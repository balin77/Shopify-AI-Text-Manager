# 🔐 Shopify API Scopes - Vollständige Übersicht

## Scopes für Translation & Content Management

### 1. **Produkte** (bereits implementiert)
```
read_products       # Produkte lesen
write_products      # Produkte bearbeiten (inkl. SEO)
```

**Was kann übersetzt werden:**
- Produkttitel
- Produktbeschreibungen
- SEO-Titel & Meta-Beschreibung
- Produktvarianten
- Produktoptionen

---

### 2. **Übersetzungen (Core)**
```
read_translations   # Übersetzungen lesen
write_translations  # Übersetzungen schreiben
read_locales        # Verfügbare Sprachen lesen
```

**Was kann übersetzt werden:**
- Alle translatierbaren Ressourcen (via Translations API)
- Metafields
- Custom Content

---

### 3. **Shop-Seiten & Content**
```
read_content                    # Content lesen (Blogs, Artikel)
write_content                   # Content schreiben
read_online_store_pages         # Shop-Seiten lesen
write_online_store_pages        # Shop-Seiten schreiben
```

**Was kann übersetzt werden:**
- Shop-Seiten (Pages)
- Blog-Posts
- Blog-Artikel
- Policies (AGB, Datenschutz, etc.)

---

### 4. **Navigation & Menüs**
```
read_navigation    # Menüs lesen
write_navigation   # Menüs bearbeiten
```

**Was kann übersetzt werden:**
- Menü-Namen
- Menü-Items
- Footer-Navigation

---

### 5. **Themes & Shop-Texte**
```
read_themes        # Theme-Einstellungen lesen
write_themes       # Theme-Einstellungen schreiben
```

**Was kann übersetzt werden:**
- Theme-Texte (z.B. "In den Warenkorb")
- Checkout-Texte
- Section-Inhalte

---

### 6. **Metaobjects & Custom Content**
```
read_metaobjects    # Metaobjects lesen
write_metaobjects   # Metaobjects schreiben
```

**Was kann übersetzt werden:**
- Custom Content (z.B. FAQs, Testimonials)
- Metaobject Definitions
- Custom Sections

---

### 7. **Collections (Produktkategorien)**
```
read_product_listings     # Collections lesen
write_product_listings    # Collections schreiben
```

**Was kann übersetzt werden:**
- Collection-Titel
- Collection-Beschreibungen
- Collection SEO

---

### 8. **Weitere nützliche Scopes**
```
read_shipping              # Versandeinstellungen
write_shipping             # Versandeinstellungen bearbeiten
read_policies              # Shop-Policies lesen
read_markets               # Märkte lesen (wichtig für Internationalisierung!)
write_markets              # Märkte bearbeiten
```

---

## ✅ Empfohlene Scope-Konfiguration

### **Für SEO & Übersetzungs-App (umfassend):**

```env
SHOPIFY_SCOPES=read_products,write_products,read_translations,write_translations,read_locales,read_content,write_content,read_online_store_pages,write_online_store_pages,read_navigation,write_navigation,read_metaobjects,write_metaobjects,read_product_listings,write_product_listings,read_themes,read_markets
```

### **Minimal für Start (nur Produkte + Basis-Übersetzungen):**

```env
SHOPIFY_SCOPES=read_products,write_products,read_translations,write_translations,read_locales
```

### **Erweitert (mit Content & Navigation):**

```env
SHOPIFY_SCOPES=read_products,write_products,read_translations,write_translations,read_locales,read_content,write_content,read_online_store_pages,write_online_store_pages,read_navigation,write_navigation
```

---

## 🎯 Was würde ich empfehlen?

### Phase 1: Start (aktuell)
```
read_products,write_products,read_translations,write_translations,read_locales
```

### Phase 2: Content erweitern
```
+ read_content,write_content
+ read_online_store_pages,write_online_store_pages
```

### Phase 3: Navigation & Menüs
```
+ read_navigation,write_navigation
```

### Phase 4: Vollständig
```
+ read_metaobjects,write_metaobjects
+ read_product_listings,write_product_listings
+ read_themes
+ read_markets
```

---

## 📊 Welche Ressourcen können übersetzt werden?

Shopify unterstützt Übersetzungen für folgende Ressourcen via **Translations API**:

### Standard-Ressourcen:
1. ✅ **Product** - Produkte
2. ✅ **ProductVariant** - Produktvarianten
3. ✅ **Collection** - Produktkategorien
4. ✅ **Page** - Shop-Seiten
5. ✅ **Article** - Blog-Artikel
6. ✅ **Blog** - Blogs
7. ✅ **Menu** - Navigationsmenüs
8. ✅ **MenuItem** - Menü-Items
9. ✅ **Link** - Links
10. ✅ **Metafield** - Metafelder
11. ✅ **Metaobject** - Custom Content
12. ✅ **Shop** - Shop-Informationen
13. ✅ **ShopPolicy** - Shop-Policies (AGB, etc.)
14. ✅ **EmailTemplate** - E-Mail-Templates
15. ✅ **Filter** - Such-Filter
16. ✅ **PaymentGateway** - Zahlungsmethoden-Beschreibungen

### Theme-spezifisch:
- ✅ **Theme** - Theme-Texte & Einstellungen
- ✅ **OnlineStoreTheme** - Storefront-Texte

---

## 🔧 Wie nutzt du die Translations API?

### GraphQL Query Beispiel:

```graphql
query GetTranslations($resourceId: ID!, $locale: String!) {
  translatableResource(resourceId: $resourceId) {
    resourceId
    translations(locale: $locale) {
      key
      value
      locale
    }
    translatableContent {
      key
      value
      digest
      locale
    }
  }
}
```

### GraphQL Mutation Beispiel:

```graphql
mutation CreateTranslation($id: ID!, $translations: [TranslationInput!]!) {
  translationsRegister(resourceId: $id, translations: $translations) {
    translations {
      key
      value
      locale
    }
    userErrors {
      field
      message
    }
  }
}
```

---

## 🌍 Markets & Internationalisierung

Für vollständige Internationalisierung:

```env
# Zusätzliche Scopes für Markets
SHOPIFY_SCOPES=...,read_markets,write_markets
```

**Markets** erlauben:
- Länderspezifische Preise
- Länderspezifische Domains
- Automatische Sprach-/Währungsauswahl

---

## 💡 Best Practices

### 1. **Starte minimal, erweitere später**
- Beginne mit Produkten + Basis-Übersetzungen
- Füge Scopes hinzu, wenn du Features brauchst

### 2. **Weniger ist mehr**
- Nur Scopes anfragen, die du wirklich nutzt
- Merchants sind vorsichtig bei zu vielen Berechtigungen

### 3. **Dokumentiere deine Scopes**
- Erkläre in der App-Beschreibung, warum du welche Scopes brauchst

### 4. **Teste alle Scopes**
- Prüfe, dass deine App auch mit weniger Scopes funktioniert (graceful degradation)

---

## 📝 Für deine neue App empfehle ich:

### **Jetzt (für Setup):**
```
read_products,write_products,read_translations,write_translations,read_locales
```

### **Später erweitern (wenn du Navigation/Content implementierst):**
```
read_products,write_products,read_translations,write_translations,read_locales,read_content,write_content,read_online_store_pages,write_online_store_pages,read_navigation,write_navigation,read_product_listings,write_product_listings,read_metaobjects,write_metaobjects
```

---

## 📚 Weitere Ressourcen

- [Shopify API Scopes](https://shopify.dev/docs/api/usage/access-scopes)
- [Translations API](https://shopify.dev/docs/api/admin-graphql/latest/mutations/translationsRegister)
- [Markets](https://shopify.dev/docs/api/admin-graphql/latest/objects/Market)

---

**Tipp**: Du kannst Scopes jederzeit in deiner App-Konfiguration ändern. Merchants müssen die App dann neu authorisieren.
