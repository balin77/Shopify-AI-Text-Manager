/**
 * Alt-text bridge, matching step (accessibility plan §7, phase 5): build the
 * `url → match` map the accessibility tab needs to turn `image-alt` findings
 * into working "generate alt text" buttons.
 *
 * Pure function on top of `matchImageUrlToProductImages` so the mapping rules
 * are unit-testable without a DB. The route action feeds it the shop-scoped
 * `ProductImage` rows and the audit-reported image URLs.
 */

import { matchImageUrlToProductImages } from "./image-alt-match";

/** What the client needs to fire the generate-and-save path for one image. */
export interface AltImageMatch {
  /** Shopify MediaImage GID — the save target (`fileUpdate`). */
  mediaId: string;
  productId: string;
  /** Product title, used as AI prompt context. */
  productTitle: string;
}

export interface AltMatchCandidateImage {
  id: string;
  productId: string;
  url: string;
  /**
   * Shopify MediaImage GID. Nullable in the DB — without it no Shopify save
   * is possible, so such rows resolve to "no match" (no dead button, §7).
   */
  mediaId: string | null;
  productTitle: string;
}

/**
 * Map each requested audit-image URL to its `AltImageMatch`, or `null` when
 * the URL is unmatched, ambiguous, unparsable, or the matched row has no
 * `mediaId`. Every requested URL gets an entry (duplicates collapse to one),
 * so the client can distinguish "no match" from "matching not loaded yet".
 */
export function buildAltImageMatches(
  urls: string[],
  images: AltMatchCandidateImage[],
): Record<string, AltImageMatch | null> {
  const byId = new Map(images.map((img) => [img.id, img]));
  const matches: Record<string, AltImageMatch | null> = {};

  for (const url of urls) {
    if (typeof url !== "string" || url in matches) continue;
    const match = matchImageUrlToProductImages(url, images);
    const row = match ? byId.get(match.id) : undefined;
    matches[url] =
      row && row.mediaId
        ? { mediaId: row.mediaId, productId: row.productId, productTitle: row.productTitle }
        : null;
  }

  return matches;
}
