import { useState, useCallback } from "react";
import type { StagedItem, VariantWithGallery } from "../components/image-manager/types";

export interface VariantGalleryUpdate {
  variantId: string;
  fileGids: string[];
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
  const [pendingVariantGalleries, setPendingVariantGalleries] = useState<VariantGalleryUpdate[]>([]);
  const [pendingMediaOrder, setPendingMediaOrder] = useState<MediaOrderUpdate[]>([]);
  const [pendingProductNewMedia, setPendingProductNewMedia] = useState<string[]>([]);
  const [pendingClearVariantMainImages, setPendingClearVariantMainImages] = useState<string[]>([]);
  const [resetCounter, setResetCounter] = useState(0);
  const [hasAltTextEdits, setHasAltTextEdits] = useState(false);
  // Variants exposed to BulkImageUploadPanel for auto-assignment
  const [variantsForBulk, setVariantsForBulk] = useState<VariantWithGallery[]>([]);
  const [missingMainImageProductIds, setMissingMainImageProductIds] = useState<Set<string>>(new Set());

  const handleVariantsLoaded = useCallback((variants: VariantWithGallery[]) => {
    setVariantsForBulk(variants);
  }, []);

  const handleMissingMainImageChange = useCallback((productId: string, hasMissing: boolean) => {
    setMissingMainImageProductIds(prev => {
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
    (galleries: VariantGalleryUpdate[], mediaOrder: MediaOrderUpdate[], productNewMedia?: string[], clearVariantMainImages?: string[]) => {
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
        ...readyItems.map(i => ({ resourceUrl: i.resourceUrl })),
        ...pendingProductNewMedia.map(r => ({ resourceUrl: r })),
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
        if (existing) {
          existing.fileGids = [...existing.fileGids, ...newUrls];
        } else {
          // Preserve existing main image at position 0; append new images after gallery.
          const fileGids = mainGid
            ? [mainGid, ...galleryGids, ...newUrls]
            : [...galleryGids, ...newUrls];
          mergedVariantGalleries.push({ variantId, fileGids });
        }
      }

      const res = await fetch("/api/update-variant-galleries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productId,
          newMedia: allNewMedia,
          variantGalleries: mergedVariantGalleries,
          mediaOrder: pendingMediaOrder,
          clearVariantMainImages: pendingClearVariantMainImages,
        }),
      });
      const data = await res.json();
      if (!data.success) {
        return (data.errors as string[]).join(", ");
      }
      setBulkItems([]);
      setSelectedBulkIds(new Set());
      setPendingVariantGalleries([]);
      setPendingMediaOrder([]);
      setPendingProductNewMedia([]);
      setPendingClearVariantMainImages([]);
      setHasAltTextEdits(false);
      setResetCounter(c => c + 1);
      return null;
    } finally {
      setIsApplying(false);
    }
  }, [bulkItems, pendingVariantGalleries, pendingMediaOrder, pendingProductNewMedia, pendingClearVariantMainImages]);

  // Beim Produktwechsel: State zurücksetzen
  const resetForProduct = useCallback(() => {
    setBulkItems([]);
    setSelectedBulkIds(new Set());
    setActiveAction(null);
    setPendingVariantGalleries([]);
    setPendingMediaOrder([]);
    setPendingProductNewMedia([]);
    setPendingClearVariantMainImages([]);
    setHasAltTextEdits(false);
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
    pendingVariantGalleries,
    pendingMediaOrder,
    pendingProductNewMedia,
    resetCounter,
    hasAltTextEdits,
    setHasAltTextEdits,
    variantsForBulk,
    missingMainImageProductIds,
    handleVariantsLoaded,
    handleMissingMainImageChange,
    handleBulkItemsChange,
    handleBulkSelect,
    handleRemoveBulk,
    handlePendingChange,
    handleApply,
    resetForProduct,
  };
}
