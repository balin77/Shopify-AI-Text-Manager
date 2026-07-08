# Plan: Market-aware read-back (Option B)

Make the **Shopify → DB read/sync path market-aware** so market-specific
translations are pulled back from Shopify. Today the app *writes* market
overrides to Shopify (`translationsRegister` with `marketId`) and to its own DB,
but *reads* only the global layer — so a fresh install (dev↔prod), or a market
override made externally in Shopify's Translate & Adapt, is never pulled in.

## 0. Confirmed facts (no investigation needed)

- **Shopify API supports it.** `TranslatableResource.translations(locale: String!, marketId: ID)` — the optional `marketId` returns market-specific content (Admin API 2025-10, verified against docs).
- **DB schema is ready.** Every translation table already has `marketId @default("")` in its composite unique key: `ContentTranslation`, `ThemeTranslation`, `MetaobjectTranslation`, `ProductImageAltTranslation`, `DirectTranslation`. **No migration needed.**
- **Loader read side is ready.** `loader-factory.server.ts` already splits DB rows into global (`marketId ""`) vs `marketTranslations` per item; the editor's `resolve()` layers market → global. So once the DB has market rows, the UI shows them with correct inheritance — **no loader/UI change needed.**
- **`loadMarkets()` is reachable server-side.** `ShopifyContentService.loadMarkets()` returns `MarketInfo[]` (`{ id: gid://shopify/Market/<id>, name, handle, localeCodes[] }`), degrades to `[]` on missing `read_markets`. `localeCodes` tells us which locales each market serves.

**Therefore the entire change is confined to the sync/read WRITE-to-DB sites.**

## 1. Scope — every route with market coverage

Market data lives in Shopify translatable content for these, so all must fetch per-market:

| Route / content type | Sync writer(s) to make market-aware |
|---|---|
| **Products** (product fields) | `product-sync.service.ts:496` (full), `:1532` (single reload) |
| **Product sub-resources** (options, option values, metafields) | `product-sync.service.ts:609` (full), `:1564` (single reload), `sub-resources.action.ts:93` (on-demand loader supplement) |
| **Product image alt text** | `product-sync.service.ts:717` (full), `:1645` (single reload) |
| **Collections** | `content-sync.service.ts:514` |
| **Articles** | `content-sync.service.ts:603` |
| **Pages** | `background-sync.service.ts:519` (full + single) |
| **Policies** | `background-sync.service.ts:814` (full + single) |
| **Metaobjects** | `metaobject-sync.service.ts:409` |
| **Theme content** (templates, system, delivery, online-store-extras, selling-plans, static sections, locale content, theme settings, app-embed…) | `background-sync.service.ts:1929 / 2305 / 2564` and the matching `update` sites; all theme flows: `syncTheme`/`syncAllThemes`, `syncSingleThemeGroup`, `syncFlatDomain`, customer-privacy |

Shared read helper that covers Pages + Policies + Collections + Articles in one edit: **`sync-utils.ts:57 fetchAllTranslations()`** (single `for (const locale of locales)` loop, query at `:79`).

### Explicitly EXCLUDED (with reason)
- **Cookie banner** — intentionally global (Customer Privacy API has no market scoping; the selector is shown greyed with a tooltip). Do NOT add a market loop.
- **Direct translations** — a **custom storefront dictionary stored only in our DB**, not Shopify translatable content. There is no Shopify source to read back, so Option B does not apply. (Cross-install parity for direct translations would need a separate DB export/import or app-to-app sync — out of scope here; flag as a known gap.)

## 2. Approach

For each sync writer, wrap the existing per-locale loop with a per-market pass:

```
markets = await loadMarkets()            // once per sync run; [] if no scope
for each resourceId (batch):
  # global pass (unchanged)
  translations(locale, marketId: null) → upsert marketId ""
  # market passes (new)
  for each market in markets:
    for each locale in (foreignLocales ∩ market.localeCodes):   # skip locales the market doesn't serve
      translations(locale, marketId: market.id) → upsert marketId: market.id
```

Bound the fan-out by `market.localeCodes` so we never query a (market, locale) pair the market doesn't publish. Reuse the existing **bulk** `translatableResourcesByIds` queries (products/metaobjects/theme) — add `marketId` to the query variables, don't switch to per-resource calls.

## 3. GraphQL changes

- `content.queries.ts` `GET_TRANSLATIONS`: add `$marketId: ID` and pass `translations(locale: $locale, marketId: $marketId)`.
- Every bulk `translatableResourcesByIds(...){ translations(locale: $locale) }` in the sync services (products `:438/:561`, product single `:1255`, metaobjects `:366`, theme `:1750/:1075`) and the inline query in `fetchAllTranslations` (`sync-utils.ts:79`): add the `marketId` arg + variable.
- `ShopifyContentService.loadTranslations(resourceId, locale, marketId = "")`: add the optional param (mirror the existing `saveTranslations(…, marketId)` change) and pass it through.

## 4. DB write changes

At each of the 13 writer sites in §1, thread `marketId` into the `createMany` `data` / `upsert` `where` + `create`. The composite unique keys already include `marketId`, so:
- `createMany`: add `marketId: <market.id or "">` to each row.
- `upsert`: `where: { …_marketId: { …, marketId } }`, `create: { …, marketId }`.

## 5. Critical correctness concern — delete/cleanup scoping ⚠️

This is the **highest-risk part**. Several sync paths do *delete-then-recreate* or *stale-delete* and currently delete by `(shop, resourceId, resourceType[, key, locale])` **without a `marketId` filter**:
- `background-sync.service.ts` page cleanup `:548-566`, policy cleanup
- `product-sync.service.ts` delete-then-recreate `:1514`
- `content-sync.service.ts` `deleteMany` `:504 / :593`
- metaobject / theme equivalents

Once we write market rows, these unscoped deletes would **wipe the freshly-fetched market rows** (or wipe market rows when only the global layer is re-synced). Two safe options per site:
- **(A) Full-replace per resource:** fetch ALL layers (global + every market) for the resource, then delete every row for the resource and recreate all in one pass. Keeps "authoritative replace" semantics. Preferred where the sync already deletes-then-recreates.
- **(B) Scope the delete by `marketId`:** delete+recreate each `(locale, market)` tuple independently. Needed where cleanup is incremental (e.g. stale-key deletes).

Every touched delete must be reviewed and scoped — this is where a naive implementation silently loses data.

## 6. Performance & safety

- **Fan-out:** cost ≈ `globals + Σ_markets |foreignLocales ∩ market.localeCodes|`. Bounding by `localeCodes` keeps it proportional to real coverage. Keep bulk `translatableResourcesByIds` (up to 250 ids) so it's one call per (locale, market) batch, not per resource.
- **Rate limits:** reuse the existing throttling/batching in each sync; add markets as an outer dimension, not a new call pattern.
- **Missing scope:** `loadMarkets()` returns `[]` → the market passes are skipped entirely → behaviour is exactly today's (global-only). Safe by construction.
- **No markets configured:** same — `[]` → no extra work.
- **Digests:** only writes need digests; reads don't. No change.

## 7. Phasing (each independently shippable)

1. **Phase 1 — shared helper + products.** `loadTranslations`/`GET_TRANSLATIONS` marketId param; market loop in `fetchAllTranslations` (covers Pages, Policies, Collections, Articles); market loop in product full + single sync (product fields). Scope all touched deletes. Verify on a 2-market store.
2. **Phase 2 — product sub-resources + image alt-text + metaobjects.** Market loops in the product sub-resource + alt-text bulk fetches, the on-demand loader supplement (`sub-resources.action.ts`), and metaobject sync.
3. **Phase 3 — theme content.** All theme flows (largest surface; `ThemeTranslation` also folds `themeId`, so the market pass nests inside the existing theme+locale loops). See `theme-translation-theme-market-unique`.

## 8. Backfill for existing installs

No data migration. Market rows appear as each resource is re-synced:
- Full/background sync picks them up on its next run.
- A per-resource **Reload** picks up that resource immediately.
- Optional: a one-off "resync markets" trigger that runs the market passes only (skip the global pass) to speed up first population.

## 9. Testing / verification

- **Unit:** market loop bounding (`localeCodes` intersection), delete-scoping (assert a global re-sync does not drop market rows, and vice-versa), marketId threaded into upsert `where`.
- **Live (2-market store):** make a market override in Shopify Translate & Adapt → run sync → assert it appears in the app greyed as a market override; make one in the app → uninstall/reinstall (fresh DB) → run sync → assert it's pulled back (the dev↔prod parity case that motivated this).
- **Regression:** a store with 0 markets / no `read_markets` scope behaves exactly as today.

## 10. Definition of done

- All routes in §1 fetch and store per-market translation rows; §1-excluded routes untouched.
- No sync path deletes market rows it shouldn't (§5 reviewed at every delete site).
- 0-market / no-scope stores unaffected; tsc + unit tests green.
- Verified end-to-end on a ≥2-market store incl. the fresh-install parity case.
