import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { Text, Button, InlineStack, Spinner, Banner, Divider, Card, BlockStack } from "@shopify/polaris";
import { useFetcher } from "@remix-run/react";
import { DndContext, DragOverlay, closestCenter, pointerWithin, useDroppable, MouseSensor, TouchSensor, useSensor, useSensors, type CollisionDetection, type DragStartEvent, type DragOverEvent, type DragEndEvent } from "@dnd-kit/core";
import { arrayMove } from "@dnd-kit/sortable";
import { useI18n } from "../../contexts/I18nContext";
import { PULSE_SYNC_EPOCH } from "../../utils/contentEditor.utils";
import { TIMING } from "../../constants/timing";
import { SortableImageGrid } from "./SortableImageGrid";
import { VariantGallerySection } from "./VariantGallerySection";
import { FilePickerModal, type AddedItem } from "./FilePickerModal";
import type { StagedItem, VariantWithGallery, ImageMeta, MediaKind } from "./types";
import { parseExternalVideoUrl, classifyFile } from "../../utils/mediaKind";

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
  onPendingChange?: (variantGalleries: Array<{ variantId: string; fileGids: string[] }>, mediaOrder: Array<{ mediaId: string; position: number }>, productNewMedia?: Array<{ resourceUrl: string; kind: MediaKind; previewUrl?: string }>, clearVariantMainImages?: string[]) => void;
  /** Notified whenever the merchant adds / removes a YouTube or Vimeo URL on
   *  any variant. The shape mirrors the /api/update-variant-galleries body
   *  field so the hook can pass it straight through. */
  onExternalVideosChange?: (variantExternalVideos: Record<string, string[]>) => void;
  /** Notified whenever the merchant adds / removes a 3D model URL on any
   *  variant. Mirrors onExternalVideosChange exactly — variant_3d_models is
   *  also a list.url metafield. */
  onThreeDModelsChange?: (variant3dModels: Record<string, string[]>) => void;
  /** Parallel to onThreeDModelsChange — fires whenever the per-variant
   *  preview-URL list changes (add / remove / index alignment after a
   *  model drop). Same lockstep index contract as the metafield write:
   *  preview[i] is the JPEG snapshot for model[i]. */
  onThreeDPreviewsChange?: (variant3dPreviews: Record<string, string[]>) => void;
  /** Carry-over from a "processing" drop on a prior save. The hook owns
   *  this map (it's its own pendingVariant3dModels state); we pass it in
   *  so the resetKey effect can re-seed our local state with the still-
   *  processing staging URLs after a Save instead of clearing them and
   *  letting the merchant's next mutation wipe the hook's carry-over via
   *  onThreeDModelsChange. */
  seedThreeDModelUrls?: Record<string, string[]>;
  /** Parallel carry-over for the preview URLs of still-processing models.
   *  Same lockstep index contract as seedThreeDModelUrls. */
  seedThreeDPreviewUrls?: Record<string, string[]>;
  /** Notified whenever the combined file+URL+model order changes on any
   *  variant (drag-reorder of a mixed gallery). The value is variantId →
   *  stringified JSON array of { kind: "file" | "url" | "model", value },
   *  ready to be persisted to custom.variant_gallery_order. */
  onGalleryOrderChange?: (variantGalleryOrder: Record<string, string>) => void;
  onVariantsLoaded?: (variants: VariantWithGallery[]) => void;
  resetKey?: number;
  variantReloadKey?: number;
  currentLanguage?: string;
  primaryLocale?: string;
  productTitle?: string;
  enabledLanguages?: string[];
  onDirtyChange?: (isDirty: boolean) => void;
  onMissingMainImageChange?: (hasMissing: boolean) => void;
  onProductImagesRefreshed?: (productId: string, images: ProductImageRef[]) => void;
  onGallerySelectionGidsChange?: (gids: string[]) => void;
}

function mapApiImagesToRefs(images: any[]): ProductImageRef[] {
  return images.map((img: any) => ({
    url: img.url ?? "",
    mediaId: img.mediaId ?? img.url ?? "",
    id: img.mediaId ?? img.url ?? "",
    altText: img.altText ?? null,
  }));
}

/** Quick optimistic-preview helper for YouTube URLs — used for the tile
 *  that flashes into the gallery the moment a merchant pastes a link.
 *  Vimeo has no public thumbnail-from-id endpoint without an oEmbed call
 *  we don't want to make from the admin; returns empty so the tile falls
 *  back to the host-name placeholder. */
function youtubeThumbForUrl(url: string): string | undefined {
  const m =
    url.match(/[?&]v=([A-Za-z0-9_-]{11})/) ||
    url.match(/youtu\.be\/([A-Za-z0-9_-]{11})/) ||
    url.match(/youtube\.com\/(?:embed|shorts)\/([A-Za-z0-9_-]{11})/);
  return m ? `https://img.youtube.com/vi/${m[1]}/hqdefault.jpg` : undefined;
}

function insertGidAtPosition(gids: string[], gid: string, overUrl: string | null, fileUrlMap: Record<string, string>): string[] {
  if (!overUrl) return [...gids, gid];
  const overIdx = gids.findIndex(g => fileUrlMap[g] === overUrl);
  if (overIdx === -1) return [...gids, gid];
  const result = [...gids];
  result.splice(overIdx, 0, gid);
  return result;
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
  onVariantsLoaded,
  resetKey,
  variantReloadKey,
  currentLanguage,
  primaryLocale,
  productTitle,
  enabledLanguages = [],
  onDirtyChange,
  onMissingMainImageChange,
  onProductImagesRefreshed,
  onGallerySelectionGidsChange,
  onExternalVideosChange,
  onThreeDModelsChange,
  onThreeDPreviewsChange,
  seedThreeDModelUrls,
  seedThreeDPreviewUrls,
  onGalleryOrderChange,
}: VariantImageManagerProps) {
  const { t } = useI18n();
  const [variants, setVariants] = useState<VariantWithGallery[]>([]);
  // Per-variant overrides for external video URLs. Empty entries are kept
  // (they mean "merchant explicitly cleared this variant's videos") so
  // resetting an array to [] still gets persisted on save.
  const [pendingExternalVideos, setPendingExternalVideos] = useState<Record<string, string[]>>({});
  // Per-variant overrides for 3D model (.glb) URLs. Same contract as
  // pendingExternalVideos — both live in list.url metafields.
  const [pendingVariant3dModels, setPendingVariant3dModels] = useState<Record<string, string[]>>({});
  // Parallel preview URLs — index N in pendingVariant3dPreviews[v] is the
  // JPEG snapshot for index N in pendingVariant3dModels[v]. add / remove
  // handlers keep both arrays in lockstep so the server can write
  // variant_3d_previews aligned with variant_3d_models.
  const [pendingVariant3dPreviews, setPendingVariant3dPreviews] = useState<Record<string, string[]>>({});
  const [pendingGalleryOrder, setPendingGalleryOrder] = useState<Record<string, string>>({});
  const pendingGalleryOrderRef = useRef<Record<string, string>>({});
  useEffect(() => { pendingGalleryOrderRef.current = pendingGalleryOrder; }, [pendingGalleryOrder]);
  // Add-media modal state. `pickerTarget` discriminates between "add to
  // variant X" (each upload commits immediately, can include external URLs)
  // and "add to product gallery" (uploads queue, external URLs are hidden
  // because they have no product-global slot).
  const [pickerTarget, setPickerTarget] = useState<{ mode: "variant"; variantId: string } | { mode: "product" } | null>(null);
  // Authoritative GID→URL map fetched from Shopify product media (not DB cache).
  const [shopifyMediaMap, setShopifyMediaMap] = useState<Record<string, string>>({});
  // Richer GID→{kind, previewUrl} map for the same product media. Drives the
  // SortableImageGrid tile dispatch (play icon for video, "3D" badge for
  // model) so the admin gallery mirrors the storefront's visual language.
  // Carries `kind: "external_video"` for ExternalVideo entries from
  // product.media — variant-scoped YouTube/Vimeo URLs live elsewhere and
  // are merged in further down.
  const [mediaMetaMap, setMediaMetaMap] = useState<Record<string, { kind: MediaKind; previewUrl: string }>>({});
  const [isLoadingVariants, setIsLoadingVariants] = useState(false);
  const [variantError, setVariantError] = useState<string | null>(null);
  const [pendingProductImageOrder, setPendingProductImageOrder] = useState<string[] | null>(null);
  // `${galleryId}::${url}` → sourceVariantId (null = product gallery)
  // Compound keys ensure same image URL selected in gallery A doesn't affect gallery B
  const [selectedGalleryItems, setSelectedGalleryItems] = useState<Map<string, string | null>>(new Map());
  const [pendingVariantGalleries, setPendingVariantGalleries] = useState<Record<string, string[]>>({});
  // Variant IDs whose injected main image was dragged to the product gallery this session
  const [locallyExcludedMainGids, setLocallyExcludedMainGids] = useState<Set<string>>(new Set());
  const [pendingProductNewMedia, setPendingProductNewMedia] = useState<Array<{ resourceUrl: string; kind: MediaKind; previewUrl?: string }>>([]);
  const [webpError, setWebpError] = useState<string | null>(null);
  const [isConvertingWebP, setIsConvertingWebP] = useState(false);
  // GIDs (mediaId) of images currently being converted; cleared when done.
  // Tracked by GID rather than URL because Shopify CDN URLs can change query params between
  // task creation and a fresh image fetch, causing URL-based lookups to miss still-running images.
  const [convertingImageUrls, setConvertingImageUrls] = useState<Set<string>>(new Set());
  const [refreshedProductImages, setRefreshedProductImages] = useState<ProductImageRef[] | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{ urls: string[]; affectedVariantCount: number } | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const webpPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const currentImagesRef = useRef<ProductImageRef[]>([]);
  const isConvertingWebPRef = useRef(false);
  const prevConvertingGidsRef = useRef<Set<string>>(new Set());
  const prevProductImagesKeyRef = useRef<string>("");
  const stagedUrlCheckedProductIdRef = useRef<string | null>(null);
  const onProductImagesRefreshedRef = useRef(onProductImagesRefreshed);
  useEffect(() => { onProductImagesRefreshedRef.current = onProductImagesRefreshed; }, [onProductImagesRefreshed]);
  const [isExpanded, setIsExpanded] = useState(false);
  const [isProductGalleryExpanded, setIsProductGalleryExpanded] = useState(false);
  const [productGalleryHasOverflow, setProductGalleryHasOverflow] = useState(false);
  const productGalleryInnerRef = useRef<HTMLDivElement | null>(null);
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
  // Monotonic token guarding against out-of-order /api/product-variants responses:
  // a fast product switch can leave an earlier request in flight that resolves AFTER
  // the newer one, overwriting the current product's variants with stale data.
  // Residual (cosmetic, accepted): `variants` is not synchronously emptied on a
  // product switch, so the previous product's galleries may flash for one render
  // until the new fetch resolves. The bulk auto-assign path is NOT affected
  // (parent-hook variantsForBulk is reset in useVariantImageManager.resetForProduct).
  // A key={productId} remount was deliberately rejected (redundant reconcile
  // calls on every product re-visit).
  const variantsReqIdRef = useRef(0);

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
    // Critical: the per-variant external-video URLs and the combined
    // gallery-order JSON also have to be cleared on Cancel / product switch,
    // otherwise a URL the merchant typed for product A but never saved would
    // ride along to product B's save payload and end up on the wrong variant.
    setPendingExternalVideos({});
    // Re-seed with the hook's carry-over (still-processing staging URLs
    // from a prior save) rather than clearing outright. Falls back to {}
    // when there's nothing to carry over — same effective behaviour as
    // before for non-3D and non-processing flows.
    setPendingVariant3dModels(seedThreeDModelUrls ?? {});
    setPendingVariant3dPreviews(seedThreeDPreviewUrls ?? {});
    setPendingGalleryOrder({});
    pendingGalleryOrderRef.current = {};
    pendingMediaOrderRef.current = [];
    dirtyUrlsRef.current.clear();
    onDirtyChange?.(false);
  }, [resetKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reload variant data (e.g. after alt text templates are applied) without clearing pending state
  useEffect(() => {
    if (!variantReloadKey || !productId) return;
    console.log("[fetchVariantsForProduct] triggered by variantReloadKey", { variantReloadKey });
    fetchVariantsForProduct(productId, false);
  }, [variantReloadKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load foreign-locale alt text translations from DB when language changes
  // or after a bulk apply (variantReloadKey bump) so freshly saved translations show up.
  useEffect(() => {
    setLocalAltTexts({});
    if (!productId || !currentLanguage || currentLanguage === primaryLocale) return;
    const form = new FormData();
    form.append("action", "loadImageAltTranslations");
    form.append("productId", productId);
    form.append("locale", currentLanguage);
    translationsFetcher.submit(form, { method: "post" });
  }, [currentLanguage, productId, variantReloadKey]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // Extracted so it can be called both on product selection (full reset) and on image reload
  // (variants-only refresh, no pending-state reset). The resetState flag controls whether
  // pending galleries / selection / exclusions are cleared before fetching.
  const fetchVariantsForProduct = useCallback((pid: string, resetState: boolean) => {
    const reqId = ++variantsReqIdRef.current;
    const isStale = () => variantsReqIdRef.current !== reqId;
    setIsLoadingVariants(true);
    setVariantError(null);
    if (resetState) {
      setPendingVariantGalleries({});
      setSelectedGalleryItems(new Map());
      setLocallyExcludedMainGids(new Set());
    }

    fetch(`/api/product-variants?productId=${encodeURIComponent(pid)}`)
      .then(r => r.json())
      .then(({ variants: raw, mediaMap, mediaMetaMap: mmm, error }) => {
        // A newer product was selected while this request was in flight — drop the
        // result so it can't overwrite the current product's variants/galleries.
        if (isStale()) return;
        if (error) { setVariantError(error); return; }
        if (mediaMap) {
          console.log("[fetchVariantsForProduct] setShopifyMediaMap", { mediaMapSize: Object.keys(mediaMap as Record<string, string>).length });
          setShopifyMediaMap(mediaMap);
        }
        if (mmm) setMediaMetaMap(mmm);
        // Re-derive refreshedProductImages from the fresh Shopify media so the
        // product-gallery section (which renders from effectiveProductImages =
        // refreshedProductImages ?? productImages) reflects newly created
        // MediaImage entries after a save. Previously a save triggered a
        // variant refetch that updated shopifyMediaMap but did NOT propagate
        // into effectiveProductImages, so the just-uploaded image vanished
        // from the in-app product gallery until a full page reload synced
        // the loader's productImages prop with Shopify. We merge into the
        // existing refreshed/prop list so any altText / id that the loader
        // already populated stays intact for entries that survive, and drop
        // entries that no longer exist in Shopify.
        if (mediaMap && mmm) {
          const existingByMediaId = new Map(
            (refreshedProductImages ?? productImages).map(img => [img.mediaId, img])
          );
          const fresh: ProductImageRef[] = [];
          for (const [gid, url] of Object.entries(mediaMap as Record<string, string>)) {
            if ((mmm as Record<string, { kind?: string }>)[gid]?.kind !== "image") continue;
            const existing = existingByMediaId.get(gid);
            fresh.push(existing
              ? { ...existing, url }
              : { url, mediaId: gid, id: gid, altText: null });
          }
          setRefreshedProductImages(fresh);
        }
        // Build URL→GID reverse map to resolve each variant's main image GID
        const urlToGidMap: Record<string, string> = {};
        if (mediaMap) {
          for (const [gid, url] of Object.entries(mediaMap as Record<string, string>)) {
            urlToGidMap[url.split("?")[0]] = gid;
          }
        }
        const mapped: VariantWithGallery[] = (raw ?? []).map((v: any) => ({
          id: v.shopifyGid ?? v.id,
          title: v.title,
          sku: v.sku,
          imageKey: v.imageKey ?? null,
          position: v.position,
          galleryFileGids: (() => {
            try { return JSON.parse(v.galleryJson || "[]"); } catch { return []; }
          })(),
          // YouTube / Vimeo URLs from custom.variant_external_videos. Stored
          // as a JSON-stringified array on the metafield — we tolerate
          // malformed values (returns []) so a hand-edit in the Shopify
          // admin can't crash the Image Manager.
          externalVideoUrls: (() => {
            try {
              const parsed = JSON.parse(v.externalVideosJson || "[]");
              return Array.isArray(parsed) ? parsed.filter((s: unknown) => typeof s === "string") : [];
            } catch { return []; }
          })(),
          // GLB CDN URLs from custom.variant_3d_models. Same tolerant-parse
          // contract as externalVideoUrls — a corrupt metafield must never
          // crash the Image Manager.
          threeDModelUrls: (() => {
            try {
              const parsed = JSON.parse(v.threeDModelsJson || "[]");
              return Array.isArray(parsed) ? parsed.filter((s: unknown) => typeof s === "string") : [];
            } catch { return []; }
          })(),
          galleryOrderJson: v.galleryOrderJson ?? null,
          mainImageGid: v.image?.url ? urlToGidMap[v.image.url.split("?")[0]] : undefined,
          defaultImageUrl: v.image?.url ?? undefined,
          selectedOptions: v.selectedOptions ?? [],
        }));
        // Filter out Shopify's synthetic default variant (only variant, titled "Default Title")
        const realVariants = mapped.length === 1 && mapped[0].title === "Default Title"
          ? []
          : mapped;
        const sortedVariants = realVariants.sort((a, b) => a.position - b.position);
        setVariants(sortedVariants);
        onVariantsLoaded?.(sortedVariants);

        // Auto-detect variants whose metafield wrongly contains the main image GID.
        // Queue them for cleanup so the user only needs to click Save to fix existing bad data.
        if (resetState && mediaMap) {
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
      .catch(() => { if (!isStale()) setVariantError(t.imageManager.variantsLoadError); })
      .finally(() => { if (!isStale()) setIsLoadingVariants(false); });
  }, [t.imageManager.variantsLoadError, onVariantsLoaded]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!productId) return;
    fetchVariantsForProduct(productId, true);
  }, [productId, resetKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync pendingVariantGalleries and locallyExcludedMainGids to parent whenever either changes.
  // For normal variants: prepend the native main image GID at position 0 so the backend sets mediaId
  // correctly and excludes it from the gallery metafield (prevents main image duplication).
  // For excluded variants: send gallery-only GIDs (no main at pos 0) and pass the variant ID in
  // clearVariantMainImages so the backend sets mediaId: null on Shopify.
  useEffect(() => {
    const hasGalleryChanges = Object.keys(pendingVariantGalleries).length > 0;
    const hasExcludedMain = locallyExcludedMainGids.size > 0;
    const hasProductNewMedia = pendingProductNewMedia.length > 0;
    // Skip the propagation only when ALL the tracked buckets are empty. The
    // previous check was variant-only and ignored pendingProductNewMedia,
    // which is the bucket that grows when the merchant adds something to
    // the product gallery via the modal (library pick or upload). Without
    // pendingProductNewMedia in the guard, the useEffect fires on dep
    // change but immediately returns early, so onPendingChange is never
    // called → the hook never sees the new media → hasPendingImageChanges
    // stays false → Save button stays disabled.
    if (!hasGalleryChanges && !hasExcludedMain && !hasProductNewMedia) return;

    // Track variants with no featured image so backend keeps all GIDs in the metafield
    // and never promotes fileGids[0] to become mediaId on Shopify.
    const noMainVariantIds = new Set<string>();

    const galleries = Object.entries(pendingVariantGalleries).map(([variantId, fileGids]) => {
      if (locallyExcludedMainGids.has(variantId)) {
        // Main image cleared — pass gallery-only GIDs; backend will set mediaId: null
        return { variantId, fileGids };
      }
      const variant = variants.find(v => v.id === variantId);
      const mainGid = variant?.defaultImageUrl
        ? (urlToGid[variant.defaultImageUrl] ??
           Object.entries(urlToGid).find(([u]) =>
             u.split("?")[0] === variant.defaultImageUrl!.split("?")[0]
           )?.[1])
        : undefined;
      if (!mainGid) {
        // No native Shopify featured image — always keep mediaId: null on the backend.
        // Gallery-only images must never be auto-promoted to mediaId; the user must
        // explicitly assign a product image as the variant's featured image.
        noMainVariantIds.add(variantId);
        return { variantId, fileGids };
      }
      const fullGids = [mainGid, ...fileGids.filter(g => g !== mainGid)];
      return { variantId, fileGids: fullGids };
    });

    // Add variants whose main image was excluded but have no pending gallery changes yet
    for (const variantId of locallyExcludedMainGids) {
      if (pendingVariantGalleries[variantId] === undefined) {
        const variant = variants.find(v => v.id === variantId);
        galleries.push({ variantId, fileGids: variant?.galleryFileGids ?? [] });
      }
    }

    const clearVariantMainImages = [...locallyExcludedMainGids, ...noMainVariantIds];
    onPendingChange?.(galleries, pendingMediaOrderRef.current, pendingProductNewMedia, clearVariantMainImages);
  }, [pendingVariantGalleries, pendingProductNewMedia, locallyExcludedMainGids]); // eslint-disable-line react-hooks/exhaustive-deps

  const webpActiveCountRef = useRef<number | null>(null);

  const startWebPPolling = useCallback((pid: string) => {
    if (webpPollRef.current) clearInterval(webpPollRef.current);
    webpActiveCountRef.current = null;
    prevConvertingGidsRef.current = new Set();
    // Shopify processes new WebP media asynchronously after the backend task completes.
    // During processing, image.url is null and the API filters those images out, causing
    // the gallery to temporarily show fewer images than expected. imagesAwaitingSync tracks
    // this state so we keep polling until all images are available.
    let imagesAwaitingSync = false;
    let syncRetryCount = 0;
    // Accumulates GIDs across ticks so the merge can remap images that completed on an
    // earlier tick when imagesAwaitingSync delayed the merge to a later tick where
    // completedGids would otherwise be empty.
    const allCompletedGids = new Set<string>();
    const MAX_SYNC_RETRIES = 10;

    webpPollRef.current = setInterval(async () => {
      try {
        const r = await fetch(`/api/running-field-tasks?resourceId=${encodeURIComponent(pid)}`);
        const { tasks } = await r.json();
        const webpTasks = (tasks ?? []).filter((t: { type: string }) => t.type === "imageWebpConversion");
        const count = webpTasks.length;
        const prev = webpActiveCountRef.current;

        // Update per-image spinner: derive the set of GIDs still being converted.
        // The task result JSON contains mediaId (the original media GID). GIDs are stable
        // across Shopify CDN URL refreshes, unlike sourceUrl which can have changing query params.
        const stillConvertingGids = new Set<string>(
          webpTasks.map((t: { result?: string }) => {
            try { return JSON.parse(t.result || "{}").mediaId as string; } catch { return null; }
          }).filter(Boolean) as string[]
        );
        setConvertingImageUrls(stillConvertingGids);

        const completedGids = new Set([...prevConvertingGidsRef.current].filter(gid => !stillConvertingGids.has(gid)));
        prevConvertingGidsRef.current = stillConvertingGids;
        completedGids.forEach(gid => allCompletedGids.add(gid));

        // Only fetch fresh images for tasks that just completed, or while waiting for
        // Shopify to finish processing a recently converted image.
        if (completedGids.size > 0 || imagesAwaitingSync) {
          try {
            const imgR = await fetch(`/api/product-images?productId=${encodeURIComponent(pid)}`);
            const imgData = await imgR.json();
            if (imgData.success && Array.isArray(imgData.images)) {
              const newImages: ProductImageRef[] = mapApiImagesToRefs(imgData.images);

              const oldImages = currentImagesRef.current;

              // If Shopify returns fewer images than expected, some new WebPs are still in
              // PROCESSING state (image.url is null → filtered out by the API). Skip updating
              // refreshedProductImages to avoid erasing images from the gallery. Retry next poll.
              if (newImages.length < oldImages.length && syncRetryCount < MAX_SYNC_RETRIES) {
                imagesAwaitingSync = true;
                syncRetryCount++;
              } else {
                imagesAwaitingSync = false;
                syncRetryCount = 0;

                // Build URL and GID remaps by matching filenames (basename without extension).
                // The worker always creates WebP with the same base filename as the source image
                // (e.g. img0.png → img0.webp), so basename matching is reliable regardless of
                // the order Shopify returns images in (productReorderMedia is async and may not
                // have taken effect when this fetch runs, making positional matching unreliable).
                const urlRemap: Record<string, string> = {};
                const gidRemap: Record<string, string> = {};
                const getBasename = (url: string) => {
                  try { return new URL(url).pathname.split("/").pop()?.replace(/\.[^.]+$/, "") ?? ""; }
                  catch { return ""; }
                };
                const newByBasename: Record<string, ProductImageRef> = {};
                for (const img of newImages) {
                  const base = getBasename(img.url);
                  if (base) newByBasename[base] = img;
                }
                for (const old of oldImages) {
                  if (!completedGids.has(old.mediaId ?? "")) continue;
                  const base = getBasename(old.url);
                  const next = base ? newByBasename[base] : undefined;
                  if (next && old.mediaId && next.mediaId && old.mediaId !== next.mediaId) {
                    urlRemap[old.url] = next.url;
                    gidRemap[old.mediaId] = next.mediaId;
                  }
                }
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
                  // Update variants state so that unmodified galleries (falling back to
                  // v.galleryFileGids) and variant featured images resolve to the new WebP
                  // GIDs/URLs — ensures correct alt badges and main image display.
                  //
                  // defaultImageUrl comes from the Shopify variant API (?v= may differ from the
                  // DB-cached old.url used as urlRemap keys). Fall back to GID-based remap so
                  // the main image URL is always updated even when query params don't match.
                  const newGidToUrl: Record<string, string> = {};
                  for (const img of newImages) {
                    if (img.mediaId) newGidToUrl[img.mediaId] = img.url;
                  }
                  setVariants(curr => curr.map(v => {
                    let newDefaultImageUrl = v.defaultImageUrl;
                    if (v.defaultImageUrl) {
                      if (urlRemap[v.defaultImageUrl]) {
                        newDefaultImageUrl = urlRemap[v.defaultImageUrl];
                      } else {
                        const oldImg = oldImages.find(img =>
                          img.url === v.defaultImageUrl ||
                          img.url.split("?")[0] === v.defaultImageUrl!.split("?")[0]
                        );
                        const newGid = oldImg?.mediaId ? gidRemap[oldImg.mediaId] : undefined;
                        if (newGid && newGidToUrl[newGid]) newDefaultImageUrl = newGidToUrl[newGid];
                      }
                    }
                    return {
                      ...v,
                      galleryFileGids: v.galleryFileGids.map(gid => gidRemap[gid] ?? gid),
                      defaultImageUrl: newDefaultImageUrl,
                    };
                  }));
                }

                // Only swap in new entries for images that actually completed conversion;
                // keep old entries for still-converting images to avoid unnecessary browser reloads
                // (CDN URLs can have changing query params even for unchanged images).
                const mergedImages = oldImages.map(old => {
                  if (allCompletedGids.has(old.mediaId ?? "")) {
                    const base = getBasename(old.url);
                    return (base ? newByBasename[base] : undefined) ?? old;
                  }
                  return old;
                });
                setRefreshedProductImages(mergedImages);
                onProductImagesRefreshedRef.current?.(pid, mergedImages);
              }
            }
          } catch {
            // non-critical: badge will update on next page load
          }
        }

        webpActiveCountRef.current = count;

        if (count === 0 && !imagesAwaitingSync) {
          clearInterval(webpPollRef.current!);
          webpPollRef.current = null;
          webpActiveCountRef.current = null;
          localStorage.removeItem(`webp_${pid}`);
          setIsConvertingWebP(false);
          setConvertingImageUrls(new Set());
        }
      } catch {
        // keep polling on transient errors
      }
    }, 3000);
  }, []);

  // Resume polling on mount/product-switch; reset spinner if no active conversion for this product.
  // If the localStorage flag indicates a conversion was in progress when the user navigated
  // away, but no tasks are still running (worker finished in the background), do a one-shot
  // refetch of /api/product-images so the WebP URLs propagate to the UI.
  useEffect(() => {
    setRefreshedProductImages(null);
    setConvertingImageUrls(new Set());
    if (!productId) return;
    let cancelled = false;
    const converting = localStorage.getItem(`webp_${productId}`);
    if (converting) {
      setIsConvertingWebP(true);
      (async () => {
        try {
          const r = await fetch(`/api/running-field-tasks?resourceId=${encodeURIComponent(productId)}`);
          const { tasks } = await r.json();
          if (cancelled) return;
          const webpTasks = (tasks ?? []).filter((t: { type: string }) => t.type === "imageWebpConversion");
          const gids = new Set<string>(
            webpTasks.map((t: { result?: string }) => {
              try { return JSON.parse(t.result || "{}").mediaId as string; } catch { return null; }
            }).filter(Boolean) as string[]
          );
          if (webpTasks.length === 0) {
            // Conversion completed while user was away. Refetch images once, propagate, and clean up.
            // Show spinner overlay on all current thumbs while we fetch (~100-300ms typical).
            const placeholderGids = new Set<string>(productImages.map(p => p.mediaId).filter(Boolean));
            setConvertingImageUrls(placeholderGids);
            try {
              const imgR = await fetch(`/api/product-images?productId=${encodeURIComponent(productId)}`);
              const imgData = await imgR.json();
              if (!cancelled && imgData.success && Array.isArray(imgData.images)) {
                const fresh = mapApiImagesToRefs(imgData.images);
                setRefreshedProductImages(fresh);
                onProductImagesRefreshedRef.current?.(productId, fresh);
              }
            } catch {
              // Silent: next mount will retry while flag is still set, or full reload will refresh.
              // We still clear the flag below so we don't loop forever on a broken endpoint.
            }
            if (cancelled) return;
            setConvertingImageUrls(new Set());
            localStorage.removeItem(`webp_${productId}`);
            setIsConvertingWebP(false);
            return;
          }
          // Active tasks present → some images may already be done (worker progresses while away).
          // Refetch /api/product-images once so the already-completed ones get their WebP URLs
          // immediately; the polling tick only catches images that finish AFTER resume because
          // it diffs against prevConvertingGidsRef which we just primed with the still-running set.
          setConvertingImageUrls(gids);
          prevConvertingGidsRef.current = gids;
          try {
            const imgR = await fetch(`/api/product-images?productId=${encodeURIComponent(productId)}`);
            const imgData = await imgR.json();
            if (!cancelled && imgData.success && Array.isArray(imgData.images)) {
              const fresh = mapApiImagesToRefs(imgData.images);
              setRefreshedProductImages(fresh);
              onProductImagesRefreshedRef.current?.(productId, fresh);
            }
          } catch {
            // Polling will eventually catch up when more tasks complete.
          }
          if (cancelled) return;
          startWebPPolling(productId);
        } catch {
          // Network blip: best effort fall back to polling so we self-heal on next tick.
          if (!cancelled) startWebPPolling(productId);
        }
      })();
    } else {
      setIsConvertingWebP(false);
    }
    return () => {
      cancelled = true;
      if (webpPollRef.current) clearInterval(webpPollRef.current);
    };
  }, [productId, startWebPPolling]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reconcile gallery with Shopify on every product open (once per productId mount).
  // The /api/product-images endpoint deletes ProductImage rows whose mediaId is no
  // longer in Shopify's response — catches staged-upload-URL legacy orphans AND
  // CDN-URL orphans left behind by interrupted WebP conversions. One extra Shopify
  // GraphQL call per product open; the previous staged-URL-only gate missed
  // CDN-URL orphans entirely.
  useEffect(() => {
    if (!productId) return;
    if (stagedUrlCheckedProductIdRef.current === productId) return;
    stagedUrlCheckedProductIdRef.current = productId;

    let cancelled = false;
    (async () => {
      try {
        const imgR = await fetch(`/api/product-images?productId=${encodeURIComponent(productId)}`);
        const imgData = await imgR.json();
        if (!cancelled && imgData.success && Array.isArray(imgData.images)) {
          const fresh = mapApiImagesToRefs(imgData.images);
          setRefreshedProductImages(fresh);
          onProductImagesRefreshedRef.current?.(productId, fresh);
        }
      } catch {
        // Best-effort: a full page reload will retry; no user-facing error needed.
      }
    })();
    return () => { cancelled = true; };
  }, [productId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep ref in sync so polling closures can read current conversion state without stale closure.
  isConvertingWebPRef.current = isConvertingWebP;

  // Clear stale refreshedProductImages when the parent reloads fresh data (same productId).
  // refreshedProductImages overrides productImages via effectiveProductImages; without this,
  // a user-triggered reload would be silently ignored as long as the stale override is set.
  // Also re-fetch variants so defaultImageUrl is fresh — missing-main detection depends on it.
  const productImagesKey = productImages.map(i => i.mediaId).join(",");
  useEffect(() => {
    const prev = prevProductImagesKeyRef.current;
    prevProductImagesKeyRef.current = productImagesKey;
    if (prev !== "" && prev !== productImagesKey && !isConvertingWebPRef.current) {
      console.log("[productImagesKey effect] productImages changed → re-fetching", {
        prevKey: prev,
        newKey: productImagesKey,
        productImagesLength: productImages.length,
      });
      setRefreshedProductImages(null);
      if (productId) fetchVariantsForProduct(productId, false);
    }
  }, [productImagesKey, productId, fetchVariantsForProduct]); // eslint-disable-line react-hooks/exhaustive-deps

  // After WebP conversion completes, use the refreshed Shopify URLs (with .webp extension)
  // so badges update immediately without a page reload. Falls back to the prop otherwise.
  const effectiveProductImages = refreshedProductImages ?? productImages;
  currentImagesRef.current = effectiveProductImages;

  // GID → URL map: DB-cached productImages merged with the authoritative Shopify media map.
  // shopifyMediaMap is fetched fresh from Shopify on every product load, so gallery images
  // always resolve even when the DB cache is stale or incomplete.
  //
  // For uploads that haven't been saved yet, pendingProductNewMedia carries a
  // local previewUrl (typically a blob: URL from URL.createObjectURL on the
  // upload pipeline). Inject those staging-URL → previewUrl entries into the
  // same map so the variant gallery's render loop — which maps galleryFileGids
  // through fileUrlMap and .filter(Boolean)s anything that doesn't resolve —
  // can actually show the optimistic tile for a freshly uploaded image. Without
  // this, the gallery silently filtered the entry out and the merchant saw
  // "I added it, nothing happened".
  const fileUrlMap: Record<string, string> = useMemo(() => ({
    ...Object.fromEntries(
      effectiveProductImages.filter(img => img.mediaId).map(img => [img.mediaId, img.url])
    ),
    ...shopifyMediaMap,
    ...Object.fromEntries(
      pendingProductNewMedia
        .filter(m => m.previewUrl && m.resourceUrl)
        .map(m => [m.resourceUrl, m.previewUrl as string])
    ),
  }), [effectiveProductImages, shopifyMediaMap, pendingProductNewMedia]);

  const urlToGid: Record<string, string> = useMemo(() => ({
    ...Object.fromEntries(effectiveProductImages.filter(img => img.mediaId).map(img => [img.url, img.mediaId])),
    ...Object.fromEntries(Object.entries(shopifyMediaMap).map(([gid, url]) => [url, gid])),
  }), [effectiveProductImages, shopifyMediaMap]);

  // Variants that have no effective main image (neither native Shopify main nor any gallery image
  // at position 0 that would be promoted on save). Used for tooltip, pulse, and dot indicator.
  const variantsWithMissingMain = useMemo(() => {
    return variants.filter(v => {
      if (locallyExcludedMainGids.has(v.id)) {
        const storedGids = pendingVariantGalleries[v.id] ?? v.galleryFileGids;
        return storedGids.length === 0;
      }
      const mainGid = v.defaultImageUrl
        ? (urlToGid[v.defaultImageUrl] ??
           Object.entries(urlToGid).find(([u]) =>
             u.split("?")[0] === v.defaultImageUrl!.split("?")[0]
           )?.[1])
        : undefined;
      if (mainGid) return false;
      // No native main image → always flag, even if metafield gallery has images.
      // Gallery images cannot substitute for a missing Shopify featured image.
      return true;
    });
  }, [variants, urlToGid, locallyExcludedMainGids, pendingVariantGalleries]);

  const hasAnyVariantMissingMainImage = variantsWithMissingMain.length > 0;

  const imageManagerTitlePulseStyle = useMemo<React.CSSProperties | undefined>(() => {
    if (hasAnyVariantMissingMainImage) {
      return {
        animation: `pulseFadeIn 500ms ease-out forwards, pulse ${TIMING.HIGHLIGHT_DURATION_MS}ms ease-in-out infinite`,
        animationDelay: `0s, -${(Date.now() - PULSE_SYNC_EPOCH) % TIMING.HIGHLIGHT_DURATION_MS}ms`,
        borderRadius: 4,
        padding: "2px 6px",
      };
    }
    return undefined;
  }, [hasAnyVariantMissingMainImage]);

  useEffect(() => {
    if (!isLoadingVariants && variants.length > 0) {
      onMissingMainImageChange?.(hasAnyVariantMissingMainImage);
    }
  }, [hasAnyVariantMissingMainImage, isLoadingVariants, variants.length, onMissingMainImageChange]);

  // Image metadata map (by URL): includes altText and isConverting spinner flag.
  // isConverting is true when the image's URL matches a still-running WebP task sourceUrl.
  // Also indexed by shopifyMediaMap URL per GID: fileUrlMap uses shopifyMediaMap as override,
  // so the URL resolved for a gallery image may differ from the DB-cached img.url (different
  // ?v= query params). Without the extra entry the alt-text badge lookup would silently fail.
  const imageMetas: Record<string, ImageMeta> = useMemo(() => {
    const map: Record<string, ImageMeta> = {};
    for (const img of effectiveProductImages) {
      // mediaMetaMap is keyed by Shopify GID — use the image's mediaId to look
      // up its media kind (image / video / model / external_video) and apply
      // it under both the DB-cached and the shopifyMediaMap-fresh URL so the
      // SortableThumbnail dispatch works regardless of which URL got rendered.
      const meta = img.mediaId ? mediaMetaMap[img.mediaId] : undefined;
      const entry: ImageMeta = {
        altText: img.altText,
        isConverting: convertingImageUrls.has(img.mediaId),
        kind: meta?.kind,
      };
      map[img.url] = entry;
      const freshUrl = img.mediaId ? shopifyMediaMap[img.mediaId] : undefined;
      if (freshUrl && freshUrl !== img.url) map[freshUrl] = entry;
    }
    // Optimistic-display entries for items the merchant just added through
    // the picker modal — the file isn't on Shopify yet (productCreateMedia
    // runs at save time), but we want the tile to appear immediately so the
    // "click Add → nothing happens" UX gap goes away. Keyed by previewUrl
    // because that's what we shove into displayedProductUrls below.
    for (const pending of pendingProductNewMedia) {
      const previewUrl = pending.previewUrl;
      if (!previewUrl) continue;
      // Mark as pending whether or not the URL already had a meta entry —
      // this is the visual cue for "still unsaved", driven by the parent
      // through pendingProductNewMedia. Once the merchant saves, the pending
      // list is cleared and the same URL no longer flags as isPending.
      if (map[previewUrl]) {
        map[previewUrl] = { ...map[previewUrl], isPending: true };
      } else {
        map[previewUrl] = { kind: pending.kind, isPending: true };
      }
    }
    // Surface mediaMetaMap's previewUrl on every keyed entry. For .glb
    // model URLs (variant_3d_models), the only renderable preview is the
    // client-generated snapshot stored at upload time — without copying
    // it onto ImageMeta the SortableThumbnail falls back to the "3D"
    // placeholder even though we have a real image to show.
    for (const [key, m] of Object.entries(mediaMetaMap)) {
      const existing = map[key];
      if (existing) {
        if (!existing.previewUrl && m.previewUrl) existing.previewUrl = m.previewUrl;
        if (!existing.kind && m.kind) existing.kind = m.kind;
      } else if (m.previewUrl) {
        map[key] = { kind: m.kind, previewUrl: m.previewUrl };
      }
    }
    return map;
  }, [effectiveProductImages, convertingImageUrls, shopifyMediaMap, mediaMetaMap, pendingProductNewMedia]);

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

  // Product image URLs to display (all or only unassigned). Pending uploads
  // / library re-uploads / external URLs that the merchant just queued via
  // the picker modal land at the END of the list as ghost tiles — they
  // disappear and get re-rendered with the real Shopify GID once the save
  // pipeline runs productCreateMedia and /api/product-variants refetches.
  const displayedProductUrls = useMemo(() => {
    const order = pendingProductImageOrder ?? effectiveProductImages.map(i => i.url);
    const baseUrls = (showAll || variants.length === 0)
      ? order
      : order.filter(url => {
          const gid = urlToGid[url];
          return !gid || !assignedGids.has(gid);
        });
    // Pending entries are de-duped by previewUrl; an entry with no preview
    // (rare: a GLB without a poster) is skipped because the grid is URL-keyed.
    const pendingPreviews = pendingProductNewMedia
      .map(p => p.previewUrl)
      .filter((u): u is string => typeof u === "string" && u.length > 0 && !baseUrls.includes(u));
    return [...baseUrls, ...pendingPreviews];
  }, [showAll, pendingProductImageOrder, effectiveProductImages, urlToGid, assignedGids, variants.length, pendingProductNewMedia]);

  // Detect whether the product gallery overflows the single-row collapsed height
  useEffect(() => {
    const el = productGalleryInnerRef.current;
    if (!el) return;
    const collapsedMax = thumbSize + 24;
    const measure = () => {
      const overflow = el.scrollHeight > collapsedMax + 1;
      setProductGalleryHasOverflow(overflow);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [displayedProductUrls, thumbSize, isProductGalleryExpanded]);

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

  // Notify parent of selected GIDs whenever selection or GID map changes
  useEffect(() => {
    if (!onGallerySelectionGidsChange) return;
    const gids = [...selectedGalleryItems.keys()]
      .map(key => key.slice(key.indexOf("::") + 2))
      .map(url => urlToGid[url])
      .filter((g): g is string => Boolean(g));
    onGallerySelectionGidsChange(gids);
  }, [selectedGalleryItems, urlToGid, onGallerySelectionGidsChange]);

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

  const handleVariantReorder = useCallback((variantId: string, newItems: string[]) => {
    // `newItems` is the unified post-reorder sequence — each entry is either
    // a file GID / staged resourceUrl OR a URL (external video or .glb 3D
    // model). Split the three so each lands in the correct pending slot,
    // then build the combined order JSON for variant_gallery_order.
    //
    // 3D-model detection by URL set, not by `.glb$` regex. Freshly uploaded
    // models sit in pendingVariant3dModels with a Shopify staging URL whose
    // pathname has no `.glb` extension — a regex check would mis-tag those
    // as `kind: "url"` (external video), the server-side external-video
    // parser would fail to extract host/id, and the storefront would
    // silently skip the entry. The state-of-truth IS the URL set itself.
    const variant = variants.find(v => v.id === variantId);
    const modelUrlSet = new Set(
      pendingVariant3dModels[variantId] ?? variant?.threeDModelUrls ?? []
    );
    const fileEntries: string[] = [];
    const orderEntries: Array<{ kind: "file" | "url" | "model"; value: string }> = [];
    for (const it of newItems) {
      if (it.startsWith("http")) {
        orderEntries.push({ kind: modelUrlSet.has(it) ? "model" : "url", value: it });
      } else {
        fileEntries.push(it);
        orderEntries.push({ kind: "file", value: it });
      }
    }
    console.log("[handleVariantReorder] writing state", {
      variantId,
      newItems,
      fileEntries,
      orderEntries,
    });
    setPendingVariantGalleries(p => ({ ...p, [variantId]: fileEntries }));
    setPendingGalleryOrder(p => ({ ...p, [variantId]: JSON.stringify(orderEntries) }));
    onGalleryOrderChange?.({ ...pendingGalleryOrderRef.current, [variantId]: JSON.stringify(orderEntries) });
  }, [variants, pendingVariant3dModels, onGalleryOrderChange]);

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
        const storedGids = pendingVariantGalleries[sourceContainerId] ?? variant?.galleryFileGids ?? [];
        // mainGid is what gets shown at position 0 in the variant gallery
        // when storedGids doesn't already include it (legacy metafield
        // convention: variant_gallery list.file_reference holds gallery
        // items, mainGid is implicit at slot 0). For reorder to be aware of
        // it (so the merchant can drag it to a different position OR drag
        // something else to position 0 to promote that one to the new
        // featured image), include it in the source variantUrls. If
        // storedGids already contains it (after a prior reorder this
        // session), use as-is — handleVariantReorder pushes mainGid into
        // pendingVariantGalleries on each reorder so the second drag onwards
        // doesn't need the prepend.
        const variantMainGid = variant?.defaultImageUrl
          ? (urlToGid[variant.defaultImageUrl] ??
             Object.entries(urlToGid).find(([u]) =>
               u.split("?")[0] === variant.defaultImageUrl!.split("?")[0]
             )?.[1])
          : undefined;
        const hasMainImageInGallery = !locallyExcludedMainGids.has(sourceContainerId) && Boolean(variantMainGid);
        const gids = (hasMainImageInGallery && variantMainGid && !storedGids.includes(variantMainGid))
          ? [variantMainGid, ...storedGids]
          : storedGids;
        const fileUrls = gids.map(gid => fileUrlMap[gid]).filter(Boolean) as string[];
        const externalUrls = pendingExternalVideos[sourceContainerId] ?? variant?.externalVideoUrls ?? [];
        const modelUrls = pendingVariant3dModels[sourceContainerId] ?? variant?.threeDModelUrls ?? [];
        // Build the same ordered display list that VariantGallerySection
        // shows the merchant — saved order JSON first (honouring per-kind
        // value lookups), then tail-append any item the order metafield
        // doesn't cover. Without this, dragging a video / 3D model fired a
        // drag-end whose URL wasn't in the (file-only) variantUrls list →
        // indexOf returned -1 → the if-guard rejected the move and nothing
        // happened. The merchant couldn't reorder mixed galleries.
        const orderJsonRaw = pendingGalleryOrder[sourceContainerId] ?? variant?.galleryOrderJson ?? null;
        const fileSet = new Set(fileUrls);
        const externalSet = new Set(externalUrls);
        const modelSet = new Set(modelUrls);
        let variantUrls: string[] = [];
        if (orderJsonRaw) {
          try {
            const parsed = JSON.parse(orderJsonRaw) as Array<{ kind: string; value: string }>;
            const seenFile = new Set<string>();
            const seenExternal = new Set<string>();
            const seenModel = new Set<string>();
            for (const entry of (Array.isArray(parsed) ? parsed : [])) {
              if (entry?.kind === "file") {
                const u = fileUrlMap[entry.value];
                if (u && fileSet.has(u) && !seenFile.has(u)) { variantUrls.push(u); seenFile.add(u); }
              } else if (entry?.kind === "url") {
                if (externalSet.has(entry.value) && !seenExternal.has(entry.value)) { variantUrls.push(entry.value); seenExternal.add(entry.value); }
              } else if (entry?.kind === "model") {
                if (modelSet.has(entry.value) && !seenModel.has(entry.value)) { variantUrls.push(entry.value); seenModel.add(entry.value); }
              }
            }
            for (const u of fileUrls) if (!seenFile.has(u)) variantUrls.push(u);
            for (const u of externalUrls) if (!seenExternal.has(u)) variantUrls.push(u);
            for (const u of modelUrls) if (!seenModel.has(u)) variantUrls.push(u);
          } catch {
            variantUrls = [...fileUrls, ...externalUrls, ...modelUrls];
          }
        } else {
          variantUrls = [...fileUrls, ...externalUrls, ...modelUrls];
        }

        const oldIndex = variantUrls.indexOf(url);
        const newIndex = variantUrls.indexOf(overUrl);
        console.log("[reorder variant] drag", {
          variantId: sourceContainerId,
          draggedUrl: url,
          dropTargetUrl: overUrl,
          variantUrls,
          oldIndex,
          newIndex,
          storedGids,
          variantMainGid,
          externalUrls,
          modelUrls,
        });
        if (oldIndex !== -1 && newIndex !== -1 && oldIndex !== newIndex) {
          // Variant gallery position 0 maps to mediaId (MediaImage only).
          // Refuse the drop iff the new head would be a non-image. The check
          // covers three sources: pendingExternalVideos (YouTube/Vimeo for
          // this variant), pendingVariant3dModels (variant .glb URLs), and
          // any imageMetas entry whose kind is non-image. Without the first
          // two, a video/model dragged to position 0 would slip past this
          // guard (their URLs aren't in imageMetas) and the server-side
          // position-0 validator would reject the whole save.
          const isNonImage = (u: string) => {
            if (externalSet.has(u) || modelSet.has(u)) return true;
            const k = imageMetas[u]?.kind;
            return k === "video" || k === "model" || k === "external_video";
          };
          const moved = arrayMove(variantUrls, oldIndex, newIndex);
          if (moved[0] && isNonImage(moved[0])) {
            console.warn("[reorder variant] refused — position 0 would be non-image", { head: moved[0] });
            return;
          }
          const newItemsForReorder = moved.map(u => {
              // External-video / 3D-model URLs must stay as URLs in the
              // payload — handleVariantReorder's URL-pattern detection
              // routes them to the right `kind` (`url` vs `model`).
              // urlToGid[glbUrl] resolves to a Model3d GID when the model
              // is also on product.media (cross-product picks), so a blind
              // ?? would mistakenly serialise it as kind:"file" → the
              // server rejects Model3d in variant_gallery list.file_reference
              // AND the 3D badge disappears from the tile on the next
              // render (no model URL in pendingVariant3dModels for that
              // entry). Same shape concern for YouTube/Vimeo URLs even
              // though they don't currently collide with urlToGid.
              if (externalSet.has(u) || modelSet.has(u)) return u;
              return urlToGid[u] ?? u;
            });
          console.log("[reorder variant] → handleVariantReorder", {
            variantId: sourceContainerId,
            moved,
            newItemsForReorder,
          });
          handleVariantReorder(sourceContainerId, newItemsForReorder);
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
          onDirtyChange?.(true);
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
          const targetMainGid = targetVariant?.defaultImageUrl
            ? (urlToGid[targetVariant.defaultImageUrl] ??
               Object.entries(urlToGid).find(([u]) =>
                 u.split("?")[0] === targetVariant.defaultImageUrl!.split("?")[0]
               )?.[1])
            : undefined;
          const noMain = (!targetMainGid || locallyExcludedMainGids.has(targetContainerId)) && existing.length === 0;
          return { ...p, [targetContainerId]: noMain ? [gid, ...existing] : insertGidAtPosition(existing, gid, overUrl, fileUrlMap) };
        });
      } else {
        // Variant → Variant: move (remove from source, add to target) in single update
        setPendingVariantGalleries(p => {
          const targetVariant = variants.find(v => v.id === targetContainerId);
          const sourceVariant = variants.find(v => v.id === sourceContainerId);
          const targetExisting = p[targetContainerId] ?? targetVariant?.galleryFileGids ?? [];
          const sourceCurrent = p[sourceContainerId] ?? sourceVariant?.galleryFileGids ?? [];
          const result = { ...p };
          if (!targetExisting.includes(gid)) {
            const targetVariant = variants.find(v => v.id === targetContainerId);
            const targetMainGid = targetVariant?.defaultImageUrl
              ? (urlToGid[targetVariant.defaultImageUrl] ??
                 Object.entries(urlToGid).find(([u]) =>
                   u.split("?")[0] === targetVariant.defaultImageUrl!.split("?")[0]
                 )?.[1])
              : undefined;
            const noMain = (!targetMainGid || locallyExcludedMainGids.has(targetContainerId)) && targetExisting.length === 0;
            result[targetContainerId] = noMain ? [gid, ...targetExisting] : insertGidAtPosition(targetExisting, gid, overUrl, fileUrlMap);
          }
          result[sourceContainerId] = sourceCurrent.filter(g => g !== gid);
          return result;
        });
      }
    } else {
      // Product → Variant: copy (keep in product gallery)
      // Special case: if the dragged image is this variant's locally-excluded main image,
      // restore it instead of copying it (clear exclusion, don't add to metafield).
      const targetVariant = variants.find(v => v.id === targetContainerId);
      if (locallyExcludedMainGids.has(targetContainerId)) {
        const targetMainGid = targetVariant?.defaultImageUrl
          ? (urlToGid[targetVariant.defaultImageUrl] ??
             Object.entries(urlToGid).find(([u]) =>
               u.split("?")[0] === targetVariant.defaultImageUrl!.split("?")[0]
             )?.[1])
          : undefined;
        if (targetMainGid && gid === targetMainGid) {
          setLocallyExcludedMainGids(prev => { const n = new Set(prev); n.delete(targetContainerId); return n; });
          return;
        }
      }
      setPendingVariantGalleries(p => {
        const existing = p[targetContainerId] ?? targetVariant?.galleryFileGids ?? [];
        if (existing.includes(gid)) return p;
        const targetMainGid = targetVariant?.defaultImageUrl
          ? (urlToGid[targetVariant.defaultImageUrl] ??
             Object.entries(urlToGid).find(([u]) =>
               u.split("?")[0] === targetVariant.defaultImageUrl!.split("?")[0]
             )?.[1])
          : undefined;
        const noMain = (!targetMainGid || locallyExcludedMainGids.has(targetContainerId)) && existing.length === 0;
        return { ...p, [targetContainerId]: noMain ? [gid, ...existing] : insertGidAtPosition(existing, gid, overUrl, fileUrlMap) };
      });
    }
  }, [pendingProductImageOrder, effectiveProductImages, variants, pendingVariantGalleries, fileUrlMap, urlToGid, locallyExcludedMainGids, handleProductReorder, handleVariantReorder]); // eslint-disable-line react-hooks/exhaustive-deps

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
      const targetVariant = variants.find(v => v.id === targetVariantId);
      const existing = p[targetVariantId] ?? targetVariant?.galleryFileGids ?? [];
      const targetMainGid = targetVariant?.defaultImageUrl
        ? (urlToGid[targetVariant.defaultImageUrl] ??
           Object.entries(urlToGid).find(([u]) =>
             u.split("?")[0] === targetVariant.defaultImageUrl!.split("?")[0]
           )?.[1])
        : undefined;
      const noMain = (!targetMainGid || locallyExcludedMainGids.has(targetVariantId)) && existing.length === 0;
      const merged = (prepend || noMain) ? [...newGids, ...existing] : [...existing, ...newGids];
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
  }, [bulkItems, selectedBulkIds, selectedGalleryItems, activeAction, variants, urlToGid, fileUrlMap, locallyExcludedMainGids, onRemoveBulk, onSetAction]);

  // Unified add-media commit. Routes the modal's three item shapes (library
  // pick, fresh upload, external URL) into the right pending state slot
  // depending on whether the modal was opened from a variant section or the
  // product gallery. Closes the modal afterwards — except for URL adds,
  // which leave it open so the merchant can pile more.
  const handleModalAdd = useCallback((items: AddedItem[]) => {
    if (!pickerTarget || items.length === 0) return;

    // Pre-seed mediaMetaMap so library tiles render with the right overlay
    // immediately instead of waiting for the next /api/product-variants
    // refetch. Uploads + library items both go here.
    setMediaMetaMap(prev => {
      const next = { ...prev };
      for (const it of items) {
        if (it.source === "library") {
          if (!next[it.gid]) next[it.gid] = { kind: it.kind, previewUrl: it.previewUrl };
        } else if (it.source === "upload") {
          if (!next[it.resourceUrl]) next[it.resourceUrl] = { kind: it.kind, previewUrl: it.previewUrl };
        }
      }
      return next;
    });

    if (pickerTarget.mode === "variant") {
      // ──────────────────────────────────────────────────────────────────
      // VARIANT MODE
      //   library  → image/video: append GID to pendingVariantGalleries
      //              model:       extract assetUrl, push to variant_3d_models
      //                           (Shopify's list.file_reference rejects
      //                           Media3d, so 3D models live in their own
      //                           list.url metafield)
      //   upload   → image/video: append resourceUrl to pendingVariantGalleries
      //                           (resolved to a real GID at save time via
      //                           resourceUrlToGid) AND register the upload
      //                           in pendingProductNewMedia so the backend
      //                           actually runs productCreateMedia for it
      //              model:       register the upload in pendingProductNewMedia
      //                           (Shopify materializes it as a Model3d on
      //                           product.media) AND push the staging URL
      //                           into pendingVariant3dModels — the backend
      //                           polls Model3d.sources after productCreateMedia
      //                           and substitutes the staging URL with the
      //                           final CDN URL before metafieldsSet runs.
      //                           If processing exceeds ~9s the URL gets
      //                           dropped with reason "processing" and the
      //                           merchant retries the save in a moment.
      //   external → handle via the URL path (variantExternalVideos)
      // ──────────────────────────────────────────────────────────────────
      const variantId = pickerTarget.variantId;
      const refsForGallery: string[] = [];
      const uploadEntries: Array<{ resourceUrl: string; kind: MediaKind; previewUrl?: string }> = [];
      for (const it of items) {
        if (it.source === "library") {
          if (it.kind === "model") {
            // Library-picked models have no admin-side snapshot — pass "" so
            // the parallel preview array stays index-aligned. The storefront
            // falls back to its own "3D" placeholder for these slots until
            // we add a server-side or on-demand snapshot path for legacy
            // models.
            if (it.assetUrl) handleAddThreeDModelUrl(variantId, it.assetUrl, "");
          } else {
            refsForGallery.push(it.gid);
            // Library-picked images/videos that aren't already on this
            // product's media should also land on product.media (so they
            // show up in the theme's product gallery, not just in the
            // variant metafield). Position-0 picks are already enforced by
            // Shopify (mediaId rejects MediaImage from other products), but
            // position-1+ picks would otherwise live only in the variant
            // metafield — inconsistent with the merchant's expectation that
            // "added to a variant" means "part of the product".
            // We only clone images for now: productCreateMedia accepts a
            // public URL as originalSource for IMAGE, but VIDEO/MODEL_3D
            // require staged-uploads URLs (no server-side download+restage
            // path exists yet). Cross-product video library picks therefore
            // stay metafield-only; same-product picks were already on
            // product.media so no clone is needed.
            const alreadyOnThisProduct = !!shopifyMediaMap[it.gid];
            if (it.kind === "image" && !alreadyOnThisProduct && it.assetUrl) {
              uploadEntries.push({ resourceUrl: it.assetUrl, kind: "image", previewUrl: it.previewUrl });
            }
          }
        } else if (it.source === "upload") {
          if (it.kind === "model") {
            // Materialize the .glb on product.media so the library and the
            // storefront agree on the asset, AND register the staging URL
            // for backend post-create resolution → variant_3d_models.
            uploadEntries.push({ resourceUrl: it.resourceUrl, kind: it.kind, previewUrl: it.previewUrl });
            // persistentPreviewUrl is the CDN URL of the snapshot JPEG
            // uploaded by BulkImageUploadPanel via fileCreate. Empty if the
            // snapshot pipeline failed or wasn't ready before the merchant
            // clicked "Confirm" — handler treats it as "no preview" and the
            // storefront falls back to the placeholder.
            handleAddThreeDModelUrl(variantId, it.resourceUrl, it.persistentPreviewUrl ?? "");
          } else {
            refsForGallery.push(it.resourceUrl);
            uploadEntries.push({ resourceUrl: it.resourceUrl, kind: it.kind, previewUrl: it.previewUrl });
          }
        } else if (it.source === "external_url") {
          handleAddExternalVideoUrl(variantId, it.url);
        }
      }
      if (uploadEntries.length > 0) {
        setPendingProductNewMedia(prev => {
          const seen = new Set(prev.map(e => e.resourceUrl));
          return [...prev, ...uploadEntries.filter(e => !seen.has(e.resourceUrl))];
        });
      }
      if (refsForGallery.length > 0) {
        setPendingVariantGalleries(prev => {
          const variant = variants.find(v => v.id === variantId);
          const current = prev[variantId] ?? variant?.galleryFileGids ?? [];
          const seen = new Set(current);
          const additions = refsForGallery.filter(r => !seen.has(r));
          if (additions.length === 0) return prev;
          return { ...prev, [variantId]: [...current, ...additions] };
        });
      }
    } else {
      // ──────────────────────────────────────────────────────────────────
      // PRODUCT MODE — every item ends up as a new product.media via the
      // pendingProductNewMedia queue. The library branch reuses the file's
      // assetUrl as the originalSource (Shopify deduplicates the underlying
      // asset, even if a new media node is created). The external_url
      // branch uses the canonical YouTube/Vimeo URL with kind=external_video
      // so productCreateMedia gets mediaContentType: EXTERNAL_VIDEO.
      // ──────────────────────────────────────────────────────────────────
      const additions: Array<{ resourceUrl: string; kind: MediaKind; previewUrl?: string }> = [];
      for (const it of items) {
        if (it.source === "library") {
          if (!it.assetUrl) continue; // library entries without an asset URL can't be re-uploaded
          additions.push({ resourceUrl: it.assetUrl, kind: it.kind, previewUrl: it.previewUrl });
        } else if (it.source === "upload") {
          additions.push({ resourceUrl: it.resourceUrl, kind: it.kind, previewUrl: it.previewUrl });
        } else if (it.source === "external_url") {
          additions.push({ resourceUrl: it.url, kind: "external_video", previewUrl: youtubeThumbForUrl(it.url) });
        }
      }
      if (additions.length > 0) {
        setPendingProductNewMedia(prev => {
          const seen = new Set(prev.map(e => e.resourceUrl));
          return [...prev, ...additions.filter(e => !seen.has(e.resourceUrl))];
        });
      }
    }

    // Library + upload commits close the modal; URL commits go through the
    // dedicated handler below and leave the modal open. handleModalAdd is
    // only called for the former two (the modal's URL flow calls
    // onAddExternalUrl directly).
    const hasNonUrlCommit = items.some(it => it.source !== "external_url");
    if (hasNonUrlCommit) setPickerTarget(null);
    // handleAddExternalVideoUrl / handleAddThreeDModelUrl are declared after
    // this callback (parent ordering); intentionally omitted from deps —
    // they are captured via closure at call-time, never re-bound.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickerTarget, variants]);

  // Called the moment the merchant hits "Add link" inside the modal. Wired
  // in both modes — product-mode URLs ride through the same handleModalAdd
  // by being represented as an AddedItem with source "external_url", so
  // variant- and product-routing stay in one place.
  const handleModalAddExternalUrl = useCallback((url: string) => {
    if (!pickerTarget) return;
    if (pickerTarget.mode === "variant") {
      handleAddExternalVideoUrl(pickerTarget.variantId, url);
    } else {
      // Product mode: bounce through handleModalAdd so the same dedup +
      // mediaMetaMap seeding logic applies.
      handleModalAdd([{ source: "external_url", url }]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickerTarget, handleModalAdd]);

  // External-video URL handlers. The "effective" URL list for a variant is
  // pendingExternalVideos[id] if the merchant has touched the row this session,
  // otherwise the server-loaded variant.externalVideoUrls. We notify the parent
  // hook on every mutation so its handleApply can ship the changes alongside
  // the regular gallery save without an extra round-trip.
  const handleAddExternalVideoUrl = useCallback((variantId: string, url: string) => {
    setPendingExternalVideos(prev => {
      const variant = variants.find(v => v.id === variantId);
      const current = prev[variantId] ?? variant?.externalVideoUrls ?? [];
      if (current.includes(url)) return prev;
      const next = { ...prev, [variantId]: [...current, url] };
      onExternalVideosChange?.(next);
      return next;
    });
  }, [variants, onExternalVideosChange]);

  const handleRemoveExternalVideoUrl = useCallback((variantId: string, url: string) => {
    setPendingExternalVideos(prev => {
      const variant = variants.find(v => v.id === variantId);
      const current = prev[variantId] ?? variant?.externalVideoUrls ?? [];
      const next = { ...prev, [variantId]: current.filter(u => u !== url) };
      onExternalVideosChange?.(next);
      return next;
    });
  }, [variants, onExternalVideosChange]);

  // 3D-model URL handlers — mirror the external-video pair, with the
  // additional twist that variant_3d_previews is a parallel list.url
  // metafield. Add appends to BOTH arrays at the same index; remove
  // deletes at the same index in both. previewUrl defaults to "" so a
  // library-picked model (no admin-side snapshot) still adds — the
  // storefront falls back to its "3D" wordmark placeholder for that slot.
  const handleAddThreeDModelUrl = useCallback((variantId: string, url: string, previewUrl: string = "") => {
    const variant = variants.find(v => v.id === variantId);
    setPendingVariant3dModels(prev => {
      const current = prev[variantId] ?? variant?.threeDModelUrls ?? [];
      if (current.includes(url)) return prev;
      const next = { ...prev, [variantId]: [...current, url] };
      onThreeDModelsChange?.(next);
      return next;
    });
    setPendingVariant3dPreviews(prev => {
      const currentModels = pendingVariant3dModels[variantId] ?? variant?.threeDModelUrls ?? [];
      if (currentModels.includes(url)) return prev;
      const current = prev[variantId] ?? variant?.threeDPreviewUrls ?? [];
      const next = { ...prev, [variantId]: [...current, previewUrl] };
      onThreeDPreviewsChange?.(next);
      return next;
    });
  }, [variants, pendingVariant3dModels, onThreeDModelsChange, onThreeDPreviewsChange]);

  const handleRemoveThreeDModelUrl = useCallback((variantId: string, url: string) => {
    const variant = variants.find(v => v.id === variantId);
    const currentModels = pendingVariant3dModels[variantId] ?? variant?.threeDModelUrls ?? [];
    const idx = currentModels.indexOf(url);
    setPendingVariant3dModels(prev => {
      const cur = prev[variantId] ?? variant?.threeDModelUrls ?? [];
      const next = { ...prev, [variantId]: cur.filter(u => u !== url) };
      onThreeDModelsChange?.(next);
      return next;
    });
    if (idx >= 0) {
      setPendingVariant3dPreviews(prev => {
        const cur = prev[variantId] ?? variant?.threeDPreviewUrls ?? [];
        const nextArr = cur.filter((_, i) => i !== idx);
        const next = { ...prev, [variantId]: nextArr };
        onThreeDPreviewsChange?.(next);
        return next;
      });
    }
  }, [variants, pendingVariant3dModels, onThreeDModelsChange, onThreeDPreviewsChange]);

  const handleRemoveFromGallery = useCallback((variantId: string, urls: string[]) => {
    const urlSet = new Set(urls);
    const variant = variants.find(v => v.id === variantId);

    // If the variant's main image (injected at position 0) is among the removed URLs,
    // mark it as locally excluded so Shopify's mediaId gets cleared on save.
    if (variant?.defaultImageUrl && urlSet.has(variant.defaultImageUrl)) {
      setLocallyExcludedMainGids(prev => new Set([...prev, variantId]));
    }

    // URL-backed items live in their own list.url metafields, not in
    // pendingVariantGalleries. Split the removal so each URL ends up clearing
    // the right slot. Membership in pendingVariant3dModels (falling back to
    // the server-loaded variant.threeDModelUrls) is the source of truth —
    // a regex on `.glb$` would miss freshly uploaded models that still sit
    // on a Shopify staging URL without that extension.
    const httpUrls = urls.filter(u => u.startsWith("http"));
    const modelUrlSet = new Set(
      pendingVariant3dModels[variantId] ?? variant?.threeDModelUrls ?? []
    );
    const modelToRemove = httpUrls.filter(u => modelUrlSet.has(u));
    const externalToRemove = httpUrls.filter(u => !modelUrlSet.has(u));
    if (externalToRemove.length > 0) {
      setPendingExternalVideos(prev => {
        const current = prev[variantId] ?? variant?.externalVideoUrls ?? [];
        const next = { ...prev, [variantId]: current.filter(u => !urlSet.has(u)) };
        onExternalVideosChange?.(next);
        return next;
      });
    }
    if (modelToRemove.length > 0) {
      // Capture the pre-removal model index for every removed URL so we
      // can prune the parallel preview array at the SAME indices. Doing
      // both lookups against `current` before any setState keeps the
      // ordering aligned even if multiple models are removed at once.
      const currentModels = pendingVariant3dModels[variantId] ?? variant?.threeDModelUrls ?? [];
      const removedIndices = new Set(
        modelToRemove
          .map(u => currentModels.indexOf(u))
          .filter(i => i >= 0)
      );
      setPendingVariant3dModels(prev => {
        const current = prev[variantId] ?? variant?.threeDModelUrls ?? [];
        const next = { ...prev, [variantId]: current.filter(u => !urlSet.has(u)) };
        onThreeDModelsChange?.(next);
        return next;
      });
      setPendingVariant3dPreviews(prev => {
        const current = prev[variantId] ?? variant?.threeDPreviewUrls ?? [];
        const next = { ...prev, [variantId]: current.filter((_, i) => !removedIndices.has(i)) };
        onThreeDPreviewsChange?.(next);
        return next;
      });
    }

    setPendingVariantGalleries(p => {
      const current = p[variantId] ?? variant?.galleryFileGids ?? [];
      return { ...p, [variantId]: current.filter(gid => !urlSet.has(fileUrlMap[gid] ?? "")) };
    });
    setSelectedGalleryItems(m => {
      const next = new Map(m);
      urls.forEach(u => next.delete(`${variantId}::${u}`));
      return next;
    });
  }, [variants, fileUrlMap, pendingVariant3dModels, onExternalVideosChange, onThreeDModelsChange, onThreeDPreviewsChange]);

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
    // Variants whose featured image was deleted — exclude from gallery and unset on Shopify
    const variantsWithDeletedMainImage = variants.filter(v => v.defaultImageUrl && urlSet.has(v.defaultImageUrl));
    setLocallyExcludedMainGids(s => {
      const next = new Set(s);
      variantsWithDeletedMainImage.forEach(v => next.add(v.id));
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
      const deleteFetch = fetch("/api/delete-product-images", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId, mediaIds: gids }),
      });
      // Shopify does not automatically clear a variant's image when the referenced media is
      // deleted. Explicitly unset mediaId for all affected variants in the same round-trip.
      const clearMainImageIds = variantsWithDeletedMainImage.map(v => v.id);
      const clearFetch = clearMainImageIds.length > 0
        ? fetch("/api/update-variant-galleries", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ productId, clearVariantMainImages: clearMainImageIds }),
          })
        : Promise.resolve();
      await Promise.all([deleteFetch, clearFetch]);
    } catch {
      // non-critical: local state already reflects deletion
    }
    setIsDeleting(false);
  }, [deleteConfirm, urlToGid, variants, effectiveProductImages, productId]);

  const handleGenerateAltFromSku = useCallback((_variantId: string, selectedGids: string[]) => {
    if (!selectedGids.length) return;
    const form = new FormData();
    form.append("action", "generateAltTextFromSku");
    form.append("productId", productId);
    selectedGids.forEach(gid => form.append("mediaId", gid));
    fetcher.submit(form, { method: "post" });
  }, [productId, fetcher]);

  const handleGenerateAltFromSkuAll = useCallback(() => {
    const allGids = new Set<string>([
      ...variants.flatMap(v => pendingVariantGalleries[v.id] ?? v.galleryFileGids),
      ...effectiveProductImages.filter(img => img.mediaId).map(img => img.mediaId!),
    ]);
    if (!allGids.size) return;
    const form = new FormData();
    form.append("action", "generateAltTextFromSku");
    form.append("productId", productId);
    allGids.forEach(gid => form.append("mediaId", gid));
    fetcher.submit(form, { method: "post" });
  }, [variants, pendingVariantGalleries, effectiveProductImages, productId, fetcher]);

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
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        if (body?.code === "IMAGE_QUOTA_EXCEEDED") {
          setWebpError(
            t.imageManager.imageQuotaExceeded.replace("{limit}", String(body.limit ?? ""))
          );
          return;
        }
        throw new Error();
      }
      localStorage.setItem(`webp_${productId}`, "1");
      setIsConvertingWebP(true);
      startWebPPolling(productId);
    } catch {
      setWebpError(t.imageManager.webpConvertError);
    }
  }, [productId, productTitle, startWebPPolling, pendingProductImageOrder, productImages]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleUploadToVariant = useCallback(async (variantId: string, files: File[]) => {
    setWebpError(null); // clear any stale error before a fresh upload
    for (const file of files) {
      try {
        const res = await fetch("/api/staged-upload", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filename: file.name, mimeType: file.type, fileSize: file.size }),
        });
        const { url, resourceUrl, parameters, httpMethod, error, code, limit } = await res.json();
        if (code === "IMAGE_QUOTA_EXCEEDED") {
          setWebpError(t.imageManager.imageQuotaExceeded.replace("{limit}", String(limit ?? "")));
          break;
        }
        if (error || !url) continue;

        await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.onload = () => resolve();
          xhr.onerror = () => reject();
          // See FilePickerModal — PUT (image) vs multipart POST (video/3D).
          if (httpMethod === "POST") {
            const form = new FormData();
            for (const p of (parameters ?? []) as Array<{ name: string; value: string }>) {
              form.append(p.name, p.value);
            }
            form.append("file", file);
            xhr.open("POST", url);
            xhr.send(form);
          } else {
            xhr.open("PUT", url);
            xhr.setRequestHeader("Content-Type", file.type);
            xhr.send(file);
          }
        });

        if (resourceUrl) {
          setPendingVariantGalleries(p => {
            const variant = variants.find(v => v.id === variantId);
            const current = p[variantId] ?? variant?.galleryFileGids ?? [];
            const mainGid = variant?.defaultImageUrl
              ? (urlToGid[variant.defaultImageUrl] ??
                 Object.entries(urlToGid).find(([u]) =>
                   u.split("?")[0] === variant.defaultImageUrl!.split("?")[0]
                 )?.[1])
              : undefined;
            const noMain = (!mainGid || locallyExcludedMainGids.has(variantId)) && current.length === 0;
            return { ...p, [variantId]: noMain ? [resourceUrl, ...current] : [...current, resourceUrl] };
          });
        }
      } catch {
        // silent — user can retry
      }
    }
  }, [variants, urlToGid, locallyExcludedMainGids]);

  const handleUploadToProductGallery = useCallback(async (files: File[]) => {
    setWebpError(null); // clear any stale error before a fresh upload
    for (const file of files) {
      try {
        // Classify so we (a) know what to push into pendingProductNewMedia
        // (which is typed as Array<{resourceUrl, kind, previewUrl?}>) and
        // (b) dispatch the upload XHR correctly per Shopify's resource type.
        const kind: MediaKind = (classifyFile(file.type, file.name) ?? "image");
        const res = await fetch("/api/staged-upload", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filename: file.name, mimeType: file.type, fileSize: file.size }),
        });
        const { url, resourceUrl, parameters, httpMethod, error, code, limit } = await res.json();
        if (code === "IMAGE_QUOTA_EXCEEDED") {
          setWebpError(t.imageManager.imageQuotaExceeded.replace("{limit}", String(limit ?? "")));
          break;
        }
        if (error || !url) continue;

        await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.onload = () => resolve();
          xhr.onerror = () => reject();
          // PUT (image) vs multipart POST (video/3D). The previous always-PUT
          // path produced a 405 against video / model staged targets, so a
          // drag-drop .glb to the product-gallery placeholder silently
          // failed and the merchant saw the modal close with nothing saved.
          if (httpMethod === "POST") {
            const form = new FormData();
            for (const p of (parameters ?? []) as Array<{ name: string; value: string }>) {
              form.append(p.name, p.value);
            }
            form.append("file", file);
            xhr.open("POST", url);
            xhr.send(form);
          } else {
            xhr.open("PUT", url);
            xhr.setRequestHeader("Content-Type", file.type);
            xhr.send(file);
          }
        });

        if (resourceUrl) {
          // Push the typed shape — bare resourceUrl strings would survive the
          // local state (resourceUrl is `any` from res.json) and then crash
          // silently in handleApply when it does m.resourceUrl / m.kind on
          // a string, producing newMedia entries with undefined fields that
          // productCreateMedia drops.
          const previewUrl = kind === "image" ? URL.createObjectURL(file) : undefined;
          setPendingProductNewMedia(p => [...p, { resourceUrl, kind, previewUrl }]);
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
  const productGallerySelectedUrls = selectedUrlsByGallery.get("product") ?? new Set<string>();
  const noneOrAllSelected = productGallerySelectedUrls.size === 0 || productGallerySelectedUrls.size >= displayedProductUrls.length;
  const imagesToConvert = effectiveProductImages.filter(i =>
    !i.url.toLowerCase().includes(".webp") &&
    !i.url.toLowerCase().includes("format=webp") &&
    (noneOrAllSelected ? displayedProductUrls.includes(i.url) : productGallerySelectedUrls.has(i.url))
  );

  const webpFormatBreakdown = (() => {
    const counts: Record<string, number> = {};
    for (const img of imagesToConvert) {
      const lower = img.url.toLowerCase();
      const fmt = lower.includes(".png") ? "PNG"
        : (lower.includes(".jpg") || lower.includes(".jpeg")) ? "JPG"
        : lower.includes(".gif") ? "GIF"
        : lower.includes(".avif") ? "AVIF"
        : lower.includes(".tif") ? "TIFF"
        : null;
      if (fmt) counts[fmt] = (counts[fmt] ?? 0) + 1;
    }
    const parts = Object.entries(counts).map(([fmt, n]) => `${n}\u00a0${fmt}`);
    return parts.length > 1 ? ` (${parts.join(", ")})` : "";
  })();

  const productSingleSelected = productGallerySelectedUrls.size === 1 ? [...productGallerySelectedUrls][0] : null;
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
          <span
            title={hasAnyVariantMissingMainImage
              ? t.imageManager.missingMainImageTooltip.replace(
                  "{variants}",
                  variantsWithMissingMain.map(v => v.title).join(", ")
                )
              : undefined}
            style={imageManagerTitlePulseStyle}
          >
            <Text as="h3" variant="headingSm">{t.imageManager.title}</Text>
          </span>
          <Button
            size="slim"
            variant="plain"
            onClick={() => setIsExpanded(e => !e)}
          >
            {isExpanded ? t.imageManager.collapse : t.imageManager.expand}
          </Button>
        </InlineStack>

        <div style={{
          maxHeight: isExpanded ? "none" : 320,
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
                  : t.imageManager.webpConvertButton.replace("{count}", String(imagesToConvert.length)) + webpFormatBreakdown}
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
        <div style={{ position: "relative", marginTop: 8 }}>
          <div
            style={{
              maxHeight: isProductGalleryExpanded ? "none" : thumbSize + 24,
              overflowY: isProductGalleryExpanded ? "visible" : "hidden",
              overflowX: "hidden",
            }}
            ref={(el) => { setProductDropRef(el); productGalleryInnerRef.current = el; }}
          >
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
              // Product-gallery placeholder click opens the central add-media
              // modal in "product" mode — uploads queue, library picks land
              // on product.media, no external-video row.
              onOpenPicker={() => setPickerTarget({ mode: "product" })}
              localAltTexts={localAltTexts}
              isPrimaryLocale={isPrimaryLocale}
            />
          </div>
          {(productGalleryHasOverflow || isProductGalleryExpanded) && (
            <div
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                bottom: 0,
                transform: "translateY(50%)",
                display: "flex",
                justifyContent: "center",
                background: "white",
                borderRadius: 4,
                zIndex: 1,
              }}
            >
              <Button
                size="slim"
                variant="plain"
                onClick={() => setIsProductGalleryExpanded(e => !e)}
              >
                {isProductGalleryExpanded ? t.imageManager.showLess : t.imageManager.showAll}
              </Button>
            </div>
          )}
        </div>

        {/* Selection info bar for product gallery */}
        {selectedGalleryItems.size > 0 && (
          <div style={{ marginTop: (productGalleryHasOverflow || isProductGalleryExpanded) ? 20 : 6, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
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
                  const urlSetForCount = new Set(productSelectedUrls);
                  const gidSet = new Set(productSelectedUrls.map(url => urlToGid[url]).filter(Boolean));
                  const affectedVariantCount = variants.filter(v => {
                    const gids = pendingVariantGalleries[v.id] ?? v.galleryFileGids;
                    const inGallery = gids.some(gid => gidSet.has(gid));
                    const isMainImage = v.defaultImageUrl ? urlSetForCount.has(v.defaultImageUrl) : false;
                    return inGallery || isMainImage;
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
              // hasMainImage is true only when a native Shopify main image (defaultImageUrl) resolves
              // to a GID. Gallery-only images from the metafield are NOT a substitute — without a
              // native main image the section must show the placeholder and pulse warning.
              const hasMainImageForVariant = !locallyExcludedMainGids.has(v.id) && Boolean(mainGid);
              // effectiveGids is the ordered file-GID list the variant gallery
              // renders. Three cases:
              //   1. No main image (none on Shopify, or merchant locally excluded it):
              //      use storedGids as-is, with mainGid filtered out as a safety net.
              //   2. Legacy state: storedGids excludes mainGid (the metafield holds
              //      gallery items only). Prepend mainGid so it shows at position 0.
              //   3. Post-reorder state: storedGids ALREADY contains mainGid in some
              //      position (handleVariantReorder always pushes the full ordered
              //      list including mainGid). Use as-is and dedup defensively — DO
              //      NOT force mainGid back to slot 0, otherwise the merchant's
              //      drag to demote it would visually snap back.
              let effectiveGids: string[];
              if (!hasMainImageForVariant) {
                effectiveGids = mainGid ? storedGids.filter(g => g !== mainGid) : storedGids;
              } else if (mainGid && !storedGids.includes(mainGid)) {
                effectiveGids = [mainGid, ...storedGids];
              } else {
                // Dedup while preserving first-seen order (handles the rare
                // bug case where the metafield contained mainGid twice).
                const seen = new Set<string>();
                effectiveGids = storedGids.filter(g => {
                  if (seen.has(g)) return false;
                  seen.add(g);
                  return true;
                });
              }
              return (
              <VariantGallerySection
                key={v.id}
                variant={{
                  ...v,
                  galleryFileGids: effectiveGids,
                  // Inject the in-session pending order so a fresh reorder
                  // is reflected in displayUrls immediately. Without this,
                  // VariantGallerySection's orderedUrls memo reads the
                  // saved-but-stale variant.galleryOrderJson and the drag
                  // appeared to do nothing (especially obvious for mixed
                  // galleries — file reorders sneaked through the tail-
                  // append branch when no order JSON existed yet, but
                  // anything with a saved order or any non-file drop
                  // looked like a no-op).
                  galleryOrderJson: pendingGalleryOrder[v.id] ?? v.galleryOrderJson,
                }}
                hasMainImage={hasMainImageForVariant}
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
                externalVideoUrls={pendingExternalVideos[v.id] ?? v.externalVideoUrls ?? []}
                onAddExternalVideoUrl={handleAddExternalVideoUrl}
                onRemoveExternalVideoUrl={handleRemoveExternalVideoUrl}
                threeDModelUrls={pendingVariant3dModels[v.id] ?? v.threeDModelUrls ?? []}
                onRemoveThreeDModelUrl={handleRemoveThreeDModelUrl}
                onBrowseLibrary={() => setPickerTarget({ mode: "variant", variantId: v.id })}
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
    <FilePickerModal
      open={pickerTarget !== null}
      onClose={() => setPickerTarget(null)}
      onAdd={handleModalAdd}
      // External-video URLs work in both modes: variant scope persists to
      // the per-variant metafield, product scope adds an ExternalVideo node
      // to product.media via productCreateMedia EXTERNAL_VIDEO.
      onAddExternalUrl={handleModalAddExternalUrl}
      // Queue mode for both variant and product flows: the merchant wants
      // to see the upload land in the modal grid, optionally select / deselect
      // it, then click "Add" once. Immediate mode (used for variant uploads
      // earlier) auto-committed on xhr.onload → modal closed before the
      // merchant could confirm, which felt like a bug ("ich kam nicht zum
      // Knopf"). Queue is consistent across both modes now.
      uploadCommitMode="queue"
      // Models are now accepted in variant mode too — picked .glb URLs are
      // routed to custom.variant_3d_models (list.url) instead of the
      // variant_gallery file_reference metafield (which rejects Media3d).
      // disallowModel stays available as an API for callers that need to
      // hide 3D entirely; nothing in the merchant flow sets it today.
      disallowModel={false}
      currentProductId={productId}
      title={
        pickerTarget?.mode === "variant"
          ? (t.imageManager.addMediaToVariantTitle ?? "Add media to variant")
              .replace("{title}", variants.find(v => v.id === pickerTarget.variantId)?.title ?? "")
          : (t.imageManager.addMediaToProductTitle ?? "Add media to product")
      }
    />
    </DndContext>
  );
}
