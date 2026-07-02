# Theme rich-text handling & save-error coverage

## 1. The problem

Some theme settings are **rich-text** fields — most visibly the *Brand information*
category (`general.brand_headline`, `general.brand_description`, …), exposed by
Shopify as the translatable resource type `ONLINE_STORE_THEME_SETTINGS_CATEGORY`
and stored in the theme's `config/settings_data.json` under `current.<setting_id>`.

Shopify enforces a strict rule on rich-text setting values:

> Setting '…' is invalid. **All top level nodes must be `<p>`, `<ul>`, `<ol>` or
> `<h1>`-`<h6>` tags.**

Our editor for these fields ([AIEditableHTMLField](../app/components/AIEditableHTMLField.tsx))
is a `contentEditable` div that saves its raw `innerHTML`. While typing, browsers
routinely emit **top-level bare text, `<br>` and `<div>` nodes**, e.g. typing
`test` in front of the field's initial empty paragraph yields `test<p></p>`.
Shopify rejects all of these. (Product `body_html` has **no** such rule, so this
only affects the theme-settings save path.)

## 2. Where it is handled

Primary-language theme-settings saves run through
[templates-update.action.ts](../app/actions/templates/templates-update.action.ts)
(`handleUpdateContent`, primary-locale branch → `themeFilesUpsert` on
`config/settings_data.json`).

The fix normalizes the HTML so every top-level node is a block tag. Normalization
is implemented in
[richtext-normalize.server.ts](../app/utils/richtext-normalize.server.ts)
(`normalizeShopifyRichtext`), built on `isomorphic-dompurify` (a prod dependency;
`jsdom` is dev-only) so it runs on the server.

Rules applied:

| Input (top level)                     | Output                         |
| ------------------------------------- | ------------------------------ |
| bare text / inline (`<a>`, `<span>`)  | wrapped in `<p>…</p>`          |
| `<br>`-separated lines                | kept inside one `<p>` with `<br>` |
| `<div>` (contentEditable line wrapper)| unwrapped → one `<p>` per line |
| `<p>` / `<ul>` / `<ol>` / `<h1>-6`    | passed through unchanged       |
| empty `<p></p>` (trailing noise)      | dropped …                      |
| … but a value that is **only** empty  | preserved as `<p></p>`         |
| plain text with no HTML tags          | returned unchanged             |

Examples (verified):

```
"test<p></p>"                     -> "<p>test</p>"
"<p></p>"                         -> "<p></p>"          (empty preserved)
"Gubler<br>Str<br>8046"           -> "<p>Gubler<br>Str<br>8046</p>"
"<div>l1</div><div>l2</div>"      -> "<p>l1</p><p>l2</p>"
"My Store"                        -> "My Store"         (plain text untouched)
```

Two guardrails:

- **Plain-text settings are never wrapped.** `normalizeShopifyRichtext` returns the
  input unchanged when it contains no HTML tag, so a non-richtext setting value
  (e.g. `"My Store"`) can never be corrupted into `<p>My Store</p>`.
- **An empty value never collapses to `""`.** An empty primary value would trip the
  irreversible-data-loss guard in the update action (Shopify permanently removes a
  field saved empty), so a value that normalizes to nothing keeps its `<p></p>`.

## 3. Merchant-selectable behaviour

`AISettings.themeRichtextMode` (default **`autofix`**), editable under
**Settings → Rich-text formatting**
([SettingsRichtextTab](../app/components/SettingsRichtextTab.tsx)):

| Mode        | Behaviour                                                                                             |
| ----------- | ---------------------------------------------------------------------------------------------------- |
| `autofix`   | Push the merchant's HTML verbatim. **Only if** Shopify rejects it with the top-level-node error, normalize that file's settings values and retry the upsert **once**. Leaves already-valid HTML byte-for-byte. |
| `normalize` | Normalize HTML-bearing `settings_data.json` values **before** the first push. No retry round-trip.   |
| `error`     | Never rewrite the merchant's HTML. On rejection, surface a clear instruction to wrap content in paragraphs. |

`autofix` and `normalize` converge on the same stored result for invalid content
(normalization is a no-op on already-valid content); the difference is that
`autofix` never runs valid HTML through the sanitizer, while `normalize` always
does (and avoids the extra round-trip).

The setting only affects primary-language theme settings in
`config/settings_data.json`. Product/collection/page content is untouched.

### DB ↔ theme-file consistency (important)

When autofix/normalize rewrites a value, the **local DB mirror must store the
rewritten value, not the raw submitted one**. The write path (`buildFileEntry`)
returns `pushedValues` — the exact value written into the file per key — which is
collected into `pushedValueByKey` (and overwritten with the normalized value on
the autofix retry). STEP 2b mirrors `pushedValueByKey` into `ThemeContent`.

If the DB instead stored the raw value, it would diverge from the theme file:
the next primary save builds `oldValueMap` from the DB, `replaceValuesInJson`
cannot find that raw old value in the (normalized) file, and the change is
reported as an unlocatable/failed key (`failedPrimaryKeys`, `pushedCount: 0`) with
the form stuck dirty. Keep DB and file byte-identical.

## 4. Save-error handling coverage (app-wide)

Scope of what happens when a merchant saves a **wrongly-formatted value**. This is
a known-recurring bug class (silent-save: Shopify rejects, app still reports
success). Status as reviewed:

**Surfaced correctly (error shown, nothing silently persisted):**

- Content translations for products/collections/pages/blogs/articles —
  [`updateContent`](../src/services/shopify-content.service.ts) throws on Shopify
  `translationsRegister.userErrors` **before** the DB write, so a rejection aborts
  the whole save; the route action returns `success:false` and the UI shows it.
- Primary resource updates (`updatePage` / `updateBlog` / `updateArticle` /
  `updateCollection`) throw on their respective `userErrors`.
- Theme-settings rich-text — handled per §2/§3.

**Known limitations (deferred — not yet addressed):**

1. **No proactive/format pre-validation.** The app does not validate values before
   sending them to Shopify. Strictly-typed metafields (`url`, `date`, `json`,
   `rich_text`) rely on Shopify's rejection being surfaced *reactively*, not on a
   client-side check.
2. **Raw Shopify messages.** Most surfaced errors are Shopify's raw English text;
   only a few paths (e.g. rich-text) add a friendly, localized explanation.
3. **Not every handler audited.** The dominant paths above were verified. Rarer
   save handlers (metaobjects, variant galleries, bulk alt-text) were **not**
   individually confirmed to convert `userErrors` → `success:false` rather than
   log-and-continue. A full audit of every mutation handler is deferred.

If certainty is required, audit each Shopify mutation handler to confirm
`userErrors` are returned to the client (not merely logged), and add proactive
format validation for strictly-typed fields.
