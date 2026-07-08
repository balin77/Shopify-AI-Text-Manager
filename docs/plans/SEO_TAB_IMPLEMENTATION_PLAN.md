# SEO-Tab für ContentPilot — Vollständiger Plan

## Context

ContentPilot besitzt heute nur **per-Item-SEO** im Editor: [SeoSidebar.tsx](app/components/SeoSidebar.tsx) berechnet client-seitig einen Score (Title/SEO-Title/Meta/Beschreibung/Alt-Text), [ai.service.ts](src/services/ai.service.ts) `generateSEO()` erzeugt Meta-Felder. Es fehlt jede **store-weite** Sicht und jede **technische SEO-Mechanik** (Structured Data, hreflang, Redirects, 404, GSC, Keywords, Readability). [COMPETITIVE_ANALYSIS.md](docs/COMPETITIVE_ANALYSIS.md) §2.2/§3.5 markiert „JSON-LD Structured Data" als kritischen Gap und listet Redirects/404, GSC, Sitemap, Keyword-Research, Readability als weitere Lücken.

**Ziel:** ein eigener Top-Level-Tab **„SEO"** zwischen „Inhalte" und „Aufgaben", der ein **Audit-Dashboard** mit einem **Konfigurations-Hub** vereint. Dieser Plan ist als **Gesamtumsetzung** geschrieben — MVP zuerst, danach die übrigen Hub-Sektionen, alle nach demselben Bauplan, damit das Feature integral umgesetzt werden kann.

**Entscheidungen (mit Nutzer geklärt):** Struktur = Dashboard **+** Hub mit Unter-Navigation · MVP = Store-Audit + Bulk-Fix **und** JSON-LD · Tab auf **allen Plänen** sichtbar, einzelne Premium-Features intern gegated.

**Architektur-Leitplanken aus dem bestehenden Code (einhalten):**
- **DB-Cache statt Live-GraphQL:** `Product`/`Collection`/`Article`/`Page` (Prisma, [schema.prisma](prisma/schema.prisma)) halten bereits `seoTitle`, `seoDescription`, `featuredImageAlt`, `body`/`descriptionHtml` — store-weites Audit liest daraus, kein teurer Admin-API-Sweep. Bild-Alt-Coverage über `ProductImage`.
- **AI-Queue wiederverwenden:** Bulk-Operationen laufen über das vorhandene `Task`-Modell + `/api.ai`-Handler, nicht über neue Job-Mechanik.
- **GDPR-Pflicht:** Jedes **neue shop-scoped Prisma-Modell** MUSS in `redactShopData()` ([app/services/gdpr.service.ts](app/services/gdpr.service.ts)) per `deleteMany({ where: { shop } })` ergänzt werden — ein Drift-Guard-Test schlägt sonst fehl. Gilt für alle unten neu eingeführten Modelle.
- **Secrets verschlüsseln:** GSC-Refresh-Tokens über dieselbe Verschlüsselungs-Utility wie die AI-API-Keys in `AISettings` ablegen.
- **Navigation immer über `useAppNavigation()`** (erhält Shopify-Session-Params host/shop/embedded), nie rohes `navigate()`.

**Vorhandene Feature-Branches (nicht neu bauen — integrieren):**
- **`origin/feature/jsonld-structured-data`** — JSON-LD ist bereits implementiert (2 Commits off `develop`): reine Builder + Validierung in `app/services/structured-data.service.ts` (+ Unit-Tests), eigene Theme-Extension `extensions/structured-data/`, optionaler `structuredData`-Prop in `SeoSidebar.tsx` (einklappbarer JSON-LD-Block, Copy, Validierung), Verdrahtung in `UnifiedContentEditor.tsx`, 5 i18n-Keys, GDPR-Guard befriedigt. **Phase 2 setzt hierauf auf, statt neu zu bauen** (Details unten).
- `origin/feature/content-templates`, `origin/feature/glossary` — adressieren andere Analyse-Gaps (Templates, Glossar); hier nur erwähnt, damit keine Doppelarbeit entsteht.
- `origin/feature/language-currency-switcher` — bereits ausgelieferter Switcher.

---

## Einheitliches Konzept — der „SEO-Section-Contract"

**Jedes** SEO-Feature (Audit, Structured Data, Redirects/404, hreflang, Keywords, GSC und alle späteren) ist eine **Section** und implementiert denselben Vertrag. Das hält Navigation, Datenfluss, UI, Gating, Persistenz und Tests über alle Features hinweg identisch — neue Features = denselben Contract erfüllen, nichts neu erfinden. Vorbild ist die bestehende `CONTENT_RUBRICS`-Mechanik ([content-rubrics.ts](app/config/content-rubrics.ts)), die Level-2/3-Nav driftfrei aus einer Quelle speist.

**1. Descriptor (Single Source of Truth).** `app/config/seo-sections.ts`:
```ts
export type SeoSectionKind = "audit" | "tool" | "integration";
export interface SeoSectionDef {
  id: string;            // "overview" | "structuredData" | "redirects" | "hreflang" | "keywords" | "searchConsole"
  path: string;          // "/app/seo" | "/app/seo/structured-data" | …
  icon: string;
  labelKey: string;      // i18n-Key unter t.seo.sections.*
  kind: SeoSectionKind;
  planGate?: Plan;       // ab welchem Plan freigeschaltet (fehlt = alle Pläne)
}
export const SEO_SECTIONS: SeoSectionDef[] = [ … ];
```
Die Layout-Route (`app.seo.tsx`) mappt über `SEO_SECTIONS` → Sub-Nav entsteht automatisch; ein neues Feature wird durch **einen Array-Eintrag** sichtbar.

**2. Einheitliches Finding-Modell.** Geteilter Typ in `app/utils/seo-score.ts` (bzw. `app/types/seo.ts`):
```ts
export interface SeoFinding {
  sectionId: string;                               // welche Section meldet
  code: string;                                    // i18n-Key + stabile ID (kein übersetzter String)
  severity: "error" | "warning" | "success";
  points?: number;                                 // optionaler Score-Beitrag
  resourceType?: "product" | "collection" | "article" | "page" | "shop";
  resourceId?: string;                             // Shopify GID für Deep-Link in den Editor
  data?: Record<string, unknown>;                  // Platzhalter-Werte für die i18n-Message
}
```
**Jede** Section-Analyse gibt `SeoFinding[]` zurück. Das Dashboard (Phase 1) aggregiert Findings **aller** Sections in den Gesamt-Score + Problem-Buckets — dadurch ist jede künftige Section ohne Sonderfall im Dashboard sichtbar. Die `SeoSidebar` mappt Codes → `t.seo.*` (nie Strings durch die Schichten reichen).

**3. Service-Contract.** Pro Section ein Service `app/services/seo/<id>.service.ts` mit:
- `analyze(shop, deps): Promise<SeoFinding[]>` — **read, DB-Cache-first** (`Product`/`Collection`/`Article`/`Page`/`ProductImage`/`ContentTranslation`), nie ein Live-GraphQL-Sweep über den ganzen Katalog.
- optional `fix(shop, params): Promise<…>` — **schreibende Massenaktionen ausschließlich über das vorhandene `Task`-Queue-System** (Rate-Limit/Retry/Progress), nie ein neuer Job-Runner.

**4. Route- & UI-Shell.** Jede Section-Route `app/routes/app.seo.<id>.tsx`: Loader ruft `analyze()`; Component rendert in einer geteilten `<SeoSectionLayout sectionId>` (Header aus `t.seo.sections.<id>`, Plan-Gate-Upsell via `usePlan()`, `HelpTooltip`). Actions laufen über einen einheitlichen `actionType`-Switch. Navigation ausschließlich über `useAppNavigation()`.

**5. i18n.** Strings je Section unter `t.seo.sections.<id>.*` und Finding-Codes unter `t.seo.findings.<code>` — eine Konvention für alle (zuerst [de.ts](app/i18n/de.ts) = `Translation`-Typ, dann en/es).

**6. Persistenz & GDPR.** DB-Cache-first; jedes **neue shop-scoped Modell** in `redactShopData()` ([gdpr.service.ts](app/services/gdpr.service.ts)) registrieren; Secrets verschlüsselt (gleiche Utility wie AI-Keys).

**7. Telemetrie.** Debug-Logger-Namespace `seo:<id>` (vorhandenes [debug.ts](app/utils/debug.ts)-Muster).

**8. Lange Operationen sind Tasks (Vordergrund bleibt frei).** Jede Operation, die spürbar dauert, läuft als **`Task`** (vorhandenes Modell + Aufgaben-Tab), damit der User weiterarbeiten kann. Faustregel:
- **Task (Hintergrund):** store-weiter Audit-Scan, Bulk-Fix/Bulk-Translate (Fan-out über viele Items), Redirect-CSV-Import, GSC-Sync/Keyword-Enrichment.
- **Synchron (Vordergrund):** Einzel-Operationen — ein Feld generieren, ein Redirect anlegen, eine URL inspizieren, On-Page-Keyword-Analyse, JSON-LD-Preview.
- **Muster (verpflichtend, aus dem Code):** `Task`-Row mit `status:"running"`, `total`/`progress`/`processed`, `expiresAt: getTaskExpirationDate()` anlegen → **detached** `void runX(taskId,…).catch(...)` (überlebt Navigation) → nach **jeder** Einheit `progress`/Teilergebnis in `Task.result` schreiben (das bumpt `updatedAt` = Heartbeat). AI-Arbeit über `AIQueueService.enqueue()`; reine Nicht-AI-Arbeit (Redirect-Import-Poll, GSC-Fetch) direkt im Runner. Vorbild: `runBulkAltTextGeneration` ([alt-text.handler.ts:226](app/routes/api-ai-handlers/alt-text.handler.ts#L226)).
- **Recovery-Pflicht:** jeder **neue lange Task-Typ** MUSS in `LONG_RUNNING_TASK_TYPES` ([task-recovery.service.js:34](task-recovery.service.js#L34)) eingetragen werden (sonst Reap nach 10 statt 45 min) **und** periodisch via Progress-Write heartbeaten. Pro Shop nur **ein** aktiver Scan/Sync gleichzeitig (vor `create` auf laufenden Task prüfen).
- **UI:** Aufgaben-Tab rendert generisch (`t.tasks.taskType[type] || type`, [app.tasks.tsx:372](app/routes/app.tasks.tsx#L372)) → neue Typen brauchen nur i18n-Labels in `t.tasks.taskType.*` (+ ggf. `resourceType`/`fieldType`).

> Akzeptanzkriterium für jede Section: erfüllt Punkte 1–8. Reihenfolge der Umsetzung pro Section: Descriptor → analyze() (+ Findings + i18n-Codes) → Route/Shell → fix()/Aktionen (Task wenn lang) → GDPR/Tests.

---

## Phase 0 — Navigation & geteilte Infrastruktur (Fundament)

### 0.0 Voraussetzungen / Blocker (zuerst erledigen) — agentenverifiziert
- **Merge-Reihenfolge (zwingend):** `origin/feature/jsonld-structured-data` **zuerst** nach `develop` mergen, **dann** Phase 0 darauf. Begründung: der Branch berührt `SeoSidebar.tsx` (neue Hooks/Prop oben + JSON-LD-Block unten, Zeilen 1–50 & 381+) und die drei i18n-Dateien. Die Score-Extraktion (0.3) ersetzt **nur** den Score-`useMemo` (Zeilen ~50–203) → **disjunkte Region**, konfliktfrei *wenn* nach dem Merge gemacht. **Nie umgekehrt.** → Ablauf: **Branch mergen → Score extrahieren (0.3) → Nav/i18n ergänzen.**
- **Stale-Hunk beim Merge:** Der Branch fügt `imageOperationCounter.deleteMany` in `gdpr.service.ts` hinzu — **das liegt auf `develop` bereits als Eintrag 24**. Beim Merge **develop-Version behalten, Branch-Duplikat verwerfen**.
- **Scope-Blocker für Redirects (Phase 3):** `shopify.app.dev.toml` **und** `shopify.app.prod.toml` enthalten nur `read_online_store_navigation`. `urlRedirectCreate/Update/Delete/Import*` brauchen **`write_online_store_navigation`** → in **beide** Scope-Strings aufnehmen (sonst 403 in deployten Apps). Die `urlRedirects`-Query deckt `read_…` ab.
- **Deep-Link-Lücke fürs Dashboard:** `?select=<GID>` → Editor-Vorauswahl ist aktuell **nur** in `app.metaobjects.tsx` implementiert. Für klickbare Dashboard-Zeilen (Phase 1) denselben 3-Zeilen-Resolver (`searchParams.get("select")` → `initialItemId`; Editor unterstützt `initialItemId` bereits via `useUnifiedContentEditor.ts`) in `app.products.tsx`, `app.collections.tsx`, `app.blog.tsx`, `app.pages.tsx` ergänzen (Match per GID, nicht Handle).

### 0.1 Level-1-Tab „SEO"
- **[MainNavigation.tsx:222](app/components/MainNavigation.tsx#L222)** — im `tabs`-Array zwischen `content` und `tasks`:
  `{ id: "seo", label: t.nav.seo, path: "/app/seo" }`. Der generische Active-Zweig (`location.pathname.startsWith(tab.path)`, ~Zeile 318) greift ohne Änderung. Mobile-Drawer-Liste analog ergänzen.
- **i18n** — `nav.seo` + kompletter `seo`-Block (Dashboard-/Hub-Strings) in [de.ts](app/i18n/de.ts) (definiert den `Translation`-Typ → zuerst), dann [en.ts](app/i18n/en.ts), [es.ts](app/i18n/es.ts).

### 0.1b Contract-Bausteine anlegen (einmalig, von allen Sections genutzt)
Erfüllt das „Einheitliche Konzept" oben mit konkreten Dateien:
- `app/config/seo-sections.ts` — `SeoSectionDef` + `SEO_SECTIONS` (Single Source of Truth für die Sub-Nav).
- `app/utils/seo-score.ts` — `SeoFinding`-Typ + die extrahierte Score-Funktion (0.3).
- `app/components/seo/SeoSectionLayout.tsx` — geteilte Shell (Header aus `t.seo.sections.<id>`, Plan-Gate-Upsell via `usePlan()`, `HelpTooltip`).
- `app/services/seo/` — Ordner für die Per-Section-Services (`analyze()`/`fix()`).

### 0.2 Routen-Gerüst (Layout + Sub-Navigation)
Remix-Flat-Routes; Layout-Route rendert eine Polaris-`Tabs`-Leiste (oder `ButtonGroup`) + `<Outlet/>`, **gespeist aus `SEO_SECTIONS`** (nicht hartkodiert):
- `app/routes/app.seo.tsx` — Layout-Route. Loader lädt `seoTitleSuffix` (Scoring) + Plan; rendert Sub-Tabs durch `map` über `SEO_SECTIONS`. Jede Section eigene Unterroute, intern per `usePlan()` gegated (`planGate` aus dem Descriptor), gesperrte zeigen Upsell statt Inhalt.
- `app/routes/app.seo._index.tsx` — Audit-Dashboard (Phase 1).
- `app/routes/app.seo.structured-data.tsx` — JSON-LD (Phase 2).
- `app/routes/app.seo.redirects.tsx` — Redirects & 404 (Phase 3).
- `app/routes/app.seo.hreflang.tsx` — hreflang-Audit (Phase 4).
- `app/routes/app.seo.keywords.tsx` — Keyword-Tracking (Phase 5).
- `app/routes/app.seo.search-console.tsx` — GSC (Phase 6).

> Bewusst **kein** `CONTENT_RUBRICS`-Eintrag — SEO ist ein eigener Level-1-Tab mit eigener Sub-Nav, nicht Teil der Inhalte-Rubriken.

### 0.3 Score-Logik extrahieren (Reuse-Kern für Dashboard + Sidebar)
Die `useMemo`-Analyse in [SeoSidebar.tsx:50-203](app/components/SeoSidebar.tsx#L50) ist UI-gebunden (liefert übersetzte Strings). Herausziehen in **reine Funktion** `app/utils/seo-score.ts`:
- Input: `{ title, description, seoTitle, metaDescription, imagesWithAlt, totalImages, excludeDescription, excludeImages, seoTitleEffectiveLimit }`.
- Output: `{ score, issues: {code, type, points}[], recommendations: code[] }` — **Codes statt Strings**, damit serverseitig nutzbar.
- `SeoSidebar.tsx` ruft die Funktion auf und mappt Codes → `t.seo.*` (keine Score-Drift, identische Gewichte/Schwellen ≥70/≥40). Verifikationspunkt: Sidebar- und Dashboard-Score eines Items müssen identisch sein.

---

## Phase 1 — Audit-Dashboard + Bulk-Fix (MVP, alle Pläne)

**Route:** `app.seo._index.tsx`

**Loader (DB-Cache, kein API-Sweep):** liest `Product`/`Collection`/`Article`/`Page` (+ `ProductImage` für Alt-Coverage) je `shop`, wendet `seo-score.ts` serverseitig pro Item an. Aggregiert:
- Durchschnitts-Score + Verteilung (gut/mittel/schlecht) je Content-Typ (Polaris-Score-Kacheln + `ProgressBar`).
- Problem-Buckets: „Meta-Description fehlt", „SEO-Title fehlt/zu lang", „Beschreibung < 150 Z.", „Bilder ohne Alt-Text".
- Worst-Offender-Liste als `IndexTable`: Spalten Item/Typ/Score/Probleme, sortier-/filterbar; Zeilen-Link öffnet den Editor (`/app/products?selected=…` etc.) via `useAppNavigation()`.
- Performance: Aggregation bei großen Shops paginiert/`select`-minimiert; bei Bedarf cachebar in einer optionalen `SeoScoreSnapshot`-Tabelle (s. „Optionale Erweiterungen").

**Bulk-Fix (vorhandene AI-Pipeline, keine neue AI-Logik):**
- Aktion „Fehlende Meta-Descriptions generieren" / „Alt-Texte ergänzen" etc. enqueuet pro betroffenem Item denselben Aufruf wie der Editor: `generateAIText` → [text-generation.handler.ts](app/routes/api-ai-handlers/text-generation.handler.ts); Alt-Text über `handleGenerateAllAltTexts` ([alt-text.handler.ts](app/routes/api-ai-handlers/alt-text.handler.ts)).
- Läuft über das vorhandene **`Task`-Queue-System** (`type: "bulkAiGeneration"`, Rate-Limit/Retry/Progress), sichtbar im Aufgaben-Tab. Kein eigener Job-Runner.
- Plan-Hinweis: AI-Bulk respektiert die bestehenden Plan-Limits (`maxProducts` etc.) automatisch, da dieselben Handler.

---

## Phase 2 — JSON-LD Structured Data (MVP) — **baut auf `feature/jsonld-structured-data` auf**

**Route:** `app.seo.structured-data.tsx` · **Status: Kern bereits implementiert.**

Der Branch hat den schweren Teil schon gelöst und zwar **anders** als ursprünglich angenommen — diese Architektur wird übernommen:

**Bereits vorhanden (übernehmen, nicht neu bauen):**
- **Generierung im Theme via Liquid**, aus **nativen Liquid-Objekten** (`product`/`collection`/`article`/`shop`) — kein Per-Item-Sync, Preis/Verfügbarkeit live. App-Embed-Block in eigener Extension `extensions/structured-data/blocks/structured-data.liquid` (`target: "body"`), rendert Product/CollectionPage/BlogPosting/Organization/BreadcrumbList. AggregateRating wird aus `product.metafields.reviews.rating(_count)` gelesen (deckt Judge.me/Loox-Shops mit Standard-Rating-Metafeld ab). Jeder dynamische Wert über `| json` escaped (`</script>`-Breakout verhindert).
- **Config über Theme-Editor-Block-Settings** (`{% schema %}`): Checkbox je Schema-Typ + `image_picker` Logo (Fallback `shop.brand.logo`) + Social-URLs-Textarea (→ `Organization.sameAs`). **Bewusst KEINE app-owned Metafields und KEINE eigene App-Settings-UI** — der frühere Metafield-Ansatz aus diesem Plan entfällt, da der Theme-Editor-Weg idiomatischer und fertig ist.
- **Reiner Service** `app/services/structured-data.service.ts`: `build{Product,Collection,Article,Organization,Breadcrumb}JsonLd`, `validateJsonLd`, `renderJsonLdScript`, `plainText`/`absoluteUrl` — dependency-frei, unit-getestet (`tests/unit/structured-data.service.test.ts`). Dient als **In-App-Spiegel** des Liquid-Outputs.
- **Per-Item-Preview im Editor**: `SeoSidebar.tsx` hat einen optionalen `structuredData`-Prop (einklappbarer Block + Schema-Validierung + „`<script>`-Tag kopieren"), `UnifiedContentEditor.tsx` füllt ihn für products/collections/blogs (Domain leer → URLs ausgelassen; Storefront emittiert die absolute Variante). 5 i18n-Keys vorhanden, GDPR-Guard befriedigt (kein neues Modell).

**Noch zu tun für die SEO-Tab-Integration (klein):**
1. **Branch integrieren** — `feature/jsonld-structured-data` nach `develop` mergen/rebasen. Konflikt-Acht: berührt `SeoSidebar.tsx` und die drei i18n-Dateien, die auch Phase 0/1 anfasst → **Reihenfolge: erst diesen Branch mergen, dann die Score-Extraktion (0.3) darauf**. `de.ts` hat schon `seo.showStructuredData` etc., dort nur den neuen `seo`-Tab-Block ergänzen.
2. **Structured-Data-Sektion** (`app.seo.structured-data.tsx`) als **Management-/Status-Seite** bauen, die den vorhandenen Service wiederverwendet:
   - Aktivierungs-Status des App-Embeds anzeigen + Deep-Link „Im Theme-Editor aktivieren/konfigurieren" (Theme-Editor-Deeplink mit der Extension-`uid`).
   - Erklärung welche Schema-Typen pro Seitentyp greifen.
   - **Live-Vorschau**: für ein Beispiel-Item je Typ via `build*JsonLd` + `renderJsonLdScript` rendern, `validateJsonLd`-Feedback zeigen, Deep-Link zum Google Rich-Results-Test.
   - Kein Speicher-State nötig (Config liegt im Theme) → reine Read/Preview-Seite. Optional ab Pro gegated (`usePlan()`), Basis für alle.

---

## Phase 3 — Weiterleitungen & 404-Tracking

**Route:** `app.seo.redirects.tsx` · **Plan:** alle (ggf. Bulk-Import ab Pro).

**Redirect-Verwaltung** über Shopifys native `urlRedirect`-API (neue GraphQL-Ops in [content.queries.ts](app/graphql/content.queries.ts)/[content.mutations.ts](app/graphql/content.mutations.ts)):
- Query `urlRedirects(first, query, after)` → Liste (Polaris `IndexTable`, Suche/Pagination).
- Mutationen `urlRedirectCreate`, `urlRedirectUpdate`, `urlRedirectDelete`. Validierung: `path` muss mit `/` beginnen, keine Schleifen.
- Optional Bulk-CSV via `urlRedirectImport` (Staged Upload) — als Pro-Komfort.

**404-Tracking** (Shopify liefert keine 404-Logs per API → eigener leichter Collector):
- Theme-`404`-Template beacon: kleines Snippet/App-Embed schickt die fehlende URL + Referrer an einen **App-Proxy-Endpoint** (`app/routes/`-Proxy-Route), der nach `Seo404Hit` (neues Prisma-Modell, shop-scoped) loggt (Pfad, Count, firstSeen/lastSeen; FIFO-Cap wie `DirectTranslationCandidate`).
- Dashboard-Sektion „Häufige 404s" mit One-Click „→ Weiterleitung anlegen" (öffnet `urlRedirectCreate` vorbefüllt).
- **GDPR:** `Seo404Hit` in `redactShopData()` aufnehmen.

---

## Phase 4 — hreflang-Audit (Validierung, keine Generierung)

**Route:** `app.seo.hreflang.tsx` · **Plan:** alle.

> Shopify injiziert mit Markets `<link rel="alternate" hreflang>` **nativ**. Eigene Generierung würde das duplizieren (analog Währung in §2.1). Wert = **Audit**, das hreflang-brechende Lücken findet.

- Publizierte Locales über `shopLocales`-Query (Admin GraphQL) ermitteln.
- Gegen den `ContentTranslation`-Cache prüfen: Items, die in einer publizierten Locale **veröffentlicht**, aber **ohne Übersetzung** sind (→ hreflang zeigt auf untranslated/identische Inhalte). Pro Locale Coverage-% + Fehlliste.
- `x-default`-Check (Primärsprache gesetzt?) und Hinweis auf Market-Domain-Konfiguration.
- Aktion: fehlende Übersetzungen direkt als Bulk-Translate enqueuen (vorhandener Übersetzungs-Pfad, [text-translation.handler.ts](app/routes/api-ai-handlers/text-translation.handler.ts)) — schließt den Loop ohne neue Mechanik.

---

## Phase 5 — Keyword-Tracking

**Route:** `app.seo.keywords.tsx` · **Plan:** alle (Tracking ab Pro koppelbar an GSC).

- **Ziel-Keyword pro Item** speichern: neues Prisma-Modell `SeoKeyword { id, shop, resourceType, resourceId, keyword, locale, … @@unique([shop, resourceId, locale]) }` (GDPR-Purge ergänzen). Alternativ als app-owned Metafield, falls Storefront-Zugriff gewünscht — Default: DB.
- **On-Page-Analyse** (rein lokal, keine externe API): prüft Keyword-Präsenz in Title/SEO-Title/Meta/H1/Body, einfache Dichte, Position. Ergebnisse fließen als Zusatzkriterium in `seo-score.ts` (optionales Input-Feld `targetKeyword`) und werden in Sidebar + Dashboard angezeigt.
- **Ranking-Positionen** (echte SERP-Daten) kommen aus der GSC-Integration (Phase 6), nicht aus einem bezahlten Keyword-API.

---

## Phase 6 — Google Search Console (schwerste Sektion)

**Route:** `app.seo.search-console.tsx` · **Plan:** Pro & Max.

- **OAuth 2.0** zu Google (Search Console API). Neue Env-Vars `GOOGLE_OAUTH_CLIENT_ID`/`_SECRET`; OAuth-Callback-Route. **Refresh-Token verschlüsselt** in neuem Modell `GoogleSearchConsoleConnection { shop, propertyUrl, refreshToken(enc), … }` (gleiche Crypto-Utility wie AI-Keys; GDPR-Purge ergänzen).
- **Funktionen:** `searchanalytics.query` (Klicks/Impressionen/CTR/Position je Seite & Query, Dashboard-Charts), `urlInspection` (Indexierungs-Status pro Seite), `sitemaps.submit` (Shopify-`/sitemap.xml` an GSC melden — Sitemap selbst ist nativ, daher hier nur Submit/Validierung, kein Generator).
- **Verknüpfung:** GSC-Query-Daten reichern Phase-5-Keywords mit realen Positionen an und liefern dem Audit einen echten Feedback-Loop.
- Aufwand/Heaviness rechtfertigt späte Phase; sauber hinter Plan-Gate.

---

## Optionale Erweiterungen (nach Bedarf, gleicher Bauplan)
- **Readability-Score:** sprachbewusste Lesbarkeit (Satz-/Wortlänge, Flesch-ähnlich) als reine Funktion neben `seo-score.ts`; in Sidebar + Dashboard. Kein API.
- **Open-Graph / Social-Preview:** OG-Title/Description/Image (per app-owned Metafield), Vorschau-Karte; vom `structured-data.liquid`-Embed mit ausgegeben.
- **Score-Historie/Trend:** `SeoScoreSnapshot { shop, period, avgScore, distribution }` für Verlaufs-Charts + günstigere Dashboard-Loads (GDPR-Purge ergänzen).

---

## Kritische Dateien (gesamt)

**Neu (Routen):** `app/routes/app.seo.tsx`, `app.seo._index.tsx`, `app.seo.structured-data.tsx`, `app.seo.redirects.tsx`, `app.seo.hreflang.tsx`, `app.seo.keywords.tsx`, `app.seo.search-console.tsx` (+ App-Proxy-Route für 404-Beacon, + GSC-OAuth-Callback-Route).

**Bereits auf `feature/jsonld-structured-data` vorhanden (übernehmen):** `app/services/structured-data.service.ts` (+ `tests/unit/structured-data.service.test.ts`), `extensions/structured-data/` (Liquid-Block + `shopify.extension.toml` + Locale), die `structuredData`-Erweiterung in `SeoSidebar.tsx`/`UnifiedContentEditor.tsx`, die JSON-LD-i18n-Keys.

**Neu (Logik/Extension):** `app/utils/seo-score.ts` (reine Score-Funktion), optional `app/services/seo-audit.service.ts` (Aggregation), `app/services/google-search-console.server.ts`.

**Neu (Prisma-Modelle, alle shop-scoped + GDPR-Purge-Pflicht in [gdpr.service.ts](app/services/gdpr.service.ts)):** `Seo404Hit`, `SeoKeyword`, `GoogleSearchConsoleConnection`, `SeoScoreSnapshot` (Anhang B), `SeoAiReferral`, `SeoIndexNowConfig`, `SeoIndexNowQueue` (Anhang D). Model-Count-Kommentar in `gdpr.service.ts` entsprechend hochzählen (heute 35 → +Audit/Keyword/GSC/404 + 3 aus Anhang D). Optional relationales `ProductVariant.barcode` (Anhang C1, kein eigenes Modell). **JSON-LD/FAQ/OG brauchen kein Modell** — Config im Theme-Editor-Block bzw. Metafield.

**Geändert (Task-Internalisierung, Anhang B):** [task-recovery.service.js](task-recovery.service.js) — neue lange Typen (`seoAudit`/`seoBulkFix`/`seoRedirectImport`/`seoGscSync`) in `LONG_RUNNING_TASK_TYPES`; `t.tasks.taskType.*` (de/en/es) — Labels für die neuen Typen.

**Geändert:**
- [SeoSidebar.tsx](app/components/SeoSidebar.tsx) — nutzt `seo-score.ts` statt Inline-`useMemo`.
- [MainNavigation.tsx](app/components/MainNavigation.tsx) — Tab-Eintrag + Mobile-Drawer.
- [de.ts](app/i18n/de.ts)/[en.ts](app/i18n/en.ts)/[es.ts](app/i18n/es.ts) — `nav.seo` + `seo.*`-Block.
- [content.queries.ts](app/graphql/content.queries.ts)/[content.mutations.ts](app/graphql/content.mutations.ts) — `urlRedirect*`, `shopLocales`, ggf. app-Metafield-Reads.
- [gdpr.service.ts](app/services/gdpr.service.ts) — `deleteMany` für jedes neue Modell (+ Model-Count-Kommentarblock aktualisieren; Drift-Guard-Test prüft das).
- `shopify.app.dev.toml` + `shopify.app.prod.toml` — Scope `write_online_store_navigation` ergänzen (Phase 3).
- `app.products.tsx` / `app.collections.tsx` / `app.blog.tsx` / `app.pages.tsx` — `?select=`→`initialItemId`-Resolver (Dashboard-Deep-Links).
- `scripts/validate-env.js` — neue GSC-Env-Vars (Phase 6).
- ggf. [plans.ts](app/config/plans.ts) — nur falls Premium-Gates als `ContentType` modelliert werden (sonst rein über `usePlan()` in der Sektion).

**Wiederverwendet (nicht neu bauen):** AI-Queue/`Task`, `/api.ai`-Handler (`generateAIText`, `handleGenerateAllAltTexts`, Translate-Handler), DB-Content-Cache (`Product`/`Collection`/`Article`/`Page`/`ProductImage`/`ContentTranslation`), `METAFIELDS_SET`, `usePlan()`, `useAppNavigation()`, `SeoSettingsContext` (`seoTitleSuffix`), API-Key-Crypto-Utility.

---

## Verifikation (end-to-end)

1. **Nav:** `npm run dev`, App im Admin öffnen → „SEO" steht zwischen „Inhalte" und „Aufgaben", aktiver Zustand korrekt, Session-Params bleiben beim Wechsel erhalten (kein Blank-Screen). Sub-Tabs wechselbar, gesperrte Sektionen zeigen Upsell.
2. **Scoring-Parität:** Produkt im Editor öffnen, Sidebar-Score notieren; selbes Produkt im Dashboard → identischer Score (beweist driftfreie Extraktion).
3. **Dashboard:** Aggregat-Zahlen plausibel; Filter „Meta fehlt" listet genau die Items ohne Meta; Zeilen-Link öffnet korrekten Editor.
4. **Bulk-Fix:** Aktion auf kleiner Auswahl → Tasks erscheinen im Aufgaben-Tab, laufen über die Queue; Meta/Alt danach in Shopify gesetzt (Admin gegenprüfen).
5. **JSON-LD:** Embed im Theme-Editor aktivieren, Org-Daten speichern; Storefront-Produktseite-Quelltext nach `application/ld+json` durchsuchen → valides Product-Schema; mit Google Rich-Results-Test bestätigen.
6. **Redirects/404:** Redirect anlegen → alte URL leitet 301 weiter; bewusst 404 erzeugen → erscheint nach Beacon im 404-Panel; „→ Weiterleitung anlegen" erzeugt korrekten Redirect.
7. **hreflang:** Locale publizieren, Item ohne Übersetzung lassen → Audit listet die Lücke; Bulk-Translate aus dem Panel füllt sie; Audit danach grün.
8. **Keywords:** Ziel-Keyword setzen → On-Page-Analyse zeigt Präsenz/Dichte; Score reagiert.
9. **GSC:** OAuth-Flow abschließen → Property verbunden, Klick-/Impression-Charts laden, Indexierungs-Status pro URL abrufbar.
10. **Querschnitt:** `npm run lint` + `tsc` grün; GDPR-Drift-Guard-Test grün (alle neuen Modelle in `redactShopData()`); `prisma migrate` sauber.

## Empfohlene Reihenfolge
Phase 0 → 1 → 2 (MVP, sofort wettbewerbswirksam) → 3 (Redirects/404) → 4 (hreflang) → 5 (Keywords) → 6 (GSC, Pro+) → **7 (AEO — llms.txt/robots.txt/Referral, basic)** → **8 (IndexNow, Pro+)**. **Anhang C** (GTIN/FAQ/Review-Schema, Bulk-Meta-Editor, Open Graph) erweitert Phase 1/2 und kann parallel laufen — C1 (GTIN) ist ein billiger, hoher AEO-Hebel und sollte mit Phase 2 mitgenommen werden. Anhang D = Phase 7/8.

---

# Anhang A — Konkretisierung (von Review-Agenten gegen den Code verifiziert)

> Alle Signaturen/Pfade/Operationen unten sind gegen den aktuellen `develop`-Stand geprüft. Findings-`code`s sind i18n-Schlüssel (nie übersetzte Strings); UI mappt sie auf `t.seo.findings.*`. Bestehende `t.seo.issues.*` / `recommendations.*` / `criteria.*` / `scoreLabels.*` sind die **kanonischen** Finding-Strings → wiederverwenden, nicht duplizieren.

## A1 — Geteilte Contract-Bausteine (Phase 0.1b)

**`app/config/seo-sections.ts`** — Spiegel von `CONTENT_RUBRICS`:
```ts
export interface SeoSectionDef { id: string; path: string; icon: string; labelKey: string; kind: "audit"|"tool"|"integration"; planGate?: Plan; }
export const SEO_SECTIONS: SeoSectionDef[] = [/* overview, structuredData, redirects, hreflang, keywords, searchConsole */];
export function getActiveSeoSection(pathname: string): SeoSectionDef | null; // LÄNGSTER Pfad zuerst sortieren — "/app/seo" ist Präfix aller Sub-Pfade
```
**`app/utils/seo-score.ts`** — `SeoFinding` + reine Score-Funktion:
```ts
export interface SeoFinding { sectionId: string; code: string; severity: "error"|"warning"|"success"; points?: number; resourceType?: "product"|"collection"|"article"|"page"|"shop"; resourceId?: string; data?: Record<string, unknown>; }
export function computeSeoScore(input: SeoScoreInput, sectionId?: string): { score: number; findings: SeoFinding[] };
export function scoreTone(score: number): "success"|"warning"|"critical"; // EINE Quelle der ≥70/≥40-Schwellen (Sidebar UND Dashboard)
```
- Gewichte/Schwellen **1:1** aus `SeoSidebar.tsx:50-203` übernehmen (Title 15 / SeoTitle 15 / Desc 20 / Meta 20 / Alt 30; Normalisierung `round(score/maxScore*100)`). `seoTitleEffectiveLimit` berechnet der **Caller** (`seoTitleSuffix ? 60-len : 60`, exakt wie `api.ai.tsx:71-73`).
- **`app/components/seo/SeoSectionLayout.tsx`**: Header aus `t.seo.sections[id]`, `HelpTooltip`, Plan-Gate via `usePlan()` + `isPlanAtLeast(plan, gate)` (Reihenfolge-Helper existiert in `MainNavigation.tsx:252`) → Upsell-Card statt `children`.
- **`MainNavigation.tsx`**: `tabs`-Array (Zeilen 222–226), `seo` zwischen `content`(223) und `tasks`(224); generischer Active-Zweig (318–321) greift; Mobile-Drawer prüfen.

## A2 — Audit-Dashboard (Phase 1)

**`app/services/seo/audit.service.ts`** → `analyzeStore(shop, { db, seoTitleEffectiveLimit }): Promise<AuditAggregate>` (`byType`-Avg/Verteilung, Problem-Buckets, `worstOffenders`, `totalScanned`).
- **DB-cache-first, mit Scale-Guard:** `select` statt `include`; Alt-Coverage via **`productImage.groupBy`** (kein per-Produkt-`include` → vermeidet N+1/OOM wie in `app.products.tsx:83-100` dokumentiert). `take`-Cap je Typ (Plan-Limits als Decke + Env-Hard-Cap, vgl. `PRODUCTS_MAX_LOADED`), `totalScanned` vs `count()` anzeigen.
- Plan-gegatete Typen (`PLAN_CONFIG[plan].contentTypes`) überspringen. `excludeImages/excludeDescription` je Typ wie `UnifiedContentEditor.tsx:384-385`.
- **Bulk-Fix:** Dashboard feuert pro Item dieselben `/api.ai`-POSTs wie der Editor — `action=generateAIText` → `handleGenerateAIText` (`type:"aiGeneration"`), Alt via `action=generateAllAltTexts` → `handleGenerateAllAltTexts` (**Task-Typ exakt `"bulkAIGeneration"`**, Code-Casing, nicht das Schema-Kommentar-Casing; Cap `MAX_IMAGES_PER_REQUEST=250` → pro Produkt enqueuen, Client-Concurrency drosseln). **Keine** Task-Schema-Änderung, kein neues Modell → GDPR-Guard unberührt.
- **Parität-Caveat:** Sidebar nutzt Editor-Live-State, Dashboard die `ProductImage`-Rows → Score-Parität nur auf **gespeichertem** Stand zusichern (Verifikation Punkt 2 entsprechend formulieren).

## A3 — Structured Data Section (Phase 2)

- Route `app.seo.structured-data.tsx` = **reine Read/Preview/Status-Seite** (kein `action`, kein State). Loader holt `ShopInfo` aus `GET_SHOP_METADATA` + je ein Beispiel-Item aus dem Cache, ruft `build*JsonLd` + `renderJsonLdScript` + `validateJsonLd` (vorhandener Service) → `<pre>` + Badges (gleiche Darstellung wie Sidebar).
- **Theme-Editor-Deeplink (exakt):** `https://{myshopifyDomain}/admin/themes/current/editor?context=apps&activateAppId={SHOPIFY_API_KEY}/structured-data` — nutzt **`process.env.SHOPIFY_API_KEY`** (App-client_id) + Block-Handle `structured-data`, **nicht** die Extension-`uid`.
- **Aktivierung nicht zuverlässig per API erkennbar** → Status „unbekannt" + Deeplink; `analyze()` meldet `{ code:"structuredData.appEmbedUnknown", severity:"warning", resourceType:"shop" }` (+ optional `serviceReady`-Success, damit Section im Dashboard auftaucht). Section-Service unter `app/services/seo/structured-data.service.ts` (Namens-Kollision vermeiden — reiner Builder bleibt in `app/services/structured-data.service.ts`).

## A4 — Redirects & 404 (Phase 3)

**GraphQL (neu in `content.queries.ts`/`content.mutations.ts`):**
- Query `urlRedirects(first, after, query, sortKey: UrlRedirectSortKeys, reverse)` → `edges{node{id path target}} pageInfo`. Suche: `path:/old`, `target:…`. Cursor-Pagination.
- `urlRedirectCreate(urlRedirect: UrlRedirectInput!)`, `urlRedirectUpdate(id, urlRedirect)`, `urlRedirectDelete(id)` — `UrlRedirectInput { path: String!, target: String! }`, immer `userErrors{field message code}` lesen. Validierung vor Mutation: `path` startet mit `/`, `path!==target` (keine Schleife), `target` nicht leer.
- Bulk (Pro): `stagedUploadsCreate(resource: URL_REDIRECT_IMPORT, mimeType:"text/csv")` (Muster `api.staged-upload.tsx:67`) → Upload (CSV-Spalten **`Redirect from` / `Redirect to`**) → `urlRedirectImportCreate(url)` → `urlRedirectImportSubmit(id)`; Fortschritt über `finished`/Counts (kein lokaler Task).

**`app/services/seo/redirects.service.ts`:** `listRedirects` (Live-GraphQL ok — klein/paginiert, kein Katalog-Sweep), `create/update/deleteRedirect`, `analyze(shop,{admin,db})` → `Seo404Hit`-basierte `redirects.frequent404`-Findings, `fix(shop,{hitPath,target})` = createRedirect + Hit auf `redirected` setzen.

**404-Beacon:** `app/routes/proxy.seo-404.tsx` (`authenticate.public.appProxy`, Muster `proxy.direct-add.tsx`) — POST `{path, referrer}`, Pfad normalisieren, Upsert-Increment. Theme-Snippet `{% if request.page_type == '404' %}` → `fetch('/apps/<proxy-subpath>/seo-404', …)`.

**Prisma `Seo404Hit`** (spiegelt `DirectTranslationCandidate`):
```prisma
model Seo404Hit { id String @id @default(cuid()) shop String path String pathHash String referrer String? @db.Text count Int @default(1) status String @default("new") firstSeenAt DateTime @default(now()) lastSeenAt DateTime @default(now()) @@unique([shop, pathHash]) @@index([shop, status]) @@index([shop, lastSeenAt]) @@index([shop, count]) }
```
FIFO-Cap (`MAX_404_HITS_PER_SHOP=1000`, Muster `direct-translation.server.ts:386`). **GDPR:** `seo404Hit.deleteMany` in `redactShopData` (Guard erzwingt es).

## A5 — hreflang-Audit (Phase 4)

**`app/services/seo/hreflang.service.ts`** → `analyze(shop, { db, admin }): Promise<HreflangResult>`.
- **`getCachedShopLocales(admin, shop)` wiederverwenden** (`shop-locales-cache.server.ts`, 60s-TTL) — **keine neue Query**. `primary` + `published&&!primary`.
- Publishable-Set aus Cache: Products `status:"ACTIVE"`; Collections/Articles/Pages haben **kein** Status-Feld → alle Cache-Rows als live behandeln (Limitation in UI-Copy nennen).
- **Es gibt kein Per-Locale-Published-Flag** → Coverage ableiten: pro publizierter Sekundär-Locale `contentTranslation.groupBy({by:["resourceId"], where:{shop, locale, key:{in:["title","body_html","meta_title","meta_description"]}}})` → fehlende = publishable ohne Translation. Findings: `hreflang.missingTranslation` (pro Item, **gecappt** ~500), `hreflang.localeCoverage`, `hreflang.noXDefault`/`xDefaultOk` (x-default = primary vorhanden), `hreflang.marketDomainHint`, `hreflang.localesUnavailable` (leere Locales).
- **Fix = vorhandener Pfad:** Route-Action POSTet `action=translateFieldToAllLocales` an `/api.ai` (`handleTranslateFieldToAllLocales`, `type:"bulkTranslation"`) — kein neuer Mechanismus. `fieldType`-Whitelist = `fieldKeyMap` des Handlers.

## A6 — Keyword-Tracking (Phase 5)

**Prisma `SeoKeyword`** `@@unique([shop, resourceId, locale])` + `@@index([shop, keyword])` (für GSC-Join); `keyword` lowercased beim Schreiben; GSC-Spalten `gscPosition/Clicks/Impressions/Ctr/UpdatedAt` (Phase 6). **GDPR:** `seoKeyword.deleteMany` + Kommentarblock-Count.
**`app/services/seo/keywords.service.ts`** → `analyzeOnPage(input): KeywordOnPageResult` (rein, server+client): Präsenz in Title/SeoTitle/Meta/H1/Body (H1 per Regex **vor** HTML-Strip), Density (low<0.5% / ok / high>2.5% = Stuffing), `firstPositionPct`. Findings `keywords.*`. Optionales `targetKeyword` in `computeSeoScore` ergänzt ein Kriterium **nur wenn gesetzt** (sonst byte-identischer Score → Parität gewahrt).

## A7 — Google Search Console (Phase 6, Pro+)

**Prisma `GoogleSearchConsoleConnection`** `@@unique shop`, `refreshToken @db.Text` **verschlüsselt via `encryptToken()`** (`app/utils/encryption.server.ts` — purpose-built, gleiche AES-256-GCM wie AI-Keys; Lesen `decryptToken`/non-throwing). **GDPR:** `googleSearchConsoleConnection.deleteMany` (+ optional Google-seitiges `oauth2.revoke`).
- **Env:** `GOOGLE_OAUTH_CLIENT_ID/_SECRET/_REDIRECT_URI` (+ Check in `scripts/validate-env.js`), bestehender `ENCRYPTION_KEY`.
- **OAuth:** Callback-Route `auth.google.callback.tsx` **außerhalb** des `app.`-Baums (nicht im Admin-iframe/App-Bridge). Scopes: `webmasters.readonly` + `webmasters` (für `sitemaps.submit`), `access_type=offline&prompt=consent`, signierter `state` (CSRF). Access-Token pro Request aus Refresh-Token (in-memory, nicht speichern); `invalid_grant` → Connection löschen + `searchConsole.reconnectRequired`.
- **API (`app/services/google-search-console.server.ts`):** `searchAnalytics/query` (dims `query`/`page`, `dataState:"final"`, Trailing-Window wg. 2–3d-Latenz, Ergebnisse cachen), URL Inspection `urlInspection/index:inspect` (on-demand), Sitemaps `PUT …/sitemaps/{feedpath}` (Shopify-`/sitemap.xml` nur submitten/validieren). `analyze()` → `searchConsole.notConnected` wenn keine Connection (nicht werfen).
- **Keyword-Enrichment:** `querySearchAnalytics(dims:["query","page"], -28d)` → Match `keys[0]===keyword` & Page-URL↔GID(Handle) → `SeoKeyword.gsc*` zurückschreiben; Finding `keywords.gscPosition`. Plan-Gate `meetsPlan(plan,"pro")` **server-seitig** in Loader/Action **und** Callback.

## A8 — Konsolidierte Testpunkte (Querschnitt)
- `computeSeoScore`-**Paritätstest** gegen Pre-Refactor-Snapshot (Grenzwerte Title 29/30/70/71; SeoTitle 0/Limit/>Limit mit Suffix; Meta 0/119/120/160/161; Alt 0-of-0/1-of-2/2-of-2).
- `getActiveSeoSection` Längst-Match; `isContentPath("/app/seo")===false`.
- `analyzeStore` Bucket-Korrektheit + Scale-Cap (5000er-Fixture, kein per-Produkt-Include).
- GraphQL-Validierung Redirects (`path` ohne `/` abgelehnt, Loop abgelehnt, `userErrors` gemappt); `record404Hit` Increment + FIFO + Status-Erhalt.
- hreflang: Item mit/ohne Translation; 100% → success; kein primary → `noXDefault`; DRAFT ausgeschlossen; leere Locales → `localesUnavailable`.
- Keywords: alle Felder/keins; Density-Grenzen; H1 vor Strip; Score-Parität ohne `targetKeyword`.
- GSC: Token-Exchange/Refresh (mock), `invalid_grant` → Connection geleert; gespeicherter Token `isEncrypted()`≠Plaintext; Non-Pro-`connect` server-seitig abgelehnt.
- **GDPR-Drift-Guard** grün mit `Seo404Hit`/`SeoKeyword`/`GoogleSearchConsoleConnection` + jeweils `deleteMany` + Count-Block; `tsc`/`lint` grün (fehlt ein i18n-Key in en/es, bricht der Build).

---

# Anhang B — Task-Internalisierung (lange Operationen im Hintergrund)

## B0 — Wie das Task-System funktioniert (verifiziert)
Zwei Schichten: (1) das durable **`Task`-Modell** (status/progress/total/processed/result/queuePosition/retryCount/expiresAt), generisch im Aufgaben-Tab gerendert und client-seitig gepollt (`api.recently-completed-tasks`, `api.running-tasks-count`, `api.running-field-tasks`); (2) die **Ausführung** in zwei Spielarten:
- **`AIQueueService`** ([ai-queue.service.ts](src/services/ai-queue.service.ts)) — In-Memory-Singleton, **per-Shop-Queues**, **global** provider-rate-limitiert (Concurrency via `AI_QUEUE_CONCURRENCY`), Round-Robin, Retry mit Backoff. Nur für echte AI-Provider-Calls. `enqueue(shop, taskId, provider, estTokens, execute)`.
- **Detached Runner** — `void runX(taskId,…).catch(...)`: Fire-and-forget, überlebt Navigation, schreibt Progress/Teilergebnis nach jeder Einheit. Für Orchestrierung von Bulk-Schleifen und reine Nicht-AI-Arbeit.
- **Recovery** ([task-recovery.service.js](task-recovery.service.js)): markiert `running/pending/queued` als `failed`, wenn `updatedAt` nicht binnen Schwelle voranschreitet — **10 min default, 45 min** für Typen in `LONG_RUNNING_TASK_TYPES` (Zeilen 34–44). → neue lange Typen dort eintragen + heartbeaten.

## B1 — Klassifikation der SEO-Operationen

| Operation | Phase | Task? | Typ / Mechanik |
|---|---|---|---|
| Store-weiter Audit-Scan (alle Items scoren) | 1 | **Ja** | `seoAudit` — detached Runner, schreibt `SeoScoreSnapshot`; Dashboard liest Snapshot, „Neu scannen" enqueuet |
| Bulk-Fix (fehlende Meta/Alt über viele Items) | 1 | **Ja** | `seoBulkFix` — Parent-Runner orchestriert, per-Item via `AIQueueService` (statt Client-Fan-out) |
| hreflang Bulk-Translate | 4 | **Ja** | Parent `seoBulkFix`/bestehender `bulkTranslation`-Pfad über `/api.ai` |
| Redirect-CSV-Import | 3 | **Ja** | `seoRedirectImport` — Nicht-AI-Runner pollt Shopify `urlRedirectImport.finished`, schreibt Progress |
| GSC-Sync + Keyword-Enrichment | 6 | **Ja** | `seoGscSync` — Nicht-AI-Runner, `searchAnalytics.query` + Rückschreiben in `SeoKeyword`; „Jetzt syncen" + periodisch |
| Einzelfeld generieren | 1/Editor | bereits | bestehender `aiGeneration`-Task |
| Einzel-Redirect anlegen/ändern/löschen | 3 | Nein | synchrone Mutation |
| 404 → ein Redirect | 3 | Nein | synchron |
| Einzelne URL-Inspektion (GSC) | 6 | Nein | synchron, on-demand |
| On-Page-Keyword-Analyse | 5 | Nein | rein/instant |
| JSON-LD-Preview/Validierung | 2 | Nein | instant |
| hreflang `analyze()` (read) | 4 | meist Nein | klein = synchron; großer Katalog → in `seoAudit`-Scan mitrechnen |

**Unifizierung:** Der `seoAudit`-Scan rechnet idealerweise **alle read-heavy Section-Findings in einem Durchgang** (Score-Buckets + hreflang-Coverage + On-Page-Keywords) und legt sie als Snapshot ab. Section-Loader lesen den Snapshot (schnell); `analyze()` läuft **inline** bei kleinen Shops, **im `seoAudit`-Task** ab einer Katalog-Schwelle (`take`-Cap/Plan-Limit als Grenze, vgl. A2-Scale-Guard).

## B2 — Konkrete Schritte
- **Neue Task-Typen:** `seoAudit`, `seoBulkFix`, `seoRedirectImport`, `seoGscSync` (hreflang nutzt `bulkTranslation`). Jeden in `LONG_RUNNING_TASK_TYPES` ([task-recovery.service.js:34](task-recovery.service.js#L34)) ergänzen.
- **i18n:** Labels unter `t.tasks.taskType.*` (+ neue `resourceType`/`fieldType`-Werte wie `seoScan`, `redirectImport`) in de/en/es — sonst Fallback auf rohen Typ-String.
- **Snapshot-Modell** (macht aus „optional" jetzt Teil des MVP für große Shops): `SeoScoreSnapshot { id, shop, scope, payload Json, totalScanned, createdAt }` — **shop-scoped + GDPR-`deleteMany`** in `redactShopData`. Dashboard-Loader liest neuesten Snapshot statt live zu scannen.
- **Single-flight:** vor `seoAudit`/`seoGscSync`-`create` auf bestehenden `running`-Task gleichen Typs/Shops prüfen (kein Doppelscan).
- **Runner-Vertrag:** `expiresAt: getTaskExpirationDate()`, Progress-Write nach jeder Einheit (Heartbeat), Teilergebnis in `Task.result`, finaler `status:"completed"`/`"failed"`. AI-Arbeit ausschließlich über `AIQueueService`.

## B3 — Testpunkte
- `seoAudit`-Runner: Navigation während des Scans → Task läuft weiter, Snapshot wird geschrieben, Dashboard zeigt ihn nach Reload.
- `seoBulkFix`: Parent-Task `processed/total` steigt; einzelne AI-Calls erscheinen über die Queue; Abbruch/Restart → Recovery markiert nicht fälschlich „failed" (Heartbeat vorhanden, Typ in Allowlist).
- `seoRedirectImport`: langer Import (>10 min) wird **nicht** nach 10 min gereapt (Allowlist + Heartbeat greifen).
- Single-flight: zweiter `seoAudit`-Trigger bei laufendem Scan erzeugt keinen zweiten Task.
- i18n-Fallback: unbekannter Typ rendert lesbar; mit Labels korrekt übersetzt.
- GDPR-Drift-Guard grün mit `SeoScoreSnapshot` + `deleteMany`.

---

# Anhang C — Erweiterte Structured Data + Bulk-Meta-Editor + Open Graph (Konkurrenz-Nachtrag §2.2.1, agentenverifiziert)

> Erweitert **Phase 2** (auf dem JSON-LD-Branch) und **Phase 1** (Audit). **Kein neues shop-scoped Modell** (FAQ/OG via Metafield, Structured-Data-Config im Theme, Bulk-Meta nutzt vorhandene Caches). Findings = Codes unter `t.seo.findings.*`.

## C1 — GTIN/Brand/Offer-Vollständigkeit (höchster AEO-Hebel)
KI-Shopping (ChatGPT/Perplexity) matcht Produkte über **GTIN**; 83 % von ChatGPTs Shopping-Carousel zieht aus dem Google-Shopping-Feed → ohne GTIN unzuverlässig.
- **`structured-data.service.ts`:** `ProductInput` +`gtin/mpn/priceValidUntil/itemCondition/brandUrl/ratingScaleMax`. Neuer reiner `gtinProps(barcode)` → wählt `gtin8/12/13/14` nach Ziffernlänge (`\D` strippen, sonst generisches `gtin`). `buildProductJsonLd`: `Offer` +`itemCondition`(default `NewCondition`)+`priceValidUntil`(default +1 J), Root +`gtin*`/`mpn`, `brand` mit `url`. Alles via `compact()` → Byte-Parität bei leeren Inputs. `validateJsonLd`: Warning `noGtin` (kein gtin/mpn), `offerNoAvailability`.
- **Liquid-Block:** `p_var.barcode`→gtin (natives Liquid-Property, **kein Scope/Sync**), `custom.mpn`, `itemCondition`/`priceValidUntil`.
- **In-App-Preview:** `barcode` ist nicht im `ProductVariant`-Cache → Preview lässt `gtin` weg (Storefront emittiert vollständig, kein Drift). **Nur falls** das Dashboard GTIN-Coverage messen soll: `ProductVariant.barcode String?` ergänzen (Cascade über `Product`, **kein** neues shop-scoped Modell).

## C2 — FAQ / Review / LocalBusiness / Video Schema
- **FAQ:** Metafield `custom.faq` (Typ `json`, `[{question,answer}]`), via vorhandenes `METAFIELDS_SET`. `buildFaqJsonLd(entries)` (filtert leere, `null` bei 0); Liquid-Block +`enable_faq`; `validateJsonLd` FAQPage-leer→error.
- **Review:** Service spiegelt das Liquid (`reviews.rating(.value.rating/.scale_max)` + `reviews.rating_count`) inkl. `bestRating`. Das **Shopify-Standard-Rating-Metafield** deckt Judge.me/Loox ab; Dashboard-Finding `reviewMetafieldMissing` wenn fehlend (App-eigene Namespaces wie `loox.avg_rating` = bekannte Grenze).
- **LocalBusiness:** opt-in Block-Settings (NAP), nur `request.page_type=='index'`, default **false** (nur bei physischer Präsenz).
- **Video:** `VideoObject` aus `product.media | where:'media_type','video'`; `uploadDate`-Fallback `published_at` (Best-Effort, da Liquid kein zuverlässiges per-Media-Datum liefert).

## C3 — Manueller Bulk-Meta-Editor (Phase 1, distinkt vom AI-Bulk-Fix)
- Sub-Route `app/routes/app.seo.bulk-meta.tsx`, Descriptor `{id:"bulkMeta", planGate:"basic", kind:"tool"}`. Inline-editierbare `IndexTable` (Title/SEO-Title/Meta/Handle/Alt) aus DB-Cache (`select`-minimiert, `take`-Cap wie A2). **Diff-only Save-All**.
- **Action reuse (vorhandene Mutationen):** `productUpdate(input{seo,handle})` (Muster `update.actions.ts:863`), `collectionUpdate`, `pageUpdate`, `articleUpdate`, `fileUpdate`/`productUpdateMedia` (Alt). Danach DB-Cache nachziehen. `userErrors` **pro Zeile** mappen (eine Kollision bricht nicht den ganzen Save).
- **Große Auswahl = Task `seoBulkMeta`** (detached **Non-AI**-Runner, nicht über `AIQueueService`; Heartbeat via Progress-Write; in `LONG_RUNNING_TASK_TYPES` + `t.tasks.taskType.seoBulkMeta` + Single-flight). ≤~25 Items synchron.
- **Bild-Dateinamen sind auf Shopify nach Upload immutabel** (web-bestätigt) → **kein** Rename-Editor; nur Audit-Finding `nonDescriptiveFilename` (`IMG_\d+|DSC\d+|untitled…`) mit Re-Upload-Empfehlung (nicht-destruktiv). Alt-Text + WebP decken die machbare Bild-SEO-Fläche.

## C4 — Open Graph / Twitter Cards (Phase-2-adjazent)
- **Neuer Block** `extensions/structured-data/blocks/social-meta.liquid` mit `target:"head"` (OG/Twitter müssen in `<head>`; falls App-Embed-`head` unzulässig → Fallback `body`, **im Theme-Editor zu verifizieren**). Werte aus nativem Liquid (Fallback-Kette `page_title→product.title→shop.name`, Bild `featured_image`→`default_og_image`→`shop.brand.logo`) + optionale Overrides `custom.og_image`/`custom.og_description`. Attribut-Escaping `| escape` (nicht `| json`).
- Structured-Data-Section zeigt OG-Status + Deeplink (`…activateAppId={SHOPIFY_API_KEY}/social-meta`) + clientseitige Social-Preview-Karte. Findings `ogUnknown`/`ogImageMissing`.

## C5 — Reihenfolge & Tests
C1 (höchster Hebel, erweitert gemergten Branch) → C4 (gleiche Extension) → C2 → C3 (größter UI-Aufwand). Tests: `gtinProps` 8/12/13/14/11/leer/Nicht-Ziffern; Offer-/Root-Parität bei leeren Inputs; `buildFaqJsonLd` leer→null; `validateJsonLd` `noGtin`; Bulk diff-only + per-Zeile-`userErrors`; `seoBulkMeta` Heartbeat/Recovery-Allowlist; OG-Preview-Fallback-Kette.

---

# Anhang D — Phase 7 (AEO) + Phase 8 (IndexNow): der KI-Search-Layer (agentenverifiziert)

> Der definierende 2026-Hebel (§2.2.1). Zwei neue contract-konforme Sections + Descriptor-Einträge (`aeo`, `indexNow`). **USP: mehrsprachige AEO** — kein Konkurrent liefert KI-Search-Optimierung über alle Locales.

## D0 — Reality-Korrekturen (gegen Code/Shopify-Docs verifiziert, ändern Annahmen)
- **Webhooks decken nur `products/*` + `collections/*`** (`shopify.app.*.toml:34–42`; **kein** articles/menus-Handler). Der IndexNow-Inkrement-Push hängt sich an die zwei vorhandenen Handler; für Blog-Posts **neuer `webhooks.articles.tsx` + Subscription in beiden toml**.
- **llms.txt ist seit 2026-05-28 NATIV:** Shopify-Liquid-Templates `templates/llms.txt.liquid` / `llms-full.txt.liquid` / `agents.md.liquid`, am Storefront-**Root** `/llms.txt` ausgeliefert. Schreiben via Admin GraphQL **`themeFilesUpsert`** (Scope `write_themes` — **bereits vorhanden**). **App-Proxy ist falsch** (liefert nur `/apps/contentpilot/…`, nicht Root).
- **robots.txt** anpassbar nur via `templates/robots.txt.liquid` (`themeFiles`-Query + `themeFilesUpsert`; `read_themes`/`write_themes` vorhanden); exponiert `robots.default_groups[].{user_agent, rules, sitemap}`.
- **IndexNow-Key-File:** Shopify blockt echte Root-Files → Protokoll-`keyLocation` + Files(CDN)+Redirect: `{key}.txt` in Files hochladen → `urlRedirectCreate /{key}.txt → CDN-URL` → submit mit `keyLocation`. Nutzt die **in Phase 3 ohnehin geplanten `urlRedirect*`** + den Phase-0-Scope `write_online_store_navigation`.
- **AI-Referral** nur via **Web Pixel** (`event.context.document.referrer`, Sandbox, Referrer oft gestrippt → Undercount). KI-*Zitations-Präsenz* ist **nicht** clientseitig messbar → wir liefern Referral-**Zählung**, kein „AI-Overview-Monitoring".

## D1 — Phase 7: AEO (`planGate:"basic"`, kind `tool`)
Route `app/routes/app.seo.aeo.tsx`, Service `app/services/seo/aeo.service.ts`: rein `buildLlmsTxt()` + Theme-I/O (`readThemeFile`/`upsertThemeFile`/`getPublishedThemeId` über `themeFiles`/`themeFilesUpsert`) + Contract `analyze()`/`fix()`.
- **llms.txt-Generierung** aus Shop + Top-Produkten/Collections → Upsert `templates/llms.txt.liquid`.
- **robots.txt AI-Crawler-Audit/Fix:** `AI_CRAWLERS`-Liste (`OAI-SearchBot`, `PerplexityBot`, `Claude-SearchBot`, `ChatGPT-User`, `GPTBot`, …); Finding je geblocktem Bot; **nicht-destruktiver** Diff-Confirm-Fix (opt-in, vgl. Autopilot-Warnung §2.2.1).
- **Referral-Zähler:** Web-Pixel-Extension `extensions/seo-pixel/` → `app/routes/proxy.seo-ai-referral.tsx` (Muster `proxy.collect-strings.tsx`) → Modell `SeoAiReferral` (tagesgebucket, **keine PII**).
- Alle Fixes **synchron** (keine Tasks).

## D2 — Phase 8: IndexNow / Instant Indexing (`planGate:"pro"`, kind `integration`)
Route `app/routes/app.seo.index-now.tsx`, Service `app/services/seo/index-now.service.ts` (`provisionKey`/`verifyKeyFile`/`deprovision`/`submitUrls`/`analyze`/`fix`).
- **Inkrementeller Push** eingehängt in `processWebhookAsync` von `webhooks.products.tsx`/`webhooks.collections.tsx` (+ neu `webhooks.articles.tsx`), debounced über `SeoIndexNowQueue`.
- **Bulk** = `seoIndexNow`-Task (detached **Non-AI**-Runner, 10k-chunked, heartbeatend) → **in `LONG_RUNNING_TASK_TYPES`** (`task-recovery.service.js:34`) + `t.tasks.taskType.seoIndexNow`.
- Modelle `SeoIndexNowConfig` (Key **plaintext** — öffentlicher Token per Design) + `SeoIndexNowQueue`.
- Ziel Bing/IndexNow + AI-Crawler (Googles Ping ist abgekündigt).

## D3 — GDPR / Plan-Deltas (D)
- **3 neue shop-scoped Modelle** (`SeoAiReferral`, `SeoIndexNowConfig`, `SeoIndexNowQueue`) → je `deleteMany({where:{shop}})` in `redactShopData`; **Model-Count-Kommentar 35→38** (Drift-Guard parst die Zahl).
- **Keine neuen Scopes** (write_themes/read_themes vorhanden; `write_online_store_navigation` kommt aus Phase 0).
- **Neue Dateien:** `webhooks.articles.tsx` (+ Subscription in `shopify.app.dev/prod.toml`), `proxy.seo-ai-referral.tsx`, Web-Pixel-Extension `extensions/seo-pixel/`.
- Beide Sections als `SEO_SECTIONS`-Einträge (`aeo` basic, `indexNow` pro), server-seitig via `meetsPlan()` gegatet.

## D4 — Tests (D)
- `buildLlmsTxt` deterministisch; robots.txt-Parser erkennt geblockten `PerplexityBot` → Finding; Diff-Fix ändert nur die Bot-Zeilen (nicht-destruktiv).
- IndexNow: `keyLocation`-Submit-Body korrekt; Webhook-Debounce dedupliziert; `seoIndexNow`-Task >10 min nicht gereapt (Allowlist+Heartbeat); Key-File-Verify über Redirect erreichbar.
- Web-Pixel: Referral aus `chatgpt.com`/`perplexity.ai` landet tagesgebucket in `SeoAiReferral`, keine PII.
- GDPR-Drift-Guard grün mit 3 neuen Modellen + Count 38.
