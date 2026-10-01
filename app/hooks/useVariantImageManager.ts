import { useState, useCallback, useRef } from "react";
import type { StagedItem, VariantWithGallery, MediaKind } from "../components/image-manager/types";
import type { SettlingMediaEntry } from "../components/image-manager/settling-media";

/** Resource URL + the kind it was uploaded as. The kind is needed at save
 *  time so productCreateMedia.mediaContentType maps correctly — without it
 *  every video / 3D file would be created as IMAGE and reject. previewUrl
 *  drives the optimistic gallery tile that appears the moment a merchant
 *  hits "Add" in the picker modal, so the change feels instant instead of
 *  having to wait for a server roundtrip. */
export interface PendingProductNewMedia {
  resourceUrl: string;
  kind: MediaKind;
  previewUrl?: string;
}

export interface VariantGalleryUpdate {
  variantId: string;
  fileGids: string[];
  // true = variant already has a main image; skip setting mediaId, all fileGids go to gallery metafield
  galleryOnly?: boolean;
}

export interface MediaOrderUpdate {
  mediaId: string;
  position: number;
}

export function useVariantImageManager() {
  const [bulkItems, setBulkItems] = useState<StagedItem[]>([]);
  const [selectedBulkIds, setSelectedBulkIds] = useState<Set<string>>(new Set());
  const [activeAction, setActiveAction] = useState<"copy" | "move" | null>(null);
  const [isApplying, setIsApplying] = useState(false);
  const [activeRightTab, setActiveRightTab] = useState<"seo" | "images">("seo");
  const [activeImageSubTab, setActiveImageSubTab] = useState<"bulkUpload" | "bulkAltText">("bulkUpload");
  const [variantReloadCounter, setVariantReloadCounter] = useState(0);
  const reloadVariants = useCallback(() => setVariantReloadCounter(c => c + 1), []);
  const [pendingVariantGalleries, setPendingVariantGalleries] = useState<VariantGalleryUpdate[]>([]);
  const [pendingMediaOrder, setPendingMediaOrder] = useState<MediaOrderUpdate[]>([]);
  const [pendingProductNewMedia, setPendingProductNewMedia] = useState<PendingProductNewMedia[]>([]);
  // Saved-but-still-processing media (see SettlingMedia). Deliberately NOT part
  // of hasPendingImageChanges — these are persisted; the Save button must not
  // light up again for them.
  const [settlingMedia, setSettlingMedia] = useState<SettlingMediaEntry[]>([]);
  const [pendingClearVariantMainImages, setPendingClearVariantMainImages] = useState<string[]>([]);
  // Per-variant YouTube / Vimeo URLs that the merchant has added via the URL
  // input inside each VariantGallerySection. variantId → canonical URLs.
  // Empty array is meaningful: it means "the merchant cleared this variant's
  // external videos" and the metafield value should be persisted as `[]`.
  const [pendingExternalVideos, setPendingExternalVideos] = useState<Record<string, string[]>>({});
  // Per-variant GLB CDN URLs. Mirrors pendingExternalVideos exactly (variant_3d_models
  // is a list.url metafield too) — same empty-array-means-cleared contract.
  const [pendingVariant3dModels, setPendingVariant3dModels] = useState<Record<string, string[]>>({});
  // Parallel preview URLs per variant — same index as pendingVariant3dModels.
  // An empty string at a slot means "this model has no preview yet" (legacy
  // entries from before variant_3d_previews existed, or library-picked models
  // we haven't snapshotted on the admin side). Persisted to
  // custom.variant_3d_previews (list.url). Add/remove handlers in
  // VariantImageManager keep both arrays in lockstep.
  const [pendingVariant3dPreviews, setPendingVariant3dPreviews] = useState<Record<string, string[]>>({});
  // Carry-over for Model3d uploads that didn't finish processing within the
  // backend's bounded polling window. Maps each still-staging URL onto its
  // Model3d GID (returned by the prior productCreateMedia call). The next
  // save sends this map as `knownModelGids` so the backend can poll the
  // GID directly instead of re-uploading the same .glb → no duplicate
  // product media. Cleared selectively after a save: only entries whose
  // staging URL came back resolved (i.e. NOT in the new "processing" drop
  // list) are removed.
  const [pendingKnownModelGids, setPendingKnownModelGids] = useState<Record<string, string>>({});
  // Combined order (file GIDs + external URLs + 3D model URLs) per variant.
  // Stringified JSON array of { kind: "file" | "url" | "model", value }.
  // Updated whenever the merchant reorders a gallery that mixes kinds; only
  // emitted to the backend when non-empty so legacy save flows stay byte-identical.
  const [pendingGalleryOrder, setPendingGalleryOrder] = useState<Record<string, string>>({});
  const [resetCounter, setResetCounter] = useState(0);
  const [hasAltTextEdits, setHasAltTextEdits] = useState(false);
  // Variants exposed to BulkImageUploadPanel for auto-assignment
  const [variantsForBulk, setVariantsForBulk] = useState<VariantWithGallery[]>([]);
  const [missingMainImageProductIds, setMissingMainImageProductIds] = useState<Set<string>>(new Set());
  const [selectedGalleryGids, setSelectedGalleryGids] = useState<string[]>([]);

  // Holds the per-variant pending state we WOULD clear at save-success time
  // if we wanted no flicker. handleApply sets this; handleVariantsLoaded
  // (which fires once the post-save /api/product-variants refetch lands)
  // applies it. The interleaving keeps the optimistic tiles visible until
  // the real product.media entries are in the local cache → seamless
  // transition instead of "image disappears for 500ms".
  const postSaveDeferredClearRef = useRef<null | {
    carryOverModels: Record<string, string[]>;
    carryOverPreviews: Record<string, string[]>;
    carryOverGids: Record<string, string>;
  }>(null);

  const handleVariantsLoaded = useCallback((variants: VariantWithGallery[]) => {
    setVariantsForBulk(variants);
    const deferred = postSaveDeferredClearRef.current;
    if (deferred) {
      postSaveDeferredClearRef.current = null;
      // The refetch has landed and shopifyMediaMap / refreshedProductImages
      // now contain the new MediaImage entries. Safe to drop the optimistic
      // staging tiles — what remains in pendingVariant3dModels /
      // pendingKnownModelGids is the "still-processing" carry-over (3D model
      // uploads whose Shopify-side processing hadn't finished by the time
      // the bounded polling window timed out).
      setPendingVariantGalleries([]);
      setPendingMediaOrder([]);
      setPendingProductNewMedia([]);
      setPendingClearVariantMainImages([]);
      setPendingExternalVideos({});
      // Merge the still-processing staging URLs with the variant's freshly-
      // fetched saved metafield URLs. Without the merge, pendingVariant3dModels
      // contains only the staging URL — and because the variant gallery's
      // render uses `pendingVariant3dModels[v.id] ?? variant.threeDModelUrls`
      // (override semantics), the override hides the saved models from the
      // gallery view. The merchant sees only the new (still-processing) model
      // until the next save, even though saved models are intact on Shopify.
      const mergedModels: Record<string, string[]> = {};
      const mergedPreviews: Record<string, string[]> = {};
      for (const [variantId, processingUrls] of Object.entries(deferred.carryOverModels)) {
        const v = variants.find((x) => x.id === variantId);
        const savedModels = v?.threeDModelUrls ?? [];
        const savedPreviews = v?.threeDPreviewUrls ?? [];
        const carryPreviews = deferred.carryOverPreviews[variantId] ?? [];
        mergedModels[variantId] = [...savedModels, ...processingUrls];
        mergedPreviews[variantId] = [
          ...savedPreviews,
          // Pad to length match: if the saved array is shorter than its
          // models, fill with "" so indices stay aligned.
          ...Array(Math.max(0, savedModels.length - savedPreviews.length)).fill(""),
          ...carryPreviews,
        ];
      }
      setPendingVariant3dModels(mergedModels);
      setPendingVariant3dPreviews(mergedPreviews);
      setPendingKnownModelGids(deferred.carryOverGids);
      setPendingGalleryOrder({});
      setResetCounter(c => c + 1);
    }
  }, []);

  const handleGallerySelectionGidsChange = useCallback((gids: string[]) => {
    setSelectedGalleryGids(gids);
  }, []);

  const handleMissingMainImageChange = useCallback((productId: string, hasMissing: boolean) => {
    setMissingMainImageProductIds(prev => {
      // Bail-out when membership wouldn't change. Without this, callers that
      // fire the same value on every render (e.g. an unmemoised parent prop
      // feeding a useEffect inside VariantImageManager) would still receive a
      // new Set instance from this setter → React commits the "change" → loop.
      const has = prev.has(productId);
      if (hasMissing === has) return prev;
      const next = new Set(prev);
      if (hasMissing) next.add(productId);
      else next.delete(productId);
      return next;
    });
  }, []);

  const handleBulkItemsChange = useCallback((updater: (prev: StagedItem[]) => StagedItem[]) => {
    setBulkItems(updater);
  }, []);

  const handleBulkSelect = useCallback((id: string, selected: boolean) => {
    setSelectedBulkIds(s => {
      const next = new Set(s);
      selected ? next.add(id) : next.delete(id);
      return next;
    });
  }, []);

  const handleRemoveBulk = useCallback((ids: string[]) => {
    setBulkItems(items => items.filter(i => !ids.includes(i.uniqueId)));
    setSelectedBulkIds(s => {
      const next = new Set(s);
      ids.forEach(id => next.delete(id));
      return next;
    });
  }, []);

  const handlePendingChange = useCallback(
    (galleries: VariantGalleryUpdate[], mediaOrder: MediaOrderUpdate[], productNewMedia?: PendingProductNewMedia[], clearVariantMainImages?: string[]) => {
      setPendingVariantGalleries(galleries);
      setPendingMediaOrder(mediaOrder);
      if (productNewMedia) setPendingProductNewMedia(productNewMedia);
      if (clearVariantMainImages !== undefined) setPendingClearVariantMainImages(clearVariantMainImages);
    },
    []
  );

  const handleApply = useCallback(async (productId: string): Promise<string | null> => {
    setIsApplying(true);
    try {
      const readyItems = bulkItems.filter(i => i.status === "ready");
      const allNewMedia = [
        // Forward each item's media kind to the backend so productCreateMedia
        // gets the right mediaContentType (IMAGE / VIDEO / MODEL_3D). Older
        // items without `kind` fall back to "image" server-side.
        ...readyItems.map(i => ({ resourceUrl: i.resourceUrl, kind: i.kind ?? "image" as const })),
        ...pendingProductNewMedia.map(m => ({ resourceUrl: m.resourceUrl, kind: m.kind })),
      ];

      // Merge auto-assigned bulk items into pendingVariantGalleries.
      // fileGids structure expected by the API:
      //   fileGids[0] → variant's native featured image (mediaId)
      //   fileGids[1..] → variant_gallery metafield
      // Group all new images per variant first so we can build the list in one pass.
      const newImagesByVariant = new Map<string, string[]>();
      for (const item of readyItems) {
        if (!item.targetVariantId || item.assignmentMode !== "assigned") continue;
        const group = newImagesByVariant.get(item.targetVariantId) ?? [];
        group.push(item.resourceUrl);
        newImagesByVariant.set(item.targetVariantId, group);
      }

      const mergedVariantGalleries = [...pendingVariantGalleries];
      for (const [variantId, newUrls] of newImagesByVariant) {
        const baseVariant = variantsForBulk.find(v => v.id === variantId);
        const mainGid = baseVariant?.mainImageGid;
        const galleryGids = baseVariant?.galleryFileGids ?? [];
        const existing = mergedVariantGalleries.find(vg => vg.variantId === variantId);

        if (mainGid) {
          // Variant already has a main image → all new uploads go to gallery only, mediaId unchanged.
          if (existing) {
            // pendingVariantGalleries entry already has mainGid at [0]; new URLs land after it → gallery.
            existing.fileGids = [...existing.fileGids, ...newUrls];
          } else {
            mergedVariantGalleries.push({ variantId, fileGids: [...galleryGids, ...newUrls], galleryOnly: true });
          }
        } else {
          // Variant has no main image → first new upload becomes the variant image, rest go to gallery.
          if (existing) {
            existing.fileGids = [...existing.fileGids, ...newUrls];
          } else {
            const fileGids = newUrls.length > 0
              ? [newUrls[0], ...galleryGids, ...newUrls.slice(1)]
              : [...galleryGids];
            mergedVariantGalleries.push({ variantId, fileGids });
          }
        }
      }

      // External-video URLs and combined gallery order live on their own
      // metafields, so the backend route can persist them in a single
      // metafieldsSet without crowding the productVariantsBulkUpdate payload.
      const variantExternalVideos = Object.entries(pendingExternalVideos).map(([variantId, urls]) => ({
        variantId,
        urls,
      }));
      const variant3dModels = Object.entries(pendingVariant3dModels).map(([variantId, urls]) => ({
        variantId,
        urls,
      }));
      const variant3dPreviews = Object.entries(pendingVariant3dPreviews).map(([variantId, urls]) => ({
        variantId,
        urls,
      }));
      const variantGalleryOrder = Object.entries(pendingGalleryOrder).map(([variantId, orderJson]) => ({
        variantId,
        orderJson,
      }));

      const res = await fetch("/api/update-variant-galleries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productId,
          newMedia: allNewMedia,
          variantGalleries: mergedVariantGalleries,
          mediaOrder: pendingMediaOrder,
          clearVariantMainImages: pendingClearVariantMainImages,
          variantExternalVideos,
          variant3dModels,
          variant3dPreviews,
          // Carry-over from prior processing drops: lets the backend poll
          // pre-existing Model3d GIDs directly without re-running
          // productCreateMedia on the same staging URL.
          knownModelGids: pendingKnownModelGids,
          variantGalleryOrder,
        }),
      });
      const data = await res.json();
      if (!data.success) {
        return (data.errors as string[]).join(", ");
      }
      // Server may have rejected a subset of external-video URLs (client and
      // server validation can drift on edge cases — whitespace, trailing
      // slashes, browser-corrected URLs). Loud-log them so a divergence
      // surfaces during QA instead of silently dropping the merchant's input.
      if (Array.isArray(data.droppedExternalUrls) && data.droppedExternalUrls.length > 0) {
        console.warn("[useVariantImageManager] server dropped external video URLs", data.droppedExternalUrls);
      }
      // Group dropped 3D URLs by reason. The bucket determines:
      //   • console feedback (informational vs error)
      //   • whether the staging URL + Model3d GID must be carried over
      //     to the next save so we can substitute it without re-running
      //     productCreateMedia (which would create a duplicate Media3d)
      type Drop3D = { variantId: string; url: string; reason?: string; gid?: string };
      const drops: Drop3D[] = Array.isArray(data.dropped3dModelUrls) ? data.dropped3dModelUrls : [];
      const processing = drops.filter(d => d.reason === "processing");
      const failed = drops.filter(d => d.reason === "invalid_glb");
      const orphaned = drops.filter(d => d.reason === "orphaned");
      const invalid = drops.filter(d => !d.reason || d.reason === "invalid_url");
      if (orphaned.length > 0) {
        console.warn(
          `[useVariantImageManager] ${orphaned.length} variant 3D model URL(s) cleaned up — ` +
          `the underlying file was deleted from this product's media.`,
          orphaned,
        );
      }
      if (processing.length > 0) {
        console.warn(
          `[useVariantImageManager] ${processing.length} 3D model upload(s) still processing on Shopify — ` +
          `the model is uploaded and on product.media; click Save again in ~10–30 seconds and the variant ` +
          `binding will land automatically (no duplicate media will be created).`,
          processing,
        );
      }
      if (failed.length > 0) {
        console.error(
          `[useVariantImageManager] ${failed.length} 3D model upload(s) rejected by Shopify (invalid .glb)`,
          failed,
        );
      }
      if (invalid.length > 0) {
        console.warn(
          `[useVariantImageManager] ${invalid.length} 3D model URL(s) failed isValid3dModelUrl validation`,
          invalid,
        );
      }
      // Carry-over: build the surviving pendingVariant3dModels (only the
      // still-processing staging URLs) and the staging→GID map for the
      // next save. Everything else gets cleared as usual.
      const carryOverModels: Record<string, string[]> = {};
      const carryOverGids: Record<string, string> = {};
      for (const d of processing) {
        if (!d.gid) continue; // skip drops without a GID — can't carry over
        if (!carryOverModels[d.variantId]) carryOverModels[d.variantId] = [];
        carryOverModels[d.variantId].push(d.url);
        carryOverGids[d.url] = d.gid;
      }
      // Parallel carry-over for the previews: same indices as
      // carryOverModels. Look up each surviving URL's old index in the
      // pre-save pendingVariant3dModels to find its preview, so a
      // still-processing model keeps its already-uploaded preview JPEG
      // (we do not want the merchant to re-snapshot on the next save).
      const carryOverPreviews: Record<string, string[]> = {};
      for (const variantId of Object.keys(carryOverModels)) {
        const oldModels = pendingVariant3dModels[variantId] ?? [];
        const oldPreviews = pendingVariant3dPreviews[variantId] ?? [];
        carryOverPreviews[variantId] = carryOverModels[variantId].map((url) => {
          const idx = oldModels.indexOf(url);
          return idx >= 0 ? (oldPreviews[idx] ?? "") : "";
        });
      }

      // Defer the per-variant + per-product pending clears until the
      // post-save refetch lands (see handleVariantsLoaded). Eager clearing
      // produced a visible flicker: pendingProductNewMedia dropped → tile
      // gone → refetch ~300-800ms later → tile re-appeared. By keeping the
      // optimistic staging tiles in state while the refetch is in flight,
      // the merchant sees a continuous image — the optimistic blob:URL
      // version + the real CDN-URL version coexist for one render tick at
      // most, then the deferred clear runs and only the real tile remains.
      postSaveDeferredClearRef.current = {
        carryOverModels,
        carryOverPreviews,
        carryOverGids,
      };
      // Every media node Shopify created for this save, with the local
      // preview we already have for it. Shopify keeps processing a new
      // MediaImage after productCreateMedia returns, and while it does,
      // /api/product-variants reports no URL for it at all — so the post-save
      // refetch below would land with the new image simply missing. Handing
      // these to the Image Manager lets it keep the tile (under the real GID)
      // and poll until the URL appears, instead of the merchant watching the
      // upload disappear and only finding it again after a page reload.
      const previewByResourceUrl = new Map<string, string | undefined>();
      for (const m of pendingProductNewMedia) previewByResourceUrl.set(m.resourceUrl, m.previewUrl);
      for (const i of readyItems) {
        if (!previewByResourceUrl.get(i.resourceUrl)) previewByResourceUrl.set(i.resourceUrl, i.previewUrl || undefined);
      }
      type CreatedMedia = { resourceUrl: string; mediaId: string; kind: MediaKind };
      const created: CreatedMedia[] = Array.isArray(data.createdMedia) ? data.createdMedia : [];
      if (created.length > 0) {
        setSettlingMedia(prev => {
          // Keep only entries still belonging to this product; an earlier
          // save's media may still be processing and must not be dropped.
          const kept = prev.filter(e => e.productId === productId);
          const seen = new Set(kept.map(e => e.mediaId));
          const additions: SettlingMediaEntry[] = created
            .filter(c => c.mediaId && !seen.has(c.mediaId))
            .map(c => ({
              productId,
              mediaId: c.mediaId,
              kind: c.kind ?? "image",
              previewUrl: previewByResourceUrl.get(c.resourceUrl),
            }));
          if (additions.length === 0 && kept.length === prev.length) return prev;
          return [...kept, ...additions];
        });
      }
      // bulkItems / hasAltTextEdits aren't tied to the gallery render in the
      // same way (no optimistic-tile flicker risk) so clear them now.
      setBulkItems([]);
      setSelectedBulkIds(new Set());
      setHasAltTextEdits(false);
      // Trigger the /api/product-variants refetch. When it returns,
      // handleVariantsLoaded reads postSaveDeferredClearRef and applies the
      // pending clears — at which point the new media is already on
      // shopifyMediaMap + refreshedProductImages so the visual transition
      // is seamless.
      setVariantReloadCounter(c => c + 1);
      return null;
    } finally {
      setIsApplying(false);
    }
  }, [bulkItems, pendingVariantGalleries, pendingMediaOrder, pendingProductNewMedia, pendingClearVariantMainImages, pendingExternalVideos, pendingVariant3dModels, pendingVariant3dPreviews, pendingKnownModelGids, pendingGalleryOrder]);

  /** Called by the Image Manager once every settling media node has shown up
   *  in the fetched media map (or the bounded wait gave up). */
  const handleSettlingMediaResolved = useCallback((mediaIds: string[]) => {
    if (mediaIds.length === 0) return;
    const done = new Set(mediaIds);
    setSettlingMedia(prev => {
      const next = prev.filter(e => !done.has(e.mediaId));
      return next.length === prev.length ? prev : next;
    });
  }, []);

  // Beim Produktwechsel: State zurücksetzen
  const resetForProduct = useCallback(() => {
    setBulkItems([]);
    // settlingMedia is deliberately NOT cleared here: this function is also
    // the Discard handler, and settling media is already SAVED — discarding
    // an unrelated text edit must not make a just-uploaded image disappear
    // again, which is the bug this whole mechanism exists to prevent. On a
    // product switch the Image Manager reports the previous product's entries
    // as resolved (they no longer match its productId) and they are dropped
    // there instead.
    setSelectedBulkIds(new Set());
    setActiveAction(null);
    setPendingVariantGalleries([]);
    setPendingMediaOrder([]);
    setPendingProductNewMedia([]);
    setPendingClearVariantMainImages([]);
    setPendingExternalVideos({});
    setPendingVariant3dModels({});
    setPendingVariant3dPreviews({});
    setPendingKnownModelGids({});
    setPendingGalleryOrder({});
    setHasAltTextEdits(false);
    // Clear data derived from the previous product so the bulk panels never match
    // against stale variants/selection during the load window of the new product.
    // missingMainImageProductIds is intentionally NOT reset — it is cross-product
    // sidebar state; clearing it would drop markers for all other products.
    setVariantsForBulk([]);
    setSelectedGalleryGids([]);
    setResetCounter(c => c + 1);
  }, []);

  return {
    bulkItems,
    selectedBulkIds,
    activeAction,
    setActiveAction,
    isApplying,
    activeRightTab,
    setActiveRightTab,
    activeImageSubTab,
    setActiveImageSubTab,
    variantReloadCounter,
    reloadVariants,
    pendingVariantGalleries,
    pendingMediaOrder,
    pendingProductNewMedia,
    settlingMedia,
    handleSettlingMediaResolved,
    pendingClearVariantMainImages,
    resetCounter,
    hasAltTextEdits,
    setHasAltTextEdits,
    variantsForBulk,
    missingMainImageProductIds,
    selectedGalleryGids,
    pendingExternalVideos,
    setPendingExternalVideos,
    pendingVariant3dModels,
    setPendingVariant3dModels,
    pendingVariant3dPreviews,
    setPendingVariant3dPreviews,
    pendingKnownModelGids,
    setPendingKnownModelGids,
    pendingGalleryOrder,
    setPendingGalleryOrder,
    handleVariantsLoaded,
    handleGallerySelectionGidsChange,
    handleMissingMainImageChange,
    handleBulkItemsChange,
    handleBulkSelect,
    handleRemoveBulk,
    handlePendingChange,
    handleApply,
    resetForProduct,
  };
}
