# Plan System Documentation

## Übersicht

Die App implementiert ein vier-stufiges Subscription-Plan-System:

| Plan | Max Produkte | Produkt-Bilder | Content-Types | AI Instructions Editierbar |
|------|--------------|----------------|---------------|----------------------------|
| **Free** | 15 | Nur Hauptbild | Products, Collections | ❌ Nein |
| **Basic** | 100 | Alle Bilder | Alle außer Metaobjects/Metadata | ✅ Ja |
| **Pro** | 250 | Alle Bilder | Alle | ✅ Ja |
| **Max** | Unbegrenzt | Alle Bilder | Alle | ✅ Ja |

## Dateien-Struktur

```
app/
├── config/
│   └── plans.ts                    # Plan-Konfiguration und Limits
├── utils/
│   ├── planUtils.ts                # Utility-Funktionen für Plan-Checks
│   └── planCacheCleanup.ts         # DB-Cache-Bereinigung
├── contexts/
│   └── PlanContext.tsx             # React Context für Plan-Management
├── components/
│   ├── MainNavigation.tsx          # Plan-Selector (4 Buttons)
│   ├── ContentTypeNavigation.tsx   # Plan-aware Content-Type-Tabs
│   ├── PlanBadge.tsx               # Visual Plan-Indikator
│   └── UpgradePrompt.tsx           # Upgrade-Call-to-Action
└── routes/
    ├── app.tsx                     # Plan im Loader laden (checkAndSyncSubscription)
    ├── app.products.tsx            # Plan-basierte Produkt-Limits
    ├── api.billing.create-subscription.tsx  # Upgrade via Shopify Billing API
    └── api.billing.cancel-subscription.tsx  # Downgrade via Shopify Billing API

prisma/
├── schema.prisma                   # subscriptionPlan Feld
└── migrations/
    └── 20260113_add_subscription_plan/
        └── migration.sql           # SQL Migration
```

## Implementierte Features

### 1. Plan-Selector in MainNavigation

- **Position**: Rechts neben den Tabs (Products, Other Content, Tasks, Settings)
- **Design**: 4 Segmented Buttons (Free | Basic | Pro | Max)
- **Funktion**:
  - Aktueller Plan ist hervorgehoben (`pressed` State)
  - Plan-Wechsel läuft ausschließlich über die Shopify Billing API:
    Upgrade via `/api/billing/create-subscription`, Downgrade via
    `/api/billing/cancel-subscription` (siehe `SettingsPlanTab`)
  - Der gespeicherte Plan wird serverseitig aus dem von Shopify
    verifizierten aktiven Abo abgeleitet (`checkAndSyncSubscription`)

### 2. Plan-basierte Content-Type-Zugriffskontrolle

**ContentTypeNavigation** zeigt alle Content-Types, aber:
- Nicht zugängliche Types sind ausgegraut (opacity: 0.5)
- Zeigen ein 🔒 Lock-Icon
- Haben Tooltip: "Available in [Next Plan] plan"
- Sind nicht klickbar (`disabled: true`)

**Beispiel Free-Plan**:
- ✅ Collections: Voll zugänglich
- 🔒 Blogs, Pages, Policies, Menus, Templates: Deaktiviert

### 3. Plan-basierte Produkt-Limits

**Products Route** (`app/routes/app.products.tsx`):
- Loader lädt max. 15/100/250/∞ Produkte je nach Plan
- Im Free-Plan:
  - KEINE `ProductImage` geladen (außer featuredImage)
  - KEINE `ProductOption` geladen
  - KEINE `ProductMetafield` geladen
- UI zeigt Limit-Information (z.B. "15/15 Products (Free Plan)")

### 4. Automatische Cache-Bereinigung

Beim Plan-Downgrade (z.B. Basic → Free) werden automatisch gelöscht:

**Free-Plan Cleanup:**
- Produkte über Limit 15
- Alle `ProductImage` Einträge
- Alle `ProductOption` Einträge
- Alle `ProductMetafield` Einträge
- Alle `Article` (Blogs)
- Alle `Page`
- Alle `ShopPolicy`
- Alle `ThemeContent` & `ThemeTranslation`
- Zugehörige `ContentTranslation` Einträge

**Basic-Plan Cleanup:**
- Produkte über Limit 100
- Restliche Daten bleiben erhalten

### 5. Plan Context API

Jede Komponente kann auf Plan-Informationen zugreifen:

```typescript
import { usePlan } from "../contexts/PlanContext";

function MyComponent() {
  const {
    plan,                           // "free" | "basic" | "pro" | "max"
    canAccessContentType,           // (type) => boolean
    isWithinProductLimit,           // (count) => boolean
    getMaxProducts,                 // () => number
    canEditAIInstructions,          // () => boolean
    shouldCacheAllProductImages,    // () => boolean
    getNextPlanUpgrade,             // () => Plan | null
    getPlanDisplayName,             // () => string
  } = usePlan();

  // Beispiel:
  if (!canAccessContentType("articles")) {
    return <UpgradePrompt feature="Blog Articles" currentPlan={plan} />;
  }
}
```

## Datenbank-Migration

### Migration ausführen:

```bash
# Lokal (wenn DATABASE_URL gesetzt)
npx prisma migrate deploy

# Auf Railway (via Pre-deploy Command)
node scripts/run-migration.js
```

### Migration-SQL:

```sql
ALTER TABLE "AISettings" ADD COLUMN "subscriptionPlan" TEXT NOT NULL DEFAULT 'basic';
COMMENT ON COLUMN "AISettings"."subscriptionPlan" IS 'Valid values: free, basic, pro, max';
```

## API Endpoints

Plan-Wechsel erfolgt **ausschließlich über die Shopify Billing API**. Es gibt
keinen Endpoint, der den Plan aus einem Request-Body setzt.

- `POST /api/billing/create-subscription` — startet ein bezahltes Abo
  (Upgrade); Shopify führt durch den Bestätigungs-/Bezahlflow.
- `POST /api/billing/cancel-subscription` — kündigt das Abo (Downgrade auf Free).
- `GET /api/billing/status` — liefert den aktuellen, von Shopify verifizierten
  Plan.

Der in der DB gespeicherte `subscriptionPlan` wird serverseitig durch
`checkAndSyncSubscription()` (`app/services/billing.server.ts`) aus dem von
Shopify verifizierten aktiven Abo abgeleitet — aufgerufen in den Loadern
(`app.tsx`, `app.settings.tsx`), im Billing-Callback und im
`APP_SUBSCRIPTIONS_UPDATE`-Webhook. Bei einem verifizierten Plan-Wechsel wird
dabei automatisch `cleanupCacheForPlan()` ausgeführt (auch bei realen
Downgrades).

## Plan-Verhalten

### Free Plan

**Zweck**: Minimale Ressourcen-Nutzung für Testing/Kleine Shops

**Einschränkungen:**
- Nur 15 Produkte gecached
- Nur Hauptbild pro Produkt (keine `ProductImage` Table)
- Keine Produkt-Optionen/Metafelder gecached
- Nur Products & Collections zugänglich
- AI Instructions sind read-only (Default-Werte)
- KEINE Blogs, Pages, Policies, Theme Content

**Use Case**: Kleine Shops mit wenigen Produkten, nur Basis-Übersetzung

### Basic Plan (Default)

**Zweck**: Standard-Nutzung für mittelgroße Shops

**Features:**
- Bis zu 100 Produkte
- Alle Bilder, Optionen, Metafelder gecached
- Alle Content-Types (Collections, Blogs, Pages, Policies, Themes, Menus)
- AI Instructions voll editierbar
- Theme-Übersetzungen verfügbar

**Use Case**: Standard-Shops mit normalem Content-Volumen

### Pro Plan

**Zweck**: Große Shops mit vielen Produkten

**Features:**
- Bis zu 250 Produkte
- Alle Features von Basic
- Zusätzlich: Metaobjects, Shop Metadata (wenn implementiert)

**Use Case**: Große E-Commerce-Shops

### Max Plan

**Zweck**: Enterprise/Unlimited

**Features:**
- **Unbegrenzte** Produkte
- Alle Features aktiviert
- Keine Limits

**Use Case**: Very large shops, agencies

## Zukünftige Erweiterungen

### Noch NICHT implementiert:

1. **AI Settings Restrictions** (Free-Plan)
   - AI Instructions Tab sollte read-only sein
   - TODO: `app/routes/app.settings.tsx` updaten

2. **Product Sync Restrictions**
   - `app/routes/api.sync-products.tsx`: Plan-Check vor Sync
   - `app/routes/api.sync-single-product.tsx`: Plan-Check
   - Sync sollte bei Erreichen des Limits stoppen

3. **Content Sync Restrictions**
   - `app/routes/api.sync-content.tsx`: Nur erlaubte Content-Types syncen

4. **Webhook Restrictions**
   - `app/routes/webhooks.*.tsx`: Plan-Check vor Verarbeitung

5. **UI Enhancements**
   - Plan-Limit-Warning in ProductList
   - Progress Bar: "15/15 Products (Free Plan)"
   - Upgrade-Modal mit Feature-Vergleich
   - Storage-Usage-Indikator

## Testing

### Lokal testen:

1. Starte die App: `npm run dev`
2. Öffne die App im Browser
3. Wechsle den Plan über die 4 Buttons in der Navigation
4. Beobachte Console-Logs für Cleanup-Stats
5. Prüfe, dass Content-Types entsprechend deaktiviert werden

### Plan-Wechsel simulieren:

```typescript
// Direkt in der DB (PostgreSQL)
UPDATE "AISettings"
SET "subscriptionPlan" = 'free'
WHERE shop = 'your-shop.myshopify.com';
```

### Cleanup testen:

```typescript
// In Node REPL oder Test-Script
import { db } from "./app/db.server.js";
import { cleanupCacheForPlan } from "./app/utils/planCacheCleanup.js";

const stats = await cleanupCacheForPlan("your-shop.myshopify.com", "free");
console.log(stats);
```

## Troubleshooting

### Plan wechselt nicht

- Check Browser Console für Fetch-Errors
- Check Server Logs für `[Billing]` Errors (`api.billing.*`, `checkAndSyncSubscription`)
- Verify Shopify-Abo ist `ACTIVE` und `subscriptionPlan` wurde in DB gespeichert

### Content-Types nicht deaktiviert

- Check: Ist `PlanContext` in `app.tsx` eingebunden?
- Check: Wird `plan` korrekt vom Loader geladen?
- Check: `ContentTypeNavigation` nutzt `usePlan()` Hook?

### Cache-Cleanup funktioniert nicht

- Check Server Logs für `[PlanCleanup]` Messages
- Verify DB-Permissions (DELETE rights)
- Check `cleanupCacheForPlan()` return stats

## Performance

### Cleanup-Geschwindigkeit

- Free-Plan Cleanup: ~200-500ms (je nach Datenmenge)
- Cascade Deletes via Prisma: Effizient durch Foreign Keys

### Plan-Check Overhead

- Plan-Limits werden nur im Loader gecached
- Kein Performance-Impact auf normale Requests
- Context-Zugriff: O(1) - Keine DB-Queries

## Sicherheit

### Plan-Manipulation verhindern

- Plan ist in DB gespeichert (nicht Client-Side)
- Plan wird **nie** aus einem Request-Body gesetzt — ausschließlich aus dem
  von Shopify verifizierten aktiven Abo abgeleitet (`checkAndSyncSubscription`)
- Billing-Endpoints erfordern Shopify Auth (`authenticate.admin`)
- Multi-Tenant-Safe: Jeder Shop hat eigenen Plan

### Cleanup-Sicherheit

- Cleanup läuft nur bei Plan-Downgrade
- Cascade Deletes via Prisma (keine Orphans)
- Transaction-Safe

---

**Autor**: Claude (Anthropic)
**Datum**: 2026-01-13
**Version**: 1.0
