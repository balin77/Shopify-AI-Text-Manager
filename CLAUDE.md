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
- [app/actions/](app/actions/)
  - [unified-content.actions.ts](app/actions/unified-content.actions.ts) — **the** entry point for product/collection/page/blog/article actions (`handleUnifiedContentActions`)
  - [content/](app/actions/content/) — content updates, alt-text, translation
  - [product/](app/actions/product/) — product-specific bulk paths (note: `translation-bulk.actions.ts` has a `handleTranslateAll` but the products page does NOT use it)
  - [templates/](app/actions/templates/) — theme templates: generate, load, translate, update
- [app/services/](app/services/) — Shopify GraphQL, AI, sync, image ops
- [app/hooks/](app/hooks/) — data loading + editor state
- [app/config/content-fields.config.tsx](app/config/content-fields.config.tsx) — field definitions per resource
- [app/utils/debug.ts](app/utils/debug.ts) — debug loggers (`transition`, `resolve` groups)
- [extensions/storefront/](extensions/storefront/) — the ONE theme app extension (JSON-LD, social-meta, app embeds all live here — see gotcha below)
- [prisma/schema.prisma](prisma/schema.prisma)

## Architecture invariants

- **Unified action handler.** Products, collections, pages, blogs, articles all route their actions through `handleUnifiedContentActions` in [unified-content.actions.ts](app/actions/unified-content.actions.ts). Do not add parallel handlers.
- **Translations write to Shopify AND the local DB.** Foreign values go to Shopify via `translationsRegister` (or the unstable CookieBanner endpoint) AND to Prisma (`ContentTranslation`, `ThemeTranslation`, etc.). A save is only successful if Shopify **echoes back** the keys — `userErrors` alone is not enough. Historic bug pattern: silent no-op when Shopify accepted the call but stored nothing.
- **Delete on Shopify must check the echo too.** `translationsRemove` can silently no-op. If Shopify does not confirm removal, do NOT delete the local DB row — otherwise state diverges.
- **Reload only refreshes known IDs.** Per-resource reload (e.g. `syncSingleProduct`) does not discover newly created Shopify resources. New resources appear only via full `syncAll*` runs.
- **UiDataLoader owns editor state.** [useUiDataLoader.ts](app/hooks/useUiDataLoader.ts) owns five cache refs (`deletedTranslationKeysRef`, `localTranslationsRef`, `savedPrimaryValuesRef`, `originalLoadedValuesRef`, `originalTemplateValuesRef`) plus a `resolve()` priority chain (foreign: deleted → localOverride → itemTranslation → fallback → empty; primary: savedPrimaryCache → itemField → fallback). **Items are read-only** — never mutate `item.translations` or item properties; go through the overlay refs. `resolve()` reads them.
- **Change detection uses the session load baseline**, not the live item. `getChangedFields` compares against the baseline captured at load — comparing against `item.body` etc. drifts and silently clobbers unrelated fields (e.g. a meta-description edit erasing `body_html` translations).
- **Primary saves invalidate foreign translations.** When primary content changes on templates, the server deletes stale foreign translations on Shopify. The client must invalidate `loadedTranslations`, `loadedTranslationsRef`, `localTranslationsRef`, and `deletedTranslationKeysRef` — otherwise stale foreign values reappear when switching locales.

## Deploy-critical gotchas

- **Only ONE theme app extension per Shopify app.** All storefront/theme blocks (JSON-LD, social-meta, app embeds) MUST live under [extensions/storefront/](extensions/storefront/). Creating a second `type = "theme"` extension silently breaks `shopify app deploy`.
- **App embeds cannot inject `<head>` CSS.** `{% stylesheet %}` is not available in app blocks; styles must live inline or in a section/block that participates in the theme's asset pipeline.
- **Meta title/description on pages, blogs, articles ≠ native `seo` field.** They live in `global.title_tag` / `description_tag` **metafields**. Clearing requires `metafieldsDelete` — setting an empty string does NOT clear.
- **Partial SEO saves clobber the untouched half.** Sending `seo: { title }` alone on products/collections wipes the primary meta description. Always send both halves or preserve the untouched value.
- **Markets: gate on `status === 'ACTIVE'`, not deprecated `enabled`.** Secondary markets often have `webPresences: []` and share the primary web presence. Do not require web-presence locales to enumerate a market.
- **Theme keys need explicit filename routing on primary save.** In `templates-update.action.ts`, `resolveFilename` maps resource types to theme file names:
  - `ONLINE_STORE_THEME_LOCALE_CONTENT` + `ONLINE_STORE_THEME` → `locales/<primaryLocale>.default.json` (Shopify lowercases regional codes: `pt-BR` → `pt-br`; resolve robustly, do not hardcode)
  - `ONLINE_STORE_THEME_SETTINGS_DATA_SECTIONS` + `ONLINE_STORE_THEME_SETTINGS_CATEGORY` → `config/settings_data.json` (values live under `current.*`)
  - Unmapped resource types silently drop from the Shopify push while still writing the DB — that's a false-success bug pattern.
- **Autofix-normalized richtext: mirror the PUSHED value to DB, not the raw one.** If autofix rewrites a richtext value (`test<p></p>` → `<p>test</p>`) before writing `config/settings_data.json`, STEP 2b of the update handler must mirror the normalized value into `ContentTranslation`. Mirroring the raw value diverges DB from file → next save can't find the old value → save appears to no-op.

## Auth / boundaries

- Shopify auth + session handled by the standard `@shopify/shopify-app-remix` flow.
- Multi-tenant: every DB row is scoped by `shopId`. Translations are additionally scoped by `locale`, and theme content by `themeId` + `marketId`.
- **`ThemeTranslation` unique key includes both `themeId` AND `marketId`.** Accessor: `shop_resourceId_groupId_key_locale_themeId_marketId`. It is the only translation table folding both.

## Commands

- `npm run dev` — Remix dev server
- `npm run shopify` — `shopify app dev` (recommended for embedded work)
- `npm run test` — Vitest (`npm run test:watch`, `npm run test:ui`)
- `npm run typecheck` — tsc
- `npm run deploy` — `shopify app deploy`
- `npm run build:flags` — regenerate storefront flag artifact

## Notes for future work

- New bug patterns and in-flight observations belong in the local memory system (outside this repo), not here. This file is curated architectural context that Claude Code should have available on every PC and in cloud sessions.
- When memory claims conflict with the current codebase, trust the code and update the memory. Several memory entries reference file paths that have since been renamed or moved.
