# Storefront Theme Extension

Umbrella Theme App Extension for ContentPilot. Bundles every storefront-facing
block we ship.

## Why one extension?

Shopify enforces a hard limit of **one Theme App Extension per app**. A single
extension can host up to 30 blocks (app blocks + app embed blocks), so any new
storefront block must be added here as another `blocks/<handle>.liquid` file —
not as a sibling folder under `extensions/`.

If you create a second extension folder with its own `shopify.extension.toml`,
`shopify app deploy` will fail with:

> You cannot add module ... because this app already has the maximum number of
> 1 module allowed for this extension type.

See [Shopify docs](https://shopify.dev/docs/apps/build/online-store/theme-app-extensions/configuration).

## Blocks

| Handle                  | Type      | Purpose                                   |
|-------------------------|-----------|-------------------------------------------|
| `variant-gallery`       | app block | Variant-aware product gallery             |
| `variant-gallery-embed` | app embed | Pre-paint FOUC fix for the native gallery |
| `locale-switcher`       | app embed | Storefront language + currency picker     |

## Identifiers worth knowing

- **Extension UID:** `55861f03-b391-90ea-8394-b3a6d5b6946b5f566a73`
  Hard-coded in [`app/components/SettingsImageManagerTab.tsx`](../../app/components/SettingsImageManagerTab.tsx)
  for theme-editor deep links.
- **Extension handle:** `variant-gallery` (kept for backward compatibility —
  merchant themes reference blocks via `shopify://apps/variant-gallery/...`).
  Renaming this handle breaks every installed merchant.

## Flag sprite

`assets/flags.svg` is generated, not hand-edited. To regenerate after editing
the curated country list:

```bash
npm run build:flags
```

Source: [scripts/build-storefront-flags.mjs](../../scripts/build-storefront-flags.mjs).

## Locales

`locales/en.default.json` is the fallback; `de.json` and `es.json` provide
translations. Keys follow `blocks.<block_handle_snake_case>.<key>`.
