/**
 * The main image of a variant, and why the merchant never has to know it is
 * stored apart from the gallery.
 *
 * Shopify keeps ONE native image per variant (`mediaId`); the rest of the
 * variant's gallery is the list metafield `custom.variant_gallery`. The two must
 * never overlap: a main image that is also in the metafield is shown twice by
 * the storefront (embed default path, app block). And a variant that loses its
 * main image (the medium deleted, the image moved away) must not be left
 * without one while its gallery still holds images: Shopify needs a main image,
 * so the next image of the gallery moves up into `mediaId` and leaves the
 * metafield, in the same write.
 *
 * Pure and import-free: the browser (what the gallery shows, what a save
 * sends) and the route (what is written) apply the SAME rules from here.
 *
 * INVARIANT: the variant's main image GID is never in the gallery metafield.
 */

export const MEDIA_IMAGE_GID_PREFIX = "gid://shopify/MediaImage/";

/** Only a MediaImage can be a variant's native image (videos, 3D models,
 *  generic files and external URLs cannot). */
export function isImageGid(ref: string | null | undefined): ref is string {
  return typeof ref === "string" && ref.startsWith(MEDIA_IMAGE_GID_PREFIX);
}

export interface GalleryOrderEntry {
  kind: "file" | "url" | "model";
  value: string;
}

export function parseGalleryOrder(json: string | null | undefined): GalleryOrderEntry[] | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed.filter(
      (e): e is GalleryOrderEntry =>
        !!e && typeof e === "object" && typeof (e as GalleryOrderEntry).value === "string" &&
        ["file", "url", "model"].includes((e as GalleryOrderEntry).kind),
    );
  } catch {
    return null;
  }
}

/** `list` without duplicates and without any of `exclude`, order kept. */
export function galleryWithout(list: readonly string[], ...exclude: Array<string | null | undefined>): string[] {
  const skip = new Set(exclude.filter((g): g is string => !!g));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const gid of list) {
    if (skip.has(gid) || seen.has(gid)) continue;
    seen.add(gid);
    out.push(gid);
  }
  return out;
}

/**
 * The file references of a gallery in the order the merchant SEES them: the
 * saved order (`variant_gallery_order`) first, restricted to files the gallery
 * holds, then whatever the order does not cover.
 */
export function visibleFileOrder(files: readonly string[], orderJson?: string | null): string[] {
  const held = new Set(files);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of parseGalleryOrder(orderJson) ?? []) {
    if (entry.kind !== "file" || !held.has(entry.value) || seen.has(entry.value)) continue;
    seen.add(entry.value);
    out.push(entry.value);
  }
  for (const gid of files) {
    if (!seen.has(gid)) {
      seen.add(gid);
      out.push(gid);
    }
  }
  return out;
}

/**
 * The image that moves up when a variant loses its main image: the first FILE in
 * the visible order that can be a native variant image (a MediaImage, and
 * `isCandidate` when the caller knows which media the product holds). Videos,
 * external URLs and 3D models are skipped; `null` when nothing qualifies.
 */
export function pickPromotedMain(input: {
  files: readonly string[];
  orderJson?: string | null;
  removedMain?: string | null;
  isCandidate?: (gid: string) => boolean;
}): string | null {
  const files = galleryWithout(input.files, input.removedMain);
  for (const gid of visibleFileOrder(files, input.orderJson)) {
    if (!isImageGid(gid)) continue;
    if (input.isCandidate && !input.isCandidate(gid)) continue;
    return gid;
  }
  return null;
}

/**
 * The saved order after the main image changed: the removed one is gone, the
 * promoted one is first. `null` = there is no order to keep consistent.
 */
export function orderAfterMainChange(
  orderJson: string | null | undefined,
  removedMain: string | null | undefined,
  promoted: string | null | undefined,
): string | null {
  const entries = parseGalleryOrder(orderJson);
  if (!entries) return null;
  const rest = entries.filter(
    (e) => !(e.kind === "file" && (e.value === removedMain || e.value === promoted)),
  );
  return JSON.stringify(promoted ? [{ kind: "file", value: promoted }, ...rest] : rest);
}

export interface DisplayMain {
  /** The image the gallery shows first with the gold border; null = none. */
  mainGid: string | null;
  /** The variant's file GIDs as displayed: the main first, once. */
  gids: string[];
}

/**
 * What a variant's gallery SHOWS. With a native main image it is first and shown
 * once, whatever the metafield holds (older saves carry it twice). When the
 * merchant has removed it (`removed`), the image that moves up on save is shown
 * as the main right away. A variant with no main image and none removed shows
 * its gallery as stored (it has no main; nothing is promoted for it).
 */
export function displayMain(input: {
  nativeMainGid: string | null | undefined;
  removed: boolean;
  stored: readonly string[];
  orderJson?: string | null;
  isCandidate?: (gid: string) => boolean;
}): DisplayMain {
  const native = input.nativeMainGid || null;
  if (native && !input.removed) {
    return { mainGid: native, gids: [native, ...galleryWithout(input.stored, native)] };
  }
  if (input.removed) {
    const promoted = pickPromotedMain({
      files: input.stored,
      orderJson: input.orderJson,
      removedMain: native,
      isCandidate: input.isCandidate,
    });
    const rest = galleryWithout(input.stored, native, promoted);
    return promoted ? { mainGid: promoted, gids: [promoted, ...rest] } : { mainGid: null, gids: rest };
  }
  return { mainGid: null, gids: galleryWithout(input.stored) };
}

export interface VariantGalleryEmission {
  variantId: string;
  fileGids: string[];
  /** true = the variant keeps the main image it has; nothing here sets `mediaId`. */
  galleryOnly?: boolean;
}

/**
 * What the editor hands to the save for the variants with a pending gallery.
 *  - a variant with a main image it can name: `[main, ...gallery]` (the main is
 *    pinned first; a reorder of the gallery never changes it);
 *  - a variant whose main image was removed: the gallery without it, and the
 *    variant is listed in `clearVariantMainIds`: the save moves the next image up;
 *  - any other variant (no native image, or one whose URL does not resolve to a
 *    GID): `galleryOnly` -- its `mediaId` is never touched, so a real main image
 *    is never cleared because the editor could not name it.
 */
export function buildVariantEmission(input: {
  pending: Record<string, readonly string[]>;
  removedMainVariantIds: ReadonlySet<string>;
  variants: ReadonlyArray<{ id: string; mainGid?: string | null; galleryFileGids: readonly string[] }>;
}): { galleries: VariantGalleryEmission[]; clearVariantMainIds: string[] } {
  const byId = new Map(input.variants.map((v) => [v.id, v]));
  const galleries: VariantGalleryEmission[] = [];
  for (const [variantId, fileGids] of Object.entries(input.pending)) {
    const variant = byId.get(variantId);
    const main = variant?.mainGid || null;
    if (input.removedMainVariantIds.has(variantId)) {
      galleries.push({ variantId, fileGids: galleryWithout(fileGids, main) });
    } else if (main) {
      galleries.push({ variantId, fileGids: [main, ...galleryWithout(fileGids, main)] });
    } else {
      galleries.push({ variantId, fileGids: [...fileGids], galleryOnly: true });
    }
  }
  for (const variantId of input.removedMainVariantIds) {
    if (input.pending[variantId] !== undefined) continue;
    const variant = byId.get(variantId);
    galleries.push({
      variantId,
      fileGids: galleryWithout(variant?.galleryFileGids ?? [], variant?.mainGid || null),
    });
  }
  return { galleries, clearVariantMainIds: [...input.removedMainVariantIds] };
}

/** What the server knows about a variant right now (a fresh read, not the client's belief). */
export interface VariantLookup {
  /** The variant's native image GID, null = none. */
  main: string | null;
  /** The stored `variant_gallery` list. */
  gallery: string[];
  /** The stored `variant_gallery_order` JSON, null = none. */
  order: string | null;
}

export interface VariantWritePlan {
  /** `undefined` = leave the variant's image alone; a GID = set it; `null` = unset it (nothing left to move up). */
  mediaId: string | null | undefined;
  /** What goes into `custom.variant_gallery`: never the main image, never a duplicate. */
  gallery: string[];
  /** The rewritten order JSON when one exists and the main image changed. */
  order?: string;
  /** The image moved up into `mediaId` because the main image was removed. */
  promoted?: string | null;
}

/**
 * The ONE decision about a variant's main image and gallery on a write.
 *  - `clear`: the merchant removed the main image (deleted the medium, moved it
 *    away). The next image of the gallery moves up into `mediaId` and leaves
 *    the metafield; `mediaId` is unset only when no image qualifies.
 *  - `galleryOnly`: the variant keeps the main image it has. The gallery never
 *    holds it, whatever the caller sent.
 *  - otherwise the first file is the main image and the rest the gallery.
 * `fileGids === null` is a variant named only in `clear`: its stored gallery is
 * the source.
 */
export function planVariantWrite(input: {
  fileGids: readonly string[] | null;
  galleryOnly?: boolean;
  clear?: boolean;
  lookup?: VariantLookup | null;
  clientOrderJson?: string | null;
  isCandidate?: (gid: string) => boolean;
}): VariantWritePlan {
  const { lookup } = input;
  if (input.clear) {
    const removed = lookup?.main ?? null;
    const source = input.fileGids ?? lookup?.gallery ?? [];
    const orderJson = input.clientOrderJson ?? lookup?.order ?? null;
    const promoted = pickPromotedMain({
      files: source,
      orderJson,
      removedMain: removed,
      isCandidate: input.isCandidate,
    });
    const order = orderJson ? orderAfterMainChange(orderJson, removed, promoted) : null;
    return {
      mediaId: promoted ?? null,
      gallery: galleryWithout(source, removed, promoted),
      ...(order ? { order } : {}),
      promoted,
    };
  }
  const files = input.fileGids ?? [];
  if (input.galleryOnly) {
    return { mediaId: undefined, gallery: galleryWithout(files, lookup?.main) };
  }
  const main = files[0];
  return {
    mediaId: main === undefined ? undefined : main,
    gallery: galleryWithout(files.slice(1), main),
  };
}
