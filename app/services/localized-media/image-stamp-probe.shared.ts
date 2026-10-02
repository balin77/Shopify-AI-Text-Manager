/**
 * Client-safe half of the image-stamp probe (image-stamp-probe.server.ts):
 * the report shape and the pure verdict. Imports nothing.
 *
 * The question: a replacement image stores `s` = the original's full
 * `image.url` including its `?v=` query. Does Shopify change that query when
 * only the ALT TEXT of the MediaImage changes? If yes, every replacement
 * would read "original changed" after any alt edit.
 */

export interface ImageStampProbeReport {
  ranAt: string;
  productId: string | null;
  mediaId: string | null;
  originalAlt: string | null;
  markerAlt: string | null;
  urlBefore: string | null;
  urlAfterAltChange: string | null;
  urlAfterRestore: string | null;
  altChangeConfirmed: boolean;
  restoreConfirmed: boolean;
  pathChanged: boolean | null;
  queryChanged: boolean | null;
  restoreQueryChanged: boolean | null;
  attemptsAfterChange: number;
  verdict: string[];
  restoreFailed: boolean;
  error: string | null;
}

export function splitImageUrl(url: string): { path: string; query: string } {
  const i = url.indexOf("?");
  return i < 0 ? { path: url, query: "" } : { path: url.slice(0, i), query: url.slice(i + 1) };
}

export function compareImageUrls(a: string | null, b: string | null): { pathChanged: boolean; queryChanged: boolean } | null {
  if (!a || !b) return null;
  const x = splitImageUrl(a);
  const y = splitImageUrl(b);
  return { pathChanged: x.path !== y.path, queryChanged: x.query !== y.query };
}

export function computeStampVerdict(input: {
  altChangeConfirmed: boolean;
  urlBefore: string | null;
  urlAfterAltChange: string | null;
}): string[] {
  if (!input.altChangeConfirmed) return ["INCONCLUSIVE: the alt change was not confirmed by Shopify's echo, so nothing can be said."];
  const cmp = compareImageUrls(input.urlBefore, input.urlAfterAltChange);
  if (!cmp) return ["INCONCLUSIVE: the image url could not be read before and after the alt change."];
  if (cmp.pathChanged) {
    return ["The url PATH changed after an alt edit: the stamp must not use the whole url (compare something stabler, e.g. the file id)."];
  }
  if (cmp.queryChanged) {
    return ["ANSWER: alt edit CHANGES the query (?v=) -> the stamp must ignore the query (compare the path only)."];
  }
  return ["ANSWER: alt edit does NOT change the url or its ?v= query -> the stamp can stay the full url."];
}
