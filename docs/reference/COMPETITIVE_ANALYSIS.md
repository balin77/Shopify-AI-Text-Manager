# Wettbewerbsanalyse & Feature-Roadmap

> Erstellt: 2026-01-27
> Ziel: Identifikation fehlender Features im Vergleich zu Wettbewerbern

---

## Inhaltsverzeichnis

1. [Aktuelle Features der App](#1-aktuelle-features-der-app)
2. [Wettbewerber-Vergleich](#2-wettbewerber-vergleich)
3. [Fehlende Features](#3-fehlende-features)
4. [Implementierungs-Roadmap](#4-implementierungs-roadmap)
5. [Quellen](#5-quellen)

---

## 1. Aktuelle Features der App

### 1.1 AI/KI Features

| Feature | Status | Details |
|---------|--------|---------|
| Multi-Provider AI | ✅ | HuggingFace, Gemini, Claude, OpenAI, Grok, DeepSeek |
| Produkttitel-Generierung | ✅ | Mit benutzerdefinierten AI-Anweisungen |
| Produktbeschreibungen | ✅ | Generieren oder verbessern |
| SEO-Titel & Meta-Beschreibungen | ✅ | Automatische Generierung |
| Alt-Text für Bilder | ✅ | SEO-optimierte Bildbeschreibungen |
| URL-Handle-Generierung | ✅ | Automatische Slug-Erstellung |
| Sammlungs-Content | ✅ | Titel, Beschreibungen, SEO |
| Blog-Artikel-Content | ✅ | Generierung und Verbesserung |
| Seiten-Content | ✅ | Statische Seiten |
| Richtlinien-Content | ✅ | Privacy, AGB, Versand, Rückgabe |
| Custom AI-Anweisungen | ✅ | Pro Content-Typ konfigurierbar |
| AI Queue System | ✅ | Rate Limiting, Retry, Progress |
| Task-Tracking | ✅ | Status, Progress, Queue-Position |

### 1.2 Übersetzungs-Features

| Feature | Status | Details |
|---------|--------|---------|
| Multi-Language-Übersetzungen | ✅ | Alle Shop-Locales |
| Produkt-Übersetzungen | ✅ | Alle Felder |
| Sammlungs-Übersetzungen | ✅ | Titel, Beschreibung, SEO |
| Artikel-Übersetzungen | ✅ | Blog-Content |
| Seiten-Übersetzungen | ✅ | Statische Seiten |
| Richtlinien-Übersetzungen | ✅ | Shop-Policies |
| Bild Alt-Text Übersetzungen | ✅ | Bulk-API für MediaImages |
| Theme-Content-Übersetzungen | ✅ | Templates, Sections |
| Theme-Standardinhalte (inkl. Checkout) | ✅ | LOCALE_CONTENT nach Präfix gruppiert; `shopify.checkout.*` = kompletter Checkout-Text |
| E-Mail-Benachrichtigungen | ✅ | EMAIL_TEMPLATE — Bestell-, Versand-, Konto-Mails etc. |
| Versand & Zustellung | ✅ | DELIVERY_METHOD_DEFINITION (Methodennamen im Checkout) |
| Filter & Shop-Metadaten | ✅ | FILTER-Labels + SHOP meta_title/meta_description |
| Cookie-Banner | ✅ | COOKIE_BANNER (via `unstable`, Auto-Fallback) |
| Zahlung & Lieferschein | ✅ | PAYMENT_GATEWAY, PACKING_SLIP_TEMPLATE (konditional) |
| Abo-Pläne | ✅ | SELLING_PLAN, SELLING_PLAN_GROUP (konditional) |
| Locale-Navigation | ✅ | Schnellwechsel im Editor |

### 1.3 Content-Management

| Feature | Status | Details |
|---------|--------|---------|
| Produkte | ✅ | Titel, Beschreibung, Handle, SEO, Bilder, Optionen, Metafelder |
| Collections | ✅ | Mit Translations |
| Blog-Artikel | ✅ | Mit Translations |
| Statische Seiten | ✅ | Mit Translations |
| Shop-Richtlinien | ✅ | 6 Policy-Typen |
| Menüs | ✅ | Hierarchische Struktur |
| Theme-Inhalte | ✅ | Templates, Sections, Settings |
| Metaobjects | 🔄 | Coming Soon |
| Unified Content Editor | ✅ | Einheitliches UI |
| HTML-Vorschau | ✅ | Für formatierte Inhalte |

### 1.4 SEO-Features

| Feature | Status | Details |
|---------|--------|---------|
| SEO-Titel-Generator | ✅ | Max. 60 Zeichen |
| Meta-Description-Generator | ✅ | 120-160 Zeichen |
| SEO-Score-Berechnung | ✅ | Mit Optimierungsvorschlägen |
| SEO Sidebar | ✅ | Live-Preview, Keyword-Tracking |
| Längen-Validierung | ✅ | Title und Meta-Description |

### 1.5 Technische Features

| Feature | Status | Details |
|---------|--------|---------|
| PostgreSQL DB-Caching | ✅ | Schnelle Ladezeiten |
| Webhook-System | ✅ | Products, Collections, Articles, Menus |
| SPA-Navigation | ✅ | Client-Side Routing |
| Subscription Plans | ✅ | Free, Basic, Pro, Max |
| GDPR Webhooks | ✅ | Data Request, Redact |
| API Key Encryption | ✅ | Sichere Speicherung |
| Prompt Sanitization | ✅ | XSS/Injection-Schutz |

---

## 2. Wettbewerber-Vergleich

### 2.1 Übersetzungs-Apps

| Feature | Unsere App | Transcy | Weglot | LangShop | T Lab |
|---------|------------|---------|--------|----------|-------|
| AI-Übersetzung | ✅ | ✅ | ✅ | ✅ | ✅ |
| Multi-Language | ✅ | ✅ 111 | ✅ | ✅ | ✅ |
| Theme-Übersetzung | ✅ | ✅ | ✅ | ✅ | ✅ |
| Custom AI-Anweisungen | ✅ | ❌ | ❌ | ❌ | ❌ |
| **Währungsumrechnung** ¹ | ❌ | ✅ 167 | ❌ | ✅ | ✅ |
| **Geolocation Auto-Detect** | ❌ | ✅ | ✅ | ✅ | ❌ |
| **Glossar/Terminologie** | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Language/Currency Switcher Widget** | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Third-Party-App-Übersetzung** ² | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Checkout-Übersetzung** ³ | ✅ | ✅ | ✅ | ✅ | ❌ |
| **Bild-Übersetzung (OCR)** | ❌ | ✅ | ❌ | ❌ | ❌ |
| **Tag-Übersetzung** ⁶ | ⚠️ | ❌ | ⚠️ | ⚠️ (Legacy) | ❌ |

> ¹ **Währungsumrechnung ist kein echter Gap** (Stand 2026-06): Shopify
> rechnet seit Markets + Shopify Payments **nativ** mit aktuellen
> Marktwechselkursen um — Storefront-Anzeige, Checkout und Refunds. Die
> ✅ der Konkurrenz duplizieren in den meisten Fällen Shopify-Bordmittel.
> Eigener Konverter ist nur in Edge-Cases relevant (Händler ohne Shopify
> Payments, reiner Display-Switcher für nicht konfigurierte Märkte,
> Custom-Rundung wie 9,99). Details + Entscheidung →
> [ROADMAP.md](../ROADMAP.md) §4.3 Localization.
>
> ² **Third-Party-App-Übersetzung — vollständig ausgeliefert** (Direct
> Translations, Stand 2026-06): Ein Theme-App-Embed liest jeden Textknoten
> auf der Storefront, schlägt ihn im merchant-gepflegten Item-Wörterbuch
> nach und ersetzt ihn live für die aktuelle Locale — trifft Labels und
> Texte von Apps wie Judge.me, Loox, PageFly und allem anderen, das im
> Parent-DOM rendert. AI-Übersetzung mit Auto-Detect der Quellsprache,
> Capture-Tool im Theme-Editor zum klick-basierten Hinzufügen, optionaler
> Auto-Sammler mit Heuristik + `franc`-Sprachfilter + Opt-in für
> `translate="no"`-Subtrees (für genau diese Apps gemacht). Ergänzend liefert
> der Metafield-Scanner shop-eigene Definitionen direkt in die
> Produktübersetzung. Harte Grenze (haben alle Konkurrenten ebenfalls):
> cross-origin iframes (z. B. Loox-Reviews im Full-Widget-Modus) sind
> per Browser-Sandbox unerreichbar.
>
> ³ **Checkout-Übersetzung — ausgeliefert** (Full-Translation-Coverage,
> Stand 2026-06): Die kompletten Checkout-Texte liegen als `shopify.checkout.*`
> in `ONLINE_STORE_THEME_LOCALE_CONTENT` (Rubrik „Theme-Standardinhalte" →
> Gruppe „Checkout & System") und sind über denselben `translationsRegister`-
> Pfad wie jeder andere Theme-Key les- und schreibbar. Für **nicht** von
> Shopify nativ unterstützte Sprachen (Arabisch, Hebräisch, Ukrainisch, …)
> greift unsere Übersetzung garantiert; für die 33 von Shopify mit
> Profi-Übersetzungen bestückten Sprachen ist die Override-Präzedenz noch
> nicht abschließend verifiziert (Smoke-Test offen). Damit ist die letzte
> große ❌-Zeile gegenüber Transcy/Weglot/LangShop geschlossen.
>
> ⁶ **Tag-Übersetzung — niemand kann es, und die ⚠️ sind allesamt Umgehungen**
> (Web-Recherche 2026-08-20). Shopify dokumentiert die Grenze ausdrücklich:
> *„A resource's `tags` field can't be translated"* — Produkt-, Artikel- und
> Blog-Tags sind **kein `translatableResource`-Key** der Admin API. Jede App,
> die über `translationsRegister` schreibt, endet dort; das ist keine
> App-Schwäche, sondern die Plattform. Verschärfend an genau der Fläche, wo
> Tags sichtbar werden: in **Search & Discovery** sind Filter-*Labels* und
> *custom* Filter-*Werte* übersetzbar, tag- und vendor-basierte Filterwerte
> aber nicht („*The only exception is tags, which cannot be translated*") —
> sie erscheinen immer in der Shop-Standardsprache. Shopifys eigene Empfehlung
> ist **Metafelder statt Tags** für Filter, weil Metafelder übersetzbar sind.
>
> Was die ⚠️ der Konkurrenz konkret bedeuten — drei Umgehungen, zwei davon
> heute tot bzw. Legacy:
> • **LangShop** = „LangShop Theme", ein *Duplikat* des Themes, in das Tags,
>   Statiktext und Bilder hineingerendert werden. **Seit 08.08.2023 für
>   Neukunden abgeschafft** (Shopify-Richtlinien); nur Shops mit einem vor
>   diesem Datum angelegten localized theme haben es noch. Zusätzlich sind die
>   Übersetzungen nur im LangShop-Theme sichtbar und die **Storefront-Suche
>   funktioniert dann nicht mehr**.
> • **langify** = ein „Polyfill"-JS, das der Händler **in den Theme-Code**
>   einbaut und das gerenderten Text ersetzt (alternativ „Custom Content").
>   Kein Tag wird übersetzt, nur seine Anzeige. Für Filter empfiehlt langify
>   selbst den Metafeld-Weg.
> • **Weglot / GTranslate** = **Proxy** vor der Storefront, der alles
>   Gerenderte auf eigenen Sprach-URLs übersetzt — inklusive Tags und Filtern,
>   aber ebenfalls nur die HTML-Ausgabe.
> • **Transcy** und **T Lab** sagen es gar nicht erst zu; T Labs Doku nennt
>   „products, articles, blog tags cannot be translated" explizit.
>
> Gemeinsamer Haken aller DOM-/Proxy-Ansätze: die **Filter-URL** bleibt
> unübersetzt — `?filter.p.tag=chairs` läuft ins Leere, sobald der angezeigte
> Wert ein anderer ist.
>
> **Unser ⚠️ ist derselbe Mechanismus, nur ohne Theme-Eingriff.** Die
> **Direktübersetzungen** sind ein TreeWalker über alle Textknoten der
> Storefront ([direct-translation.js](../../extensions/storefront/assets/direct-translation.js)) —
> technisch dieselbe Klasse wie langifys Polyfill, aber als App-Embed, also
> ohne Theme-Code. Ein Händler ersetzt damit heute schon sichtbare Tag-Texte
> und tag-basierte Filterwerte pro Locale. Grenze: es ist ein **shop-weites
> Wörterbuch** (ein Quellstring → eine Übersetzung je Locale), nicht pro
> Produkt — für Tags ist das aber die richtige Granularität, weil ein Tag
> ohnehin shop-weit derselbe String ist. Die Filter-URL-Parameter bleiben auch
> bei uns unübersetzt.
>
> **Kein Gap, und die Modellierung im Code ist die richtige:** `field.tags` im
> Bulk-Editor ist bewusst `translatable: false`
> ([columns.shared.ts](../../app/services/bulk-editor/columns.shared.ts)), Tags
> sind ein Merchandising-Attribut mit `translationKey: ""`. Auch die
> Coverage-Aussage unten bleibt unberührt: Tags sind kein *Ressourcentyp*, den
> man abdecken könnte. Ehrlicher Marketing-Satz wäre entsprechend nicht „wir
> übersetzen Tags" (dieselbe Halbwahrheit wie bei Weglot/GTranslate), sondern:
> *„Tags sind bei Shopify nicht übersetzbar — mit Direktübersetzungen ersetzt
> du die angezeigten Tag-Texte trotzdem in jeder Sprache, ohne Theme-Code."*
>
> **Ungemessen** (nicht geraten, sondern offen): ob unser Embed die Tag-Chips
> in einem konkreten Theme wirklich erwischt, und ob Transcy Tags still doch
> über einen eigenen DOM-Layer abdeckt.

#### Vollständige Übersetzungsabdeckung — T&A-Parität + 3 Flächen darüber hinaus

Mit dem „Full Translation Coverage"-Release (2026-06) deckt ContentPilot
**jeden übersetzbaren Ressourcentyp** der Shopify Admin GraphQL API ab und
erreicht damit volle Parität zu Shopifys eigener *Translate & Adapt* —
inklusive dreier Flächen, die T&A selbst **nicht** anbietet:

| Neu übersetzbar | API-Ressource | T&A |
|---|---|---|
| Theme-Standardinhalte (inkl. Checkout) | `ONLINE_STORE_THEME_LOCALE_CONTENT` | ✅ |
| E-Mail-Benachrichtigungen | `EMAIL_TEMPLATE` | ✅ |
| Versand & Zustellung (im Checkout sichtbar) | `DELIVERY_METHOD_DEFINITION` | ✅ |
| Filter-Labels | `FILTER` | ✅ |
| Shop-Metadaten (SEO) | `SHOP` (meta_title/description) | ✅ |
| Cookie-Banner (via `unstable`, Auto-Fallback) | `COOKIE_BANNER` | ✅ |
| **Zahlungsanbieter-Texte** | `PAYMENT_GATEWAY` | ❌ |
| **Lieferschein-Vorlagen** | `PACKING_SLIP_TEMPLATE` | ❌ |
| **Abo-Pläne / Abo-Gruppen** | `SELLING_PLAN`, `SELLING_PLAN_GROUP` | ❌ |

Einzig `MENU`/`LINK` bleibt teilabgedeckt — eine Shopify-API-Limitierung, die
alle Apps betrifft. Die letzten drei Zeilen sind ein echtes Differenzial:
Shopifys hauseigene App kann sie nicht übersetzen, wir schon (konditional
eingeblendet, wenn der Shop sie besitzt). Kombiniert mit AI-Markenstimme und
Direct Translations ist das die breiteste Abdeckung am Markt.

**Preise der Wettbewerber (aktualisiert Mai 2026, USD/Monat — Shopify App Store):**

| App | Free | Einstieg | Mitte | Top | Rating (Reviews) |
|-----|------|----------|-------|-----|------------------|
| Transcy | ✅ | $14.90 | $29 | $69 | 4.4 (2.480) |
| Weglot | ✅ (2k Wörter) | $17 | $32 | $87 | 4.5 (816) |
| LangShop | ✅ (50 Prod.) | $10 | $40 | $75 | 4.5 (451) |
| T Lab | ✅ | $11.99 | $29.99 | $59.99 | 4.9 (933) |
| langify | ✅ (manuell) | $17.50 | $29.95 | $59.95 | 4.7 (712) |
| GTranslate | ✅ | $9.99 | $19.99 | $29.99 | 4.7 (659) |
| Hextom | ✅ | $9.99 | ~$19.99 | $49.99 | 4.7 (1.184) |
| Shopify Translate & Adapt | ✅ vollständig gratis | — | — | — | 4.5 (1.424) |
| **ContentPilot (wir)** | ✅ (50 Prod., ∞ Spr.) | €9.90 | €19.90 | €59.90 | — |

> Markt: ~150 Apps in *Currency & Translation* (inkl. Währung/Geolocation),
> davon ~40–60 reine Übersetzungs-Apps. Wettbewerber staffeln nach **Sprachen**
> bzw. **Wörtern** (Weglot); wir nach **Produkten**. Da unser AI-Token-Kosten
> beim Merchant liegen (BYO-Key), ist unsere Locale-Großzügigkeit (**unbegrenzt
> Sprachen ab €0/€9.90** vs. LangShop $40 / Weglot $32 für nur 3) ein echter,
> bislang unkommunizierter USP. Detaillierte Limit-Kritik → `ROADMAP.md`
> §Limit-Review.

### 2.2 SEO-Apps

> ⚠️ **Veraltet (Tabelle aus 01/2026).** Die ❌-Zeilen unten sind seit dem SEO-Tab-Ausbau
> (07/2026) und den Erweiterungen danach fast alle geschlossen — JSON-LD, Rich Snippets, GSC,
> Broken-Link-Detection, Sitemap, Keyword-Research und der manuelle Bulk-Editor sind live.
> **Aktueller Stand, gegen `develop` verifiziert + Markt 08/2026:**
> [SEO_COMPETITIVE_ANALYSIS_2026-08.md](SEO_COMPETITIVE_ANALYSIS_2026-08.md).

| Feature | Unsere App | Yoast SEO | SEOWILL | StoreSEO |
|---------|------------|-----------|---------|----------|
| SEO-Titel/Meta | ✅ | ✅ | ✅ | ✅ |
| AI-Content-Generation | ✅ | ✅ | ✅ | ✅ |
| Alt-Text-Generierung | ✅ | ❌ | ✅ | ✅ |
| SEO-Score | ✅ | ✅ | ✅ | ✅ |
| **JSON-LD Structured Data** | ❌ | ✅ | ✅ | ✅ |
| **Rich Snippets** | ❌ | ✅ | ✅ | ✅ |
| **Google Search Console** | ❌ | ✅ | ❌ | ✅ |
| **Google Analytics** | ❌ | ❌ | ❌ | ✅ |
| **Page Speed Optimization** | ⚠️ teilw. | ❌ | ✅ | ❌ |
| **Image Compression** | ✅ (WebP ab Pro) | ❌ | ✅ | ✅ |
| **Broken Link Detection** | ❌ | ❌ | ✅ | ❌ |
| **Auto-Redirect 404** | ❌ | ❌ | ✅ | ❌ |
| **Sitemap Generation** | ❌ | ❌ | ✅ | ✅ |
| **AMP Support** | ❌ | ❌ | ✅ | ❌ |
| **Keyword Research** | ❌ | ✅ | ✅ | ✅ |
| **Readability Analysis** | ❌ | ✅ | ❌ | ❌ |
| **Breadcrumb Schema** | ❌ | ✅ | ✅ | ✅ |

**Preise der Wettbewerber:**
- Yoast SEO: Free / Premium verfügbar
- SEOWILL: Free / Paid Plans
- StoreSEO: Free / ab $100/Monat (250+ SKUs)

### 2.2.1 Übersehene & neue Funktionsweisen (Nachtrag 2026-06-29)

> ⚠️ **Ebenfalls überholt.** Alle hier als ❌/⚠️ geführten AEO-Punkte (llms.txt, IndexNow,
> AI-Crawler-Zugriff, Schema-Vollständigkeit, Bulk-Meta-Grid) sind ausgeliefert. Neu seit dieser
> Fassung: `agents.md` hat `llms.txt` als kanonische KI-Discovery-Datei abgelöst (Shopify,
> ~20.05.2026) und Shopify Spring '26 (17.06.2026) liefert Catalog/UCP nativ — beides ändert die
> AEO-Bewertung grundlegend. Siehe
> [SEO_COMPETITIVE_ANALYSIS_2026-08.md](SEO_COMPETITIVE_ANALYSIS_2026-08.md) §2.

Die ursprüngliche SEO-Tabelle (§2.2) stammt aus 01/2026 und verpasst den **definierenden Markt-Shift 2026: AEO/GEO** — Optimierung für *Antwort-/generative Engines* (ChatGPT Search, Perplexity, Google AI Overviews, Gemini, Amazon Rufus, MS Copilot). Diese Funktionsweisen fehlen oben komplett und werden von der aktuellen Wettbewerbsspitze (StoreSEO „AI SEO Agent", SEOWILL, TinyIMG, dedizierte IndexNow-Apps) bereits ausgeliefert:

| Funktionsweise | Was es ist | Wettbewerber | Status bei uns |
|---|---|---|---|
| **AEO/GEO** | Sichtbarkeit & Zitierung in KI-Antworten (ChatGPT/Perplexity/AI Overviews) statt nur klassischem SERP | StoreSEO, SEOWILL | ❌ fehlt komplett |
| **llms.txt-Generierung** | Kanonische Markenfakten-/Citation-Datei für LLMs | StoreSEO, TinyIMG, IndexNow-Apps | ❌ |
| **IndexNow / Instant Indexing** | Echtzeit-Push an Bing/Yandex/AI-Crawler bei jeder Content-Änderung (Google hat seinen Ping abgekündigt) | IndexNow, InstaIndex, SEO Instant Indexer, TinyIMG, SEOWILL | ❌ — **Webhook-Infra für products/collections vorhanden** (articles-Webhook nachzurüsten) |
| **AI-Crawler-Zugriff (robots.txt)** | `OAI-SearchBot`/`PerplexityBot`/`Claude-SearchBot` zulassen (sonst in KI-Shopping unsichtbar), `GPTBot` (Training) bewusst steuern | GEO-Tools, app-übergreifend empfohlen | ❌ |
| **GTIN/Brand im Product-Schema (AI Shopping)** | `gtin13/12/14` + vollständige Attribute; 83 % von ChatGPTs Shopping-Carousel zieht aus dem Google-Shopping-Feed | ChatGPT/Perplexity Shopping, TinyIMG (AI Product Feed) | ⚠️ JSON-LD-Branch ohne `gtin`/vollständige Offer-Felder |
| **Erweiterte Schema-Typen** | FAQ, Review, LocalBusiness, Video, HowTo — über Product/Breadcrumb hinaus | Yoast, StoreSEO, SEOWILL (LocalBusiness), Schema Plus | ⚠️ Branch deckt Product/Collection/Article/Org/Breadcrumb, **nicht** FAQ/LocalBusiness/Video |
| **Internes Linking** | Verlinkungs-Vorschläge/Automatik + Link-Health | SEO Instant Indexer, SEOWILL | ❌ |
| **Manueller Bulk-Meta-Editor** | Spreadsheet-Grid zum direkten Bearbeiten von Titel/Meta/Alt/**Dateiname** über den ganzen Katalog | TinyIMG, Smart SEO, SEO Manager, Booster | ⚠️ wir haben **AI-**Bulk-Fix, kein manuelles Grid |
| **Bild-Dateinamen-SEO** | SEO-Dateinamen, nicht nur Alt-Text | TinyIMG | ❌ (wir: Alt + WebP) |
| **AI-Referral-Tracking** | `ChatGPT.com`/`Perplexity.ai` als Referral-Quelle + Präsenz-Monitoring in AI Overviews | AEO-Tools | ❌ |
| **Open Graph / Twitter Cards** | Social-Share-Vorschau & -Steuerung | app-übergreifend | ⚠️ im Plan nur optional |
| **Lokales SEO / Backlink / Keyword-Gap** | NAP/LocalBusiness, Backlink-Analyse, Wettbewerber-Keywords | SearchPie, SEOWILL | ❌ (teils externe Daten → niedrige Prio) |
| **Auto-Fix/Autopilot — Design-Warnung** | Booster-Autopilot **überschreibt Merchant-Arbeit** (Agenturen raten auf Plus-Builds ab) → unser Prinzip: **opt-in, nicht-destruktiv** | Booster (Negativbeispiel) | Design-Leitplanke |

**Strategische Einordnung:** Shopify syndiziert Kataloge inzwischen **automatisch** an ChatGPT (Agentic Storefronts), Perplexity und Copilot-Checkout. Die App-Wertschöpfung verschiebt sich damit von „Katalog überhaupt sichtbar machen" zu **Schema-Vollständigkeit** (GTIN/Brand/Review/FAQ), **llms.txt**, **IndexNow** und **AI-Crawler-Zugriff** — genau die Hebel, die entscheiden, ob ein Produkt in der KI-Antwort *zitiert* wird. Kombiniert mit unseren bestehenden Stärken (Multi-Provider-AI, BYO-Key, breite Übersetzungsabdeckung) ist **mehrsprachige AEO** ein bislang unbesetzter USP: kein Übersetzungs- **oder** SEO-Konkurrent liefert KI-Search-Optimierung über alle Shop-Locales. Bereits im SEO-Tab-Plan adressiert: hreflang-Audit (Phase 4) und Structured-Data-Basis (Branch `feature/jsonld-structured-data`).

### 2.3 AI Content Generator Apps

| Feature | Unsere App | ChatGPT-AI | WritePilot | Smartli |
|---------|------------|------------|------------|---------|
| Multi-Provider AI | ✅ 6 | ❌ 1 | ❌ 1 | ❌ 1 |
| Custom Prompts | ✅ | ✅ | ✅ | ✅ |
| Multi-Language | ✅ | ✅ 30+ | ✅ | ✅ |
| Bulk-Generierung | 🔄 Queue | ✅ | ✅ | ✅ |
| **Content-Templates** ⁵ | ❌ (bewusst) | ✅ | ✅ | ✅ |
| **Auto-Generate neues Produkt** | ❌ | ✅ | ❌ | ❌ |
| **AI Blog-Post-Generator** | ❌ | ❌ | ✅ | ✅ |
| **AI Image Generator** | ❌ | ❌ | ❌ | ✅ |
| **AI Email/Marketing** | ❌ | ❌ | ❌ | ✅ |
| **AI Social Media Posts** | ❌ | ❌ | ❌ | ✅ |
| **Image-to-Description** | ❌ | ❌ | ❌ | ✅ |

> ⁵ **Content-Templates — bewusst nicht implementiert** (Rollback 2026-07-19): das Feature war vom 2026-07-17 bis 2026-07-19 auf `develop` gemergt und wurde nach Design-Review wieder zurückgezogen. Analyse ergab, dass das Kern-Feature — `{{title}}`/`{{description}}`/`{{language}}`/`{{current_value}}`/`{{field_label}}`-Substitution — der KI **keine Information lieferte, die der Handler nicht bereits als eigene Prompt-Zeilen** (`Context - Title: …`, `Context - Description: …`, `Language: …`, `Current {field}: …`) sendet. Templates duplizierten damit die bestehenden per-Field-Custom-Instructions (AI-Einstellungen) mit einer rein textuellen Umpositionierung der gleichen Info — zwei Konzepte für dieselbe Prompt-Steuerung, kein realer Merchant-Nutzen. Der Rollback ist commit `69e7b8b`; die DB-Migration `20260518100000_add_content_template` wird via Reverse-Migration `20260719130000_drop_content_template` zurückgerollt. **Bedingung für ein Re-Design:** die Variablen müssen dann Daten liefern, die die KI heute noch NICHT bekommt — z. B. `{{brand}}` / `{{price}}` / `{{tags}}` / `{{vendor}}` / `{{product_type}}` / `{{similar_products}}` aus Shopify. Erst dann rechtfertigt sich ein zweites Prompt-Steuerungs-Konzept neben Custom-Instructions.

**Preise der Wettbewerber:**
- ChatGPT-AI: ~$1 pro 100 Beschreibungen
- WritePilot: Paid Plans
- Smartli: Free / Paid Plans

### 2.4 Variant-Image-Gallery-Apps (Nachtrag 2026-06-29)

Eigene Marktkategorie im Shopify App Store: Apps, die **mehrere Bilder pro
Variante** zeigen und beim Variantenwechsel die Galerie variantengerecht
filtern (statt nur ein einzelnes „featured image" pro Variante, wie Shopify
es nativ kann). ContentPilot liefert dieses Modell als Theme-App-Extension-
App-Block (`extensions/storefront/blocks/variant-gallery.liquid` +
`variant-gallery.js/.css`) plus Admin-seitigem **Image Manager**
(`app/components/image-manager/VariantImageManager.tsx`). Speicher: pro
Variante eine Bildliste im Metafield `custom.variant_gallery`; die Storefront
bettet **alle** Galerie-Daten als JSON-Insel ein und schaltet client-seitig
**ohne zusätzlichen HTTP-Request** um. Plan-Gate: **Pro+** (Free/Basic sehen
die native Shopify-Galerie unverändert).

> **Zwei Storefront-Varianten:** (a) der **App-Block** `variant-gallery.js`
> (`cp-variant-gallery`) — schlanke Inline-Galerie (Hauptbild + Thumbnails),
> die der Merchant manuell im Theme-Editor platziert; (b) der **App-Embed**
> `variant-gallery-embed.js` (`cp-embed-gallery`) — ersetzt die native Theme-
> Galerie *in place* und ist die voll ausgestattete Variante: **Lightbox**
> (natives `<dialog>`) + **Klick-Zoom 2×**, Thumbnail-Carousel mit Pfeilen,
> Mobile-Dot-Pagination, Video/3D und **Theme-Settings-Inheritance** (Zoom-
> Modus `lightbox`/`hover`/`none`, Thumbnail-Position/-Layout, Mobile-Thumbs,
> `media_fit`, `constrain_to_viewport` werden aus Dawn übernommen). Die
> Feature-Vergleichstabelle unten bezieht sich auf den App-Embed.

#### Wie unsere Bulk-Auto-Zuweisung funktioniert

Nicht nur manuelles Drag-&-Drop — wir haben eine vollwertige **konventions-
basierte Auto-Zuweisung** (`BulkImageUploadPanel.tsx` + `parseFilenames.ts` +
`api.update-variant-match-key.tsx`):

1. **Zwei Match-Modi:** Abgleich gegen die Varianten-**SKU** *oder* ein
   dediziertes `custom.image_key`-Metafield (für Shops, die ihre SKU nicht
   „verbrauchen" wollen).
2. **Dateinamen-Konvention** `ProductName_Variant1_Variant2_..._Identifier.ext`:
   Beim Drop wird jeder Dateiname geparst und **deterministisch** gegen
   SKU/Image-Key jeder Variante gematcht (Produktname + *alle* Optionssegmente
   müssen exakt passen). Treffer → automatisch der Variantengalerie zugewiesen;
   kein Treffer → „unassigned" (manueller Fallback).
3. **Key-Generator:** Erzeugt SKUs/Image-Keys für *alle* Varianten in einem
   Klick aus Basisname + Optionswerten (Label-Modus: Wert / Handle / Memory,
   inkl. Inline-Chip-Overrides) und schreibt sie via `productVariantsBulkUpdate`
   bzw. `metafieldsSet` nach Shopify zurück.
4. **Cross-Produkt-Option-Value-Memory:** Merkt sich shop-weit
   `Optionswert → Segment` (z. B. „Rot" → „Red"), sodass die Konvention über
   den ganzen Katalog konsistent bleibt — der eigentliche USP für Skalierung.

Unterschied zur Konkurrenz: **Rubik** rät per AI-Bilderkennung (Pixel + Alt-Text/
Dateiname), **SA Automator** gruppiert per Bildreihenfolge im Produkt-Admin.
Unser Ansatz ist **deterministisch/konventionsbasiert** — verlässlicher und
mehr-options-fähig (Color × Size × …), erfordert aber eine Namens-/Key-
Konvention (die Generator + Memory praktisch auf einen Klick reduzieren). Reine
**Bild-Inhalts-Erkennung** (Pixel-AI à la Rubik) haben wir bewusst nicht.

#### Funktions-Vergleich

| Feature | ContentPilot (wir) | Rubik | SA Variant Image Automator | NS Color Swatch | Variant Image Wizard | GG Image Slider |
|---|---|---|---|---|---|---|
| Mehrere Bilder pro Variante | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Variantengerechtes Filtern beim Umschalten | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Kein Layout-Shift / Pre-Paint-FOUC-Fix | ✅ (`variant-gallery-embed`) | ✅ | ✅ | ⚠️ | ⚠️ | ✅ |
| Client-seitig, kein Extra-Request | ✅ | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ⚠️ |
| **Farb-/Bild-Swatches (Produktseite)** | ❌ | ✅ | ✅ | ✅ | ✅ | ⚠️ |
| **Swatches auf Collection-Seiten** | ❌ | ⚠️ | ❌ | ✅ | ❌ | ❌ |
| **Auto-Zuweisung im Bulk** | ✅ (Dateiname↔SKU/Image-Key-Matching) | ✅ AI-Bilderkennung | ✅ per Bildreihenfolge | ⚠️ | ❌ manuell | ⚠️ |
| **Key-Generator + Cross-Produkt-Memory** | ✅ (Option-Value-Memory, 1-Klick-Keys) | ❌ | ❌ | ❌ | ❌ | ❌ |
| Manuelle Drag-&-Drop-Zuweisung (Fallback) | ✅ (Produkt↔Variante) | ✅ | ❌ (nur automatisch) | ⚠️ | ✅ | ⚠️ |
| **Zoom / Lightbox / Fullscreen** | ✅ (App-Embed: `<dialog>`-Lightbox + Klick-Zoom 2×) | ✅ | ✅ | ✅ | ⚠️ | ✅ |
| Video-Support (YouTube/Vimeo) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 3D-Modell-Support | ✅ | ✅ | ✅ | ⚠️ | ⚠️ | ✅ |
| **Kombinierte/getrennte Produkt-Listings** ⁴ | ❌ | ⚠️ | ❌ | ✅ | ✅ (Produkt-Gruppierung) | ❌ |
| Bulk-Upload + WebP-Komprimierung | ✅ (WebP ab Pro) | ❌ | ❌ | ❌ | ❌ | ❌ |
| **AI-Alt-Text + Übersetzung der Alt-Texte** | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Mehrsprachiges App-UI | ✅ (de/en/es) | ✅ 15 Spr. | ⚠️ | ⚠️ | ⚠️ | ⚠️ |
| Built for Shopify | — | ✅ | ❌ | ❌ | ❌ | ❌ |

> ⚠️ = teilweise / nicht beworben / unklar. Quellen siehe §5.
>
> ⁴ **Kombinierte/getrennte Produkt-Listings** — zwei gegenläufige Merchandising-
> Funktionen, die die Grenze „ein Produkt mit Varianten" ↔ „mehrere eigenständige
> Produkte" auflösen:
> • **Kombiniert** (combined listing): mehrere *separate* Produkte (z. B. „T-Shirt
>   Rot", „T-Shirt Blau" als eigene Handles/Inventar/SEO-URLs) werden auf der PDP
>   über Swatches zu *einer* erlebten Produktseite verknüpft. Motivation: Farben
>   müssen aus Inventar-/SEO-/Feed-Gründen eigene Produkte sein, sollen sich für
>   den Kunden aber wie ein Produkt anfühlen. (Shopify bietet inzwischen ein
>   natives „Combined Listings".)
> • **Getrennt** (split listing): das Gegenteil — ein Produkt mit Varianten wird
>   im Storefront in mehrere Einträge gesplittet, z. B. auf der Collection-Seite
>   pro Farbe eine eigene Kachel mit Variantenbild statt einer Produktkachel.
>   Motivation: mehr „Regalfläche"/Sichtbarkeit je Variante, direkterer Klickpfad.
> Das ist eine **Katalog-/Merchandising-Struktur-Funktion**, keine reine Bild-
> Funktion — daher nur teilweise im Scope einer Variant-Gallery. Wir haben weder
> Kombinieren noch Splitten (❌); unser Modell arbeitet strikt *innerhalb* eines
> Produkts. Niedrige Priorität gegenüber den Swatches.

**Preise & Ratings der Wettbewerber (Stand 2026-06, USD/Monat):**

| App | Free | Spanne | Rating (Reviews) | Besonderheit |
|-----|------|--------|------------------|--------------|
| Rubik Variant Images & Swatch | ✅ (1 Prod., 50 AI-Bilder) | $25 / $50 / $75 | 5.0 (394) | AI-Auto-Assign, Built for Shopify |
| SA Variant Image Automator | install frei | $9.90–$49.90 | 4.9 (430+) | Auto-Gruppierung per Bildreihenfolge |
| NS Color Swatch Variant Images | ✅ | $7.99–$14.99 | 4.9 (104+) | Swatches auch auf Collection-Seiten |
| Variant Image Wizard + Swatch | ✅ | $4.99–$7.99 | 4.9 (233+) | Günstigster Einstieg, Drag-&-Drop |
| GG Product Page Image Slider | ✅ | $8.99 | 4.9 (167) | Slider/Lightbox/Zoom, Video/3D |
| **ContentPilot (wir)** | — (Pro+ €19.90) | Teil der Suite | — | In Content-/Übersetzungs-Suite gebündelt |

#### Einordnung

**Unsere Stärken in dieser Kategorie:**
- **Kein Einzweck-Add-on, sondern Teil der Suite** — der Merchant zahlt nicht
  separat $5–$75/Monat nur für Variantenbilder; das Feature kommt als
  Mehrwert in einem ohnehin gekauften Pro-Plan.
- **Einzigartig: AI-Alt-Text + Übersetzung der Alt-Texte** — kein reiner
  Variant-Gallery-Konkurrent übersetzt Bildbeschreibungen mehrsprachig oder
  generiert sie per AI. Direkter Hebel auf unsere Kern-USPs (Multi-Provider-
  AI, BYO-Key, breite Übersetzungsabdeckung).
- **Integrierte WebP-Komprimierung + Bulk-Upload** — die Standalone-Apps
  fassen nur Zuweisung/Anzeige an, nicht die Bildoptimierung.
- **Vollwertige Bulk-Auto-Zuweisung** (siehe oben) — deterministisches
  Dateiname↔SKU/Image-Key-Matching mit Key-Generator und **Cross-Produkt-
  Option-Value-Memory**. Letztere hat in dieser Form **kein** Konkurrent;
  sie macht die Zuweisung über den ganzen Katalog hinweg konsistent.
- **Performance-Parität mit der Spitze** — Pre-Paint-FOUC-Fix
  (`variant-gallery-embed`), reservierte `aspect-ratio` gegen Layout-Shift,
  client-seitiges Umschalten ohne Extra-Request (wie Rubik/GG).
- **Video + 3D-Modelle** — Parität mit den Top-Apps.
- **Lightbox + Klick-Zoom** — der App-Embed bringt eine selbstgebaute
  `<dialog>`-Lightbox und 2×-Klick-Zoom mit; der Zoom-Modus wird sogar aus dem
  Theme-Setting (`image_zoom`: lightbox/hover/none) geerbt. Parität mit NS, GG,
  SA.

**Echte Lücken (Wettbewerber liefern, wir nicht):**
1. **Farb-/Bild-Swatches auf der Produktseite** — das ist das *Leitfeature*
   fast aller Konkurrenten (Rubik, NS, Wizard, SA). Wir zeigen nur Galerie +
   Thumbnails, keine klick-/hover-baren Variant-Swatches. **Größte Lücke.**
2. **Swatches auf Collection-Seiten** — NS bewirbt das prominent; verbessert
   Conversion vor dem PDP-Klick.
3. **Kein eigener Free/Einstiegs-Tarif** — Konkurrenten holen Merchants ab
   $4.99 oder gratis ab; bei uns erst ab Pro (€19.90). Da das Feature aber im
   Suite-Kontext steht, ist das nur bedingt ein Nachteil.

**Kein Gap (Korrekturen 2026-06-29):**
- *Auto-Zuweisung* ist **vorhanden** — deterministisches Bulk-Matching via
  SKU/Image-Key + Key-Generator + Cross-Produkt-Option-Value-Memory (siehe
  „Wie unsere Bulk-Auto-Zuweisung funktioniert"). Wir verzichten lediglich
  bewusst auf reine **Pixel-AI-Bilderkennung** (Rubik); unser konventions-
  basierter Weg ist deterministischer und mehr-options-fähig. Optionaler
  Ausbau: eine AI-**Heuristik** (Alt-Text/Dateiname → Optionswert) als
  Komfort-Layer *über* dem bestehenden Matching.
- *Zoom / Lightbox / Fullscreen* ist **vorhanden** — der App-Embed
  (`variant-gallery-embed.js`) bringt eine `<dialog>`-Lightbox + 2×-Klick-Zoom
  mit, Modus aus dem Theme geerbt. (Nur der schlanke App-**Block**
  `variant-gallery.js` hat das nicht — bewusst, er ist die Minimal-Variante.)

**Empfehlung:** Wenn die Kategorie ausgebaut werden soll, ist **Variant-
Swatches auf der Produktseite** (Lücke #1) der mit Abstand wichtigste — und
nach den Korrekturen oben praktisch **einzige** — *funktionale* Hebel gegenüber
der Spitze. Es ist das definierende Feature der Kategorie. Nicht vergessen zu
*vermarkten*: AI-Alt-Text + Übersetzung der Bildbeschreibungen **und** die
Cross-Produkt-Memory der Bulk-Zuweisung kann **kein** Variant-Gallery-
Konkurrent — das sind hier unsere unbesetzten USPs.

---

## 3. Fehlende Features

### 3.1 Kritisch (Wettbewerbsnachteil)

Diese Features haben die meisten Wettbewerber und Kunden erwarten sie:

| # | Feature | Impact | Aufwand | Wettbewerber |
|---|---------|--------|---------|--------------|
| 1 | **JSON-LD Structured Data** | Hoch | Mittel | Yoast, SEOWILL, StoreSEO |
| 2 | **Rich Snippets (Product, Review, Breadcrumb)** | Hoch | Mittel | Yoast, SEOWILL, StoreSEO |
| ~~3~~ | ~~**Glossar/Terminologie-Management**~~ ✅ erledigt (2026-07, Settings-Tab „Glossar" + zentrale Prompt-Injektion in `src/services/ai.service.ts`) | — | — | — |
| ~~4~~ | ~~**Language/Currency Switcher Widget**~~ ✅ erledigt (2026-06, `extensions/storefront/blocks/locale-switcher.liquid`) | — | — | — |
| ~~5~~ | ~~**Content-Templates/Vorlagen**~~ ⛔ **bewusst nicht** (Rollback 2026-07-19 nach 2-Tage-Test auf `develop`; `{{variables}}` lieferten der KI keine Info, die sie nicht ohnehin über die Handler-Context-Zeilen bekam — siehe §2.3 Fußnote ⁵) | — | — | — |

#### Details:

**1. JSON-LD Structured Data**
```
Was fehlt:
- Product Schema (Preis, Verfügbarkeit, SKU, Brand)
- Organization Schema
- BreadcrumbList Schema
- Article Schema für Blogs
- Review/AggregateRating Schema

Warum wichtig:
- Google zeigt Rich Snippets in Suchergebnissen
- Bessere Klickrate (CTR)
- Voraussetzung für Google Shopping
```

**2. Glossar/Terminologie-Management**
```
Was fehlt:
- Glossar-Datenbank pro Shop
- Begriffe die nicht übersetzt werden sollen
- Begriffe mit fester Übersetzung
- Import/Export von Glossaren

Warum wichtig:
- Marken-Konsistenz (Produktnamen bleiben gleich)
- Fachbegriffe korrekt übersetzen
- Vermeidung von Fehlübersetzungen
```

**3. Language/Currency Switcher Widget**
```
Was fehlt:
- Frontend-Komponente für Kunden
- Dropdown oder Flags für Sprachwahl
- Integration ins Theme
- Konfigurierbare Position/Styling

Warum wichtig:
- Kunden können selbst Sprache wählen
- Standard-Feature aller Translation-Apps
- Ohne Widget: Übersetzungen nutzlos für Kunden
```

**4. Content-Templates/Vorlagen — ⛔ zurückgezogen (2026-07-19)**

Feature war vom 2026-07-17 bis 2026-07-19 auf `develop` gemergt und in einem
2-Tages-Design-Review wieder entfernt. Historie:

- **2026-07-17** — Aus `origin/feature/content-templates` (b4be11f, Mai 2026) cherry-picked und an aktuelles develop angepasst: `ContentTemplate`-Prisma-Model, Substitution-Util, CRUD-Service mit Single-Default-Invariante, Settings-Tab „Vorlagen" (Pro/Max), Integration in `text-generation.handler.ts`, GDPR-Purge, 40 Unit-Tests. Merge-Commit `266b00a`.
- **2026-07-19** — Nach kritischer Nutzerfrage („Ist die neue Vorlage und die KI-Instruktionen nicht redundant? Welche Infos kriegt die KI durch `{{variables}}` überhaupt, die sie sonst nicht hätte?") ergab die Analyse:
  - Alle 6 unterstützten Variablen (`{{title}}`, `{{name}}`, `{{product_name}}`, `{{description}}`, `{{current_value}}`, `{{language}}`, `{{field_label}}`) landeten in Werten, die der Handler ohnehin schon als eigene Prompt-Zeilen sendet (`Context - Title: …`, `Context - Description: …`, `Current {label}: …`, `Language: …`).
  - Templates duplizierten damit die bestehenden per-Field-Custom-Instructions (AISettings) mit rein **textueller Umpositionierung** derselben Info. Zwei Prompt-Steuerungs-Konzepte für den identischen Effekt.
  - Rollback-Commit `69e7b8b` — alle Feature-Dateien, Handler-Blöcke, Plan-Flag, i18n, Route-Integration entfernt; Reverse-Migration `20260719130000_drop_content_template` rollt die DB-Änderung beim nächsten Railway-Deploy zurück.

**Bedingung für einen späteren Wiedereinstieg:** die Variablen müssen dann Informationen liefern, die die KI heute NICHT bekommt — z. B. `{{brand}}`, `{{price}}`, `{{tags}}`, `{{vendor}}`, `{{product_type}}`, `{{similar_products}}`, `{{previous_generation}}` aus Shopify-Daten, die im Handler heute nicht durchgereicht werden. Solange die Variablen nur bestehende Context-Werte spiegeln, decken Custom-Instructions denselben Bedarf ab, ohne den Merchant vor eine zweite Konfigurationsfläche zu stellen.

---

### 3.2 Hoch (Deutlicher Mehrwert)

| # | Feature | Impact | Aufwand | Wettbewerber |
|---|---------|--------|---------|--------------|
| 6 | **Währungsumrechnung** | Hoch | Hoch | Transcy, LangShop, Hextom |
| 7 | **Geolocation Auto-Detect** | Mittel | Mittel | Transcy, Weglot, LangShop |
| 8 | **Google Search Console Integration** | Mittel | Mittel | Yoast, StoreSEO |
| 9 | **Broken Link Detection & Auto-Redirect** | Mittel | Mittel | SEOWILL |
| 10 | **AI Blog-Post-Generator** | Mittel | Niedrig | SEOWILL, WritePilot, Smartli |
| 11 | **Sitemap-Generierung** | Niedrig | Niedrig | SEOWILL, StoreSEO |

#### Details:

**6. Währungsumrechnung**
```
Was fehlt:
- Automatische Währungskonvertierung
- Tägliche Wechselkurs-Updates
- Rounding-Regeln (z.B. 9,99 statt 9,87)
- Multi-Currency Checkout

Warum wichtig:
- Internationale Kunden sehen lokale Preise
- Höhere Conversion-Rate
- Kombiniert mit Geolocation sehr mächtig
```

**7. Geolocation Auto-Detect**
```
Was fehlt:
- IP-basierte Standorterkennung
- Automatische Sprach-/Währungswahl
- Redirect-Optionen
- Cookie-basierte Präferenz-Speicherung

Warum wichtig:
- Kunden sehen sofort ihre Sprache
- Bessere User Experience
- Weniger Absprünge
```

**8. Google Search Console Integration**
```
Was fehlt:
- OAuth-Verbindung zu GSC
- Indexierungs-Status anzeigen
- Suchanfragen-Daten
- Klick/Impression-Statistiken
- Fehler-Benachrichtigungen

Warum wichtig:
- SEO-Performance direkt in der App
- Keine Notwendigkeit für externes Tool
- Actionable Insights
```

**9. Broken Link Detection**
```
Was fehlt:
- Crawler für interne/externe Links
- 404-Erkennung
- Automatische Redirects erstellen
- Link-Status-Dashboard

Warum wichtig:
- 404-Fehler schaden SEO-Ranking
- Automatische Behebung spart Zeit
- Bessere User Experience
```

**10. AI Blog-Post-Generator**
```
Was fehlt:
- Vollständige Artikel generieren (nicht nur Beschreibungen)
- Outline-Erstellung
- Abschnitte mit Überschriften
- SEO-optimierte Struktur
- Interne Verlinkung vorschlagen

Warum wichtig:
- Content-Marketing automatisieren
- SEO durch regelmäßige Blog-Posts
- Zeitersparnis bei Content-Erstellung
```

---

### 3.3 Mittel (Nice-to-Have)

| # | Feature | Impact | Aufwand | Wettbewerber |
|---|---------|--------|---------|--------------|
| 12 | **Page Speed Optimization** | Mittel | Hoch | SEOWILL |
| ~~13~~ | ~~**Image Compression**~~ ✅ **bereits abgedeckt** via WebP-Konvertierung ab Pro (`webp-processor.service.js`) — kein Gap | — | — | — |
| 14 | **Auto-Generate bei neuem Produkt** | Mittel | Niedrig | ChatGPT-AI |
| 15 | **Keyword Research/Tracking** | Niedrig | Mittel | Yoast, SEOWILL, StoreSEO |
| 16 | **Third-Party-App-Übersetzung** | Niedrig | Hoch | Transcy, Weglot, LangShop |
| ~~17~~ | ~~**Checkout-Übersetzung**~~ ✅ **erledigt** (2026-06, `shopify.checkout.*` in LOCALE_CONTENT) — kein Gap | — | — | — |
| 18 | **Readability Analysis** | Niedrig | Niedrig | Yoast |

---

### 3.4 Optional (Differenzierung)

| # | Feature | Impact | Aufwand | Wettbewerber |
|---|---------|--------|---------|--------------|
| 19 | AI Image Generator | Niedrig | Hoch | Smartli |
| 20 | AI Social Media Posts | Niedrig | Niedrig | Smartli |
| 21 | AI Email/Marketing Content | Niedrig | Niedrig | Smartli |
| 22 | Image-to-Description (AI Vision) | Niedrig | Mittel | Jobto AI |
| 23 | AMP Support | Niedrig | Hoch | SEOWILL |
| 24 | Bild-Übersetzung (OCR) | Niedrig | Hoch | Transcy |
| 25 | Google Analytics Integration | Niedrig | Mittel | StoreSEO |

---

## 3.5 Gap-Kontext & Priorisierung (Stand 2026-05)

> ⏸️ **Status: NICHT eingeplant.** Erst Bugfixes, dann Feature-Arbeit. Dieser
> Abschnitt hält nur den Kontext fest, damit nichts verloren geht — keine
> Umsetzungs-Zusage.
>
> **Limit-Befunde 1–4 sind alle erledigt** (Commit `1327432`, 2026-05):
> Befund 3 = `monthlyImageOperations`-Quota (Free/Basic 0, Pro 2000, Max
> 10000), erzwungen an `api.staged-upload`/`api.convert-webp`. Befund 4 =
> Pro/Max kosten-aligned differenziert über Bild-Quota **+ WebP-Parallelität
> gespreizt (Pro 2 / Max 6)**, zentralisiert in `config/webp-concurrency.js`
> (Drift-Bug behoben). Details → `ROADMAP.md` §Limit-Review.

### 🔴 Kritisch

**1. Language/Currency-Switcher-Widget (Storefront).** ✅ **ERLEDIGT (2026-06).**
Theme App Extension `extensions/storefront/blocks/locale-switcher.liquid`
(+ `assets/locale-switcher.{js,css}`, `assets/flags.svg`, Locales) liefert
einen sichtbaren Sprach-/Währungs-Switcher (Dropdown mit Flaggen, Header-/
Footer-Position, Auto-Compact ab schmalem Viewport, Merged-Mode für Mobile,
konfigurierbare Settings). Damit ist die einzige echte Funktionslücke
geschlossen — Übersetzungen sind für Endkunden ohne Theme-Editing sichtbar.

**2. Glossar/Terminologie-Management.** ✅ erledigt (2026-07). Begriffsdatenbank
pro Shop: „nie übersetzen" / „immer exakt so übersetzen" pro Zielsprache,
Settings-Tab „Glossar" mit Locale-Buttons, CSV-Import/Export. Injektion sitzt
zentral in `AIService` (nur Begriffe, die im Quelltext vorkommen), deckt also
alle Übersetzungspfade ab (Editoren, Theme-Content, Direct Translations,
Alt-Texte, SEO).

**3. JSON-LD Structured Data.** Maschinenlesbares Markup (Product/Breadcrumb/
Article/Review) → Rich Snippets in Google (Sterne, Preis, Verfügbarkeit) +
Voraussetzung für Google Shopping. Wir generieren SEO-Titel/Meta schon, aber
nicht den CTR-wirksamen strukturierten Teil. Umsetzung = Service, der JSON-LD
aus vorhandenen Daten erzeugt und ins Theme injiziert.

**4. ~~Content-Templates/Vorlagen.~~** ⛔ **bewusst zurückgezogen (2026-07-19).**
Feature war 2 Tage auf `develop` gemergt, Analyse ergab dass die `{{variables}}`
(title/description/language/current_value/field_label) der KI keine Info
lieferten, die sie nicht über die existierenden Handler-Context-Zeilen bereits
bekam — reine textuelle Umpositionierung. Damit deckte das Konzept die
Custom-Instructions doppelt ab, ohne dem Merchant echten Zusatzwert zu bieten.
Ein späterer Wiedereinstieg lohnt nur, wenn neue Variablen echte Zusatz-Info
bringen (`{{brand}}`, `{{price}}`, `{{tags}}`, `{{vendor}}`, `{{product_type}}`).
Details → §3.1 Punkt 5 / §2.3 Fußnote ⁵.

### 🟠 Hoch

- **Geolocation Auto-Detect** — IP-basierte Auto-Sprach-/Währungswahl;
  funktioniert nur sinnvoll *mit* #1 gekoppelt. Mittlerer Aufwand.
- **Währungsumrechnung** — ⚠️ **kein echter Gap mehr** (Stand 2026-06):
  Shopify Markets + Shopify Payments rechnet **nativ** mit aktuellen
  Marktwechselkursen um — Anzeige, Checkout *und* Refunds. Conversion-Fee
  Shopify-seitig (0,5–2 % je nach Plan). Eigene Umsetzung würde Shopify-
  Bordmittel duplizieren. Restwert nur in Edge-Cases: Händler **ohne**
  Shopify Payments (PayPal-only, nicht unterstützte Länder), reiner
  Display-Switcher für Märkte ohne Markets-Konfig, Custom-Rundung
  (9,99 statt 9,87). Empfehlung: **nicht als Vollfeature bauen**, ggf.
  schmaler Display-Switcher + Rundungsregeln als Pro-Add-on. Details →
  [ROADMAP.md](../ROADMAP.md) §4.3.
- **AI Blog-Post-Generator** — ganze Artikel statt nur Beschreibungen. Niedriger
  Aufwand (AI-Infra steht), guter Marketing-Hebel.
- **Google Search Console Integration** — Indexierung/Klicks/Impressionen in der
  App. Mittel; macht aus „Content-Ersteller" einen SEO-Feedback-Loop.
- **Broken-Link-Detection & Auto-Redirect** — 404-Crawler + Auto-Redirects;
  404er schaden Ranking. Mittlerer Aufwand.

### 🟡/🟢 Niedrig
Page-Speed, Auto-Generierung bei `products/create`, Keyword-Research;
optionale Differenzierer (AI-Bildgenerierung, Social/Email-Content,
Image-to-Description, OCR). Nice-to-have, kein Kaufentscheidungs-Treiber.
(Image Compression = ✅ via WebP, kein Gap. Checkout-Übersetzung = ✅ via
LOCALE_CONTENT, kein Gap. Third-Party-App-Übersetzung = ✅ via Direct
Translations, siehe §2.1 Fußnote ².)

### Strategisches Big Picture (aktualisiert 2026-07-19)
Die früheren „kritischen" Schwächen sind alle geschlossen: Switcher-Widget
(2026-06), Glossar (2026-07), JSON-LD + kompletter SEO-Tab (2026-07). Der
5. Kandidat auf der Kritikum-Liste — **Content-Templates** — wurde ausprobiert
und bewusst wieder zurückgezogen (siehe §3.1 Punkt 5), weil die
`{{variables}}` in der aktuellen Form der KI keine zusätzliche Information
lieferten und damit die bestehenden Custom-Instructions redundant duplizierten.
Damit ist die „Kritikum-Liste" leer, und der Fokus verschiebt sich auf
**Vermarktung** der geschlossenen Lücken + der USPs (mehrsprachige AEO,
Foreign-Locale-SEO-Audit, unbegrenzte Sprachen, BYO-Key, Multi-Provider-AI,
6-Provider-Breite).

**Empfohlene Reihenfolge (wenn Bugs erledigt):** ~~#1 Switcher-Widget~~ ✅
erledigt → ~~#2 Glossar~~ ✅ erledigt → ~~#3 JSON-LD~~ ✅ erledigt (2026-07,
kompletter SEO-Tab) → ~~#4 Content-Templates~~ ⛔ zurückgezogen. **Nächste
sinnvolle Kandidaten sind keine „Kritika" mehr, sondern Hoch-Prio-Erweiterungen:**
AI Blog-Post-Generator (§3.2 #10, AI-Infra steht) oder Geolocation Auto-Detect
(§3.2 #7, koppelt mit dem Switcher). Beides ist Ausbau, keine Basis-Erwartung.

---

## 4. Implementierungs-Roadmap

### Phase 1: Kritische Lücken schließen

**Ziel:** Wettbewerbsfähigkeit bei Kernfeatures herstellen

#### 1.1 JSON-LD Structured Data
- [ ] Product Schema implementieren
- [ ] BreadcrumbList Schema
- [ ] Organization Schema
- [ ] Article Schema für Blogs
- [ ] Review Integration (judge.me, Loox, etc.)
- [ ] Schema-Validierung in SEO-Sidebar

**Technische Umsetzung:**
```typescript
// Neuer Service: app/services/structured-data.service.ts
// JSON-LD in Theme injizieren oder als Code-Block ausgeben
// Integration mit bestehenden Product/Collection-Daten
```

#### 1.2 Glossar-Management ✅ erledigt (2026-07)
- [x] Glossar-Datenmodell (`GlossaryEntry` + `GlossaryEntryTranslation`, prisma/schema.prisma)
- [x] Glossar-UI in Settings (Tab „Glossar" mit Locale-Buttons, `SettingsGlossaryTab.tsx`)
- [x] Begriffe hinzufügen/bearbeiten/löschen
- [x] "Nicht übersetzen" Option (pro Begriff, gilt für alle Sprachen)
- [x] "Feste Übersetzung" Option (pro Zielsprache)
- [x] Glossar beim Übersetzen anwenden (zentral in `AIService`, alle Übersetzungspfade)
- [x] Import/Export (CSV)

Umgesetzt mit einem Entry-plus-per-Locale-Übersetzungen-Datenmodell (ersetzt
den früher hier skizzierten flachen `GlossaryTerm`-Entwurf).

#### 1.3 Content-Templates — ⛔ zurückgezogen (2026-07-19)

Feature war vom 2026-07-17 bis 2026-07-19 in einem 2-Tages-Sprint komplett
integriert (`ContentTemplate`-Model + Migration + Service + `{{variable}}`-
Substitution + Settings-Tab + Handler-Integration in generate/format + Plan-Gate
Pro/Max + GDPR-Purge + 40 Unit-Tests + i18n in de/en/es, alles auf `develop`).

Nach kritischem Nutzer-Review komplett zurückgezogen — die Variablen boten der
KI keine Info, die sie nicht ohnehin über die Handler-Prompt-Zeilen bekam.
Reverse-Migration `20260719130000_drop_content_template` räumt die DB-Tabelle
beim nächsten Deploy weg. Details → §3.1 Punkt 5 (Rollback-Historie) + §2.3
Fußnote ⁵ (Analyse).

**Bedingung für einen späteren Re-Einstieg** (nicht eingeplant):
Variablen müssten Zusatz-Info liefern, die der Handler heute NICHT
durchreicht — z. B. `{{brand}}`, `{{price}}`, `{{tags}}`, `{{vendor}}`,
`{{product_type}}`, `{{similar_products}}`, `{{previous_generation}}` aus
Shopify-Daten. Pro neuer Variable ~30 min Aufwand (GraphQL-Feld im Handler
laden + in `vars`-Objekt reichen).

---

### Phase 2: Wettbewerbsfähigkeit stärken

#### 2.1 Language/Currency Switcher Widget ✅ ERLEDIGT (2026-06)
- [x] Embeddable Widget entwickeln — `extensions/storefront/blocks/locale-switcher.liquid`
- [x] Theme App Extension — als App Block in `extensions/storefront`
- [x] Konfigurierbare Styles (Dropdown, Flags) — `assets/flags.svg`, Settings im Liquid-Block
- [x] Position wählbar (Header, Footer) — Footer als Default, Auto-Compact ab schmalem Viewport
- [x] Sprache **und** Währung im selben Switcher — Merged-Mode für sehr schmale Viewports
- [x] Installation: Standard-Shopify-App-Block-Workflow (kein eigener Guide nötig)

#### 2.2 AI Blog-Post-Generator
- [ ] Neuer Content-Typ "Blog Post" in AI-Generierung
- [ ] Outline-Generator (Struktur vorschlagen)
- [ ] Abschnitts-weise Generierung
- [ ] SEO-Keywords einbeziehen
- [ ] Interne Links vorschlagen
- [ ] Featured Image vorschlagen

#### 2.3 Google Search Console Integration
- [ ] OAuth 2.0 Flow für GSC
- [ ] API-Anbindung
- [ ] Dashboard mit Key Metrics
- [ ] Indexierungs-Status pro Seite
- [ ] Suchanfragen anzeigen
- [ ] Fehler-Benachrichtigungen

---

### Phase 3: Premium-Features

#### 3.1 Geolocation + Währungsumrechnung
- [ ] IP-Geolocation-Service integrieren
- [ ] Währungs-API (Exchange Rates)
- [ ] Auto-Detect beim ersten Besuch
- [ ] Präferenz in Cookie speichern
- [ ] Rounding-Regeln konfigurierbar
- [ ] Integration mit Language Switcher

#### 3.2 Auto-Generate bei neuem Produkt
- [ ] Webhook für `products/create` erweitern
- [ ] Automatische AI-Generierung triggern
- [ ] Konfigurierbar (an/aus, welche Felder)
- [ ] Queue-Integration
- [ ] Benachrichtigung wenn fertig

#### 3.3 Broken Link Detection
- [ ] Link-Crawler implementieren
- [ ] Regelmäßiger Scan (Cron Job)
- [ ] 404-Erkennung
- [ ] Dashboard mit kaputten Links
- [ ] Auto-Redirect erstellen
- [ ] Email-Benachrichtigung

---

## 5. Quellen

### Übersetzungs-Apps
- [Transcy: AI Language Translate](https://apps.shopify.com/transcy-multiple-languages)
- [Weglot: AI & Human Translate](https://apps.shopify.com/weglot)
- [LangShop AI Language Translate](https://apps.shopify.com/langshop)
- [T Lab AI Language Translate](https://apps.shopify.com/content-translation)
- [Shopify Translate & Adapt](https://apps.shopify.com/translate-and-adapt)

### Tag-Übersetzung (Recherche 2026-08, Fußnote ⁶)
- [Shopify: Manage translations of merchant-provided content](https://shopify.dev/docs/apps/build/markets/manage-translated-content)
- [Shopify Help: Localization and translation](https://help.shopify.com/en/manual/international/localization-and-translation)
- [Shopify Help: Adding filters with Shopify Search & Discovery](https://help.shopify.com/en/manual/online-store/storefront-search/search-and-discovery-filters)
- [LangShop: Translate resource tags](https://help.langshop.app/hc/en-us/articles/360018542080-Translate-resource-tags)
- [LangShop: What is a localized theme?](https://help.langshop.app/hc/en-us/articles/360013653339-What-is-localized-theme-)
- [langify: Product translations (Polyfill)](https://support.langify-app.com/support/solutions/articles/11000082051-product-translations)
- [langify: Collection Filter Translation — Metafields vs. Custom Content](https://support.langify-app.com/support/solutions/articles/11000136165-collection-filter-translations)
- [Weglot: Shopify Translate & Adapt limitations](https://www.weglot.com/blog/shopify-translate-adapt-limitations)
- [FacetGuard: Translating Filter Values with Shopify Metafields](https://www.facetguard.com/blog/translating-filter-values-shopify-metafields)
- [Shopify Community: Translation for filters content (Tags / Product option)](https://community.shopify.com/t/translation-for-filters-content-standard-from-tags-and-product-option-set-size/229788)

### SEO-Apps
- [Yoast SEO for Shopify](https://apps.shopify.com/yoast-seo)
- [SEOWILL (formerly SEOAnt)](https://apps.shopify.com/seo-master)
- [StoreSEO](https://apps.shopify.com/storeseo)
- [Schema Plus for SEO](https://apps.shopify.com/schema-plus)

### Variant-Image-Gallery-Apps
- [Rubik Variant Images & Swatch](https://apps.shopify.com/rubik-variant-images)
- [SA Variant Image Automator](https://apps.shopify.com/variant-image-automator)
- [NS Color Swatch Variant Images](https://apps.shopify.com/ns-product-variants-options)
- [Variant Image Wizard + Swatch](https://apps.shopify.com/variant-image-wizard)
- [Easy Variant Images](https://apps.shopify.com/easy-variant-images)
- [Best Shopify Variant Image Gallery Apps (NestScale)](https://nestscale.com/blog/best-shopify-variant-image-gallery-apps.html)
- [How to choose a variant images & swatch app (Craftshift, 2026)](https://craftshift.com/how-to-choose-the-right-variant-images-swatch-app-for-shopify-store-2026/)

### AI Content Generator Apps
- [ChatGPT-AI Product Description](https://apps.shopify.com/automated-description-writing)
- [WritePilot ChatGPT AI Content](https://apps.shopify.com/ai-content-generator-by-amasty)
- [Smartli (ChatGPT: 9 AI Tools)](https://apps.shopify.com/smartli-ai-product-description)
- [SEO On: AI Product Description](https://apps.shopify.com/ai-product-copy)

### Marktanalysen
- [Best Shopify AI Tools 2026](https://txtcartapp.com/blog/best-shopify-ai-tools/)
- [Best Translation Apps for Shopify 2026](https://blog.adnabu.com/shopify/best-translation-apps-for-shopify/)
- [Best Shopify SEO Apps 2026](https://litextension.com/blog/best-shopify-seo-apps/)
- [Best Shopify AI Product Description Apps 2026](https://instant.so/blog/best-shopify-app-ai-product-description)

---

## Changelog

| Datum | Änderung |
|-------|----------|
| 2026-01-27 | Initiale Erstellung der Wettbewerbsanalyse |
| 2026-05-18 | Preise/Ratings Mai 2026; Image Compression als ✅ (WebP ab Pro) korrigiert; §3.5 Gap-Kontext & Priorisierung ergänzt (Status: nicht eingeplant, Bugs zuerst) |
| 2026-05-18 | §3.5-Banner nachgezogen: Limit-Befunde 1–4 alle erledigt (Commit 1327432) — Befund 4 via Bild-Quota + WebP-Spreizung Pro 2/Max 6; Template-Verweise auf „zusätzliches Differenzial" entschärft |
| 2026-06-25 | **Full Translation Coverage ausgeliefert** (T&A-Parität): Checkout-Übersetzung ❌→✅ (§2.1 + Fußnote ³); neue übersetzbare Flächen in §1.2 (E-Mail/Versand/Filter/Shop-Metadaten/Cookie-Banner/Zahlung/Lieferschein/Abo-Pläne); §1.2-Coverage-Tabelle inkl. 3 Flächen über T&A hinaus (PAYMENT_GATEWAY, PACKING_SLIP_TEMPLATE, SELLING_PLAN*); §3.3 Zeile 17 (Checkout) als erledigt markiert; §3.5-Niedrig nachgezogen |
| 2026-06-29 | **§2.4 Nachtrag — Variant-Image-Gallery-Apps** ergänzt (Web-Recherche 06/2026): Vergleich unseres Variant-Gallery-App-Blocks + Image Managers mit Rubik, SA Variant Image Automator, NS Color Swatch, Variant Image Wizard, GG Image Slider. Stärken: Suite-Bündelung, AI-Alt-Text + Übersetzung der Alt-Texte (unbesetzter USP), WebP/Bulk-Upload, Video/3D, Pre-Paint-FOUC-Fix. Lücken: Produktseiten-**Swatches** (#1), Collection-Swatches, Zoom/Lightbox, kein Free/Einstiegs-Tarif. Quellen in §5 ergänzt. |
| 2026-06-29 | **§2.4 Korrektur — Lightbox/Zoom** ist vorhanden (war fälschlich als Lücke gelistet): der App-**Embed** `variant-gallery-embed.js` hat eine selbstgebaute `<dialog>`-Lightbox (`_bindLightbox`/`_openLightbox`) + 2×-Klick-Zoom (`_bindScaleZoom`), Zoom-Modus aus Dawns `image_zoom`-Setting geerbt. Erste Analyse hatte nur den schlanken App-**Block** `variant-gallery.js` geprüft. Intro um „Zwei Storefront-Varianten" ergänzt; Lücken-Liste auf nur noch Produktseiten-Swatches + Collection-Swatches + Free-Tarif reduziert. |
| 2026-06-29 | **§2.4 Korrektur — Bulk-Auto-Zuweisung** ist vorhanden (war fälschlich als Lücke gelistet): deterministisches Dateiname↔SKU/Image-Key-Matching (`BulkImageUploadPanel.tsx`, `parseFilenames.ts`, `api.update-variant-match-key.tsx`) + 1-Klick-Key-Generator + Cross-Produkt-Option-Value-Memory (eigener USP, kein Konkurrent hat das). Neuer Erklär-Block, zwei neue Tabellenzeilen; „Auto-Zuweisung" aus der Lücken-Liste entfernt — bewusster Verzicht nur auf Pixel-AI-Bilderkennung (Rubik). |
| 2026-06-29 | **§2.2.1 Nachtrag — übersehene & neue Funktionsweisen** ergänzt (Web-Recherche 06/2026): AEO/GEO als definierender 2026-Layer, llms.txt, IndexNow/Instant-Indexing, AI-Crawler-Zugriff (robots.txt), GTIN/Brand im Product-Schema für AI-Shopping, erweiterte Schema-Typen (FAQ/Review/LocalBusiness/Video), internes Linking, manueller Bulk-Meta-Editor, Bild-Dateinamen-SEO, AI-Referral-Tracking, OG/Twitter-Cards, Autopilot-Design-Warnung. Strategie: **mehrsprachige AEO** als unbesetzter USP. Wurde als SEO-Tab Phase 0–8 umgesetzt (siehe folgender Eintrag) und lebt heute unter `app/routes/app.seo.*.tsx` mit dem Contract in `docs/architecture/SEO_SECTION_CONTRACT.md`. |
| 2026-07-19 | **SEO-Tab Phasen 0–8 ausgeliefert** — kompletter Umbau von §1.4/§2.2/§2.2.1/§3 und den Roadmap-Phasen. Neu live: store-weites Audit-Dashboard mit Score-Trend/Snapshots, JSON-LD Structured Data (Product inkl. GTIN/Offer, Organization, Breadcrumb, Article, Review/AggregateRating, FAQ), Open Graph / Twitter Cards, Redirects & 404-Tracking, hreflang-Audit, Keyword-Tracking + On-Page-Analyse per-Locale, Google Search Console Pro+ mit täglicher Auto-Sync, AEO (`llms.txt` + `robots.txt`-AI-Crawler-Audit), IndexNow / Instant Indexing Pro+, manueller Bulk-Meta-Editor, Bulk „Fix with AI", Foreign-Locale SEO-Audit + AI-Fix. Damit sind die kritischen SEO-Gaps #1/#2 (JSON-LD/Rich Snippets), #8 (GSC), #9 (Broken Link Detection), #15 (Keyword Research) erledigt. |
| 2026-08-18 | **SEO-Teil ausgelagert und neu erhoben** — §2.2/§2.2.1 als veraltet markiert und auf [SEO_COMPETITIVE_ANALYSIS_2026-08.md](SEO_COMPETITIVE_ANALYSIS_2026-08.md) verwiesen: vollständige Feature-Matrix gegen `develop` verifiziert, Markt-Recherche 08/2026. Kernbefund: bei technischem On-Site-SEO auf oder über Wettbewerbsniveau; echte Lücken sind `agents.md` (löste llms.txt als kanonische KI-Discovery-Datei ab), Catalog-/Produktdaten-Readiness nach Shopify Spring '26, AI-Sichtbarkeits-Tracking, zeitgesteuerte Crawls, Bild-Dateinamen-SEO und Readability. |
| 2026-08-19 | **SEO-Wettbewerbsanalyse abgeschlossen** — [SEO_COMPETITIVE_ANALYSIS_2026-08.md](SEO_COMPETITIVE_ANALYSIS_2026-08.md) §10. Alle P1- und P2.3/P2.4-Lücken sind umgesetzt, auf einem Live-Shop ausgeliefert und gegen Googles Rich Results Test gegengeprüft: `agents.md` (mit merchant-editierbarer Einleitung), Katalog-Bereitschaft, wöchentlicher Crawl, KI-Referral-Tracking, Readability, VideoObject inkl. `uploadDate`. Dabei gefunden: Theme- und App-Markup verschmelzen über dieselbe `@id` — Aktivierung ist deshalb jetzt der letzte Schritt und urteilt anhand der Crawl-Messung. Offen und bewusst offen: LocalBusiness (nur Opt-in), Bild-Dateinamen-SEO, Long-Form-Generator, echtes Prompt-Rank-Tracking, Theme-Eingriffe (⛔ Nicht-Ziel). Größte verbleibende Lücke ist kommunikativ, nicht funktional. |
| 2026-07-19 | **Content-Templates ⛔ zurückgezogen** nach 2-Tages-Test auf `develop` (Merge `266b00a` → Rollback `69e7b8b`). Kritischer Nutzer-Review ergab: die `{{title}}`/`{{description}}`/`{{language}}`/`{{current_value}}`/`{{field_label}}`-Substitution lieferte der KI keine Info, die sie nicht bereits über die Handler-Prompt-Zeilen (`Context - Title:`, `Language:` etc.) bekam. Templates duplizierten damit die bestehenden per-Field-Custom-Instructions mit rein textueller Umpositionierung. Reverse-Migration `20260719130000_drop_content_template` räumt die DB-Tabelle beim nächsten Deploy weg. §2.3 Fußnote ⁵, §3.1 Punkt 5, §3.5 „Big Picture", §4 Phase 1.3 alle aktualisiert. **Bedingung für einen späteren Wiedereinstieg:** Variablen müssen Zusatz-Info liefern, die die KI heute nicht bekommt (`{{brand}}`/`{{price}}`/`{{tags}}`/`{{vendor}}`/`{{product_type}}`/`{{similar_products}}` aus Shopify). Ohne diese Bedingung deckt Custom-Instructions denselben Bedarf ohne zweite Konfigurationsfläche ab. |
| 2026-08-20 | **§2.1 Tag-Übersetzung ergänzt** (Web-Recherche): neue Tabellenzeile + Fußnote ⁶. Kernbefund — **keine** App übersetzt Tags als Tags; `tags` ist kein `translatableResource`-Key der Admin API, und tag-/vendor-basierte Filterwerte sind auch in Search & Discovery ausgenommen. Die ⚠️ der Konkurrenz sind drei Umgehungen: LangShops Theme-Duplikat (für Neukunden seit 08.08.2023 abgeschafft, Storefront-Suche kaputt), langifys Polyfill im Theme-Code, Weglot/GTranslates Proxy — alle ersetzen nur die HTML-Ausgabe, alle lassen die Filter-URL (`?filter.p.tag=…`) unübersetzt. Transcy und T Lab sagen es gar nicht erst zu. **Kein Gap für uns:** die Direktübersetzungen sind derselbe DOM-Mechanismus ohne Theme-Eingriff (shop-weites Wörterbuch, für Tags die richtige Granularität), und `field.tags` als `translatable: false` ist die korrekte Modellierung der Plattform-Grenze. Shopifys eigene Empfehlung für übersetzbare Filter bleibt: Metafelder statt Tags. Offen/ungemessen: ob unser Embed Tag-Chips in einem konkreten Theme trifft, und ob Transcy still einen eigenen DOM-Layer hat. |
