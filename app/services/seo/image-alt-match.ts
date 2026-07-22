/**
 * Image-alt bridge (accessibility plan §7): map an image URL from a Lighthouse
 * `image-alt` finding back to a `ProductImage` row, so the finding can render
 * an "generate alt text" button into the existing alt-text path.
 *
 * A naive string compare fails because Shopify CDN URLs carry transformation
 * suffixes (`_1024x1024`, `_600x`, `@2x`, `_crop_center`, legacy named sizes
 * like `_grande`) and version query strings (`?v=…`) that differ between what
 * the storefront renders and what the Admin API stored. Matching therefore
 * runs on the normalized filename stem.
 *
 * The match will not always succeed — images from theme assets or metafields
 * have no `ProductImage` row at all, and ambiguous stems are deliberately not
 * matched (no button is better than a wrong button). Callers must handle null.
 */

/** Legacy Shopify named size suffixes (`hero_grande.jpg`, `hero_master.png`, …). */
const NAMED_SIZE_SUFFIXES = "pico|icon|thumb|small|compact|medium|large|grande|original|master";

/**
 * One or more trailing transformation tokens before the file extension:
 * `_600x600`, `_600x`, `_x600`, `_crop_center`, `_grande`, `@2x` — in any
 * combination/order (`_600x600_crop_center@2x`).
 */
const TRANSFORM_SUFFIX_RE = new RegExp(
  `(?:_(?:${NAMED_SIZE_SUFFIXES})|_\\d*x\\d*|_crop_[a-z]+|@\\dx)+$`,
  "i",
);

/**
 * Normalize an image URL to its filename stem: path basename without the query
 * string, without size/crop/scale transformation suffixes, lowercase. The file
 * extension (when present) is kept.
 *
 * `hero_1024x1024.jpg?v=123` → `hero.jpg`
 *
 * Returns null when the URL cannot be parsed or has no basename. Relative and
 * protocol-relative URLs (as they appear in Lighthouse snippets) are resolved
 * against a dummy base so their path still normalizes.
 */
export function normalizeShopifyImageUrl(url: string): string | null {
  if (typeof url !== "string" || !url.trim()) return null;
  const trimmed = url.trim();
  let pathname: string;
  try {
    pathname = new URL(trimmed).pathname;
  } catch {
    try {
      pathname = new URL(trimmed, "https://cdn.shopify.com").pathname;
    } catch {
      return null;
    }
  }

  const rawBasename = pathname.split("/").pop() ?? "";
  if (!rawBasename) return null;

  let basename = rawBasename;
  try {
    basename = decodeURIComponent(rawBasename);
  } catch {
    // Malformed percent-encoding — keep the raw basename; both sides of a
    // match would fail decoding identically anyway.
  }
  basename = basename.toLowerCase();

  const extMatch = basename.match(/^(.*)\.([a-z0-9]+)$/);
  const rawStem = extMatch ? extMatch[1] : basename;
  const ext = extMatch ? extMatch[2] : "";
  const stem = rawStem.replace(TRANSFORM_SUFFIX_RE, "");
  if (!stem) return null;
  return ext ? `${stem}.${ext}` : stem;
}

/**
 * Find the `ProductImage` a Lighthouse-reported image URL belongs to, by
 * normalized filename stem. Returns null when nothing matches, when the audit
 * URL is unparsable, or when the stem is ambiguous — i.e. two DIFFERENT images
 * share it. A wrong "generate alt text" button would write the text to the
 * wrong image, so ambiguity resolves to "no button".
 */
export function matchImageUrlToProductImages(
  auditImageUrl: string,
  images: Array<{ id: string; productId: string; url: string }>,
): { id: string; productId: string } | null {
  const target = normalizeShopifyImageUrl(auditImageUrl);
  if (!target) return null;

  let match: { id: string; productId: string } | null = null;
  for (const image of images) {
    if (!image || typeof image.url !== "string") continue;
    if (normalizeShopifyImageUrl(image.url) !== target) continue;
    if (match && match.id !== image.id) return null; // ambiguous stem
    match = { id: image.id, productId: image.productId };
  }
  return match;
}
