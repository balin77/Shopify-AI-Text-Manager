/**
 * Which of several requested uploads became which created medium, when one
 * `productCreateMedia` call answered with FEWER media than were requested.
 *
 * The answer's order cannot be trusted then (a refused file leaves no slot), so
 * nothing is mapped by position. The created media are read afresh and each
 * requested upload is matched to a created medium by FILENAME STEM: exactly
 * equal, or Shopify's appended suffix (`name_<something>` before the extension,
 * which Shopify adds when a file of that name already exists; the suffix format
 * is NOT measured on a shop, so any non-empty text after `stem_` counts).
 *
 * A match counts only when it is UNIQUE BOTH WAYS: exactly one created medium
 * fits that upload and that medium fits no other upload. Everything else is
 * UNCERTAIN: not mapped, and (the caller's rule) not uploaded again either,
 * because it may already exist on the product.
 *
 * Client-safe and import-free.
 */

export interface RequestedUpload {
  resourceUrl: string;
}

export interface CreatedMediumFile {
  id: string;
  /** The filename (or the external link) the created medium reports; null = it reports none yet (still processing). */
  filename: string | null;
}

export interface UploadMatch {
  /** resourceUrl -> created medium id, only for unique-both-ways matches. */
  mapped: Record<string, string>;
  /** Uploads that may be among the created media but could not be tied to one. */
  uncertain: string[];
}

/** Last path segment of a URL without query/hash, decoded and lowercased; null when there is none. */
export function filenameOfUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const path = url.split("#")[0].split("?")[0];
  const last = path.split("/").pop() ?? "";
  if (!last) return null;
  let decoded = last;
  try { decoded = decodeURIComponent(last); } catch { /* keep the raw segment */ }
  return decoded.toLowerCase();
}

function splitName(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return { stem: name, ext: "" };
  const ext = name.slice(dot + 1);
  return { stem: name.slice(0, dot), ext: ext === "jpeg" ? "jpg" : ext };
}

/** Does a created medium's filename fit a requested upload's filename: same stem, or `stem_<suffix>`; same extension when both have one. */
export function filenameFits(requested: string, created: string): boolean {
  const r = splitName(requested.toLowerCase());
  const c = splitName(created.toLowerCase());
  if (r.ext && c.ext && r.ext !== c.ext) return false;
  if (!r.stem) return false;
  if (c.stem === r.stem) return true;
  return c.stem.length > r.stem.length + 1 && c.stem.startsWith(`${r.stem}_`);
}

export function matchUploadsToCreatedMedia(
  requested: readonly RequestedUpload[],
  created: readonly CreatedMediumFile[],
): UploadMatch {
  const fits = new Map<string, string[]>(); // resourceUrl -> created ids that fit it
  const claimedBy = new Map<string, string[]>(); // created id -> resourceUrls it fits
  for (const r of requested) {
    const rn = filenameOfUrl(r.resourceUrl);
    const ids: string[] = [];
    for (const c of created) {
      if (!rn || !c.filename) continue;
      if (c.filename === r.resourceUrl.toLowerCase() || filenameFits(rn, c.filename)) ids.push(c.id);
    }
    fits.set(r.resourceUrl, ids);
    for (const id of ids) claimedBy.set(id, [...(claimedBy.get(id) ?? []), r.resourceUrl]);
  }
  const mapped: Record<string, string> = {};
  const usedIds = new Set<string>();
  for (const r of requested) {
    const ids = fits.get(r.resourceUrl) ?? [];
    if (ids.length === 1 && (claimedBy.get(ids[0]) ?? []).length === 1) {
      mapped[r.resourceUrl] = ids[0];
      usedIds.add(ids[0]);
    }
  }
  // A created medium that no upload could be tied to may be ANY upload that is not mapped: all of those are uncertain.
  // With every created medium accounted for, the unmapped uploads were refused by Shopify and are simply retried.
  const leftoverCreated = created.filter((c) => !usedIds.has(c.id));
  const uncertain = leftoverCreated.length > 0 ? requested.filter((r) => !(r.resourceUrl in mapped)).map((r) => r.resourceUrl) : [];
  return { mapped, uncertain };
}
