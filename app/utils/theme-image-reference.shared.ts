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
// The file name as Files knows it (decoded): a space or an umlaut is fine,
// path separators, control characters, quotes and angle brackets are not (the
// name ends up in a JSON file and in markup the theme renders).
const NAME_CHARS = "[^\\u0000-\\u001f\\u007f\\u2028\\u2029/\\\\?#\"'<>]+";
const REFERENCE = new RegExp(`^shopify:\\/\\/shop_images\\/(${NAME_CHARS})$`);
const SAFE_NAME = new RegExp(`^${NAME_CHARS}$`);

/** A decoded Files filename that may be written into a shop_images reference. */
export function isSafeThemeImageFilename(name: unknown): name is string {
  return typeof name === "string" && name.length <= 255 && name === name.trim() && name !== "." && name !== ".." && SAFE_NAME.test(name);
}

/** True for a whole value that is exactly one theme image reference. */
export function isThemeImageReference(value: unknown): boolean {
  return themeImageFilename(value) !== null;
}

/** The filename a reference points at, or null for anything else. */
export function themeImageFilename(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m = REFERENCE.exec(value.trim());
  return m && isSafeThemeImageFilename(m[1]) ? m[1] : null;
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

/**
 * The refusal every AI path answers with for a media value. `error` IS the
 * machine code (like "gated"), rendered in the merchant's language by
 * `translateErrorMessage`; `actionType`/`fieldType` echo what was posted so the
 * editor lands it on the control that fired it, like the managed-AI refusals.
 */
export const THEME_MEDIA_REFUSAL_CODE = "themeMediaValue";

export function themeMediaRefusalBody(actionType: string, fieldType?: string) {
  return {
    success: false as const,
    error: THEME_MEDIA_REFUSAL_CODE,
    code: THEME_MEDIA_REFUSAL_CODE,
    actionType,
    ...(fieldType ? { fieldType } : {}),
  };
}

/** Builds the reference for a Files filename. */
export function themeImageReferenceFor(filename: string): string {
  return `${PREFIX}${filename}`;
}

/**
 * Whether a PRIMARY change of a theme value leaves the foreign values of that
 * key alone. A foreign value of an IMAGE setting is not a translation of the
 * original: it is a per-language (and per-market) choice the merchant made
 * deliberately, so a new original never makes it stale (owner, 2026-10-03).
 * Decided by the FIELD's type (`isImageField`: the key is rendered as a
 * `themeImage` picker) AND the value it held being an image reference - a text
 * or url setting that merely holds a link or text of that shape is text. THE
 * one rule for the server's purge / market purge / re-translation (where the
 * client's list of image keys can only narrow it) and the client's
 * invalidation, so the two cannot disagree.
 */
export function keepsForeignMediaOnPrimaryChange(isImageField: boolean, oldValue: unknown): boolean {
  return isImageField && isThemeImageReference(oldValue);
}

/** The id of a Files image, the only thing a theme image pick may name. */
export const THEME_IMAGE_FILE_ID = /^gid:\/\/shopify\/MediaImage\/\d+$/;

// A pick made in this page session: reference -> the MediaImage id it came
// from. A reference names a file as Files knows it, so the pair is a fact
// about the shop, not edit state, which is why a module-level map is safe. The
// save sends the id and the SERVER derives the reference from a fresh read of
// that file; nothing the server writes is taken from the client's text.
const picks = new Map<string, string>();

export function rememberThemeImagePick(reference: string, fileId: string): void {
  if (isThemeImageReference(reference) && THEME_IMAGE_FILE_ID.test(fileId)) picks.set(reference.trim(), fileId);
}

export function fileIdForThemeImage(reference: unknown): string | null {
  return typeof reference === "string" ? picks.get(reference.trim()) ?? null : null;
}
