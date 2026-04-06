# Code Review Progress - ContentPilot

**Branch:** `claude/continue-code-review-cleanup-AYUbc`
**Started:** 2026-04-06
**Based on:** prior branch `claude/continue-code-review-cleanup-NWLyp` (Tasks 1–22 completed there)

---

## Status Overview

| Task | Status | Notes |
|------|--------|-------|
| 1. Logging Consolidation | ✅ Done | Replaced server-side `console.*` in `app.tasks.tsx` |
| 2. Input Validation (Zod) | ✅ Done | Schemas + `parseJsonBody` helper; applied to `api.update-plan.tsx` and `api.sync-content.tsx` |
| 3. Test Coverage Config | ✅ Done | `@vitest/coverage-v8` installed; thresholds set at 20% |
| 4. Bug Fix: Hardcoded Plan Values | ✅ Done | Fixed in `UnifiedContentEditor.tsx` |
| 5. GDPR Audit Log | ✅ Done | `GdprAuditLog` DB table + persistent logging in `gdpr.service.ts` |
| 6. Template Handlers | ✅ Done | AI/translate handlers in `app.content.tsx` submit to `/app/templates` action |
| 7. any-Type Cleanup | ✅ Done | 23x `catch (error: any)` → `unknown` in routes; `UnifiedContentEditor` props typed |
| 8. Service `catch (error: any)` Cleanup | ✅ Done | Fixed 4 remaining catch blocks in service files |
| 9. Promise.all Review | ✅ Done | Both sites analysed; no changes needed (see below) |
| 10. Route Scan (5 routes) | ✅ Done | No issues found; all routes use `authenticate.admin`; no `catch (error: any)` |
| 11. useUnifiedContentEditor.ts Inspection | ✅ Done | No `catch (error: any)` remaining; race conditions properly guarded |
| 12. Unit Tests (gdpr + validation) | ✅ Done | 2 new test files written |
| 13. catch(error:any) in Components/Utils | ✅ Done | 4 remaining blocks fixed |
| 14. console.log in content.service.ts | ✅ N/A | All 24 calls are inside a block comment (dead code) |
| 15. Zod validation on 4 routes | ✅ N/A | Validation is centralized in `handleUnifiedContentActions`; routes just pass formData through |
| 16. any-Types in Services (top 10) | ✅ Done | `billing.server.ts`, `webhook-registration.service.ts`, `content.service.ts` |
| 17. Unit Tests (billing + webhook) | ✅ Done | 2 new test files written |
| 18. any-Types in loader-factory.server.ts | ✅ Done | 8 remaining `: any` replaced with proper types |
| 19. any-Types in contentEditor.utils.ts | ✅ Done | 11 metaobject-branch `any` patterns replaced via MetaobjectEntry interface |
| 20. Null-Safety: formData.get() as string | ✅ Done | 12 unsafe casts replaced with getFormString() + 400 guards in 5 routes |
| 21. any-Types in Gateway + Retry Services | ✅ Done | QueuedRequest typed; WebhookHandler payload typed; processRetry uses Prisma type |
| 22. Unit Tests (background-sync + gateway) | ✅ Done | 9 new tests across 2 files; all 148 tests pass |
| 23. any-Types in product-sync.service.ts | ✅ Done | ~20 any removed: BulkProductsQueryResponse + TranslatableResourcesByIdsResponse interfaces; `Prisma.TransactionClient`; catch blocks → unknown |
| 24. MetaobjectEntry in 3 files | ✅ Done | Exported MetaobjectEntry from contentEditor.utils.ts; fixed content-fields.config.tsx, useUiDataLoader.ts, UnifiedContentEditor.tsx |
| 25. ShopLocale + I18n any-types in UI | ✅ Done | OptionsField, ThemeContentViewer, UnifiedContentEditor → ShopLocale; StoragePieChart, SettingsUsageLimitsTab, SettingsSetupTab, SettingsAITab, ApiKeyWarningBanner, SettingsLanguageTab → I18nTranslation |
| 26. any-Types in useUnifiedContentEditor.ts | ✅ Done | TaskData interface; filter/map callbacks typed |
| 27. any-Types in SettingsSetupTab.tsx | ✅ Done | WebhookEntry interface; all `(w: any)` replaced |
| 28. Smaller remaining any-casts | ✅ Done | ReloadButton, useProductSubResources (SubResourceFetcherData), MobileToolbar (ContentImage), content-sync.service.ts (Prisma.InputJsonValue), LocaleNavigationButtons |

**Final any-count:** 0 in app/services/ (outside catch blocks); 9 in app/components/ (all unavoidable Framework/Polaris limitations)

---

## 1. Logging Consolidation

**Goal:** Replace `console.*` calls with the existing Winston logger at `app/utils/logger.server.ts`

**Findings:**
- Logger already exists and is imported in many files
- 492 total `console.*` calls across 53 files
- Key server-side files still using raw console:
  - `app/services/content.service.ts` – 24 debug-level calls (menus section)
  - `app/routes/app.tasks.tsx` – 3 calls
  - `app/routes/app._index.tsx` – 1 call
  - `app/routes/app.templates.tsx` – 1 call
  - `app/routes/app.tsx` – 1 call
  - `src/index.ts` – 24 calls (standalone demo script, low priority)
  - `src/oauth-setup.ts` – 38 calls (standalone CLI script, low priority)

**Completed:**
- [x] `app/routes/app.tasks.tsx` – replaced 3x `console.error` with `logger.error` (loader + action)
- Note: `app/services/content.service.ts` – all 24 calls are inside a block comment (commented-out code); no change needed
- Note: `app/routes/app.templates.tsx`, `app/routes/app.tsx` – client-side browser code; `console.error` is appropriate there
- Note: `src/index.ts`, `src/oauth-setup.ts` – standalone CLI scripts; `console.*` is intentional for CLI output

---

## 2. Input Validation (Zod)

**Goal:** Add Zod schemas to API route action/loader functions for request body validation

**Findings:**
- Zod v4.3.5 already installed as dependency
- `app/utils/validation.ts` and `app/utils/form-data.utils.ts` exist with some helpers
- No systematic Zod schema validation on API routes yet

**Completed:**
- [x] Added to `app/utils/validation.ts`:
  - `AIRequestBaseSchema` – common fields for all AI actions
  - `AITranslateFieldSchema` – for `translateField`/`rewriteField` actions
  - `SyncContentQuerySchema` – for `api.sync-content.tsx` query params
  - `UpdatePlanSchema` – for `api.update-plan.tsx` JSON body
  - `parseJsonBody()` – reusable helper for JSON body parsing + validation
- [x] `api.update-plan.tsx` – replaced manual plan check with `parseJsonBody(request, UpdatePlanSchema)`
- [x] `api.sync-content.tsx` – replaced unvalidated `types` string split with `SyncContentQuerySchema.safeParse()`
- Note: `api.ai.tsx` and `api.billing.create-subscription.tsx` already have solid manual validation; schemas available for future adoption

---

## 3. Test Coverage Configuration

**Goal:** Configure Vitest coverage reporting with thresholds

**Findings:**
- `vitest.config.ts` exists but has no coverage configuration
- `npm run test:coverage` script exists in package.json
- `@vitest/coverage-v8` not yet in devDependencies

**Completed:**
- [x] Installed `@vitest/coverage-v8@^4.1.2` as devDependency
- [x] Added `coverage` config to `vitest.config.ts`:
  - Provider: `v8`
  - Reporters: `text`, `json`, `html`
  - Output: `./coverage/`
  - Includes: `app/**/*.{ts,tsx}`, `src/**/*.ts`
  - Excludes: entry files, examples, standalone scripts
  - Thresholds: 20% (baseline – increase as test suite grows)
- Run with: `npm run test:coverage`

---

---

## 4. Bug Fix: Hardcoded Plan Values in UnifiedContentEditor

**Status:** ✅ Fixed (2026-04-06)

**Issue:** `CODE_IMPROVEMENTS.md` listed this as fixed, but the 3 hardcoded TODO values were still present in production code. This caused:
- Plan limit dialogs always showing "current" as plan name instead of the real plan
- Upgrade prompts always suggesting "Pro" regardless of the user's actual plan
- `isFreePlan` always `false`, bypassing free-plan feature gates for image alt-text generation

**Root cause:** `FieldRenderer` is a separate component inside `UnifiedContentEditor.tsx` and does not inherit the parent's `usePlan()` call.

**Files fixed:**
- `app/components/UnifiedContentEditor.tsx`

**Changes:**
```tsx
// BEFORE (broken)
currentPlan: "current",      // TODO: Get from plan context
nextPlan: "Pro",             // TODO: Get from plan context
isFreePlan={false}           // TODO: Get from plan context

// AFTER (correct)
import { getPlanDisplayName as getPlanDisplayNameUtil } from "../utils/planUtils";

// In UnifiedContentEditor:
const { plan, getMaxProducts, getNextPlanUpgrade } = usePlan();
currentPlan: getPlanDisplayNameUtil(plan),
nextPlan: nextPlan ? getPlanDisplayNameUtil(nextPlan) : undefined,

// In FieldRenderer (separate component):
const { plan } = usePlan();
isFreePlan={plan === 'free'}
```

---

---

## 5. GDPR Audit Log

**Status:** ✅ Done (2026-04-06)

**Issue:** `logGDPRRequest()` in `gdpr.service.ts:290` only logged to Winston but never persisted to the database, violating GDPR Art. 5(2) accountability requirements (3-year retention).

**Changes:**
- `prisma/schema.prisma` – Added `GdprAuditLog` model with indexes on `shop`, `requestType`, `requestedAt`
- `prisma/migrations/20260406085834_add_gdpr_audit_log/migration.sql` – Migration SQL
- `app/services/gdpr.service.ts` – `logGDPRRequest()` now calls `db.gdprAuditLog.create()` after logging; `dataExported` param typed as `unknown` instead of `any`

---

## 6. Template Handlers in app.content.tsx

**Status:** ✅ Done (2026-04-06)

**Issue:** `handleGenerateAI`, `handleTranslate`, `handleTranslateAll` in `app.content.tsx:231-245` were empty stubs with TODO comments.

**Solution:** Implemented handlers to submit form data to the existing `/app/templates` action (which already has full AI + translation logic). Added a `useEffect` that reads `fetcher.data` to update `aiSuggestions` and `editableValues` from the action responses.

**Files changed:**
- `app/routes/app.content.tsx`

---

## 7. any-Type Cleanup

**Status:** ✅ Done (2026-04-06)

**Issue:** 23x `catch (error: any)` in route files; `UnifiedContentEditor` had `items: any[]`, `shopLocales: any[]`, `t: any` props.

**Changes:**
- All `catch (error: any)` → `catch (error: unknown)` in 19 route files; `error.message`/`error.stack` accesses wrapped with `instanceof Error` guards
- `app/components/UnifiedContentEditor.tsx` – `items: TranslatableContentItem[]`, `shopLocales: ShopLocale[]`, `t: I18nTranslation`; same for `FieldRendererProps`; added proper imports

---

---

## 8. Service `catch (error: any)` Cleanup

**Status:** ✅ Done (2026-04-06)

**Files changed:**
- `app/services/webhook-registration.service.ts` – 3x `catch (error: any)` → `unknown`; `error.message` → `error instanceof Error ? error.message : String(error)`
- `app/services/shopify-api-gateway.service.ts` – 1x `catch (error: any)` → `unknown`; `error.status` → `(error as { status?: number }).status`; `error.message.includes(...)` guarded with `instanceof Error`

---

## 9. Promise.all Review

**Status:** ✅ Done (2026-04-06) – No changes needed

### product-sync.service.ts:1473
`Promise.all` runs inside a Prisma transaction (`tx.productImage.create` per image). If one image insertion fails the transaction rolls back entirely – that is the correct all-or-nothing behaviour. **Keep as `Promise.all`.**

### background-sync.service.ts:1438
`Promise.all` already has a per-item `.catch()` handler that returns `0` if a single content-type sync fails. Individual failures are isolated and logged; the overall sync still completes. **Already safe – no change needed.**

---

## 10. Route Scan (5 routes)

**Status:** ✅ Done (2026-04-06) – No issues found

| Route | Auth | `catch (error: any)` | Hardcoded values | Notes |
|-------|------|----------------------|-----------------|-------|
| `app.blog.tsx` | `authenticate.admin` ✅ | None | None | Clean |
| `app.collections.tsx` | `authenticate.admin` ✅ | None | `"free"` as DB fallback | Acceptable default |
| `app.pages.tsx` | `authenticate.admin` ✅ | None | None | Clean |
| `app.metaobjects.tsx` | `authenticate.admin` ✅ | None | None | Clean |
| `app.billing.callback.tsx` | `authenticate.admin` ✅ | None (uses `catch (error)` with proper guard) | None | Clean |

---

## 11. useUnifiedContentEditor.ts Inspection

**Status:** ✅ Done (2026-04-06) – No changes needed

### submitAIAction (lines 897–956)
Uses `fetch` directly (not the Remix fetcher), so parallel AI requests are independent – no race condition. Loading state is tracked per-field via a `Set<string>`. The `finally` block always clears the field key. **No issues.**

### Fetcher-Pending Guard (lines 1165–1172)
The FIFO queue (`saveQueueRef`) plus `justSubmittedRef` guard correctly prevents concurrent `fetcher.submit()` calls from aborting in-flight saves. The guard checks both `fetcherRef.current.state !== 'idle'` and `justSubmittedRef.current`. **Guard is complete.**

### Remaining `catch (error: any)` blocks
`grep` found **0** occurrences – already fully cleaned up in Task 7.

---

## 12. Unit Tests

**Status:** ✅ Done (2026-04-06)

- `tests/unit/gdpr.service.test.ts` – Tests for `logGDPRRequest` (happy path, error-status path, customerId BigInt conversion, DB failure resilience)
- `tests/unit/validation.test.ts` – Tests for `parseJsonBody` (valid body, invalid body, malformed JSON, UpdatePlanSchema, SyncContentQuerySchema)

---

## 13. catch(error: any) – Components & Utils (Branch: cleanup-1xkQF)

**Status:** ✅ Done (2026-04-06)

Last 4 `catch (error: any)` blocks cleaned up:

| File | Location | Change |
|------|----------|--------|
| `app/components/SettingsSetupTab.tsx` | line 65 | `catch (error: unknown)`; `error.message` → guarded |
| `app/components/SyncProgressBar.tsx` | line 184 | `catch (error: unknown)`; extracted `errorMessage` var; `onError?.(errorMessage)` |
| `app/components/SyncProgressBar.tsx` | line 403 | `catch (error: unknown)`; `error.message` → guarded |
| `app/utils/loader-factory.server.ts` | line 104 | `catch (error: unknown)`; `error.stack` + `error.message` guarded |

Zero `catch (error: any)` now remain in `app/` (confirmed by grep).

---

## 14. console.log in content.service.ts

**Status:** ✅ N/A (2026-04-06)

All 24 `console.log` calls in the Menus function are inside a multi-line block comment
(`/* ... */`) that starts at line 235. The live code path at line 230–233 already uses `logger.debug`.
No changes needed.

---

## 15. Zod Validation – 4 additional routes

**Status:** ✅ N/A (2026-04-06)

Routes `app.blog.tsx`, `app.collections.tsx`, `app.pages.tsx`, `app.metaobjects.tsx` all delegate
directly to `handleUnifiedContentActions()` in `app/actions/unified-content.actions.ts`.
That handler already validates:
- `action` field (via `getFormString`)
- `itemId` (validated as Shopify GID via `isValidShopifyGID`)
- `locale` (validated via `isValidLocale`)
- Returns 400 for missing required fields

No route-level Zod schemas needed — validation is centralized and complete.

---

## 16. any-Types in Services (top 10 fixes)

**Status:** ✅ Done (2026-04-06)

### billing.server.ts
Added 3 interfaces (`ShopifyAdminClient`, `AppSubscription`, `UserError`):
- All 7x `admin: any` → `admin: ShopifyAdminClient`
- `getPlanFromSubscription(subscription: any)` → `(subscription: AppSubscription | null)`
- `getCurrentSubscription()` → explicit return type `Promise<AppSubscription | null>`
- `response.json()` cast to typed structure
- `userErrors.map((e: any) => e.message)` → `(errors as UserError[]).map((e) => e.message)` (×2)

### webhook-registration.service.ts
Added `WebhookUserError` and `WebhookSubscription` interfaces:
- `variables?: any` → `variables?: Record<string, unknown>`
- `Promise<any>` return types → `Promise<{ json: () => Promise<unknown> }>`
- `getExistingWebhook()` → `Promise<WebhookSubscription | null>`
- `listWebhooks()` → `Promise<WebhookSubscription[]>`
- `(e: any) => e.message` → `(errors as WebhookUserError[])` (×2)
- `(e: any) => e.node` → `(e: { node: WebhookSubscription })` 

### content.service.ts
- `const data: any` → typed cast with inline interface
- `const shop: any` → inferred from cast
- `const metafieldsConnection: any` → inferred from cast

---

## 17. Unit Tests – billing + webhook-registration

**Status:** ✅ Done (2026-04-06)

### tests/unit/billing.server.test.ts (14 tests)
- `getPlanFromSubscription()`: null → free, Pro, Max, Basic, unknown name
- `getCurrentSubscription()`: with subscription, without, graphql call count
- `checkAndSyncSubscription()`: active Pro, active Max, no subscription, PENDING subscription, graphql error → defaults to free, missing aISettings → no DB update

### tests/unit/webhook-registration.service.test.ts (6 tests)
- Throws when `SHOPIFY_APP_URL` not set; no graphql calls made
- Creates all 3 webhooks (PRODUCTS_CREATE/UPDATE/DELETE) when none exist
- Updates (not re-creates) an existing webhook
- Continues registering remaining webhooks when one create returns `userErrors`
- Continues registering remaining webhooks when one graphql call throws (resilience)

All 139 unit tests pass (9 test files).

---

## Files Modified

| File | Change |
|------|--------|
| `CODE_REVIEW_PROGRESS.md` | Created + updated (this file) |
| `app/routes/app.tasks.tsx` | Replaced `console.error` with `logger.error`; `catch (error: any)` → `unknown` |
| `app/utils/validation.ts` | Added `AIRequestBaseSchema`, `AITranslateFieldSchema`, `SyncContentQuerySchema`, `UpdatePlanSchema`, `parseJsonBody()` |
| `app/routes/api.update-plan.tsx` | Replaced manual plan validation with `parseJsonBody(request, UpdatePlanSchema)` |
| `app/routes/api.sync-content.tsx` | Replaced raw string split with `SyncContentQuerySchema.safeParse()`; `catch` → `unknown` |
| `vitest.config.ts` | Added `coverage` configuration with v8 provider and thresholds |
| `package.json` / `package-lock.json` | Added `@vitest/coverage-v8` devDependency |
| `app/components/UnifiedContentEditor.tsx` | Fixed hardcoded plan values; `usePlan()` in `FieldRenderer`; typed props |
| `prisma/schema.prisma` | Added `GdprAuditLog` model |
| `prisma/migrations/20260406085834_add_gdpr_audit_log/migration.sql` | Migration for `GdprAuditLog` table |
| `app/services/gdpr.service.ts` | `logGDPRRequest()` persists to DB; typed `error` param |
| `app/routes/app.content.tsx` | Implemented template AI/translate handlers; `catch` → `unknown` |
| `app/routes/api.metaobjects.$.tsx` | `catch (error: any)` → `unknown` |
| `app/routes/api.templates.$.tsx` | `catch (error: any)` → `unknown` |
| `app/routes/api.sync-single-product.tsx` | `catch (error: any)` → `unknown` |
| `app/routes/api.sync-products.tsx` | `catch (error: any)` → `unknown` |
| `app/routes/api.sync-missing-products.tsx` | `catch (error: any)` → `unknown` (3 blocks) |
| `app/routes/api.sync-all-stream.tsx` | `catch (error: any)` → `unknown` |
| `app/routes/api.sync-single-resource.tsx` | `catch (error: any)` → `unknown` |
| `app/routes/api.product-images.tsx` | `catch (error: any)` → `unknown` |
| `app/routes/api.setup-webhooks.tsx` | `catch (error: any)` → `unknown` |
| `app/routes/webhooks.products.tsx` | `catch (error: any)` → `unknown` |
| `app/routes/webhooks.collections.tsx` | `catch (error: any)` → `unknown` |
| `app/routes/webhooks.menus.tsx` | `catch (error: any)` → `unknown` |
| `app/routes/webhooks.articles.tsx` | `catch (error: any)` → `unknown` |
| `app/routes/app.metadata.tsx` | `catch (error: any)` → `unknown` |
| `app/routes/app.policies.tsx` | `catch (error: any)` → `unknown` |
| `app/routes/app.settings.tsx` | `catch (error: any)` → `unknown` |
| `app/services/webhook-registration.service.ts` | 3x `catch (error: any)` → `unknown`; `error.message` guarded |
| `app/services/shopify-api-gateway.service.ts` | 1x `catch (error: any)` → `unknown`; `error.status` / `error.message` guarded |
| `tests/unit/gdpr.service.test.ts` | New: unit tests for `logGDPRRequest` |
| `tests/unit/validation.test.ts` | New: unit tests for `parseJsonBody` |
| `app/components/SettingsSetupTab.tsx` | `catch (error: any)` → `unknown`; `error.message` guarded |
| `app/components/SyncProgressBar.tsx` | 2x `catch (error: any)` → `unknown`; `error.message` guarded; `onError` call uses extracted variable |
| `app/utils/loader-factory.server.ts` | `catch (error: any)` → `unknown`; `error.stack` / `error.message` guarded |
| `app/services/billing.server.ts` | Added `ShopifyAdminClient`, `AppSubscription`, `UserError` interfaces; all `admin: any` → typed; `getPlanFromSubscription` param typed; `userErrors.map((e:any))` → `(errors as UserError[])` |
| `app/services/webhook-registration.service.ts` | Added `WebhookUserError`, `WebhookSubscription` interfaces; `variables?: any` → `Record<string,unknown>`; `(e:any)` inline casts removed; return types tightened |
| `app/services/content.service.ts` | `const data: any` / `const shop: any` / `const metafieldsConnection: any` replaced with typed cast |
| `tests/unit/billing.server.test.ts` | New: unit tests for `checkAndSyncSubscription` |
| `tests/unit/webhook-registration.service.test.ts` | New: unit tests for `registerProductWebhooks` + retry behaviour |
| `app/utils/loader-factory.server.ts` | `LoaderContext` typed with `ShopifyGraphQLClient`, `PrismaClient`, `ShopLocale[]`, `AISettings\|null`; `PrismaModelDelegate` interface; `(l:any)`/`(r:any)` removed; `Record<string,any>` → `Record<string,unknown>` |
| `app/utils/contentEditor.utils.ts` | Added `MetaobjectEntry` interface; replaced 11 `any` usages across 5 metaobject code blocks (selectedItem cast, filter/map callbacks, field access) |
| `app/routes/api.templates.$.tsx` | 5x `formData.get() as string` → `getFormString()` + 400 guard for `translateAll` and `updateContent` cases |
| `app/routes/api.sync-single-resource.tsx` | 3x `formData.get() as string` → `getFormString()` + updated error message |
| `app/routes/api.sync-single-product.tsx` | 1x `formData.get() as string` → `getFormString()` |
| `app/routes/app.settings.tsx` | `actionType` → `getFormString()` + 400 guard; `getFormString` imported |
| `app/routes/app.tasks.tsx` | `taskId` → `getFormString()` + 400 guard; `getFormString` imported |
| `app/services/shopify-api-gateway.service.ts` | `QueuedRequest.variables` → `Record<string,unknown>`; `resolve`/`reject` typed; `graphql()` return → `GraphQLResponse`; `isRateLimitError(data:any)` → `(data:Record<string,unknown>)` with proper element narrowing; `data.errors` cast tightened |
| `app/services/webhook-retry.service.ts` | `WebhookRetryJob.payload` + `WebhookHandler` param → `Record<string,unknown>`; `scheduleRetry` payload typed; `processRetry(retry:any)` → `(retry:WebhookRetry)` (Prisma type) |
| `tests/unit/background-sync.service.test.ts` | New: 4 tests for `syncAll()` error isolation — `.catch()` returns 0, never throws |
| `tests/unit/shopify-api-gateway.service.test.ts` | New: 5 tests — THROTTLED detection + retry, rate-limit message detection, sequential queue processing, MAX_RETRIES rejection |

---

## 22. Unit Tests — background-sync + gateway (Branch: NWLyp)

**Status:** ✅ Done (2026-04-06)

### tests/unit/background-sync.service.test.ts (4 tests)
- All four content types succeed → totals aggregated correctly
- One type (pages) fails → `pages: 0`, rest still complete, no throw
- Multiple types fail simultaneously → all → 0, remaining type's count preserved
- `stats.duration` is a non-negative number

### tests/unit/shopify-api-gateway.service.test.ts (5 tests)
- THROTTLED extension code detected → request retried (2 admin.graphql calls)
- "rate limit" in error message → request retried (2 calls)
- No rate-limit error → resolves on first call
- Sequential queue: 3 requests called in order [1, 2, 3], never concurrently
- MAX_RETRIES (3) exhausted on persistent error → rejects; 4 total calls (1+3)

**All 148 unit tests pass.**

---

## 23–28. any-Type Cleanup — Final Pass (Branch: AYUbc)

**Status:** ✅ Done (2026-04-06)

### Task 23: product-sync.service.ts
Added `BulkProductsQueryResponse` and `TranslatableResourcesByIdsResponse` interfaces inline; `allProducts: any[]` → `ShopifyProductData[]`; `tx: any` → `Prisma.TransactionClient`; all filter/map callbacks typed; 6x `catch (err: any)` → `unknown` with `instanceof Error` guards; `import type { Prisma } from '@prisma/client'` added.

### Task 24: MetaobjectEntry export + 3 files
Exported `MetaobjectEntry` from `contentEditor.utils.ts`; imported in `useUiDataLoader.ts` and `UnifiedContentEditor.tsx`; added to `content-fields.config.tsx` via import; all `(metaobj: any)`, `(m: any)`, `(f: any)` callbacks replaced; `getSourceText(item: any)` → `(item: TranslatableContentItem)`.

### Task 25: ShopLocale + I18nTranslation in UI components
- `OptionsField.tsx`: `shopLocales: any[]` → `ShopLocale[]`; `(l: any)` → `(l: ShopLocale)`
- `ThemeContentViewer.tsx`: Added `ThemeResource` + `ThemeTranslatableContent` interfaces; `shopLocales: any[]` → `ShopLocale[]`; item callbacks inferred
- `StoragePieChart.tsx`, `SettingsUsageLimitsTab.tsx`, `SettingsSetupTab.tsx`, `SettingsAITab.tsx`, `ApiKeyWarningBanner.tsx`, `SettingsLanguageTab.tsx`: `t: any` → `t: I18nTranslation`
- `UnifiedContentEditor.tsx`: `(t as any).common?.` → direct access (common is in Translation type); `defaultRenderSidebar(item: any)` → `TranslatableContentItem`

### Task 26: useUnifiedContentEditor.ts
Added `TaskData` interface `{ id, fieldType, targetLocale, type? }`; both filter/map callbacks on `/api/running-field-tasks` response now use `TaskData` instead of `any`.

### Task 27: SettingsSetupTab.tsx
Added `WebhookEntry { topic, callbackUrl? }` interface; all 6x `(w: any)` in webhook filter/map → `(w: WebhookEntry)`.

### Task 28: Smaller remaining any-casts
- `ReloadButton.tsx`: `fetcher.data as any` → `{ success?, error?, reloadRequired? } | undefined`
- `useProductSubResources.ts`: Added `SubResourceFetcherData` interface; 2x `fetcher.data as any` → typed
- `MobileToolbar.tsx`: `images?: any[]; featuredImage?: any` → `ContentImage[]` / `ContentImage`
- `content-sync.service.ts`: `items: ... as any` → `as Prisma.InputJsonValue`; `import type { Prisma }` added
- `LocaleNavigationButtons.tsx`: `resourceType as any` → narrowed union cast

**All 148 unit tests pass after all changes.**
