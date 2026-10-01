# Plan — one verified write path for every translation

Status: PLANNED (2026-10-01), revised after an independent review the same day
(§8 lists what the review changed). Branch: `fix/save-path-audit` (steps 1–2 of the
save-path audit land there first; this plan is step 3).

> Note: line numbers (where any remain) are as of 2026-10-01; re-anchor by symbol.
> Sites below are named by function / constant for that reason.

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

**Client.** The helpers take a minimal client interface
`{ graphql(query, { variables }) → Response }`, which both `ShopifyApiGateway`
and `admin` satisfy. Not "always a gateway": `ShopifyApiGateway` retries any
thrown error three times with 1 s sleeps (throttling 1/2/3 s,
`ShopifyApiGateway.processQueue` / `handleRateLimitError` in `shopify-api-gateway.service.ts`) and `admin.graphql` THROWS
`GraphqlQueryError` on a schema refusal, so a refused document would cost ~3 s
of pointless retries on request-bound paths (single editor save, the
grouped-field loop over N products). Request-bound callers pass `admin`;
background / bulk callers keep their ONE gateway per request (a gateway per
call coordinates nothing — each instance rate-limits only its own calls).

**No-digest mirror is an explicit opt-in.** CLAUDE.md says "always write the
DB row even when Shopify returns no digest" — that is the single editor's
rule (`updateContent`'s `dbOnlyTranslations`), not a universal one:
`saveImageAltTextTranslation` (`shopify-content.service.ts`, the no-digest branch of that method)
deliberately does NOT write locally without a digest, and
`api.grouped-field-translations.tsx` counts a missing digest as a failure.
`mirrorConfirmedContentTranslations` therefore mirrors no-digest keys only
with `{ mirrorWithoutDigest: true }`, and the result reports them as
`localOnly` so a caller can say "saved in the app, not on Shopify" instead of
a plain success.

### 2.2 One echo comparison

Two echo matchers exist and disagree on one point: `registerAndVerify` compares
the locale **exactly**, `ShopifyContentService`'s `echoKeyOf` compares it
**case-insensitively** (documented there: Shopify is inconsistent about the case
of regional codes, `pt-BR` vs `pt-br`). The unified helper adopts the
case-insensitive comparison — a translation stored under a differently-cased
spelling is the same translation, and reporting it as refused is a false
failure. `readTranslationEcho` / `echoConfirms` / `echoedValue` in
`shopify-content.service.ts` become thin uses of the shared matcher.

**Results are keyed by the spelling that was SENT, never the echoed one.**
`removeAndVerifyAcrossLocales` builds `confirmedPairs` from the locale Shopify
echoes (`confirmedPairs` in `removeAndVerifyAcrossLocales`, `translations.server.ts`) while its callers look pairs up with the
locale they sent (`invalidateFeaturedImageAltTranslations` in `shopify-content.service.ts`, `market-layer-purge`,
`menu-tree`). With a case-insensitive match that would silently miss, or
mirror rows that differ only in case. The matcher maps every echo back onto
the sent input it matches, and every result and every mirror uses the sent
spelling. Pinned by a test (`pt-BR` sent, `pt-br` echoed → confirmed under
`pt-BR`, one row).

Note: for the single editor's `updateContent` register (the register in `updateContent`) and
`translateAllContent` (`saveFieldsIndividually`, `savePerLocaleBatch` and its third register) this is a REFACTOR only —
they already verify the echo case-insensitively.

### 2.3 One field→key map, client-safe

`app/services/translations/translation-keys.shared.ts` (import-free, so the
client can use it — `content-attributes.shared.ts` (the comment on its client-side predicate) notes the current one
cannot be imported there) becomes THE map. `FIELD_TO_TRANSLATION_KEY` /
`fieldTranslationKeyMap` in `src/services/shopify-content.service.ts`
re-export it. Copies to replace:

| Copy | Location |
|---|---|
| `UI_FIELD_TO_TRANSLATION_KEY` + inverse | `UI_FIELD_TO_TRANSLATION_KEY` in `app/constants/shopifyFields.ts`, `TRANSLATION_KEY_TO_FIELD_KEY` in `app/utils/field-validation.utils.ts` |
| two inline maps | the two `fieldKeyMap` literals in `handleTranslateFieldToAllLocales`, `app/routes/api-ai-handlers/text-translation.handler.ts` |
| subset under the same name | `FIELD_TO_TRANSLATION_KEY` in `app/routes/api-ai-handlers/seo-bulk-fix.handler.ts` |
| `CONTENT_TRANSLATION_KEY` | `CONTENT_TRANSLATION_KEY` in `app/services/seo/keywords.service.ts` |
| hard-coded keys | `updateTranslatedProduct` in `app/actions/product/update.actions.ts` |

## 3. Sites to migrate (from the audit; anchored by symbol)

### Phase A — the module (no behaviour change)
Extract §2.1/§2.2, re-export, move the bulk editor's tests to the new module,
add tests for `registerWithDigests` / `mirrorConfirmedContentTranslations`
(confirmed only; no-digest keys mirrored; unechoed keys not mirrored;
case-insensitive locale).

### Phase B+C — `ShopifyContentService` AND sub-resources, ONE commit
They cannot land separately: the sub-resource callers (`sub-resources.action.ts`:
`handleSaveSubResourceTranslations`, `handleTranslateSubResources`,
`handleTranslateSubResourceToAllLocales`) ignore `saveTranslations`' return value and rely on it
THROWING on `userErrors` — the catch is what fills `failedResources`. A
`saveTranslations` that returns per-key results without its callers reading
them would make every sub-resource save upsert every field silently.

ShopifyContentService:
- `saveTranslations`: return the verified result (confirmed keys,
  values, digests, no-digest keys); still THROWS on transport/GraphQL errors.
- `deleteAllTranslationsForKeys`: the removal must REACH THE RE-READ.
  `removeAndVerifyAcrossLocales` never re-reads, and two of its callers clear
  ONE locale whose row may be a DB-only mirror (digest null — written on
  purpose by `updateContent`): Shopify echoes nothing for a key it never held,
  so "delete confirmed only" without the re-read is the dead end CLAUDE.md
  describes — the merchant can never clear that field. So:
  - single-locale callers → `removeAndVerify` (echo, then re-read on a gap):
    the single editor's cleared field (`updateContent`'s cleared-field branch →
    its DB delete) and the featured-alt clear (the clear branch of
    `saveImageAltTextTranslation`);
  - multi-locale callers → the `purgeAltTranslations` pattern in `product-alt-repair.server.ts`:
    one `removeAndVerifyAcrossLocales` call, then `removeAndVerify` ONLY for a
    locale with a gap: `updateContent`'s primary-change purge (→ its `deleteMany`).
- `saveImageAltTextTranslation`: verified register (no local write
  without a digest — its existing rule, see §2.1).

Sub-resources (`app/actions/content/sub-resources.action.ts`), same commit:

- the three `saveTranslations` callers (`handleSaveSubResourceTranslations`,
  `handleTranslateSubResources`, `handleTranslateSubResourceToAllLocales`) mirror
  only confirmed keys, WITH digest (fixes the 5 digest-less upserts in those
  handlers and their read-back backfills — the two backfills get the digest from
  the same read);
- `handleSaveSubResourceTranslations` inline `translationsRemove`
  → `removeAndVerify`; DB delete only on confirmation;
- `handleSavePrimarySubResources` purges (option name, option values, metafields) → `removeAndVerifyAcrossLocales`;
- Task status: `completed_with_errors` (the existing status used elsewhere)
  when any resource or locale failed, with the failures in `result`; the
  response carries `failedResources` so the client (fixed in audit step 2)
  reports them;
- a GLOBAL metafield clear sends `value: ""` to `translationsRegister`
  (in `handleSaveSubResourceTranslations`) instead of removing the translation — clear means remove, as on
  every other surface;
- the `contentTranslation.deleteMany` in `handleSaveSubResourceTranslations` has no `shop` filter — add it.

### Phase D — product editor (`app/actions/product/update.actions.ts`)
- foreign register + mirror in `updateTranslatedProduct` → `registerAndVerify` + mirror confirmed;
- foreign remove + DB delete in `updateTranslatedProduct` → `removeAndVerify`, delete confirmed only;
- alt translation in `updateImageAltTexts` (+ its `ProductImageAltTranslation` mirror) → shared alt helper (Phase E);
- the PRIMARY-change purge in `updatePrimaryProduct`: hand-rolled `translationsRemove` with
  no echo, followed by a `contentTranslation.deleteMany` that runs even after
  `userErrors` and whose `where` has no `shop` filter → the multi-locale
  pattern from Phase B+C, delete confirmed only, `shop` in the filter.
This is the main product translation path and it has NO test file today
(`tests/unit` has none for `product/update.actions.ts`): the characterisation
tests are written from scratch first, in their own commit, before any change.

### Phase E — alt texts (one shared helper)
`registerMediaAltAndVerify(gateway, mediaGid, locale, value)` (digest of `alt`
→ register → verify) replaces the ~8 copies of that sequence:
`handleTranslateAltTextToAllLocales` and `handleSaveImageAltText` in
`app/actions/content/alt-text.action.ts`; `handleTranslateAltTextToAllLocales`,
`handleTranslateAllAltTextsToAllLocales` and `handleTranslateAllAltTextsForLocale`
in `app/routes/api-ai-handlers/alt-text.handler.ts`; the `action` of
`app/routes/api.apply-alt-text-templates.tsx`; `updateImageAltTexts` in
`update.actions.ts`; `saveImageAltTextTranslation`. Mirror (`ProductImageAltTranslation` /
`ContentTranslation` `image_alt_text` on the parent) only on confirmation, and
keep the existing lock claims (`mediaAltLockId`, `featuredAltLockId`).

### Phase F — themes
- `handleTranslateField` / `handleTranslateFieldToAllLocales`
  (`templates-translate-field.action.ts`) and `handleTranslateAll`
  (`templates-translate-all.action.ts`) → verified register; mirror
  `ThemeTranslation` from confirmed keys; claim the theme lock key the save
  path claims (CLAUDE.md "theme foreign save");
- `handleUpdateContent` (`templates-update.action.ts`), primary-change purge: delete
  `ThemeTranslation` rows only for confirmed removals (today: deleted even when
  the Shopify removal failed or threw);
- `handleUpdateContent`'s own foreign-register echo check is kept but moved onto the
  shared matcher;
- the theme FOREIGN clear in `handleUpdateContent` checks the echo but
  never re-reads, so a DB-only `ThemeTranslation` row can never be cleared —
  the same dead end as Phase B+C; route it through the re-read.
Sites are anchored by symbol, so a later edit to these files does not stale
the plan.

### Phase G — remaining writers
- `app/routes/api-ai-handlers/text-translation.handler.ts`: `registerTemplateFieldTranslation`
  and all FOUR hand-rolled registers in `handleTranslateFieldToAllLocales` —
  the content and metaobject registers of the parallel path and the same two of
  the sequential path → verified register;
- the `action` of `app/routes/api.grouped-field-translations.tsx` → verified register,
  claims `markTranslationSaved`. Its `{ ok }` answer stays (renaming it would
  touch `SettingsTranslationsTab.tsx` and `task-details.shared.ts` for
  no behavioural gain);
- `translateMetaobjectEntries` in `app/actions/content/translation.action.ts`
  (the metaobject translate-all branch) (reads no result at all) → `registerAndVerify`, as the metaobject
  editor already does.

Deliberately NOT migrated: the cookie banner
(`app/utils/cookie-banner-availability.server.ts`) writes through Shopify's unstable
CookieBanner endpoint, whose empty echo is a documented exception; its echo
check moves onto the shared matcher, the exception stays and stays commented.

Two echo-verified registers of their own exist and are moved onto the shared
matcher here (behaviour unchanged): `persistFieldForLocale` (field) and `registerAltTranslation` (alt) in
`seo-bulk-fix.handler.ts`, and `menu-translation-repair.server.ts`.

### Phase H — guard
A unit test that fails when a file outside an allowlist SENDS one of the two
mutations. It must match the mutation being sent, not the bare word: the
strings appear in comments and docs across many files (`stale-translation-sync`,
`sitemap.service`, `app.menus.tsx`, `delete.actions`, `seo-bulk-meta`,
`ai-credentials`, `roadmap.server`, `columns.shared`, constants, probes). The
rule: a `#graphql` document (or a `graphql(` call's first argument) whose text
contains `translationsRegister(` / `translationsRemove(`, or an import of the
`TRANSLATE_CONTENT` / `REMOVE_TRANSLATIONS` constants. Allowlist by name: the
verified module, the GraphQL constant files, the cookie banner, the probe
routes. Remove the bulk-editor re-exports and point imports at the new module.

## 4. Order, size, verification

Execution order: **A → B+C → E → D → F → G → H** (D uses E's alt helper).

| Phase | Risk | Est. diff | Depends on |
|---|---|---|---|
| A module | low | ~300 (purely additive) | — |
| B+C ShopifyContentService + sub-resources | high (many callers) | ~450 | A |
| E alt texts | medium | ~250 | A |
| D product editor (tests first) | high (main path) | ~250 + tests | A, E |
| F themes | medium | ~150 | A |
| G remaining | low | ~200 | A |
| H guard + map | low | ~200 | all |

Phase A is purely ADDITIVE: the new module plus re-exports, no caller moved.
Four tests `vi.mock` the bulk-editor module path, and a caller moved to the
new path would slip past those mocks unnoticed — each later phase moves its
callers AND updates the affected mocks in the same commit.

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

1. ~~Do any callers rely on `saveTranslations` THROWING on `userErrors`?~~
   Answered by the review: yes, the three sub-resource callers — hence B+C as
   one commit.
2. `removeAndVerifyAcrossLocales` costs one extra re-read per locale with a
   gap. For the single editor's cleared-field path that is acceptable (one
   field); for the primary-change purge across many keys it is the same cost
   the bulk editor already pays — measure on a shop with 8 locales before
   merging Phase B.

## 7. Already correct (not touched beyond the shared matcher)

Stale repair (`purgeStaleEntries` and `runRetranslation` in
`stale-translation-sync.server.ts`) and market purge (`purgeMarketOverrides` in
`market-layer-purge.server.ts`) already use the verified helpers.
Rows kept after an unconfirmed removal keep their old digest, which the
digest gate handles correctly, so neither changes behaviour here.

## 8. What the review (2026-10-01) changed

- Added sites: product primary-change purge (`updatePrimaryProduct`),
  two more text-translation registers (the sequential path of
  `handleTranslateFieldToAllLocales`), the theme foreign clear
  (`handleUpdateContent` in `templates-update.action.ts`), and the two self-verifying
  registers in `seo-bulk-fix` / `menu-translation-repair`.
- B and C merged into one commit (the throw dependency).
- Single-locale clears go through the re-read, multi-locale ones through the
  alt-repair pattern — otherwise a DB-only row could never be cleared.
- Results keyed by the sent locale spelling.
- No-digest mirroring is an opt-in with a `localOnly` result.
- Helpers take a minimal client (admin OR gateway), not always a gateway.
- Guard matches sent mutations, not bare strings.
- Order A → B+C → E → D → F → G → H; D's tests written from scratch first.
- Dropped the grouped-field `{ok}` → `{success}` rename.
- Added: metafield clear = remove, missing `shop` filters.
