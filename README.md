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

### Embedded App Navigation - Wichtige technische Details

**WICHTIG:** Diese App verwendet eine spezielle Navigation-Implementierung für Shopify Embedded Apps, die sich von Standard-React/Remix-Apps unterscheidet.

#### Das Problem mit Standard-Navigation

In Shopify Embedded Apps (die im Shopify Admin iframe laufen) funktioniert normale Client-Side-Navigation **nicht**:

❌ **Was NICHT funktioniert:**
- `<Link>` von Remix/React Router → Klicks werden blockiert
- `<NavLink>` → Pathname ändert sich nicht
- `useNavigate()` → Navigation wird vom iframe abgefangen
- `AppProvider` von `@shopify/shopify-app-remix/react` → Verursacht React Suspense Errors (#418, #423)

#### Die Lösung: Full Page Reload mit URL-Parameter Preservation

✅ **Was funktioniert:**

```typescript
// In MainNavigation.tsx
const handleClick = (path: string) => {
  // 1. Current URL mit allen Parametern auslesen
  const url = new URL(window.location.href);
  const searchParams = url.searchParams;

  // 2. Neue URL mit erhaltenen Parametern erstellen
  const newUrl = `${path}?${searchParams.toString()}`;

  // 3. Full Page Reload durchführen
  window.location.href = newUrl;
};
```

**Warum das funktioniert:**
1. ✅ Full Page Reloads werden vom Shopify iframe **nicht blockiert**
2. ✅ URL-Parameter (`embedded`, `hmac`, `host`, `id_token`, etc.) bleiben erhalten
3. ✅ Session bleibt durch die erhaltenen Parameter gültig
4. ✅ Authentifizierung funktioniert bei jedem Request

#### AppProvider Konfiguration

Verwende den **Polaris AppProvider**, NICHT den von `@shopify/shopify-app-remix`:

```typescript
// ✅ RICHTIG - app/routes/app.tsx
import { AppProvider } from "@shopify/polaris";

export default function App() {
  return (
    <AppProvider i18n={{}}>
      <Outlet />
    </AppProvider>
  );
}
```

```typescript
// ❌ FALSCH - Verursacht React Errors
import { AppProvider } from "@shopify/shopify-app-remix/react";
```

#### Prefetch-Request Handling

Remix sendet Prefetch-Requests, die keine Session-Tokens enthalten. Diese müssen abgefangen werden:

```typescript
// In app.tsx loader
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const headers = Object.fromEntries(request.headers.entries());
  const isPrefetch = headers['sec-purpose'] === 'prefetch';

  if (isPrefetch) {
    // Prefetch-Requests sofort mit Default-Daten beantworten
    return json({ appLanguage: "de" });
  }

  // Normale Requests mit Authentication behandeln
  const { session } = await authenticate.admin(request);
  // ...
};
```

#### Bekannte Limitationen

- **Keine Client-Side-Navigation**: Jeder Tab-Wechsel löst einen Full Page Reload aus
- **Langsamere UX**: SPA-Navigation wäre schneller, funktioniert aber nicht im iframe
- **App Bridge Navigation**: Theoretisch möglich, aber komplex und fehleranfällig

#### Debugging

**Backend Logs checken:**
```bash
# Railway Logs sollten zeigen:
🔍 [APP.TSX LOADER] Start - URL: /app/content
✅ [APP.TSX LOADER] Authentication successful
```

**Browser Console checken:**
```javascript
// Sollte zeigen:
🖱️ [MainNavigation] Tab clicked: content -> /app/content
🖱️ [MainNavigation] Navigating to: /app/content?embedded=1&hmac=...
```

#### Referenzen

- [GitHub Issue #369 - Shopify Remix Navigation Bug](https://github.com/Shopify/shopify-app-template-remix/issues/369)
- [GitHub Issue #529 - Suspense Boundary Problem](https://github.com/Shopify/shopify-app-js/issues/529)
- Diese Probleme sind bekannt und dokumentiert, aber noch nicht von Shopify gefixt

### App Bridge Setup und POST-Request-Authentifizierung

**KRITISCH:** Die App verwendet Shopify App Bridge für automatische Authentifizierung aller API-Requests.

#### Problem: POST Requests werden vom iframe blockiert

In Shopify Embedded Apps (die im Shopify Admin iframe laufen) werden POST/PUT/DELETE Requests standardmäßig blockiert, weil Browser third-party cookies im iframe einschränken.

**Symptome:**
- POST Requests kommen nicht am Backend an
- Buttons (z.B. "Setup Webhooks") haben keine Wirkung
- Keine Network-Requests sichtbar in Browser DevTools
- Formulare werden nicht abgeschickt

#### Lösung: App Bridge mit automatischer Session Token-Injektion

App Bridge **v4+** löst dieses Problem, indem es automatisch Session Tokens in alle `fetch()` Requests injiziert.

**Setup in [app/root.tsx](app/root.tsx):**

```typescript
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const apiKey = process.env.SHOPIFY_API_KEY || "";
  return json({ apiKey });
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

  return (
    <html lang="de">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />

        {/* KRITISCH: API Key als Meta-Tag für App Bridge Auto-Init */}
        <meta name="shopify-api-key" content={apiKey} />

        <Meta />
        <Links />

        {/* App Bridge CDN Script - lädt automatisch und initialisiert sich */}
        <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js" />
      </head>
      <body>
        <Outlet />
        <Scripts />
      </body>
    </html>
  );
}
```

**Wie es funktioniert:**

1. **Meta-Tag lesen**: App Bridge liest automatisch `<meta name="shopify-api-key">` beim Page Load
2. **Auto-Initialisierung**: Kein manueller JavaScript-Code nötig
3. **Global Fetch Injection**: App Bridge überschreibt die globale `fetch()` Funktion
4. **Session Token**: Jeder Request bekommt automatisch einen Authorization Header mit Session Token

**In deinen Components - Keine Änderungen nötig:**

```typescript
// Einfach normales fetch() verwenden - App Bridge authentifiziert automatisch!
const handleSetupWebhooks = async () => {
  const response = await fetch("/api/setup-webhooks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  const data = await response.json();
  // Works! 🎉
};
```

#### Wichtige Hinweise:

✅ **Was funktioniert:**
- Alle `fetch()` Requests (GET, POST, PUT, DELETE, etc.)
- Formulare mit JavaScript-Submit
- AJAX-Requests
- GraphQL-Requests mit fetch()

❌ **Was NICHT funktioniert:**
- Native HTML Form-Submit (ohne JavaScript)
- `useFetcher()` von Remix (verwende stattdessen direktes `fetch()`)
- Requests von Web Workers (laufen außerhalb des App Bridge Contexts)

#### Backend Session Token-Validierung:

Das Backend validiert automatisch die Session Tokens dank `@shopify/shopify-app-remix`:

```typescript
// In app/shopify.server.ts - Bereits konfiguriert
export const authenticate = {
  admin: async (request: Request) => {
    // Validiert automatisch den Session Token aus dem Authorization Header
    // Wirft Error bei ungültigem/fehlendem Token
    const { session, admin } = await shopify.authenticate.admin(request);
    return { session, admin };
  }
};
```

#### Debugging:

**1. Prüfe ob App Bridge geladen ist:**
```javascript
// In Browser Console:
console.log(window.shopify); // Sollte Object zeigen, nicht undefined
```

**2. Prüfe Meta-Tag:**
```javascript
// In Browser Console:
document.querySelector('meta[name="shopify-api-key"]')?.content
// Sollte deinen API Key zeigen
```

**3. Prüfe Network-Requests:**
- Öffne DevTools → Network Tab
- Führe POST Request aus
- Klicke auf Request → Headers Tab
- Suche nach `Authorization: Bearer ...` Header
- Token sollte vorhanden sein!

**4. Backend Logs checken:**
```bash
# Railway Logs sollten zeigen:
🔍 [APP.TSX LOADER] Authentication successful
✅ Session validated for shop: your-shop.myshopify.com
```

#### Referenzen:

- [Shopify App Bridge Documentation](https://shopify.dev/docs/api/app-bridge-library)
- [Session Tokens Guide](https://shopify.dev/docs/apps/build/authentication-authorization/session-tokens)
- [Embedded App Authorization](https://shopify.dev/docs/apps/build/authentication-authorization/set-embedded-app-authorization)

### Authentication Strategy

Die App verwendet die Standard-Authentifizierung von `@shopify/shopify-app-remix` kombiniert mit App Bridge für iframe-sichere POST Requests. Falls Probleme auftreten, checke die Railway Logs für Authentication-Fehler.

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

**Symptome:**
- Klicks auf Navigation-Tabs haben keine Wirkung
- Pathname ändert sich nicht
- Keine Backend-Requests sichtbar in Railway Logs
- React Errors #418 oder #423 in Browser Console

**Lösungen:**

1. **Überprüfe die Navigation-Implementierung:**
   - Muss `window.location.href` mit URL-Parameter Preservation verwenden
   - NICHT `<Link>`, `<NavLink>`, oder `useNavigate()` verwenden
   - Siehe [Embedded App Navigation](#embedded-app-navigation---wichtige-technische-details)

2. **Überprüfe den AppProvider:**
   - Muss von `@shopify/polaris` importiert sein
   - NICHT von `@shopify/shopify-app-remix/react`

3. **Scopes überprüfen:**
   - Leerzeichen in `SHOPIFY_SCOPES` entfernen
   - App in Shopify neu installieren

4. **Session-Storage leeren:**
   - Datenbank-Tabelle `Session` leeren
   - App neu autorisieren

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
