# Plan System Documentation

## Übersicht

Die App implementiert ein vier-stufiges Subscription-Plan-System:

> Quelle der Wahrheit: [`app/config/plans.ts`](../../app/config/plans.ts) (`PLAN_CONFIG`).
> Diese Tabelle spiegelt exakt die dortigen Werte wider.

| Plan | Max Produkte | Max Collections | Max Pages | Max Articles | Locales | Produkt-Bilder | Content-Types | AI Instructions editierbar |
|------|-------------|-----------------|-----------|--------------|---------|----------------|---------------|----------------------------|
| **Free** | 50 | 5 | 0 | 0 | ∞ | Nur Hauptbild | Products, Collections | ❌ Nein |
| **Basic** | 100 | 50 | 20 | 0 | ∞ | Alle Bilder | Products, Collections, Pages, Policies | ❌ Nein |
| **Pro** | 500 | 100 | 50 | 100 | ∞ | Alle Bilder | Alle (inkl. Blogs/Articles, Menus, Templates, Metaobjects) | ✅ Ja |
| **Max** | 2500 | 500 | 200 | 300 | ∞ | Alle Bilder | Alle (inkl. Blogs/Articles, Menus, Templates, Metaobjects) | ✅ Ja |

> **Locales sind bewusst unbegrenzt auf allen Tiers** (Entscheidung 2026-05):
> AI-Tokens sind merchant-finanziert (BYO-Key), zusätzliche Sprachen kosten uns
> nichts. Sprach-Großzügigkeit ist ein bewusster USP — Segmentierung erfolgt
> über Produktanzahl & Content-Breite, nicht über Locale-Anzahl. Produkt-Caps
> auf geometrische Staffelung umgestellt (25 → 100 → 500 → 2500). Hintergrund:
> `ROADMAP.md` §Limit-Review.

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
│   ├── SettingsPlanTab.tsx         # Plan-Auswahl/Upgrade (Shopify Billing API)
│   ├── ContentTypeNavigation.tsx   # Plan-aware Content-Type-Tabs
│   └── PlanAccessGate.tsx          # Sperrt eine Seite/Sektion unter dem nötigen Plan
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

### 1. Plan-Auswahl im Settings-Tab

- **Position**: Settings → Plan-Tab (`SettingsPlanTab.tsx`). MainNavigation
  enthält **keinen** Plan-Selector mehr.
- **Funktion**:
  - Aktueller Plan ist hervorgehoben
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
- Loader lädt max. 50/100/500/2500 Produkte je nach Plan (Free/Basic/Pro/Max)
- Im Free-Plan:
  - KEINE `ProductImage` geladen (außer featuredImage)
  - KEINE `ProductOption` geladen
  - KEINE `ProductMetafield` geladen
- UI zeigt Limit-Information (z.B. "25/25 Products (Free Plan)")

### 4. Automatische Cache-Bereinigung

Beim Plan-Downgrade (z.B. Basic → Free) werden automatisch gelöscht:

**Free-Plan Cleanup:**
- Produkte über Limit 50
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
    return <PlanAccessGate contentType="articles">{children}</PlanAccessGate>;
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
-- Baseline legte die Spalte historisch mit DEFAULT 'basic' an. Die Folge-
-- Migration 20260516000002_default_subscription_plan_free gleicht den
-- DB-Default an das Prisma-Schema an (DEFAULT 'free'):
ALTER TABLE "AISettings" ADD COLUMN "subscriptionPlan" TEXT NOT NULL DEFAULT 'free';
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
- Nur 50 Produkte gecached
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
- Content-Types: Products, Collections, Pages, Policies (KEINE Blogs/Menus/
  Templates/Metaobjects — erst ab Pro)
- AI Instructions read-only (erst ab Pro editierbar)

**Use Case**: Standard-Shops mit normalem Content-Volumen

### Pro Plan

**Zweck**: Große Shops mit vielen Produkten

**Features:**
- Bis zu 500 Produkte
- Alle Features von Basic
- Zusätzlich: Blogs/Articles, Menus, Templates, Metaobjects
- AI Instructions editierbar (erster Plan mit dieser Funktion)
- Variant Image Manager / Bulk-Upload / WebP: **2000** Bild-Operationen/Monat,
  2 parallele WebP-Konvertierungen

**Use Case**: Große E-Commerce-Shops

### Max Plan

**Zweck**: Enterprise/Unlimited

**Features:**
- Bis zu **2500** Produkte (höchstes Limit, nicht „unbegrenzt")
- Alle Features aktiviert (höhere Limits als Pro: 500 Collections, 200 Pages,
  300 Articles; Locales unbegrenzt wie alle Tiers)
- Variant Image Manager / Bulk-Upload / WebP: **10000** Bild-Operationen/Monat
  (5× Pro), **6** parallele WebP-Konvertierungen (3× Pro) — kostenausgerichtete
  Pro→Max-Differenzierer (AI ist BYO)
- SEO-Tab: nächtlicher Auto-Audit (exklusiv), 12 Monate Score- und
  Ranking-Historie, 1000 Keywords, 480-Tage-GSC-Fenster, 50 000
  IndexNow-URLs/Monat, 2500er-Bulk-Batches — siehe „SEO-Entitlements" unten

**Use Case**: Very large shops, agencies

### SEO-Entitlements (`PlanLimits.seo`)

Eigener Block in `app/config/plans.ts`, ausgewertet über die `getSeo*`-Helper in
`planUtils.ts`. **Leitprinzip: Pro bekommt die vollständige SEO-Feature-Fläche,
Max kauft Automatisierung, Gedächtnis, Skalierung und Durchsatz.** Vorher war
`planGate: "pro"` die höchste Stufe im gesamten SEO-Tab — Max schaltete dort
nichts frei. Segmentiert wird ausschließlich an realen wiederkehrenden Kosten
(geplante Compute-Zyklen, Snapshot-Storage, Google-API-Calls, Queue-Durchsatz),
dieselbe Achse wie `monthlyImageOperations` und `dailyPageSpeedRuns` — nie an
der Sprachanzahl (bewusster USP) und nie am Basis-Audit.

| Dimension | Free | Basic | Pro | Max |
|---|---|---|---|---|
| Audit, Ladezeit, Structured Data, Redirects, hreflang, AEO | ✅ | ✅ | ✅ | ✅ |
| `bulkBatchSize` (Elemente/Bulk-Lauf) | 25 | 100 | 500 | **2500** |
| `maxTrackedKeywords` | 0 | 25 | 100 | **1000** |
| `scoreHistoryDays` (Score- + Ranking-Historie) | 0 | 0 | 30 | **365** |
| `gscProperties` / `gscHistoryDays` | 0 / 0 | 0 / 0 | 1 / 28 | 1 / **480** |
| `monthlyIndexNowSubmissions` | 0 | 0 | 5000 | **50000** |
| `scheduledAudit` (Nacht-Audit) | ❌ | ❌ | ❌ | **✅** |

`0` = Feature gesperrt (nicht „leeres Kontingent"), gleiche Konvention wie
`monthlyImageOperations`. `canAccessSeoFeature()` **leitet** den booleschen
Zugriff aus den Zahlen ab, damit Quota und Flag nicht driften können.

**Wo das durchgesetzt wird** (immer server-seitig, `usePlan()` ist Kosmetik):

| Dimension | Durchsetzung |
|---|---|
| `scheduledAudit` | `services/seo/audit-auto-run.service.ts` — Sweep wählt nur Shops auf einem Plan mit dem Flag (Filter in der Query) |
| `scoreHistoryDays` | `saveAuditSnapshot` (Score-Snapshots) + `enrichKeywordsFromGsc` (Ranking-Snapshots) prunen nach Alter; die neueste Zeile überlebt immer |
| `maxTrackedKeywords` | `keywords.service.ts` (`getKeywordQuota`) in `assignKeyword` / `createKeyword` / `addKeywordsToGroup`; Section-Gate `planGate:"basic"` |
| `gscHistoryDays` | `defaultDateRange(now, days)` in `app.seo.search-console.tsx` + Export-Route |
| `monthlyIndexNowSubmissions` | `index-now.service.ts` (`getSubmitQuota`) in `drainQueue` / `submitAll` / `canSubmitAll`, Zähler auf `SeoIndexNowConfig` |
| `bulkBatchSize` | `seo-bulk-fix.handler.ts` kappt die Item-Liste |

**Downgrade-Regel — wichtig:** `planCacheCleanup` löscht **Cache** (aus Shopify
nachsyncbar). `SeoKeyword` ist merchant-eigene Recherche und wird deshalb
**niemals** gelöscht: ein Shop über dem Cap behält alle Keywords, kann nur keine
neuen anlegen (`isOverKeywordQuota` → Banner + deaktivierter „Hinzufügen"-Button,
`getKeywordQuota` im Loader). Abgeleitete Daten (Score-/Ranking-Snapshots) folgen
dagegen der Plan-Retention. Der IndexNow-Zähler ist Nutzungsdatum → lazy, kein
Cleanup.

### Bild-Operationen (monthlyImageOperations)

Rolling-Monats-Quota auf abrechenbare Bild-Operationen (Bulk-Upload +
WebP-Konvertierung) — unser realer variabler Kostentreiber (Compute/Bandbreite),
da AI-Tokens merchant-finanziert (BYO) sind. Free/Basic = 0 (kein Image Manager),
Pro 2000, Max 10000. **Lazy erzwungen** an den Upload-/Convert-Pfaden (wie
`maxProducts`), Ganze-Batch-Semantik, UTC-Monats-Reset ohne Cron. Es ist
Nutzungs-, **keine** Entitlement-Daten → bewusst **nicht** in `getSyncScope` /
`planCacheCleanup` (kein Downgrade-Cleanup). `maxConcurrentWebpConversions` ist
in `app/config/webp-concurrency.js` zentralisiert (Single Source of Truth für
`plans.ts` *und* den Node-`webp-processor.service.js`; Drift-Guard-Test).

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
   - Progress Bar: "25/25 Products (Free Plan)"
   - Upgrade-Modal mit Feature-Vergleich
   - Storage-Usage-Indikator

## Testing

### Lokal testen:

1. Starte die App: `npm run dev`
2. Öffne die App im Browser
3. Wechsle den Plan über den Settings → Plan-Tab (Shopify Billing Flow)
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
