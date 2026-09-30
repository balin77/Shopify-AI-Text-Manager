/**
 * Turns what the file picker hands back into a PERMANENT Shopify file:
 * `{ fileId, url }` — the MediaImage GID and its CDN URL.
 *
 * A library pick already is one. An upload is only a staged target at this
 * point (`resourceUrl`), so it is materialised through the existing
 * `/api/create-shopify-file` (fileCreate + poll until READY). Both callers of
 * "a different image per language" — the theme image field and the product
 * card — need exactly this, and a second copy would drift on the one case that
 * matters: a file still processing is an ERROR here, never a half-written URL.
 *
 * Plain `.ts`, not `.client.ts`: the components that import it render on the
 * server too, where a `.client` module is `undefined` (CLAUDE.md, server
 * error logging). It only ever runs from a click handler.
 */
import type { AddedItem } from "../image-manager/FilePickerModal";

export type PickedImage = { fileId: string; url: string };

export type PickFailure = { error: string; code?: "stillProcessing" };

export async function resolvePickedImage(item: AddedItem | undefined): Promise<PickedImage | PickFailure> {
  if (!item) return { error: "No image selected" };
  if (item.source === "external_url") return { error: "A link is not an image file" };
  if (item.kind !== "image") return { error: "Only images can replace an image" };
  if (item.source === "library") {
    if (!item.gid || !item.assetUrl) return { error: "The file has no URL yet" };
    return { fileId: item.gid, url: item.assetUrl };
  }
  try {
    const res = await fetch("/api/create-shopify-file", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resourceUrl: item.resourceUrl }),
    });
    const body = (await res.json().catch(() => ({}))) as { fileId?: string; url?: string; error?: string };
    // 504 = the file EXISTS in Files but Shopify is still processing it. It is
    // not an upload failure: re-uploading would create a duplicate, while the
    // same file can be picked from the library a moment later.
    if (res.status === 504 && body.fileId) return { error: body.error || "processing", code: "stillProcessing" };
    if (!res.ok || !body.fileId || !body.url) return { error: body.error || `HTTP ${res.status}` };
    return { fileId: body.fileId, url: body.url };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
