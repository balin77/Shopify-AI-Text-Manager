/**
 * The refusal of a ONE-SIDED SEO save whose other half could not be read.
 *
 * Shopify's `seo` input is a unit: sending one half alone may clear the other.
 * So a save that carries only the title or only the description reads the
 * other half from Shopify first, and when that read FAILS nothing is saved at
 * all (no fallback to a value the editor held, which may be older than the one
 * in Shopify). The answer names this code as `error` and as `errorKey`; the
 * client words it in the merchant's language ("please try again") and keeps the
 * typed text, the Task rows of a bulk run carry it per item.
 *
 * Import-free: the server writers, the bulk runner and the client all read it.
 */
export const SEO_OTHER_HALF_UNREADABLE = "seoOtherHalfUnreadable";

/** Thrown where the other half is read; the save is never attempted. */
export class SeoOtherHalfUnreadableError extends Error {
  readonly code = SEO_OTHER_HALF_UNREADABLE;
  constructor(detail?: string) {
    super(SEO_OTHER_HALF_UNREADABLE + (detail ? `: ${detail}` : ""));
    this.name = "SeoOtherHalfUnreadableError";
  }
}

/** The structured answer of a writer that refused. */
export function seoOtherHalfRefusalBody(): { success: false; error: string; errorKey: string } {
  return { success: false, error: SEO_OTHER_HALF_UNREADABLE, errorKey: SEO_OTHER_HALF_UNREADABLE };
}
