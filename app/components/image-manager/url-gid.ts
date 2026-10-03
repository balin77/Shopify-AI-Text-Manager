/**
 * Which media GID a gallery tile's URL stands for.
 *
 * The image manager keys its tiles by URL while everything the per-language
 * replacement knows is keyed by the media GID. The URL a tile shows and the
 * URL the url->gid map holds can differ by the `?v=` version query (the loader's
 * cached URL against Shopify's live one), so the lookup is exact first and
 * query-stripped second -- the same fallback the replace button uses for the
 * selected tile. A value that is not a GID (a loader image without a media id
 * maps to its own URL) never counts as an answer.
 */
export function gidForUrl(urlToGid: Readonly<Record<string, string>>, url: string): string | null {
  const exact = urlToGid[url];
  if (exact && exact.startsWith("gid://")) return exact;
  const base = url.split("?")[0];
  for (const [candidate, gid] of Object.entries(urlToGid)) {
    if (gid.startsWith("gid://") && candidate.split("?")[0] === base) return gid;
  }
  return null;
}

/** The per-tile entries (keyed by the TILE's url) for every shown url whose medium has one. */
export function tilesByUrl<T>(
  urls: readonly string[],
  urlToGid: Readonly<Record<string, string>>,
  tileOf: (gid: string) => T | null,
): Record<string, T> {
  const out: Record<string, T> = {};
  for (const url of urls) {
    const gid = gidForUrl(urlToGid, url);
    if (!gid) continue;
    const tile = tileOf(gid);
    if (tile) out[url] = tile;
  }
  return out;
}

/**
 * The same per-tile entries for the VARIANT galleries, whose tiles are keyed
 * by `fileUrlMap[gid]` (gid -> url) rather than by the product gallery's urls.
 * The lookup is the fileUrlMap inverse overlaid by the product gallery's
 * url->gid map, so a variant tile of a product medium resolves to the very GID
 * its "all images" tile does -- one replacement per medium, shown in both.
 */
export function fileTilesByUrl<T>(
  fileUrlMap: Readonly<Record<string, string>>,
  urlToGid: Readonly<Record<string, string>>,
  tileOf: (gid: string) => T | null,
): Record<string, T> {
  const lookup: Record<string, string> = {};
  for (const [gid, url] of Object.entries(fileUrlMap)) if (url) lookup[url] = gid;
  Object.assign(lookup, urlToGid);
  return tilesByUrl(Object.values(fileUrlMap), lookup, tileOf);
}

/** A 3D model medium: the storefront swap rewrites images and videos only, never a model viewer. */
export function isModel3dGid(gid: string | null | undefined): boolean {
  return typeof gid === "string" && gid.startsWith("gid://shopify/Model3d/");
}

/** What the selected tile of a VARIANT gallery offers for a per-language replacement. */
export type VariantTileReplaceState =
  | { kind: "replace"; mediaId: string }
  /** An unsaved upload (no media id yet): nothing, like the product gallery. */
  | { kind: "none" }
  /** A file or link that lives only on the variant. */
  | { kind: "notProductMedium" }
  /** A 3D model: never replaceable. */
  | { kind: "model3d" };

/**
 * Decides it from the variant's OWN gallery keys first (the GID the tile was
 * stored under), the url lookup only as the fallback: a url can collide across
 * media, the stored key cannot.
 */
export function variantTileReplaceState(args: {
  url: string;
  galleryFileGids: readonly string[];
  fileUrlMap: Readonly<Record<string, string>>;
  urlToGid: Readonly<Record<string, string>>;
  externalVideoUrls: readonly string[];
  threeDModelUrls: readonly string[];
  productMediaIds?: ReadonlySet<string>;
}): VariantTileReplaceState {
  const { url } = args;
  if (args.threeDModelUrls.includes(url) || /\.glb(\?|#|$)/i.test(url)) return { kind: "model3d" };
  if (args.externalVideoUrls.includes(url)) return { kind: "notProductMedium" };
  const key = args.galleryFileGids.find((k) => args.fileUrlMap[k] === url);
  if (key !== undefined && !key.startsWith("gid://")) return { kind: "none" };
  const gid = key ?? gidForUrl(args.urlToGid, url);
  if (!gid) {
    // A local preview with no medium behind it yet is an unsaved upload.
    return url.startsWith("blob:") || url.startsWith("data:") ? { kind: "none" } : { kind: "notProductMedium" };
  }
  if (isModel3dGid(gid)) return { kind: "model3d" };
  return args.productMediaIds?.has(gid) ? { kind: "replace", mediaId: gid } : { kind: "notProductMedium" };
}

/**
 * Can the selected tile of a VARIANT gallery carry an alt text? Only a
 * medium can (Shopify stores the alt on the media node): a YouTube/Vimeo
 * link or a 3D model url stored on the VARIANT is not one, and a draft typed
 * there could never be sent -- it would hold the save bar up for good. An
 * unsaved upload can (its alt is carried over until the image exists).
 */
export function variantTileAltEditable(args: {
  url: string;
  galleryFileGids: readonly string[];
  fileUrlMap: Readonly<Record<string, string>>;
  urlToGid: Readonly<Record<string, string>>;
  externalVideoUrls: readonly string[];
  threeDModelUrls: readonly string[];
}): boolean {
  const { url } = args;
  if (args.externalVideoUrls.includes(url) || args.threeDModelUrls.includes(url)) return false;
  // Stored under a key of the variant's own gallery: a medium (a GID) or an
  // unsaved upload (its staging url).
  if (args.galleryFileGids.some((k) => args.fileUrlMap[k] === url)) return true;
  if (gidForUrl(args.urlToGid, url)) return true;
  return url.startsWith("blob:") || url.startsWith("data:");
}
