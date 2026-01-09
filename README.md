# 🚀 Shopify AI Text Manager

Eine professionelle Shopify Embedded App für KI-gestützte Texterstellung, SEO-Optimierung und automatische Übersetzungen.

## ✨ Features

- 🤖 **KI-gestützte Texterstellung** mit mehreren AI-Providern (HuggingFace, Gemini, Claude, OpenAI, Grok, DeepSeek)
- 🌍 **Automatische Übersetzungen** in alle Shopify Shop-Sprachen
- 📝 **Content-Verwaltung** für Produkte, Blogs, Collections und Pages
- 💾 **Intelligentes Change-Tracking** verhindert Datenverlust
- 🎨 **Embedded Shopify App** mit Polaris Design System
- 📊 **SEO-Score-Berechnung** mit Echtzeit-Optimierungsvorschlägen
- 🏗️ **Modulare Architektur** - Remix, React, Prisma, GraphQL

## 🚀 Schnellstart

### 1. Installation

```bash
npm install
```

### 2. Environment Variables

Erstelle eine `.env` Datei mit folgenden Variablen:

```env
# Shopify App Credentials
SHOPIFY_API_KEY=your-api-key
SHOPIFY_API_SECRET=your-api-secret
SHOPIFY_APP_URL=https://your-app-url.railway.app

# WICHTIG: Keine Leerzeichen zwischen den Scopes!
SHOPIFY_SCOPES=read_products,write_products,read_translations,write_translations,read_locales,read_content,write_content,read_online_store_pages,write_online_store_pages

# Database
DATABASE_URL=postgresql://user:password@host:port/database

# AI Provider (optional)
AI_PROVIDER=huggingface
HUGGINGFACE_API_KEY=your-key
```

### 3. Datenbank Setup

```bash
npx prisma generate
npx prisma db push
```

### 4. Development starten

```bash
npm run dev
```

## ⚠️ Wichtige Hinweise

### Scopes Configuration

**KRITISCH:** Die `SHOPIFY_SCOPES` Environment Variable darf **KEINE Leerzeichen** zwischen den Scopes enthalten!

✅ **Richtig:**
```env
SHOPIFY_SCOPES=read_products,write_products,read_translations
```

❌ **Falsch:**
```env
SHOPIFY_SCOPES=read_products, write_products, read_translations
                          ^^^           ^^^
                    Diese Leerzeichen brechen die App!
```

**Symptome bei falschen Scopes:**
- Navigation funktioniert nicht
- Authentifizierung schlägt fehl
- API-Requests werden abgelehnt
- App lädt nicht oder zeigt weiße Seite

**Lösung:**
1. Überprüfe die `SHOPIFY_SCOPES` auf Railway/Hosting
2. Entferne alle Leerzeichen nach Kommas
3. App neu deployen
4. Shopify App eventuell neu installieren

### Authentication Strategy

Die App verwendet `unstable_newEmbeddedAuthStrategy: true` für moderne Token-Exchange-Authentifizierung. Falls Probleme auftreten, kann diese in `app/shopify.server.ts` deaktiviert werden.

## 📦 Projektstruktur

```
Shopify AI Text Manager/
├── app/
│   ├── routes/              # Remix Routes
│   │   ├── app._index.tsx   # Produkte-Seite
│   │   ├── app.content.tsx  # Content-Verwaltung
│   │   ├── app.settings.tsx # Einstellungen
│   │   └── app.tasks.tsx    # Task-Tracking
│   ├── components/          # React Components
│   ├── services/            # Business Logic
│   ├── graphql/             # GraphQL Queries
│   └── contexts/            # React Contexts
├── src/
│   └── services/            # Shared Services
├── prisma/
│   └── schema.prisma        # Datenbank Schema
└── public/                  # Static Assets
```

## 🤖 AI Provider

Unterstützte AI-Provider (konfigurierbar in den App-Einstellungen):

- **HuggingFace** (kostenlos)
- **Google Gemini** (kostenlos)
- **Claude** (Anthropic)
- **OpenAI** (GPT)
- **Grok** (xAI)
- **DeepSeek**

API-Keys werden in der App unter "Einstellungen" hinterlegt.

## 🔧 Deployment auf Railway

1. Projekt mit Railway verbinden
2. Environment Variables setzen (siehe oben)
3. PostgreSQL Datenbank hinzufügen
4. Deploy - Railway baut und startet automatisch

**Wichtig:** Nach Deployment App in Shopify installieren/neu autorisieren!

## 📖 Weitere Dokumentation

- [Shopify App Development](https://shopify.dev/docs/apps)
- [Remix Documentation](https://remix.run/docs)
- [Shopify Polaris](https://polaris.shopify.com/)

## 🐛 Troubleshooting

### App lädt nicht / Weiße Seite
- Überprüfe Browser-Konsole auf Fehler
- Checke Railway Logs
- Verifiziere Environment Variables (besonders `SHOPIFY_SCOPES`)

### Navigation funktioniert nicht
- Leerzeichen in `SHOPIFY_SCOPES` entfernen
- App in Shopify neu installieren
- Session-Storage in Datenbank leeren

### API-Fehler
- Scopes überprüfen - alle benötigten Permissions vorhanden?
- Shopify API-Limits beachten
- Access Token gültig?

## 📄 Lizenz

ISC
