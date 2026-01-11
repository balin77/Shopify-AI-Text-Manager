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
- 🚀 **DB-Caching** - Blitzschnelle Ladezeiten durch PostgreSQL-Cache
- 🔄 **Webhook-System** - Automatische Synchronisierung mit Shopify
- ⚡ **Instant Updates** - Änderungen sofort sichtbar ohne Reload

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

**WICHTIG:** Dank App Bridge v4+ verwendet diese App jetzt **Client-Side (SPA) Navigation** für schnelle, flüssige Tab-Wechsel ohne Page Reload!

#### Aktuelle Implementierung: Client-Side Navigation mit useNavigate()

✅ **Was jetzt funktioniert (seit App Bridge Setup):**

Die App nutzt React Router's `useNavigate()` für instant SPA-Navigation:

```typescript
// In MainNavigation.tsx - AKTUELLE IMPLEMENTIERUNG
import { useNavigate, useLocation } from "@remix-run/react";

export function MainNavigation() {
  const navigate = useNavigate();
  const location = useLocation();

  const handleClick = (path: string) => {
    // Preserve URL parameters für Shopify Session
    const searchParams = new URLSearchParams(location.search);
    const newPath = `${path}?${searchParams.toString()}`;

    // Client-Side Navigation - instant, kein Reload!
    navigate(newPath);
  };

  // ...
}
```

**Vorteile der aktuellen Lösung:**
- ⚡ **Instant Navigation** - keine Wartezeit, keine Flicker
- 🎨 **Smooth UX** - React State bleibt erhalten
- 💾 **Bessere Performance** - nur neue Daten werden geladen
- 🚀 **Schnellere App** - kein kompletter DOM-Neuaufbau

**Warum das jetzt funktioniert:**
- App Bridge v4+ ist korrekt initialisiert (siehe [App Bridge Setup](#app-bridge-setup-und-post-request-authentifizierung))
- Session Tokens werden automatisch in alle Requests injiziert
- URL-Parameter (`embedded`, `host`, `hmac`) werden erhalten
- iframe-Blocking wird durch App Bridge umgangen

#### Fallback-Lösung: Full Page Reload (falls SPA-Navigation Probleme macht)

Falls die Client-Side-Navigation **nicht funktioniert** (z.B. bei App Bridge Problemen), kann man zur alten Methode zurückkehren:

```typescript
// FALLBACK - Nur verwenden wenn SPA-Navigation nicht funktioniert!
const handleClick = (path: string) => {
  // Preserve URL parameters
  const url = new URL(window.location.href);
  const searchParams = url.searchParams;
  const newUrl = `${path}?${searchParams.toString()}`;

  // Full Page Reload
  window.location.href = newUrl;
};
```

**Wann Fallback verwenden:**
- App Bridge lädt nicht korrekt
- Navigation führt zu Authentication-Fehlern
- React Suspense Errors (#418, #423)
- Pathname ändert sich nicht

#### Das ursprüngliche Problem mit Standard-Navigation

Historisch gesehen funktionierte in Shopify Embedded Apps (die im Shopify Admin iframe laufen) Client-Side-Navigation **nicht**:

❌ **Was historisch NICHT funktionierte (ohne App Bridge):**
- `<Link>` von Remix/React Router → Klicks wurden blockiert
- `<NavLink>` → Pathname änderte sich nicht
- `useNavigate()` → Navigation wurde vom iframe abgefangen
- `AppProvider` von `@shopify/shopify-app-remix/react` → Verursachte React Suspense Errors (#418, #423)

**Warum es jetzt funktioniert:**

App Bridge v4+ löst diese Probleme durch:
1. ✅ Automatische Session Token-Injektion in alle Requests
2. ✅ Globale `fetch()` Override für Authentication
3. ✅ iframe-Kommunikation mit Shopify Admin
4. ✅ URL-Parameter werden korrekt erhalten

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

#### Debugging Navigation-Probleme

**Backend Logs checken:**
```bash
# Railway Logs sollten zeigen:
🔍 [APP.TSX LOADER] Start - URL: /app/content
✅ [APP.TSX LOADER] Authentication successful
```

**Browser Console checken:**
```javascript
// Bei SPA-Navigation sollte zeigen:
🖱️ [MainNavigation] Tab clicked: content -> /app/content
🎯 [MainNavigation] Using client-side navigation (SPA)
🖱️ [MainNavigation] Navigating to: /app/content?embedded=1&hmac=...

// Kein Page Reload sollte stattfinden!
```

**Wenn Navigation nicht funktioniert:**
1. Prüfe ob App Bridge geladen ist: `console.log(window.shopify)`
2. Checke ob `<meta name="shopify-api-key">` im `<head>` vorhanden ist
3. Versuche Fallback zu Full Page Reload (siehe oben)
4. Überprüfe Railway Logs auf Authentication-Fehler

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

### 1. Projekt-Setup

1. Projekt mit Railway verbinden
2. Environment Variables setzen (siehe oben)
3. PostgreSQL Datenbank hinzufügen

### 2. Custom Start Command konfigurieren

**WICHTIG:** Setze den Start Command auf:

```bash
npm run start:migrate
```

**Wo:** Railway Dashboard → Service → Settings → Deploy → Start Command

**Warum:** Führt automatisch Datenbank-Migrationen vor jedem Start aus.

### 3. Nach dem Deployment

**Webhooks einrichten (einmalig):**

1. Öffne deine App im Shopify Admin
2. Navigiere zu `/app/setup`
3. Klicke auf **"Setup Webhooks"**
4. Erwartung: 9 Webhooks registriert
   - 3x Products (create, update, delete)
   - 3x Collections (create, update, delete)
   - 3x Articles/Blogs (create, update, delete)

**Content synchronisieren (einmalig):**

```javascript
// In der Browser Console (wenn du in der App eingeloggt bist):
fetch('/api/sync-content', { method: 'POST' })
  .then(r => r.json())
  .then(console.log)

// Erwartung: { success: true, stats: { collections: X, articles: Y, pages: Z } }
```

**Wichtig:** Nach Deployment App in Shopify installieren/neu autorisieren!

## 🏗️ Technische Architektur

### DB-Caching & Webhook-System

Die App verwendet eine **Dual-Sync Strategie** für maximale Performance und Konsistenz:

#### 1. Sofortiges DB-Update nach Save

Wenn ein User Content in der App speichert:

```
User speichert → Shopify Mutation → Success → DB Update → User sieht Änderung
                     (0.5s)           ✅         (0.1s)         (instant!)
```

**Implementierung:**

```typescript
// In app/routes/app.content.tsx
if (locale !== primaryLocale) {
  // Save to Shopify
  await admin.graphql(TRANSLATE_CONTENT, { ... });

  // 🔥 DIRECT DB UPDATE: Sofort nach Shopify-Success
  await db.contentTranslation.createMany({
    data: translationsInput.map(t => ({
      resourceId: itemId,
      resourceType: "Collection",  // or "Article", "Page"
      key: t.key,
      value: t.value,
      locale: t.locale,
    })),
  });
}
```

**Vorteile:**
- ⚡ **Instant Updates** - User sieht Änderungen sofort
- 💾 **Keine Wartezeit** - Kein Warten auf Webhooks
- 🎯 **Garantierte Konsistenz** - DB = Shopify direkt nach Save

#### 2. Webhook-basierte Synchronisierung

Für **externe Änderungen** (direkt in Shopify Admin):

```
Änderung in Shopify → Webhook Event → Background Job → DB Update
                         (1-3s)          (async)         ✅
```

**Registrierte Webhooks:**

| Topic | Handler | Funktion |
|-------|---------|----------|
| `products/create` | [webhooks.products.tsx](app/routes/webhooks.products.tsx) | Neues Produkt → DB |
| `products/update` | [webhooks.products.tsx](app/routes/webhooks.products.tsx) | Produkt-Update → DB |
| `products/delete` | [webhooks.products.tsx](app/routes/webhooks.products.tsx) | Produkt löschen aus DB |
| `collections/create` | [webhooks.collections.tsx](app/routes/webhooks.collections.tsx) | Neue Collection → DB |
| `collections/update` | [webhooks.collections.tsx](app/routes/webhooks.collections.tsx) | Collection-Update → DB |
| `collections/delete` | [webhooks.collections.tsx](app/routes/webhooks.collections.tsx) | Collection löschen aus DB |
| `articles/create` | [webhooks.articles.tsx](app/routes/webhooks.articles.tsx) | Neuer Artikel → DB |
| `articles/update` | [webhooks.articles.tsx](app/routes/webhooks.articles.tsx) | Artikel-Update → DB |
| `articles/delete` | [webhooks.articles.tsx](app/routes/webhooks.articles.tsx) | Artikel löschen aus DB |

**Webhook-Flow:**

```typescript
// 1. Shopify sendet Webhook
POST /webhooks/collections
  Body: { id: 123, title: "New Title", ... }

// 2. Webhook-Handler verifiziert Signature
const verified = verifyWebhook(rawBody, hmac);

// 3. Event wird in DB geloggt
await db.webhookLog.create({ shop, topic, payload, processed: false });

// 4. Background Processing (async - blockiert Shopify nicht)
processWebhookAsync(logId, shop, collectionId, topic);
  ↓
  ContentSyncService.syncCollection(collectionId)
  ↓
  - Fetch collection data from Shopify
  - Fetch all translations
  - Upsert to database
  ↓
  Mark webhook as processed
```

**Services:**

- **[ContentSyncService](app/services/content-sync.service.ts)** - Synchronisiert Collections, Articles, Pages
- **[ProductSyncService](app/services/product-sync.service.ts)** - Synchronisiert Produkte
- **[WebhookRegistrationService](app/services/webhook-registration.service.ts)** - Registriert Webhooks

#### 3. DB-basierter Loader

Alle Content-Seiten laden Daten aus der **lokalen PostgreSQL-Datenbank**, nicht von Shopify:

```typescript
// app/routes/app.content.tsx - Loader
const [collections, articles, pages] = await Promise.all([
  db.collection.findMany({
    where: { shop: session.shop },
    include: { translations: true },  // Alle Übersetzungen pre-loaded!
  }),
  db.article.findMany({ ... }),
  db.page.findMany({ ... }),
]);
```

**Performance-Verbesserung:**

| Operation | Vorher (Shopify API) | Jetzt (DB) | Verbesserung |
|-----------|---------------------|-----------|--------------|
| Page Load | 3-5 Sekunden | < 0.5 Sekunden | **10x schneller** |
| Language Switch | Broken (fetcher issue) | Instant | **∞ schneller** |
| After Save | Inconsistent | Instant | **Guaranteed** |

#### 4. Datenbank Schema

**Content Models:**

```prisma
model Collection {
  id              String   @id
  shop            String
  title           String
  descriptionHtml String?
  handle          String
  seoTitle        String?
  seoDescription  String?
  shopifyUpdatedAt DateTime
  lastSyncedAt     DateTime

  translations    ContentTranslation[]
}

model Article {
  id              String   @id
  shop            String
  blogId          String
  blogTitle       String
  title           String
  body            String?
  handle          String
  seoTitle        String?
  seoDescription  String?
  shopifyUpdatedAt DateTime
  lastSyncedAt     DateTime

  translations    ContentTranslation[]
}

model Page {
  id              String   @id
  shop            String
  title           String
  body            String?
  handle          String
  shopifyUpdatedAt DateTime
  lastSyncedAt     DateTime

  translations    ContentTranslation[]
}

model ContentTranslation {
  id           String  @id
  resourceId   String  // Collection/Article/Page ID
  resourceType String  // "Collection", "Article", or "Page"
  key          String  // "title", "body", "handle", etc.
  value        String
  locale       String  // "en", "fr", "es", etc.
  digest       String? // Shopify digest
}
```

**Sync Status Tracking:**

```prisma
model WebhookLog {
  id        String   @id
  shop      String
  topic     String   // "collections/update", etc.
  productId String?  // Resource ID
  payload   String   // Full webhook payload
  processed Boolean
  error     String?
  createdAt DateTime
}
```

#### 5. API Routes

- **[/api/sync-content](app/routes/api.sync-content.tsx)** - Bulk-Sync aller Collections, Articles, Pages
- **[/api/sync-products](app/routes/api.sync-products.tsx)** - Bulk-Sync aller Produkte
- **[/api/setup-webhooks](app/routes/api.setup-webhooks.tsx)** - Webhook-Registration

**Verwendung:**

```bash
# Alle Content synchronisieren
POST /api/sync-content

# Response:
{
  "success": true,
  "stats": {
    "collections": 15,
    "articles": 42,
    "pages": 8,
    "total": 65
  }
}
```

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
- Page Reload findet nicht statt (bei SPA-Navigation)

**Lösungen:**

1. **Prüfe App Bridge Initialisierung:**
   - Öffne Browser Console: `console.log(window.shopify)` sollte Object zeigen
   - Prüfe `<meta name="shopify-api-key">` im `<head>` vorhanden ist
   - Siehe [App Bridge Setup](#app-bridge-setup-und-post-request-authentifizierung)

2. **Fallback zu Full Page Reload:**
   - Falls SPA-Navigation nicht funktioniert, ändere [MainNavigation.tsx](app/components/MainNavigation.tsx) zu `window.location.href`
   - Siehe [Fallback-Lösung](#fallback-lösung-full-page-reload-falls-spa-navigation-probleme-macht)

3. **Überprüfe den AppProvider:**
   - Muss von `@shopify/polaris` importiert sein
   - NICHT von `@shopify/shopify-app-remix/react`

4. **Scopes überprüfen:**
   - Leerzeichen in `SHOPIFY_SCOPES` entfernen
   - App in Shopify neu installieren

5. **Session-Storage leeren:**
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

### DB-Caching & Webhook Issues

#### "Content-Seite lädt langsam / zeigt keine Daten"

**Symptome:**
- Content-Seite ist leer oder zeigt "0 Collections/Articles/Pages"
- Ladezeiten immer noch 3-5 Sekunden
- Railway Logs zeigen DB-Fehler

**Ursachen & Lösungen:**

1. **Migration nicht ausgeführt:**
   ```bash
   # Auf Railway:
   railway run npx prisma migrate deploy

   # Oder: Custom Start Command setzen (siehe Deployment)
   npm run start:migrate
   ```

2. **Content nicht synchronisiert:**
   ```javascript
   // In Browser Console (in der App):
   fetch('/api/sync-content', { method: 'POST' })
     .then(r => r.json())
     .then(console.log)

   // Sollte zeigen: { success: true, stats: { ... } }
   ```

3. **Webhooks nicht registriert:**
   - Gehe zu `/app/setup`
   - Klicke "Setup Webhooks"
   - Prüfe ob 9 Webhooks registriert wurden

#### "Änderungen werden nicht gespeichert"

**Symptome:**
- User speichert Content
- "Success" Message erscheint
- Nach Reload sind Änderungen weg

**Lösungen:**

1. **Prüfe Railway Logs:**
   ```bash
   railway logs | grep "CONTENT-UPDATE"

   # Sollte zeigen:
   [CONTENT-UPDATE] Updating DB for collection gid://...
   [CONTENT-UPDATE] ✓ Updated collection in DB
   ```

2. **DB-Konsistenz prüfen:**
   ```sql
   -- In Railway PostgreSQL Console:
   SELECT COUNT(*) FROM "Collection";
   SELECT COUNT(*) FROM "ContentTranslation";

   -- Sollte > 0 sein nach Sync
   ```

3. **Force Re-Sync:**
   ```javascript
   // Sync einzelnen Content-Type:
   fetch('/api/sync-content', { method: 'POST' })
   ```

#### "Webhooks werden nicht empfangen"

**Symptome:**
- Änderungen in Shopify Admin erscheinen nicht in der App
- Railway Logs zeigen keine `[WEBHOOK]` Messages
- WebhookLog Tabelle ist leer

**Lösungen:**

1. **Webhook-URLs prüfen:**
   - Gehe zu Shopify Admin → Settings → Notifications → Webhooks
   - URLs sollten sein: `https://your-app.railway.app/webhooks/[products|collections|articles]`
   - Status sollte "Connected" sein

2. **SHOPIFY_API_SECRET prüfen:**
   ```bash
   # Auf Railway:
   echo $SHOPIFY_API_SECRET

   # Sollte dein API Secret sein, nicht leer!
   ```

3. **Signature-Fehler debuggen:**
   ```bash
   railway logs | grep "WEBHOOK"

   # Bei Signature-Fehler:
   [WEBHOOK] Invalid signature
   [WEBHOOK] Expected: xxx
   [WEBHOOK] Received: yyy

   # → SHOPIFY_API_SECRET ist falsch!
   ```

4. **Webhook neu registrieren:**
   - `/app/setup` → "Setup Webhooks"
   - Oder: Manuelle Registration in Shopify Admin

#### "Performance nicht verbessert nach DB-Caching"

**Symptome:**
- Content-Seite lädt immer noch langsam (> 2 Sekunden)
- Keine Performance-Verbesserung sichtbar

**Checkliste:**

1. ✅ Migration ausgeführt? (`npm run start:migrate`)
2. ✅ Content synchronisiert? (`POST /api/sync-content`)
3. ✅ Railway Logs zeigen DB-Queries? (`[CONTENT-LOADER]`)
4. ✅ Browser-Cache geleert?

**Debugging:**

```javascript
// In Browser Console:
performance.mark('start');

// Navigiere zu Content-Seite, dann:
performance.mark('end');
performance.measure('load', 'start', 'end');
console.log(performance.getEntriesByType('measure'));

// Sollte < 1000ms sein für DB-basiertes Load
```

#### "Translations fehlen nach Save"

**Symptome:**
- User speichert Übersetzung
- Success Message
- Übersetzung fehlt beim Language-Switch

**Ursache:** Direct DB Update schlägt fehl

**Lösung:**

```bash
# Railway Logs prüfen:
railway logs | grep "CONTENT-UPDATE"

# Bei Fehler:
[CONTENT-UPDATE] Error: ...
# → Checke Prisma Schema, unique constraints, etc.

# Webhook als Fallback prüfen:
railway logs | grep "ContentSync"
# Sollte zeigen:
[ContentSync] ✓ Saved X translations to DB
```

## 📄 Lizenz

ISC
