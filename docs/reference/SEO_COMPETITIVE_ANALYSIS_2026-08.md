# SEO-Wettbewerbsanalyse — August 2026

> **Stand:** 2026-08-18 · **Code-Basis:** `develop` @ `f702508`
> **Frage:** Hinkt der SEO-Stand der App der Konkurrenz hinterher? Wo sind die Stärken, was fehlt?
> **Vorgänger:** [COMPETITIVE_ANALYSIS.md](COMPETITIVE_ANALYSIS.md) — dessen SEO-Tabellen (§2.2/§2.2.1)
> stammen aus 01/2026 bzw. 06/2026 und sind durch die seither gelieferte SEO-Suite überholt.

---

## 0. Kurzfassung

**Wir hinken nicht hinterher — bei technischem On-Site-SEO liegen wir auf oder über dem Niveau
der Spitzen-Apps.** Was 01/2026 noch als ❌ in der Wettbewerbstabelle stand (JSON-LD, Rich
Snippets, GSC, Broken-Link-Detection, Sitemap, Keyword-Research, Bulk-Meta-Editor), ist
vollständig ausgeliefert; einige Flächen (Live-Crawl mit Falsch-Positiv-Disziplin, interne
Verlinkung mit Diff-Preview, per-Locale-SEO über den ganzen Katalog) hat **kein** direkter
Konkurrent in dieser Tiefe.

Der Rückstand liegt woanders — nicht bei Funktionen, sondern an **drei Marktverschiebungen von
Frühjahr/Sommer 2026**, die nach der letzten Analyse passiert sind:

1. **`agents.md` hat `llms.txt` als kanonische KI-Discovery-Datei abgelöst** (Shopify, ~20. Mai
   2026). Unsere komplette AEO-Sektion schreibt `templates/llms.txt.liquid` — die Datei, die
   Agenten heute zuerst lesen, befüllen wir nicht. **Größte konkrete Lücke, kleiner Aufwand.**
2. **Shopify Spring '26 (17. Juni 2026)** liefert Catalog + UCP + ein AI-Kanal-Dashboard nativ.
   Katalog-Syndizierung an ChatGPT/Copilot/Google AI Mode passiert ohne App. Damit ist
   „JSON-LD emittieren" kein Differenzial mehr — **Produktdaten-Vollständigkeit** ist es.
3. **AI-Sichtbarkeits-Tracking** ist eine eigene App-Kategorie geworden (LLM Rank, Agentic
   Shopper, Otterly, Profound, Anagram). Wir messen KI-Sichtbarkeit gar nicht.

Dazu drei kleinere, gut sichtbare Marketing-Lücken: **Bild-Dateinamen-SEO + Speed-Eingriffe**
(TinyIMG/Avada/Booster verkaufen genau das), **zeitgesteuerte Crawls** (Booster wirbt mit
wöchentlichem 404-/Redirect-/Orphan-Scan; wir crawlen nur on demand) und **Readability-Analyse**
(Yoast-Signature).

---

## 1. Was wir heute haben (im Code verifiziert)

Alle Sektionen liegen unter `/app/seo/*`, Deskriptoren in
[seo-sections.ts](../../app/config/seo-sections.ts), Plan-Grenzen in
[plans.ts](../../app/config/plans.ts) (`SeoPlanLimits`).

| Sektion | Was sie kann | Plan |
|---|---|---|
| **Übersicht** | Store-weiter Score, Verteilung, Problem-Buckets, „Alle mit KI beheben", Score-Trend über Snapshots, **pro Locale** (eigener Score + KI-Fix je Sprache) | alle (Historie: Pro 30 d / Max 365 d, nächtlicher Auto-Audit nur Max) |
| **Ladezeit & Qualität** | PageSpeed Insights je Seite (CWV, Accessibility, Best Practices) + echte Nutzer-Samples (`SeoWebVitalSample`) | alle (Runs/Tag: 5/20/40/80) |
| **Website-Crawl** | Live-Crawl der Storefront in zwei Schritten: **Auslieferung** (Statuscodes, kaputte interne *und externe* Links, Redirect-Hops, Antwortzeiten, Waisen, Head-Drift, Duplicate Titles, Crawl-zu-Crawl-Diff) und **On-Page & Indexierung** (noindex/Robots-Direktiven, Canonicals, H1, fehlende Meta-Descriptions, dünner Inhalt als Perzentil je Typ, Bilder ohne Alt) + CSV-Export | Pro |
| **hreflang** | Prüft, ob veröffentlichte Sprachen wirklich übersetzt sind | alle (ab 2 Sprachen) |
| **Keywords** | Keywords pro Inhalt **und pro Sprache**, Gruppen, Prioritäten, GSC-Anreicherung je Assignment, Snapshots/Historie, Vorschläge aus Google-Autocomplete, KI-Keyword-Verteilung über den Katalog, „Keyword einarbeiten" im Editor, CSV | Basic (25 / Pro 100 / Max 1000) |
| **Search Console** | OAuth, Sync, Quick-Wins mit CTR-Kurve, Auflösung URL → Item, täglicher Auto-Sync, **per-Seiten-Rollup** (`SeoGscPageStat`) | Pro (28 d) / Max (480 d) |
| **Weiterleitungen** | 301-Verwaltung, CSV-Import, **Live-404-Tracking** aus der Storefront (`Seo404Hit`), Redirect-Ketten-Erkennung + Auflösung, **Auto-Redirect bei Handle-Wechsel — auch für übersetzte Handles** | alle |
| **Interne Verlinkung** | Findet unverlinkte Erwähnungen (Titel/Keyword/KI-Synonyme, gebündelte Synonym-Calls), cheerio-basierte Einfügung mit **Vorher/Nachher-Diff und Merchant-Bestätigung**, permanente Ablehnungen mit Gedächtnis, zweite Liste für Abgelehntes | Pro |
| **Strukturierte Daten** | JSON-LD über den Storefront-Block: Product (inkl. Offer/GTIN/Brand), Organization, CollectionPage, BlogPosting, BreadcrumbList, FAQPage, AggregateRating; `validateJsonLd` mit 18 Warncodes; **katalogweiter Batch-Report** (`seoJsonLdAudit`); dazu Open Graph / Twitter Cards | alle |
| **Sitemap** | Liest die echte `sitemap.xml`, schlägt Ausschlüsse vor und setzt/entfernt `seo.hidden` per `metafieldsSet`/`metafieldsDelete` mit Echo-Prüfung; Crossmatch gegen den letzten Crawl | Pro |
| **IndexNow** | Key-Datei am Storefront-Root (per Shopify-Redirect, gemessen: 202 Accepted), Auto-Submit über Webhooks und Publish-Übergänge, Queue + Quota | Pro (5k/Monat) / Max (50k) |
| **KI-Suche / AEO** | `llms.txt` als Theme-Template inkl. täglichem Auto-Refresh; robots.txt-Audit für KI-Crawler (OAI-SearchBot, PerplexityBot, Claude-SearchBot, GPTBot …) mit KI-Beratung und verwalteter robots.txt | Basic |
| **Bulk-Editor** | Spreadsheet-Grid über den ganzen Katalog inkl. SEO-Titel/Meta/Handle/Alt-Text/Metafelder, Diff-only-Saves, CSV-I/O, KI-Bulk-Fix, Bulk-Übersetzung | alle (Batch 25/100/500/2500) |

Dazu quer über die App: **Content-Freshness-Audit** (GSC × `shopifyUpdatedAt` → Refresh-Kandidaten),
KI-Alt-Texte + WebP-Konvertierung (Pro+), Glossar-Injektion in alle KI-Pfade, Inhalte direkt in
der App anlegen (Produkte/Collections/Seiten/Artikel inkl. KI-Generierung).

---

## 2. Was sich im Markt seit der letzten Analyse geändert hat

### 2.1 `agents.md` statt `llms.txt` (~20. Mai 2026)

Shopify serviert `/agents.md` nativ als **kanonische** KI-Discovery-Datei; `/llms.txt` und
`/llms-full.txt` zeigen per Default darauf. Alle drei Pfade sind über eigene Liquid-Templates
überschreibbar, mit Fallback auf `agents.md.liquid`. Merchants, die ihre `llms.txt` vorher über
URL-Redirects oder App-Proxys ausgeliefert hatten, verloren ihre Overrides.

**Für uns:** unsere AEO-Sektion schreibt ausschließlich `templates/llms.txt.liquid`
([aeo.service.ts](../../app/services/seo/aeo.service.ts): `LLMS_TEMPLATE_FILENAME`) — der
Theme-Template-Weg ist der richtige (App-Proxy-Lösungen sind gebrochen), aber der String
`agents.md` kommt im gesamten Repo nicht vor. Unsere sorgfältig gebauten Markenfakten landen
damit nicht in der Datei, die Agenten zuerst lesen.

### 2.2 Shopify Spring '26 — Catalog, UCP, AI-Kanal-Dashboard (17. Juni 2026)

Über 150 Updates rund um „agentic commerce": **Shopify Catalog** syndiziert berechtigte Produkte
ohne Setup an ChatGPT, Microsoft Copilot, Google AI Mode, Gemini und die Shop-App; das
**Universal Commerce Protocol (UCP)** (mit Google entwickelt, von Amazon/Meta/Microsoft/Stripe
u. a. getragen) ist offener Standard; Merchants schalten AI-Kanäle im Admin frei und sehen die
Performance in einem nativen Dashboard.

**Für uns:** die alte AEO-These „wir machen den Katalog für KI überhaupt sichtbar" ist von der
Plattform erledigt worden. Was zählt, ist die **Qualität und Vollständigkeit der Produktdaten**,
die in den Catalog fließen (GTIN, Brand/Vendor, Attribute, Varianten, Verfügbarkeit) — und genau
dafür haben wir die Bausteine (JSON-LD-Batch-Audit kennt `productNoGtinMpn`, der Bulk-Editor
kann Metafelder und Attribute massenhaft füllen), aber keinen Report, der das als
„Catalog-Readiness" ausweist.

### 2.3 AI-Sichtbarkeit ist eine eigene Kategorie geworden

Apps wie **LLM Rank – AI Visibility** und **Agentic Shopper** (Shopify App Store) sowie
Plattformen wie Otterly (ab ~$29/Monat), Profound, Scrunch und Anagram tracken täglich, ob eine
Marke in ChatGPT-/Perplexity-/Gemini-/Copilot-Antworten auftaucht, mit welchen Prompts, mit
welchem Sentiment und gegen welche Wettbewerber. StoreSEO und TinyIMG haben AEO-Bausteine
(llms.txt, FAQ-Schema) in ihre SEO-Suiten gezogen.

**Für uns:** wir liefern die *Voraussetzungen* für Zitierbarkeit (Schema, llms.txt,
Crawler-Zugriff, IndexNow), messen aber nichts davon. Das ist die einzige Kategorie, in der
Wettbewerber ein Feature *bewerben*, das wir nicht einmal ansatzweise haben.

---

## 3. Feature-Matrix (Stand 08/2026)

Konkurrenz-Daten aus Sekundärquellen (§7) — der Shopify App Store war aus der Analyse-Umgebung
nicht direkt abrufbar; Preise und Ratings vor einer Marketing-Verwendung nachprüfen.

| Funktion | **Wir** | Yoast | StoreSEO | SEOWILL (ex SEOAnt) | TinyIMG | Booster / Avada |
|---|---|---|---|---|---|---|
| SEO-Titel/Meta + KI-Generierung | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Bulk-Meta-Editor (manuelles Grid) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Alt-Text (KI) | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ |
| JSON-LD / Rich Snippets | ✅ (7 Typen) | ✅ (+ Schema-Aggregation) | ✅ | ✅ | ✅ | ✅ |
| Erweiterte Schema-Typen (LocalBusiness/Video/HowTo) | ❌ | ⚠️ (nicht in Shopify-App) | ⚠️ | ✅ (Local) | ⚠️ | ⚠️ |
| Open Graph / Twitter Cards | ✅ | ⚠️ | ✅ | ✅ | ⚠️ | ✅ |
| Store-Audit + Score | ✅ (+ pro Sprache) | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Live-Storefront-Crawl** | ✅ (2 Schritte, Diff, CSV) | ❌ | ⚠️ | ✅ | ⚠️ | ✅ (Booster: wöchentlich) |
| Broken-Link-Erkennung (intern + extern) | ✅ | ❌ | ⚠️ | ✅ | ✅ | ✅ |
| 404-Tracking + Auto-Redirects | ✅ (inkl. übersetzter Handles) | ❌ | ✅ | ✅ | ✅ | ✅ |
| Redirect-Ketten | ✅ | ❌ | ⚠️ | ⚠️ | ⚠️ | ✅ |
| **Interne Verlinkungs-Vorschläge** | ✅ (Diff + Bestätigung) | ❌ (nur WP-Premium) | ⚠️ | ✅ | ❌ | ⚠️ |
| Google Search Console | ✅ | ⚠️ | ✅ | ⚠️ | ⚠️ | ✅ |
| Keyword-Tracking | ✅ (pro Sprache, GSC-basiert) | ✅ | ✅ | ✅ | ⚠️ | ✅ |
| **Keyword-Volumen / Difficulty** | ❌ (bewusst) | ⚠️ | ✅ | ✅ | ❌ | ✅ (SearchPie) |
| Sitemap-Kontrolle | ✅ (`seo.hidden`, Echo-verifiziert) | ⚠️ | ✅ | ✅ | ✅ (HTML-Sitemap) | ✅ |
| IndexNow / Instant Indexing | ✅ (Root-Key, gemessen) | ⚠️ | ✅ | ✅ | ✅ | ⚠️ |
| llms.txt | ✅ | ⚠️ | ✅ | ⚠️ | ✅ | ⚠️ |
| **`agents.md`** | ❌ | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ⚠️ |
| robots.txt / KI-Crawler-Audit | ✅ | ❌ | ⚠️ | ⚠️ | ⚠️ | ⚠️ |
| **AI-Sichtbarkeits-Tracking** | ❌ | ❌ | ⚠️ | ⚠️ | ⚠️ | ❌ (eigene Apps) |
| Core Web Vitals / PageSpeed | ✅ (Diagnose + Feld-Daten) | ⚠️ | ✅ | ✅ | ✅ | ✅ |
| **Speed-Eingriffe (Lazy-Load, Minify)** | ❌ | ❌ | ⚠️ | ✅ | ✅ | ✅ |
| Bildkomprimierung | ✅ (WebP, Pro+) | ❌ | ✅ | ✅ | ✅ | ✅ |
| **Bild-Dateinamen-SEO** | ❌ | ❌ | ⚠️ | ⚠️ | ✅ | ⚠️ |
| Readability-Analyse | ❌ | ✅ | ⚠️ | ❌ | ❌ | ❌ |
| Content-Freshness (GSC × Alter) | ✅ | ❌ | ⚠️ | ❌ | ❌ | ❌ |
| **SEO in Fremdsprachen** (Audit/Score/Fix pro Locale) | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Backlinks / Local SEO | ❌ (Nicht-Ziel) | ❌ | ⚠️ | ✅ | ❌ | ✅ (SearchPie) |
| Autopilot (automatisch überschreibend) | ❌ (bewusst opt-in) | ❌ | ⚠️ | ⚠️ | ⚠️ | ✅ (Booster) |

⚠️ = teilweise / nicht beworben / unklar.

**Preise zum Vergleich:** Yoast $19/Monat · StoreSEO Free + ab $14.99 · TinyIMG Free + ab $9.99 ·
Sherpas Smart SEO bis $29.99 · Avada ~$35 / ~$99 · Booster ~$39 / ~$69 · SEOWILL Free + Paid.
Wir: €9.90 / €19.90 / €59.90 — **inklusive Übersetzung, Bildverwaltung und Content-Erstellung**.

---

## 4. Unsere Stärken (was so kein Konkurrent hat)

1. **Mehrsprachiges SEO über den kompletten Stack.** Score, Problem-Buckets und KI-Fix laufen
   pro Locale; Keywords hängen an Sprache *und* Item; der Crawl löst **übersetzte Handles** auf
   und behandelt Locale-Präfixe in jeder Regel (Denylist, noindex-Erwartung, Duplicate-Content);
   hreflang-Audit prüft, ob veröffentlichte Sprachen wirklich übersetzt sind. Kein SEO-Konkurrent
   liefert das, kein Übersetzungs-Konkurrent liefert SEO in dieser Tiefe. **Das ist der Moat.**
2. **Crawl-Ergebnisse ohne Rauschen.** Policy-Seiten haben keine Metadaten-Fläche (Shopify-API),
   `/collections/all` ist virtuell, `?page=N` erbt Seite-1-Metadaten, `noindex` ist oft gewollt,
   dünner Inhalt ist ein Perzentil je Ressourcentyp — jede Kategorie ist gegen ihre eigenen
   Falsch-Positiven gefiltert, und Ausgeschlossenes wird *ausgewiesen*, nicht verschwiegen.
   Genau daran scheitern Auto-Audit-Apps regelmäßig.
3. **Interne Verlinkung mit Merchant-Kontrolle.** Diff-Preview, Bestätigung, permanentes
   Ablehnungs-Gedächtnis, Synonym-Prompts, die Abgelehntes nicht wiederholen. Yoasts
   Shopify-App hat gar kein internes Linking.
4. **BYO-Key / 6 KI-Provider.** Konkurrenten rechnen in „AI-Credits" (StoreSEO: 200 gratis,
   dann Kontingente). Bei uns ist KI-Volumen kein Produktlimit.
5. **IndexNow richtig gebaut.** Key-Datei am Storefront-Root über eine Shopify-URL-Weiterleitung,
   Primary-Domain aufgelöst, Ergebnis gemessen (202 Accepted), Auto-Submit an Webhooks und
   Publish-Übergängen. Der naheliegende App-Proxy-Weg liefert 422 — das haben wir bezahlt und
   dokumentiert.
6. **Nicht-destruktiv.** Kein Autopilot, der Merchant-Texte überschreibt (Booster ist genau
   dafür berüchtigt). Jede Massenänderung ist opt-in, per Zelle fehlerbar und diff-basiert.
7. **Suite statt Punktlösung.** SEO + Übersetzung + Bilder + Content-Erstellung in einem Abo,
   unter dem Preis der meisten reinen SEO-Apps.

---

## 5. Lücken, priorisiert

### P1 — schließen, bevor jemand fragt

| # | Lücke | Warum | Aufwand |
|---|---|---|---|
| 1 | **`agents.md`** (+ `llms-full.txt`) als Theme-Template, analog zum bestehenden `llms.txt`-Pfad inkl. Auto-Refresh | Die kanonische KI-Discovery-Datei bleibt sonst Shopify-Default, unsere Markenfakten landen nicht darin | Klein — der ganze Mechanismus (Template schreiben, Echo prüfen, stündlicher Sweep) existiert. **Vorher ~1 h Dev-Store-Spike:** welche Datei gewinnt, wenn beide Templates existieren |
| 2 | **Catalog-/Produktdaten-Readiness-Report** — „N Produkte ohne GTIN, ohne Brand, ohne Kategorie, ohne Attributwerte", mit Sprung in den Bulk-Editor | Shopify syndiziert automatisch; über Sichtbarkeit in KI-Antworten entscheidet ab jetzt die Datenqualität | Mittel — `seoJsonLdAudit` liefert schon die halbe Auswertung, der Bulk-Editor die Fix-Fläche |

### P2 — sichtbare Wettbewerbsnachteile

| # | Lücke | Warum | Aufwand |
|---|---|---|---|
| 3 | **Zeitgesteuerter Crawl / Link-Health** (Max, analog `SeoAuditAutoRunService`) | Booster bewirbt wöchentliche 404-/Redirect-/Orphan-Scans; unser Crawl läuft nur auf Knopfdruck | Klein-mittel — Sweep-Muster + Single-Flight existieren |
| 4 | **KI-Referral-Tracking** („X Besuche aus chatgpt.com/perplexity.ai") statt vollem AI-Rank-Tracking | Billigster ehrlicher Einstieg in die AEO-Messung; echtes Prompt-Monitoring kostet laufend Geld | Klein (Referrer-Auswertung in der Storefront-Extension) — echtes Rank-Tracking: hoch, wiederkehrende Kosten |
| 5 | **Bild-Dateinamen-SEO** (SEO-Dateinamen statt nur Alt-Text) | TinyIMG-Kernversprechen; wir fassen bereits jedes Bild an (WebP, Alt) | Mittel — Datei-Rename über `fileUpdate`, Referenzen müssen mitziehen |
| 6 | **Speed-Eingriffe** (Lazy-Load, CSS/JS-Minify) | Avada/Booster/TinyIMG verkaufen „Speed"; wir diagnostizieren nur | Mittel-hoch, Theme-Eingriff — **bewusst prüfen, ob wir das wollen** |

### P3 — Feinschliff / Erwartungsmanagement

7. **Readability-Analyse** — Yoast-Signature (Satzlänge, Passiv, Absatzlänge). Mehrsprachig
   nicht trivial, aber ein KI-basierter Lesbarkeits-Check je Sprache passt zu unserem Stack.
8. **Erweiterte Schema-Typen** — LocalBusiness (SEOWILL wirbt damit), VideoObject, HowTo.
   FAQ/Review/Breadcrumb/Article/Product/Organization haben wir.
9. **Keyword-Volumen & Difficulty** — bleibt Datenmoat und Nicht-Ziel; aber im UI sagen, *warum*
   dort keine Volumenzahl steht (heute wirkt es wie eine fehlende Funktion).
10. **Long-Form-Blog-Generator** (Outline → Abschnitte → interne Links). Artikel anlegen und
    Felder generieren geht bereits; ein Struktur-Workflow fehlt.

### Bewusste Nicht-Ziele (unverändert)

Backlink-Analyse, Kompetitor-Ranking-Tracking, SERP-Scraping, Log-File-Analyse, AMP,
Autopilot-Overwrites.

---

## 6. Empfehlung

Reihenfolge nach Wirkung ÷ Aufwand:

1. **`agents.md`** (P1.1) — nach dem Dev-Store-Spike ein kurzer Umbau der AEO-Sektion.
2. **Catalog-Readiness-Report** (P1.2) — der neue, verteidigbare AEO-Nutzen.
3. **Zeitgesteuerter Crawl** (P2.3) — schließt das letzte Automatisierungs-Argument der
   Konkurrenz und ist ein echtes Max-Differenzial.
4. **KI-Referral-Tracking** (P2.4) — billige Messung statt teurem Rank-Tracking.
5. Danach nach Marktfeedback: Bild-Dateinamen, Readability, Schema-Typen.

**Und unabhängig von Code:** Die größte Lücke ist nicht funktional, sondern kommunikativ.
Mehrsprachiges SEO, Crawl-Disziplin, Freshness-Audit und die interne Verlinkung mit Diff-Preview
stehen in keinem App-Store-Text der Konkurrenz — bei uns aber auch nirgends prominent.

---

## 7. Methodik & Vorbehalte

- **App-Stand:** direkt gegen `develop` @ `f702508` verifiziert (Routen, Services, Prisma-Modelle,
  Plan-Limits) — nicht aus Dokumentation abgeschrieben.
- **Wettbewerbsdaten:** `apps.shopify.com` und `shopify.dev` waren aus dieser Umgebung durch die
  Egress-Policy blockiert. Feature-, Preis- und Rating-Angaben stammen aus Sekundärquellen
  (Vergleichs-Blogs, Review-Portale, Suchergebnis-Zusammenfassungen), Stand August 2026. Vor
  einer Verwendung in Marketing oder einer Umsetzungsentscheidung an der Primärquelle prüfen.
- **`agents.md`:** zwei unabhängige Sekundärquellen beschreiben Datum, Fallback-Kette und
  Template-Namen übereinstimmend; `shopify.dev` war nicht erreichbar. Deshalb steht der
  Dev-Store-Spike **vor** der Umsetzung, nicht danach.

### Quellen

- [Shopify — Agentic Commerce on Shopify (2026)](https://www.shopify.com/blog/how-agentic-commerce-works)
- [Digital Applied — Shopify Spring '26 Edition: Agentic Commerce, UCP, Catalog](https://www.digitalapplied.com/blog/shopify-spring-2026-edition-agentic-commerce-ucp-catalog)
- [Weaverse — Shopify agents.md vs llms.txt: What Changed in 2026](https://weaverse.io/blogs/shopify-agents-md-llms-txt-theme-template-customization-may-28-2026)
- [Consentmo — Shopify's New AI Discovery Files](https://www.consentmo.com/blog-posts/shopifys-new-ai-discovery-files)
- [Craftshift — Best Shopify SEO apps 2026: 8 verified and ranked](https://craftshift.com/best-shopify-seo-apps-2026/)
- [SearchAtlas — 12 Best Shopify SEO Apps for 2026, Tested and Compared](https://searchatlas.com/blog/shopify-seo-apps/)
- [TinyIMG — Services / Feature-Übersicht](https://tiny-img.com/services/)
- [StoreSEO — Best AI Shopify Apps for LLMs.txt and Schema Markup](https://storeseo.com/best-ai-shopify-apps-for-llms-txt-and-schema-markup/)
- [Identixweb — Yoast SEO for Shopify Review](https://www.identixweb.com/yoast-seo-for-shopify/)
- [HulkApps — Avada SEO vs Sherpas Smart SEO](https://www.hulkapps.com/blogs/compare/shopify-seo-apps-avada-seo-image-optimizer-vs-sherpas-smart-seo)
- [wrkngdigital — Top 6 Tools to Track Shopify AI Shopping Visibility (2026)](https://wrkngdigital.com/post/top-6-tools-track-shopify-ai-shopping-visibility-chatgpt-perplexity-google-2026)
- [Shopify App Store — LLM Rank · AI Visibility](https://apps.shopify.com/llm-rank) · [Agentic Shopper · AI Visibility](https://apps.shopify.com/ai-mention-tracker)
