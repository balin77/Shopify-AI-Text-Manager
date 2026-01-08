# 🚀 Shopify SEO Optimizer

Ein modularer, KI-gestützter SEO-Optimizer für Shopify-Produkte mit automatischer Übersetzung in mehrere Sprachen.

## ✨ Features

- 🤖 **KI-gestützte SEO-Optimierung** mit mehreren AI-Providern (HuggingFace, Gemini, Claude, OpenAI)
- 🌍 **Automatische Übersetzungen** in 5 Sprachen (DE, EN, FR, ES, IT)
- 📝 **Rich-Text-Editor** mit HTML-Formatierung
- 💾 **Intelligentes Change-Tracking** verhindert Datenverlust
- 🎨 **Moderne Web-UI** mit Echtzeit-Updates
- 📊 **SEO-Score-Berechnung** mit konkreten Verbesserungsvorschlägen
- 🏗️ **Modulare Architektur** - Services, Components, State Management

## 📚 Dokumentation

- **[ARCHITECTURE.md](ARCHITECTURE.md)** - Detaillierte Architektur-Dokumentation mit Code-Beispielen
- **[OAUTH-SETUP.md](OAUTH-SETUP.md)** - OAuth-Setup Anleitung

## 🚀 Schnellstart

### 1. Installation
```bash
npm install
```

### 2. OAuth Setup
Folge der detaillierten Anleitung in [OAUTH-SETUP.md](OAUTH-SETUP.md)

**Kurzversion:**
1. App im [Shopify Partners Dashboard](https://partners.shopify.com/) erstellen
2. Credentials in `.env` eintragen
3. OAuth Flow starten: `npm run oauth`
4. Browser öffnen: `http://localhost:3000/auth`
5. App autorisieren

### 3. Web-App starten
```bash
npm run web
```
Öffne `http://localhost:3001` im Browser

## 💡 Verwendung

### Web-UI
Die Web-App bietet eine benutzerfreundliche Oberfläche:
1. Produkte durchsuchen und filtern
2. Produktdetails bearbeiten (Titel, Beschreibung, Handle)
3. SEO-Daten optimieren mit KI-Unterstützung
4. Übersetzungen in mehrere Sprachen verwalten
5. SEO-Score in Echtzeit sehen

### Programmatische Nutzung

Die Services können auch direkt verwendet werden:

```typescript
import { ShopifyConnector } from './src/shopify-connector';
import { ProductService } from './src/services/product.service';
import { AIService } from './src/services/ai.service';

const connector = new ShopifyConnector();
const productService = new ProductService(connector);
const aiService = new AIService('huggingface');

// Alle Produkte abrufen
const products = await productService.getAllProducts(250);

// SEO generieren
const suggestion = await aiService.generateSEO(
  'Produkttitel',
  'Produktbeschreibung'
);

// Produkt aktualisieren
await productService.updateProduct(productId, {
  seoTitle: suggestion.seoTitle,
  metaDescription: suggestion.metaDescription
});
```

## 📦 Projektstruktur

```
Shopify API Connector/
├── src/
│   ├── services/              # Backend Services
│   │   ├── product.service.ts
│   │   ├── translation.service.ts
│   │   └── ai.service.ts
│   ├── types/                 # TypeScript Typen
│   └── shopify-connector.ts   # Shopify API Wrapper
├── web-app/
│   ├── server.ts              # Express Server
│   ├── js/
│   │   ├── modules/           # State Management
│   │   ├── services/          # Frontend API Service
│   │   ├── components/        # UI Components
│   │   └── utils/             # Helper Functions
│   └── index.html
├── ARCHITECTURE.md            # Architektur-Dokumentation
├── MIGRATION-GUIDE.md         # Migrations-Guide
└── README.md
```

## 🔧 Verfügbare Scripts

- `npm run web` - Web-App starten (Port 3001)
- `npm run oauth` - OAuth Setup (einmalig)
- `npm run build` - TypeScript kompilieren
- `npm run dev` - Development Mode

## 🤖 AI Provider

Unterstützte AI-Provider (konfigurierbar über `.env`):

- **HuggingFace** (Standard, kostenlos)
- **Google Gemini** (kostenlos)
- **Claude**
- **OpenAI**

```env
AI_PROVIDER=huggingface
HUGGINGFACE_API_KEY=dein-key
```

## 📖 Weitere Dokumentation

- [Shopify GraphQL Admin API](https://shopify.dev/docs/api/admin-graphql)
- [Shopify API Library](https://github.com/Shopify/shopify-api-js)

## 📄 Lizenz

ISC
