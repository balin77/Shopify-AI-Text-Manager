/**
 * ONE rule for which store answers an image alt translation, per
 * (media, layer) key -- pure and client-safe. Used by the image manager's load,
 * the bulk editor's grid values (and CSV export), its missing-translation
 * flags and its candidate scan, so the four cannot disagree.
 *
 * A PRODUCT-backed medium (a ProductImage row exists) is served from the
 * product store: a product entry wins for its key, EVEN an empty one. The
 * library store (ContentTranslation "MediaImage") only fills keys the product
 * store has no entry for, and only with a non-empty value -- it holds leftovers
 * from the time the file was a library file. A library-only medium has no
 * product store: its library entries are taken as they are.
 */
export function mergeAltLayerFallback(
  product: ReadonlyMap<string, string>,
  library: ReadonlyMap<string, string>,
  backed: boolean,
): Map<string, string> {
  if (!backed) return new Map(library);
  const merged = new Map(product);
  for (const [key, value] of library) {
    if (merged.has(key)) continue;
    if (value.trim() === "") continue;
    merged.set(key, value);
  }
  return merged;
}
