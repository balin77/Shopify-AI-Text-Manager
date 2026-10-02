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
