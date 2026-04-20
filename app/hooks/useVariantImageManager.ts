import { useState, useCallback } from "react";
import type { StagedItem } from "../components/image-manager/types";

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
    (galleries: VariantGalleryUpdate[], mediaOrder: MediaOrderUpdate[]) => {
      setPendingVariantGalleries(galleries);
      setPendingMediaOrder(mediaOrder);
    },
    []
  );

  const handleApply = useCallback(async (productId: string) => {
    setIsApplying(true);
    try {
      const readyItems = bulkItems.filter(i => i.status === "ready");
      await fetch("/api/update-variant-galleries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productId,
          newMedia: readyItems.map(i => ({ resourceUrl: i.resourceUrl })),
          variantGalleries: pendingVariantGalleries,
          mediaOrder: pendingMediaOrder,
        }),
      });
      // Bulk Items leeren nach erfolgreichem Apply
      setBulkItems([]);
      setSelectedBulkIds(new Set());
      setPendingVariantGalleries([]);
      setPendingMediaOrder([]);
    } finally {
      setIsApplying(false);
    }
  }, [bulkItems, pendingVariantGalleries, pendingMediaOrder]);

  // Beim Produktwechsel: State zurücksetzen
  const resetForProduct = useCallback(() => {
    setBulkItems([]);
    setSelectedBulkIds(new Set());
    setActiveAction(null);
    setPendingVariantGalleries([]);
    setPendingMediaOrder([]);
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
    handleBulkItemsChange,
    handleBulkSelect,
    handleRemoveBulk,
    handlePendingChange,
    handleApply,
    resetForProduct,
  };
}
