/**
 * A theme setting that holds an IMAGE (`image_picker`) is translatable in
 * Shopify like a text: its value is a reference `shopify://shop_images/<file>`
 * and a translation is simply another reference, per locale and per market
 * (docs/plans/PLAN_LOCALIZED_IMAGES.md, Phase 1a). That makes it look like
 * text to every path that handles theme content — and the one thing that must
 * never happen to it is the AI "translating" it: the answer is a broken
 * reference, written to the storefront with an echo that confirms it.
 *
 * This is THE predicate. Every AI path over theme values asks it (translate
 * all, translate field, the /api/ai handlers, the stale repair's
 * `survivesValuePrompt`), the field factory asks it to render a picker instead
 * of a text box, and the completeness check asks it so an image the merchant
 * deliberately keeps the same in every language is not reported as missing.
 *
 * Import-free on purpose: it runs in the client bundle and the server graph.
 */

const PREFIX = "shopify://shop_images/";
const REFERENCE = /^shopify:\/\/shop_images\/([^\s/?#]+)$/;

/** True for a whole value that is exactly one theme image reference. */
export function isThemeImageReference(value: unknown): boolean {
  return typeof value === "string" && REFERENCE.test(value.trim());
}

/** The filename a reference points at, or null for anything else. */
export function themeImageFilename(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m = REFERENCE.exec(value.trim());
  return m ? m[1] : null;
}

/**
 * The filename of a Shopify Files CDN URL (`…/files/<name>?v=…`), i.e. the
 * name a `shopify://shop_images/` reference uses. Null when the URL has no
 * usable last segment.
 */
export function filenameFromCdnUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const path = url.split("?")[0].split("#")[0];
  const last = path.split("/").pop() ?? "";
  return last && /^[^\s/?#]+$/.test(last) ? last : null;
}

// A theme VIDEO setting holds either a Shopify file reference (the `video`
// setting type) or a YouTube/Vimeo link (`video_url`). The reference SHAPE of
// the first is not measured, so both spellings it plausibly takes are
// accepted (shopify://files/videos/<file>, shopify://shop_videos/<file>) and
// the theme-image probe reports what a shop really holds; the link is matched
// by host. Neither is a parser — nothing is extracted, the
// only question is "is this whole value a video choice rather than text".
const THEME_VIDEO_FILE = /^shopify:\/\/(?:files\/videos|shop_videos)\/[^\s?#]+$/i;
const VIDEO_LINK = /^https?:\/\/(?:www\.|m\.)?(?:youtube\.com|youtu\.be|youtube-nocookie\.com|vimeo\.com|player\.vimeo\.com)\/\S+$/i;

/** True for a whole value that is one video choice: a Shopify video reference or a YouTube/Vimeo link. */
export function isThemeVideoValue(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const v = value.trim();
  return THEME_VIDEO_FILE.test(v) || VIDEO_LINK.test(v);
}

/**
 * THE predicate every AI path asks: an image OR a video choice. Either is a
 * file or a link per language, never text — an AI answer to it is a broken
 * reference or a rewritten URL, written with an echo that confirms it.
 */
export function isThemeMediaValue(value: unknown): boolean {
  return isThemeImageReference(value) || isThemeVideoValue(value);
}

/** Builds the reference for a Files filename. */
export function themeImageReferenceFor(filename: string): string {
  return `${PREFIX}${filename}`;
}
