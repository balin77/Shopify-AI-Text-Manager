# PLAN — SEO-Crawl-Ausbau (Screaming-Frog-Lücken schließen)

Stand: 2026-08-16 · Branch: `develop`

Dieser Plan schließt die Lücken, die der Vergleich mit Screaming Frog gezeigt hat.
Er ist so geschnitten, dass **jede Phase einzeln deploybar** ist und keine Phase eine
spätere blockiert.

Konventionen wie in den früheren SEO-Plänen: `§`-Nummern hier sind die Anker, auf die
Code-Kommentare referenzieren sollen. Architektur-Invarianten, die aus diesem Plan
hervorgehen, wandern nach Abschluss nach [CLAUDE.md](../../CLAUDE.md) — dieser Plan wird
danach gelöscht, nicht archiviert.

---

## §0 — Die Tab-Entscheidung (die eigentliche Frage)

### §0.1 Ausgangslage

`/app/seo/crawl` ist heute **Crawler UND Report in einem**. Der Loader
([app.seo.crawl.tsx:273-285](../../app/routes/app.seo.crawl.tsx#L273-L285)) lädt alle
`SeoCrawlPage`-Zeilen und baut daraus 10 Listen; die UI rendert 9 Tiles und 9
Tab-Bodies in einer 1249-Zeilen-Route.

Der Tab vermischt dabei zwei Dinge, die ein Merchant nicht zusammen sucht:

| Auslieferungs-Gesundheit | On-Page-Qualität |
|---|---|
| Alle Seiten, OK-Seiten | Head-Drift |
| Kaputte Seiten & Links | Doppelte Titel |
| Serverfehler | *(neu: Indexierbarkeit, Canonicals, H1, Meta live, Thin Content, Bilder)* |
| Firewall-Blocks | |
| Langsamste Seiten | |
| Waisen | |

Alles Neue fällt in die **rechte** Spalte. Würde man es an `/app/seo/crawl` anhängen,
entstünden ~16 Tiles in einem Grid, ein Loader mit ~16 Listen und eine Route jenseits
2000 Zeilen. Das ist der Punkt, an dem geteilt werden muss.

### §0.2 Entscheidung pro Feature

| # | Feature | Wohin | Begründung |
|---|---|---|---|
| 1 | Indexierbarkeit (`meta robots`, `X-Robots-Tag`) | **Neuer Tab** `/app/seo/onpage` | Merchant sucht „Indexierung", nicht „Crawl". Eigener Loader. |
| 2 | Canonical-Report | **Neuer Tab** `/app/seo/onpage` | Gleiche Datenquelle, gleiche Denkweise wie 1. |
| 3 | H1 / Meta-Description live / Thin Content | **Neuer Tab** `/app/seo/onpage` | Felder liegen schon in der DB, gehören inhaltlich zu 1+2. |
| 4 | Head-Drift + Doppelte Titel | **Umzug** Crawl → `/app/seo/onpage` | Sind heute im falschen Tab; Umzug macht beide Tabs kohärent. |
| 5 | Bilder (fehlende Alts live, Gewicht) | **Neuer Tab** `/app/seo/onpage` | Reiht sich als weitere On-Page-Kategorie ein. |
| 6 | **Redirect-Ketten** | **Bestehender Tab** `/app/seo/redirects` | **Braucht keinen Crawl** — siehe §4.1. Und der Fix lebt dort. |
| 7 | Externe Links | **Bestehender Tab** `/app/seo/crawl` | Ist Auslieferungs-Gesundheit, nur außerhalb der eigenen Domain. |
| 8 | CSV-Export | **Beide** Crawl + On-Page | Resource-Routes, kein UI-Platz nötig. |
| 9 | Crawl-Vergleich (Snapshot-Diff) | **Bestehender Tab** `/app/seo/crawl` | Bezieht sich auf den Crawl als Ganzes, nicht auf eine Kategorie. |

**Ein Crawler bleibt es.** `runCrawl` ist und bleibt die einzige Live-Fetch-Stelle
(CLAUDE.md-Regel). `/app/seo/onpage` startet **denselben** `seoCrawl`-Task und liest
**denselben** letzten `SeoCrawlSnapshot`. Es gibt nie zwei Crawls.

### §0.3 Der geteilte Snapshot-Header

Damit zwei Tabs über einen Crawl nicht verwirren, teilen sie sich eine Komponente:

```
app/components/seo/CrawlSnapshotHeader.tsx
```

Rendert: „Letzter Crawl: {time}" · Fortschrittsbanner bei `running` · Fehlerbanner
(`storefront_password` / `bot_blocked:<source>`) · „Jetzt scannen"-Button · das
`capped`-Banner. Beide Routes rendern sie identisch — der Merchant sieht sofort, dass
es derselbe Crawl ist.

Dazu ein geteilter Loader-Helper:

```
app/services/seo/crawl-snapshot.server.ts
  loadLatestSnapshot(db, shop) → { snapshotRow, running, parsedError } | null
```

Beide Routes rufen ihn auf. Kein Copy-Paste der Task-Single-Flight-Abfrage.

### §0.4 Nav-Eintrag

In [seo-sections.ts](../../app/config/seo-sections.ts), Rubrik `analysis`, **hinter** `crawl`
(der Crawl erzeugt die Daten, der On-Page-Tab liest sie — Reihenfolge folgt dem Workflow):

```ts
{
  id: "onpage",
  path: "/app/seo/onpage",
  icon: "📄",
  labelKey: "onpage",
  kind: "audit",
  planGate: "pro",   // identisch zum Crawl — ohne Crawl-Daten ist der Tab leer
},
```

`planGate: "pro"` ist zwingend gleich dem Crawl-Gate: ein Free-Shop kann nie einen
Snapshot haben, ein ungegateter On-Page-Tab wäre also permanent leer. Der Tab zeigt
im gegateten Zustand dasselbe Beispiel-Ergebnis-Muster wie der Crawl
(`upgradeExampleTitle` + `EXAMPLE_SNAPSHOT`).

---

## §1 — Datenmodell

### §1.1 Neue Spalten auf `SeoCrawlPage`

Alle additiv mit Default → eine Migration, kein Backfill, kein Downtime-Risiko.

```prisma
model SeoCrawlPage {
  // … bestehend …

  // §2.1 Indexierbarkeit. RAW gespeichert, nie vorinterpretiert — die Ableitung
  // ist eine pure Funktion (deriveIndexability), damit sich die Regel ohne
  // Re-Crawl korrigieren lässt.
  // "" bedeutet ZWEI Dinge, die nicht unterscheidbar sind: kein Tag/Header
  // vorhanden, ODER Zeile vor Einführung der Spalte geschrieben. Deshalb hält
  // `indexabilityKnown` fest, ob dieser Crawl-Lauf überhaupt danach gesehen hat.
  metaRobots        String  @default("")  // <meta name="robots" content="…">
  xRobotsTag        String  @default("")  // X-Robots-Tag der FINALEN Antwort
  indexabilityKnown Boolean @default(false)

  // §2.3 On-Page. h1Count existiert bereits; der Text kommt dazu, weil
  // "H1 identisch zum Title" und "H1 leer" sonst nicht prüfbar sind.
  h1First    String?
  imgCount        Int @default(0)
  imgMissingAlt   Int @default(0)

  // §5 Redirect-Beobachtung. `redirectedTo` (Endziel) existiert bereits;
  // die Kettenlänge fehlt und ist der eigentliche Report-Wert.
  redirectHops Int @default(0)
}
```

**Trap, die zwingend in den Schema-Kommentar muss** (identisch zur `jsonLdTypes`-Falle):
`metaRobots == ""` heißt **nicht** „indexierbar". Es heißt „nichts gefunden ODER alter
Snapshot". Deshalb `indexabilityKnown` — die UI blendet die ganze Kategorie aus, wenn
der letzte Snapshot sie nicht kennt, statt „alles in Ordnung" zu behaupten. Das ist
exakt der Fehler, den `translatableContent` schon einmal produziert hat (CLAUDE.md:
„Never conclude 'not translatable' from an empty key list").

### §1.2 Neues Modell für externe Links (§6)

```prisma
// §6 — Externe Links. Pro EINDEUTIGER Ziel-URL eine Zeile, nicht pro Kante:
// ein Instagram-Link im Footer erscheint auf jeder Seite und würde die Tabelle
// sonst mit 2000 identischen Zeilen fluten. `sourceCount` hält fest, wie viele
// Seiten darauf zeigen, `sampleSources` zeigt bis zu 5 davon.
model SeoCrawlExternalLink {
  id           String  @id @default(cuid())
  shop         String
  snapshotId   String
  url          String
  statusCode   Int     // 0 = Timeout/DNS, -1 = Redirect-Loop
  finalUrl     String? // wenn weitergeleitet
  sourceCount  Int     @default(0)
  sampleSources String @default("") // bis zu 5 Quell-URLs, "\n"-getrennt
  anchor       String?
  checkedAt    DateTime @default(now())

  snapshot SeoCrawlSnapshot @relation(fields: [snapshotId], references: [id], onDelete: Cascade)

  @@unique([snapshotId, url])
  @@index([shop, snapshotId])
  @@index([shop, snapshotId, statusCode])
}
```

Plus die Gegenrelation `externalLinks SeoCrawlExternalLink[]` auf `SeoCrawlSnapshot`.

### §1.3 Snapshot-Zähler — bewusst NICHT

`SeoCrawlSnapshot` bekommt **keine** neuen `…Count`-Spalten. Der Crawl-Loader rechnet
`pagesOk`/`pagesBroken` bereits bewusst aus den persistierten Seiten neu
([app.seo.crawl.tsx:288-297](../../app/routes/app.seo.crawl.tsx#L288-L297)), weil
Snapshot-Zähler bei geänderten Klassifizierungsregeln veralten. Für die neuen
Kategorien gilt dasselbe: **immer aus `SeoCrawlPage` ableiten**.

Einzige Ausnahme wäre das Dashboard (§7), das die Zahlen ohne Seiten-Load braucht —
das löst §7 über die Problem-Buckets im `payload` von `SeoScoreSnapshot`, nicht über
neue Crawl-Spalten.

### §1.4 Migration

Eine Migration, `20260817000000_seo_crawl_onpage_fields`. Rein additiv. Auf Railway
über `npm run prisma:migrate` (**nie** als `postdeploy`-Script — CLAUDE.md).

---

## §2 — Phase A: Crawler-Erfassung (Fundament für alles)

Ohne diese Phase hat der neue Tab nichts zu zeigen. Sie ist klein, weil das HTML
bereits geparst wird.

### §2.1 `X-Robots-Tag` aus den Antwort-Headern

`FetchOutcome` ([crawl.service.ts:713-725](../../app/services/seo/crawl.service.ts#L713-L725))
bekommt ein Feld:

```ts
interface FetchOutcome {
  // …
  /** `X-Robots-Tag` der FINALEN Antwort der Redirect-Kette. Ein Header auf
   *  einem 301 gilt für die Weiterleitung, nicht für die Zielseite. */
  xRobotsTag: string;
}
```

Gesetzt **nur** im Nicht-Redirect-Rückgabezweig
([crawl.service.ts:868-877](../../app/services/seo/crawl.service.ts#L868-L877)), nicht in den
3xx-Zweigen. Mehrfach gesendete Header werden von `Headers.get()` bereits
komma-verbunden zurückgegeben — genau das speichern wir.

### §2.2 `meta robots` aus dem HTML

Im bestehenden Parse-Block
([crawl.service.ts:1293-1302](../../app/services/seo/crawl.service.ts#L1293-L1302)), eine
Zeile:

```ts
record.metaRobots = $('meta[name="robots"]').attr("content")?.trim() || "";
```

`name="robots"` case-insensitive matchen (`meta[name="robots" i]` — cheerio unterstützt
den `i`-Flag). Googlebot-spezifische Tags (`name="googlebot"`) **zusätzlich** erfassen
und mit `,` anhängen — sie überschreiben das generische Tag für Google und sind der
häufigere Ort für ein versehentliches `noindex`.

`indexabilityKnown = true` wird gesetzt, sobald der Body geparst wurde. Bei einer
Seite ohne Body (4xx/5xx/Block) bleibt es `false` — dort ist die Frage sinnlos.

### §2.3 H1-Text und Bilder

Im selben Parse-Block:

```ts
record.h1First = $("h1").first().text().replace(/\s+/g, " ").trim().slice(0, 300) || null;

const imgs = $("img");
record.imgCount = imgs.length;
record.imgMissingAlt = imgs.filter((_, el) => !($(el).attr("alt") || "").trim()).length;
```

Kosten: null zusätzliche Requests. **Wichtig:** `alt=""` ist gültiges HTML für
dekorative Bilder und wird hier als „fehlt" gezählt — das muss die UI so benennen
(„ohne Alt-Text", nicht „Fehler"), sonst produziert jedes Theme mit dekorativen
Icons hunderte Falschmeldungen. Siehe §3.5 für die Filterregel.

### §2.4 `redirectHops`

`FetchOutcome.hops` existiert bereits. Beim Bau von `PageRecord`:

```ts
redirectHops: Math.max(0, outcome.hops.length - 1),
```

### §2.5 Tests (Phase A)

`app/services/seo/__tests__/crawl.service.test.ts` erweitern:
- `xRobotsTag` wird von der finalen Antwort genommen, nicht vom 301
- `meta[name=googlebot]` wird zusätzlich zu `meta[name=robots]` erfasst
- `indexabilityKnown` bleibt `false` bei 404/Block (kein Body)
- `imgMissingAlt` zählt `alt=""` und fehlendes `alt` gleich
- `redirectHops` = 0 ohne Redirect, 2 bei A→B→C

---

## §3 — Phase B: Der neue Tab `/app/seo/onpage`

### §3.1 Service: `app/services/seo/onpage.service.ts`

**Nur pure Funktionen über bereits geladene Zeilen** — keine Fetches, keine
Prisma-Aufrufe außer im Loader. Das macht die ganze Regelmenge unit-testbar, wie
`classifyLinkStatus` / `groupDuplicateTitles` es vormachen.

```ts
export type IndexabilityVerdict =
  | "indexable"
  | "noindex"        // meta robots ODER X-Robots-Tag sagt noindex
  | "nofollow_only"  // folgt Links nicht, ist aber indexierbar
  | "unknown";       // Snapshot ohne indexabilityKnown, oder Seite ohne Body

export function deriveIndexability(row: {
  metaRobots: string;
  xRobotsTag: string;
  indexabilityKnown: boolean;
  statusCode: number;
}): IndexabilityVerdict;
```

Regel: `noindex` oder `none` in einem der beiden Felder (case-insensitive,
komma-getrennt) → `noindex`. `none` impliziert `noindex,nofollow`.

### §3.2 Die Falsch-Positiv-Regel für `noindex` (kritisch)

Ein `noindex` ist **oft gewollt**. Wird das nicht gefiltert, meldet der Tab bei jedem
Shop dutzende „Fehler", die keine sind — dieselbe Klasse von Bug wie die 403-Blocks,
die schon einmal die Broken-Link-Liste geflutet haben.

Erwartetes `noindex` (**nicht** als Problem melden, sondern in einer eigenen,
neutralen Zeile „Bewusst ausgeschlossen"):

1. **`seo.hidden`-Metafeld gesetzt** — der Sitemap-Tab verwaltet genau das. Query gegen
   `SeoSitemapExclusion` (siehe [sitemap.service.ts](../../app/services/seo/sitemap.service.ts)),
   Join über `resourceType`/`resourceId` der Crawl-Zeile — beide Tabellen nutzen
   dieselbe kleingeschriebene `resourceType`-Konvention (`"product"` | `"collection"` |
   `"page"` | `"article"`), der Join geht also direkt.

   **Nur `status === "applied"` zählt.** Die Tabelle kennt drei Zustände
   (`"suggested"` | `"applied"` | `"reverted"`, gesetzt in
   [sitemap.service.ts:397/952/995](../../app/services/seo/sitemap.service.ts#L952)); nur bei
   `"applied"` ist `seo.hidden` tatsächlich auf Shopify gesetzt. Ein bloßer *Vorschlag*
   erklärt kein `noindex` — würde man ihn mitzählen, verschwiegen wir genau die Fälle,
   in denen ein Merchant einen Vorschlag nie angewendet hat und die Seite aus einem
   **anderen**, unbeabsichtigten Grund auf `noindex` steht.
2. **Shopify-native noindex-Pfade**: `/search`, `/cart`, `/account*`, `/policies/*`,
   `/challenge`, `/*/tagged/*` (gefilterte Kollektionen), `?constraint=`-Varianten.
   Als exportierte Konstante `EXPECTED_NOINDEX_PATTERNS` mit Kommentar je Eintrag.
3. **Nicht-primäre Locale-Präfixe**, wenn der Markt keine Websuche bedient — hier
   bewusst **kein** automatisches Urteil: `locale !== ""` wird nur markiert, nicht
   gewertet.

Alles andere ist ein echter Fund. Ein Produkt oder eine Kollektion mit `noindex`, das
**nicht** in `SeoSitemapExclusion` steht, ist der wertvollste Einzelfund des ganzen
Tabs und bekommt `tone="critical"`.

### §3.3 Canonical-Regeln (ebenfalls falsch-positiv-anfällig)

Shopify setzt Canonicals selbst und **richtig**: `/collections/x/products/y`
canonicalisiert auf `/products/y`. Ein naives „nicht selbstreferenzierend = Fehler"
meldet auf jedem Shop hunderte Nicht-Probleme.

Gemeldet wird nur:

| Fund | Schwere | Warum |
|---|---|---|
| Canonical fehlt ganz | warning | Theme-Defekt, Shopify liefert sonst immer eins |
| Canonical zeigt auf 4xx/5xx | critical | Die kanonische Seite existiert nicht |
| Canonical zeigt auf eine Weiterleitung | warning | Verschenkt Signal, Google folgt ungern |
| Canonical zeigt auf fremde Domain | critical | Klassischer Migrations-/App-Unfall |
| Canonical-Kette (A→B, B→C) | warning | Google bricht ab |
| Canonical zeigt auf `noindex`-Seite | critical | Widerspruch, Seite fällt komplett raus |

Alle sechs sind **rein aus der Snapshot-Tabelle berechenbar** (Join `canonical` gegen
`url` der anderen Zeilen) — kein zusätzlicher Fetch.

```ts
export type CanonicalIssue =
  | "missing" | "targetBroken" | "targetRedirects"
  | "crossHost" | "chain" | "targetNoindex";

export function analyzeCanonicals(
  pages: OnPageRow[],
  canonicalHost: string,
): Array<{ url: string; issue: CanonicalIssue; target: string | null }>;
```

**Normalisierung:** Der Vergleich `canonical` ↔ `url` muss durch dieselbe
Normalisierung wie `normalizeCrawlUrl` (Trailing-Slash, Host-Collapse
myshopify→primary, Query-Strip). Sonst meldet jede Seite eine Kette gegen sich selbst.
Nicht neu implementieren — `normalizeCrawlUrl` exportieren und wiederverwenden.

### §3.4 On-Page-Regeln

| Kategorie | Regel | Anmerkung |
|---|---|---|
| H1 fehlt | `h1Count === 0` | nur bei 2xx-Seiten |
| Mehrere H1 | `h1Count > 1` | `warning`, nicht `critical` — HTML5 erlaubt es, Google mag es trotzdem nicht |
| H1 = Title | normalisierter Vergleich | `info`, reiner Hinweis |
| Meta-Description fehlt **live** | `metaDesc` leer | **abweichend vom Dashboard**: das prüft den DB-Cache, hier zählt, was ausgeliefert wird |
| Meta-Description doppelt **live** | Gruppierung wie `groupDuplicateTitles` | siehe §3.6 |
| Thin Content | siehe §3.5 | |

### §3.5 Thin Content — nicht mit absoluter Schwelle

`countWords` ([crawl.service.ts:702-709](../../app/services/seo/crawl.service.ts#L702-L709))
entfernt `nav, footer, script, style, noscript` — aber **nicht** `header`, `aside`,
Cookie-Banner oder Theme-Boilerplate. Auf einem Shopify-Produkt-Template sind darum
300–600 „Wörter" normal, egal wie leer die Beschreibung ist. Eine feste Schwelle
(SF nutzt 200) produziert hier Unsinn in beide Richtungen.

**Regel stattdessen:** Perzentil **innerhalb des `resourceType`**. Eine Produktseite
wird gegen Produktseiten verglichen, nicht gegen Blog-Artikel.

```ts
/** Seiten unter dem 10. Perzentil ihres eigenen resourceType UND unter der
 *  Hälfte des Typ-Medians. Beide Bedingungen, damit ein Shop mit durchgehend
 *  kurzen Produkttexten nicht 10 % seines Katalogs als Defekt gemeldet bekommt. */
export function findThinPages(pages: OnPageRow[]): ThinPageRow[];
```

Braucht mindestens 20 Seiten des Typs, sonst wird die Kategorie für diesen Typ
ausgeblendet (Perzentil über 6 Seiten ist Rauschen). Das muss die UI sagen, nicht
verschweigen.

`findThinContentPages` existiert bereits in
[sitemap.service.ts:203](../../app/services/seo/sitemap.service.ts#L203) — **prüfen, ob es
wiederverwendbar ist**, statt eine zweite Thin-Content-Definition einzuführen. Wenn
ja: dorthin verschieben und aus beiden Tabs importieren. Zwei divergierende
Definitionen von „dünn" wären genau das Muster, das `FIELD_TO_TRANSLATION_KEY`-Duplikate
schon einmal verursacht haben.

### §3.6 Doppelte Meta-Descriptions

`groupDuplicateTitles` ([crawl.service.ts:1648](../../app/services/seo/crawl.service.ts#L1648))
generalisieren statt kopieren:

```ts
export function groupDuplicateValues(
  rows: { url: string; value: string | null }[],
  normalize: (v: string | null) => string,
): DuplicateGroup[];

// Titel:  groupDuplicateValues(rows, v => normalizeHeadTitle(v, shopName))
// Meta:   groupDuplicateValues(rows, v => (v ?? "").trim().toLowerCase())
```

`groupDuplicateTitles` bleibt als dünner Wrapper bestehen — der Crawl-Tab und die
bestehenden Tests importieren sie.

### §3.7 Route `app/routes/app.seo.onpage.tsx`

Loader:
1. `authenticate.admin` → `loadPlan` → `meetsPlan(plan, "pro")`, sonst `gated` + Beispiel
2. `loadLatestSnapshot(db, shop)` (§0.3)
3. `SeoCrawlPage.findMany` — **nur 2xx-Seiten**, mit den On-Page-Feldern
   (`url, title, metaDesc, canonical, metaRobots, xRobotsTag, indexabilityKnown, h1Count, h1First, wordCount, imgCount, imgMissingAlt, statusCode, resourceType, resourceId, locale`)
4. `SeoSitemapExclusion.findMany` für die §3.2-Filterung
5. `fetchShopName` (für Head-Drift, das hierher zieht)
6. Alle pure-Funktionen aus §3.1–§3.6 anwenden

**Wichtig:** Der Loader zieht auch für Canonical-Auflösung die **nicht**-2xx-Seiten,
weil „Canonical zeigt auf 404" sonst nicht feststellbar ist. Also: alle Zeilen laden,
aber nur 2xx-Zeilen bewerten. Kommentar dazu in den Code.

Tiles/Tabs:

```
Indexierbarkeit · Canonicals · H1 · Meta-Description · Thin Content ·
Bilder ohne Alt · Head-Drift · Doppelte Titel
```

Jede Kategorie wiederverwendet `ReportGrid` / `ReportRow` / `CapNotice` /
`PageRowLine` aus dem Crawl-Tab. **Diese vier Komponenten wandern dazu nach**
`app/components/seo/crawl/` — sie sind heute route-lokal in `app.seo.crawl.tsx`
definiert. Der Umzug ist Voraussetzung, nicht Nice-to-have: sonst entstehen zwei
Report-Tabellen mit driftendem Styling.

### §3.8 Umzug von Head-Drift + Doppelte Titel (§0.2 Nr. 4)

Aus `app.seo.crawl.tsx` entfernen: Tiles `tileHeadDrift`/`tileDuplicates`, Tabs
`headDrift`/`duplicates`, der `computeHeadDrift`-Aufruf, `groupDuplicateTitles`,
`fetchShopName`. Das nimmt dem Crawl-Loader zwei DB-Roundtrips und einen
Admin-API-Call ab — der Crawl-Tab wird dadurch **schneller**, nicht nur schlanker.

Der Crawl-Tab bekommt an ihrer Stelle einen Hinweis-Link:
„Titel-Abweichungen und doppelte Titel findest du jetzt unter **On-Page & Indexierung**."
Ein Redirect wäre falsch — die URL `/app/seo/crawl` bleibt gültig und sinnvoll.

Die Dashboard-Buckets `headDrift` deep-linken heute auf `/app/seo/crawl`
([audit.service.ts](../../app/services/seo/audit.service.ts), `action: "deepLink"`) — die
Ziel-URL muss auf `/app/seo/onpage` umgestellt werden. **Nicht vergessen**, sonst
landet der Merchant auf einem Tab ohne die Kategorie.

### §3.9 i18n

Neuer Block `t.seo.onpagePage.*` in [de.ts](../../app/i18n/de.ts), [en.ts](../../app/i18n/en.ts),
[es.ts](../../app/i18n/es.ts) — alle drei, sonst fällt die Route auf `undefined` zurück.
Plus `t.seo.sections.onpage` (Label/Title/Description).

Die Erklärtexte tragen hier überdurchschnittlich viel: „noindex" und „Canonical" sind
die zwei Begriffe, bei denen ein Shopify-Merchant am ehesten aussteigt. Jede Kategorie
bekommt einen Ein-Satz-Hinweis **über** der Tabelle, nach dem Muster von
`brokenPagesHint` / `serverErrorsHint`.

### §3.10 Tests (Phase B)

`app/services/seo/__tests__/onpage.service.test.ts`:
- `deriveIndexability`: `noindex`, `none`, `NOINDEX` (Case), Header vs. Meta,
  `googlebot`-Override, `unknown` bei `indexabilityKnown: false`
- `EXPECTED_NOINDEX_PATTERNS` matcht `/search`, `/policies/agb`, `/collections/x/tagged/y`
- Ein Produkt mit `noindex` **ohne** `SeoSitemapExclusion` ⇒ critical
- Ein Produkt mit `noindex` **mit** `SeoSitemapExclusion` ⇒ nicht gemeldet
- `analyzeCanonicals`: alle sechs Fälle aus §3.3, plus „selbstreferenzierend nach
  Normalisierung" ⇒ kein Fund
- `/collections/x/products/y` → `/products/y` ⇒ **kein** Fund
- `findThinPages`: < 20 Seiten des Typs ⇒ leer; Typ-getrennte Perzentile
- `groupDuplicateValues` ist verhaltensgleich zu `groupDuplicateTitles`

---

## §4 — Phase C: Redirect-Ketten (bestehender Redirects-Tab)

### §4.1 Warum kein Crawl nötig ist

Eine Redirect-Kette ist vollständig aus **Shopifys eigener Redirect-Liste** berechenbar:
existiert `A → B` und ist `B` selbst Quelle von `B → C`, ist das eine Kette. Dafür
braucht es keinen einzigen HTTP-Request — `listRedirects`
([redirects.service.ts:279](../../app/services/seo/redirects.service.ts#L279)) liefert alles.

Das ist zugleich der Punkt, an dem die App **besser als Screaming Frog** ist: SF findet
die Kette, kann sie aber nicht reparieren. Wir haben `updateRedirect`
([redirects.service.ts:318](../../app/services/seo/redirects.service.ts#L318)) direkt daneben.

### §4.2 Service

```ts
// app/services/seo/redirect-chains.ts  (pure, client-safe, kein .server)

export interface RedirectChain {
  /** Volle Kette inkl. Endziel: ["/alt", "/mittel", "/neu"] */
  hops: string[];
  /** true = Schleife statt Kette (letzter Hop zeigt zurück in die Kette) */
  isLoop: boolean;
  /** GID des ERSTEN Redirects — das ist der, der umgebogen wird. */
  firstRedirectId: string;
  /** Das aufgelöste Endziel; null bei Schleife. */
  finalTarget: string | null;
}

export function findRedirectChains(redirects: UrlRedirect[]): RedirectChain[];
```

Implementierung: Map `path → {id, target}`, dann von jedem Pfad aus folgen, `Set` zur
Schleifenerkennung, Abbruch bei > 10 Hops (dann ist es faktisch eine Schleife).

**Normalisierung:** Shopify speichert Pfade mit führendem `/` und ohne Host, aber
`target` kann eine **absolute URL** sein. Ketten nur über relative Ziele verfolgen;
absolute Ziele auf dem eigenen Primary-Host auf den Pfad reduzieren (dafür
`fetchPrimaryDomain` aus [shop-domain.server.ts](../../app/utils/shop-domain.server.ts)),
fremde Hosts beenden die Kette. Groß-/Kleinschreibung: Shopify matcht Pfade
case-insensitive → normalisiert vergleichen.

### §4.3 UI im Redirects-Tab

Eine neue Card **über** der Redirect-Liste, nur sichtbar wenn `chains.length > 0`:

```
⚠️  3 Redirect-Ketten gefunden
    /alt-produkt → /zwischenschritt → /neues-produkt      [Kette auflösen]
    …
    [Alle Ketten auflösen (3)]
```

„Kette auflösen" = `updateRedirect(firstRedirectId, { path: hops[0], target: finalTarget })`.
Die Zwischen-Redirects bleiben bestehen (sie können eigene Inbound-Links haben) —
das ist die richtige Semantik und muss im Hilfetext stehen, sonst wirkt es wie ein Bug.

Bei `isLoop`: **kein** Auflösen-Button, nur eine kritische Meldung mit Link zum
Bearbeiten — eine Schleife hat kein Endziel, das Auto-Fix wählen könnte.

### §4.4 Ergänzung im Crawl-Tab: beobachtete Ketten

`redirectHops` (§2.4) fängt Ketten, die **nicht** in der Merchant-Redirect-Liste stehen
— Theme-Redirects, App-Redirects, Locale-Weiterleitungen. Die gehören nicht in den
Redirects-Tab (dort gäbe es keinen Fix), sondern als **Spalte** in die bestehende
„Alle gecrawlten Seiten"-Tabelle: `→ 2 Hops` als Badge hinter dem Status.
Kein neuer Tab, kein neues Tile.

### §4.5 Plan-Gate

Der Redirects-Tab hat heute kein Gate. Redirect-Ketten bleiben ungegatet — es ist
eine kleine Funktion, sie kostet keine Ressourcen (die Redirect-Liste wird ohnehin
geladen), und sie erzeugt genau das Vertrauen, das einen Free-Shop zum Upgrade bringt.

### §4.6 Tests

`app/services/seo/__tests__/redirect-chains.test.ts`:
- A→B→C ⇒ eine Kette, `finalTarget: "/c"`, `firstRedirectId` = A
- A→B, B→A ⇒ `isLoop: true`, kein `finalTarget`
- A→B, C→B ⇒ **keine** Kette (zwei Quellen, ein Ziel ist normal)
- Absolutes Ziel auf Primary-Host wird verfolgt; fremder Host beendet
- Case-insensitive: `/Alt` → `/b` und `/b` → `/c` ⇒ Kette
- > 10 Hops ⇒ als Schleife behandelt

---

## §5 — Phase D: CSV-Export

### §5.1 Zwei Resource-Routes

Vorbild: [app.seo.redirects.export.tsx](../../app/routes/app.seo.redirects.export.tsx).

```
app/routes/app.seo.crawl.export.tsx     ?category=allPages|broken|serverErrors|blocked|orphans|slowest|external
app/routes/app.seo.onpage.export.tsx    ?category=indexability|canonicals|h1|meta|thin|images|headDrift|duplicates
```

### §5.2 Die Gate-Falle

Eine Resource-Route ist **direkt per GET aufrufbar**. Das ist dieselbe Klasse wie die
`/api/ai`-Handler, die laut CLAUDE.md ihr Plan-Gate selbst prüfen müssen, weil sie
direkt POST-erreichbar sind.

⇒ **Jede Export-Route prüft `meetsPlan(plan, "pro")` selbst.** Ein Free-Shop, der die
URL rät, bekommt 403, nicht den Crawl seines eigenen Shops als CSV. (Er dürfte ihn
zwar sehen — aber dann ist das Gate wirkungslos und der Export ein Gate-Bypass für
alles, was der Tab sonst nur als Beispiel zeigt.)

### §5.3 Format

CSV-Erzeugung über die bestehenden Helper in
[redirects-csv.ts](../../app/services/seo/redirects-csv.ts) / [keywords-csv.ts](../../app/services/seo/keywords-csv.ts)
— **prüfen, ob dort ein generischer `toCsv(rows, columns)` extrahierbar ist**, statt
einen dritten CSV-Serializer zu schreiben. UTF-8 BOM voranstellen (Excel), `;` als
Trenner für DE-Locale-Excel, Zellen mit `"` escapen.

Kein Zeilen-Cap im Export — `UI_ROW_CAP` ist eine UI-Grenze, kein Datenlimit. Genau
das ist der Grund, warum Merchants den Export wollen. Bei 2000 Seiten × ~15 Spalten
ist die Datei < 1 MB, streamen ist unnötig.

---

## §6 — Phase E: Externe Links

Die aufwendigste Phase — als letzte, weil sie als einzige neue Netzwerk-Last erzeugt.

### §6.1 Sammlung während des Crawls

`normalizeCrawlUrl` verwirft heute alles Fremd-Origin
([crawl.service.ts:191](../../app/services/seo/crawl.service.ts#L191)). Es wird **nicht**
geändert — stattdessen sammelt der `$("a[href]")`-Loop parallel:

```ts
const externalTargets = new Map<string, { count: number; sources: string[]; anchor: string | null }>();
```

Filter: nur `http:`/`https:`, kein `mailto:`/`tel:`, keine Shopify-CDN-Hosts
(`cdn.shopify.com` etc. — das sind Assets, keine Links). Deduplizierung nach voller
URL inkl. Query (anders als intern: bei externen Zielen ist die Query oft bedeutungstragend).

Bound: `MAX_EXTERNAL_TARGETS = 2000`. Danach wird nur noch `count` hochgezählt, keine
neuen URLs aufgenommen — und das wird geloggt **und in der UI gesagt**. Stille
Truncation ist die Regel, die dieser Codebase schon einmal weh getan hat.

### §6.2 Zweiter Pass nach dem Crawl

Eigener Fetcher, **eigenes Rate-Regime** — hier gilt Shopifys Shield nicht:

```ts
const EXTERNAL_CONCURRENCY = 6;       // vs. CRAWL_CONCURRENCY = 2
const EXTERNAL_PER_HOST_CONCURRENCY = 2;  // ein Host darf nicht geflutet werden
const EXTERNAL_TIMEOUT_MS = 8_000;
```

`HEAD` zuerst; bei `405`/`501`/`403` einmal `GET` mit `Range: bytes=0-0`. Sehr viele
Hosts (u. a. Cloudflare-geschützte) beantworten `HEAD` mit 403, obwohl die Seite
existiert — ohne den GET-Fallback meldet der Report massenhaft Falsch-Positive.

**Redirects folgen** (bis 5 Hops), aber `finalUrl` festhalten: „Link zeigt auf
http://, wird auf https:// weitergeleitet" ist ein eigener, nützlicher Fund.

**SSRF-Schutz:** `isPrivateOrLoopbackHost`
([crawl.service.ts:225](../../app/services/seo/crawl.service.ts#L225)) ist bereits exportiert
und muss hier **jeden** Hop prüfen. Ein externer Link darf per Definition überallhin
zeigen — genau deshalb ist der Guard hier wichtiger als im internen Crawl. Zusätzlich:
keine nicht-http(s)-Protokolle, kein Redirect auf eine IP-Literal-URL.

### §6.3 Zeitbudget

Der Pass läuft **nach** dem Crawl innerhalb desselben `seoCrawl`-Tasks und bekommt ein
hartes Gesamtbudget (`EXTERNAL_CHECK_BUDGET_MS = 120_000`). Läuft es ab, wird
abgebrochen und der Rest als „nicht geprüft" markiert — der Crawl selbst ist zu dem
Zeitpunkt bereits persistiert und darf niemals an einem externen Host scheitern.

Der Heartbeat (`onProgress`) muss während dieses Passes weiterlaufen, sonst sieht der
Merchant einen eingefrorenen Fortschritt — dieselbe Falle, die der Kommentar bei
`detectMerchantCloudflare` schon beschreibt.

### §6.4 UI

Neues Tile + Tab „Externe Links" im **Crawl**-Tab (§0.2 Nr. 7). Spalten: Ziel-URL ·
Status · von N Seiten verlinkt · Linktext · aufklappbar die Quell-Seiten.
Sortierung: kaputt zuerst, dann nach `sourceCount` absteigend — ein toter Link im
Footer (auf 2000 Seiten) ist dringender als einer in einem Blog-Artikel.

### §6.5 Opt-out

Die Prüfung schickt Requests an fremde Server. Ein Schalter in den Crawl-Einstellungen
(`AISettings` oder ein neues `SeoCrawlConfig`) mit Default **an**, aber sichtbar und
abschaltbar. Muss im UI erklärt werden, warum es den Crawl verlängert.

---

## §7 — Phase F: Dashboard-Buckets + Crawl-Vergleich

### §7.1 Neue Problem-Buckets

In [audit.service.ts](../../app/services/seo/audit.service.ts) neben den bestehenden
crawl-abgeleiteten `deepLink`-Buckets (`brokenLinks`, `serverErrors`, `orphanPages`,
`headDrift`):

| Bucket-Code | Deep-Link-Ziel |
|---|---|
| `nonIndexable` | `/app/seo/onpage` |
| `canonicalIssue` | `/app/seo/onpage` |
| `missingH1` | `/app/seo/onpage` |
| `thinContent` | `/app/seo/onpage` |
| `externalBrokenLinks` | `/app/seo/crawl` |
| `redirectChains` | `/app/seo/redirects` |

Alle mit `action: "deepLink"` — **kein** „Mit KI beheben". Für keinen dieser Funde gibt
es einen KI-Fix, und ein Button, der so aussieht, wäre eine Lüge.

`nonIndexable` bekommt zusätzlich die höchste Sortierpriorität im Bucket-Ranking: ein
versehentliches `noindex` auf einem Produkt kostet mehr Umsatz als jede
Meta-Description-Länge.

i18n-Keys unter `t.seo.dashboard.problems.*` in allen drei Sprachen.

### §7.2 Crawl-Vergleich

Zwei letzte Snapshots (die Retention hält 5,
[crawl.service.ts:1671](../../app/services/seo/crawl.service.ts#L1671)), pure Funktion:

```ts
// app/services/seo/crawl-diff.ts
export interface CrawlDiff {
  newUrls: string[];
  goneUrls: string[];
  statusChanged: Array<{ url: string; from: number; to: number }>;
  indexabilityChanged: Array<{ url: string; from: IndexabilityVerdict; to: IndexabilityVerdict }>;
  titleChanged: Array<{ url: string; from: string | null; to: string | null }>;
  counts: { pages: [number, number]; broken: [number, number]; nonIndexable: [number, number] };
}

export function diffCrawls(previous: DiffRow[], current: DiffRow[]): CrawlDiff;
```

UI: eine ausklappbare Card im Crawl-Tab über den Tiles, „Seit dem letzten Crawl
({datum})" mit den Zähler-Deltas als farbige Badges und den vier Listen darunter.
Ausgeblendet, wenn es keinen Vorgänger-Snapshot gibt.

`indexabilityChanged` ist der eigentliche Wert: „12 Seiten sind seit dem letzten Crawl
auf noindex gesprungen" ist die Meldung, für die man ein SEO-Tool hat. **Aber:** nur
zeigen, wenn **beide** Snapshots `indexabilityKnown` haben — sonst meldet der erste
Crawl nach dem Deploy den ganzen Shop als „geändert" (§1.1).

---

## §8 — Reihenfolge, Aufwand, Deploybarkeit

| Phase | Inhalt | Aufwand | Einzeln deploybar |
|---|---|---|---|
| **A** | Crawler-Erfassung + Migration (§1, §2) | ~0,5 Tag | ja (unsichtbar, sammelt nur) |
| **C** | Redirect-Ketten (§4) | ~0,5 Tag | ja — **unabhängig von A** |
| **B** | Tab `/app/seo/onpage` (§3) | ~2 Tage | ja, braucht A |
| **D** | CSV-Export (§5) | ~0,5 Tag | ja, braucht B |
| **F** | Buckets + Diff (§7) | ~1 Tag | ja, braucht A+B |
| **E** | Externe Links (§6) | ~1,5 Tage | ja, braucht A |

**Empfohlene Reihenfolge: A → C → B → D → F → E.**

Begründung: **C vor B**, weil Redirect-Ketten ohne jede Abhängigkeit auskommen und
sofort sichtbaren Wert liefern — ein halber Tag für ein fertiges Feature. **A vor B**,
weil der neue Tab sonst nur alte Snapshots ohne die neuen Felder sieht und einen
halben Tab lang „unbekannt" anzeigt; nach A sammelt der nächste reguläre Crawl bereits
alles ein. **E zuletzt**, weil es als einziges neue externe Netzwerk-Last erzeugt und
das Risiko-Profil des `seoCrawl`-Tasks verändert.

Gesamt: ~6 Tage. Nach A+C (1 Tag) ist bereits ein Feature live und die Datenbasis für
alles Weitere vorhanden.

---

## §9 — Was bewusst NICHT gebaut wird

| Screaming-Frog-Feature | Warum nicht |
|---|---|
| **JS-Rendering (headless Chrome)** | Der Crawl läuft in einem Railway-Node-Prozess. Ein Browser pro Crawl sprengt Speicher und Laufzeit um Größenordnungen. Shopify-Themes liefern SEO-relevantes HTML serverseitig. |
| **100k-URL-Crawls** | `CRAWL_CONCURRENCY = 2` und `BASE_SPACING_MS = 1000` sind keine Bequemlichkeit, sondern die Bedingung dafür, dass Shopifys Shield uns überhaupt durchlässt (der Kommentar im Code ist explizit). SF crawlt von der lokalen IP des Merchants — dieser Vorteil ist nicht einholbar. |
| **Custom Extraction (XPath/Regex → eigene Spalte)** | Ein Power-User-Feature für Agenturen. Unsere Zielgruppe ist der Merchant, der nicht weiß, was ein Canonical ist. |
| **Log-File-Analyse** | Shopify gibt keinen Zugriff auf Server-Logs. Technisch unmöglich, nicht bloß unpriorisiert. |
| **Crawl-Konfiguration (Include/Exclude-Regeln)** | Die Denylist (`CRAWL_DENYLIST_PATHS`) deckt die sinnvollen Fälle ab. Konfigurierbarkeit hier erzeugt vor allem falsch konfigurierte Crawls und Support-Last. |

Das ist kein Verzicht, sondern die Positionierung: Wir sind kein Desktop-Crawler mit
Web-UI. Wir sind das Tool, das den Fund **repariert** — Bulk-Editor, KI-Fix,
Redirect anlegen, Übersetzung schreiben. §4 ist das Musterbeispiel: SF findet die
Kette, wir lösen sie auf.

---

## §10 — Review-Pflicht

Phasen A, B, E und F fassen Write-Pfade, ein Datenmodell, eine Migration und
geteilte Komponenten an — nach dem Working Agreement in [CLAUDE.md](../../CLAUDE.md) endet
**jede** dieser Phasen mit `/code-review high` über den Diff, und die Funde werden
behoben, bevor die Phase als fertig gilt.

Phasen C und D sind klein genug für einen normalen Durchgang, aber C fasst mit
`updateRedirect` einen Shopify-Write an — also ebenfalls Review.

Zusätzlich vor jedem Deploy: `npm run typecheck`, `npm run test`, und für Phase A/E
ein realer Crawl gegen einen Live-Shop (die Falsch-Positiv-Regeln in §3.2 und §3.3
lassen sich nur an echten Daten verifizieren — genau das ist die Lehre aus den
403-Blocks und dem leeren `translatableContent`).
