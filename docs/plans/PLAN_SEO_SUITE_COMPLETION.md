# SEO-Suite-Vervollständigung — Rudimentärer Plan (Phasen 1–5)

**Status:** Skizze / Entwurf zur späteren Ausarbeitung
**Baut auf:** vorhandene SEO-Oberfläche (Dashboard, Bulk-Meta, GSC, Structured Data, Redirects, Hreflang, IndexNow, AEO, Performance) unter [app/routes/app.seo*.tsx](../../app/routes/) + [PLAN_KEYWORDS_EXPANSION.md](./PLAN_KEYWORDS_EXPANSION.md). Section-Contract: [SEO_SECTION_CONTRACT.md](../SEO_SECTION_CONTRACT.md).
**Ziel dieses Plans:** die Lücken schließen, die ContentPilot vom „SEO-Werkzeug für Content" zur echten SEO-Suite hebt — ohne Backlink-/Kompetitor-Datenmoats anzugehen.

---

## 0. Ist-Zustand (was ContentPilot heute schon deckt)

Damit wir keine Doppelarbeit planen — kurz die Bestandsaufnahme der SEO-Oberfläche:

- **Store-weiter Audit + Score:** [audit.service.ts](app/services/seo/audit.service.ts) → `analyzeStore` liest den DB-Content-Cache (Product/Collection/Article/Page + Alt-Coverage), `computeSeoScore` scored pro Item, Snapshot in `SeoScoreSnapshot`. Rendering im [Dashboard](app/routes/app.seo._index.tsx) mit „Fix with AI"-Bulk (via `seoBulkFix`-Task).
- **Bulk-Meta:** [app.seo.bulk-meta.tsx](app/routes/app.seo.bulk-meta.tsx) + `seoBulkMeta`-Task.
- **Redirects:** [app.seo.redirects.tsx](app/routes/app.seo.redirects.tsx) + CSV-Import ([redirects-csv.ts](app/services/seo/redirects-csv.ts)) + `seoRedirectImport`-Task.
- **Hreflang-Coverage:** [app.seo.hreflang.tsx](app/routes/app.seo.hreflang.tsx).
- **Structured Data (JSON-LD):** [app.seo.structured-data.tsx](app/routes/app.seo.structured-data.tsx) + [structured-data.service.ts](app/services/structured-data.service.ts) mit `validateJsonLd` (leichter schema.org-Sanity-Check). Emission auf dem Storefront durch [extensions/structured-data/](extensions/structured-data/).
- **Search Console:** [app.seo.search-console.tsx](app/routes/app.seo.search-console.tsx) + [google-search-console.server.ts](app/services/google-search-console.server.ts) + `seoGscSync`-Task.
- **AEO / robots.txt AI-Crawler-Audit / llms.txt:** [app.seo.aeo.tsx](app/routes/app.seo.aeo.tsx) + [aeo.service.ts](app/services/seo/aeo.service.ts). **Nur AI-Crawler-Fokus**, keine allgemeine robots-/sitemap-Kontrolle.
- **IndexNow:** [app.seo.index-now.tsx](app/routes/app.seo.index-now.tsx) + `seoIndexNow`-Task.
- **Core Web Vitals / Performance:** [app.seo.performance.tsx](app/routes/app.seo.performance.tsx).
- **Keywords (Ausbau geplant):** [PLAN_KEYWORDS_EXPANSION.md](./PLAN_KEYWORDS_EXPANSION.md).

**Was fehlt, um mit Yoast/RankMath (und dem „kleinen Semrush") auf Augenhöhe zu sein:**

1. Kein **Live-Storefront-Crawler** — der Audit ist rein DB-basiert. Broken Links, echte Response-Codes, Rendered-Head vs. DB-Drift, Orphan-Erkennung via Link-Graph → alles blind.
2. Keine **Internal-Linking-Vorschläge** — trotz vollständigem Content-Wissen der App keine „diese Seite könnte auf X linken"-Feature.
3. Kein **Content-Freshness-Audit** — GSC-Daten liegen vor, `updatedAt` auch, aber kein Crossmatch „rankt gut, aber seit 18 Monaten nicht angefasst → refresh".
4. Keine **Sitemap-Kontrolle** — Shopify generiert automatisch, Merchant kann nichts steuern (Prioritäten, Exclusions, Change-Frequency).
5. Kein **externes Schema-/Rich-Results-Testing** — `validateJsonLd` ist ein guter Sanity-Check, aber kein Deep-Link zu Googles Rich-Results-Test pro Item, kein Batch-Report „welche 42 Produkte haben `productNoImage`".

Diese fünf Lücken sind der Scope dieses Plans.

---

## 1. Zielbild

ContentPilot bleibt **content-first**, aber erweitert seine SEO-Oberfläche um die technischen Prüfungen, die eine echte SEO-Suite ausmachen — mit klarer Abgrenzung nach oben:

- **Wir liefern:** technische On-Site-SEO (Crawl-Audit, Interne Verlinkung, Freshness, Sitemap-Steuerung, Schema-QS) + Content-SEO (bereits vorhanden).
- **Wir liefern nicht:** Backlink-Analyse, Kompetitor-Ranking-Tracking, SERP-Feature-Scraping, Log-File-Analyse. Das sind **Datenmoat-Themen** (Ahrefs/Semrush/Botify) — ohne teure Fremd-Datenbanken bleiben sie halbgar.

Der eine Satz für die Positionierung: *„ContentPilot ist die SEO-Suite für Shopify-Merchants, die keine externe Ahrefs-Lizenz haben — und für die meisten reicht das."*

---

## 2. Datenmodell (grob)

Neue shop-scoped Modelle (alle in `SHOP_SCOPED_MODELS` + `redactShopData` in [gdpr.service.ts](app/services/gdpr.service.ts) eintragen — Drift-Guard-Test schlägt sonst fehl):

```prisma
// Phase 1 (Crawler)
model SeoCrawlSnapshot {
  id          String   @id @default(cuid())
  shop        String
  startedAt   DateTime @default(now())
  finishedAt  DateTime?
  status      String   // "running" | "completed" | "failed"
  pagesTotal  Int      @default(0)
  pagesOk     Int      @default(0)
  pagesBroken Int      @default(0)
  orphanCount Int      @default(0)

  pages     SeoCrawlPage[]
  brokenLinks SeoCrawlBrokenLink[]

  @@index([shop, startedAt])
}

model SeoCrawlPage {
  id           String @id @default(cuid())
  shop         String
  snapshotId   String
  url          String
  statusCode   Int
  responseMs   Int
  title        String?   // <title> from rendered HTML
  metaDesc     String?
  canonical    String?
  h1Count      Int       @default(0)
  wordCount    Int       @default(0)
  resourceType String?   // "product" | "collection" | "article" | "page" | "unknown"
  resourceId   String?   // matched shopify GID if resolvable
  inboundCount Int       @default(0)   // #interne Links, die HIER hinzeigen
  outboundCount Int      @default(0)

  snapshot SeoCrawlSnapshot @relation(fields: [snapshotId], references: [id], onDelete: Cascade)

  @@index([shop, snapshotId])
  @@index([shop, statusCode])
}

model SeoCrawlBrokenLink {
  id         String @id @default(cuid())
  shop       String
  snapshotId String
  fromUrl    String
  toUrl      String
  statusCode Int    // 404, 500, timeout=0, redirect-chain-too-long=-1
  anchor     String?

  snapshot SeoCrawlSnapshot @relation(fields: [snapshotId], references: [id], onDelete: Cascade)

  @@index([shop, snapshotId])
}

// Phase 2 (Interne Verlinkung)
model SeoInternalLinkSuggestion {
  id            String @id @default(cuid())
  shop          String
  fromResourceType String
  fromResourceId String
  anchorText    String   // was im Content erwähnt wurde
  toResourceType String
  toResourceId  String
  confidence    Float
  status        String   // "pending" | "accepted" | "dismissed"
  createdAt     DateTime @default(now())

  @@index([shop, status])
  @@index([shop, fromResourceType, fromResourceId])
}

// Phase 4 (Sitemap)
model SeoSitemapRule {
  id           String @id @default(cuid())
  shop         String
  resourceType String   // "product" | "collection" | "article" | "page" | "blog"
  scope        String   // "all" | "single" | "tagged"
  scopeValue   String?  // resourceId oder Tag-Name
  action       String   // "exclude" | "priority" | "changefreq"
  actionValue  String?  // "0.9" | "weekly" | ...

  @@index([shop, resourceType])
}
```

**Phase 3 (Freshness)** kommt ohne neues Modell aus — ist ein Read-Layer über `updatedAt` × `GscQueryPage`.
**Phase 5 (JSON-LD Validation)** kommt ohne neues Modell aus — nutzt bestehende Item-Tabellen + `validateJsonLd`.

---

## 3. Phase 1 — Storefront-Crawler / echtes Site-Audit

**Das Herzstück dieses Plans.** Ohne Live-Crawl bleiben alle Aussagen zu Broken Links, Orphans, Head-Drift Vermutungen.

### 3.1 Was der Crawler tut

Startet vom Shop-Root (`https://<myshopify>/`) plus `/sitemap.xml`, folgt internen Links (Same-Origin) bis zu Tiefe **N** (default 5, konfigurierbar), respektiert `robots.txt`.

Pro besuchter Seite:
- HTTP `HEAD` → wenn 2xx: `GET` mit `Accept: text/html`; sonst nur Statuscode + Anchor merken.
- HTML parsen (cheerio o. ä.): `<title>`, `meta[name=description]`, `link[rel=canonical]`, `<h1>` count, ungefährer Wortzähler, alle `<a href>` (same-origin) sammeln.
- Response-Zeit tracken.
- Resource-Auflösung: URL-Pfad → `resourceType`/`resourceId` via bestehende URL→Item-Logik (siehe Phase-2-Empfehlung in [PLAN_KEYWORDS_EXPANSION.md §4.1](./PLAN_KEYWORDS_EXPANSION.md#41-item-auflösung)).

Nach dem Crawl:
- Broken Links: alle Kanten `from→to` mit `to.statusCode >= 400` → `SeoCrawlBrokenLink`.
- Orphan-Erkennung: Items im DB-Cache ohne `SeoCrawlPage.inboundCount > 0` (außer sich selbst) → gelten als verwaist.
- Head-Drift: `SeoCrawlPage.title` vs. DB-`seoTitle` (bzw. fallback `title`) — Abweichungen als Finding.

### 3.2 Rate + Robustheit

- `p-limit` auf **5 parallele Requests** (nicht mehr — der eigene Shop soll unter dem Crawl nicht wackeln).
- Timeout: 10 s pro Request, 3 Retries mit exponential backoff bei 5xx/Timeouts.
- User-Agent: `ContentPilotSEO/1.0 (+https://contentpilot.app/bot)`.
- Hard cap: default **2000 Seiten/Crawl** (konfigurierbar bis 10 000 auf Pro-Plan), tiefere Kataloge werden abgeschnitten und der User im UI informiert (`totalDiscovered` vs. `pagesCrawled`).
- Reihenfolge: BFS, damit bei Cap wenigstens flache/wichtige Seiten dabei sind.

### 3.3 UI

Neuer Tab **„Site-Audit"** unter `app.seo.crawl.tsx` (Naming: bewusst NICHT „audit", weil das schon das Dashboard ist):

- Header: „Letzter Crawl vor X Tagen" + Button „Jetzt scannen" + Progress-Balken während Task.
- Kacheln: Seiten gesamt · davon OK · Broken Links · Waisen · Head-Drift.
- Tabs innerhalb:
  - **Broken Links**: `from`, `to`, Status, Anchor — Deep-Link zum Editor der Quell-Seite (`?select=<GID>`), Deep-Link zu Redirects („Redirect anlegen").
  - **Waisen**: Liste der Items ohne interne Inbound-Links — Deep-Link zum Editor + Deep-Link zu Phase 2 („Vorschlag holen").
  - **Head-Drift**: Rendered-Title/Description ≠ DB-Wert — meist Caching-/Theme-Bugs; Zeile zeigt beide Werte + Deep-Link.
  - **Slowest Pages**: Top 20 nach `responseMs`.

### 3.4 Task-Integration

- Neuer Task-Typ **`seoCrawl`** in `LONG_RUNNING_TASK_TYPES` ([task-recovery.service.js:34](task-recovery.service.js#L34)).
- Heartbeat via `Task.progress` alle 25 gecrawlten Seiten.
- Single-flight pro Shop (nur ein aktiver Crawl gleichzeitig).
- i18n: `t.tasks.taskType.seoCrawl`.

### 3.5 Findings-Integration

Broken Links + Orphans + Head-Drift fließen als eigene Codes in den Dashboard-Score (siehe [SEO_SECTION_CONTRACT.md](../SEO_SECTION_CONTRACT.md) §2). Ohne Doppelscoring: Findings, die schon der DB-Audit sieht (leere seoTitle etc.), bleiben dort — der Crawler ergänzt nur die technischen Codes, die DB-only nicht sehen kann.

### 3.6 Pro-Gate

Site-Audit ist ein **Pro-Feature** (Crawl-Kosten + wahrgenommener Wert). Free-Plan sieht den Tab mit Upgrade-CTA und einem Read-only-Beispiel-Snapshot.

### 3.7 Offen für spätere Ausarbeitung

- Robots-Respekt: exakter Parser (existiert schon rudimentär in [aeo.service.ts](app/services/seo/aeo.service.ts) — wiederverwenden).
- Sitemap-Discovery-Reihenfolge (Sitemap first? Root first?).
- Handling von Query-Params (Facet-URLs → sonst Crawl-Explosion).
- Duplicate-Content-Erkennung: gleicher `<title>` auf ≥ 2 URLs → Finding (billige Erweiterung, gehört hier hin).
- Redirect-Chain-Warnung: > 2 Hops → Finding.

---

## 4. Phase 2 — Interne Verlinkungs-Vorschläge

**Ziel:** „Ihr habt 12 Erwähnungen von *Keramikvase* in Blog-Artikeln, die auf Produkt X linken könnten." Reine Content-Analyse auf DB-Basis, kein Live-Fetch nötig.

### 4.1 Algorithmus

Pro Shop einmal die Woche (oder auf Merchant-Trigger):

1. **Zielmenge** aufbauen: alle Produkte/Collections mit ihrem Handle + primärem Keyword (nach Umsetzung von [PLAN_KEYWORDS_EXPANSION.md](./PLAN_KEYWORDS_EXPANSION.md)) + Titel + AI-generierten Synonymen (kleiner LLM-Call einmalig pro Item, gecached).
2. **Quellenmenge** durchgehen: HTML-Bodies aller Blog-Artikel + Pages + `descriptionHtml` von Produkten.
3. Für jede Quelle: Match jeder Ziel-Anchor (Titel + Synonyme + Keyword) gegen den Fließtext.
   - **Skip**, wenn die Quelle bereits einen `<a href>` zum Ziel enthält (oder das Ziel = die Quelle selbst).
   - **Skip**, wenn > 3 Vorschläge für dieselbe Quelle rausfallen (sonst wirkt es spammy).
4. Confidence = Funktion aus: Anchor-Match-Qualität (exakt > Synonym > partial), Position (Body > Header > Fuß), Zielrelevanz (primary Keyword > secondary).
5. Ergebnis: `SeoInternalLinkSuggestion` mit `status='pending'`.

### 4.2 UI

Karte auf dem SEO-Dashboard: „X Verlinkungs-Vorschläge offen". Detailtabelle:
- Von (Deep-Link zum Editor) · Erwähnter Text · Nach (Deep-Link) · Confidence · Aktionen: **Akzeptieren** (setzt den Link automatisch in `descriptionHtml`/`body`, öffnet Editor mit Diff-Preview) / **Ablehnen** / **Ignorieren für 90 Tage**.
- Filter nach Quell-/Ziel-Typ.

### 4.3 Task + Kosten

- Neuer Task-Typ **`seoInternalLinks`** in `LONG_RUNNING_TASK_TYPES`.
- Synonym-Cache pro `(shop, resourceId)`: einmalig ~5 LLM-Calls pro 100 Items → billig.
- Match-Loop selbst ist reines Text-Matching, kein LLM.
- Pro-Gate.

### 4.4 Offen für spätere Ausarbeitung

- Wie genau der Link im HTML eingesetzt wird ohne bestehende Formatierung zu zerreißen (Editor-Sidebar bekommt „Link einfügen"-Preview mit Undo).
- Multi-Locale: nur innerhalb derselben Locale matchen — DE-Anchor → DE-Ziel-Handle.
- Umgang mit Metaobject-Referenzen.

---

## 5. Phase 3 — Content-Freshness-Audit

**Ziel:** GSC × `updatedAt` crossmatchen. „Diese Seite rankt Position 4–8 für ein wichtiges Keyword, wurde aber seit 18 Monaten nicht angefasst → Refresh-Kandidat."

### 5.1 Datenquelle

Keine neue — alles vorhanden:
- `updatedAt` auf `Product`/`Collection`/`Article`/`Page` (letzter Save aus ContentPilot).
- **Achtung Drift:** `updatedAt` reflektiert nur ContentPilot-Änderungen. Ein Direkt-Edit im Shopify-Admin schlägt sich nicht darin nieder, außer der Sync läuft danach. Vor der Ausarbeitung prüfen, ob wir Shopifys `updatedAt` aus dem letzten Sync-Zug spiegeln oder eine eigene Kolonne führen.
- GSC-Metriken pro Query/Page (bereits im Search-Console-Bereich vorhanden).

### 5.2 Regel

„Refresh-Kandidat" = Item mit:
- durchschnittlicher GSC-Position ≤ 20 (rankt überhaupt),
- Impressions ≥ 100 in den letzten 90 Tagen (nicht totgeburt),
- `updatedAt` älter als 180 Tage.

Zusatz-Signal (Bonus): CTR < median der Kategorie → doppelt priorisieren.

### 5.3 UI

Karte auf dem SEO-Dashboard: „N Refresh-Kandidaten". Tabelle:
- Item · GSC-Position · CTR · Impressions · zuletzt bearbeitet · Aktionen: **„Mit AI überarbeiten"** (öffnet Editor mit vor-eingefülltem Refresh-Prompt: „Aktualisiere diesen Text, behalte Struktur und Fakten, verbessere Freshness-Signale"), **Ignorieren**.

### 5.4 Kein neuer Task

Berechnung ist billig — pro Aufruf einmal die Kombination durchspielen. Cache in `SeoScoreSnapshot` mitschreiben.

### 5.5 Offen für spätere Ausarbeitung

- Woher genau das Refresh-Prompt kommt (neue Vorlage in [content-fields.config.tsx](app/config/content-fields.config.tsx)).
- Ob wir eine „Refreshed at" History führen wollen (`SeoRefreshEvent` — später).

---

## 6. Phase 4 — Sitemap-Kontrolle

**Ziel:** Merchant kann steuern, was in `sitemap.xml` erscheint (Shopify liefert automatisch, aber die Steuerung fehlt).

### 6.1 Realitätscheck (VOR der Ausarbeitung klären)

Shopify's `sitemap.xml` ist **plattformseitig generiert** und nicht direkt editierbar. Zwei Ansätze:
- **a) Regel-Layer über Shopify's Sitemap:** wir generieren einen eigenen `sitemap-contentpilot.xml`-Endpoint (via Proxy oder App-Route), der Shopifys Basis + unsere Modifikationen zusammenführt und dem Merchant eine Anleitung gibt, Google auf **unseren** Sitemap zu zeigen. → Umgeht Shopifys Limit, aber Merchant muss Search-Console anpassen.
- **b) Nur Vorschläge + Reporting:** wir zeigen dem Merchant, wie seine effektive Sitemap aussieht, welche Seiten mit `noindex` markiert werden können (via Storefront-Meta), und wo Prioritäten sinnvoll wären. Keine eigene sitemap.xml. → Weniger mächtig, aber viel einfacher und ohne Shopify-Fight.

**Empfehlung: mit b) anfangen.** a) nur, wenn nachweislicher Bedarf da ist (viele Merchants beklagen sich).

### 6.2 UI (Variante b, minimalinvasiv)

Tab „Sitemap-Übersicht" mit:
- Effektive Sitemap-URL (aus Shopify) + Anzahl Einträge.
- Empfehlungen: Kollektionen, die per `noindex` (Metafield `seo.hidden` oder Theme-Konvention) ausgeschlossen werden sollten, aber nicht sind (z. B. leere Kollektionen).
- Fehlerhinweise: Broken-Links in der Sitemap (nutzt Phase-1-Crawl-Daten).
- Optional: Regel-Editor („diese Kollektion aus Sitemap ausschließen"), der intern ein `SeoSitemapRule` schreibt und den Merchant informiert, dass er noch das entsprechende Metafield in Shopify setzen muss (oder wir setzen es via API — Feasibility prüfen).

### 6.3 Offen

- Ob Shopify das `noindex`-Metafield tatsächlich in der eigenen Sitemap respektiert (empirisch prüfen).
- Wenn nein: Variante a) planen, sonst ist das Feature Schaufenster ohne Wirkung.

---

## 7. Phase 5 — JSON-LD Advanced Validation

**Ziel:** die bestehende `validateJsonLd`-Basis zur „echten" QS-Oberfläche ausbauen.

### 7.1 Was fehlt gegenüber heute

- **Batch-Report:** heute prüft der Structured-Data-Tab _ein_ Beispiel-Item pro Typ. Ein Batch-Scan über **alle** Produkte/Artikel/Collections mit Aggregat („42 Produkte ohne Bild-Feld", „7 Artikel ohne `datePublished`") fehlt.
- **Deep-Link zu Google Rich Results Test pro Item**, nicht nur global.
- **Erweiterung von `validateJsonLd`**:
  - `Product`: `sku`/`gtin`/`mpn`-Warnung (Google will mindestens eins).
  - `Product`: `aggregateRating` ohne `reviewCount` → Warning.
  - `Article`: `image` mit Aspect-Ratio-Warnung (Google will 1:1, 4:3, 16:9).
  - `Organization`: `sameAs` fehlt → Info (Social-Profile-Links).
  - `BreadcrumbList`: emittiert das Theme? Falls ja, prüfen.

### 7.2 UI

Erweiterung der [structured-data.tsx](app/routes/app.seo.structured-data.tsx):
- Neuer Sub-Tab „Batch-Prüfung" mit „Jetzt prüfen"-Button → startet Task `seoJsonLdAudit`.
- Ergebnis: Aggregat-Tabelle (Bucket → Anzahl → betroffene Items) + Deep-Link pro Item zum Editor UND zum Google-Rich-Results-Test mit vor-ausgefüllter URL.

### 7.3 Task

- Neuer Task-Typ **`seoJsonLdAudit`** in `LONG_RUNNING_TASK_TYPES`.
- Läuft rein auf DB-Cache (kein Live-Fetch): baut per Item das JSON-LD via existierende Builder → `validateJsonLd` → aggregiert.
- Schnell (Millisekunden pro Item), Task nur wegen Runtime bei sehr großen Katalogen.

### 7.4 Offen

- Ob wir Googles Rich-Results-Test-API programmatisch anbinden (existiert, ist aber gequotad). Für Phase 5 default: **nur Deep-Link**, kein API-Call.

---

## 8. Reihenfolge, Aufwand, Abhängigkeiten (grob)

| Phase | Aufwand (grob) | Abhängigkeit                                    | Freischaltung        |
|-------|----------------|--------------------------------------------------|----------------------|
| 1 (Crawler)        | 3–4 Wochen | URL→Item-Resolver (kann mit Phase-2 aus Keywords-Plan geteilt werden) | Pro |
| 2 (Internal Links) | 2 Wochen   | Keywords-Plan Phase 1 (Multi-Keyword) für bessere Vorschläge | Pro |
| 3 (Freshness)      | 4–6 Tage   | GSC-Sync (existiert)                             | Pro (wg. GSC)        |
| 4 (Sitemap)        | 1 Woche (Variante b) / 2–3 Wochen (Variante a) | Phase 1 (für Broken-Links-Signal) | alle Pläne (b), Pro (a) |
| 5 (JSON-LD Batch)  | 1 Woche    | keine                                            | alle Pläne           |

**Kritischer Pfad:** Phase 1 zuerst (liefert Daten, die 4 + 5 mitnutzen). Phase 2 kann parallel starten. Phase 3 + 5 sind schnelle Auszahlungen.

---

## 9. Tests (Pflicht pro Phase)

- **Unit** (Vitest):
  - Crawler: URL-Deduplizierung, Robots-Respekt, Redirect-Chain-Erkennung, Timeout-Handling.
  - Broken-Link-Klassifikation (4xx vs. 5xx vs. Timeout vs. Redirect-Loop).
  - Internal-Link-Matcher: Synonym-Match, Skip-bei-vorhandenem-Link, Cap pro Quelle.
  - Freshness-Regel: Grenzfälle bei fehlenden GSC-Daten.
  - JSON-LD-Erweiterungen: neue Warning-Codes durchdeklinieren.
- **Integration:**
  - Crawler-Task end-to-end gegen einen fixture-Server (`nock` o. ä.).
  - Findings-Integration: neue Codes erscheinen im Dashboard-Score.
- **GDPR-Guard:** alle neuen Modelle in `SHOP_SCOPED_MODELS` — sonst schlägt der Drift-Guard-Test fehl.

---

## 10. Nicht-Ziele (explizit)

- **Kein Backlink-/Referring-Domains-Feature.** Datenmoat, gehört zu Ahrefs/Semrush.
- **Kein Kompetitor-Ranking-Tracking.** SERP-Scraping = rechtliche Grauzone + teuer.
- **Keine Log-File-Analyse.** Enterprise-SEO-Nische, außerhalb Shopify-Reichweite.
- **Kein eigenes SERP-Feature-Monitoring** (Featured Snippets, PAA, Image Pack). Skip.
- **Keine Auto-Anwendung der Internal-Link-Vorschläge.** Preview + Merchant-Confirm ist Pflicht.
- **Keine JavaScript-Rendering im Crawler** (kein Puppeteer). Shopify-Themes rendern serverseitig genug HTML für alle SEO-relevanten Signale. Wenn ein Merchant Client-only-Content baut, sagen wir das explizit.

---

## 11. Offene Fragen (vor Ausarbeitung klären)

1. **Crawler-Hosting:** läuft der Crawl im Railway-Node-Prozess (blockiert eventuell den Web-Server-Loop bei 2000 Requests) oder wollen wir einen separaten Worker? Wenn ja: welcher (BullMQ? Eigene Queue via DB-Poll)?
2. **Rate-Limits vom Shop selbst:** Shopify hat kein hartes Rate-Limit auf Storefront-Requests, aber Shops mit Bot-Firewalls (Cloudflare bei Enterprise) können unseren Crawler blocken. Detection + graceful message.
3. **Sitemap Variante a vs. b** — vor Phase 4 empirisch prüfen, ob Shopifys Sitemap-Steuerung via Metafield ausreicht.
4. **URL→Item-Resolver Sharing:** derselbe Helper wird in Keywords-Plan Phase 2 und hier gebraucht — vor Umsetzung als gemeinsame Utility in `app/services/seo/url-resolver.ts` ziehen.
5. **`updatedAt`-Semantik für Freshness:** ContentPilot-`updatedAt` vs. Shopify-`updatedAt` — welche gilt? Kann Direkt-Edit in Shopify unseren Freshness-Score unterlaufen?
6. **Internal-Link-Anwendung ohne HTML-Zerstörung:** wollen wir einen einfachen Anchor-Insert (regex-basiert, Risiko: kann Formatierung zerreißen) oder einen HTML-parser-basierten Insert (sauberer, mehr Aufwand)?
7. **Duplicate-Content-Erkennung:** gehört sie zu Phase 1 (Crawl-Titel-Vergleich) oder als eigene Phase 6? Vorschlag: klein genug für Phase 1.
8. **Metaobjects im Crawler:** ihre URLs sind theme-abhängig — überhaupt crawlbar? Falls nein: nur DB-Signale nutzen, im UI kennzeichnen.

---

## 12. Notiz zum Zusammenhang mit dem Positionierungs-Satz

Nach diesem Plan ist der Satz in [PLAN_KEYWORDS_EXPANSION.md §10](./PLAN_KEYWORDS_EXPANSION.md#10-nicht-ziele-explizit) zu präzisieren:

- Alt: *„Kein Ahrefs-Klon. Wer Backlink-Analyse braucht, nutzt Ahrefs — ContentPilot ist ein Content-Werkzeug, kein SEO-Suite-Ersatz."*
- Neu (Vorschlag): *„Kein Backlink- oder Kompetitor-SERP-Tool. Wer die Off-Site-Datenmoat-Analysen von Ahrefs/Semrush braucht, greift zu denen. Für On-Site-SEO (Audit, Crawl, Internal Linking, Schema, Sitemap, Freshness) deckt ContentPilot den vollen Umfang ab."*
