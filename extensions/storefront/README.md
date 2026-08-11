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

## Deploying — the 100 KiB Liquid budget

Shopify also enforces a hard **100 KiB (102400 bytes)** limit on the *Liquid*
content of the extension. Every `blocks/*.liquid` file counts against it
together; `assets/` does **not** (JS/CSS/SVG are served statically, which is why
the block logic lives there). Blowing the budget fails the deploy with:

> bundle: Extension Liquid content size exceeds 100 KB limit

The commented sources are past that limit on their own, so deploy through the
wrapper, never through the bare CLI:

```bash
npm run deploy -- -c dev --allow-updates
npm run deploy -- -c prod
```

[`scripts/deploy-minified.mjs`](../../scripts/deploy-minified.mjs) strips Liquid
comments and indentation from the blocks **in place**, runs `shopify app deploy`
with every argument passed through, and restores the commented sources
afterwards — including on failure and on Ctrl-C. The minified form never
survives the command, so `blocks/` stays fully commented in git. **Never commit
minified blocks.**

To see the budget without deploying:

```bash
npm run minify:blocks
```

The transform only touches plain markup. `<script>` (JS and JSON/JSON-LD
islands), `<style>`, `<pre>`, `<textarea>`, `{% raw %}` bodies and the interior
of every `{% … %}` / `{{ … }}` expression are left byte-identical — so comments
*inside* a JSON island are not stripped and do not buy you any headroom. When
the budget gets tight, move markup or data into `assets/`.

## Blocks

| Handle                  | Type      | Purpose                                            |
|-------------------------|-----------|----------------------------------------------------|
| `variant-gallery`       | app block | Minimal inline variant gallery (main + thumbnails) |
| `variant-gallery-embed` | app embed | Full variant gallery that replaces the native one  |
| `locale-switcher`       | app embed | Storefront language + currency picker              |

### Two variant-gallery flavours

There are **two** independent variant-gallery implementations — don't confuse
them when editing:

- **`variant-gallery` (app block, `cp-variant-gallery`)** — the lightweight
  option the merchant manually places in the theme editor. Renders a main image
  plus a thumbnail strip and switches client-side on variant change. **No**
  lightbox/zoom/carousel — it is intentionally minimal.

- **`variant-gallery-embed` (app embed, `cp-embed-gallery`)** — the
  full-featured gallery. It started life as a pre-paint FOUC fix but now
  **replaces the theme's native product gallery in place** and provides:
  - **Lightbox** (native `<dialog>`) + **2× click-zoom**, with the zoom mode
    (`lightbox` / `hover` / `none`) inherited from the theme's `image_zoom`
    section setting.
  - Thumbnail carousel with prev/next arrows + mobile dot pagination.
  - Native video (`<video>`), external video (YouTube/Vimeo `<iframe>`) and 3D
    models (`<model-viewer>`).
  - **Theme-settings inheritance** (Dawn): thumbnail position/layout, mobile
    thumbnails, `media_fit`, `constrain_to_viewport`.
  - Pre-paint FOUC handling for both initial load and AJAX variant switches.

  The "pre-paint FOUC fix" label is historical — keep in mind this embed is now
  the primary, fully-featured storefront gallery.

#### Which one merchants actually get

Both blocks are still shipped and both therefore still show up in the theme
editor (the app block under "Add block" inside a product section, the app embed
under "App embeds"). **The app only promotes the embed**, though: the Setup tab
builds a deep link to `variant-gallery-embed` only
([`SettingsSetupTab.tsx`](../../app/components/SettingsSetupTab.tsx), via
`buildEmbedUrl("variant-gallery-embed")`) — nothing in the admin UI links to or
mentions the `variant-gallery` app block. So in practice merchants are always
guided to the full-featured embed; the app block is just the unpromoted minimal
fallback (kept available for manual placement / backward compatibility).

> **Gotcha:** both block schemas currently use the same `"name": "Variant Image
> Gallery"`, so a merchant sees that label twice in the theme editor (once as a
> block, once as an app embed). Rename one of them if this causes confusion.

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
