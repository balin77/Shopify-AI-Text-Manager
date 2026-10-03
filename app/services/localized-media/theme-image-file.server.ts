/**
 * The `shopify://shop_images/<file>` reference of a Files image, derived from
 * a FRESH read of the file by its id — never from text the client sent.
 *
 * Used by the primary theme save (the original image of an `image_picker`
 * setting). The foreign save derives its reference in the browser from the
 * picked file's CDN URL with `filenameFromCdnUrl` + decode +
 * `themeImageReferenceFor`; this is the same derivation, repeated on the
 * server where the value is authoritative.
 */
import { logger } from "~/utils/logger.server";
import {
  THEME_IMAGE_FILE_ID,
  filenameFromCdnUrl,
  isSafeThemeImageFilename,
  isThemeImageReference,
  themeImageReferenceFor,
} from "~/utils/theme-image-reference.shared";
import { isShopifyCdnUrl } from "./localized-media.shared";

export type ThemeImageFileCode = "invalidFile" | "fileNotReady" | "readFailed";

export type ThemeImageReferenceResult =
  | { ok: true; reference: string; filename: string }
  | { ok: false; code: ThemeImageFileCode };

const READ_THEME_IMAGE_FILE = `#graphql
  query themeImageFile($id: ID!) {
    node(id: $id) {
      id
      ... on MediaImage { fileStatus image { url } }
    }
  }
`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Admin = { graphql: (query: string, opts?: any) => Promise<{ json: () => Promise<any> }> };

export async function resolveThemeImageReference(admin: Admin, fileId: unknown): Promise<ThemeImageReferenceResult> {
  if (typeof fileId !== "string" || !THEME_IMAGE_FILE_ID.test(fileId)) return { ok: false, code: "invalidFile" };
  let node: { fileStatus?: string; image?: { url?: string } | null } | null | undefined;
  try {
    const res = await admin.graphql(READ_THEME_IMAGE_FILE, { variables: { id: fileId } });
    const body = await res.json();
    // A top-level errors array or a missing data object is a failed read, not
    // "no such file": nothing here may be guessed from it.
    if (!body || body.errors || !body.data) return { ok: false, code: "readFailed" };
    node = body.data.node;
  } catch (error) {
    logger.warn("[theme-image] file read failed", { error: error instanceof Error ? error.message : String(error) });
    return { ok: false, code: "readFailed" };
  }
  // Not a MediaImage (a video or a missing node answers without these fields).
  if (!node || node.fileStatus === undefined) return { ok: false, code: "invalidFile" };
  if (node.fileStatus !== "READY") return { ok: false, code: "fileNotReady" };
  const url = node.image?.url;
  if (!url) return { ok: false, code: "fileNotReady" };
  const raw = filenameFromCdnUrl(url);
  if (!isShopifyCdnUrl(url) || !raw) return { ok: false, code: "invalidFile" };
  // A reference names the file as Files knows it, i.e. decoded.
  let filename = raw;
  try { filename = decodeURIComponent(raw); } catch { /* keep raw */ }
  const reference = themeImageReferenceFor(filename);
  // A space or an umlaut is a legitimate name; separators, control characters,
  // quotes and angle brackets are not.
  if (!isSafeThemeImageFilename(filename) || !isThemeImageReference(reference)) return { ok: false, code: "invalidFile" };
  return { ok: true, reference, filename };
}
