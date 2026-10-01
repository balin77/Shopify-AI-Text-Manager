import type { MediaKind } from "./types";

/**
 * "Settling" media — the gap between `productCreateMedia` returning and
 * Shopify finishing the upload.
 *
 * Shopify hands back the media GID the instant the mutation runs, but keeps
 * processing the file afterwards. While it does, `MediaImage.image` is null,
 * and /api/product-variants drops any node it cannot resolve to a URL — so
 * for those seconds the just-saved media is reported by NOTHING: not by the
 * media map, not by the product-image list. The Image Manager used to clear
 * its optimistic tile the moment that refetch landed, which is why a fresh
 * upload disappeared from the gallery (and the media count stayed put) until
 * the merchant reloaded the page, by which point processing had finished and
 * the image was "mysteriously" back.
 *
 * The rule these helpers encode: presence in the fetched media map is the
 * readiness signal, uniformly for every kind (a Video or Model3d whose poster
 * has not rendered yet is missing from that map for the same reason). Until a
 * GID shows up there we keep rendering the local preview under the real GID;
 * once it does, the entry is dropped and the real tile takes over.
 */
export interface SettlingMediaEntry {
  /** Product the media was created on. A settling entry must never leak into
   *  another product's gallery when the merchant switches items. */
  productId: string;
  mediaId: string;
  kind: MediaKind;
  /** Local blob:/data:/CDN preview captured before the save. Undefined for
   *  kinds the browser cannot preview (a .glb without a snapshot) — such an
   *  entry is still tracked, it just renders no tile. */
  previewUrl?: string;
}

/**
 * Back-off schedule for the re-poll while media is settling. Shopify normally
 * finishes an image in a second or two; the long tail is for large files and
 * busy shops. Total patience ≈ 55s, after which we stop asking but KEEP the
 * tiles — media that is on Shopify but slow must not vanish from the gallery,
 * which is the whole point of this mechanism.
 */
export const SETTLING_POLL_DELAYS_MS: readonly number[] = [
  1500, 2000, 3000, 4000, 5000, 5000, 8000, 8000, 10000, 10000,
];

/** Delay before poll `attempt` (0-based), or null when the budget is spent. */
export function settlingPollDelayMs(attempt: number): number | null {
  if (attempt < 0 || attempt >= SETTLING_POLL_DELAYS_MS.length) return null;
  return SETTLING_POLL_DELAYS_MS[attempt];
}

/** Entries of `productId` that the fetched media map still cannot resolve. */
export function unsettledMediaEntries(
  entries: readonly SettlingMediaEntry[],
  productId: string,
  mediaMap: Record<string, string>,
): SettlingMediaEntry[] {
  return entries.filter(e => e.productId === productId && !mediaMap[e.mediaId]);
}

/**
 * Entries that can be forgotten: the media map now resolves them, or they
 * belong to a product we are no longer looking at.
 */
export function resolvedMediaIds(
  entries: readonly SettlingMediaEntry[],
  productId: string,
  mediaMap: Record<string, string>,
): string[] {
  return entries
    .filter(e => e.productId !== productId || Boolean(mediaMap[e.mediaId]))
    .map(e => e.mediaId);
}
