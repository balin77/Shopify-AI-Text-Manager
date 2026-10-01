# Plan — one verified write path for every translation

Status: PLANNED (2026-10-01). Branch: `fix/save-path-audit` (steps 1–2 of the
save-path audit land there first; this plan is step 3).

## 1. Why

CLAUDE.md states two invariants for every translation write:

- a register counts only for the keys Shopify **echoes back** — `userErrors: []`
  is not a confirmation, and the DB mirrors only what was confirmed (and gets
  its row even without a digest);
- a removal deletes the local row only when Shopify **confirmed** it (echo, or
  the re-read in `removeAndVerify`) — an unconfirmed removal keeps the row.

The audit of 2026-10-01 found that a correct implementation exists —
`registerAndVerify`, `removeAndVerify`, `removeAndVerifyAcrossLocales` in
`app/services/bulk-editor/translations.server.ts` — and is used by the bulk
editor, the metaobject editor, menus, internal links, the stale repair and the
market purge. Roughly **20 other write sites** hand-roll the mutation and
check `userErrors` only, and several of them then delete or upsert DB rows on
that evidence. The failure mode is the one the invariants were written for: a
silent no-op on Shopify mirrored locally as success (the editor shows a
translation the storefront does not serve), or a removal that did not happen
deleting the local row (the storefront keeps serving a translation the app
says is gone).

Secondary findings folded in here because they touch the same code:

- 5 `ContentTranslation` upserts write **no digest**, so stale detection cannot
  see those translations (sub-resources).
- the field→translation-key map exists in **7 copies**; one had drifted
  (`summary` vs `summary_html` — fixed in step 2 of the audit).
- `sub-resources.action.ts` marks its Task `completed` whatever happened.

## 2. Target shape

### 2.1 One module

Move the verified helpers out of the bulk editor into
`app/services/translations/verified-translations.server.ts`:

- `registerAndVerify(gateway, resourceId, inputs)` → `VerifiedWriteResult`
- `removeAndVerify(gateway, resourceId, keys, locale, marketId)` → `VerifiedRemoveResult`
- `removeAndVerifyAcrossLocales(...)` (unchanged semantics, §6.6 sweep)
- `fetchDigestsForResource` / `loadDigestsForRows`
- NEW `registerWithDigests(gateway, resourceId, values: {key, value, locale, marketId?}[])`:
  reads the digests (one query), registers the keys that have one, verifies the
  echo, and returns `{ confirmed, confirmedValues, digests, noDigest, userErrors }`.
  This is the call ~15 sites hand-roll today ("fetch digest → register → check
  userErrors").
- NEW `mirrorConfirmedContentTranslations(db, shop, resourceId, resourceType, result, opts)`:
  upserts `ContentTranslation` for confirmed keys WITH their digest, and — per
  the invariant — also for keys that had **no digest** (local mirror only),
  never for keys Shopify was asked to store and did not echo.

`bulk-editor/translations.server.ts` re-exports the moved names so existing
imports keep working (removed in the last phase).

Callers that hold an `admin` client construct `new ShopifyApiGateway(admin, shop)`
— the pattern `metaobject-update.action.ts` already uses. No new client
interface is needed.

### 2.2 One echo comparison

Two echo matchers exist and disagree on one point: `registerAndVerify` compares
the locale **exactly**, `ShopifyContentService`'s `echoKeyOf` compares it
**case-insensitively** (documented there: Shopify is inconsistent about the case
of regional codes, `pt-BR` vs `pt-br`). The unified helper adopts the
case-insensitive comparison — a translation stored under a differently-cased
spelling is the same translation, and reporting it as refused is a false
failure. `readTranslationEcho` / `echoConfirms` / `echoedValue` in
`shopify-content.service.ts` become thin uses of the shared matcher.

### 2.3 One field→key map, client-safe

`app/services/translations/translation-keys.shared.ts` (import-free, so the
client can use it — `content-attributes.shared.ts:83` notes the current one
cannot be imported there) becomes THE map. `FIELD_TO_TRANSLATION_KEY` /
`fieldTranslationKeyMap` in `src/services/shopify-content.service.ts`
re-export it. Copies to replace:

| Copy | Location |
|---|---|
| `UI_FIELD_TO_TRANSLATION_KEY` + inverse | `app/constants/shopifyFields.ts:31`, `app/utils/field-validation.utils.ts:39` |
| two inline maps | `app/routes/api-ai-handlers/text-translation.handler.ts:721`, `:1220` |
| subset under the same name | `app/routes/api-ai-handlers/seo-bulk-fix.handler.ts:461` |
| `CONTENT_TRANSLATION_KEY` | `app/services/seo/keywords.service.ts:1740` |
| hard-coded keys | `app/actions/product/update.actions.ts:655-690` |

## 3. Sites to migrate (from the audit, file:line as of 2026-10-01)

### Phase A — the module (no behaviour change)
Extract §2.1/§2.2, re-export, move the bulk editor's tests to the new module,
add tests for `registerWithDigests` / `mirrorConfirmedContentTranslations`
(confirmed only; no-digest keys mirrored; unechoed keys not mirrored;
case-insensitive locale).

### Phase B — `ShopifyContentService` (shared by many callers)
- `saveTranslations` (`shopify-content.service.ts:243`): return the verified
  result (confirmed keys, values, digests, no-digest keys) instead of the raw
  echo; callers mirror only from it.
- `deleteAllTranslationsForKeys` (`:843`): go through
  `removeAndVerifyAcrossLocales`; return confirmed (locale, key) pairs. Callers
  that delete DB rows unconditionally afterwards change to "confirmed only":
  - single editor cleared field — `:1211` → DB delete `:1308-1317`
  - primary-change purge — `:1723` → `deleteMany` after it
  - featured-alt clear — `:757-765`
- `saveImageAltTextTranslation` (`:792`): verified register.

### Phase C — sub-resources (`app/actions/content/sub-resources.action.ts`)
- the three `saveTranslations` callers (`:258`, `:482`, `:723`) mirror only
  confirmed keys, WITH digest (fixes the 5 digest-less upserts `:103`, `:137`,
  `:320`, `:489`, `:730` — the two read-back backfills get the digest from the
  same read);
- `handleSaveSubResourceTranslations` inline `translationsRemove` (`:270-297`)
  → `removeAndVerify`; DB delete only on confirmation;
- `handleSavePrimarySubResources` purges (`:1170-1290`) → `removeAndVerifyAcrossLocales`;
- Task status: `completed_with_errors` (the existing status used elsewhere)
  when any resource or locale failed, with the failures in `result`; the
  response carries `failedResources` so the client (fixed in audit step 2)
  reports them.

### Phase D — product editor (`app/actions/product/update.actions.ts`)
- foreign register `:756-800` + mirror `:878` → `registerAndVerify` + mirror confirmed;
- foreign remove `:805-850` + DB delete `:907-916` → `removeAndVerify`, delete confirmed only;
- alt translation `:389-500` (+ mirror `ProductImageAltTranslation` `:543`) → shared alt helper (Phase E).
This is the main product translation path; it gets its own commit and the
product-editor save tests are extended first (characterisation tests).

### Phase E — alt texts (one shared helper)
`registerMediaAltAndVerify(gateway, mediaGid, locale, value)` (digest of `alt`
→ register → verify) replaces the ~8 copies of that sequence:
`app/actions/content/alt-text.action.ts:697`, `:950`;
`app/routes/api-ai-handlers/alt-text.handler.ts:720`, `:1018`, `:1291`;
`app/routes/api.apply-alt-text-templates.tsx:381`; `update.actions.ts` alt
block; `saveImageAltTextTranslation`. Mirror (`ProductImageAltTranslation` /
`ContentTranslation` `image_alt_text` on the parent) only on confirmation, and
keep the existing lock claims (`mediaAltLockId`, `featuredAltLockId`).

### Phase F — themes
- `templates-translate-field.action.ts:89`, `:245` and
  `templates-translate-all.action.ts:151` → verified register; mirror
  `ThemeTranslation` from confirmed keys; claim the theme lock key the save
  path claims (CLAUDE.md "theme foreign save");
- `templates-update.action.ts:1186-1218` primary-change purge: delete
  `ThemeTranslation` rows only for confirmed removals (today: deleted even when
  the Shopify removal failed or threw);
- `templates-update.action.ts:303`'s own echo check is kept but moved onto the
  shared matcher.

### Phase G — remaining writers
- `app/routes/api-ai-handlers/text-translation.handler.ts`: `acceptRegister`
  (`:64-75`), `:791`, `:906` → verified register;
- `app/routes/api.grouped-field-translations.tsx:158` → verified register,
  answers `{ success }` like every other route (it answers `{ ok }` today —
  update its one client), claims `markTranslationSaved`;
- `app/actions/content/translation.action.ts:154` metaobject translate-all
  branch (reads no result at all) → `registerAndVerify`, as the metaobject
  editor already does.

Deliberately NOT migrated: the cookie banner
(`cookie-banner-availability.server.ts:283`) writes through Shopify's unstable
CookieBanner endpoint, whose empty echo is a documented exception; its echo
check moves onto the shared matcher, the exception stays and stays commented.

### Phase H — guard
A unit test that scans `app/` and `src/` for the strings `translationsRegister`
and `translationsRemove` and fails for any file outside an allowlist (the
verified module, the cookie banner, GraphQL constant files, probes). New code
then cannot hand-roll a write again without the test naming it. Remove the
bulk-editor re-exports and point imports at the new module.

## 4. Order, size, verification

| Phase | Risk | Est. diff | Depends on |
|---|---|---|---|
| A module | low | ~300 (mostly moved) | — |
| B ShopifyContentService | high (many callers) | ~250 | A |
| C sub-resources | medium | ~200 | A, B |
| D product editor | high (main path) | ~200 | A, E |
| E alt texts | medium | ~250 | A |
| F themes | medium | ~150 | A |
| G remaining | low | ~150 | A |
| H guard + map | low | ~200 | all |

One commit per phase, each with: typecheck, `lint:hooks`, full unit suite,
new tests for the changed behaviour (confirmed-only mirror, unconfirmed
removal keeps the row, partial echo → per-key failure surfaced), and an
independent review pass (CLAUDE.md working agreement) before the next phase.
Phases B and D get characterisation tests of the current responses FIRST, so
the only diffs in their tests are the intended ones.

## 5. Behaviour the merchant will notice

- A translation Shopify did not actually store is reported as failed instead
  of shown as saved (and no longer appears in the editor after a reload as if
  saved).
- Clearing a translation that Shopify did not remove keeps it visible and says
  so, instead of hiding it locally while the storefront still serves it.
- Option/metafield translations become visible to the auto-translation's
  change detection (digest mirrored).
- Tasks for option/metafield translation show "completed with errors" when a
  language failed.

The public guide gets one sentence in the translations topic (saved means
confirmed by Shopify; a refused language is named) — no new feature.

## 6. Open questions

1. Do any callers rely on `saveTranslations` THROWING on `userErrors`? Phase B
   keeps the throw for transport/GraphQL errors and returns per-key results
   otherwise; every caller is reviewed in that commit.
2. `removeAndVerifyAcrossLocales` costs one extra re-read per locale with a
   gap. For the single editor's cleared-field path that is acceptable (one
   field); for the primary-change purge across many keys it is the same cost
   the bulk editor already pays — measure on a shop with 8 locales before
   merging Phase B.
