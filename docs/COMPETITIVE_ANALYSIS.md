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
| **Glossar/Terminologie** | ❌ | ✅ | ✅ | ✅ | ✅ |
| **Language/Currency Switcher Widget** | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Third-Party-App-Übersetzung** ² | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Checkout-Übersetzung** ³ | ✅ | ✅ | ✅ | ✅ | ❌ |
| **Bild-Übersetzung (OCR)** | ❌ | ✅ | ❌ | ❌ | ❌ |

> ¹ **Währungsumrechnung ist kein echter Gap** (Stand 2026-06): Shopify
> rechnet seit Markets + Shopify Payments **nativ** mit aktuellen
> Marktwechselkursen um — Storefront-Anzeige, Checkout und Refunds. Die
> ✅ der Konkurrenz duplizieren in den meisten Fällen Shopify-Bordmittel.
> Eigener Konverter ist nur in Edge-Cases relevant (Händler ohne Shopify
> Payments, reiner Display-Switcher für nicht konfigurierte Märkte,
> Custom-Rundung wie 9,99). Details + Entscheidung →
> [ROADMAP.md](ROADMAP.md) §4.3 Localization.
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
| **Content-Templates** | ❌ | ✅ | ✅ | ✅ |
| **Auto-Generate neues Produkt** | ❌ | ✅ | ❌ | ❌ |
| **AI Blog-Post-Generator** | ❌ | ❌ | ✅ | ✅ |
| **AI Image Generator** | ❌ | ❌ | ❌ | ✅ |
| **AI Email/Marketing** | ❌ | ❌ | ❌ | ✅ |
| **AI Social Media Posts** | ❌ | ❌ | ❌ | ✅ |
| **Image-to-Description** | ❌ | ❌ | ❌ | ✅ |

**Preise der Wettbewerber:**
- ChatGPT-AI: ~$1 pro 100 Beschreibungen
- WritePilot: Paid Plans
- Smartli: Free / Paid Plans

---

## 3. Fehlende Features

### 3.1 Kritisch (Wettbewerbsnachteil)

Diese Features haben die meisten Wettbewerber und Kunden erwarten sie:

| # | Feature | Impact | Aufwand | Wettbewerber |
|---|---------|--------|---------|--------------|
| 1 | **JSON-LD Structured Data** | Hoch | Mittel | Yoast, SEOWILL, StoreSEO |
| 2 | **Rich Snippets (Product, Review, Breadcrumb)** | Hoch | Mittel | Yoast, SEOWILL, StoreSEO |
| 3 | **Glossar/Terminologie-Management** | Hoch | Mittel | Transcy, Weglot, LangShop, T Lab |
| ~~4~~ | ~~**Language/Currency Switcher Widget**~~ ✅ erledigt (2026-06, `extensions/storefront/blocks/locale-switcher.liquid`) | — | — | — |
| 5 | **Content-Templates/Vorlagen** | Hoch | Niedrig | ChatGPT-AI, WritePilot, SEO On |

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

**4. Content-Templates/Vorlagen**
```
Was fehlt:
- Wiederverwendbare Prompt-Templates
- Variablen-System ({{product_name}}, {{category}})
- Template-Bibliothek
- Template-Sharing zwischen Produkten

Warum wichtig:
- Konsistente Markensprache
- Schnellere Content-Erstellung
- Weniger manuelle Anpassungen
```

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

**2. Glossar/Terminologie-Management.** Begriffsdatenbank pro Shop: „nie
übersetzen" / „immer exakt so übersetzen". Verhindert inkonsistente AI-
Übersetzung von Marken-/Fachbegriffen. Standard bei allen großen Translation-
Apps. Umsetzung = Prisma-Tabelle + Settings-UI + Begriffe in den AI-Prompt
injizieren. Mittlerer Aufwand, hoher Erwartungswert.

**3. JSON-LD Structured Data.** Maschinenlesbares Markup (Product/Breadcrumb/
Article/Review) → Rich Snippets in Google (Sterne, Preis, Verfügbarkeit) +
Voraussetzung für Google Shopping. Wir generieren SEO-Titel/Meta schon, aber
nicht den CTR-wirksamen strukturierten Teil. Umsetzung = Service, der JSON-LD
aus vorhandenen Daten erzeugt und ins Theme injiziert.

**4. Content-Templates/Vorlagen.** Wiederverwendbare Prompt-Vorlagen mit
Platzhaltern (`{{product_name}}`, `{{category}}`). AI-Pipeline + Custom-
Instructions existieren schon; Kern = Prisma-Tabelle + Editor-UI + Variablen-
Substitution vor dem AI-Call. **Bestes Aufwand/Nutzen** und taugt zugleich als
*zusätzliches* Pro/Max-Differenzial (Befund 4 ist bereits gelöst — Templates
optional obendrauf, z. B. erst ab Pro).

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
  [ROADMAP.md](ROADMAP.md) §4.3.
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

### Strategisches Big Picture
Schwächen = „Sichtbarkeit & SEO-Mechanik" (Switcher, Structured Data).
Stärken = „AI-Qualität & Breite" (6 Provider, BYO-Key = ∞ günstige AI, Custom-
Instructions, Bild-Tools, viele Content-Typen). → Kritische Lücken schließen,
damit man nicht an Basis-Erwartungen scheitert; *vermarkten* aber die Stärken,
die kein Übersetzungs-Konkurrent hat.

**Empfohlene Reihenfolge (wenn Bugs erledigt):** ~~#1 Switcher-Widget~~ ✅
erledigt → #4 Templates (billig, nutzt vorhandene Infra, zusätzliches
Pro/Max-Differenzial) → #2 Glossar + #3 JSON-LD parallel.

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

#### 1.2 Glossar-Management
- [ ] Glossar-Datenmodell (Prisma Schema erweitern)
- [ ] Glossar-UI in Settings
- [ ] Begriffe hinzufügen/bearbeiten/löschen
- [ ] "Nicht übersetzen" Option
- [ ] "Feste Übersetzung" Option
- [ ] Glossar beim Übersetzen anwenden
- [ ] Import/Export (CSV)

**Technische Umsetzung:**
```prisma
// prisma/schema.prisma
model GlossaryTerm {
  id           String   @id @default(cuid())
  shop         String
  sourceTerm   String
  targetTerm   String?  // null = nicht übersetzen
  sourceLocale String
  targetLocale String
  caseSensitive Boolean @default(false)
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  @@unique([shop, sourceTerm, sourceLocale, targetLocale])
}
```

#### 1.3 Content-Templates
- [ ] Template-Datenmodell
- [ ] Template-Editor UI
- [ ] Variablen-System ({{product_name}}, {{category}}, etc.)
- [ ] Template pro Content-Typ
- [ ] Template-Auswahl bei Generierung
- [ ] Standard-Templates mitliefern

**Technische Umsetzung:**
```prisma
// prisma/schema.prisma
model ContentTemplate {
  id          String   @id @default(cuid())
  shop        String
  name        String
  contentType String   // "product", "collection", "article", etc.
  fieldType   String   // "title", "description", "seoTitle", etc.
  template    String   // Der Prompt mit {{variablen}}
  isDefault   Boolean  @default(false)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
}
```

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

### SEO-Apps
- [Yoast SEO for Shopify](https://apps.shopify.com/yoast-seo)
- [SEOWILL (formerly SEOAnt)](https://apps.shopify.com/seo-master)
- [StoreSEO](https://apps.shopify.com/storeseo)
- [Schema Plus for SEO](https://apps.shopify.com/schema-plus)

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
| 2026-06-29 | **§2.2.1 Nachtrag — übersehene & neue Funktionsweisen** ergänzt (Web-Recherche 06/2026): AEO/GEO als definierender 2026-Layer, llms.txt, IndexNow/Instant-Indexing, AI-Crawler-Zugriff (robots.txt), GTIN/Brand im Product-Schema für AI-Shopping, erweiterte Schema-Typen (FAQ/Review/LocalBusiness/Video), internes Linking, manueller Bulk-Meta-Editor, Bild-Dateinamen-SEO, AI-Referral-Tracking, OG/Twitter-Cards, Autopilot-Design-Warnung. Strategie: **mehrsprachige AEO** als unbesetzter USP. Fließt in den SEO-Tab-Plan (`docs/plans/SEO_TAB_IMPLEMENTATION_PLAN.md`) ein. |

