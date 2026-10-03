/**
 * Which cached product image an alt-text action means.
 *
 * A client's POSITION in its live gallery is not a position in the DB order
 * (`ProductImage.position`): the image manager lists what Shopify returned,
 * pending reorders and settling uploads included, and `findIndex` answers -1
 * for a tile that is not saved yet -- which a `Math.max(0, ...)` turned into
 * "image 0", so the translations of one picture landed on another. A MEDIA id
 * names the picture itself, so the server resolves by it and REFUSES when it
 * cannot -- never a fallback to some other image. The index stays only for
 * callers that cannot name a medium (collections and articles have no
 * `ProductImage` rows at all).
 */

/** `errorCode` of the refusal, rendered by the client in the merchant's language. */
export const ALT_IMAGE_NOT_FOUND = "imageNotFound";

export interface PickableProductImage {
  mediaId: string | null;
}

export function pickProductImage<T extends PickableProductImage>(
  images: readonly T[] | null | undefined,
  by: { mediaId?: string | null; imageIndex?: number | null },
): T | undefined {
  const list = images ?? [];
  const mediaId = (by.mediaId ?? "").trim();
  if (mediaId) return list.find((img) => img.mediaId === mediaId);
  const index = by.imageIndex;
  if (index === null || index === undefined || !Number.isInteger(index) || index < 0) return undefined;
  return list[index];
}
