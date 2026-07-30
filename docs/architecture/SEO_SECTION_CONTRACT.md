# SEO-Section-Contract

**Was das ist:** der aktive Architektur-Vertrag, den **jedes** SEO-Feature in ContentPilot (Audit-Dashboard, Structured Data, Redirects, Hreflang, Keywords, Search Console, Performance, AEO, IndexNow, Bulk-Meta — und alle künftigen) einhalten muss.

**Warum das existiert:** Der Vertrag hält Navigation, Datenfluss, UI-Shell, Gating, Persistenz und Tests über alle SEO-Sections hinweg identisch. Ein neues Feature = denselben Vertrag erfüllen, nichts neu erfinden. Vorbild ist die bestehende `CONTENT_RUBRICS`-Mechanik ([content-rubrics.ts](../../app/config/content-rubrics.ts)), die Level-2/3-Nav driftfrei aus einer Quelle speist.

**Historie:** der Vertrag wurde ursprünglich als Teil des Umsetzungs-Plans `docs/plans/SEO_TAB_IMPLEMENTATION_PLAN.md` formuliert; jener Plan (Phasen 0–8) wurde 2026-07 vollständig ausgeliefert und ist damit obsolet. Was hier steht ist der destillierte, dauerhaft gültige Kern — Code-Kommentare, die auf „Phase X of SEO_TAB_IMPLEMENTATION_PLAN.md" verweisen, dokumentieren die historische Umsetzungs-Reihenfolge, nicht diesen Vertrag.

---

## Die acht Vertrags-Punkte

### 1. Descriptor als Single Source of Truth

Jede Section ist ein Eintrag in [app/config/seo-sections.ts](../../app/config/seo-sections.ts):

```ts
export type SeoSectionKind = "audit" | "tool" | "integration";
export interface SeoSectionDef {
  id: string;            // "overview" | "structuredData" | "redirects" | "hreflang" | "keywords" | "searchConsole" | …
  path: string;          // "/app/seo" | "/app/seo/structured-data" | …
  icon: string;
  labelKey: string;      // i18n-Key unter t.seo.sections.*
  kind: SeoSectionKind;
  planGate?: Plan;       // ab welchem Plan freigeschaltet (fehlt = alle Pläne)
}
```

Sections liegen in **Rubriken** (`SEO_RUBRICS`) — die Level-2-Ebene des SEO-Tabs, analog zu `CONTENT_RUBRICS`:

```ts
export interface SeoRubricDef {
  id: string;            // "overview" | "analysis" | "rankings" | "linking" | "technical"
  icon: string;          // Label unter t.seo.rubrics.<id>
  entries: SeoSectionDef[];
}
```

Reihenfolge folgt dem SEO-Workflow von links nach rechts: erst sehen wo man steht (Übersicht, Analyse), dann inhaltlich optimieren (Keywords & Rankings, Verlinkungen), dann ausliefern/indexieren lassen (Technik & Indexierung).

`SEO_SECTIONS` ist die **abgeleitete** flache Liste (`SEO_RUBRICS.flatMap(r => r.entries)`) und wird nie separat gepflegt — sie speist Mobile-Drawer, Plan-Gate-Lookup in `SeoSectionLayout` und das Path-Matching. Die Layout-Route ([app.seo.tsx](../../app/routes/app.seo.tsx)) rendert daraus beide Leisten (Level 2 = Rubriken, Level 3 = Sections der aktiven Rubrik) über die geteilte `SubNavBar` (`variant="level3"` für die untere). **Ein neues Feature wird durch einen Array-Eintrag in der passenden Rubrik sichtbar** — nicht durch Nav-Code-Änderungen. Eine Rubrik zeigt das Schloss nur, wenn **alle** ihre Sections über dem Plan liegen; gemischte Rubriken bleiben offen und das Schloss trägt der einzelne Level-3-Chip.

### 2. Sections rendern ihre eigenen Ergebnisse — es gibt kein geteiltes Finding-Modell

> **Korrigiert 2026-07-22.** Frühere Fassungen dieses Vertrags beschrieben hier einen geteilten Typ `SeoFinding` in `app/utils/seo-score.ts`, den **jede** Section zurückgibt und den das Dashboard über alle Sections hinweg zu einem Gesamt-Score aggregiert. **Das wurde nie gebaut.** `SeoFinding` existiert im Code nicht (null Vorkommen), und keine der zehn Sections speist das Dashboard. Der Absatz beschrieb ein Zielbild, las sich aber wie Ist-Zustand — und hat dadurch mindestens einmal eine Planung in die Irre geführt. Wer die Aggregation will, baut sie bewusst; wer eine Section baut, verlässt sich nicht auf sie.

**Ist-Zustand:**

- Das Dashboard ([app.seo._index.tsx](../../app/routes/app.seo._index.tsx)) wird **ausschließlich** von `analyzeStore` ([audit.service.ts](../../app/services/seo/audit.service.ts)) gespeist, über einen persistierten Snapshot. `analyzeStore` ist **item-zentriert**: es liest die DB-Caches von Product/Collection/Article/Page, bewertet jedes Item und bucketet Probleme nach `code` (`AuditAggregate.problems[]`), was wiederum „Fix with AI" antreibt.
- **Jede andere Section lebt vollständig auf ihrer eigenen Route** und definiert ihren eigenen Ergebnistyp. Das ist der geltende Normalfall, kein Defizit.

**Für neue Sections gilt daher:**

- `analyze()` gibt den Typ zurück, den die eigene Route rendert — kein erfundener gemeinsamer Nenner.
- Codes statt übersetzter Strings durch die Schichten reichen bleibt richtig (i18n-Mapping erst in der UI, siehe §5).
- Wer ins Dashboard will, muss `analyzeStore` erweitern — und sollte vorher prüfen, ob die eigenen Befunde überhaupt item-zentriert sind. Template- oder URL-bezogene Befunde (Ladezeit, Barrierefreiheit) sind es nicht und gehören dort nicht hinein.

### 3. Service-Contract

Pro Section ein Service `app/services/seo/<id>.service.ts` mit:

- **`analyze(shop, deps)`** — read-only, **DB-Cache-first** (`Product` / `Collection` / `Article` / `Page` / `ProductImage` / `ContentTranslation`), **nie** ein Live-GraphQL-Sweep über den ganzen Katalog. Der Rückgabetyp gehört der Section (siehe §2) — es gibt keinen geteilten Finding-Typ.
- optional **`fix(shop, params)`** — schreibende Massenaktionen **ausschließlich** über das vorhandene `Task`-Queue-System (Rate-Limit / Retry / Progress), nie ein neuer Job-Runner. Siehe §8.

### 4. Route- & UI-Shell

Jede Section-Route `app/routes/app.seo.<id>.tsx`:

- Loader ruft `analyze()`.
- Component rendert in der geteilten [`<SeoSectionLayout sectionId>`](../../app/components/seo/SeoSectionLayout.tsx) (Header aus `t.seo.sections.<id>`, Plan-Gate-Upsell via `usePlan()`, `HelpTooltip`).
- Actions laufen über einen einheitlichen `actionType`-Switch.
- Navigation **ausschließlich** über `useAppNavigation()` — nie rohes `navigate()` (das würde die Shopify-Session-Params `host` / `shop` / `embedded` verlieren).

### 5. i18n

- Section-Strings unter `t.seo.sections.<id>.*`.
- Finding-Codes unter `t.seo.findings.<code>`.
- Reihenfolge: zuerst [de.ts](../../app/i18n/de.ts) (definiert den `Translation`-Typ), dann [en.ts](../../app/i18n/en.ts), [es.ts](../../app/i18n/es.ts).

### 6. Persistenz & GDPR

- **DB-Cache-first** (keine Live-Sweeps über den ganzen Katalog).
- **Jedes neue shop-scoped Prisma-Modell MUSS** in `SHOP_SCOPED_MODELS` + `redactShopData()` ([app/services/gdpr.service.ts](../../app/services/gdpr.service.ts)) per `deleteMany({ where: { shop } })` ergänzt werden. Ein Drift-Guard-Test schlägt sonst fehl.
- **Secrets verschlüsselt** über dieselbe Utility wie AI-API-Keys in `AISettings` (relevant z. B. für GSC-Refresh-Tokens).

### 7. Telemetrie

Debug-Logger-Namespace `seo:<id>` (vorhandenes [debug.ts](../../app/utils/debug.ts)-Muster). Keine sensiblen Daten loggen, keine unbeschränkten `console.log`.

### 8. Lange Operationen sind Tasks

Jede Operation, die spürbar dauert, läuft als **`Task`** (vorhandenes Modell + Aufgaben-Tab), damit der Vordergrund frei bleibt.

**Faustregel:**
- **Task (Hintergrund):** store-weiter Audit-Scan, Bulk-Fix / Bulk-Translate (Fan-out über viele Items), Redirect-CSV-Import, GSC-Sync, Keyword-Enrichment, Site-Crawl.
- **Synchron (Vordergrund):** Einzel-Operationen — ein Feld generieren, ein Redirect anlegen, eine URL inspizieren, On-Page-Keyword-Analyse, JSON-LD-Preview.

**Muster (verpflichtend):**
1. `Task`-Row mit `status:"running"`, `total` / `progress` / `processed`, `expiresAt: getTaskExpirationDate()` anlegen.
2. **Detached** `void runX(taskId, …).catch(...)` (überlebt Navigation).
3. Nach **jeder** Einheit `progress` / Teilergebnis in `Task.result` schreiben — das bumpt `updatedAt` und ist damit gleichzeitig der Heartbeat.
4. AI-Arbeit über `AIQueueService.enqueue()`; reine Nicht-AI-Arbeit direkt im Runner.

**Vorbild:** `runBulkAltTextGeneration` in [alt-text.handler.ts](../../app/routes/api-ai-handlers/alt-text.handler.ts).

**Recovery-Pflicht:**
- Jeder **neue lange Task-Typ MUSS** in `LONG_RUNNING_TASK_TYPES` ([task-recovery.service.js:34](../../task-recovery.service.js#L34)) eingetragen werden — sonst Reap nach 10 statt 45 min.
- Periodisch via Progress-Write heartbeaten.
- **Single-flight pro Shop:** nur ein aktiver Scan / Sync gleichzeitig (vor `create` auf laufenden Task prüfen). Zweiter Aufruf zeigt Banner mit Link zum Aufgaben-Tab.

**UI:** Der Aufgaben-Tab rendert generisch (`t.tasks.taskType[type] || type`) → neue Typen brauchen nur i18n-Labels in `t.tasks.taskType.*` (+ ggf. `resourceType` / `fieldType`).

---

## Akzeptanzkriterium für neue Sections

Eine neue Section (bzw. eine bestehende, die substanziell ausgebaut wird) ist erst „fertig", wenn Punkte 1–8 erfüllt sind. **Empfohlene Umsetzungs-Reihenfolge:**

1. **Descriptor** in die passende Rubrik in `SEO_RUBRICS` eintragen (+ Label unter `t.seo.sections.<id>`).
2. **`analyze()`** implementieren + Findings + i18n-Codes.
3. **Route/Shell** mit `SeoSectionLayout`.
4. **`fix()` / Aktionen** — Task wenn lang, sonst synchron.
5. **GDPR** (neue Modelle in `redactShopData`) + **Tests**.

Diese Reihenfolge deckt in jeder Phase einen benutzbaren Zwischenstand ab und verhindert, dass Nav-Einträge auf tote Loader zeigen.

---

## Wo dieser Vertrag heute Anwendung findet

Die produktive SEO-Oberfläche unter [app/routes/app.seo*.tsx](../../app/routes/) wurde nach diesem Vertrag gebaut. Neue Pläne, die weitere SEO-Features hinzufügen, bauen darauf auf — z. B. der ausgelieferte Keyword-Ausbau ([KEYWORDS_CONTRACT.md](./KEYWORDS_CONTRACT.md)) und [PLAN_SEO_SUITE_COMPLETION.md](../plans/PLAN_SEO_SUITE_COMPLETION.md).
