/**
 * Image management for the Unified Content Editor.
 * Handles on-demand image loading from Shopify API as a fallback when DB has no images.
 * Also merges loaded images into the selected item and clones image alt-texts for mutation.
 */

import { useState, useEffect, useRef, useMemo } from "react";
import { useBackgroundJson } from "./useBackgroundJson";
import type { ContentImage, AltTextTranslation, ContentEditorConfig, TranslatableContentItem } from "../types/content-editor.types";

interface UseEditorImageManagementProps {
  config: ContentEditorConfig;
  selectedItemId: string | null;
  baseSelectedItem: TranslatableContentItem | undefined;
}

interface UseEditorImageManagementReturn {
  selectedItem: TranslatableContentItem | undefined;
  onDemandImages: ContentImage[];
  isLoadingImages: boolean;
  prevSelectedItemIdRef: React.MutableRefObject<string | null>;
}

export function useEditorImageManagement({
  config,
  selectedItemId,
  baseSelectedItem,
}: UseEditorImageManagementProps): UseEditorImageManagementReturn {
  const [onDemandImages, setOnDemandImages] = useState<ContentImage[]>([]);
  const [isLoadingImages, setIsLoadingImages] = useState(false);
  const imageFetcher = useBackgroundJson<{ success: boolean; images: Array<{ url: string; altText?: string }>; error?: string }>();
  const loadedImagesForProductRef = useRef<string | null>(null);
  const prevSelectedItemIdRef = useRef<string | null>(null);

  // Hybrid image loading + image cloning:
  // - If images exist in DB -> clone for alt-text mutations
  // - If no images in DB -> merge on-demand images from Shopify API
  //
  // Items are READ-ONLY — only image alt-texts are mutated in-place, so only images need cloning.
  const selectedItem = useMemo(() => {
    if (!baseSelectedItem) return undefined;

    const hasDbImages = baseSelectedItem.images && baseSelectedItem.images.length > 0;

    if (hasDbImages) {
      return {
        ...baseSelectedItem,
        images: baseSelectedItem.images!.map((img: ContentImage) => ({
          ...img,
          altTextTranslations: img.altTextTranslations
            ? img.altTextTranslations.map((t: AltTextTranslation) => ({ ...t }))
            : [],
        })),
      };
    }

    if (
      onDemandImages.length > 0 &&
      loadedImagesForProductRef.current === selectedItemId
    ) {
      return { ...baseSelectedItem, images: onDemandImages };
    }

    return baseSelectedItem;
  }, [baseSelectedItem, onDemandImages, selectedItemId]);

  // Trigger on-demand image loading only if DB has no images
  useEffect(() => {
    if (config.contentType !== 'products') return;

    // Detect product change - clear on-demand state
    if (prevSelectedItemIdRef.current !== selectedItemId) {
      setOnDemandImages([]);
      loadedImagesForProductRef.current = null;
      prevSelectedItemIdRef.current = selectedItemId;
    }

    if (!selectedItemId || !baseSelectedItem) {
      setIsLoadingImages(false);
      return;
    }

    // Skip if DB already has images. A read still out for the PREVIOUS product
    // is ignored when it lands (url guard below), so its spinner ends here.
    const hasDbImages = baseSelectedItem.images && baseSelectedItem.images.length > 0;
    if (hasDbImages) {
      setIsLoadingImages(false);
      return;
    }

    // Skip if already loaded for this product
    if (loadedImagesForProductRef.current === selectedItemId) return;

    setIsLoadingImages(true);
    imageFetcher.load(`/api/product-images?productId=${encodeURIComponent(selectedItemId)}`);
  }, [selectedItemId, baseSelectedItem, config.contentType]); // eslint-disable-line react-hooks/exhaustive-deps

  // Handle on-demand image fetcher response
  useEffect(() => {
    // A failed read (rate limit, network) is settled like an error answer: no
    // spinner, no retry storm, and never an error page.
    if (imageFetcher.state === "idle" && (imageFetcher.data || imageFetcher.failed) && selectedItemId) {
      // The snapshot must be the answer for THIS product. In the commit of a
      // product switch this effect still sees the previous product's idle
      // snapshot; taking it would show A's images (or A's failure) on B and
      // switch B's spinner off.
      if (imageFetcher.url !== `/api/product-images?productId=${encodeURIComponent(selectedItemId)}`) return;
      setIsLoadingImages(false);

      if (prevSelectedItemIdRef.current !== selectedItemId) return;

      if (imageFetcher.failed || !imageFetcher.data) {
        // Nothing to show for this product: never the previous one's images.
        setOnDemandImages([]);
        loadedImagesForProductRef.current = selectedItemId;
      } else if (imageFetcher.data.success && imageFetcher.data.images) {
        const images: ContentImage[] = imageFetcher.data.images.map((img) => ({
          url: img.url,
          altText: img.altText,
          altTextTranslations: [],
        }));
        setOnDemandImages(images);
        loadedImagesForProductRef.current = selectedItemId;
      } else if (imageFetcher.data.error) {
        loadedImagesForProductRef.current = selectedItemId;
      }
    }
  }, [imageFetcher.state, imageFetcher.data, imageFetcher.failed, imageFetcher.url, selectedItemId]);

  return { selectedItem, onDemandImages, isLoadingImages, prevSelectedItemIdRef };
}
