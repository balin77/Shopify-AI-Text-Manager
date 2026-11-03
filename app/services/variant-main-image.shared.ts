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
 * A main image changes only on an EXPLICIT intent of the merchant, never because
 * of how a list happens to look: dragging an image to the first slot of the
 * variant's OWN gallery (`mainGid` + the main image the editor showed as
 * `expectedMainGid`), removing the main image (`removedMainGid`, the GID that was
 * removed) or, for a variant with no native image at all, a real edit
 * (`promoteIfEmpty`). Each one is compared with a FRESH read on the server, so a
 * replay, a retry or a stale tab can never move a main image the merchant did
 * not touch. A product-gallery reorder, an add, a copy or a bulk upload never
 * changes a main image.
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

/** What `variant_gallery` (list.file_reference) can hold: an image, a video or a generic file. A 3D model or an
 *  external video is never a file entry of a variant gallery (they live in their own link / model lists). */
export function isFileKindGid(ref: string | null | undefined): boolean {
  return typeof ref === "string" && /^gid:\/\/shopify\/(MediaImage|Video|GenericFile)\//.test(ref);
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
  /** References that are no GID yet but ARE images (an upload / clone this save creates): only the display
   *  of a variant with no native image uses it (the server promotes the created medium by its GID). */
  isStagedImage?: (ref: string) => boolean;
}): string | null {
  const files = galleryWithout(input.files, input.removedMain);
  for (const gid of visibleFileOrder(files, input.orderJson)) {
    if (!isImageGid(gid) && !input.isStagedImage?.(gid)) continue;
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
  /** The image the gallery shows with the gold border; null = none. */
  mainGid: string | null;
  /** The variant's file GIDs as displayed. The main image is among them exactly once. */
  gids: string[];
}

/**
 * What a variant's gallery SHOWS. The explicit intent of the merchant decides
 * the main image and nothing is inferred from the list:
 *  - `pendingMain` (set only by dragging an image to the first slot of the
 *    variant's own gallery): that image is the main image;
 *  - `removed` (the main image was deleted or moved away): the image that moves up
 *    on save is shown as the main right away;
 *  - otherwise the native main image. It keeps the position the stored list gives
 *    it; when the list does not hold it (the normal case, the metafield never
 *    holds it) it is put first.
 * A variant with no main image and none removed shows its gallery as stored.
 */
export function displayMain(input: {
  nativeMainGid: string | null | undefined;
  removed: boolean;
  pendingMain?: string | null;
  stored: readonly string[];
  orderJson?: string | null;
  isCandidate?: (gid: string) => boolean;
  isStagedImage?: (ref: string) => boolean;
}): DisplayMain {
  const native = input.nativeMainGid || null;
  const own = galleryWithout(input.stored);
  if (input.pendingMain) {
    const main = input.pendingMain;
    const withOld = native && !input.removed && !own.includes(native) ? [...own, native] : own;
    return { mainGid: main, gids: withOld.includes(main) ? withOld : [main, ...withOld] };
  }
  if (native && !input.removed) {
    return { mainGid: native, gids: own.includes(native) ? own : [native, ...own] };
  }
  if (input.removed) {
    const promoted = pickPromotedMain({
      files: input.stored,
      orderJson: input.orderJson,
      removedMain: native,
      isCandidate: input.isCandidate,
      isStagedImage: input.isStagedImage,
    });
    const rest = galleryWithout(input.stored, native, promoted);
    return promoted ? { mainGid: promoted, gids: [promoted, ...rest] } : { mainGid: null, gids: rest };
  }
  return { mainGid: null, gids: own };
}

/**
 * The saved order as the gallery SHOWS it: when an order exists but does not
 * list the main image, the main image is put first (the storefront emits a
 * variant's own image first whatever the order says, and a tile the order does
 * not cover would otherwise be appended at the very end).
 */
export function orderShowingMain(orderJson: string | null | undefined, mainGid: string | null | undefined): string | null {
  const entries = parseGalleryOrder(orderJson);
  if (!entries || entries.length === 0 || !mainGid) return orderJson ?? null;
  if (entries.some((e) => e.kind === "file" && e.value === mainGid)) return orderJson ?? null;
  return JSON.stringify([{ kind: "file", value: mainGid }, ...entries]);
}

/**
 * A pending order after files were deleted: the deleted file entries are gone, and the order must
 * still START with a file (the route refuses an order that does not): the first remaining file entry
 * moves to the front. `null` = no file entry is left, the order is dropped.
 */
export function orderWithoutFiles(orderJson: string | null | undefined, removed: ReadonlySet<string>): string | null {
  const entries = parseGalleryOrder(orderJson);
  if (!entries) return orderJson ?? null;
  return normalizeOrderHead(entries.filter((e) => !(e.kind === "file" && removed.has(e.value))));
}

/**
 * The ONE head rule for a gallery order, used by the editor and the route: it must start with a file
 * entry when there is one, and the first IMAGE file leads (a video / generic file cannot be a main
 * image); with files but no image the first file leads; with only links / models the order is kept as it
 * is; an EMPTY order is `null`: the caller writes no order (and clears a stored one).
 */
export function normalizeOrderHead(entries: GalleryOrderEntry[]): string | null {
  const kept = [...entries];
  let first = kept.findIndex((e) => e.kind === "file" && isImageGid(e.value));
  if (first === -1) first = kept.findIndex((e) => e.kind === "file");
  // No file entry at all: an order of links / models only is valid for the embed (it renders them straight
  // from the order, without a main image in front); only an EMPTY order means "no order".
  if (first === -1) return kept.length > 0 ? JSON.stringify(kept) : null;
  if (first > 0) kept.unshift(...kept.splice(first, 1));
  return JSON.stringify(kept);
}

/**
 * The order restricted to the links and models the variant really has (`null` = no restriction for
 * that kind). A link or model entry the variant no longer holds is never written: the embed renders
 * those entries straight from the order.
 */
export function orderRestrictedToLinks(
  orderJson: string | null | undefined,
  allowedUrls: ReadonlySet<string> | null,
  allowedModels: ReadonlySet<string> | null,
): string | null {
  const entries = parseGalleryOrder(orderJson);
  if (!entries) return orderJson ?? null;
  return normalizeOrderHead(
    entries.filter((e) => (e.kind === "url" ? !allowedUrls || allowedUrls.has(e.value) : e.kind === "model" ? !allowedModels || allowedModels.has(e.value) : true)),
  );
}

export interface VariantGalleryEmission {
  variantId: string;
  /** The variant's file references as the editor holds them (may hold the main image). */
  fileGids: string[];
  /** true = nothing here changes the variant's main image. */
  galleryOnly?: boolean;
  /** The variant has no native image at all: a real edit promotes its first own image. */
  promoteIfEmpty?: boolean;
  /** The merchant removed this main image (deleted the medium / moved it away). */
  removedMainGid?: string;
  /** Explicit intent: this image becomes the main image ... */
  mainGid?: string;
  /** ... provided the variant's main image still is this one (null = none). */
  expectedMainGid?: string | null;
}

/** The merchant dragged `gid` to the first slot of the variant's own gallery while the main image was `expected`. */
export interface PendingMain {
  gid: string;
  expected: string | null;
}

export interface RemovedMainEmission {
  variantId: string;
  removedMainGid: string;
}

/**
 * What the editor hands to the save for the variants with a pending change.
 * Every statement is an explicit intent with the OLD value it is based on, so a
 * replay or a stale tab can never move a main image the merchant did not touch:
 *  - `removed[variantId]` (the main image's GID the merchant removed): a
 *    removal; with a pending list it travels with it, without one on its own;
 *  - `pendingMain[variantId]` (dragged to the first slot of the variant's own
 *    gallery): `mainGid` + `expectedMainGid` (the main image the editor showed);
 *  - any other variant with a main image it can name: `galleryOnly`;
 *  - a variant with no native image: `promoteIfEmpty`;
 *  - a variant whose native image URL does not resolve to a GID: `galleryOnly`
 *    (its `mediaId` is never touched because the editor could not name it).
 */
export function buildVariantEmission(input: {
  pending: Record<string, readonly string[]>;
  removed: Readonly<Record<string, string>>;
  pendingMain?: Readonly<Record<string, PendingMain>>;
  variants: ReadonlyArray<{ id: string; mainGid?: string | null; hasNativeImage?: boolean; galleryFileGids: readonly string[] }>;
}): { galleries: VariantGalleryEmission[]; removedMainImages: RemovedMainEmission[] } {
  const byId = new Map(input.variants.map((v) => [v.id, v]));
  const pendingMain = input.pendingMain ?? {};
  const galleries: VariantGalleryEmission[] = [];
  const removedMainImages: RemovedMainEmission[] = [];
  for (const [variantId, fileGids] of Object.entries(input.pending)) {
    const variant = byId.get(variantId);
    const main = variant?.mainGid || null;
    const removedGid = input.removed[variantId];
    const chosen = pendingMain[variantId]?.gid;
    if (removedGid) {
      galleries.push({
        variantId,
        fileGids: galleryWithout(fileGids, removedGid),
        removedMainGid: removedGid,
        // The main image the editor SHOWED (what the removal promoted) is the basis of the choice.
        ...(chosen ? { mainGid: chosen, expectedMainGid: pendingMain[variantId].expected } : {}),
      });
    } else if (chosen && chosen !== main) {
      galleries.push({ variantId, fileGids: [...fileGids], mainGid: chosen, expectedMainGid: pendingMain[variantId].expected });
    } else if (main) {
      galleries.push({ variantId, fileGids: galleryWithout(fileGids, main), galleryOnly: true, expectedMainGid: main });
    } else if (variant && variant.hasNativeImage === false) {
      galleries.push({ variantId, fileGids: [...fileGids], promoteIfEmpty: true });
    } else {
      galleries.push({ variantId, fileGids: [...fileGids], galleryOnly: true });
    }
  }
  for (const [variantId, removedGid] of Object.entries(input.removed)) {
    if (input.pending[variantId] !== undefined) continue;
    removedMainImages.push({ variantId, removedMainGid: removedGid });
  }
  return { galleries, removedMainImages };
}

/** What the server knows about a variant right now (a fresh read, not the client's belief). */
export interface VariantLookup {
  /** The variant's native image GID, null = none. */
  main: string | null;
  /** The stored `variant_gallery` list. */
  gallery: string[];
  /** The stored `variant_gallery_order` JSON, null = none. */
  order: string | null;
  /** The stored link / model lists (`variant_external_videos`, `variant_3d_models`), when the read had them. */
  links?: string[];
  models?: string[];
}

export type MainRefusal = "mainChangedElsewhere" | "lookupFailed" | "attachFailed" | "attachNotConfirmed" | "notAnImage" | "variantNotFound" | "mainFileGone";

export interface VariantWritePlan {
  /** `write` = send it; `skip` = nothing to do for this variant (an idempotent replay); `refuse` = do not touch the variant. */
  action: "write" | "skip" | "refuse";
  refusal?: MainRefusal;
  /** `undefined` = leave the variant's image alone; a GID = set it; `null` = unset it (nothing left to move up). */
  mediaId: string | null | undefined;
  /** What goes into `custom.variant_gallery`: never the main image, never a duplicate. */
  gallery: string[];
  /** The rewritten order JSON when the main image changed or the stored order needs it. */
  order?: string;
  /** The image that becomes the main image in this write (promotion or explicit choice). */
  promoted?: string | null;
  /** A MediaImage the product does not hold: it must be attached (fileUpdate) before `mediaId` can be set. */
  attach?: string;
}

const refuse = (refusal: MainRefusal): VariantWritePlan => ({ action: "refuse", refusal, mediaId: undefined, gallery: [] });

/** The single-entry order the embed needs so that a variant with a main image and an empty gallery shows ONLY that image. */
export function mainOnlyOrder(mainGid: string): string {
  return JSON.stringify([{ kind: "file", value: mainGid }]);
}

/**
 * The ONE decision about a variant's main image and gallery on a write. Every
 * change of the main image is an explicit intent and is compared with the FRESH
 * read (`lookup`); nothing is inferred from the list the editor sent.
 *  - `removedMainGid`: the merchant removed that main image. Acts only while the
 *    fresh main image still is that one (or is empty); a replay / a stale tab
 *    finds another main image and does nothing (a bare removal) or is refused
 *    (when it carries a list that is not what the removal would have produced).
 *  - `mainGid` + `expectedMainGid`: an explicit choice. Equal to the fresh main
 *    image = no change; the fresh main image is the expected one = set it; any
 *    other = refused.
 *  - `promoteIfEmpty`: the variant had no native image; only an empty one gets
 *    its first own image promoted.
 *  - otherwise (galleryOnly) the main image is not touched and never stored in
 *    the gallery.
 * A main image is only ever set from a lookup that succeeded (fail closed).
 * `productMedia` = the product's media (GID -> media type) from the same lookup.
 */
export function planVariantWrite(input: {
  fileGids: readonly string[] | null;
  galleryOnly?: boolean;
  promoteIfEmpty?: boolean;
  removedMainGid?: string | null;
  mainGid?: string | null;
  expectedMainGid?: string | null;
  lookup?: VariantLookup | null;
  clientOrderJson?: string | null;
  productMedia?: ReadonlyMap<string, string> | null;
  /** Files that can still be promoted (a reference to a file that no longer exists is not one). */
  isCandidate?: (gid: string) => boolean;
  /** GIDs created in THIS request: a removal does not promote them (the editor shows no promoted image for an
   *  unsaved upload); a variant with no native image DOES get its first own image, created ones included. */
  createdGids?: ReadonlySet<string>;
}): VariantWritePlan {
  const lk = input.lookup ?? null;
  const touchesMain = !!input.removedMainGid || !!input.mainGid || !!input.promoteIfEmpty;
  if (touchesMain && !lk) return refuse("lookupFailed");
  const needsAttach = (gid: string) => !!input.productMedia && !input.productMedia.has(gid);
  const withOrder = (
    base: VariantWritePlan,
    orderJson: string | null,
    finalMain: string | null,
    removedMain: string | null,
  ): VariantWritePlan => {
    // The order the embed needs when the promoted main image is all a variant has.
    let order: string | null = null;
    if (base.promoted) {
      order = orderJson ? orderAfterMainChange(orderJson, removedMain, base.promoted) : null;
      if (!order && base.gallery.length === 0) order = mainOnlyOrder(base.promoted);
    } else if (!input.clientOrderJson && lk?.order && finalMain && base.gallery.length > 0) {
      // A stale single-entry "main only" order must not hide a gallery image added later.
      const entries = parseGalleryOrder(lk.order);
      if (entries && entries.length === 1 && entries[0].kind === "file" && entries[0].value === finalMain) {
        order = JSON.stringify([{ kind: "file", value: finalMain }, ...base.gallery.map((g) => ({ kind: "file", value: g }))]);
      }
    }
    return order ? { ...base, order } : base;
  };

  // 1. The merchant removed the main image.
  if (input.removedMainGid) {
    const removed = input.removedMainGid;
    const cur = lk!.main;
    const files = input.fileGids ?? lk!.gallery;
    const orderJson = input.clientOrderJson ?? lk!.order;
    if (input.mainGid && !isImageGid(input.mainGid)) return refuse("notAnImage");
    const chosen = input.mainGid ?? pickPromotedMain({
      files,
      orderJson,
      removedMain: removed,
      isCandidate: (g) => (input.isCandidate ? input.isCandidate(g) : true) && !input.createdGids?.has(g),
    });
    // The merchant chose another main image right after the removal, based on the image the editor
    // showed as the promoted main (`expectedMainGid`). When the fresh read holds exactly that image
    // (our own earlier write), the explicit choice replaces it instead of being refused.
    if (cur && cur !== removed && input.mainGid && cur !== input.mainGid && cur === input.expectedMainGid) {
      const base: VariantWritePlan = {
        action: "write",
        mediaId: input.mainGid,
        gallery: galleryWithout(files, removed, input.mainGid),
        promoted: input.mainGid,
        ...(needsAttach(input.mainGid) ? { attach: input.mainGid } : {}),
      };
      return withOrder(base, orderJson, input.mainGid, removed);
    }
    if (cur && cur !== removed) {
      if (input.fileGids === null) return { action: "skip", mediaId: undefined, gallery: [] };
      // Our own earlier write may have landed already: the fresh main image is what this removal promotes.
      if (cur !== chosen) return refuse("mainChangedElsewhere");
      const tolerated = withOrder(
        { action: "write", mediaId: undefined, gallery: galleryWithout(files, removed, cur) },
        orderJson,
        cur,
        removed,
      );
      // A client order that still lists the removed main image is not written back as it is.
      if (!tolerated.order && input.clientOrderJson) {
        const cleaned = orderAfterMainChange(input.clientOrderJson, removed, cur);
        if (cleaned) tolerated.order = cleaned;
      }
      return tolerated;
    }
    const base: VariantWritePlan = {
      action: "write",
      mediaId: chosen ?? (cur === removed ? null : undefined),
      gallery: galleryWithout(files, removed, chosen),
      promoted: chosen,
      ...(chosen && needsAttach(chosen) ? { attach: chosen } : {}),
    };
    const out = withOrder(base, orderJson, chosen, removed);
    // Nothing moved up: the removed main image's file entry still leaves the stored order.
    if (!chosen && orderJson && !out.order) {
      const cleaned = orderAfterMainChange(orderJson, removed, null);
      if (cleaned && cleaned !== "[]") out.order = normalizeOrderHead(parseGalleryOrder(cleaned) ?? []) ?? cleaned;
    }
    return out;
  }

  const files = input.fileGids ?? [];

  // 2. An explicit choice of the main image.
  if (input.mainGid) {
    const target = input.mainGid;
    if (!isImageGid(target)) return refuse("notAnImage");
    const cur = lk!.main;
    if (cur === target) {
      return withOrder({ action: "write", mediaId: undefined, gallery: galleryWithout(files, target) }, null, target, null);
    }
    if ((cur ?? null) !== (input.expectedMainGid ?? null)) return refuse("mainChangedElsewhere");
    return {
      action: "write",
      mediaId: target,
      // The previous main image stays in the list where the merchant put it.
      gallery: galleryWithout(files, target),
      promoted: target,
      ...(needsAttach(target) ? { attach: target } : {}),
    };
  }

  // 3. A variant with no native image gets the first own image of a real edit.
  if (input.promoteIfEmpty && lk && !lk.main) {
    const orderJson = input.clientOrderJson ?? lk.order;
    const promoted = pickPromotedMain({ files, orderJson, isCandidate: input.isCandidate });
    if (promoted) {
      return withOrder(
        {
          action: "write",
          mediaId: promoted,
          gallery: galleryWithout(files, promoted),
          promoted,
          ...(needsAttach(promoted) ? { attach: promoted } : {}),
        },
        orderJson,
        promoted,
        null,
      );
    }
  }

  // 4. Plain write: the main image is not touched and never stored in the gallery. A write that
  // states which main image the editor showed (galleryOnly + expectedMainGid) is refused when the
  // fresh read says another one: a stale tab would otherwise strip the NEW main from its list and
  // write the old gallery over it.
  if (input.galleryOnly && input.expectedMainGid && lk && lk.main !== input.expectedMainGid) {
    return refuse("mainChangedElsewhere");
  }
  return withOrder(
    { action: "write", mediaId: undefined, gallery: galleryWithout(files, lk?.main) },
    null,
    lk?.main ?? null,
    null,
  );
}

export interface DragEntry {
  id: string;
  /** A MediaImage: the only kind that can be a variant's main image. */
  isImage: boolean;
}

export type DragMainPlan =
  | { kind: "reorder"; order: string[]; /** The image that leads now and did not before; null = the first slot did not change. */ newMain: string | null }
  | { kind: "refused"; reason: "nonImageFirst" | "onlyImage" };

/**
 * A drag inside a variant's own gallery. The first slot is the main image:
 *  - the first slot does not change: a plain reorder, the main image is untouched;
 *  - an image comes to the first slot: it becomes the main image (`newMain`);
 *  - a video / link / 3D model dragged to the first slot: refused;
 *  - the main image dragged away so that a non-image would lead: the first image of
 *    the result moves to the front instead (`[M, V, A]` with M to the end gives
 *    `[A, V, M]`); when the dragged image is the only image the drag is refused.
 */
export function planVariantDrag(entries: readonly DragEntry[], fromId: string, toId: string): DragMainPlan | null {
  const from = entries.findIndex((e) => e.id === fromId);
  const to = entries.findIndex((e) => e.id === toId);
  if (from === -1 || to === -1 || from === to) return null;
  const moved = [...entries];
  const [item] = moved.splice(from, 1);
  moved.splice(to, 0, item);
  const oldHead = entries[0];
  const head = moved[0];
  if (head.id === oldHead.id) return { kind: "reorder", order: moved.map((e) => e.id), newMain: null };
  if (head.isImage) return { kind: "reorder", order: moved.map((e) => e.id), newMain: head.id };
  if (head.id === item.id) return { kind: "refused", reason: "nonImageFirst" };
  const first = moved.find((e) => e.isImage && e.id !== item.id);
  if (!first) return { kind: "refused", reason: "onlyImage" };
  return {
    kind: "reorder",
    order: [first.id, ...moved.filter((e) => e.id !== first.id).map((e) => e.id)],
    newMain: first.id,
  };
}
