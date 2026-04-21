import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { Text, Button, InlineStack, Spinner, Banner, Divider, Card, BlockStack } from "@shopify/polaris";
import { useFetcher } from "@remix-run/react";
import { DndContext, DragOverlay, closestCenter, pointerWithin, useDroppable, MouseSensor, TouchSensor, useSensor, useSensors, type CollisionDetection, type DragStartEvent, type DragOverEvent, type DragEndEvent } from "@dnd-kit/core";
import { arrayMove } from "@dnd-kit/sortable";
import { useI18n } from "../../contexts/I18nContext";
import { SortableImageGrid } from "./SortableImageGrid";
import { VariantGallerySection } from "./VariantGallerySection";
import type { StagedItem, VariantWithGallery, ImageMeta } from "./types";

// Prefer sortable items (compound id '::') over plain container droppables;
// fall back to closestCenter when pointer is outside all droppables.
const imageManagerCollision: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  if (hits.length === 0) return closestCenter(args);
  const itemHits = hits.filter(({ id }) => (id as string).includes("::"));
  return itemHits.length > 0 ? itemHits : hits;
};

interface ProductImageRef {
  url: string;
  mediaId: string;
  id: string;
  altText?: string | null;
}

interface ImageManagerSettings {
  firstImageBig: boolean;
  showAltTags: boolean;
  autoAltText: boolean;
  thumbSize?: number;
}

interface VariantImageManagerProps {
  productId: string;
  productImages: ProductImageRef[];
  bulkItems: StagedItem[];
  activeAction: "copy" | "move" | null;
  selectedBulkIds: Set<string>;
  onRemoveBulk: (ids: string[]) => void;
  onSetAction: (action: "copy" | "move" | null) => void;
  imageManagerSettings: ImageManagerSettings;
  onPendingChange?: (variantGalleries: Array<{ variantId: string; fileGids: string[] }>, mediaOrder: Array<{ mediaId: string; position: number }>, productNewMedia?: string[]) => void;
  resetKey?: number;
  currentLanguage?: string;
  primaryLocale?: string;
  productTitle?: string;
  enabledLanguages?: string[];
  onDirtyChange?: (isDirty: boolean) => void;
}

export function VariantImageManager({
  productId,
  productImages,
  bulkItems,
  activeAction,
  selectedBulkIds,
  onRemoveBulk,
  onSetAction,
  imageManagerSettings,
  onPendingChange,
  resetKey,
  currentLanguage,
  primaryLocale,
  productTitle,
  enabledLanguages = [],
  onDirtyChange,
}: VariantImageManagerProps) {
  const { t } = useI18n();
  const [variants, setVariants] = useState<VariantWithGallery[]>([]);
  // Authoritative GID→URL map fetched from Shopify product media (not DB cache).
  const [shopifyMediaMap, setShopifyMediaMap] = useState<Record<string, string>>({});
  const [isLoadingVariants, setIsLoadingVariants] = useState(false);
  const [variantError, setVariantError] = useState<string | null>(null);
  const [pendingProductImageOrder, setPendingProductImageOrder] = useState<string[] | null>(null);
  // `${galleryId}::${url}` → sourceVariantId (null = product gallery)
  // Compound keys ensure same image URL selected in gallery A doesn't affect gallery B
  const [selectedGalleryItems, setSelectedGalleryItems] = useState<Map<string, string | null>>(new Map());
  const [pendingVariantGalleries, setPendingVariantGalleries] = useState<Record<string, string[]>>({});
  // Variant IDs whose injected main image was dragged to the product gallery this session
  const [locallyExcludedMainGids, setLocallyExcludedMainGids] = useState<Set<string>>(new Set());
  const [pendingProductNewMedia, setPendingProductNewMedia] = useState<string[]>([]);
  const [webpError, setWebpError] = useState<string | null>(null);
  const [isConvertingWebP, setIsConvertingWebP] = useState(false);
  const [refreshedProductImages, setRefreshedProductImages] = useState<ProductImageRef[] | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{ urls: string[]; affectedVariantCount: number } | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const webpPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const currentImagesRef = useRef<ProductImageRef[]>([]);
  const [isExpanded, setIsExpanded] = useState(false);
  const [showAll, setShowAll] = useState(true);
  const [thumbSize, setThumbSize] = useState(imageManagerSettings.thumbSize ?? 80);
  const thumbSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fetcher = useFetcher();
  // Alt text editing state
  const [localAltTexts, setLocalAltTexts] = useState<Record<string, string>>({});
  const altTextFetcher = useFetcher<any>();          // generate / translate (returns text)
  const saveAltTextFetcher = useFetcher<any>();      // save (writes to Shopify)
  const translationsFetcher = useFetcher<any>();     // load foreign locale alt texts from DB
  const prevAltFetcherData = useRef<any>(null);
  const productGalleryBlurSkipRef = useRef(false);
  const dirtyUrlsRef = useRef(new Set<string>());
  // Track current media order so we can include it whenever variant galleries change
  const pendingMediaOrderRef = useRef<Array<{ mediaId: string; position: number }>>([]);

  // Cross-gallery drag state
  const [activeDragUrl, setActiveDragUrl] = useState<string | null>(null);
  const [activeDragSourceContainer, setActiveDragSourceContainer] = useState<string | null>(null);
  const [isCtrlHeld, setIsCtrlHeld] = useState(false);
  // overContainerId tracked implicitly via autoExpandId
  const isCtrlHeldRef = useRef(false);
  const [autoExpandId, setAutoExpandId] = useState<string | null>(null);
  const autoExpandTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentOverContainerRef = useRef<string | null>(null);
  const sharedSensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
  );
  const { setNodeRef: setProductDropRef } = useDroppable({ id: "product" });

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "Control" || e.key === "Meta") { isCtrlHeldRef.current = true; setIsCtrlHeld(true); }
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === "Control" || e.key === "Meta") { isCtrlHeldRef.current = false; setIsCtrlHeld(false); }
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
  }, []);

  useEffect(() => {
    if (!resetKey) return;
    setPendingVariantGalleries({});
    setPendingProductNewMedia([]);
    setPendingProductImageOrder(null);
    setSelectedGalleryItems(new Map());
    setLocallyExcludedMainGids(new Set());
    pendingMediaOrderRef.current = [];
    dirtyUrlsRef.current.clear();
    onDirtyChange?.(false);
  }, [resetKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load foreign-locale alt text translations from DB when language changes
  useEffect(() => {
    setLocalAltTexts({});
    if (!productId || !currentLanguage || currentLanguage === primaryLocale) return;
    const form = new FormData();
    form.append("action", "loadImageAltTranslations");
    form.append("productId", productId);
    form.append("locale", currentLanguage);
    translationsFetcher.submit(form, { method: "post" });
  }, [currentLanguage, productId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Apply loaded translations to localAltTexts (mediaId → url → altText)
  useEffect(() => {
    const data = translationsFetcher.data;
    if (!data || data.actionType !== "loadImageAltTranslations") return;
    const altTexts: Record<string, string> = data.altTexts ?? {};
    setLocalAltTexts(prev => {
      const next = { ...prev };
      for (const [mediaId, altText] of Object.entries(altTexts)) {
        const url = fileUrlMap[mediaId];
        if (url) next[url] = altText as string;
      }
      return next;
    });
  }, [translationsFetcher.data]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!productId) return;
    setIsLoadingVariants(true);
    setVariantError(null);
    setPendingVariantGalleries({});
    setSelectedGalleryItems(new Map());

    fetch(`/api/product-variants?productId=${encodeURIComponent(productId)}`)
      .then(r => r.json())
      .then(({ variants: raw, mediaMap, error }) => {
        if (error) { setVariantError(error); return; }
        if (mediaMap) setShopifyMediaMap(mediaMap);
        const mapped: VariantWithGallery[] = (raw ?? []).map((v: any) => ({
          id: v.shopifyGid ?? v.id,
          title: v.title,
          sku: v.sku,
          position: v.position,
          galleryFileGids: (() => {
            try { return JSON.parse(v.galleryJson || "[]"); } catch { return []; }
          })(),
          defaultImageUrl: v.image?.url ?? undefined,
        }));
        // Filter out Shopify's synthetic default variant (only variant, titled "Default Title")
        const realVariants = mapped.length === 1 && mapped[0].title === "Default Title"
          ? []
          : mapped;
        setVariants(realVariants.sort((a, b) => a.position - b.position));

        // Auto-detect variants whose metafield wrongly contains the main image GID.
        // Queue them for cleanup so the user only needs to click Save to fix existing bad data.
        if (mediaMap) {
          const urlToGidFromMedia: Record<string, string> = {};
          for (const [gid, url] of Object.entries(mediaMap as Record<string, string>)) {
            urlToGidFromMedia[url] = gid;
          }
          const autoFixes: Record<string, string[]> = {};
          for (const v of realVariants) {
            if (!v.defaultImageUrl || v.galleryFileGids.length === 0) continue;
            const mainGid =
              urlToGidFromMedia[v.defaultImageUrl] ??
              Object.entries(urlToGidFromMedia).find(([u]) =>
                u.split("?")[0] === v.defaultImageUrl!.split("?")[0]
              )?.[1];
            if (mainGid && v.galleryFileGids.includes(mainGid)) {
              autoFixes[v.id] = v.galleryFileGids.filter(g => g !== mainGid);
            }
          }
          if (Object.keys(autoFixes).length > 0) {
            setPendingVariantGalleries(autoFixes);
          }
        }
      })
      .catch(() => setVariantError(t.imageManager.variantsLoadError))
      .finally(() => setIsLoadingVariants(false));
  }, [productId]);

  // Sync pendingVariantGalleries to parent whenever it changes.
  // Always prepend the variant's native main image GID at position 0 so the backend can set
  // mediaId correctly and exclude it from the gallery metafield (prevents main image duplication).
  useEffect(() => {
    if (Object.keys(pendingVariantGalleries).length === 0) return;
    const galleries = Object.entries(pendingVariantGalleries).map(([variantId, fileGids]) => {
      const variant = variants.find(v => v.id === variantId);
      const mainGid = variant?.defaultImageUrl
        ? (urlToGid[variant.defaultImageUrl] ??
           Object.entries(urlToGid).find(([u]) =>
             u.split("?")[0] === variant.defaultImageUrl!.split("?")[0]
           )?.[1])
        : undefined;
      const fullGids = mainGid
        ? [mainGid, ...fileGids.filter(g => g !== mainGid)]
        : fileGids;
      return { variantId, fileGids: fullGids };
    });
    onPendingChange?.(galleries, pendingMediaOrderRef.current, pendingProductNewMedia);
  }, [pendingVariantGalleries, pendingProductNewMedia]); // eslint-disable-line react-hooks/exhaustive-deps

  const webpActiveCountRef = useRef<number | null>(null);

  const startWebPPolling = useCallback((pid: string) => {
    if (webpPollRef.current) clearInterval(webpPollRef.current);
    webpActiveCountRef.current = null;
    webpPollRef.current = setInterval(async () => {
      try {
        const r = await fetch(`/api/running-field-tasks?resourceId=${encodeURIComponent(pid)}`);
        const { tasks } = await r.json();
        const webpTasks = (tasks ?? []).filter((t: { type: string }) => t.type === "imageWebpConversion");
        const count = webpTasks.length;
        const prev = webpActiveCountRef.current;

        // Fetch fresh image URLs whenever a task completes (count decreased) or all are done.
        // This updates each image's badge as soon as its individual conversion finishes.
        if (prev === null || count < prev) {
          try {
            const imgR = await fetch(`/api/product-images?productId=${encodeURIComponent(pid)}`);
            const imgData = await imgR.json();
            if (imgData.success && Array.isArray(imgData.images)) {
              const newImages: ProductImageRef[] = imgData.images.map((img: any) => ({
                url: img.url ?? "",
                mediaId: img.mediaId ?? img.url ?? "",
                id: img.mediaId ?? img.url ?? "",
                altText: img.altText ?? null,
              }));

              // Build URL and GID remaps by matching positions (processor preserves order).
              // Needed so pendingProductImageOrder and pendingVariantGalleries stay valid
              // after old PNG media is deleted and replaced by new WebP media.
              const oldImages = currentImagesRef.current;
              const urlRemap: Record<string, string> = {};
              const gidRemap: Record<string, string> = {};
              oldImages.forEach((old, i) => {
                const next = newImages[i];
                if (next && old.mediaId && next.mediaId && old.mediaId !== next.mediaId) {
                  urlRemap[old.url] = next.url;
                  gidRemap[old.mediaId] = next.mediaId;
                }
              });
              if (Object.keys(urlRemap).length > 0) {
                setPendingProductImageOrder(curr =>
                  curr ? curr.map(url => urlRemap[url] ?? url) : null
                );
                setPendingVariantGalleries(curr => {
                  const next: Record<string, string[]> = {};
                  for (const [variantId, gids] of Object.entries(curr)) {
                    next[variantId] = gids.map(gid => gidRemap[gid] ?? gid);
                  }
                  return next;
                });
              }

              setRefreshedProductImages(newImages);
            }
          } catch {
            // non-critical: badge will update on next page load
          }
        }

        webpActiveCountRef.current = count;

        if (count === 0) {
          clearInterval(webpPollRef.current!);
          webpPollRef.current = null;
          webpActiveCountRef.current = null;
          localStorage.removeItem(`webp_${pid}`);
          setIsConvertingWebP(false);
        }
      } catch {
        // keep polling on transient errors
      }
    }, 3000);
  }, []);

  // Resume polling on mount/product-switch; reset spinner if no active conversion for this product
  useEffect(() => {
    setRefreshedProductImages(null);
    if (!productId) return;
    const converting = localStorage.getItem(`webp_${productId}`);
    if (converting) {
      setIsConvertingWebP(true);
      startWebPPolling(productId);
    } else {
      setIsConvertingWebP(false);
    }
    return () => {
      if (webpPollRef.current) clearInterval(webpPollRef.current);
    };
  }, [productId, startWebPPolling]);

  // After WebP conversion completes, use the refreshed Shopify URLs (with .webp extension)
  // so badges update immediately without a page reload. Falls back to the prop otherwise.
  const effectiveProductImages = refreshedProductImages ?? productImages;
  currentImagesRef.current = effectiveProductImages;

  // GID → URL map: DB-cached productImages merged with the authoritative Shopify media map.
  // shopifyMediaMap is fetched fresh from Shopify on every product load, so gallery images
  // always resolve even when the DB cache is stale or incomplete.
  const fileUrlMap: Record<string, string> = useMemo(() => ({
    ...Object.fromEntries(
      effectiveProductImages.filter(img => img.mediaId).map(img => [img.mediaId, img.url])
    ),
    ...shopifyMediaMap,
  }), [effectiveProductImages, shopifyMediaMap]);

  const urlToGid: Record<string, string> = useMemo(() => ({
    ...Object.fromEntries(effectiveProductImages.filter(img => img.mediaId).map(img => [img.url, img.mediaId])),
    ...Object.fromEntries(Object.entries(shopifyMediaMap).map(([gid, url]) => [url, gid])),
  }), [effectiveProductImages, shopifyMediaMap]);

  // Image metadata map (by URL)
  const imageMetas: Record<string, ImageMeta> = useMemo(() => {
    const map: Record<string, ImageMeta> = {};
    for (const img of effectiveProductImages) {
      map[img.url] = { altText: img.altText };
    }
    return map;
  }, [effectiveProductImages]);

  // All GIDs currently assigned to any variant gallery (including injected main images)
  const assignedGids = useMemo(() => {
    const gids = new Set<string>();
    for (const v of variants) {
      const storedGids = pendingVariantGalleries[v.id] ?? v.galleryFileGids;
      storedGids.forEach(gid => gids.add(gid));
      if (v.defaultImageUrl && !locallyExcludedMainGids.has(v.id)) {
        const mainGid = urlToGid[v.defaultImageUrl] ??
          Object.entries(urlToGid).find(([u]) =>
            u.split("?")[0] === v.defaultImageUrl!.split("?")[0]
          )?.[1];
        if (mainGid) gids.add(mainGid);
      }
    }
    return gids;
  }, [variants, pendingVariantGalleries, urlToGid, locallyExcludedMainGids]);

  // Product image URLs to display (all or only unassigned)
  const displayedProductUrls = useMemo(() => {
    const order = pendingProductImageOrder ?? effectiveProductImages.map(i => i.url);
    if (showAll || variants.length === 0) return order;
    return order.filter(url => {
      const gid = urlToGid[url];
      return !gid || !assignedGids.has(gid);
    });
  }, [showAll, pendingProductImageOrder, effectiveProductImages, urlToGid, assignedGids, variants.length]);

  // Per-gallery selected URL sets — same URL in different galleries is independent
  const selectedUrlsByGallery = useMemo(() => {
    const map = new Map<string, Set<string>>();
    map.set("product", new Set());
    for (const v of variants) map.set(v.id, new Set());
    for (const [key] of selectedGalleryItems) {
      const sep = key.indexOf("::");
      if (sep === -1) continue;
      const galleryId = key.slice(0, sep);
      const url = key.slice(sep + 2);
      const s = map.get(galleryId);
      if (s) s.add(url);
    }
    return map;
  }, [selectedGalleryItems, variants]);

  const makeSelectHandler = useCallback((sourceVariantId: string | null) =>
    (url: string, sel: boolean) => {
      const galleryId = sourceVariantId ?? "product";
      const key = `${galleryId}::${url}`;
      setSelectedGalleryItems(m => {
        const next = new Map(m);
        if (sel) next.set(key, sourceVariantId);
        else next.delete(key);
        return next;
      });
    }, []);

  const handleVariantReorder = useCallback((variantId: string, newGids: string[]) => {
    setPendingVariantGalleries(p => ({ ...p, [variantId]: newGids }));
  }, []);

  const handleProductReorder = useCallback((newUrls: string[]) => {
    setPendingProductImageOrder(newUrls);
    const mediaOrder = newUrls
      .map((url, idx) => {
        const img = effectiveProductImages.find(i => i.url === url);
        return img?.mediaId ? { mediaId: img.mediaId, position: idx } : null;
      })
      .filter(Boolean) as Array<{ mediaId: string; position: number }>;

    pendingMediaOrderRef.current = mediaOrder;
    const galleries = Object.entries(pendingVariantGalleries).map(([variantId, fileGids]) => ({
      variantId, fileGids,
    }));
    onPendingChange?.(galleries, mediaOrder, pendingProductNewMedia);
  }, [effectiveProductImages, pendingVariantGalleries, pendingProductNewMedia, onPendingChange]);

  const handleSharedDragStart = useCallback((event: DragStartEvent) => {
    const url = event.active.data.current?.url as string | undefined;
    const containerId = event.active.data.current?.containerId as string | undefined;
    setActiveDragUrl(url ?? null);
    setActiveDragSourceContainer(containerId ?? null);
  }, []);

  const handleSharedDragOver = useCallback((event: DragOverEvent) => {
    const { over } = event;
    if (!over) {
      if (autoExpandTimerRef.current) { clearTimeout(autoExpandTimerRef.current); autoExpandTimerRef.current = null; }
      currentOverContainerRef.current = null;
      return;
    }
    const overStr = over.id as string;
    const containerId = overStr.includes("::") ? overStr.split("::")[0] : overStr;

    // Start auto-expand timer when entering a new variant container (ref prevents redundant resets)
    if (containerId !== "product" && containerId !== currentOverContainerRef.current) {
      currentOverContainerRef.current = containerId;
      if (autoExpandTimerRef.current) clearTimeout(autoExpandTimerRef.current);
      autoExpandTimerRef.current = setTimeout(() => setAutoExpandId(containerId), 700);
    }
  }, []);

  const handleSharedDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    setActiveDragUrl(null);
    setActiveDragSourceContainer(null);
    setAutoExpandId(null);
    currentOverContainerRef.current = null;
    if (autoExpandTimerRef.current) { clearTimeout(autoExpandTimerRef.current); autoExpandTimerRef.current = null; }
    if (!over) return;

    const sourceContainerId = active.data.current?.containerId as string | undefined;
    const url = active.data.current?.url as string | undefined;
    if (!sourceContainerId || !url) return;

    const overStr = over.id as string;
    const sepIdx = overStr.indexOf("::");
    const targetContainerId = sepIdx !== -1 ? overStr.slice(0, sepIdx) : overStr;
    const overUrl = sepIdx !== -1 ? overStr.slice(sepIdx + 2) : null;

    if (sourceContainerId === targetContainerId) {
      // Same gallery — reorder (only when dropping on a sibling item, not on the container itself)
      if (!overUrl || url === overUrl) return;
      if (sourceContainerId === "product") {
        const urls = pendingProductImageOrder ?? effectiveProductImages.map(i => i.url);
        const oldIndex = urls.indexOf(url);
        const newIndex = urls.indexOf(overUrl);
        if (oldIndex !== -1 && newIndex !== -1 && oldIndex !== newIndex) {
          handleProductReorder(arrayMove(urls, oldIndex, newIndex));
        }
      } else {
        const variant = variants.find(v => v.id === sourceContainerId);
        const gids = pendingVariantGalleries[sourceContainerId] ?? variant?.galleryFileGids ?? [];
        const variantUrls = gids.map(gid => fileUrlMap[gid]).filter(Boolean) as string[];
        const oldIndex = variantUrls.indexOf(url);
        const newIndex = variantUrls.indexOf(overUrl);
        if (oldIndex !== -1 && newIndex !== -1 && oldIndex !== newIndex) {
          handleVariantReorder(
            sourceContainerId,
            arrayMove(variantUrls, oldIndex, newIndex).map(u => urlToGid[u] ?? u),
          );
        }
      }
      return;
    }

    // Variant → product gallery: remove from variant (no copy)
    // Must be checked before urlToGid lookup — image may not be in urlToGid if resolved via shopifyMediaMap only.
    if (targetContainerId === "product") {
      if (sourceContainerId === "product") return;
      const sourceVariant = variants.find(v => v.id === sourceContainerId);
      const sourceCurrent = pendingVariantGalleries[sourceContainerId] ?? sourceVariant?.galleryFileGids ?? [];
      const gidToRemove = sourceCurrent.find(g => fileUrlMap[g] === url);
      if (!gidToRemove) {
        // The dragged image is the injected main image (not stored in the metafield).
        // Mark it as locally excluded so it disappears from the variant gallery this session.
        const mainGid = sourceVariant?.defaultImageUrl
          ? (urlToGid[sourceVariant.defaultImageUrl] ??
             Object.entries(urlToGid).find(([u]) =>
               u.split("?")[0] === sourceVariant.defaultImageUrl!.split("?")[0]
             )?.[1])
          : undefined;
        if (mainGid && fileUrlMap[mainGid] === url) {
          setLocallyExcludedMainGids(prev => new Set([...prev, sourceContainerId]));
        }
        return;
      }
      setPendingVariantGalleries(p => ({
        ...p,
        [sourceContainerId]: sourceCurrent.filter(g => g !== gidToRemove),
      }));
      return;
    }

    const gid = urlToGid[url];
    if (!gid) return;

    if (sourceContainerId !== "product") {
      if (isCtrlHeldRef.current) {
        // Variant → Variant + Ctrl: copy (keep in source)
        setPendingVariantGalleries(p => {
          const targetVariant = variants.find(v => v.id === targetContainerId);
          const existing = p[targetContainerId] ?? targetVariant?.galleryFileGids ?? [];
          if (existing.includes(gid)) return p;
          return { ...p, [targetContainerId]: [...existing, gid] };
        });
      } else {
        // Variant → Variant: move (remove from source, add to target) in single update
        setPendingVariantGalleries(p => {
          const targetVariant = variants.find(v => v.id === targetContainerId);
          const sourceVariant = variants.find(v => v.id === sourceContainerId);
          const targetExisting = p[targetContainerId] ?? targetVariant?.galleryFileGids ?? [];
          const sourceCurrent = p[sourceContainerId] ?? sourceVariant?.galleryFileGids ?? [];
          const result = { ...p };
          if (!targetExisting.includes(gid)) result[targetContainerId] = [...targetExisting, gid];
          result[sourceContainerId] = sourceCurrent.filter(g => g !== gid);
          return result;
        });
      }
    } else {
      // Product → Variant: copy (keep in product gallery)
      setPendingVariantGalleries(p => {
        const targetVariant = variants.find(v => v.id === targetContainerId);
        const existing = p[targetContainerId] ?? targetVariant?.galleryFileGids ?? [];
        if (existing.includes(gid)) return p;
        return { ...p, [targetContainerId]: [...existing, gid] };
      });
    }
  }, [pendingProductImageOrder, effectiveProductImages, variants, pendingVariantGalleries, fileUrlMap, urlToGid, handleProductReorder, handleVariantReorder]); // eslint-disable-line react-hooks/exhaustive-deps

  // prepend=true → image lands at position 0 (main image slot, triggered by placeholder click)
  // prepend=false → image appended to end of gallery
  const handleDropToVariant = useCallback((targetVariantId: string, prepend = false) => {
    const bulkGids = bulkItems
      .filter(i => selectedBulkIds.has(i.uniqueId) && i.status === "ready")
      .map(i => i.resourceUrl);

    const galleryGids = [...new Set(
      [...selectedGalleryItems.keys()]
        .map(key => { const sep = key.indexOf("::"); return urlToGid[sep !== -1 ? key.slice(sep + 2) : key]; })
        .filter(Boolean) as string[]
    )];

    const newGids = [...bulkGids, ...galleryGids];
    if (newGids.length === 0) return;

    setPendingVariantGalleries(p => {
      const existing = p[targetVariantId] ??
        variants.find(v => v.id === targetVariantId)?.galleryFileGids ?? [];
      const merged = prepend ? [...newGids, ...existing] : [...existing, ...newGids];
      return { ...p, [targetVariantId]: merged };
    });

    if (activeAction === "move") {
      if (selectedBulkIds.size > 0) onRemoveBulk([...selectedBulkIds]);

      const bySource = new Map<string, string[]>();
      for (const [key, sourceId] of selectedGalleryItems.entries()) {
        if (sourceId === null) continue;
        const sep = key.indexOf("::");
        const url = sep !== -1 ? key.slice(sep + 2) : key;
        const gid = urlToGid[url];
        if (!gid) continue;
        if (!bySource.has(sourceId)) bySource.set(sourceId, []);
        bySource.get(sourceId)!.push(url);
      }
      for (const [srcVariantId, urls] of bySource.entries()) {
        if (srcVariantId === targetVariantId) continue;
        setPendingVariantGalleries(p => {
          const srcVariant = variants.find(v => v.id === srcVariantId);
          const current = p[srcVariantId] ?? srcVariant?.galleryFileGids ?? [];
          const urlSet = new Set(urls);
          return { ...p, [srcVariantId]: current.filter(gid => !urlSet.has(fileUrlMap[gid] ?? "")) };
        });
      }
      // Move ends the action and clears selection
      onSetAction(null);
      setSelectedGalleryItems(new Map());
    }
    // Copy: keep action mode + selection active so user can copy to multiple variants
  }, [bulkItems, selectedBulkIds, selectedGalleryItems, activeAction, variants, urlToGid, fileUrlMap, onRemoveBulk, onSetAction]);

  const handleRemoveFromGallery = useCallback((variantId: string, urls: string[]) => {
    const urlSet = new Set(urls);
    setPendingVariantGalleries(p => {
      const variant = variants.find(v => v.id === variantId);
      const current = p[variantId] ?? variant?.galleryFileGids ?? [];
      return { ...p, [variantId]: current.filter(gid => !urlSet.has(fileUrlMap[gid] ?? "")) };
    });
    setSelectedGalleryItems(m => {
      const next = new Map(m);
      urls.forEach(u => next.delete(`${variantId}::${u}`));
      return next;
    });
  }, [variants, fileUrlMap]);

  const productSelectedUrls = useMemo(() => {
    const urls: string[] = [];
    for (const [key, sourceVariantId] of selectedGalleryItems) {
      if (sourceVariantId === null && key.startsWith("product::")) {
        urls.push(key.slice("product::".length));
      }
    }
    return urls;
  }, [selectedGalleryItems]);

  const handleConfirmDelete = useCallback(async () => {
    if (!deleteConfirm) return;
    const { urls } = deleteConfirm;
    const gids = urls.map(url => urlToGid[url]).filter(Boolean) as string[];
    const urlSet = new Set(urls);
    const gidSet = new Set(gids);

    setIsDeleting(true);
    setDeleteConfirm(null);

    // Optimistically remove from local state
    setPendingVariantGalleries(p => {
      const next = { ...p };
      for (const v of variants) {
        const current = p[v.id] ?? v.galleryFileGids;
        const filtered = current.filter(gid => !gidSet.has(gid));
        if (filtered.length !== current.length) next[v.id] = filtered;
      }
      return next;
    });
    setPendingProductImageOrder(curr => {
      const base = curr ?? effectiveProductImages.map(i => i.url);
      return base.filter(url => !urlSet.has(url));
    });
    setRefreshedProductImages(effectiveProductImages.filter(img => !urlSet.has(img.url)));
    setSelectedGalleryItems(m => {
      const next = new Map(m);
      urls.forEach(url => next.delete(`product::${url}`));
      return next;
    });

    try {
      await fetch("/api/delete-product-images", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId, mediaIds: gids }),
      });
    } catch {
      // non-critical: local state already reflects deletion
    }
    setIsDeleting(false);
  }, [deleteConfirm, urlToGid, variants, effectiveProductImages, productId]);

  const handleGenerateAltFromSku = useCallback((variantId: string) => {
    const variant = variants.find(v => v.id === variantId);
    const gids = pendingVariantGalleries[variantId] ?? variant?.galleryFileGids ?? [];
    if (!gids.length) return;

    const form = new FormData();
    form.append("action", "generateAltTextFromSku");
    form.append("productId", productId);
    gids.forEach(gid => form.append("mediaId", gid));
    fetcher.submit(form, { method: "post" });
  }, [variants, pendingVariantGalleries, productId, fetcher]);

  const handleConvertToWebP = useCallback(async (images: ProductImageRef[]) => {
    setWebpError(null);
    if (images.length === 0) return;

    const effectiveOrder = pendingProductImageOrder ?? productImages.map(p => p.url);

    try {
      const res = await fetch("/api/convert-webp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productId,
          productTitle,
          images: images.map(i => ({
            mediaId: i.mediaId,
            url: i.url,
            productImageId: i.id,
            altText: i.altText ?? null,
            position: effectiveOrder.indexOf(i.url),
          })),
        }),
      });
      if (!res.ok) throw new Error();
      localStorage.setItem(`webp_${productId}`, "1");
      setIsConvertingWebP(true);
      startWebPPolling(productId);
    } catch {
      setWebpError(t.imageManager.webpConvertError);
    }
  }, [productId, productTitle, startWebPPolling, pendingProductImageOrder, productImages]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleUploadToVariant = useCallback(async (variantId: string, files: File[]) => {
    for (const file of files) {
      try {
        const res = await fetch("/api/staged-upload", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filename: file.name, mimeType: file.type, fileSize: file.size }),
        });
        const { url, resourceUrl, error } = await res.json();
        if (error || !url) continue;

        await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.onload = () => resolve();
          xhr.onerror = () => reject();
          xhr.open("PUT", url);
          xhr.setRequestHeader("Content-Type", file.type);
          xhr.send(file);
        });

        if (resourceUrl) {
          setPendingVariantGalleries(p => {
            const variant = variants.find(v => v.id === variantId);
            const current = p[variantId] ?? variant?.galleryFileGids ?? [];
            return { ...p, [variantId]: [...current, resourceUrl] };
          });
        }
      } catch {
        // silent — user can retry
      }
    }
  }, [variants]);

  const handleUploadToProductGallery = useCallback(async (files: File[]) => {
    for (const file of files) {
      try {
        const res = await fetch("/api/staged-upload", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filename: file.name, mimeType: file.type, fileSize: file.size }),
        });
        const { url, resourceUrl, error } = await res.json();
        if (error || !url) continue;

        await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.onload = () => resolve();
          xhr.onerror = () => reject();
          xhr.open("PUT", url);
          xhr.setRequestHeader("Content-Type", file.type);
          xhr.send(file);
        });

        if (resourceUrl) {
          setPendingProductNewMedia(p => [...p, resourceUrl]);
        }
      } catch {
        // silent — user can retry
      }
    }
  }, []);

  // Watch altTextFetcher for AI generate / translate results → auto-save result
  useEffect(() => {
    const data = altTextFetcher.data;
    if (!data || data === prevAltFetcherData.current) return;
    prevAltFetcherData.current = data;
    const idx = data.imageIndex as number | undefined;
    const url = idx !== undefined ? effectiveProductImages[idx]?.url : undefined;
    if (url) {
      if (data.actionType === "generateAltText" && data.altText !== undefined) {
        setLocalAltTexts(p => ({ ...p, [url]: data.altText }));
        // Auto-save the generated result immediately
        const mediaId = urlToGid[url];
        if (mediaId) {
          const form = new FormData();
          form.append("action", "saveImageAltText");
          form.append("mediaId", mediaId);
          form.append("altText", data.altText);
          if (currentLanguage) form.append("locale", currentLanguage);
          if (primaryLocale) form.append("primaryLocale", primaryLocale);
          saveAltTextFetcher.submit(form, { method: "post" });
        }
      }
      if (data.actionType === "translateAltText" && data.translatedAltText !== undefined) {
        setLocalAltTexts(p => ({ ...p, [url]: data.translatedAltText }));
        // Auto-save the translated result immediately
        const mediaId = urlToGid[url];
        if (mediaId) {
          const form = new FormData();
          form.append("action", "saveImageAltText");
          form.append("mediaId", mediaId);
          form.append("altText", data.translatedAltText);
          if (currentLanguage) form.append("locale", currentLanguage);
          if (primaryLocale) form.append("primaryLocale", primaryLocale);
          saveAltTextFetcher.submit(form, { method: "post" });
        }
      }
    }
  }, [altTextFetcher.data, effectiveProductImages]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleAltTextChange = useCallback((url: string, value: string) => {
    setLocalAltTexts(p => ({ ...p, [url]: value }));
    if (!dirtyUrlsRef.current.has(url)) {
      dirtyUrlsRef.current.add(url);
      if (dirtyUrlsRef.current.size === 1) onDirtyChange?.(true);
    }
  }, [onDirtyChange]);

  const handleSaveAltText = useCallback((url: string, altText: string) => {
    const mediaId = urlToGid[url];
    if (!mediaId) return;
    const form = new FormData();
    form.append("action", "saveImageAltText");
    form.append("mediaId", mediaId);
    form.append("altText", altText);
    if (currentLanguage) form.append("locale", currentLanguage);
    if (primaryLocale) form.append("primaryLocale", primaryLocale);
    saveAltTextFetcher.submit(form, { method: "post" });
    dirtyUrlsRef.current.delete(url);
    if (dirtyUrlsRef.current.size === 0) onDirtyChange?.(false);
  }, [urlToGid, currentLanguage, primaryLocale, saveAltTextFetcher, onDirtyChange]);

  const handleGenerateAltTextForImage = useCallback((url: string) => {
    const imageIndex = effectiveProductImages.findIndex(i => i.url === url);
    const form = new FormData();
    form.append("action", "generateAltText");
    form.append("itemId", productId);
    form.append("productId", productId);
    form.append("imageIndex", String(Math.max(0, imageIndex)));
    form.append("imageUrl", url);
    form.append("productTitle", productTitle ?? "");
    form.append("mainLanguage", primaryLocale ?? "en");
    altTextFetcher.submit(form, { method: "post" });
  }, [productId, effectiveProductImages, productTitle, primaryLocale, altTextFetcher]);

  const handleTranslateAltTextForImage = useCallback((url: string, sourceAltText: string) => {
    const imageIndex = effectiveProductImages.findIndex(i => i.url === url);
    if (!currentLanguage) return;
    const form = new FormData();
    form.append("action", "translateAltText");
    form.append("itemId", productId);
    form.append("productId", productId);
    form.append("imageIndex", String(Math.max(0, imageIndex)));
    form.append("sourceAltText", sourceAltText);
    form.append("targetLocale", currentLanguage);
    altTextFetcher.submit(form, { method: "post" });
  }, [productId, effectiveProductImages, currentLanguage, altTextFetcher]);

  const handleTranslateAltTextToAllLocales = useCallback((url: string, sourceAltText: string) => {
    const imageIndex = effectiveProductImages.findIndex(i => i.url === url);
    const targetLocales = enabledLanguages.filter(l => l !== primaryLocale);
    if (targetLocales.length === 0) return;
    const form = new FormData();
    form.append("action", "translateAltTextToAllLocales");
    form.append("itemId", productId);
    form.append("productId", productId);
    form.append("imageIndex", String(Math.max(0, imageIndex)));
    form.append("sourceAltText", sourceAltText);
    form.append("targetLocales", JSON.stringify(targetLocales));
    form.append("productTitle", productTitle ?? "");
    if (primaryLocale) form.append("primaryLocale", primaryLocale);
    altTextFetcher.submit(form, { method: "post" });
  }, [productId, effectiveProductImages, enabledLanguages, primaryLocale, altTextFetcher]);

  const hasAnySelection = selectedBulkIds.size > 0 || selectedGalleryItems.size > 0;

  const isPrimaryLocale = !currentLanguage || currentLanguage === primaryLocale;

  // Single selected URL in product gallery (for inline alt text editor)
  const productSelectedUrls = selectedUrlsByGallery.get("product") ?? new Set<string>();
  const noneOrAllSelected = productSelectedUrls.size === 0 || productSelectedUrls.size >= displayedProductUrls.length;
  const imagesToConvert = effectiveProductImages.filter(i =>
    !i.url.toLowerCase().includes(".webp") &&
    !i.url.toLowerCase().includes("format=webp") &&
    (noneOrAllSelected ? displayedProductUrls.includes(i.url) : productSelectedUrls.has(i.url))
  );

  const productSingleSelected = productSelectedUrls.size === 1 ? [...productSelectedUrls][0] : null;
  const productCurrentAltText = productSingleSelected
    ? (isPrimaryLocale
      ? (localAltTexts[productSingleSelected] ?? imageMetas[productSingleSelected]?.altText ?? "")
      : (localAltTexts[productSingleSelected] ?? ""))
    : "";
  const productPrimaryAltText = productSingleSelected ? (imageMetas[productSingleSelected]?.altText ?? "") : "";
  const productHasTranslation = productSingleSelected
    ? (localAltTexts[productSingleSelected] !== undefined && localAltTexts[productSingleSelected] !== "")
    : false;

  return (
    <DndContext
      sensors={sharedSensors}
      collisionDetection={imageManagerCollision}
      onDragStart={handleSharedDragStart}
      onDragOver={handleSharedDragOver}
      onDragEnd={handleSharedDragEnd}
    >
    <Card padding="400">
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="h3" variant="headingSm">{t.imageManager.title}</Text>
          <Button
            size="slim"
            variant="plain"
            onClick={() => setIsExpanded(e => !e)}
          >
            {isExpanded ? t.imageManager.collapse : t.imageManager.expand}
          </Button>
        </InlineStack>

        <div style={{
          maxHeight: isExpanded ? "none" : 480,
          overflowY: isExpanded ? "visible" : "auto",
          overflowX: "hidden",
          paddingRight: isExpanded ? 0 : 4,
        }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {webpError && (
        <Banner tone="critical" onDismiss={() => setWebpError(null)}>
          <p>{webpError}</p>
        </Banner>
      )}

      {/* Produktbilder allgemein */}
      <div>
        <InlineStack align="space-between" blockAlign="center">
        <InlineStack gap="200" blockAlign="center">
          <Text as="h3" variant="headingSm">{t.imageManager.productPhotos}</Text>
          {!isLoadingVariants && variants.length > 0 ? (
            <InlineStack gap="0" blockAlign="center">
              {(["all", "unassigned"] as const).map((mode, i) => {
                const label = mode === "all" ? t.imageManager.all : t.imageManager.unassigned;
                const active = mode === "all" ? showAll : !showAll;
                return (
                  <span key={mode}>
                    {i > 0 && <span style={{ color: "#8c9196", padding: "0 4px" }}>·</span>}
                    <button
                      onClick={() => setShowAll(mode === "all")}
                      style={{
                        background: "none",
                        border: "none",
                        padding: "0 2px",
                        cursor: "pointer",
                        fontSize: 13,
                        fontWeight: active ? 700 : 400,
                        color: active ? "#202223" : "#6d7175",
                        borderBottom: active ? "2px solid #202223" : "2px solid transparent",
                        lineHeight: "20px",
                      }}
                    >
                      {label}
                    </button>
                  </span>
                );
              })}
            </InlineStack>
          ) : (
            <Text as="span" variant="headingSm" tone="subdued">{t.imageManager.general}</Text>
          )}
        </InlineStack>
        <InlineStack gap="400" blockAlign="center">
          {(imagesToConvert.length > 0 || isConvertingWebP) && (
            <InlineStack gap="200" blockAlign="center">
              <Button size="slim" onClick={() => handleConvertToWebP(imagesToConvert)} disabled={isConvertingWebP}>
                {isConvertingWebP
                  ? t.imageManager.webpConverting
                  : t.imageManager.webpConvertButton.replace("{count}", String(imagesToConvert.length))}
              </Button>
              {isConvertingWebP && <Spinner size="small" />}
            </InlineStack>
          )}
          <input
            type="range"
            min={80}
            max={200}
            step={10}
            value={thumbSize}
            onChange={(e) => {
              const val = Number(e.target.value);
              setThumbSize(val);
              if (thumbSaveTimer.current) clearTimeout(thumbSaveTimer.current);
              thumbSaveTimer.current = setTimeout(() => {
                fetch("/api/image-manager-settings", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ thumbSize: val }),
                }).catch(() => {});
              }, 600);
            }}
            style={{ width: 80, cursor: "pointer", accentColor: "#005bd3" }}
            aria-label={t.imageManager.thumbSizeLabel}
          />
        </InlineStack>
        </InlineStack>
        <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 6 }}>
          <input
            type="checkbox"
            checked={displayedProductUrls.length > 0 && displayedProductUrls.every(url => (selectedUrlsByGallery.get("product") ?? new Set()).has(url))}
            disabled={displayedProductUrls.length === 0}
            onChange={(e) => {
              const handler = makeSelectHandler(null);
              displayedProductUrls.forEach(url => handler(url, e.target.checked));
            }}
            style={{ width: 15, height: 15, cursor: "pointer", accentColor: "#005bd3" }}
            aria-label={t.imageManager.selectAllProductImagesLabel}
          />
          <Text as="span" variant="bodySm" tone="subdued">{t.imageManager.selectAll}</Text>
        </div>
        <div style={{ marginTop: 8 }} ref={setProductDropRef}>
          <SortableImageGrid
            containerId="product"
            imageUrls={displayedProductUrls}
            imageMetas={imageMetas}
            onReorder={handleProductReorder}
            onSelect={makeSelectHandler(null)}
            selectedUrls={selectedUrlsByGallery.get("product") ?? new Set()}
            isDropTarget={activeAction !== null || (activeDragSourceContainer !== null && activeDragSourceContainer !== "product")}
            thumbSize={thumbSize}
            skipDndContext
            onUploadToGallery={handleUploadToProductGallery}
          />
        </div>

        {/* Selection info bar for product gallery */}
        {selectedGalleryItems.size > 0 && (
          <div style={{ marginTop: 6, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <Text as="span" variant="bodySm" tone="subdued">
              {t.imageManager.selectedCount.replace("{count}", String(selectedGalleryItems.size))}
            </Text>
            <Button
              size="slim"
              variant={activeAction === "copy" ? "primary" : "secondary"}
              onClick={() => onSetAction(activeAction === "copy" ? null : "copy")}
            >
              {activeAction === "copy" ? t.imageManager.copyActive : t.imageManager.copy}
            </Button>
            <Button
              size="slim"
              variant={activeAction === "move" ? "primary" : "secondary"}
              onClick={() => onSetAction(activeAction === "move" ? null : "move")}
            >
              {activeAction === "move" ? t.imageManager.moveActive : t.imageManager.move}
            </Button>
            {productSelectedUrls.length > 0 && (
              <Button
                size="slim"
                tone="critical"
                variant="secondary"
                disabled={isDeleting}
                onClick={() => {
                  const gidSet = new Set(productSelectedUrls.map(url => urlToGid[url]).filter(Boolean));
                  const affectedVariantCount = variants.filter(v => {
                    const gids = pendingVariantGalleries[v.id] ?? v.galleryFileGids;
                    return gids.some(gid => gidSet.has(gid));
                  }).length;
                  setDeleteConfirm({ urls: productSelectedUrls, affectedVariantCount });
                }}
              >
                {t.imageManager.deleteImage}
              </Button>
            )}
            <Button
              size="slim"
              variant="plain"
              onClick={() => { setSelectedGalleryItems(new Map()); onSetAction(null); }}
            >
              {t.imageManager.clearSelection}
            </Button>
          </div>
        )}

        {deleteConfirm && (
          <div style={{
            marginTop: 8,
            padding: "10px 12px",
            background: "#fff4e4",
            border: "1px solid #e6a817",
            borderRadius: 6,
          }}>
            <Text as="p" variant="bodyMd" fontWeight="semibold">
              {t.imageManager.deleteConfirmTitle.replace("{count}", String(deleteConfirm.urls.length))}
            </Text>
            <div style={{ marginTop: 4 }}>
              <Text as="p" variant="bodySm">
                {t.imageManager.deleteConfirmBody}
              </Text>
            </div>
            {deleteConfirm.affectedVariantCount > 0 && (
              <div style={{ marginTop: 6, color: "#b44b00" }}>
                <Text as="p" variant="bodySm">
                  {t.imageManager.deleteConfirmWithGalleries
                    .replace("{count}", String(deleteConfirm.urls.length))
                    .replace("{galleries}", String(deleteConfirm.affectedVariantCount))}
                </Text>
              </div>
            )}
            <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
              <Button size="slim" tone="critical" loading={isDeleting} onClick={handleConfirmDelete}>
                {t.imageManager.deleteConfirmBtn}
              </Button>
              <Button size="slim" disabled={isDeleting} onClick={() => setDeleteConfirm(null)}>
                {t.common.cancel}
              </Button>
            </div>
          </div>
        )}

        {/* Alt text editor for product gallery — only when exactly 1 image is selected */}
        {productSingleSelected && (
          <div style={{
            marginTop: 10,
            padding: "10px 12px",
            background: !isPrimaryLocale && !productHasTranslation ? "#fff8f0" : "#f6f6f7",
            borderRadius: 6,
            border: `1px solid ${!isPrimaryLocale && !productHasTranslation ? "#e6a817" : "#e1e3e5"}`,
          }}>
            <div style={{ marginBottom: 6 }}>
              <Text as="span" variant="bodySm" tone="subdued">
                {t.imageManager.altTextForSelected}
              </Text>
            </div>
            <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
              <input
                type="text"
                value={productCurrentAltText}
                onChange={(e) => handleAltTextChange(productSingleSelected, e.target.value)}
                placeholder={isPrimaryLocale ? t.imageManager.altTextPlaceholder : (productPrimaryAltText || t.imageManager.altTextPlaceholder)}
                style={{
                  flex: "1 1 200px",
                  minWidth: 180,
                  padding: "5px 8px",
                  fontSize: 13,
                  border: "1px solid #c9cccf",
                  borderRadius: 4,
                  outline: "none",
                  background: !isPrimaryLocale && !productHasTranslation ? "#fff8f0" : "white",
                }}
                onFocus={(e) => { e.target.style.borderColor = "#005bd3"; e.target.style.background = "white"; }}
                onBlur={(e) => {
                  e.target.style.borderColor = "#c9cccf";
                  e.target.style.background = !isPrimaryLocale && !productHasTranslation ? "#fff8f0" : "white";
                  if (productGalleryBlurSkipRef.current) {
                    productGalleryBlurSkipRef.current = false;
                    return;
                  }
                  handleSaveAltText(productSingleSelected, e.target.value);
                }}
              />
              <div style={{ display: "flex", gap: 4, flexShrink: 0, flexWrap: "wrap" }}>
                {isPrimaryLocale && (
                  <div onMouseDown={() => { productGalleryBlurSkipRef.current = true; }}>
                    <Button
                      size="slim"
                      disabled={altTextFetcher.state !== "idle"}
                      loading={altTextFetcher.state !== "idle"}
                      onClick={() => handleGenerateAltTextForImage(productSingleSelected)}
                    >
                      {`✨ ${t.imageManager.aiGenerate}`}
                    </Button>
                  </div>
                )}
                {isPrimaryLocale && enabledLanguages.filter(l => l !== primaryLocale).length > 0 && (
                  <div onMouseDown={() => { productGalleryBlurSkipRef.current = true; }}>
                    <Button
                      size="slim"
                      disabled={altTextFetcher.state !== "idle"}
                      loading={altTextFetcher.state !== "idle"}
                      onClick={() => handleTranslateAltTextToAllLocales(productSingleSelected, productCurrentAltText)}
                    >
                      {`🌍 ${t.imageManager.translateAltAll}`}
                    </Button>
                  </div>
                )}
                {!isPrimaryLocale && (
                  <div onMouseDown={() => { productGalleryBlurSkipRef.current = true; }}>
                    <Button
                      size="slim"
                      disabled={altTextFetcher.state !== "idle"}
                      loading={altTextFetcher.state !== "idle"}
                      onClick={() => handleTranslateAltTextForImage(productSingleSelected, productCurrentAltText)}
                    >
                      {`🌍 ${t.imageManager.translateAlt}`}
                    </Button>
                  </div>
                )}
              </div>
            </div>
            {!isPrimaryLocale && productPrimaryAltText && (
              <div style={{ marginTop: 6, fontSize: 12, color: "#6d7175" }}>
                <span style={{ fontWeight: 600 }}>{t.imageManager.primaryRef}: </span>
                {productPrimaryAltText}
              </div>
            )}
          </div>
        )}
      </div>

      <Divider />

      {/* Varianten-Galerien */}
      <div>
        <InlineStack align="space-between" blockAlign="center">
          <Text as="h3" variant="headingSm">{t.imageManager.variantGalleries}</Text>
          {hasAnySelection && activeAction && (
            <Text as="span" variant="bodySm" tone="subdued">
              {activeAction === "copy" ? t.imageManager.copyHint : t.imageManager.moveHint}
            </Text>
          )}
        </InlineStack>

        <div style={{ marginTop: 8 }}>
          {isLoadingVariants ? (
            <div style={{ padding: 16, display: "flex", justifyContent: "center" }}>
              <Spinner size="small" />
            </div>
          ) : variantError ? (
            <Banner tone="warning"><p>{variantError}</p></Banner>
          ) : variants.length === 0 ? (
            <Text as="p" tone="subdued">{t.imageManager.noVariants}</Text>
          ) : (
            variants.map(v => {
              const storedGids = pendingVariantGalleries[v.id] ?? v.galleryFileGids;
              const mainGid = v.defaultImageUrl
                ? (urlToGid[v.defaultImageUrl] ??
                   Object.entries(urlToGid).find(([u]) =>
                     u.split("?")[0] === v.defaultImageUrl!.split("?")[0]
                   )?.[1])
                : undefined;
              // Always strip mainGid from the gallery portion and re-inject once at position 0.
              // This prevents duplicate React keys when mainGid was wrongly saved into the
              // metafield (which would cause React to silently drop the second occurrence).
              // Skip injection when the user dragged the main image to the product gallery this session.
              const galleryGids = mainGid ? storedGids.filter(g => g !== mainGid) : storedGids;
              const effectiveGids = mainGid && !locallyExcludedMainGids.has(v.id)
                ? [mainGid, ...galleryGids]
                : galleryGids;
              return (
              <VariantGallerySection
                key={v.id}
                variant={{
                  ...v,
                  galleryFileGids: effectiveGids,
                }}
                fileUrlMap={fileUrlMap}
                imageMetas={imageMetas}
                activeAction={hasAnySelection ? activeAction : null}
                selectedUrls={selectedUrlsByGallery.get(v.id) ?? new Set()}
                onSelect={makeSelectHandler(v.id)}
                onReorder={handleVariantReorder}
                onDrop={handleDropToVariant}
                onRemoveFromGallery={handleRemoveFromGallery}
                onGenerateAltFromSku={handleGenerateAltFromSku}
                onUploadToGallery={handleUploadToVariant}
                thumbSize={thumbSize}
                localAltTexts={localAltTexts}
                isAltTextLoading={altTextFetcher.state !== "idle"}
                onAltTextChange={handleAltTextChange}
                onSaveAltText={handleSaveAltText}
                onGenerateAltText={handleGenerateAltTextForImage}
                onTranslateAltText={handleTranslateAltTextForImage}
                onTranslateAltToAllLocales={handleTranslateAltTextToAllLocales}
                enabledLanguages={enabledLanguages}
                currentLanguage={currentLanguage}
                primaryLocale={primaryLocale}
                skipDndContext
                forceOpen={autoExpandId === v.id}
              />
              );
            })
          )}
        </div>
      </div>

        </div>
        </div>
      </BlockStack>
    </Card>
    <DragOverlay>
      {activeDragUrl ? (
        <div style={{ position: "relative", display: "inline-block" }}>
          <img
            src={activeDragUrl}
            alt=""
            style={{
              width: thumbSize,
              height: thumbSize,
              objectFit: "cover",
              borderRadius: 6,
              opacity: 0.9,
              boxShadow: "0 4px 16px rgba(0,0,0,0.3)",
              pointerEvents: "none",
              display: "block",
            }}
          />
          {isCtrlHeld && (
            <div style={{
              position: "absolute",
              top: -10,
              right: -10,
              width: 36,
              height: 36,
              borderRadius: "50%",
              background: "#008060",
              color: "white",
              fontSize: 22,
              fontWeight: 700,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              lineHeight: 1,
              boxShadow: "0 2px 6px rgba(0,0,0,0.35)",
            }}>+</div>
          )}
        </div>
      ) : null}
    </DragOverlay>
    </DndContext>
  );
}
