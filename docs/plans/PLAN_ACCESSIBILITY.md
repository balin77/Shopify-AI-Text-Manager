# Barrierefreiheit & Website-Qualität — Plan

**Status:** Entwurf, nicht begonnen (2026-07-22).
**Baut auf:** der bestehenden PSI-Anbindung ([pagespeed.service.ts](../../app/services/seo/pagespeed.service.ts)) und dem Alt-Text-Pfad ([alt-text.action.ts](../../app/actions/content/alt-text.action.ts)).
**Section-Contract:** siehe [SEO_SECTION_CONTRACT.md](../architecture/SEO_SECTION_CONTRACT.md) — dieser Plan führt **eine** neue Section ein und erfüllt die Punkte 1–8.

---

## 0. Ist-Zustand

**PSI-Anbindung** ([pagespeed.service.ts:122](../../app/services/seo/pagespeed.service.ts#L122)):

```ts
apiUrl.searchParams.append("category", "performance");
```

Genau eine Kategorie. Der Rest der Datei (Fetch mit 60s-Timeout, 429-Behandlung über `PageSpeedQuotaExceededError`, 30-Minuten-Cache, History-Prune auf 10 Zeilen pro `(shop, url, strategy)`) ist **kategorie-agnostisch** und direkt wiederverwendbar. Nur `parsePageSpeedResponse` ist performance-spezifisch.

**Alt-Texte:** `ProductImage` hält `url`, `altText` und `mediaId` ([schema.prisma:399-409](../../prisma/schema.prisma#L399-L409)). Damit ist eine Rückabbildung von einer CDN-URL im Lighthouse-Befund auf eine editierbare Zeile möglich — die Grundlage für §7.

**Dashboard:** [app.seo._index.tsx:109](../../app/routes/app.seo._index.tsx#L109) wird ausschließlich von `analyzeStore` gespeist; keine Section trägt Findings bei, und den in Contract §2 beschriebenen Typ `SeoFinding` gibt es im Code nicht. Ausgeführt in §11.1 — der Contract ist an dieser Stelle veraltet.

---

## 1. Zielbild und die drei Grundsatz-Entscheidungen

### 1.1 Neue SEO-Section, kein neuer Top-Level-Tab

**Entscheidung: Section `quality` unter dem SEO-Tab.**

Ein neuer Top-Level-Tab müsste eigene Navigation, eigenes Layout, eigenes Gating und eigene Test-Muster mitbringen. Eine SEO-Section kostet dagegen **einen Array-Eintrag** in [seo-sections.ts](../../app/config/seo-sections.ts) und erbt Sub-Nav, `SeoSectionLayout`, Plan-Gate und `HelpTooltip` (Contract §1/§4).

Der Einwand „Barrierefreiheit ist kein SEO" stimmt konzeptionell — aber der SEO-Tab beherbergt bereits Redirects, IndexNow und AEO. Er ist faktisch der „Technische Website-Qualität"-Tab. Wenn die Section später eigenständig trägt, lässt sie sich mit dem Descriptor-Muster in einem Schritt nach oben ziehen.

**Label: „Qualität & Barrierefreiheit"** — bewusst breiter als „Accessibility", damit Best Practices unter dasselbe Dach passt, ohne dass es wie ein Fremdkörper wirkt.

### 1.2 Best Practices ja — aber ohne Score-Beitrag

Best Practices kommt **im selben PSI-Response** mit, kostet also weder einen zusätzlichen Request noch Kontingent. Es als Goodie mitzunehmen ist richtig.

Was **nicht** passieren darf: dass es in den Score einfließt. Die Kategorie prüft überwiegend Dinge, die weder Merchant noch ContentPilot beeinflussen können (HTTPS und HSTS liegen bei Shopify, Konsolenfehler und CSP beim Theme bzw. bei Fremd-Apps). Ein Score, der wegen einer Fremd-App sinkt und den man nicht heben kann, ist ein Support-Ticket-Generator.

**Umsetzung:** eigene, standardmäßig eingeklappte Karte, als „Zusatzinformationen" beschriftet, `points: undefined` bei allen Findings.

### 1.3 Barrierefreiheit muss ehrlich beschriftet sein

Lighthouse' Accessibility-Score basiert auf axe-core und erkennt nur einen Teil der realen Probleme — Google selbst nennt automatisiertes Testing ausdrücklich unvollständig. Ein 100er-Score bedeutet **nicht** „barrierefrei".

Das gehört als fester Hinweistext über die Karte, nicht in einen Tooltip. Ein Shopify-Merchant, der wegen des European Accessibility Act (seit Juni 2025 verbindlich für E-Commerce in der EU) hier landet, darf aus einer grünen Zahl keine Rechtssicherheit ableiten. Das ist kein Nice-to-have im Text, sondern Haftungsvermeidung.

---

## 2. Theme-Dateien und KI — außerhalb dieses Plans

Erwogen und **verworfen**: den Merchant sein Theme über die App verwalten zu lassen (per GitHub-Verknüpfung oder direkt über die Admin-Theme-API), um Theme-Dateien einer KI zur Analyse zu übergeben.

**Der ausschlaggebende Grund ist die Scope-Bewilligung.** ContentPilot hat `write_themes` für einen **bewilligten Verwendungszweck** — Theme-Inhalte und -Übersetzungen. Der Scope im Manifest ist keine Freifahrt: eine allgemeine Theme-Datei-Bearbeitung wäre ein neuer Zweck und bräuchte eine eigene Bewilligung. Das ist keine technische Hürde, die man wegprogrammiert, sondern eine Genehmigungsfrage, die **vor** jeder Implementierung steht.

**Der zweite Grund ist Wettbewerb um die falsche Aufgabe.** Eine dynamische Abfrage- und Analyse-Schleife über Theme-Dateien ist genau das, was Coding-Agenten (Claude Code und Vergleichbares) bereits deutlich besser können — mit Repo-Kontext, Iteration und Werkzeugzugriff, den eine embedded Shopify-App nicht nachbaut. Diese Fähigkeit in ContentPilot zu duplizieren hieße, eine schlechtere Version eines vorhandenen Werkzeugs zu bauen.

Dazu kämen bei der GitHub-Variante noch: ein zweiter OAuth-Provider, dessen Token je nach Grant das gesamte Repo oder die Organisation des Merchants öffnet (andere Risikoklasse als ein Shopify-Session-Token, und im App-Store-Review exponiert); eine Zielgruppe, die als Content- und SEO-Verantwortliche typischerweise gar keine Repo-Verknüpfung eingerichtet hat; und Merge-Konflikte, weil Shopifys GitHub-Integration bidirektional synchronisiert.

**Konsequenz für diesen Plan:** Er kommt vollständig ohne Theme-Dateizugriff aus. Datenquelle ist ausschließlich die PageSpeed-Insights-API. Nichts in den Phasen 0–6 berührt `themeFilesUpsert` oder erweitert die Nutzung von `write_themes`.

---

## 3. Datenmodell

Ein neues shop-scoped Modell:

```prisma
model SeoQualityAudit {
  id        String   @id @default(cuid())
  shop      String
  url       String
  strategy  String   // "mobile" | "desktop"

  a11yScore          Int?    // 0-100, null wenn Lighthouse nicht scoren konnte
  bestPracticesScore Int?
  result             Json    // QualityAuditResult (siehe §4.2)

  createdAt DateTime @default(now())

  @@index([shop, url, strategy, createdAt])
}
```

**Pflicht (Contract §6):** `deleteMany({ where: { shop } })` in `redactShopData` ([gdpr.service.ts](../../app/services/gdpr.service.ts)) **und** Eintrag im Coverage-Kommentarblock darüber. Der Drift-Guard-Test parst `schema.prisma` und wird sonst rot — das ist kein optionaler Schritt.

Prune analog zum bestehenden Muster auf 10 Zeilen pro `(shop, url, strategy)`.

---

## 4. Service

### 4.1 Refactoring von `pagespeed.service.ts`

`fetchPageSpeedInsights` bekommt einen Kategorien-Parameter:

```ts
async function fetchPageSpeedInsights(
  url: string,
  strategy: PageSpeedStrategy,
  categories: string[] = ["performance"],
): Promise<unknown>
```

Alles andere in der Datei — Timeout, 429/`PageSpeedQuotaExceededError`, Cache-Lookup, Prune — bleibt unverändert und wird geteilt. **Kein zweiter PSI-Client.**

### 4.2 Neuer Service `app/services/seo/quality.service.ts`

Parser-Vertrag in `quality.types.ts`:

```ts
export interface QualityIssue {
  id: string;              // Lighthouse-Audit-ID, z.B. "color-contrast"
  title: string;
  description?: string;    // Markdown-Links gestrippt (Helper aus pagespeed.service.ts teilen)
  category: "accessibility" | "best-practices";
  /** Betroffene Elemente: Selektor + Snippet, gekappt. */
  items: Array<{ selector?: string; snippet?: string; url?: string }>;
  /** Lighthouse `scoreDisplayMode: "manual"` — nicht automatisch geprüft. */
  manual: boolean;
}

export interface QualityAuditResult {
  url: string;
  strategy: PageSpeedStrategy;
  fetchedAt: string;
  a11yScore: number | null;
  bestPracticesScore: number | null;
  issues: QualityIssue[];
  itemTotal: number;       // vor der Kappung, damit die UI die Kürzung offenlegt
  runtimeError?: string;
  stale?: boolean;
}
```

Der Parser ist wie `parsePageSpeedResponse` **defensiv und wirft nie** — dieselbe Begründung wie dort (PSI-Formen variieren, Sektionen fehlen). Die Lehren aus dem Performance-Report werden direkt übernommen: `description` wird gerendert, `runtimeError` durchgereicht, Kappungen offengelegt.

### 4.3 `analyze()` nach Contract §3

```ts
export async function analyzeQuality(shop: string, deps): Promise<QualityAuditResult[]>
```

DB-Cache-first: liest die gespeicherten `SeoQualityAudit`-Zeilen, **löst keinen PSI-Lauf aus**. Ein Scan wird ausschließlich explizit über den Task gestartet (§6.2). Ohne Daten gibt `analyze()` ein leeres Array zurück und die Section zeigt den Leerzustand — nie ein impliziter Netzwerk-Sweep beim Seitenaufruf.

**Kein `SeoFinding[]`** — siehe §11.1: der Typ existiert im Code nicht, und keine Section speist das Dashboard. Der Rückgabetyp ist das, was die Route rendert.

---

## 5. Kontingent — die eigentliche Rahmenbedingung

PSI zählt **Requests, nicht Kategorien**. Ein Aufruf mit drei Kategorien kostet exakt so viel wie einer mit einer.

Daraus folgt die zentrale Design-Entscheidung: **Ein Scan-Lauf fragt `performance`, `accessibility` und `best-practices` gemeinsam ab und beliefert beide Features aus einer Antwort.** Der Quality-Scan aktualisiert also nebenbei die Performance-Zeile für dieselbe URL, ohne ein einziges zusätzliches Kontingent.

Der Preis: die Antwort wird deutlich größer und der Lighthouse-Lauf etwas länger. Beides tragbar, weil in einen kompakten eigenen Vertrag geparst wird — die Rohantwort wird nie gespeichert.

**Kontingent-Rechnung:** 5 Templates (Startseite, Produkt, Kollektion, Seite, Warenkorb) × 2 Strategien = **10 Requests pro Voll-Scan**. Das ist gegen das Tagesbudget des Shops zu rechnen (§11.2) — auf Free passt ein Voll-Scan **nicht**, dort muss der Umfang aus dem Plan abgeleitet werden.

**Konsequenz:** Zusätzlich vor dem Scan-Button prüfen, ob `PAGESPEED_API_KEY` gesetzt ist. Fehlt er, den Scan auf Mobil beschränken und den bestehenden `staleQuotaNotice`-Mechanismus greifen lassen. Der 429-Pfad ist bereits gebaut und muss nur wiederverwendet werden.

---

## 6. UI

### 6.1 Descriptor

```ts
{ id: "quality", path: "/app/seo/quality", icon: "♿", labelKey: "quality", kind: "audit" }
```

### 6.2 Route `app/routes/app.seo.quality.tsx`

Aufbau in `SeoSectionLayout` (Contract §4):

1. **Hinweis-Banner** — der Ehrlichkeits-Text aus §1.3. Nicht dismissbar.
2. **Scan-Steuerung** — Template-Auswahl (Mehrfach) + Strategie, ein Button „Scan starten". Der Scan ist ein **Task** (§9), kein synchroner Request. Darunter der Budget-Stand („x von y Tests heute verbraucht", §11.2) — dasselbe Muster wie auf der Ladezeit-Seite, damit der Merchant die Grenze **vor** dem Klick sieht statt als Wand danach. Reicht das Restbudget für die gewählte Template-Menge nicht, wird der Button gesperrt, bevor der Task startet — ein Scan, der auf halber Strecke am Limit abbricht, hinterlässt einen halb gefüllten Bericht.
3. **Score-Karten** je gescanntem Template: Accessibility-Score prominent, Best-Practices-Score daneben und kleiner.
4. **Befundliste Barrierefreiheit** — je Issue Titel, Beschreibung, betroffene Elemente (Selektor/Snippet gekappt, mit Offenlegung der Kappung), und wo möglich der Aktions-Button aus §7.
5. **Karte „Zusatzinformationen"** — Best Practices, eingeklappt, ohne Score-Beitrag.
6. **Verlauf** — analog zur Performance-History.

Navigation ausschließlich über `useAppNavigation()` (Contract §4) — rohes `navigate()` verliert `host`/`shop`/`embedded`.

---

## 7. Der Punkt, der das Feature rechtfertigt: der Alt-Text-Brückenschlag

Ein reiner Report ist wenig wert, weil ContentPilot Kontrast-, ARIA- und Fokus-Probleme nicht beheben kann — das sind Theme-Themen.

**Eine Ausnahme gibt es, und die ist die wichtigste:** der `image-alt`-Audit trifft genau die Funktion, die die App bereits besitzt.

**Ablauf:**
1. Lighthouse meldet unter `image-alt` betroffene Elemente inklusive Bild-URL.
2. Die URL wird gegen `ProductImage.url` ([schema.prisma:404](../../prisma/schema.prisma#L404)) gematcht.
3. Bei Treffer trägt das Finding `resourceType: "product"` und `resourceId` — der Contract sieht genau dafür `resourceId` vor (§2), und die Section rendert einen „Alt-Text generieren"-Button, der in den bestehenden Pfad ([alt-text.action.ts](../../app/actions/content/alt-text.action.ts)) führt.

**Wichtiger Vorbehalt, der beim Bauen zu prüfen ist:** Shopify liefert CDN-URLs mit Transformations-Suffixen (`_1024x1024`, `?v=…`). Ein naiver Vergleich schlägt fehl. Der Match muss auf dem normalisierten Dateinamen-Stamm laufen, und er wird nicht immer gelingen — Bilder aus Theme-Assets oder Metafeldern haben gar keine `ProductImage`-Zeile. Die UI muss den Fall „gefunden, aber nicht zuordenbar" sauber zeigen, statt einen toten Button zu rendern.

Erwartete Trefferquote ist unbekannt. Das ist der erste Spike (§11.3), bevor der Rest gebaut wird — trägt der Brückenschlag nicht, schrumpft das Feature auf einen Report, und dann ist die Priorität neu zu bewerten.

---

## 8. i18n

Reihenfolge zwingend `de.ts` → `en.ts` → `es.ts` (`de.ts` definiert den `Translation`-Typ; Contract §5).

- `t.seo.sections.quality.*` — Label, Titel, Hinweistexte
- `t.seo.findings.a11y*` / `bp*` — Finding-Codes
- `t.tasks.taskType.qualityScan` — Aufgaben-Tab (rendert generisch, braucht nur das Label)

Lighthouse-Audit-Titel und -Beschreibungen kommen **auf Englisch** von Google. Sie zu übersetzen hieße, ~50 Audit-Texte zu pflegen, die sich mit jeder Lighthouse-Version ändern. Empfehlung: Googles Texte unverändert übernehmen (wie jetzt schon bei den Performance-Opportunities) und stattdessen die **Rahmen**-Texte übersetzen. PSI unterstützt einen `locale`-Parameter — den bei Gelegenheit mitzugeben ist der billigere Weg zu lokalisierten Audit-Texten als eigene Übersetzungen.

---

## 9. Task, Recovery, Telemetrie

**Task** (Contract §8): Ein Voll-Scan sind bis zu 10 PSI-Läufe à 15–30s, also mehrere Minuten. Zwingend Hintergrund-Task nach dem Pflichtmuster: `Task`-Row mit `status:"running"` und `expiresAt`, detached `void runQualityScan(...)`, nach **jeder** URL `progress` schreiben (das ist gleichzeitig der Heartbeat).

**Recovery-Pflicht:** `qualityScan` in `LONG_RUNNING_TASK_TYPES` ([task-recovery.service.js:34](../../task-recovery.service.js#L34)) eintragen — sonst wird der Task nach 10 statt 45 Minuten als hängend abgeräumt, und ein normaler Scan wird mitten im Lauf gekillt.

**Single-flight pro Shop:** vor dem `create` auf einen laufenden Scan prüfen; zweiter Aufruf zeigt Banner mit Link zum Aufgaben-Tab. Ohne das kann ein ungeduldiger Merchant das Tageskontingent in Minuten verbrennen.

**Kein `AIQueueService`** — der Scan macht keine KI-Arbeit. Erst der Alt-Text-Fix aus §7 läuft über die Queue, und der ist bereits gebaut.

**Telemetrie:** Logger-Namespace `seo:quality` (Contract §7).

---

## 10. Phasen

| Phase | Inhalt | Ergebnis |
|---|---|---|
| **0** | Spike §11.3: Alt-Text-Match-Trefferquote an echten Daten messen | Go/No-Go für §7 |
| **1** | `fetchPageSpeedInsights` um Kategorien erweitern; `quality.service.ts` + Parser + Tests | Parser grün, noch keine UI |
| **2** | Prisma-Modell + Migration + `redactShopData` + Coverage-Kommentar | GDPR-Guard grün |
| **3** | Descriptor + Route + Score-Karten + Befundliste + i18n | Section benutzbar (nur Anzeige) |
| **4** | Scan als Task + Recovery-Eintrag + Single-flight | Voll-Scan möglich |
| **5** | Alt-Text-Brückenschlag (§7) | Der Befund wird behebbar |
| **6** | Best-Practices-Karte (eingeklappt, ohne Score) | Das Goodie |

Nach jeder Phase ist ein benutzbarer Zwischenstand erreicht — das ist die vom Contract empfohlene Reihenfolge (Descriptor → analyze → Shell → Aktionen → GDPR/Tests), angepasst daran, dass Phase 0 eine Produktentscheidung absichert.

---

## 11. Entschieden / offen

### 11.1 Keine Dashboard-Aggregation — **entschieden 2026-07-22**

**Befund:** `SeoFinding` existiert im Code **nicht** (null Vorkommen). Contract §2 beschreibt einen nie gebauten Mechanismus. Das Dashboard wird ausschließlich von `analyzeStore` ([audit.service.ts:330](../../app/services/seo/audit.service.ts#L330)) über einen Snapshot gespeist, und **keine** der neun bestehenden Sections trägt etwas bei — jede lebt auf ihrer eigenen Route.

**Entscheidung:** Die Section bindet sich **nicht** ans Dashboard an, exakt wie alle bestehenden. Kein Sonderfall, keine neue Infrastruktur.

Verworfen wurde außerdem, Barrierefreiheit als `AuditType` in `analyzeStore` zu führen: das ist item-zentriert über den Katalog, Barrierefreiheits-Befunde sind template-zentriert. Ein Kontrastproblem gehört keinem Produkt.

**Folge:** Der frühere §11.4 (Score-Beitrag deckeln) entfällt ersatzlos — es gibt keinen Gesamt-Score, in den etwas einfließen könnte.

**Separat zu erledigen:** Contract §2 korrigieren. Er beschreibt derzeit einen Mechanismus, den es nicht gibt, und führt jeden Leser in dieselbe Fehlannahme.

### 11.2 Kein Plan-Gate, sondern ein Tageslimit — **entschieden 2026-07-22, für Ladezeit bereits umgesetzt**

**Begründung:** PSI wird gegen **unseren** `PAGESPEED_API_KEY` abgerechnet, ist also eine von der App bezahlte, über alle Shops geteilte Ressource — anders als AI-Tokens (BYO, deshalb ungedeckelt). Das ist Verbrauch, nicht Berechtigung. Dasselbe Muster wie `monthlyImageOperations` in [plans.ts](../../app/config/plans.ts), das dort ausdrücklich als „usage data, NOT entitlement data" geführt wird. Ein Gate würde nur entscheiden, *wer* das geteilte Kontingent leeren darf, nicht *wie viel* ein einzelner Shop nimmt.

**Umsetzung (bereits gebaut für die Ladezeit-Seite):** `PlanLimits.dailyPageSpeedRuns` in [plans.ts](../../app/config/plans.ts), gelesen über `getDailyPageSpeedRunsLimit`, durchgesetzt in [pagespeed.service.ts](../../app/services/seo/pagespeed.service.ts) via `countPageSpeedRunsToday`. Kein Zählmodell nötig — eine `SeoPageSpeedAudit`-Zeile entsteht nur nach einem Lauf, der Google tatsächlich erreicht hat, also **ist** der Zeilen-Count der Verbrauchszähler. Die Prüfung sitzt bewusst **nach** dem Cache-Lookup: ein zwischengespeichertes Ergebnis kostet kein Kontingent und darf nichts verbrauchen.

**Staffelung:** Free 5 · Basic 20 · Pro 40 · Max 80 Läufe pro UTC-Tag. Gestaffelter Verbrauch, kein Zugangs-Gate — dieselbe Unterscheidung, die `monthlyImageOperations` bereits trifft.

**Für diesen Plan:** Der Quality-Scan zählt auf **dasselbe** Tagesbudget ein — beide Features ziehen aus derselben Google-Quote. `countPageSpeedRunsToday` muss dafür die `SeoQualityAudit`-Zeilen mitzählen (Kommentar steht bereits im Code).

**Achtung — Kollision auf Free:** Ein Voll-Scan über 5 Templates × 2 Strategien kostet 10 Läufe und passt damit **nicht** in das Free-Budget von 5. Der Scan-Umfang muss deshalb aus dem Plan abgeleitet werden, nicht fest verdrahtet: die Template-Auswahl folgt ohnehin `PLAN_CONFIG[plan].contentTypes` (Free hat keine Pages/Articles, also Startseite + Produkt + Kollektion = 3 Templates), und auf knappem Budget wird auf Mobil beschränkt — 3 Läufe, passt. Ohne diese Ableitung wäre der Scan-Button auf Free dauerhaft gesperrt und läse sich als kaputt statt als begrenzt. Gehört in Phase 4.

**Plan-Gates insgesamt** werden separat neu überdacht; dieser Plan setzt deshalb **kein** `planGate` im Descriptor (§6.1).

### 11.3 Alt-Text-Match — Spike vor Phase 1 (offen)
An einem echten Shop messen, welcher Anteil der `image-alt`-Befunde sich auf eine `ProductImage`-Zeile abbilden lässt (§7). Unter grob einem Drittel Trefferquote ist §7 kein tragender Nutzen und die Phasen 5/6 sind neu zu bewerten.

---

## 12. Bewusst nicht in diesem Plan

- **Lighthouse-Kategorie SEO.** Überschneidet sich fast vollständig mit [bulk-meta](../../app/routes/app.seo.bulk-meta.tsx), [hreflang](../../app/routes/app.seo.hreflang.tsx), [redirects](../../app/routes/app.seo.redirects.tsx) und dem eigenen Score in [seo-score.ts](../../app/utils/seo-score.ts). Ein zweiter, anders gewichteter SEO-Score neben dem eigenen verwirrt mehr, als er hilft. Der `structured-data`-Audit dort ist zudem ein reiner Handprüfungs-Hinweis ohne Validierung.
- **GitHub-Anbindung und KI-Analyse von Theme-Dateien.** Siehe §2 — Scope-Bewilligung und Werkzeug-Konkurrenz, nicht zurückgestellt sondern verworfen.
- **Eigene axe-core-Ausführung** (statt PSI). Würde einen Headless-Browser auf Railway bedeuten — eine ganz andere Betriebsklasse als ein HTTP-Call.
