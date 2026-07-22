# SEO-Suite-Vervollständigung — Plan (Phasen 1–5)

**Status:** Entwurf / ausgearbeitet, Umsetzung nicht begonnen
**Baut auf:** vorhandene SEO-Oberfläche (Dashboard, Bulk-Meta, GSC, Structured Data, Redirects, Hreflang, IndexNow, AEO, Performance) unter [app/routes/app.seo*.tsx](../../app/routes/) + dem ausgelieferten Keyword-System ([KEYWORDS_CONTRACT.md](../architecture/KEYWORDS_CONTRACT.md)). Section-Contract: [SEO_SECTION_CONTRACT.md](../architecture/SEO_SECTION_CONTRACT.md) — **jede Phase erfüllt alle acht Vertragspunkte**, das wird hier nicht pro Phase wiederholt.
**Ziel dieses Plans:** die Lücken schließen, die ContentPilot vom „SEO-Werkzeug für Content" zur echten SEO-Suite heben — ohne Backlink-/Kompetitor-Datenmoats anzugehen.

---

## 0. Ist-Zustand (verifiziert gegen den Code, 2026-07)

Damit wir keine Doppelarbeit planen — Bestandsaufnahme der SEO-Oberfläche:

- **Store-weiter Audit + Score:** [audit.service.ts](../../app/services/seo/audit.service.ts) → `analyzeStore` liest den DB-Content-Cache (Product/Collection/Article/Page + Alt-Coverage via `groupBy`, Cap 1000/Typ), `computeSeoScore` scored pro Item, Snapshot in `SeoScoreSnapshot`. Rendering im [Dashboard](../../app/routes/app.seo._index.tsx) mit „Fix with AI"-Bulk (Task `seoBulkFix`) und Rescan (Task `seoAudit`).
  **Wichtig für Phase 1:** Der Dashboard-Score aggregiert heute **ausschließlich** `analyzeStore`-Buckets (`AuditProblemBucket`, Codes unter `t.seo.dashboard.problems.*`, Mapping `FINDING_TO_BUCKET`) — es gibt KEINE generische „jede Section liefert `SeoFinding[]` ans Dashboard"-Pipeline im Code. Neue Crawl-Findings müssen als zusätzliche Buckets in `analyzeStore` integriert werden (§3.6), nicht über einen imaginären Findings-Bus.
- **Bulk-Meta:** [app.seo.bulk-meta.tsx](../../app/routes/app.seo.bulk-meta.tsx) + Task `seoBulkMeta`.
- **Redirects + 404-Tracking:** [app.seo.redirects.tsx](../../app/routes/app.seo.redirects.tsx) + CSV-Import ([redirects-csv.ts](../../app/services/seo/redirects-csv.ts)). Der CSV-Import ist eine **synchrone Action** (`actionType=importCsv`), kein Task. Live-404s werden bereits in `Seo404Hit` gesammelt (Storefront-seitig via Extension) — Phase 1 ergänzt das um *proaktiv* gefundene Broken Links.
- **Hreflang-Coverage:** [app.seo.hreflang.tsx](../../app/routes/app.seo.hreflang.tsx).
- **Structured Data (JSON-LD):** [app.seo.structured-data.tsx](../../app/routes/app.seo.structured-data.tsx) + [structured-data.service.ts](../../app/services/structured-data.service.ts). `validateJsonLd` deckt bereits 17 Warning-Codes ab (`JsonLdWarningCode`), u. a. `productNoGtinMpn`, `ratingNoReviewCount`, `articleNoDatePublished`, `articleNoImage`, `productNoImage`, `orgNoLogo`. Emission auf dem Storefront durch [extensions/storefront/blocks/structured-data.liquid](../../extensions/storefront/blocks/structured-data.liquid) — **NICHT** eine eigene Extension (nur EINE Theme-App-Extension erlaubt, siehe CLAUDE.md-Gotcha); Breadcrumb-JSON-LD wird dort via `buildBreadcrumbJsonLd` bereits emittiert.
- **Search Console:** [app.seo.search-console.tsx](../../app/routes/app.seo.search-console.tsx) + [google-search-console.server.ts](../../app/services/google-search-console.server.ts). Sync ist eine **synchrone Action** (`actionType=sync`) plus täglicher Auto-Sync ([gsc-auto-sync.service.ts](../../app/services/seo/gsc-auto-sync.service.ts)); GSC-Metriken werden **pro Keyword-Assignment** persistiert (`SeoKeywordAssignment.gsc*` + Historie `SeoKeywordSnapshot`). Ein persistenter **per-Page**-Rollup existiert NICHT (relevant für Phase 3). URL→Item-Auflösung existiert bereits: `resolveGscPagePath` ([google-search-console.server.ts:536](../../app/services/google-search-console.server.ts#L536)) + `resolveQuickWinResources` (batched Handle-Lookup, [app.seo.search-console.tsx:112](../../app/routes/app.seo.search-console.tsx#L112)).
- **AEO / robots.txt AI-Crawler-Audit / llms.txt:** [app.seo.aeo.tsx](../../app/routes/app.seo.aeo.tsx) + [aeo.service.ts](../../app/services/seo/aeo.service.ts). Enthält einen funktionierenden robots.txt-Parser (`parseRobots`, aktuell **modulintern**, `auditRobotsTxt` ist exportiert) — Phase 1 extrahiert ihn wiederverwendbar.
- **IndexNow:** [app.seo.index-now.tsx](../../app/routes/app.seo.index-now.tsx) — Config + URL-Queue (`SeoIndexNowConfig` / `SeoIndexNowQueue`), Submission direkt aus dem Service, kein eigener Task-Typ.
- **Core Web Vitals / Performance:** [app.seo.performance.tsx](../../app/routes/app.seo.performance.tsx) (PageSpeed + Web-Vitals-Samples).
- **Keywords:** Das Datenmodell aus [KEYWORDS_CONTRACT.md](../architecture/KEYWORDS_CONTRACT.md) (`SeoKeyword` / `SeoKeywordAssignment` / `SeoKeywordGroup` / `SeoKeywordGroupMembership` / `SeoKeywordSnapshot`) ist ausgeliefert — Multi-Keyword pro Item mit `primary`/`secondary`-Rollen und GSC-Enrichment pro Assignment steht zur Verfügung (Phase-2-Anker für Internal Links).

**Vorhandene Task-Typen** in `LONG_RUNNING_TASK_TYPES` ([task-recovery.service.js:34](../../task-recovery.service.js#L34)): `seoBulkFix`, `seoAudit`, `seoBulkMeta` (+ Nicht-SEO-Typen). Dieser Plan fügt drei hinzu: `seoCrawl`, `seoInternalLinks`, `seoJsonLdAudit`.

**Was fehlt, um mit Yoast/RankMath (und dem „kleinen Semrush") auf Augenhöhe zu sein:**

1. Kein **Live-Storefront-Crawler** — der Audit ist rein DB-basiert. Broken Links, echte Response-Codes, Rendered-Head vs. DB-Drift, Orphan-Erkennung via Link-Graph → alles blind. (`Seo404Hit` sieht nur 404s, die echte Besucher bereits getroffen haben.)
2. Keine **Internal-Linking-Vorschläge** — trotz vollständigem Content-Wissen der App kein „diese Seite könnte auf X linken".
3. Kein **Content-Freshness-Audit** — GSC-Daten und `shopifyUpdatedAt` liegen vor, aber kein Crossmatch „rankt gut, aber seit 18 Monaten nicht angefasst → Refresh".
4. Keine **Sitemap-/Indexierungs-Kontrolle** — Shopify generiert automatisch; der dokumentierte Hebel (`seo.hidden`-Metafield) ist für Merchants unsichtbar.
5. Kein **Batch-Schema-Report** — `validateJsonLd` prüft im Structured-Data-Tab nur ein Beispiel-Item pro Typ; kein Katalog-weiter Report „42 Produkte ohne GTIN/MPN".

Diese fünf Lücken sind der Scope dieses Plans.

---

## 1. Zielbild

ContentPilot bleibt **content-first**, erweitert seine SEO-Oberfläche aber um die technischen Prüfungen, die eine echte SEO-Suite ausmachen — mit klarer Abgrenzung nach oben:

- **Wir liefern:** technische On-Site-SEO (Crawl-Audit, interne Verlinkung, Freshness, Sitemap-/Indexierungs-Steuerung, Schema-QS) + Content-SEO (bereits vorhanden).
- **Wir liefern nicht:** Backlink-Analyse, Kompetitor-Ranking-Tracking, SERP-Feature-Scraping, Log-File-Analyse. Das sind **Datenmoat-Themen** (Ahrefs/Semrush/Botify) — ohne teure Fremd-Datenbanken bleiben sie halbgar.

Positionierungssatz: *„ContentPilot ist die SEO-Suite für Shopify-Merchants, die keine externe Ahrefs-Lizenz haben — und für die meisten reicht das."*

**Neue Dependencies (entschieden 2026-07):**
- **HTML-Parser: `cheerio`** als Runtime-Dependency (MIT, kostenlos) — **beschlossen**. Gebraucht von Phase 1 (Head/Link-Extraktion) UND Phase 2 (formatierungssichere Link-Insertion). Im Repo existiert kein Parser (nur `isomorphic-dompurify` zum Sanitizen; `happy-dom`/`jsdom` sind dev-only). Eine Dependency, zwei Phasen.
- **Concurrency-Limiter:** `p-limit` ist NICHT im Repo. Für 5 parallele Fetches reicht eine ~15-Zeilen-Semaphore als Utility (`app/utils/semaphore.ts`) — keine Dependency nötig.
- **Test-HTTP-Mocking:** `nock` ist NICHT im Repo, **`msw` ist bereits devDependency** — Crawler-Integrationstests nutzen msw.

---

## 2. Datenmodell

Alle Modelle shop-scoped. **GDPR-Pflicht (Kein `SHOP_SCOPED_MODELS`-Konstrukt!):** Es gibt KEINE Code-Konstante — die „Liste" ist der Kommentarblock über `redactShopData` in [gdpr.service.ts](../../app/services/gdpr.service.ts); der Drift-Guard ([tests/unit/gdpr.service.test.ts](../../tests/unit/gdpr.service.test.ts)) parst `schema.prisma` und prüft auf das `shop`-Feld. Für **jedes** neue Modell: `deleteMany({ where: { shop } })` in `redactShopData` + Kommentarblock ergänzen — Cascades reichen dem Guard nicht, deshalb trägt auch jedes Child-Modell eine eigene `shop`-Spalte.

```prisma
// ── Phase 1 (Crawler) ────────────────────────────────────────────────────────

model SeoCrawlSnapshot {
  id              String    @id @default(cuid())
  shop            String
  startedAt       DateTime  @default(now())
  finishedAt      DateTime?
  status          String    // "running" | "completed" | "failed" | "capped"
  error           String?   // Kurzbegründung bei "failed" (z. B. "storefront_password", "bot_blocked")
  pagesCrawled    Int       @default(0)
  totalDiscovered Int       @default(0) // gefundene URLs, auch jenseits des Caps
  pagesOk         Int       @default(0)
  pagesBroken     Int       @default(0)
  orphanCount     Int       @default(0)
  headDriftCount  Int       @default(0)

  pages       SeoCrawlPage[]
  brokenLinks SeoCrawlBrokenLink[]

  @@index([shop, startedAt])
}

model SeoCrawlPage {
  id            String  @id @default(cuid())
  shop          String
  snapshotId    String
  url           String  // normalisierte URL (Query-Params gestrippt, §3.2)
  statusCode    Int
  redirectedTo  String? // finale URL, wenn 3xx gefolgt wurde
  responseMs    Int
  title         String? // <title> aus dem gerenderten HTML
  metaDesc      String?
  canonical     String?
  h1Count       Int     @default(0)
  wordCount     Int     @default(0)
  resourceType  String? // "product" | "collection" | "article" | "page" | "unknown"
  resourceId    String? // Shopify GID, wenn auflösbar (Editor-Deep-Link)
  locale        String  @default("") // aus URL-Prefix (/fr/...) — "" = primär
  inboundCount  Int     @default(0)  // interne Links, die HIER hinzeigen
  outboundCount Int     @default(0)

  snapshot SeoCrawlSnapshot @relation(fields: [snapshotId], references: [id], onDelete: Cascade)

  @@unique([snapshotId, url])
  @@index([shop, snapshotId])
  @@index([shop, snapshotId, statusCode])
}

model SeoCrawlBrokenLink {
  id         String  @id @default(cuid())
  shop       String
  snapshotId String
  fromUrl    String
  toUrl      String
  statusCode Int     // 404/410/5xx; 0 = Timeout, -1 = Redirect-Kette > 3 Hops / Loop
  anchor     String?

  snapshot SeoCrawlSnapshot @relation(fields: [snapshotId], references: [id], onDelete: Cascade)

  @@index([shop, snapshotId])
}

// ── Phase 2 (Interne Verlinkung) ─────────────────────────────────────────────

model SeoInternalLinkSuggestion {
  id               String    @id @default(cuid())
  shop             String
  locale           String    @default("") // Anchor + Ziel immer gleiche Locale
  fromResourceType String
  fromResourceId   String
  anchorText       String    // gefundene Erwähnung im Quell-Content
  toResourceType   String
  toResourceId     String
  confidence       Float
  status           String    // "pending" | "accepted" | "dismissed"
  dismissedUntil   DateTime? // „Ignorieren für 90 Tage"
  createdAt        DateTime  @default(now())
  updatedAt        DateTime  @updatedAt

  // Idempotenz über Läufe: pro (Quelle, Ziel, Locale) genau EIN Vorschlag —
  // Wiederholungs-Läufe machen upsert und reaktivieren nichts, was der
  // Merchant dismissed hat (solange dismissedUntil in der Zukunft liegt).
  @@unique([shop, fromResourceType, fromResourceId, toResourceType, toResourceId, locale])
  @@index([shop, status])
}

// ── Phase 3 (Freshness) — Option b, siehe §5.1 ──────────────────────────────

model SeoGscPageStat {
  id           String   @id @default(cuid())
  shop         String
  page         String   // volle GSC-Page-URL
  resourceType String?  // via resolveGscPagePath aufgelöst (null wenn nicht)
  resourceId   String?
  position     Float
  clicks       Int
  impressions  Int
  ctr          Float
  windowDays   Int      @default(90)
  syncedAt     DateTime @default(now())

  @@unique([shop, page])
  @@index([shop, resourceType, resourceId])
}

// ── Phase 4 (Sitemap/Indexierung) ────────────────────────────────────────────

model SeoSitemapExclusion {
  id           String    @id @default(cuid())
  shop         String
  resourceType String    // "product" | "collection" | "page" | "article" | "blog"
  resourceId   String    // Shopify GID
  reason       String?   // "emptyCollection" | "thinContent" | "manual" | …
  // Lifecycle: "suggested" (von uns vorgeschlagen) | "applied" (seo.hidden
  // via API gesetzt UND von Shopify bestätigt) | "reverted"
  status       String    @default("suggested")
  appliedAt    DateTime?
  createdAt    DateTime  @default(now())

  @@unique([shop, resourceType, resourceId])
  @@index([shop, status])
}
```

**Bewusst KEIN Modell für:**
- **Phase 5 (JSON-LD-Batch):** Aggregat lebt im `Task.result` des `seoJsonLdAudit`-Laufs (gleiche Mechanik wie `seoAudit` → `SeoScoreSnapshot` wäre Overkill, der Report ist ephemer und in Minuten reproduzierbar).
- **Link-Graph:** Kanten des Crawls werden NICHT persistiert (2000 Seiten × ~100 Links = 200k Rows/Crawl). `inboundCount`/`outboundCount` werden während des Crawls in-memory aggregiert; nur kaputte Kanten landen als `SeoCrawlBrokenLink` in der DB.
- **Sitemap-Prioritäten/Change-Frequency:** gestrichen — Google ignoriert `priority` und `changefreq` dokumentiert seit Jahren. Ein Regel-Editor dafür wäre Schaufenster ohne Wirkung (§6).

**Retention:** Beim Start eines neuen Crawls alte Snapshots des Shops bis auf die letzten **5** löschen (Cascade räumt Pages + BrokenLinks mit). Analog braucht `SeoGscPageStat` kein History-Konzept — der Unique-Key `(shop, page)` überschreibt beim Sync.

---

## 3. Phase 1 — Storefront-Crawler / echtes Site-Audit

**Das Herzstück dieses Plans.** Ohne Live-Crawl bleiben alle Aussagen zu Broken Links, Orphans und Head-Drift Vermutungen.

### 3.1 Was der Crawler tut

Startet von `https://<primary-domain>/` **und** `/sitemap.xml` (beide als Seeds — die Sitemap liefert sofort die vollständige URL-Liste für die Orphan-Baseline, der Root-Crawl liefert den Link-Graphen), folgt internen Links (Same-Origin auf die Primary-Domain, inkl. `<myshop>.myshopify.com` → Primary-Domain-Normalisierung) per **BFS** bis Tiefe 5, respektiert `robots.txt`.

Pro besuchter Seite:
- **Ein `GET`** mit `Accept: text/html` (kein HEAD+GET-Doppel: HEAD ist auf CDNs unzuverlässig und verdoppelt die Request-Zahl). Redirects manuell folgen (max 3 Hops, Kette dokumentieren), Response-Body bei > 2 MB abbrechen (Stream-Cap), Nicht-HTML-Content-Types nach den Headers verwerfen.
- HTML mit cheerio parsen: `<title>`, `meta[name=description]`, `link[rel=canonical]`, `<h1>`-Count, grober Wortzähler (Text der `<main>`/`<body>` ohne nav/footer), alle same-origin `<a href>` einsammeln.
- Response-Zeit (TTFB-nah: bis Header-Empfang) tracken.
- **Resource-Auflösung:** URL-Pfad → `resourceType`/`resourceId` über die **bestehende** Logik `resolveGscPagePath` + batched Handle-Lookup (heute in [app.seo.search-console.tsx:112](../../app/routes/app.seo.search-console.tsx#L112)). VOR Phase 1 wird beides als gemeinsame Utility nach `app/services/seo/url-resolver.server.ts` extrahiert (Deliverable, kein Neubau). Locale-Prefix (`/fr/...`) wird dabei erkannt und auf `SeoCrawlPage.locale` gestellt.

Nach dem Crawl:
- **Broken Links:** alle Kanten `from→to` mit `to.statusCode >= 400`, Timeout oder Redirect-Loop → `SeoCrawlBrokenLink`.
- **Orphans:** Items aus dem DB-Cache, deren URL im Crawl `inboundCount == 0` hat (Links von sich selbst zählen nicht). **Nur gültig, wenn der Crawl NICHT gecapped wurde** — bei `status="capped"` wird die Orphan-Kachel ausgegraut mit Hinweis („Crawl unvollständig — Orphan-Analyse nicht verlässlich"). Sonst produziert jeder große Shop Phantom-Waisen.
- **Head-Drift:** `SeoCrawlPage.title` vs. DB-`seoTitle` (Fallback `title`). **Normalisiert vergleichen:** Themes hängen fast immer ein `– ShopName`-Suffix an — der Vergleich strippt das Shop-Name-Suffix und whitespace-normalisiert, sonst ist jede Seite ein False Positive. Drift-Findings nur für Seiten mit aufgelöster `resourceId` und `locale == ""` (Fremdsprachen-Titel gegen `ContentTranslation` zu prüfen ist Phase-1-Scope-Creep — als Erweiterung notiert, §3.8).
- **Duplicate Titles:** gleicher normalisierter `<title>` auf ≥ 2 URLs → Finding (billige `groupBy`-Auswertung auf `SeoCrawlPage`, gehört in Phase 1).

### 3.2 URL-Normalisierung (Crawl-Explosions-Schutz)

Shopify-Storefronts erzeugen unendliche URL-Räume (Facetten-Filter, `?variant=`, `?sort_by=`, Vendor-Collections). Regeln:
- Query-String wird **komplett gestrippt** — mit einer Whitelist-Ausnahme: `page` (Pagination) bis max `page=5` pro Basis-URL.
- Fragmente (`#…`) strippen, Trailing-Slash normalisieren, Lowercase-Host.
- Dedupe über die normalisierte URL (`@@unique([snapshotId, url])` ist zugleich der DB-Guard).
- `/cart`, `/checkout`, `/account`, `/challenge`, `/password`, `/cdn/`, `/apps/` werden nie gecrawlt (Hardcoded-Denylist zusätzlich zu robots.txt).

### 3.3 Rate + Robustheit

- Eigene Semaphore (§1) auf **5 parallele Requests**, ~200 ms Mindestabstand pro Slot — der eigene Shop darf unter dem Crawl nicht wackeln.
- Timeout 10 s pro Request; **kein Retry bei 4xx**, 1 Retry mit Backoff bei 5xx/Timeout (3 Retries × 2000 Seiten wäre im Worst Case eine Stunde nur Retries).
- User-Agent: `ContentPilotSEO/1.0 (+<APP_URL>/bot)` — Bot-Info-Seite als statische Route bereitstellen.
- robots.txt: `parseRobots` aus [aeo.service.ts](../../app/services/seo/aeo.service.ts) exportieren/extrahieren (existiert, ist nur modulintern) und gegen unsere UA-Gruppe bzw. `*` matchen.
- **Passwortgeschützte Shops erkennen:** Redirect auf `/password` beim Seed → Crawl sofort mit `status="failed"`, `error="storefront_password"` beenden und im UI erklären (betrifft jeden Dev-Store!).
- **Bot-Firewalls erkennen:** ≥ 3 aufeinanderfolgende 403/429/„Checking your browser"-Antworten → Abbruch mit `error="bot_blocked"` + freundlicher UI-Text (Cloudflare-Enterprise-Shops).
- Hard-Cap: default **2000 Seiten/Crawl** (Env-übersteuerbar, bis 10 000 denkbar), BFS sorgt dafür, dass beim Cap die flachen/wichtigen Seiten dabei sind. `totalDiscovered` vs. `pagesCrawled` im UI ausweisen, `status="capped"` setzen (Konsequenz für Orphans: §3.1).

### 3.4 UI

Neue Section in [seo-sections.ts](../../app/config/seo-sections.ts): `{ id: "crawl", path: "/app/seo/crawl", kind: "audit", planGate: "pro" }` → Route `app.seo.crawl.tsx` (Naming bewusst NICHT „audit" — das ist das Dashboard):

- Header: „Letzter Crawl vor X Tagen" + „Jetzt scannen" + Progress (Task-Polling wie beim `seoAudit`-Rescan).
- Kacheln: Seiten gesamt · OK · Broken Links · Waisen · Head-Drift · Duplicate Titles.
- Sub-Tabs:
  - **Broken Links:** `from` · `to` · Status · Anchor — Deep-Link zum Editor der Quell-Seite (`?select=<GID>`), Aktion „Redirect anlegen" (prefilled Deep-Link auf den Redirects-Tab; dort existiert `createRedirect` bereits).
  - **Waisen:** Items ohne interne Inbound-Links — Deep-Link zum Editor + „Verlinkungs-Vorschlag holen" (Deep-Link zu Phase 2).
  - **Head-Drift:** beide Werte nebeneinander + Deep-Link (meist Theme-/Caching-Bugs).
  - **Langsamste Seiten:** Top 20 nach `responseMs` (Hinweis: Serverzeit, kein CWV-Ersatz — Cross-Link auf Performance-Tab).
  - **Duplicate Titles:** Gruppen gleicher Titel.

### 3.5 Task-Integration

- Neuer Task-Typ **`seoCrawl`** in `LONG_RUNNING_TASK_TYPES` ([task-recovery.service.js:34](../../task-recovery.service.js#L34)) — Begründungskommentar wie bei den Bestands-Einträgen.
- Detached Runner nach Contract-§8-Muster (`void runCrawl(taskId,…)`), Heartbeat: `Task.progress` alle 25 Seiten.
- Single-flight pro Shop (Check auf laufenden `seoCrawl` vor `create`, wie [seo-audit.handler.ts:38](../../app/routes/api-ai-handlers/seo-audit.handler.ts#L38)).
- Kein Worker-Prozess nötig: der Crawl ist reines IO (fetch + parse), blockiert den Node-Loop nicht nennenswert — gleiche Architektur wie alle anderen detached Tasks auf Railway. Erst wenn Telemetrie etwas anderes zeigt, über Auslagerung nachdenken (Nicht-Ziel, §10).
- i18n: `t.tasks.taskType.seoCrawl` (de → en → es).

### 3.6 Findings-Integration ins Dashboard (konkret)

`analyzeStore` bekommt einen billigen Zusatzschritt: letzten `SeoCrawlSnapshot` mit `status IN ("completed","capped")` lesen und daraus **drei neue `AuditProblemBucket`s** bauen — `brokenLinks`, `orphanPages`, `headDrift` (Codes unter `t.seo.dashboard.problems.*`, Item-Refs auf `MAX_PROBLEM_BUCKET_ITEMS` gecapped wie alle Buckets). **Wichtig:**
- Diese Buckets haben **keinen „Fix with AI"-Pfad** — die Dashboard-UI braucht eine Bucket-Eigenschaft `action: "fixWithAi" | "deepLink"`, damit die drei neuen Buckets stattdessen auf den Crawl-Tab verlinken. (Kleiner UI-Umbau, im Aufwand von Phase 1 enthalten.)
- Kein Doppel-Scoring: Findings, die der DB-Audit schon sieht (leerer seoTitle etc.), bleiben dort; der Crawler liefert nur die Codes, die DB-only nicht sehen kann.
- Fehlt ein Snapshot (noch nie gecrawlt / Free-Plan), erscheinen die Buckets schlicht nicht — kein Sonderfall im Score.

### 3.7 Pro-Gate

`planGate: "pro"` im Descriptor (Plan-Stufen sind `free | basic | pro | max`, [plans.ts](../../app/config/plans.ts)). Free/Basic sehen den Tab mit Upgrade-CTA (`SeoSectionLayout` + `usePlan()` liefern das Muster) und einem statischen Read-only-Beispiel-Snapshot.

### 3.8 Bewusst NICHT in Phase 1 (notierte Erweiterungen)

- Head-Drift für Fremdsprachen-Locales (Vergleich gegen `ContentTranslation`).
- Redirect-Chain-Warnung als eigener Finding-Code (> 2 Hops) — Daten fallen ab Tag 1 an (`redirectedTo`), UI-Code später.
- Scheduled Crawls (wöchentlich automatisch) — erst wenn On-Demand sich bewährt.
- Metaobject-Seiten: URLs sind theme-abhängig; werden gecrawlt wie jede URL, aber nicht auf Ressourcen aufgelöst (`resourceType="unknown"`).

---

## 4. Phase 2 — Interne Verlinkungs-Vorschläge

**Ziel:** „12 Erwähnungen von *Keramikvase* in Blog-Artikeln könnten auf Produkt X linken." Reine Content-Analyse auf DB-Basis, kein Live-Fetch nötig — deshalb unabhängig von Phase 1 startbar.

### 4.1 Algorithmus

Auf Merchant-Trigger (Button; wöchentliche Automatik später):

1. **Zielmenge:** alle Produkte/Collections mit Handle + zugewiesenen Keywords (aus `SeoKeywordAssignment`, primary + secondaries — **existiert bereits im Schema**) + Titel + AI-Synonymen (ein kleiner LLM-Call pro Item, gecached in einer JSON-Spalte oder ephemer im Task — Entscheidung §11.3).
2. **Quellenmenge:** HTML-Bodies aller Blog-Artikel + Pages + `descriptionHtml` von Produkten (DB-Cache).
3. **Match** jeder Ziel-Anchor (Titel > primary Keyword > secondary > Synonym) gegen den Fließtext der Quelle — nur Text-Knoten, nicht innerhalb bestehender `<a>`, nicht in Headings (cheerio-Traversal statt Regex).
   - **Skip:** Quelle linkt bereits aufs Ziel; Ziel == Quelle; Ziel-Status draft/archived.
   - **Cap:** max 3 Vorschläge pro Quelle (sonst wirkt es spammy), max 200 offene `pending` pro Shop.
   - **Locale-Regel:** nur innerhalb derselben Locale matchen (DE-Anchor → DE-Ziel); Quellen-Locale = primär, Fremdsprachen-Matching ist Phase-2-Nicht-Ziel.
4. **Confidence** = Funktion aus Match-Qualität (exakt > Keyword > Synonym > partial), Position im Text, Ziel-Rolle (primary Keyword > secondary).
5. **Ergebnis:** Upsert in `SeoInternalLinkSuggestion` (Unique-Key macht Läufe idempotent; `dismissed`-Zeilen mit zukünftigem `dismissedUntil` werden nie reaktiviert).

### 4.2 UI

Eigene Section `{ id: "internalLinks", path: "/app/seo/internal-links", kind: "tool", planGate: "pro" }` + Karte auf dem Dashboard („X Verlinkungs-Vorschläge offen") als Einstieg. Tabelle:
- Von (Deep-Link Editor) · Erwähnter Text · Nach (Deep-Link) · Confidence · Aktionen: **Akzeptieren** / **Ablehnen** / **90 Tage ignorieren**; Filter nach Quell-/Ziel-Typ.
- **Akzeptieren** setzt den Link cheerio-basiert in `descriptionHtml`/`body` (erster Match im Text-Knoten wird zu `<a href="/products/<handle>">`), zeigt **Vorher/Nachher-Diff im Modal** und speichert erst nach Bestätigung über den bestehenden Save-Pfad (`handleUnifiedContentActions`-Route — KEIN paralleler Save-Handler, Architektur-Invariante). Kein Regex-Insert: HTML-Zerstörungsrisiko.

### 4.3 Task + Kosten

- Neuer Task-Typ **`seoInternalLinks`** in `LONG_RUNNING_TASK_TYPES`; Single-flight; Heartbeat pro 20 Quellen.
- Synonym-Calls über `AIQueueService.enqueue()` (Contract §8) — grob 1 Call pro Ziel-Item, einmalig, danach gecached; Match-Loop selbst ist LLM-frei.
- Pro-Gate.

### 4.4 Offen für die Umsetzung

- Synonym-Cache-Ort (§11.3).
- Umgang mit Metaobject-Referenzen in Bodies (v1: ignorieren).

---

## 5. Phase 3 — Content-Freshness-Audit

**Ziel:** GSC × Änderungsdatum crossmatchen: „Diese Seite rankt Position 4–8, wurde aber seit 18 Monaten nicht angefasst → Refresh-Kandidat."

### 5.1 Datenquelle (Korrektur gegenüber der Skizze)

- **Änderungsdatum: gelöst.** `shopifyUpdatedAt` existiert bereits auf `Product`/`Collection`/`Article`/`Page` (+ `lastSyncedAt`) — das ist Shopifys eigenes `updated_at` vom letzten Sync und fängt auch Direkt-Edits im Shopify-Admin ab (Staleness = Sync-Frequenz, für 180-Tage-Schwellen irrelevant). **Kein** eigenes Datum nötig, ContentPilot-`updatedAt` wird ignoriert.
- **GSC pro Seite: NICHT vorhanden.** Ein Modell `GscQueryPage` existiert nicht; GSC-Werte hängen heute an `SeoKeywordAssignment` (nur getrackte Keywords). Zwei Optionen:
  - **a) Nur getrackte Items:** Freshness nutzt die vorhandenen `gscPosition/gscImpressions` der Assignments. Null Neubau, aber blind für alles ohne getracktes Keyword.
  - **b) Per-Page-Rollup (Empfehlung):** der bestehende tägliche GSC-Auto-Sync ([gsc-auto-sync.service.ts](../../app/services/seo/gsc-auto-sync.service.ts)) holt zusätzlich EINE `dimensions:["page"]`-Query (90 Tage, rowLimit 1000) und upsertet `SeoGscPageStat` (§2) — Auflösung auf `resourceType/resourceId` via `resolveGscPagePath`. Ein API-Call mehr pro Tag, danach ist Freshness DB-first (Contract §3/§6) und deckt den ganzen Katalog.

  **Empfehlung: b.** Aufwand ist klein (der Sync + Resolver existieren), und nur b macht das Feature katalogweit ehrlich.

### 5.2 Regel

„Refresh-Kandidat" = Item mit:
- Ø GSC-Position ≤ 20 (rankt überhaupt),
- Impressions ≥ 100 in 90 Tagen (keine Totgeburt),
- `shopifyUpdatedAt` älter als 180 Tage.

Schwellen als Konstanten im Service (nicht UI-konfigurierbar in v1). Bonus-Signal: CTR unterhalb des Positions-Erwartungswerts → doppelt priorisieren (die CTR-Kurven-Logik der Quick-Wins existiert im GSC-Service bereits — wiederverwenden).

### 5.3 UI

Karte auf dem SEO-Dashboard („N Refresh-Kandidaten") + Tabelle (im Dashboard expandierbar oder als Panel im GSC-Tab — Entscheidung bei Umsetzung, KEINE eigene Section: zu wenig Fläche):
- Item · Position · CTR · Impressions · zuletzt geändert · Aktionen: **„Mit AI überarbeiten"** (Editor-Deep-Link mit Refresh-Prompt-Preset) · **Ignorieren** (persistiert als einfache Dismissed-Liste — Ort: `SeoScoreSnapshot`-Nachbarspalte oder Mini-Tabelle, bei Umsetzung entscheiden).

### 5.4 Kein neuer Task

Berechnung ist ein Join über zwei DB-Tabellen — läuft im Loader. Pro-Gate (setzt GSC voraus, GSC-Section ist bereits `planGate: "pro"`).

### 5.5 Offen für die Umsetzung

- Refresh-Prompt-Preset: als neue Vorlage in [content-fields.config.tsx](../../app/config/content-fields.config.tsx) oder als Query-Param-Preset im Editor — bei Umsetzung klären.
- „Refreshed at"-History (`SeoRefreshEvent`) — bewusst später.

---

## 6. Phase 4 — Sitemap- & Indexierungs-Kontrolle

**Ziel:** Merchant sieht, was in `sitemap.xml` steht, und kann Ausschlüsse steuern — über Shopifys **dokumentierten** Mechanismus statt gegen die Plattform.

### 6.1 Realitätscheck (präzisiert)

Shopifys `sitemap.xml` ist plattformgeneriert und nicht editierbar. Der dokumentierte Hebel: Metafield **`seo.hidden` = 1** (namespace `seo`, key `hidden`, Integer) auf Product/Page/Article/Collection/Blog → Shopify setzt `noindex` UND entfernt die Ressource aus der Sitemap. Wert löschen = wieder sichtbar. **Das können wir via `metafieldsSet`/`metafieldsDelete` aus der App setzen** — kein eigener Sitemap-Endpoint, kein Search-Console-Umbiegen nötig.

Damit schrumpft die alte Variante a (eigener `sitemap-contentpilot.xml`-Proxy) zum Nicht-Ziel (§10): sie brächte nur `priority`/`changefreq`-Steuerung — und **Google ignoriert beide Attribute dokumentiert**. Der frühere `SeoSitemapRule`-Entwurf (scope/action/actionValue) entfällt zugunsten des schlanken `SeoSitemapExclusion` (§2).

**Empirischer Pflicht-Spike vor der Umsetzung (~1 h):** auf einem Dev-Store verifizieren, dass `seo.hidden` (a) die Sitemap wirklich bereinigt, (b) mit `metafieldsSet` als App setzbar ist (Scope/Owner-Type prüfen), (c) beim Löschen sauber revertiert. Scheitert (b), degradiert die Phase zu „Vorschläge + Anleitung" — das UI bleibt gleich, nur der Apply-Button wird zur Copy-Anleitung.

### 6.2 UI

**Entschieden (2026-07): eigene Section** `{ id: "sitemap", path: "/app/seo/sitemap", kind: "tool" }` → Route `app.seo.sitemap.tsx` — Begründung: Auffindbarkeit (ein Merchant, der „Sitemap" sucht, schaut nicht in einen „AEO"-Tab) schlägt die Nav-Verdichtung; der Section-Contract macht neue Sections ohnehin billig (ein Descriptor-Eintrag + Route). `planGate` abhängig vom Spike-Ausgang (§6.1): voller Apply-Flow → `pro`; nur Vorschläge/Anleitung → `basic`. Inhalt:

- Effektive Sitemap-URL + Eintragszahl (Sitemap-Index live fetchen + parsen — dieselbe Fetch-Disziplin wie der AEO-robots-Check).
- **Empfehlungen** (`status="suggested"` in `SeoSitemapExclusion`): leere Collections, `thin content`-Pages (Wortzahl aus DB), out-of-stock-archivierte Produkte — jeweils mit Begründung.
- **Apply/Revert:** setzt/löscht das `seo.hidden`-Metafield via API und stellt `status` erst nach Shopify-Bestätigung auf `applied` (Echo prüfen — dieselbe Lehre wie bei `translationsRegister`: `userErrors` allein reicht nicht).
- **Broken-Links in der Sitemap:** Crossmatch Sitemap-URLs × letzter Crawl-Snapshot (nur wenn Phase 1 live ist; sonst Kachel ausblenden).

### 6.3 Kein Task, GDPR wie üblich

Sitemap-Fetch + Vorschlagsberechnung laufen im Loader (eine Sitemap-Index-Datei + n Sub-Sitemaps, gecached für 1 h). `SeoSitemapExclusion` in `redactShopData` + Kommentarblock.

---

## 7. Phase 5 — JSON-LD Batch-Audit

**Ziel:** die bestehende `validateJsonLd`-Basis von „ein Beispiel-Item pro Typ" zum katalogweiten QS-Report ausbauen.

### 7.1 Was WIRKLICH fehlt (Korrektur gegenüber der Skizze)

Die Skizze plante mehrere Checks, die **bereits existieren** (`productNoGtinMpn`, `ratingNoReviewCount`, `articleNoDatePublished`, `articleNoImage`, `productNoImage`, `orgNoLogo` — siehe `JsonLdWarningCode` in [structured-data.service.ts](../../app/services/structured-data.service.ts)); Breadcrumb-Emission macht unser Storefront-Block ebenfalls schon. Tatsächlich neu:

1. **Batch-Report:** `validateJsonLd` über **alle** Items laufen lassen und aggregieren („42 Produkte: `productNoGtinMpn`", „7 Artikel: `articleNoDatePublished`") — heute prüft der Tab nur ein Beispiel-Item pro Typ.
2. **Deep-Link zum Google Rich-Results-Test pro Item:** `https://search.google.com/test/rich-results?url=<encoded-storefront-url>` (URL aus Handle + Primary-Domain gebaut).
3. **Wenige neue Warning-Codes:** `orgNoSameAs` (Social-Profile fehlen, Severity info) und ggf. `articleImageAspectRatio` — Letzteres NUR, wenn Bild-Dimensionen günstig beschaffbar sind; die DB speichert keine (`ProductImage` hat nur `url`/`altText`), und ein HEAD-Probe-Sweep über alle Bilder widerspräche dem DB-first-Contract. Default: **streichen**, als Option notieren (§11.4).

### 7.2 UI

Erweiterung von [app.seo.structured-data.tsx](../../app/routes/app.seo.structured-data.tsx): Sub-Tab „Batch-Prüfung" mit „Jetzt prüfen"-Button → Task `seoJsonLdAudit`. Ergebnis (aus `Task.result`):
- Aggregat-Tabelle: Warning-Code → Anzahl → betroffene Items (gecapped, Muster `MAX_PROBLEM_BUCKET_ITEMS`).
- Pro Item: Deep-Link Editor + Deep-Link Rich-Results-Test.
- `previewMode: false` verwenden (der volle Check — die Builder bekommen im Batch dieselben Daten wie der Storefront-Block: Variant-Preise, `publishedAt`, Shop-Brand).

### 7.3 Task

- Neuer Task-Typ **`seoJsonLdAudit`** in `LONG_RUNNING_TASK_TYPES`; Single-flight; Heartbeat pro 100 Items.
- Läuft rein auf DB-Cache: pro Item JSON-LD via bestehende Builder (`buildProductJsonLd` etc.) → `validateJsonLd` → aggregieren. Millisekunden pro Item; Task nur wegen sehr großer Kataloge (gleiche Begründung wie `seoAudit`).
- Alle Pläne (kein Pro-Gate — niedrige Kosten, hoher wahrgenommener Wert, gutes Upgrade-Schaufenster für die Pro-Features).

### 7.4 Nicht in Phase 5

Googles Rich-Results-Test-API programmatisch anbinden (existiert, ist gequotet): nur Deep-Link, kein API-Call.

---

## 8. Reihenfolge, Aufwand, Abhängigkeiten

| Phase | Aufwand (grob) | Abhängigkeit | Freischaltung |
|-------|----------------|--------------|----------------|
| 1 (Crawler) | 3–4 Wochen | URL-Resolver-Extraktion (Vorarbeit, ~½ Tag); cheerio-Entscheidung | Pro |
| 2 (Internal Links) | 2 Wochen | Keyword-Assignments (im Schema vorhanden); cheerio | Pro |
| 3 (Freshness) | 4–6 Tage | GSC-Sync (existiert) + `SeoGscPageStat`-Erweiterung (§5.1 b) | Pro |
| 4 (Sitemap, eigene Section) | ~1 Woche | `seo.hidden`-Spike (§6.1, VOR Umsetzung); Sitemap×Crawl-Kachel braucht Phase 1 | `pro` bei Apply-Flow, `basic` bei Anleitung — folgt dem Spike-Ergebnis (§6.2) |
| 5 (JSON-LD Batch) | ~1 Woche | keine | alle Pläne |

**Kritischer Pfad:** Phase 1 zuerst (liefert Daten für 4, definiert das Bucket-Muster für alle). Phase 5 ist die schnellste Auszahlung und kann als Warm-up VOR Phase 1 gezogen werden (null Abhängigkeiten, etabliert das Batch-Task-Muster). Phase 2 parallel zu 1 möglich (disjunkte Services, aber gemeinsame cheerio-Einführung koordinieren).

**Empfohlene Startreihenfolge: 5 → 1 → 3 → 2 → 4.**

---

## 9. Tests (Pflicht pro Phase)

- **Unit (Vitest):**
  - URL-Normalisierung (Query-Strip, Pagination-Whitelist, Denylist-Pfade, Locale-Prefix).
  - robots-Matching gegen `parseRobots`-Gruppen (Fixtures aus den bestehenden aeo-Tests erweitern).
  - Broken-Link-Klassifikation (4xx vs. 5xx vs. Timeout=0 vs. Redirect-Loop=-1).
  - Head-Drift-Normalisierung (Shop-Name-Suffix, Whitespace, Umlaut-Entities).
  - Internal-Link-Matcher: Keyword-/Synonym-Match, Skip-bei-vorhandenem-Link, Caps, Locale-Isolation; cheerio-Insertion zerstört keine Formatierung (Fixture-HTML mit verschachtelten Tags).
  - Freshness-Regel: Grenzfälle (fehlende GSC-Zeile, frisch synctes Item, Impressions genau an der Schwelle).
  - Neue `JsonLdWarningCode`s + Aggregation.
- **Integration:**
  - Crawler-Task end-to-end gegen **msw**-gemockte Storefront-Fixtures (kleine Site mit Broken Link, Redirect-Kette, robots-Sperre, Passwort-Redirect).
  - Dashboard-Buckets: `brokenLinks`/`orphanPages`/`headDrift` erscheinen mit `action:"deepLink"` (kein Fix-with-AI-Button).
  - `seo.hidden`-Apply: Echo-Verifikation (Shopify bestätigt Metafield) vor `status="applied"`.
- **GDPR-Drift-Guard:** alle neuen Modelle mit `shop`-Spalte + `deleteMany` in `redactShopData` + Kommentarblock — sonst rot.

---

## 10. Nicht-Ziele (explizit)

- **Kein Backlink-/Referring-Domains-Feature.** Datenmoat, gehört zu Ahrefs/Semrush.
- **Kein Kompetitor-Ranking-Tracking.** SERP-Scraping = rechtliche Grauzone + teuer.
- **Keine Log-File-Analyse.** Enterprise-Nische außerhalb der Shopify-Reichweite.
- **Kein SERP-Feature-Monitoring** (Featured Snippets, PAA, Image Pack).
- **Kein eigener Sitemap-Endpoint / Proxy** (Ex-„Variante a"): brächte nur `priority`/`changefreq`, die Google ignoriert, und zwingt Merchants zum Search-Console-Umbau.
- **Keine Auto-Anwendung der Internal-Link-Vorschläge.** Diff-Preview + Merchant-Confirm ist Pflicht.
- **Kein JavaScript-Rendering im Crawler** (kein Puppeteer). Shopify-Themes rendern serverseitig genug HTML für alle SEO-Signale; Client-only-Content wird im UI als Grenze benannt.
- **Kein separater Worker-Prozess/BullMQ** für den Crawl — detached Task im bestehenden Prozess, wie alle anderen Tasks. Erst bei nachgewiesenen Problemen neu bewerten.

---

## 11. Offene Fragen (vor der jeweiligen Phase klären)

Erledigt gegenüber der Skizze: ~~Crawler-Hosting~~ (in-process, §3.5/§10) · ~~`updatedAt`-Semantik~~ (`shopifyUpdatedAt` existiert, §5.1) · ~~URL-Resolver~~ (existiert, wird extrahiert, §3.1) · ~~Insert-Methode~~ (cheerio-basiert, §4.2) · ~~Duplicate-Content~~ (in Phase 1, §3.1) · ~~Metaobjects im Crawler~~ (mitgecrawlt, nicht aufgelöst, §3.8).

**Entschieden 2026-07:**
- **cheerio** als Runtime-Dependency: **ja** (MIT, kostenlos; §1).
- **`seo.hidden`-Spike** (§6.1): **wird VOR der Phase-4-Umsetzung ausgeführt** (reiner ~1-h-Test auf einem Dev-Store, keine App-Änderung). Noch ausstehend: die Durchführung selbst; ihr Ergebnis bestimmt Apply-Flow vs. Anleitung und damit das `planGate` (§6.2).
- **Phase-4-Platzierung: eigene Section** `{ id: "sitemap" }` — Auffindbarkeit schlägt Nav-Verdichtung (§6.2).

Noch offen:

1. **Synonym-Cache-Ort für Phase 2:** eigene Spalte/JSON am Item, Mini-Tabelle, oder ephemer pro Lauf (dann pro Lauf neue LLM-Kosten)? Empfehlung bei Umsetzung anhand realer Call-Kosten.
2. **`articleImageAspectRatio`:** nur bauen, falls Bild-Dimensionen ohne HEAD-Sweep beschaffbar (z. B. künftig beim Sync mitspeichern) — sonst dauerhaft streichen.
3. **Crawl-Frequenz-Limit:** wie oft darf ein Merchant „Jetzt scannen" drücken? Vorschlag: Single-flight + Cooldown 6 h (Env-übersteuerbar) — bei Umsetzung bestätigen.

---

## 12. Notiz zur Positionierung

Nach diesem Plan ist der Satz in [KEYWORDS_CONTRACT.md §10](../architecture/KEYWORDS_CONTRACT.md#10-nicht-ziele-weiterhin-gültig) zu präzisieren:

- Alt: *„Kein Ahrefs-Klon. Wer Backlink-Analyse braucht, nutzt Ahrefs — ContentPilot ist ein Content-Werkzeug, kein SEO-Suite-Ersatz."*
- Neu: *„Kein Backlink- oder Kompetitor-SERP-Tool. Wer die Off-Site-Datenmoat-Analysen von Ahrefs/Semrush braucht, greift zu denen. Für On-Site-SEO (Audit, Crawl, Internal Linking, Schema, Sitemap, Freshness) deckt ContentPilot den vollen Umfang ab."*
