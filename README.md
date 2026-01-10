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
- ⚡ **AI Queue System** mit Rate Limiting und automatischem Retry
- 📋 **Task Management** mit Echtzeit-Tracking und Queue-Visualisierung

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

## 🤖 AI Provider & Rate Limiting

### Unterstützte AI-Provider

Die App unterstützt mehrere AI-Provider, die in den Einstellungen konfiguriert werden können:

| Provider | Kostenlos | Standard Rate Limits |
|----------|-----------|---------------------|
| **HuggingFace** | ✅ Ja | 1M Tokens/Min, 100 Requests/Min |
| **Google Gemini** | ✅ Ja | 1M Tokens/Min, 15 Requests/Min |
| **Claude** (Anthropic) | ❌ Nein | 40k Tokens/Min, 5 Requests/Min |
| **OpenAI** (GPT) | ❌ Nein | 200k Tokens/Min, 500 Requests/Min |
| **Grok** (xAI) | ❌ Nein | 100k Tokens/Min, 60 Requests/Min |
| **DeepSeek** | ❌ Nein | 100k Tokens/Min, 60 Requests/Min |

### AI Queue System

Alle AI-Anfragen werden über ein intelligentes Queue-System verarbeitet:

#### Features:
- **Automatisches Rate Limiting** - Verhindert API-Limit-Überschreitungen
- **Sliding Window Tracking** - Token- und Request-Nutzung wird pro Minute überwacht
- **Intelligentes Queueing** - Anfragen warten automatisch, wenn Limits erreicht sind
- **Retry-Logik** - Bis zu 3 automatische Wiederholungen bei Rate-Limit-Fehlern
- **Exponential Backoff** - Intelligente Wartezeiten zwischen Retries (1s, 2s, 4s)
- **Task Tracking** - Alle Anfragen werden als Tasks in der Datenbank getrackt

#### Konfiguration:

In den **App-Einstellungen** unter **"AI API Access"** können Sie für jeden Provider konfigurieren:

1. **API Key** - Ihr Provider-spezifischer API-Schlüssel
2. **Max Tokens per Minute** - Maximale Tokens pro Minute
3. **Max Requests per Minute** - Maximale Anfragen pro Minute

Die Standard-Limits basieren auf den üblichen Free-Tier bzw. Starter-Plänen der Provider. Passen Sie diese an Ihren tatsächlichen Plan an!

#### Wie es funktioniert:

```
User startet AI-Aktion
    ↓
Task erstellt (Status: pending)
    ↓
Zur Queue hinzugefügt (Status: queued)
    ↓
Queue prüft Rate Limits (alle 100ms)
    ↓
├─ Limits OK? → Ausführen (Status: running)
│   ↓
│   ├─ Erfolg → Status: completed
│   └─ Rate Limit Error → Retry (max 3x)
│
└─ Limits erreicht? → Warten bis verfügbar
```

#### Task Monitoring:

- **Navigation Badge** - Zeigt Anzahl aktiver Tasks (pending/queued/running)
- **Tasks-Seite** - Detaillierte Übersicht aller Tasks mit Status und Progress
- **Auto-Update** - Navigation aktualisiert sich alle 5 Sekunden

#### API-Keys beantragen:

- [HuggingFace Token](https://huggingface.co/settings/tokens)
- [Google AI Studio](https://aistudio.google.com/app/apikey)
- [Anthropic Console](https://console.anthropic.com/settings/keys)
- [OpenAI Platform](https://platform.openai.com/api-keys)
- [X.AI Console](https://console.x.ai)
- [DeepSeek Platform](https://platform.deepseek.com)

## 🔧 Deployment auf Railway

1. Projekt mit Railway verbinden
2. Environment Variables setzen (siehe oben)
3. PostgreSQL Datenbank hinzufügen
4. Deploy - Railway baut und startet automatisch

**Wichtig:** Nach Deployment App in Shopify installieren/neu autorisieren!

## 🏗️ Technische Architektur

### AI Queue System

Das AI Queue System basiert auf einem Singleton-Pattern und verwaltet alle AI-Anfragen zentral:

#### Komponenten:

**1. AIQueueService** ([src/services/ai-queue.service.ts](src/services/ai-queue.service.ts))
- Singleton Service für Queue-Management
- Sliding Window Rate Limiting
- Automatisches Retry mit Exponential Backoff
- Task-Status-Verwaltung

**2. AIService** ([src/services/ai.service.ts](src/services/ai.service.ts))
- Wrapper für alle AI-Provider
- Token-Schätzung basierend auf Prompt-Länge
- Queue-Integration für alle Anfragen

**3. Task Model** ([prisma/schema.prisma](prisma/schema.prisma))
```prisma
model Task {
  id              String    @id @default(cuid())
  shop            String
  type            String    // "aiGeneration", "translation", etc.
  status          String    // "pending", "queued", "running", "completed", "failed"
  queuePosition   Int?      // Position in Queue
  retryCount      Int       @default(0)
  estimatedTokens Int?      // Für Rate Limiting
  progress        Int       @default(0)
  // ... weitere Felder
}
```

#### Datenfluss:

```
┌─────────────────┐
│  User Action    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Product Actions │ Creates Task (pending)
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  AIService      │ Enqueues request
└────────┬────────┘
         │
         ▼
┌─────────────────────────────────┐
│     AIQueueService              │
│  ┌───────────────────────────┐  │
│  │ Check Rate Limits (100ms) │  │
│  └──────────┬────────────────┘  │
│             │                    │
│    ┌────────▼────────┐          │
│    │  Can Execute?   │          │
│    └────┬────────┬───┘          │
│         │        │               │
│      YES│        │NO             │
│         │        │               │
│    ┌────▼──┐  ┌─▼──────┐       │
│    │Execute│  │ Wait    │       │
│    └───┬───┘  └────┬────┘       │
│        │           │             │
│        │           └─────┐       │
│   ┌────▼─────┐          │       │
│   │  Success │          │       │
│   └────┬─────┘          │       │
│        │                │       │
│   ┌────▼────────┐  ┌───▼────┐  │
│   │  Completed  │  │ Queued │  │
│   └─────────────┘  └────────┘  │
└─────────────────────────────────┘
```

#### Rate Limiting Algorithmus:

1. **Sliding Window**: Tracking der letzten 60 Sekunden
2. **Token Estimation**: ~4 Zeichen = 1 Token + Output-Tokens
3. **Request Counting**: Anzahl Requests im aktuellen Fenster
4. **Limit Check**: Vor jeder Ausführung wird geprüft:
   ```typescript
   currentTokens + estimatedTokens <= maxTokensPerMinute &&
   currentRequests + 1 <= maxRequestsPerMinute
   ```
5. **Wait Calculation**: Bei Limit-Erreichen wird Wartezeit bis zum ältesten Fenster-Ablauf berechnet

### Datenbank Schema

Wichtige Modelle:

- **AISettings** - API Keys und Rate Limits pro Provider
- **AIInstructions** - Benutzerdefinierte AI-Anweisungen
- **Task** - Queue und Task-Tracking
- **Session** - Shopify OAuth Sessions

## 📖 Weitere Dokumentation

- [Shopify App Development](https://shopify.dev/docs/apps)
- [Remix Documentation](https://remix.run/docs)
- [Shopify Polaris](https://polaris.shopify.com/)
- [Prisma Documentation](https://www.prisma.io/docs)

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

### AI Queue Issues

#### "Tasks bleiben in Queue hängen"
- Überprüfen Sie die Rate Limit Einstellungen in den Settings
- Stellen Sie sicher, dass die Limits nicht zu niedrig sind
- Prüfen Sie Railway Logs auf AI-Provider-Fehler
- Queue Service läuft im Hintergrund - warten Sie bis zu 1 Minute

#### "Rate Limit Errors trotz korrekter Settings"
- Ihre tatsächlichen Provider-Limits können niedriger sein als konfiguriert
- Passen Sie die Limits in den Settings an Ihren Plan an
- Prüfen Sie das Provider-Dashboard für aktuelle Nutzung
- Retry-Logik greift automatisch - warten Sie bis zu 7 Sekunden

#### "Tasks werden nicht ausgeführt"
- Prüfen Sie ob ein gültiger API Key hinterlegt ist
- Verifizieren Sie den ausgewählten Provider in Settings
- Checken Sie Task-Status in der Tasks-Übersicht
- Bei Status "failed" - Fehlerdetails in der Task-Ansicht prüfen

#### "Badge in Navigation zeigt falsche Anzahl"
- Browser-Cache leeren
- Seite neu laden (F5)
- Polling erfolgt alle 5 Sekunden - kurz warten

## 📄 Lizenz

ISC
