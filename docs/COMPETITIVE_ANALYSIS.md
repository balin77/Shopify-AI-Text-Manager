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
| **Währungsumrechnung** | ❌ | ✅ 167 | ❌ | ✅ | ✅ |
| **Geolocation Auto-Detect** | ❌ | ✅ | ✅ | ✅ | ❌ |
| **Glossar/Terminologie** | ❌ | ✅ | ✅ | ✅ | ✅ |
| **Language Switcher Widget** | ❌ | ✅ | ✅ | ✅ | ✅ |
| **Third-Party-App-Übersetzung** | ❌ | ✅ | ✅ | ✅ | ✅ |
| **Checkout-Übersetzung** | ❌ | ✅ | ✅ | ✅ | ❌ |
| **Bild-Übersetzung (OCR)** | ❌ | ✅ | ❌ | ❌ | ❌ |

**Preise der Wettbewerber:**
- Transcy: Free / $11.90 / $29.90 / $59.90 pro Monat
- Weglot: Ab $15/Monat
- LangShop: Free / $9.99+ pro Monat
- T Lab: Free / $9.99+ pro Monat

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
| **Page Speed Optimization** | ❌ | ❌ | ✅ | ❌ |
| **Image Compression** | ❌ | ❌ | ✅ | ✅ |
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
| 4 | **Language/Currency Switcher Widget** | Hoch | Hoch | Alle Translation-Apps |
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
| 13 | **Image Compression** | Mittel | Mittel | SEOWILL, StoreSEO |
| 14 | **Auto-Generate bei neuem Produkt** | Mittel | Niedrig | ChatGPT-AI |
| 15 | **Keyword Research/Tracking** | Niedrig | Mittel | Yoast, SEOWILL, StoreSEO |
| 16 | **Third-Party-App-Übersetzung** | Niedrig | Hoch | Transcy, Weglot, LangShop |
| 17 | **Checkout-Übersetzung** | Niedrig | Hoch | Transcy, Weglot, LangShop |
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

#### 2.1 Language Switcher Widget
- [ ] Embeddable Widget entwickeln
- [ ] Theme App Extension oder Script Tag
- [ ] Konfigurierbare Styles (Dropdown, Flags, etc.)
- [ ] Position wählbar (Header, Footer, Floating)
- [ ] Locale-Cookie setzen
- [ ] Installation-Anleitung

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

