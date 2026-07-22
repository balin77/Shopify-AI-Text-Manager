# Barrierefreiheit & Website-Qualität — Plan

**Status:** Entwurf, nicht begonnen (2026-07-22, überarbeitet 2026-07-22).
**Baut auf:** der bestehenden Ladezeit-Section ([app.seo.performance.tsx](../../app/routes/app.seo.performance.tsx), [pagespeed.service.ts](../../app/services/seo/pagespeed.service.ts)) und dem Alt-Text-Pfad ([alt-text.action.ts](../../app/actions/content/alt-text.action.ts)).
**Section-Contract:** siehe [SEO_SECTION_CONTRACT.md](../architecture/SEO_SECTION_CONTRACT.md) — dieser Plan führt **keine** neue Section ein, sondern erweitert eine bestehende. Die Contract-Punkte zu Descriptor, `analyze()` und Dashboard-Findings entfallen damit (§11.1).

> **Kursänderung gegenüber der ersten Fassung (2026-07-22).** Die erste Fassung sah eine eigene Section `quality` unter `/app/seo/quality` mit eigenem Prisma-Modell, eigenem Hintergrund-Task und eigenem Voll-Scan über mehrere Templates vor. Verworfen: Barrierefreiheit und Best Practices kommen aus **demselben PSI-Aufruf** wie die Ladezeit, also aus demselben Testlauf, demselben Cache-Eintrag und derselben History-Zeile. Zwei Seiten, die dieselbe Antwort zweimal holen, sind teurer und für den Merchant verwirrender als eine Seite mit Tabs. Was dadurch ersatzlos entfällt, steht in §9 — damit es niemand versehentlich doch baut.

---

## 0. Ist-Zustand

**PSI-Anbindung** ([pagespeed.service.ts:184](../../app/services/seo/pagespeed.service.ts#L184)):

```ts
apiUrl.searchParams.append("category", "performance");
```

Genau eine Kategorie. Der Rest der Datei (Fetch mit 60s-Timeout, 429-Behandlung über `PageSpeedQuotaExceededError`, Tageslimit über `PageSpeedDailyLimitError`, 30-Minuten-Cache, History-Prune auf 10 Zeilen pro `(shop, url, strategy)`) ist **kategorie-agnostisch** und wird unverändert mitbenutzt. Nur `parsePageSpeedResponse` ist performance-spezifisch.

Der `locale`-Parameter wird bereits mitgeschickt ([pagespeed.service.ts:185](../../app/services/seo/pagespeed.service.ts#L185), gespeist aus `AISettings.appLanguage`). Lighthouse-Audit-Titel und -Beschreibungen kommen also **schon heute** in der Sprache des Merchants zurück — das gilt für die neuen Kategorien genauso, ohne Zusatzarbeit (§8).

**Speicher:** eine Tabelle, `SeoPageSpeedAudit` ([schema.prisma:1208](../../prisma/schema.prisma#L1208)) — `score` denormalisiert für die History-Liste, alles Übrige im `result`-JSON. Bereits in `redactShopData` abgedeckt ([gdpr.service.ts:479](../../app/services/gdpr.service.ts#L479)).

**Alt-Texte:** `ProductImage` hält `url`, `altText` und `mediaId` ([schema.prisma:399-409](../../prisma/schema.prisma#L399-L409)). Damit ist eine Rückabbildung von einer CDN-URL im Lighthouse-Befund auf eine editierbare Zeile möglich — die Grundlage für §7.

**Heutiger Seitenaufbau** ([app.seo.performance.tsx](../../app/routes/app.seo.performance.tsx)), von oben nach unten:

| # | Element | Zeile |
|---|---|---|
| 1 | Banner „Was misst dieser Test?" | [1141](../../app/routes/app.seo.performance.tsx#L1141) |
| 2 | Card **„Seite testen"** (Picker, Gerät, Buttons, Budget-Stand) | [1149](../../app/routes/app.seo.performance.tsx#L1149) |
| 3 | Fehler-Banner | [1209](../../app/routes/app.seo.performance.tsx#L1209) |
| 4 | Banner „Historischer Test vom {date}" | [1213](../../app/routes/app.seo.performance.tsx#L1213) |
| 5 | Banner „Zwischengespeichertes Ergebnis" (stale) | [1232](../../app/routes/app.seo.performance.tsx#L1232) |
| 6 | Card „Echte Nutzerdaten (Google CrUX)" | [1241](../../app/routes/app.seo.performance.tsx#L1241) |
| 7 | Card Laborergebnis (Gauge, Screenshot, Core Web Vitals) | [1278](../../app/routes/app.seo.performance.tsx#L1278) |
| 8 | Banner Runtime-Error / Run-Warnings / kein Element-Screenshot | [1385](../../app/routes/app.seo.performance.tsx#L1385) |
| 9 | Card „Befunde" | [1439](../../app/routes/app.seo.performance.tsx#L1439) |
| 10 | Card **„Echte Besucherdaten"** (RUM aus dem eigenen App-Embed) | [1573](../../app/routes/app.seo.performance.tsx#L1573) |
| 11 | Card „Bisherige Tests" (History) | [1684](../../app/routes/app.seo.performance.tsx#L1684) |

**#4 bis #9 sind der Bereich, der in §3 in eine einzige Tab-Card wandert.** #1–#3, #10 und #11 bleiben, wo sie sind — sie gelten für alle Tabs.

---

## 1. Zielbild und die drei Grundsatz-Entscheidungen

### 1.1 Keine neue Section — die Ladezeit-Section wächst und wird umbenannt

**Entscheidung: kein Descriptor-Eintrag, keine neue Route.** Der Inhalt kommt in [app.seo.performance.tsx](../../app/routes/app.seo.performance.tsx), aufgeteilt auf Tabs innerhalb einer Ergebnis-Card (§3).

Begründung: Ein PSI-Aufruf liefert **alle** Lighthouse-Kategorien in einer einzigen Antwort (§6). Eine zweite Section müsste denselben Testlauf ein zweites Mal anstoßen, ein zweites Mal cachen, ein zweites Mal historisieren — und der Merchant müsste dieselbe Seite zweimal testen, um beide Bilder zu sehen. Mit Tabs ist ein Test = ein Ergebnis = drei Blickwinkel darauf.

**Was stabil bleibt:** `id: "performance"`, `path: "/app/seo/performance"`, `icon: "🚀"`, `labelKey: "performance"` in [seo-sections.ts:60-66](../../app/config/seo-sections.ts#L60-L66). Die Id steuert `getActiveSeoSection`, `SeoSectionLayout sectionId="performance"` und Deep Links — sie umzubenennen bringt nichts und bricht Lesezeichen und Tests.

**Was sich ändert: nur der angezeigte String** `t.seo.sections.performance` in de/en/es.

**Vorschlag: „Ladezeit & Qualität"** (en: „Speed & quality", es: „Velocidad y calidad"). Das bekannte Wort bleibt vorn, damit die Sub-Nav für bestehende Merchants nicht über Nacht fremd wirkt, und „Qualität" ist weit genug für Barrierefreiheit **und** Best Practices. Alternative, falls kürzer gewünscht: „Seitenqualität" — dann verliert der Merchant aber den Begriff, unter dem er die Seite kennt.

Auch der Einleitungs-Banner (#1, `helpTitle`/`helpBody1`/`helpBody2`) muss mitwachsen: er beschreibt heute ausschließlich den Ladezeit-Test.

### 1.2 Best Practices ja — aber ohne Score-Beitrag

Best Practices kommt **im selben PSI-Response** mit, kostet also weder einen zusätzlichen Request noch Kontingent. Es als Goodie mitzunehmen ist richtig.

Was **nicht** passieren darf: dass es in eine Gesamtbewertung einfließt. Die Kategorie prüft überwiegend Dinge, die weder Merchant noch ContentPilot beeinflussen können (HTTPS und HSTS liegen bei Shopify, Konsolenfehler und CSP beim Theme bzw. bei Fremd-Apps). Ein Score, der wegen einer Fremd-App sinkt und den man nicht heben kann, ist ein Support-Ticket-Generator.

**Umsetzung:** eigener Tab, als „Zusatzinformationen" eingeleitet, keine Aufnahme in die History-Spalten, keine Score-Badge in der Tab-Beschriftung. Im Score-Strip (§3.3) steht die Zahl gleichberechtigt neben den anderen — „kein Score-Beitrag" heißt „geht in keine Aggregation ein", nicht „wird versteckt".

### 1.3 Barrierefreiheit muss ehrlich beschriftet sein

Lighthouse' Accessibility-Score basiert auf axe-core und erkennt nur einen Teil der realen Probleme — Google selbst nennt automatisiertes Testing ausdrücklich unvollständig. Ein 100er-Score bedeutet **nicht** „barrierefrei".

Das gehört als fester Hinweistext in den Barrierefreiheits-Tab, nicht in einen Tooltip. Ein Shopify-Merchant, der wegen des European Accessibility Act (seit Juni 2025 verbindlich für E-Commerce in der EU) hier landet, darf aus einer grünen Zahl keine Rechtssicherheit ableiten. Das ist kein Nice-to-have im Text, sondern Haftungsvermeidung.

Der Hinweis steht **im Tab**, nicht über der ganzen Seite — sonst liest ihn jeder, der nur die Ladezeit prüfen wollte, als Warnung zu seinem Ladezeit-Ergebnis.

---

## 2. Theme-Dateien und KI — außerhalb dieses Plans

Erwogen und **verworfen**: den Merchant sein Theme über die App verwalten zu lassen (per GitHub-Verknüpfung oder direkt über die Admin-Theme-API), um Theme-Dateien einer KI zur Analyse zu übergeben.

**Der ausschlaggebende Grund ist die Scope-Bewilligung.** ContentPilot hat `write_themes` für einen **bewilligten Verwendungszweck** — Theme-Inhalte und -Übersetzungen. Der Scope im Manifest ist keine Freifahrt: eine allgemeine Theme-Datei-Bearbeitung wäre ein neuer Zweck und bräuchte eine eigene Bewilligung. Das ist keine technische Hürde, die man wegprogrammiert, sondern eine Genehmigungsfrage, die **vor** jeder Implementierung steht.

**Der zweite Grund ist Wettbewerb um die falsche Aufgabe.** Eine dynamische Abfrage- und Analyse-Schleife über Theme-Dateien ist genau das, was Coding-Agenten (Claude Code und Vergleichbares) bereits deutlich besser können — mit Repo-Kontext, Iteration und Werkzeugzugriff, den eine embedded Shopify-App nicht nachbaut. Diese Fähigkeit in ContentPilot zu duplizieren hieße, eine schlechtere Version eines vorhandenen Werkzeugs zu bauen.

Dazu kämen bei der GitHub-Variante noch: ein zweiter OAuth-Provider, dessen Token je nach Grant das gesamte Repo oder die Organisation des Merchants öffnet (andere Risikoklasse als ein Shopify-Session-Token, und im App-Store-Review exponiert); eine Zielgruppe, die als Content- und SEO-Verantwortliche typischerweise gar keine Repo-Verknüpfung eingerichtet hat; und Merge-Konflikte, weil Shopifys GitHub-Integration bidirektional synchronisiert.

**Konsequenz für diesen Plan:** Er kommt vollständig ohne Theme-Dateizugriff aus. Datenquelle ist ausschließlich die PageSpeed-Insights-API. Nichts in den Phasen 0–6 berührt `themeFilesUpsert` oder erweitert die Nutzung von `write_themes`.

---

## 3. Der Seitenaufbau — das Kernstück dieser Fassung

### 3.1 Zielzustand

```
┌ Banner „Was misst dieser Test?" ────────────────────────┐   bleibt (Text erweitern, §1.1)
└─────────────────────────────────────────────────────────┘
┌ Card „Seite testen" ────────────────────────────────────┐   bleibt unverändert
│  Seite · eigener Pfad · Gerät · [Jetzt testen] [Erneut] │   EIN Scan speist ALLE Tabs
│  „3 von 20 Tests heute verbraucht."                     │
└─────────────────────────────────────────────────────────┘
  Fehler-Banner (nur bei Fehler)                              bleibt

┌ Card (neu, ohne Titel) ─────────────────────────────────┐
│  ⓘ Historischer Test vom 21.07. · /products/x · Mobil   │   ← kleiner Hinweis, KEINE Card
│    [Zurück zum aktuellen Test]                          │
│  ⓘ Zwischengespeichertes Ergebnis …                     │   ← nur bei stale
│  ⚠ Google konnte diese Seite nicht analysieren          │   ← runtimeError/runWarnings, global
│                                                          │
│    ◍ 76        ◍ 97          ◍ 73        ◍ 100          │   ← Score-Strip, §3.3
│   Ladezeit  Barrierefrei-  Best Prac-     SEO           │      wie auf pagespeed.web.dev
│             heit           tices                        │
│ ─────────────────────────────────────────────────────── │
│ │ Ladezeit │ Barrierefreiheit │ Best Practices │        │   ← Polaris <Tabs>
│ ─────────────────────────────────────────────────────── │
│                                                          │
│   (Inhalt des gewählten Tabs, §3.4–§3.6)                │
│                                                          │
└─────────────────────────────────────────────────────────┘
┌ Card „Echte Besucherdaten" (RUM) ───────────────────────┐   bleibt unverändert
└─────────────────────────────────────────────────────────┘
┌ Card „Bisherige Tests" ─────────────────────────────────┐   bleibt, + 1 Spalte (§3.7)
└─────────────────────────────────────────────────────────┘
```

Die Tab-Card wird — wie heute der Ergebnisblock — **nur gerendert, wenn ein Ergebnis vorliegt** (`result != null`). Drei leere Tabs vor dem ersten Test wären reines Rauschen.

### 3.2 Hinweise oberhalb der Tabs

Alles, was für **alle** Tabs gilt, steht über der Tab-Leiste — sonst müsste es dreimal gerendert werden oder verschwände, sobald der Merchant den Tab wechselt.

| Hinweis | heute | künftig |
|---|---|---|
| Historischer Test | `<Banner tone="info" title=… onDismiss>` mit Fließtext + Button | **eine Zeile** `bodySm`/`subdued` mit Datum, Pfad und Gerät + `Button variant="plain"` „Zurück zum aktuellen Test" |
| Zwischengespeichert (stale) | Banner `warning` | bleibt Banner (ist eine echte Einschränkung des Ergebnisses) |
| `runtimeError` | Banner `critical` | bleibt Banner, wandert **über** die Tabs — wenn Lighthouse die Seite gar nicht laden konnte, sind alle drei Kategorien leer, nicht nur die Ladezeit |
| `runWarnings` | Banner `warning` | bleibt Banner, über die Tabs (gilt für den ganzen Lauf) |
| kein Element-Screenshot (`!annotatable`) | Banner `info` | bleibt Banner, aber **im Ladezeit-Tab** — betrifft nur die Screenshot-Ausschnitte dort |

Für den Historisch-Hinweis werden `viewingHistoryTitle` und `viewingHistoryBody` durch **einen** Schlüssel ersetzt (`viewingHistoryHint`, Platzhalter `{date}` `{url}` `{strategy}`); `viewingHistoryBack` bleibt. Die alten beiden Schlüssel in allen drei Sprachdateien entfernen — sonst bleiben sie als toter Ballast liegen.

### 3.3 Der Score-Strip — die Kategorie-Übersicht wie auf pagespeed.web.dev

PSI stellt seiner Auswertung eine Reihe kleiner Ring-Scores voran (Leistung · Barrierefreiheit · Best Practices · SEO). **Das übernehmen wir**: eine Zeile kleiner Gauges direkt unter den Hinweisen und direkt über der Tab-Leiste.

Sie leistet genau das, was die Tabs allein nicht können: Der Merchant sieht **alle** Kategorien auf einen Blick, ohne durchzuklicken — sonst wüsste er nicht, dass es sich lohnt, den Barrierefreiheits-Tab überhaupt zu öffnen. Die Tabs bleiben die Detailebene, der Strip ist die Zusammenfassung.

**Umsetzung:**

- **Bauteil:** derselbe `ScoreGauge` wie heute, mit einem kleineren Größen-Parameter (Ring ~48px statt 190px, Zahl im Ring, Beschriftung darunter) und **ohne** die Hover-Split-Mechanik — die erklärt Metrik-Gewichte und ergibt nur bei der Performance-Kategorie Sinn. `GAUGE_SIZE`/`GAUGE_RADIUS`/`GAUGE_STROKE` sind heute Modul-Konstanten ([app.seo.performance.tsx:739-744](../../app/routes/app.seo.performance.tsx#L739-L744)) und müssen dafür zu Props werden.
- **Farbbänder:** unverändert `lighthouseTone` (90 / 50), also dieselbe Ampel wie die große Gauge. Kein zweites Bandschema auf einer Seite.
- **Kein Wert:** Kategorie fehlt im Response oder Lighthouse konnte nicht scoren → grauer Ring mit „–", nicht 0 und nicht ausgeblendet. Ein fehlender Ring in der Reihe liest sich als „ist alles in Ordnung".
- **Klick schaltet den Tab um.** Der Strip ist damit auch die Navigation, genau wie die Sprungmarken auf pagespeed.web.dev. Der Gauge des aktiven Tabs wird hervorgehoben (Beschriftung `fontWeight="semibold"`), damit Strip und Tab-Leiste nicht widersprüchlich wirken.
- **Beschriftungen** kommen aus denselben i18n-Schlüsseln wie die Tab-Namen (§8) — zwei Wörter für dieselbe Sache auf 100px Abstand wären ein Fehler.
- **Barrierefreiheit des Strips selbst:** Die Gauges sind Buttons mit `aria-label` „{Kategorie}: {Score} von 100" und `aria-selected`-Kopplung an die Tabs. Eine Barrierefreiheits-Auswertung, die selbst nur per Maus bedienbar ist, wäre schwer zu verteidigen.

**Der SEO-Ring — bewusst nur Zahl, kein Tab.** §12 schließt die Lighthouse-SEO-Kategorie inhaltlich aus, weil ihre Befunde sich fast vollständig mit unseren eigenen SEO-Sections überschneiden. Der **Score** dagegen kostet nichts und fehlt im Strip sofort auffällig, wenn PSI ihn zeigt und wir nicht. Deshalb:

- Der SEO-Ring wird angezeigt, hat aber **keinen Tab** und **keine Befundliste**.
- Ein Klick darauf öffnet keinen Tab, sondern zeigt einen kurzen Hinweis mit Link auf die eigenen SEO-Werkzeuge (Overview / Meta-Daten).
- Die Beschriftung muss ihn von unserem eigenen SEO-Score abgrenzen — Vorschlag „SEO (Google-Technik)" mit `HelpTooltip`. **Ungelöste Spannung, siehe §11.4:** Unser Dashboard-Score und Lighthouse' SEO-Score messen Verschiedenes und werden verschiedene Zahlen zeigen.

**„Agentisches Browsing"** (der fünfte Eintrag im PSI-Screenshot, ein Bestanden-Zähler „3/3", kein Score) ist neu und in der dokumentierten `category`-Aufzählung der PSI-API v5 nicht gesichert. **In Phase 1 prüfen**, ob die API sie liefert; wenn ja, als weitere Kachel am Ende des Strips ergänzen (Zähler statt Ring), wenn nein, ersatzlos weglassen. Nicht raten — die Kachel steht oder fällt mit dem Response.

### 3.4 Tab 1 „Ladezeit" — der heutige Inhalt, unverändert in der Sache

Reihenfolge innerhalb des Tabs, identisch zu heute:

1. Echte Nutzerdaten (Google CrUX) — Gesamtbewertung, Core-Web-Vitals-Kacheln mit Schwellenwert-Balken, „Andere wichtige Messwerte", Origin-Fallback-Hinweis
2. Laborergebnis — Split-Gauge, Screenshot-Vorschau, „Getestet: …", Score-Legende, Core Web Vitals
3. Banner „kein Element-Screenshot"
4. Befunde (Akkordeon mit Lighthouse-Detailtabellen und Element-Thumbnails)

**Der eine echte Umbau: Card-in-Card auflösen.** CrUX ([1241](../../app/routes/app.seo.performance.tsx#L1241)), Labor ([1278](../../app/routes/app.seo.performance.tsx#L1278)) und Befunde ([1439](../../app/routes/app.seo.performance.tsx#L1439)) sind heute je eine eigene `<Card>`. Innerhalb der Tab-Card werden daraus Abschnitte in einem `BlockStack` mit `<Divider>` dazwischen und einer `headingSm`/`subdued`-Überschrift je Abschnitt — verschachtelte Polaris-Cards sind kein Muster, das die App sonst verwendet.

Zu beachten beim Umbau:
- Das `padding="600"` der beiden Ergebnis-Cards entfällt; die äußere Card bringt ihr eigenes Padding mit. Die Kachel-Grids (`FIELD_GRID_STYLE`) und die 260px-Deckelung der Balken bleiben unangetastet — sie hängen an der Spaltenbreite, nicht am Card-Padding.
- Der Trenn-Hairline zwischen Gauge und Screenshot im Laborblock bleibt (das ist ein `<div>`, keine Card-Grenze).
- Der Befunde-Block rendert seine Zeilen bereits mit eigenem `borderTop` — im Tab sieht das unverändert aus.

### 3.5 Tab 2 „Barrierefreiheit"

1. **Hinweistext** aus §1.3, nicht ausblendbar, ganz oben im Tab.
2. **Kein eigener großer Gauge** — der Score steht bereits im Strip (§3.3), zwei Ringe mit derselben Zahl im Abstand von 60px wären Doppelung. Die Ladezeit behält ihren großen Gauge nur deshalb, weil dessen Hover-Split die Gewichtung erklärt; für Accessibility gibt es nichts Vergleichbares zu erklären.
3. **Befundliste** — dasselbe Akkordeon-Bauteil wie bei den Ladezeit-Befunden, damit beide Tabs als ein Werkzeug lesbar bleiben. Pro Befund: Titel, Beschreibung, betroffene Elemente (Selektor + gekapptes Snippet, mit Offenlegung der Kappung), bei `image-alt` zusätzlich der Aktions-Button aus §7.
4. **Manuelle Prüfpunkte** — Lighthouse' `scoreDisplayMode: "manual"`-Audits, eingeklappt und klar als „von Google nicht automatisch geprüft" beschriftet. Sie in die normale Befundliste zu mischen wäre irreführend: sie sind keine gefundenen Fehler.

### 3.6 Tab 3 „Best Practices"

Einleitungssatz „Zusatzinformationen — fließt in keine Bewertung ein und liegt teils außerhalb deines Einflusses" (§1.2), darunter dieselbe Befundliste. Kein Gauge im Tab; der Score steht im Strip.

Zur Klarstellung gegenüber §1.2: „kein Score-Beitrag" heißt, dass Best Practices in **keine aggregierte Bewertung** eingeht — nicht, dass die Zahl versteckt wird. Im Strip steht sie gleichberechtigt neben den anderen, so wie PSI es tut; der Einleitungssatz im Tab ordnet sie ein.

### 3.7 History („Bisherige Tests")

Bleibt die eigene Card unten und bleibt die gemeinsame Historie: **eine** Zeile pro Testlauf, weil ein Lauf alle drei Kategorien enthält. Ergänzt wird eine Spalte „Barrierefreiheit" neben „Score". Best Practices bekommt **keine** Spalte — dieselbe Begründung wie §1.2, und die Tabelle hat bei vier Spalten schon genug zu tragen.

Ein Klick auf eine Zeile lädt wie heute den gespeicherten Lauf in den Ergebnisblock — jetzt also samt Barrierefreiheits- und Best-Practices-Tab.

### 3.8 Zustand und Altbestand

- **Tab-Auswahl** ist lokaler State. Sie wird bei einem neuen Testlauf **nicht** zurückgesetzt: wer auf „Barrierefreiheit" steht und erneut testet, will das neue Barrierefreiheits-Ergebnis sehen, nicht wieder die Ladezeit.
- **Alte gespeicherte Läufe** (vor dieser Änderung, und der 30-Minuten-Cache über den Deploy hinweg) haben keine Qualitätsdaten im `result`-JSON. Die Tabs 2 und 3 zeigen dann einen expliziten Leerzustand: „Dieser Testlauf wurde vor der Qualitätsprüfung gespeichert — starte einen neuen Test." Ein leerer Tab ohne Erklärung liest sich als Fehler.

---

## 4. Datenmodell

**Kein neues Modell.** `SeoPageSpeedAudit` bekommt zwei nullable Spalten, nach demselben Muster wie das bestehende `score` („denormalized for history lists"):

```prisma
model SeoPageSpeedAudit {
  id                 String   @id @default(cuid())
  shop               String
  url                String
  strategy           String // "mobile" | "desktop"
  score              Int?   // Lighthouse performance score 0-100
  a11yScore          Int?   // Lighthouse accessibility score 0-100 (neu)
  bestPracticesScore Int?   // Lighthouse best-practices score 0-100 (neu)
  result             Json   // PageSpeedAuditResult
  createdAt          DateTime @default(now())

  @@index([shop, url, strategy, createdAt])
  @@index([shop, createdAt])
}
```

Die Befunde selbst wandern in das bestehende `result`-JSON (§5.2) — sie werden nur zusammen mit dem Lauf gelesen, eine eigene Tabelle brächte nichts.

**Der SEO-Score bekommt bewusst keine Spalte.** Spalten gibt es nur für Werte, die eine Listenansicht ohne das JSON braucht — das ist die History-Tabelle, und die zeigt Performance und Barrierefreiheit (§3.7). Der SEO-Score lebt im `result`-JSON und wird nur im Score-Strip des geöffneten Laufs gelesen.

**Migration** ist rein additiv und nullable, also ohne Backfill und ohne Downtime. Alte Zeilen behalten `null` und lösen den Leerzustand aus §3.8 aus.

**GDPR:** `SeoPageSpeedAudit` wird bereits in `redactShopData` gelöscht ([gdpr.service.ts:479](../../app/services/gdpr.service.ts#L479)). Da **kein neues Modell** entsteht, bleibt der Schema-Coverage-Drift-Guard grün und der Coverage-Kommentarblock unverändert. Das ist einer der handfesten Gewinne gegenüber der ersten Fassung.

**Prune** bleibt wie er ist: 10 Zeilen pro `(shop, url, strategy)`.

**Größenrisiko:** Das `result`-JSON enthält bereits Base64-Screenshots. Die Qualitäts-Befunde kommen obendrauf, deshalb gelten Kappungen analog zu den bestehenden `MAX_*`-Konstanten in [pagespeed.service.ts:324-332](../../app/services/seo/pagespeed.service.ts#L324-L332) — Vorschlag: max. 15 Befunde je Kategorie, max. 5 betroffene Elemente je Befund, Snippet auf `MAX_CELL_LENGTH` gekappt. Die Gesamtzahl **vor** der Kappung wird mitgespeichert und in der UI offengelegt.

---

## 5. Service

### 5.1 `fetchPageSpeedInsights` bekommt Kategorien

```ts
async function fetchPageSpeedInsights(
  url: string,
  strategy: PageSpeedStrategy,
  locale?: string,
  categories: string[] = ["performance", "accessibility", "best-practices", "seo"],
): Promise<unknown>
```

`seo` ist dabei, weil der Score-Strip (§3.3) den SEO-Ring zeigt. Die **Befunde** dieser Kategorie werden verworfen, nur der Score wird übernommen — inhaltliche Begründung in §12.

Alles andere in der Datei — Timeout, 429/`PageSpeedQuotaExceededError`, Tageslimit, Cache-Lookup, Prune — bleibt unverändert und wird geteilt. **Kein zweiter PSI-Client, kein zweiter Aufrufpfad.**

**Zu messen in Phase 1:** `PSI_TIMEOUT_MS` steht auf 60s ([pagespeed.service.ts:50](../../app/services/seo/pagespeed.service.ts#L50)). Vier Kategorien bedeuten deutlich mehr Audits und eine spürbar größere Antwort; wenn Läufe an die Grenze stoßen, muss der Wert hoch (und der `runningHint`-Text von „15–30 Sekunden" mit ihm). Das ist die einzige Stelle, an der die Zusammenlegung etwas kosten kann — sie gehört gemessen, nicht geschätzt.

### 5.2 Parser: eine Erweiterung, kein zweiter Vertrag

`parsePageSpeedResponse` liefert weiterhin **ein** `PageSpeedAuditResult`. Es bekommt ein optionales Feld:

```ts
export interface QualityIssue {
  id: string;              // Lighthouse-Audit-ID, z.B. "color-contrast"
  title: string;
  description?: string;    // Markdown-Links gestrippt (stripMarkdownLinks wiederverwenden)
  /** Lighthouse-Score des Audits: 0 = durchgefallen, 1 = bestanden, null = nicht bewertbar. */
  score: number | null;
  /** Betroffene Elemente: Selektor + Snippet, gekappt. */
  items: Array<{ selector?: string; snippet?: string; url?: string }>;
  itemTotal: number;       // vor der Kappung
  /** `scoreDisplayMode: "manual"` — von Lighthouse nicht automatisch geprüft. */
  manual: boolean;
}

export interface QualityResult {
  a11yScore: number | null;
  bestPracticesScore: number | null;
  /** Nur für den Score-Strip (§3.3) — die SEO-Befunde werden bewusst verworfen (§12). */
  seoScore: number | null;
  accessibility: QualityIssue[];
  bestPractices: QualityIssue[];
  accessibilityTotal: number;   // vor der Kappung
  bestPracticesTotal: number;
  /** PSI-Kategorie „Agentic browsing", falls die API sie liefert — sonst undefined (§3.3). */
  agentic?: { passed: number; total: number };
}

// in PageSpeedAuditResult:
//   quality?: QualityResult;   // fehlt bei Läufen vor dieser Änderung → §3.8
```

Optional, nicht pflicht — genau deshalb bleiben alte gespeicherte Läufe typkonform lesbar.

Der Parser ist wie `parsePageSpeedResponseInner` **defensiv und wirft nie**: fehlt die Kategorie im Response, bleibt `quality` undefined und die Ladezeit-Auswertung läuft unbeirrt weiter. Die Lehren aus dem Performance-Report werden übernommen — `description` wird gerendert statt verworfen, Kappungen werden offengelegt, `null` bleibt `null` und wird nicht zu 0 geglättet.

`runPageSpeedAudit` schreibt zusätzlich `a11yScore` und `bestPracticesScore` in die neuen Spalten; `listPageSpeedHistory` gibt sie mit aus.

### 5.3 Kein `analyze()`, kein Dashboard-Beitrag

Der Contract (§3) verlangt ein `analyze()` je Section. Diese Section hat keins und braucht keins: sie hat einen eigenen Loader und eine eigene Action, und die Ladezeit-Section hatte auch bisher keins. Siehe §11.1.

---

## 6. Kontingent

PSI zählt **Requests, nicht Kategorien**. Ein Aufruf mit vier Kategorien kostet exakt so viel wie einer mit einer.

Daraus folgt die zentrale Eigenschaft dieser Fassung: **Der Merchant startet genau einen Test wie bisher und bekommt alle Kategorien auf einmal.** Die Qualitätsdaten sind, gemessen am Tagesbudget, umsonst.

Damit ändert sich am Budget **nichts**:

- `countPageSpeedRunsToday` zählt weiter `SeoPageSpeedAudit`-Zeilen — es gibt keine zweite Tabelle, die mitgezählt werden müsste. Der Kommentar im Code, der eine künftige zweite Tabelle ankündigt, wird ersatzlos gestrichen.
- Die Staffelung bleibt: Free 5 · Basic 20 · Pro 40 · Max 80 Läufe pro UTC-Tag (`PlanLimits.dailyPageSpeedRuns`, [plans.ts](../../app/config/plans.ts)).
- Die Budget-Anzeige über dem Test-Button bleibt unverändert.
- Der 429-Pfad und der Tageslimit-Pfad bleiben unverändert und decken die neuen Kategorien automatisch mit ab.

Die Kollision, die die erste Fassung auf dem Free-Plan hatte (ein Voll-Scan über 5 Templates × 2 Strategien = 10 Läufe gegen ein Budget von 5), **entfällt** — es gibt keinen Voll-Scan mehr.

---

## 7. Der Punkt, der das Feature rechtfertigt: der Alt-Text-Brückenschlag

Ein reiner Report ist wenig wert, weil ContentPilot Kontrast-, ARIA- und Fokus-Probleme nicht beheben kann — das sind Theme-Themen.

**Eine Ausnahme gibt es, und die ist die wichtigste:** der `image-alt`-Audit trifft genau die Funktion, die die App bereits besitzt.

**Ablauf:**
1. Lighthouse meldet unter `image-alt` betroffene Elemente inklusive Bild-URL.
2. Die URL wird gegen `ProductImage.url` ([schema.prisma:404](../../prisma/schema.prisma#L404)) gematcht.
3. Bei Treffer rendert die Befundzeile im Barrierefreiheits-Tab einen „Alt-Text generieren"-Button, der in den bestehenden Pfad ([alt-text.action.ts](../../app/actions/content/alt-text.action.ts)) führt.

**Wichtiger Vorbehalt, der beim Bauen zu prüfen ist:** Shopify liefert CDN-URLs mit Transformations-Suffixen (`_1024x1024`, `?v=…`). Ein naiver Vergleich schlägt fehl. Der Match muss auf dem normalisierten Dateinamen-Stamm laufen, und er wird nicht immer gelingen — Bilder aus Theme-Assets oder Metafeldern haben gar keine `ProductImage`-Zeile. Die UI muss den Fall „gefunden, aber nicht zuordenbar" sauber zeigen, statt einen toten Button zu rendern.

Erwartete Trefferquote ist unbekannt. Das ist der erste Spike (§11.3), bevor der Rest gebaut wird — trägt der Brückenschlag nicht, schrumpft das Feature auf einen Report, und dann ist die Priorität neu zu bewerten.

---

## 8. i18n

Reihenfolge zwingend `de.ts` → `en.ts` → `es.ts` (`de.ts` definiert den `Translation`-Typ; Contract §5).

**Neu bzw. geändert:**

- `t.seo.sections.performance` — der Section-Name (§1.1). Nur der String, nicht der Schlüssel.
- `t.seo.performancePage.helpTitle` / `helpBody1` / `helpBody2` — erweitern, damit sie nicht länger nur den Ladezeit-Test beschreiben.
- `t.seo.performancePage.tabs.{performance,accessibility,bestPractices}` — Tab-Beschriftungen. **Dieselben Schlüssel** beschriften die Ringe im Score-Strip (§3.3); zwei Wörter für dieselbe Kategorie darf es nicht geben.
- `t.seo.performancePage.strip.{seo,seoHint,agentic,scoreAriaLabel,noScore}` — SEO-Ring samt Abgrenzungshinweis (§11.4), optionale Agentic-Kachel, `aria-label`-Muster „{Kategorie}: {Score} von 100", Platzhalter „–".
- `t.seo.performancePage.viewingHistoryHint` — ersetzt `viewingHistoryTitle` + `viewingHistoryBody` (§3.2); beide alten Schlüssel in allen drei Dateien löschen.
- `t.seo.performancePage.a11y.*` — Ehrlichkeits-Hinweis (§1.3), Score-Titel, Leerzustand, Titel des Manuell-Blocks, Alt-Text-Button, Text für „nicht zuordenbar".
- `t.seo.performancePage.bestPractices.*` — Einleitung, Leerzustand.
- `t.seo.performancePage.qualityUnavailable` — Leerzustand für Altbestand-Läufe (§3.8).
- `t.seo.performancePage.historyColA11y` — die neue History-Spalte (§3.7).
- Falls Tooltips gewünscht: neue Hilfetexte im selben Hilfe-Register wie `perfLcp` (liegt ebenfalls in den i18n-Dateien).

**Nicht zu übersetzen:** Lighthouse-Audit-Titel und -Beschreibungen. Sie kommen bereits lokalisiert von Google, weil `locale` seit dem Ladezeit-Ausbau mitgeschickt wird ([pagespeed.service.ts:185](../../app/services/seo/pagespeed.service.ts#L185)). Eigene Übersetzungen für ~50 Audit-Texte, die sich mit jeder Lighthouse-Version ändern, wären reine Pflegelast.

---

## 9. Was aus der ersten Fassung ersatzlos entfällt

Ausdrücklich hier festgehalten, damit es niemand aus dem alten Text wiederbelebt:

| Entfällt | Grund |
|---|---|
| Section-Descriptor `quality`, Route `/app/seo/quality` | §1.1 — die Ladezeit-Section trägt es mit |
| Prisma-Modell `SeoQualityAudit` + `redactShopData`-Eintrag + Coverage-Kommentar | §4 — zwei Spalten an einer bestehenden Tabelle statt eines neuen Modells |
| Hintergrund-**Task** `qualityScan` (Task-Row, `expiresAt`, detached Runner, Progress-Heartbeat) | Ein Lauf ist ein synchroner Request über die bestehende Fetcher-Action; es gibt keinen Mehr-URL-Scan mehr |
| Eintrag in `LONG_RUNNING_TASK_TYPES` ([task-recovery.service.js](../../task-recovery.service.js)) | kein Task |
| Single-flight-Sperre pro Shop | kein Task; der Test-Button ist bereits über `fetcher.state` und das Tagesbudget gesperrt |
| Template-Mehrfachauswahl + Voll-Scan über 5 Templates × 2 Strategien | Der bestehende Einzelseiten-Picker bleibt die Steuerung |
| Plan-abhängige Ableitung des Scan-Umfangs (Free-Kollision) | §6 — ohne Voll-Scan gibt es keine Kollision |
| Eigenes `analyze()` nach Contract §3 | §5.3 |
| `t.tasks.taskType.qualityScan` | kein Task |

Was **bleibt**: der Logger-Namespace. Die neuen Parser-Zweige loggen unter dem bestehenden Namespace der Ladezeit-Section, nicht unter einem eigenen — es ist dieselbe Section.

---

## 10. Phasen

| Phase | Inhalt | Ergebnis |
|---|---|---|
| **0** | Spike §11.3: Alt-Text-Match-Trefferquote an echten Daten messen | Go/No-Go für §7 |
| **1** | `fetchPageSpeedInsights` um Kategorien erweitern (inkl. `seo`); Parser + `QualityResult`-Typen + Tests; prüfen, ob die API „Agentic browsing" liefert; Laufzeit gegen `PSI_TIMEOUT_MS` messen | Parser grün, Daten kommen an, noch keine UI |
| **2** | Prisma: `a11yScore` + `bestPracticesScore` + Migration; Schreiben in `runPageSpeedAudit`; `listPageSpeedHistory` erweitern | Werte landen in der DB und in der History-Abfrage |
| **3** | **Struktureller Umbau:** Tab-Card einziehen, Ladezeit-Tab = heutiger Inhalt (Card-in-Card auflösen), Historisch-Banner → Hinweiszeile, globale Banner über die Tabs, **Score-Strip** (§3.3) mit `ScoreGauge` als Größen-Prop | Alle Kategorie-Scores sichtbar, Details vorerst nur für Ladezeit |
| **4** | Tab „Barrierefreiheit": Ehrlichkeits-Hinweis, Befundliste, manuelle Prüfpunkte, Leerzustand für Altbestand; Strip-Ring wird klickbar; Section-Umbenennung; i18n de→en→es | Der neue Nutzen ist sichtbar |
| **5** | Alt-Text-Brückenschlag (§7) | Der Befund wird behebbar |
| **6** | Tab „Best Practices" + History-Spalte „Barrierefreiheit" | Das Goodie |

Phase 3 bewusst **vor** den neuen Tabs: Der Umbau der bestehenden Seite ist der Teil mit dem größten Regressionsrisiko (Card-in-Card, Grid-Breiten, Bannerplatzierung, `ScoreGauge`-Parametrisierung). Ihn allein zu deployen heißt, ihn allein prüfen zu können — steckte er mit dem neuen Tab zusammen im selben Schritt, wäre bei einem Layout-Fehler nicht klar, welche Hälfte ihn verursacht hat.

In Phase 3 zeigt der Strip bereits alle Ringe (die Daten liegen seit Phase 1/2 vor), aber nur der Ladezeit-Ring hat ein Ziel. Die übrigen sind dort reine Anzeige und werden erst in Phase 4 bzw. 6 klickbar — ein Ring, der beim Klick nichts tut, braucht in Phase 3 keinen Cursor-Pointer.

Nach jeder Phase ist ein benutzbarer Zwischenstand erreicht.

---

## 11. Entschieden / offen

### 11.1 Keine Dashboard-Aggregation — **entschieden 2026-07-22**

**Befund:** `SeoFinding` existiert im Code **nicht** (null Vorkommen). Contract §2 beschreibt einen nie gebauten Mechanismus. Das Dashboard wird ausschließlich von `analyzeStore` ([audit.service.ts:330](../../app/services/seo/audit.service.ts#L330)) über einen Snapshot gespeist, und **keine** der bestehenden Sections trägt etwas bei — jede lebt auf ihrer eigenen Route.

**Entscheidung:** Kein Dashboard-Beitrag, exakt wie bei allen bestehenden Sections. Kein Sonderfall, keine neue Infrastruktur.

Verworfen wurde außerdem, Barrierefreiheit als `AuditType` in `analyzeStore` zu führen: das ist item-zentriert über den Katalog, Barrierefreiheits-Befunde sind seiten-zentriert. Ein Kontrastproblem gehört keinem Produkt.

**Separat zu erledigen:** Contract §2 korrigieren. Er beschreibt derzeit einen Mechanismus, den es nicht gibt, und führt jeden Leser in dieselbe Fehlannahme.

### 11.2 Kein Plan-Gate, sondern ein Tageslimit — **entschieden 2026-07-22, bereits umgesetzt**

**Begründung:** PSI wird gegen **unseren** `PAGESPEED_API_KEY` abgerechnet, ist also eine von der App bezahlte, über alle Shops geteilte Ressource — anders als AI-Tokens (BYO, deshalb ungedeckelt). Das ist Verbrauch, nicht Berechtigung. Dasselbe Muster wie `monthlyImageOperations` in [plans.ts](../../app/config/plans.ts), das dort ausdrücklich als „usage data, NOT entitlement data" geführt wird.

**Umsetzung (steht):** `PlanLimits.dailyPageSpeedRuns`, gelesen über `getDailyPageSpeedRunsLimit`, durchgesetzt in [pagespeed.service.ts](../../app/services/seo/pagespeed.service.ts) via `countPageSpeedRunsToday`. Eine `SeoPageSpeedAudit`-Zeile entsteht nur nach einem Lauf, der Google tatsächlich erreicht hat — der Zeilen-Count **ist** der Verbrauchszähler. Die Prüfung sitzt bewusst **nach** dem Cache-Lookup: ein zwischengespeichertes Ergebnis kostet kein Kontingent.

**Staffelung:** Free 5 · Basic 20 · Pro 40 · Max 80 Läufe pro UTC-Tag.

**Für diesen Plan:** keine Änderung nötig (§6). Der Kommentar im Code, der eine künftige zweite Tabelle zum Mitzählen ankündigt, wird gestrichen.

**Plan-Gates insgesamt** werden separat neu überdacht; die Section bleibt ungegatet.

### 11.3 Alt-Text-Match — Spike vor Phase 1 (offen)

An einem echten Shop messen, welcher Anteil der `image-alt`-Befunde sich auf eine `ProductImage`-Zeile abbilden lässt (§7). Unter grob einem Drittel Trefferquote ist §7 kein tragender Nutzen und die Phasen 5/6 sind neu zu bewerten.

### 11.4 Zwei SEO-Scores auf einer Seite — offen, vor Phase 3 zu entscheiden

Der Score-Strip (§3.3) zeigt Lighthouse' SEO-Score, weil PSI ihn zeigt und eine Lücke in der Reihe auffiele. ContentPilot hat aber **einen eigenen** SEO-Score ([seo-score.ts](../../app/utils/seo-score.ts), Bänder 70/40) im Dashboard. Beide messen Verschiedenes: Lighthouse prüft technische Seiten-Grundlagen (Titel-Tag vorhanden, crawlbar, Viewport), unser Score prüft Inhalt und Abdeckung über den Katalog. Sie werden regelmäßig auseinanderliegen — „SEO 100" hier, „SEO 62" dort.

**Empfehlung:** Ring zeigen, aber klar abgrenzen — Beschriftung „SEO (Google-Technik)" plus `HelpTooltip`, der in einem Satz sagt, dass es sich um Googles technische Prüfung dieser **einen** Seite handelt und nicht um die SEO-Bewertung des Shops. Zusätzlich Bänder unverändert bei 90/50 lassen (Lighthouse-Logik), damit nicht auch noch die Farbschwellen zweier Scores kollidieren.

**Alternative, falls die Verwechslungsgefahr schwerer wiegt als die Lücke in der Reihe:** den Ring weglassen und im Strip nur Ladezeit · Barrierefreiheit · Best Practices zeigen. Das ist die konservative Variante und exakt das, was §12 inhaltlich vorgibt.

Die Entscheidung fällt spätestens mit Phase 3, weil dort der Strip gebaut wird. Am Aufwand ändert sie fast nichts — ein Ring mehr oder weniger.

### 11.5 Name der Section (offen, klein)

„Ladezeit & Qualität" ist der Vorschlag (§1.1). Entscheidung fällt spätestens in Phase 4, weil dort die i18n-Strings ohnehin angefasst werden. Am Code ändert die Wahl nichts — es ist ein String in drei Dateien.

---

## 12. Bewusst nicht in diesem Plan

- **Die Lighthouse-SEO-*Befunde*** (nicht der Score — der steht im Strip, §3.3/§11.4). Sie überschneiden sich fast vollständig mit [bulk-meta](../../app/routes/app.seo.bulk-meta.tsx), [hreflang](../../app/routes/app.seo.hreflang.tsx), [redirects](../../app/routes/app.seo.redirects.tsx) und dem eigenen Score in [seo-score.ts](../../app/utils/seo-score.ts). Eine zweite, anders gewichtete SEO-Befundliste neben den eigenen Werkzeugen verwirrt mehr, als sie hilft, und der `structured-data`-Audit dort ist ohnehin ein reiner Handprüfungs-Hinweis ohne Validierung. Der Parser verwirft die Audits dieser Kategorie deshalb bewusst und behält nur die Zahl.
- **GitHub-Anbindung und KI-Analyse von Theme-Dateien.** Siehe §2 — Scope-Bewilligung und Werkzeug-Konkurrenz, nicht zurückgestellt sondern verworfen.
- **Eigene axe-core-Ausführung** (statt PSI). Würde einen Headless-Browser auf Railway bedeuten — eine ganz andere Betriebsklasse als ein HTTP-Call.
- **Mehr-Seiten-Scan** (mehrere Templates in einem Rutsch). Fiel mit dem Task weg (§9). Falls er später gewünscht wird, ist er ein eigenes Vorhaben mit eigener Budget-Rechnung — und er würde dann Ladezeit **und** Qualität gemeinsam betreffen, nicht nur die neuen Tabs.
