# CLAUDE.md — Shopify AI Text Manager (ContentPilot)

Curated architectural notes for Claude Code. Public repo — nothing security-sensitive in here.

## Project

Shopify embedded app (Remix + Vite + Prisma + Polaris) for AI content generation, SEO, and multi-locale/market translation of products, collections, pages, blogs, articles, metaobjects, and theme content.

## Stack

- **Remix** (Vite) — see [remix.config.js](remix.config.js), [vite.config.ts](vite.config.ts)
- **Prisma + PostgreSQL** — schema in [prisma/schema.prisma](prisma/schema.prisma), migrations in [prisma/migrations/](prisma/migrations/)
- **Shopify App Bridge + Polaris** for the embedded UI
- **AI providers**: Anthropic, Gemini, OpenAI, HuggingFace, DeepSeek, Grok (see [app/services/](app/services/))
- **Vitest** for tests
- **Runtime**: Node, deployed on Railway (see [RAILWAY-SETUP.md](RAILWAY-SETUP.md), [nixpacks.toml](nixpacks.toml))

## Layout

- [app/routes/](app/routes/) — `app.products.tsx`, `app.collections.tsx`, `app.pages.tsx`, `app.blog.tsx`, theme routes, etc.
- [app/routes/app.bulk.tsx](app/routes/app.bulk.tsx) + [app/services/bulk-editor/](app/services/bulk-editor/) — the **bulk editor**: a spreadsheet grid over products/variants/collections/articles/pages/blogs/policies/metaobjects with diff-only saves, CSV I/O and verified translation writes. Own `/app/bulk` main-nav tab; legacy `/app/seo/bulk-meta` 302-redirects. Client-safe descriptors/diff/keys in `columns.shared.ts`, row loading in `load.server.ts`, writing in `apply.server.ts`, verified translation helpers in `translations.server.ts`.
- [app/routes/app.bulk_.translate.tsx](app/routes/app.bulk_.translate.tsx) — the bulk editor's **"add missing translations"** page at `/app/bulk/translate` (the `_` opts out of nesting under `app.bulk`, which has no `<Outlet/>`). Lists the current filter set's items with per-item/per-field checkboxes and a target-language bar, then starts the `bulkEditorTranslate` task. The candidate scan (`missing-translations.server.ts`) is THE source of "what is missing" and is re-run server-side before writing — the client's selection (`translate-missing.shared.ts`: default + exceptions, so "select all" spans every page) is only replayed over it. Deliberate scope: writes GLOBAL translations only, no preview mode (only empty values are filled, so nothing can be overwritten), URL handles opt-in and slug-normalized, and only columns whose translation rides on the row's own `translatableResource` (metafields/options/alt-texts have no verified bulk write path).
- [app/actions/](app/actions/)
  - [unified-content.actions.ts](app/actions/unified-content.actions.ts) — **the** entry point for product/collection/page/blog/article actions (`handleUnifiedContentActions`)
  - [content/](app/actions/content/) — content updates, alt-text, translation
  - [product/](app/actions/product/) — product-specific update paths (`update.actions.ts`, `shared/action-context.ts`). Translate-all for products runs through `translateAllContent()` in [shopify-content.service.ts](src/services/shopify-content.service.ts), NOT a product-local bulk handler.
  - [templates/](app/actions/templates/) — theme templates: generate, load, translate, update
- [app/services/](app/services/) — Shopify GraphQL, AI, sync, image ops
- [app/hooks/](app/hooks/) — data loading + editor state
- [app/config/content-fields.config.tsx](app/config/content-fields.config.tsx) — field definitions per resource
- [app/utils/debug.ts](app/utils/debug.ts) — debug loggers (`transition`, `resolve` groups)
- [extensions/storefront/](extensions/storefront/) — the ONE theme app extension (JSON-LD, social-meta, app embeds all live here — see gotcha below)
- [prisma/schema.prisma](prisma/schema.prisma)

## Architecture invariants

- **Unified action handler.** Products, collections, pages, blogs, articles all route their actions through `handleUnifiedContentActions` in [unified-content.actions.ts](app/actions/unified-content.actions.ts). Do not add parallel handlers.
- **Translations write to Shopify AND the local DB.** Foreign values go to Shopify via `translationsRegister` (or the unstable CookieBanner endpoint) AND to Prisma (`ContentTranslation`, `ThemeTranslation`, etc.). A save is only successful if Shopify **echoes back** the keys — `userErrors` alone is not enough. Historic bug pattern: silent no-op when Shopify accepted the call but stored nothing. Conversely, always write the DB row **even when Shopify returns no digest** — `translationsRegister` requires a digest but Prisma does not (fields like `product_type` may lack one in some contexts).
- **Delete on Shopify must check the echo too.** `translationsRemove` can silently no-op. If Shopify does not confirm removal, do NOT delete the local DB row — otherwise state diverges.
- **Reload only refreshes known IDs.** Per-resource reload (e.g. `syncSingleProduct`) does not discover newly created Shopify resources. New resources appear only via full `syncAll*` runs.
- **UiDataLoader owns editor state.** [useUiDataLoader.ts](app/hooks/useUiDataLoader.ts) owns five cache refs (`deletedTranslationKeysRef`, `localTranslationsRef`, `savedPrimaryValuesRef`, `originalLoadedValuesRef`, `originalTemplateValuesRef`) plus a `resolve()` priority chain (foreign: deleted → localOverride → itemTranslation → fallback → empty; primary: savedPrimaryCache → itemField → fallback). **Items are read-only** — never mutate `item.translations` or item properties; go through the overlay refs. `resolve()` reads them.
- **Change detection uses the session load baseline**, not the live item. `getChangedFields` compares against the baseline captured at load — comparing against `item.body` etc. drifts and silently clobbers unrelated fields (e.g. a meta-description edit erasing `body_html` translations).
- **Primary saves invalidate foreign translations.** When primary content changes on templates, the server deletes stale foreign translations on Shopify. The client must invalidate `loadedTranslations`, `loadedTranslationsRef`, `localTranslationsRef`, and `deletedTranslationKeysRef` — otherwise stale foreign values reappear when switching locales. The single editor and the bulk editor (`invalidateStaleForeignTranslations`) both do this server-side too — echo-verified, global `marketId ""` rows only (market overrides survive).
- **Bulk edits go through `applyBulkDiff`** ([apply.server.ts](app/services/bulk-editor/apply.server.ts)) — the ONE write path. Three entrances: the sync route action (≤`MAX_SYNC_SAVE` cells), the `seoBulkMeta` write task, and the `bulkEditorTranslate` AI task. All validate the client diff server-side against the server-built column universe (`buildServerColumnsByType` — never trust client column claims) and gate plan/locale/market at **all three** (the `/api/ai` handlers are directly POST-reachable). Foreign translations write ONLY through the echo-verified `registerAndVerify` / `removeAndVerify` / `removeAndVerifyAcrossLocales` in `bulk-editor/translations.server.ts`. Failures are per **cell** (`BulkFailure.columnId`), never all-or-nothing per row. The task type stays `seoBulkMeta` even though the editor left the SEO section — renaming would break running tasks + `LONG_RUNNING_TASK_TYPES`.
- **One field→translation-key map.** `FIELD_TO_TRANSLATION_KEY` / `fieldTranslationKeyMap(resourceType)` in [shopify-content.service.ts](src/services/shopify-content.service.ts) is THE map (ShopPolicy translates `body`→`body`; every other type maps `body`/`description`→`body_html`, `seoTitle`→`meta_title`, `metaDescription`→`meta_description`, `productType`→`product_type`, `summary`→`summary_html`). Never re-declare it — historic copies drifted. `TranslatableResourceType` enum is `PAGE`/`ARTICLE`/`BLOG`/`COLLECTION` (the `ONLINE_STORE_*` names were removed with 2024-10).

## Deploy-critical gotchas

- **Only ONE theme app extension per Shopify app.** All storefront/theme blocks (JSON-LD, social-meta, app embeds) MUST live under [extensions/storefront/](extensions/storefront/). Creating a second `type = "theme"` extension silently breaks `shopify app deploy`.
- **The extension has a hard 100 KiB (102400 bytes) Liquid budget.** Every `extensions/storefront/blocks/*.liquid` counts together; `assets/` does not (served statically — that's why the block logic lives there). Over budget, the CLI fails with `bundle: Extension Liquid content size exceeds 100 KB limit`. The commented sources are already over it, so deploy via `npm run deploy` ([scripts/deploy-minified.mjs](scripts/deploy-minified.mjs)) — it minifies the blocks in place, deploys, and restores the sources in a `finally` (also on failure/Ctrl-C). **Never commit minified blocks**; `blocks/` stays commented in git. Minification skips `<script>`/`<style>`/`<pre>`/`<textarea>`/`{% raw %}` and every `{% … %}` / `{{ … }}` interior byte-identically, so comments inside a JSON island buy no headroom — when it gets tight, move markup into `assets/`. Check with `npm run minify:blocks`.
- **Never add a `postdeploy` script to package.json.** npm auto-runs `pre<x>`/`post<x>` around every script, so a `postdeploy` entry fires after each `npm run deploy` — *after* the extension version is already released. It used to run [scripts/migrate-baseline.js](scripts/migrate-baseline.js) (a DB migration, unrelated to the Shopify deploy) and turned successful releases into a red exit code, inviting a retry that publishes a second version. Railway never called it: it starts via `Procfile`/`nixpacks.toml` → `npm run start:production` → `run-all-migrations.js`. Run the baseline migration explicitly with `npm run prisma:migrate`.
- **App embeds cannot inject `<head>` CSS.** `{% stylesheet %}` is not available in app blocks; styles must live inline or in a section/block that participates in the theme's asset pipeline.
- **Meta title/description on pages, blogs, articles ≠ native `seo` field.** They live in `global.title_tag` / `description_tag` **metafields**. Clearing requires `metafieldsDelete` — setting an empty string does NOT clear.
- **`metafieldsSet` with `""` is rejected** ("Value can't be blank") — clear a metafield via `metafieldsDelete` (`MetafieldIdentifierInput`: `ownerId`+`namespace`+`key`; the old GID-based `metafieldDelete` was removed 2025-01). Always send `type` on `metafieldsSet` (required when creating without a definition); max 25 per call, atomic upsert.
- **Alt-text writes use `productUpdateMedia`, not `fileUpdate`.** `fileUpdate` needs the `write_files` scope → re-consent of every merchant. Keep the deprecated-but-present `productUpdateMedia` until a scope change happens anyway. Mirror to DB with `altTextModifiedAt: new Date()` so the self-triggered `products/update` webhook (5-min preserve window) doesn't overwrite the fresh value.
- **Variant pricing is synced in the regular product sync** (`price`/`compareAtPrice`/`barcode` on `ProductVariant`; before this, variant rows only appeared after opening the image manager). The variant upsert must NOT `deleteMany`+recreate — `galleryJson`/`imageKey` come from the image manager; upsert on `id` and delete only ids Shopify no longer returns. Products with >100 variants are flagged `hasMoreVariants` (remainder uncached, editable in the Shopify admin).
- **Partial SEO saves clobber the untouched half.** Sending `seo: { title }` alone on products/collections wipes the primary meta description. Always send both halves or preserve the untouched value.
- **Markets: gate on `status === 'ACTIVE'`, not deprecated `enabled`.** Secondary markets often have `webPresences: []` and share the primary web presence. Do not require web-presence locales to enumerate a market.
- **Theme keys need explicit filename routing on primary save.** In `templates-update.action.ts`, `resolveFilename` maps resource types to theme file names:
  - `ONLINE_STORE_THEME_LOCALE_CONTENT` + `ONLINE_STORE_THEME` → `locales/<primaryLocale>.default.json` (Shopify lowercases regional codes: `pt-BR` → `pt-br`; resolve robustly, do not hardcode)
  - `ONLINE_STORE_THEME_SETTINGS_DATA_SECTIONS` + `ONLINE_STORE_THEME_SETTINGS_CATEGORY` → `config/settings_data.json` (values live under `current.*`)
  - Unmapped resource types silently drop from the Shopify push while still writing the DB — that's a false-success bug pattern.
- **Autofix-normalized richtext: mirror the PUSHED value to DB, not the raw one.** If autofix rewrites a richtext value (`test<p></p>` → `<p>test</p>`) before writing `config/settings_data.json`, STEP 2b of the update handler must mirror the normalized value into `ContentTranslation`. Mirroring the raw value diverges DB from file → next save can't find the old value → save appears to no-op.

## Single-language shops (one shop locale) — mandatory rules for every new UI

A shop with only its primary locale must never be offered translation UI it cannot use. These rules are not optional polish; apply them to **every new button, bar or section** that touches locales. Reference implementation: [LocaleAvailabilityContext.tsx](app/contexts/LocaleAvailabilityContext.tsx) + [DisabledActionTooltip.tsx](app/components/DisabledActionTooltip.tsx).

- **Locale buttons/bars: REMOVE, don't disable.** Anything that switches between languages (locale chip rows, `UnifiedLanguageBar`, `MobileToolbar`'s locale row, the keyword/glossary/dashboard locale bars) renders nothing at `locales.length <= 1` — a single permanently-active button is noise. Drop the surrounding `<Card>`/wrapper too so no empty box is left: `shouldRenderLanguageBar()` in [UnifiedLanguageBar.tsx](app/components/unified/UnifiedLanguageBar.tsx) is the caller-side twin of the bar's internal emptiness check. Kill the Ctrl+click hint with the bar (the primary locale can't be toggled off).
- **Everything else: DISABLE + tooltip, don't hide.** Translate, translate-to-all-locales, copy-to-all-locales, "Accept & Translate", alt-text translation, per-option/metafield 🌍 — all stay visible, greyed out, with `t.common.requiresSecondLanguage` as the tooltip. Hiding them makes merchants think the feature is missing.
- **Get the flag from the context, not from props.** Inside the editor tree call `useSingleLocaleHint()` — it returns `undefined` when the shop is multi-language (so `disabled={... || !!singleLocaleHint}` and `<DisabledActionTooltip hint={singleLocaleHint}>` are no-ops) and the reason string otherwise. `UnifiedContentEditor` provides `LocaleAvailabilityProvider`; components outside it (image manager panels that receive `shopLocales`/`enabledLanguages` as props) derive the same hint locally.
- **Disabled controls need the wrapper.** Browsers do not dispatch pointer events for a disabled control, so a bare Polaris `<Tooltip>` around it never opens. Always wrap with `DisabledActionTooltip`. In an `ActionList` (no hover tooltip possible) use `disabled` + `helpText` instead.
- **Whole sections that only exist for translation** (e.g. the hreflang audit): mark the descriptor `requiresMultipleLocales` ([seo-sections.ts](app/config/seo-sections.ts)), grey the nav chip with a **🌐** marker (never 🔒 — that reads as "upgrade your plan") and render the explanation in place of the section body. A plan gate outranks the language gate in both the marker and the body.
- **Never gate on a failed lookup.** `getCachedShopLocales` swallows non-401 errors and resolves with `[]`, so an empty list means "lookup failed", not "one locale" — treat it as multi-language. Do not `catch` around it: it re-throws 401 on purpose so the request can re-authenticate.
- **Handlers stay defensive anyway.** The client gate is UI only; every `targetLocales = enabled.filter(l => l !== primaryLocale)` path keeps its `length === 0` guard, and server actions keep returning a successful no-op.
- **Exception — Direct translations.** `/app/direct-translations` targets *all* published locales including the primary (the source string is arbitrary storefront text), so its translate buttons stay enabled with a single locale. Only its locale bar disappears.

## Auth / boundaries

- Shopify auth + session handled by the standard `@shopify/shopify-app-remix` flow.
- Multi-tenant: every DB row is scoped by `shopId`. Translations are additionally scoped by `locale`, and theme content by `themeId` + `marketId`.
- **`ThemeTranslation` unique key includes both `themeId` AND `marketId`.** Accessor: `shop_resourceId_groupId_key_locale_themeId_marketId`. It is the only translation table folding both.

## Commands

- `npm run dev` — Remix dev server
- `npm run shopify` — `shopify app dev` (recommended for embedded work)
- `npm run test` — Vitest (`npm run test:watch`, `npm run test:ui`)
- `npm run typecheck` — tsc
- `npm run deploy -- -c dev --allow-updates` (or `-c prod`) — **the only correct way to deploy.** Minify-then-`shopify app deploy` wrapper ([scripts/deploy-minified.mjs](scripts/deploy-minified.mjs)); all args pass through. Calling `shopify app deploy` directly fails on the 100 KiB Liquid limit — see the deploy gotchas above
- `npm run minify:blocks` — report the extension Liquid budget without deploying
- `npm run build:flags` — regenerate storefront flag artifact

## Working agreement

- **Every larger or system-relevant change ends with a review pass.** Once the rebuild is finished (and typecheck + tests are green), run an independent review agent over the diff — `/code-review high` on the branch, or a subagent with the same brief — and then FIX what it finds before reporting the work as done. "System-relevant" = anything touching a write path, translation/sync logic, auth or plan gating, a shared component or context used across pages, DB schema or migrations, deploy scripts, or a cross-cutting UI rule like the single-language rules above. Small local edits (a string, one styling tweak, a test) don't need it.
- Report the findings and what you did with each; if a finding is a false positive, say why instead of silently dropping it.

## Notes for future work

- New bug patterns and in-flight observations belong in the local memory system (outside this repo), not here. This file is curated architectural context that Claude Code should have available on every PC and in cloud sessions.
- When memory claims conflict with the current codebase, trust the code and update the memory. Several memory entries reference file paths that have since been renamed or moved.
