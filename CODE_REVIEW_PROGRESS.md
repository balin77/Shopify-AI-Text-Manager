# Code Review Progress - ContentPilot

**Branch:** `claude/continue-code-review-progress-PHSBB`
**Started:** 2026-04-06
**Based on:** CODE_IMPROVEMENTS.md recommendations

---

## Status Overview

| Task | Status | Notes |
|------|--------|-------|
| 1. Logging Consolidation | ✅ Done | Replaced server-side `console.*` in `app.tasks.tsx` |
| 2. Input Validation (Zod) | ✅ Done | Schemas + `parseJsonBody` helper; applied to `api.update-plan.tsx` and `api.sync-content.tsx` |
| 3. Test Coverage Config | ✅ Done | `@vitest/coverage-v8` installed; thresholds set at 20% |

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

## Files Modified

| File | Change |
|------|--------|
| `CODE_REVIEW_PROGRESS.md` | Created (this file) |
| `app/routes/app.tasks.tsx` | Replaced 3x `console.error` with `logger.error` |
| `app/utils/validation.ts` | Added `AIRequestBaseSchema`, `AITranslateFieldSchema`, `SyncContentQuerySchema`, `UpdatePlanSchema`, `parseJsonBody()` |
| `app/routes/api.update-plan.tsx` | Replaced manual plan validation with `parseJsonBody(request, UpdatePlanSchema)` |
| `app/routes/api.sync-content.tsx` | Replaced raw string split with `SyncContentQuerySchema.safeParse()` |
| `vitest.config.ts` | Added `coverage` configuration with v8 provider and thresholds |
| `package.json` / `package-lock.json` | Added `@vitest/coverage-v8` devDependency |
| `app/components/UnifiedContentEditor.tsx` | Fixed 3 hardcoded plan values; added `usePlan()` to `FieldRenderer` |
