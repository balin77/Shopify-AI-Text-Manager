import { useState, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { captureRemoved, reinsertRemoved, splitDeleteAnswer, removePendingNewMedia, queuedResourceUrls, stripRefsFromGalleries, unsentUrls, urlNeedsRestore, type RemovedEntry } from "./delete-rollback";
import { Text, Button, InlineStack, Spinner, Banner, Divider, Card, BlockStack, Tooltip } from "@shopify/polaris";
import { useFetcher } from "react-router";
import { DndContext, DragOverlay, closestCenter, pointerWithin, useDroppable, MouseSensor, TouchSensor, useSensor, useSensors, type CollisionDetection, type DragStartEvent, type DragOverEvent, type DragEndEvent } from "@dnd-kit/core";
import { arrayMove } from "@dnd-kit/sortable";
import { buildVariantEmission, displayMain, isImageGid, orderShowingMain, orderWithoutFiles, isFileKindGid, parseGalleryOrder, galleryWithout, visibleFileOrder, planVariantDrag, type DragEntry, type MainMove, type PendingMain, type RemovedMainEmission, type VariantGalleryEmission } from "../../services/variant-main-image.shared";
import { useI18n } from "../../contexts/I18nContext";
import { getLocalizedLanguageName } from "../../utils/contentEditor.utils";
import { answerPredatesSave, altConfirmKey, monotonicNow } from "./alt-load-guard";
import { useInfoBox } from "../../contexts/InfoBoxContext";
import { altTranslateSourceText, foreignAltLocked, knownPrimaryAlt, classifyAltSaveResponse, type AltSaveVerdict, classifyAltAiResponse, classifyAllLocalesResponse, enqueueAltSave, altSaveScope, type QueuedAltSave } from "../../services/alt-text-feedback.shared";
import { usePlan } from "../../contexts/PlanContext";
import { meetsPlan, getPlanDisplayName } from "../../utils/planUtils";
import { PULSE_SYNC_EPOCH } from "../../utils/contentEditor.utils";
import { TIMING } from "../../constants/timing";
import { DisabledActionTooltip } from "../DisabledActionTooltip";
import { useLocalizedMediaContext } from "../localized-images/LocalizedMediaContext";
import { LocalizedMediaReplaceButtons, LocalizedMediaNotReplaceable, LocalizedMediaOrphanNotice } from "../localized-images/LocalizedMediaReplaceButton";
import type { LocalizedMediaTile } from "../localized-images/useLocalizedMedia";
import { SortableImageGrid } from "./SortableImageGrid";
import { VariantGallerySection } from "./VariantGallerySection";
import { FilePickerModal, type AddedItem } from "./FilePickerModal";
import type { StagedItem, VariantWithGallery, ImageMeta, MediaKind } from "./types";
import { parseExternalVideoUrl, classifyFile, isWebpConvertible } from "../../utils/mediaKind";
import { isWebpWorkRow } from "../../config/webp-tasks.js";
import { uploadToStagedTarget } from "../../utils/staged-upload.client";
import { appFetch } from "../../utils/app-fetch";
import { splitLoadedAltTexts, altFieldView } from "./alt-market-layer";
import { planAltFlush, planImmediateAltSave, hasImmediateAltSave, restoreAltDrafts, revertAltDraftsWithoutPrimary, altFlushKey, createAltFlushWaiter, settleAltFlushWaiter, releaseAltFlushToken, transferAltFlushWaiter, altFlushSummary, selectAltSends, unsentAltDrafts, settledAltRenames, rekeyAltDrafts, altSaveInView, altDraftUrlsOfDeletedMedia, strandedAltDraftUrls, dropAltDrafts, partitionAltQueue, type AltDraftApi, type AltFlushSummary, type AltFlushWaiter, type SettlingAltSource } from "./alt-draft";
import { fileTilesByUrl, gidForUrl, tilesByUrl, isModel3dGid, variantHoldsMedium } from "./url-gid";
import { altSuggestionInView, altSuggestionsOfProduct, planAcceptAltSuggestion, shouldTranslateAfterSave, withAltSuggestion, withoutAltSuggestion, type AltSuggestionMap } from "./alt-suggestion";
import { AISuggestionBanner } from "../AISuggestionBanner";
import { AutoGrowTextarea } from "../unified/AutoGrowTextarea";
import {
  settlingPollDelayMs,
  unsettledMediaEntries,
  resolvedMediaIds,
  type SettlingMediaEntry,
} from "./settling-media";

// Prefer sortable items (compound id '::') over plain container droppables;
// fall back to closestCenter when pointer is outside all droppables.
/** A variants read that failed (the limiter's 429 under fast clicking, a network blip) is tried again
 *  by itself after these pauses, so the galleries come back without the merchant leaving the product. */
export const VARIANTS_RETRY_DELAYS_MS = [3000, 8000, 20000];

const imageManagerCollision: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  // No closestCenter fallback: releasing in genuine empty space must abort
  // the drag, not snap to the nearest tile.
  if (hits.length === 0) return [];
  const sourceContainer = args.active.data.current?.containerId as string | undefined;
  const itemHits = hits.filter(({ id }) => (id as string).includes("::"));
  const containerHits = hits.filter(({ id }) => !(id as string).includes("::"));
  if (sourceContainer) {
    if (sourceContainer === "product") {
      // Product source: prefer cross-container targets so a drop landing
      // on a variant tile (with an overlapping product tile underneath
      // from pointerWithin's stacked hits) routes to the variant. Without
      // this, the product tile won the tie and the handler fell into the
      // within-product reorder branch instead of product→variant copy —
      // the merchant saw the dragged image rearrange inside product
      // ("disappears from where it was") and never arrive in the variant.
      const nonSource = itemHits.filter(({ id }) =>
        !(id as string).startsWith("product::")
      );
      if (nonSource.length > 0) return nonSource;
    } else {
      // Variant source: prefer same-variant items so a small variant
      // gallery's reorder doesn't get hijacked by an overlapping product
      // tile underneath.
      const sameContainerItems = itemHits.filter(({ id }) =>
        (id as string).startsWith(sourceContainer + "::")
      );
      if (sameContainerItems.length > 0) return sameContainerItems;
      // No same-variant tile under cursor — accept any cross-container item.
      const nonSource = itemHits.filter(({ id }) =>
        !(id as string).startsWith(sourceContainer + "::")
      );
      if (nonSource.length > 0) return nonSource;
    }
  }
  if (itemHits.length > 0) return itemHits;
  // No item hits — only containers. Prefer non-source containers so a
  // cross-gallery drop on whitespace isn't hijacked by the source's own
  // overlapping container droppable.
  if (sourceContainer) {
    const nonSource = containerHits.filter(({ id }) => id !== sourceContainer);
    if (nonSource.length > 0) return nonSource;
  }
  return containerHits;
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
  onPendingChange?: (variantGalleries: VariantGalleryEmission[], mediaOrder: Array<{ mediaId: string; position: number }>, productNewMedia?: Array<{ resourceUrl: string; kind: MediaKind; previewUrl?: string }>, removedMainImages?: RemovedMainEmission[], mainMoves?: MainMove[]) => void;
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
  /** Media Shopify has already created for this product (productCreateMedia
   *  returned the GID) but has not finished processing. `/api/product-variants`
   *  can only report media that HAS a URL, so between the save and the end of
   *  Shopify's processing the entry is missing from every fetched map — which
   *  is exactly why a fresh upload used to vanish from the gallery until a
   *  page reload. We keep rendering the local preview under the real GID and
   *  poll until the GID appears. Owned by useVariantImageManager. */
  settlingMedia?: SettlingMediaEntry[];
  /** Reports the settling media that has since shown up (or belongs to another
   *  product) so the hook can drop it from its list. */
  onSettlingMediaResolved?: (mediaIds: string[]) => void;
  /** Reports whether a product-image delete is in flight. The parent blocks
   *  the editor's Save meanwhile: the optimistic exclusion is already emitted,
   *  so a save during a delete that then fails would clear variant main images
   *  on Shopify for media that still exists. */
  onDeletingChange?: (deleting: boolean) => void;
  /** Full view (the whole manager over the editor's content area) instead of the product-image preview.
   *  The owner may hold the state so the editor can hide its text fields; absent = the manager keeps its own. */
  fullView?: boolean;
  onFullViewChange?: (open: boolean) => void;
  resetKey?: number;
  variantReloadKey?: number;
  currentLanguage?: string;
  primaryLocale?: string;
  /**
   * The market whose translation layer the open foreign language shows ("" or
   * absent = the global layer). Foreign alt texts are read from and saved to
   * THAT layer; "translate to all languages" stays global, like the editor's.
   */
  selectedMarketId?: string;
  productTitle?: string;
  enabledLanguages?: string[];
  onDirtyChange?: (isDirty: boolean) => void;
  /** Every alt-text save response, so the editor can watch the background
   *  re-translation a primary alt change starts (it carries its task ids). */
  onSaveResponse?: (response: unknown) => void;
  /** Filled by the manager with the two calls the editor's save bar needs for
   *  the alt-text DRAFTS: `flush` (send every dirty alt) and `discard`. */
  altDraftApiRef?: React.MutableRefObject<AltDraftApi | null>;
  /** True while alt saves the merchant already pressed Save for are still out
   *  (queued or in flight; a draft carried over until a new image exists is
   *  not counted -- it would hold the save bar for the whole processing). */
  onAltSavingChange?: (saving: boolean) => void;
  /** True while an alt save an AI button sent AT ONCE (generate / translate)
   *  is queued or in flight -- the only alt save a view switch waits for. */
  onImmediateAltSavingChange?: (saving: boolean) => void;
  onMissingMainImageChange?: (hasMissing: boolean) => void;
  onProductImagesRefreshed?: (productId: string, images: ProductImageRef[]) => void;
  onGallerySelectionGidsChange?: (gids: string[]) => void;
  /** Bumped by the editor when a background re-translation finished and the
   *  loader was reloaded: the foreign alt texts are re-read from the database. */
  backgroundRefreshVersion?: number;
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
  settlingMedia,
  onSettlingMediaResolved,
  resetKey,
  fullView: fullViewProp,
  onFullViewChange,
  onDeletingChange,
  variantReloadKey,
  currentLanguage,
  primaryLocale,
  selectedMarketId = "",
  productTitle,
  enabledLanguages = [],
  onDirtyChange,
  onSaveResponse,
  altDraftApiRef,
  onAltSavingChange,
  onImmediateAltSavingChange,
  onMissingMainImageChange,
  onProductImagesRefreshed,
  onGallerySelectionGidsChange,
  onExternalVideosChange,
  onThreeDModelsChange,
  onThreeDPreviewsChange,
  seedThreeDModelUrls,
  seedThreeDPreviewUrls,
  onGalleryOrderChange,
  backgroundRefreshVersion = 0,
}: VariantImageManagerProps) {
  const { t, locale: appLocale } = useI18n();
  const { plan } = usePlan();
  // Alt-text translation needs at least one foreign locale. Without one the
  // buttons stay visible but greyed out, with this as their tooltip.
  const singleLocaleHint = enabledLanguages.filter(l => l !== primaryLocale).length > 0
    ? undefined
    : t.common?.requiresSecondLanguage;
  // WebP conversion bills a monthly image-operation per image (Pro+ only —
  // free/basic have monthlyImageOperations=0 which the server already
  // rejects). Disable the button + show a plan hint so the merchant doesn't
  // click into a server error.
  const webpAllowed = meetsPlan(plan, "pro");
  const webpPlanNote = (t.imageManager.webpRequiresPlan ?? "Requires the {plan} plan.").replace(
    "{plan}",
    getPlanDisplayName("pro"),
  );
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
  // Main images the merchant removed this session (deleted the medium, or moved it to the
  // product gallery): variantId -> the GID that was removed. The OLD value is the point: a
  // removal acts only while the variant's main image still is that GID (see
  // `locallyExcludedMainGids` below), so a refetch that brings the promoted image ends it
  // by itself and a replayed save can never remove a second main image.
  const [removedMains, setRemovedMains] = useState<Record<string, string>>({});
  // Explicit intent: an image dragged to the FIRST slot of the variant's own gallery
  // (variantId -> the new main image and the main image shown when it was dragged). Set
  // by that one branch of the drag handler and by nothing else; Discard, a save and a
  // product switch clear it.
  const [pendingMains, setPendingMains] = useState<Record<string, PendingMain>>({});
  // Explicit intent: a main image MOVED to another variant (plain drag of the main image onto another
  // variant's gallery). It ties the source's removal and the target's list together so the server writes
  // both or neither. Discard, a save and a product switch clear it; it ends by itself once either side
  // is not pending any more (`effectiveMoves`).
  const [pendingMoves, setPendingMoves] = useState<MainMove[]>([]);
  const [pendingProductNewMedia, setPendingProductNewMedia] = useState<Array<{ resourceUrl: string; kind: MediaKind; previewUrl?: string }>>([]);
  const [webpError, setWebpError] = useState<string | null>(null);
  // A media write (delete, upload) the server refused; shown above the gallery.
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [isConvertingWebP, setIsConvertingWebP] = useState(false);
  // GIDs (mediaId) of images currently being converted; cleared when done.
  // Tracked by GID rather than URL because Shopify CDN URLs can change query params between
  // task creation and a fresh image fetch, causing URL-based lookups to miss still-running images.
  const [convertingImageUrls, setConvertingImageUrls] = useState<Set<string>>(new Set());
  const [refreshedProductImages, setRefreshedProductImages] = useState<ProductImageRef[] | null>(null);
  // Re-arm trigger + budget for the settling-media poll (see below).
  const [settlingPollTick, setSettlingPollTick] = useState(0);
  const settlingPollAttemptRef = useRef(0);
  const prevUnsettledKeyRef = useRef("");
  const [deleteConfirm, setDeleteConfirm] = useState<{ urls: string[]; affectedVariantCount: number } | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  useEffect(() => {
    onDeletingChange?.(isDeleting);
  }, [isDeleting]); // eslint-disable-line react-hooks/exhaustive-deps
  // Never leave the parent's save blocked if this component goes away mid-delete.
  useEffect(() => () => onDeletingChange?.(false), []); // eslint-disable-line react-hooks/exhaustive-deps
  const webpPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const currentImagesRef = useRef<ProductImageRef[]>([]);
  const isConvertingWebPRef = useRef(false);
  const prevConvertingGidsRef = useRef<Set<string>>(new Set());
  const prevProductImagesKeyRef = useRef<string>("");
  const stagedUrlCheckedProductIdRef = useRef<string | null>(null);
  const onProductImagesRefreshedRef = useRef(onProductImagesRefreshed);
  useEffect(() => { onProductImagesRefreshedRef.current = onProductImagesRefreshed; }, [onProductImagesRefreshed]);
  // Normal view = only the product images as a preview; full view = the whole manager over the
  // editor's content area (round 3, point 3). The view is a CSS switch on mounted content, never an
  // unmount, so drafts, running saves and refs survive. The owner (the products page) may hold the
  // state so the editor can hide its text fields; without an owner the manager keeps its own.
  const [localFullView, setLocalFullView] = useState(false);
  const fullView = fullViewProp ?? localFullView;
  const setFullView = (next: boolean) => { if (onFullViewChange) onFullViewChange(next); else setLocalFullView(next); };
  const managerRootRef = useRef<HTMLDivElement | null>(null);
  const savedScrollRef = useRef(0);
  const prevFullViewRef = useRef(fullView);
  const scrollerOf = () => managerRootRef.current?.closest(".field-editor-area") as HTMLElement | null;
  const openFullView = () => {
    savedScrollRef.current = scrollerOf()?.scrollTop ?? 0;
    setFullView(true);
  };
  const closeFullView = () => setFullView(false);
  // Scroll and focus follow the switch: opening starts at the top with the close button focused, closing
  // puts the page back where it was and focuses the button that opened it.
  useLayoutEffect(() => {
    if (prevFullViewRef.current === fullView) return;
    prevFullViewRef.current = fullView;
    const scroller = scrollerOf();
    const root = managerRootRef.current;
    if (fullView) {
      if (scroller) scroller.scrollTop = 0;
      root?.querySelector<HTMLElement>("[data-im-close] button")?.focus();
    } else {
      if (scroller) scroller.scrollTop = savedScrollRef.current;
      root?.querySelector<HTMLElement>("[data-im-open] button")?.focus();
    }
  }, [fullView]);
  const [showAll, setShowAll] = useState(true);
  const [thumbSize, setThumbSize] = useState(imageManagerSettings.thumbSize ?? 80);
  const thumbSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fetcher = useFetcher();
  // Alt text editing state
  const [localAltTexts, setLocalAltTexts] = useState<Record<string, string>>({});
  // Values the open market inherits from the global layer: shown as a
  // placeholder, never as the field's value (see alt-market-layer.ts).
  const [inheritedAltTexts, setInheritedAltTexts] = useState<Record<string, string>>({});
  const altTextFetcher = useFetcher<any>();          // generate / translate (returns text)
  const saveAltTextFetcher = useFetcher<any>();      // save (writes to Shopify)
  const { showInfoBox } = useInfoBox();
  const localAltTextsRef = useRef<Record<string, string>>({});
  localAltTextsRef.current = localAltTexts;
  const primaryLocaleRef = useRef(primaryLocale);
  primaryLocaleRef.current = primaryLocale;
  const currentLanguageRef = useRef(currentLanguage);
  currentLanguageRef.current = currentLanguage;
  // The market layer the open view writes to ("" = global / primary language).
  const viewMarketRef = useRef("");
  const timedOutAltSaveRef = useRef<QueuedAltSave | null>(null);
  // Alt saves are SERIALISED over the one fetcher: a second save fired before
  // the first answer landed used to drop that answer, and with it the task ids
  // of the re-translation the first one started. One in flight, the rest queued.
  const altSaveInFlightRef = useRef<QueuedAltSave | null>(null);
  const altSaveQueueRef = useRef<QueuedAltSave[]>([]);
  const altSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const altSaveSawBusyRef = useRef(false);
  const lastHandledSaveDataRef = useRef<unknown>(null);
  // Images whose last save FAILED: their text stays in the field as a DRAFT
  // (still dirty, so the save bar stays up and the next Save retries it) and is
  // not overwritten by a reload.
  const failedAltUrlsRef = useRef(new Set<string>());
  // What each edited image's own alt was BEFORE its first edit (undefined = it
  // had no own value): Discard puts exactly that back.
  const altBaselinesRef = useRef(new Map<string, string | undefined>());
  // When each draft was last edited: one medium shown under two urls (product
  // gallery and a variant gallery) is saved ONCE, with the latest edit.
  const altEditOrderRef = useRef(new Map<string, number>());
  const altEditSeqRef = useRef(0);
  // Tile urls that changed under a save (an upload's preview url -> its real
  // url once Shopify has the image): a late answer finds its draft again.
  const altUrlRenamesRef = useRef(new Map<string, string>());
  const resolveAltUrl = (url: string) => {
    let cur = url;
    for (let i = 0; i < 5 && altUrlRenamesRef.current.has(cur); i++) cur = altUrlRenamesRef.current.get(cur)!;
    return cur;
  };
  // Drafts of images the same page Save is only UPLOADING: no media id yet, so
  // they are carried over and sent once the image exists (see the effect that
  // resolves them). `token` is what the page Save waits for meanwhile.
  const deferredAltRef = useRef(new Map<string, { draft: Omit<QueuedAltSave, "mediaId">; token: object; applied: "running" | "done" }>());
  const [deferredAltTick, setDeferredAltTick] = useState(0);
  // Set further down: the settling poll calls it when it gives up.
  const releaseStuckDeferredAltsRef = useRef<(() => void) | null>(null);
  // Page Saves waiting for their alt saves to be answered.
  const altFlushWaitersRef = useRef<Array<{ waiter: AltFlushWaiter; resolve: (s: AltFlushSummary) => void }>>([]);
  /** Records an answer (or a release) for every waiter and wakes the ones that are complete. */
  const settleAltTokens = (apply: (w: AltFlushWaiter) => boolean) => {
    if (altFlushWaitersRef.current.length === 0) return;
    const still: typeof altFlushWaitersRef.current = [];
    for (const w of altFlushWaitersRef.current) {
      if (apply(w.waiter)) w.resolve(altFlushSummary(w.waiter));
      else still.push(w);
    }
    altFlushWaitersRef.current = still;
  };
  /** Saves that will never be answered (Discard, a gallery save that failed): they count as unsent. */
  const releaseAltTokens = (tokens: readonly object[]) => {
    if (tokens.length === 0) return;
    settleAltTokens((w) => {
      for (const token of tokens) releaseAltFlushToken(w, token);
      return w.pending.size === 0;
    });
  };
  // Saves the merchant pressed Save for that are being SENT: the page shows
  // its Save as busy meanwhile. A draft carried over until its new image
  // exists does not count: Shopify may process the image for most of a
  // minute, and holding the whole save bar busy for that would block every
  // unrelated save. It is still sent once the image settles, and a switch
  // still counts it as pressed-Save (not as an unsent draft).
  const altSavingRef = useRef(false);
  const immediateAltSavingRef = useRef(false);
  const syncAltSaving = () => {
    // The AI buttons' own saves, separately: only those refuse a view switch.
    const immediate = hasImmediateAltSave(altSaveInFlightRef.current, altSaveQueueRef.current);
    if (immediate !== immediateAltSavingRef.current) {
      immediateAltSavingRef.current = immediate;
      onImmediateAltSavingChange?.(immediate);
    }
    const busy = !!altSaveInFlightRef.current || altSaveQueueRef.current.length > 0;
    if (busy === altSavingRef.current) return;
    altSavingRef.current = busy;
    onAltSavingChange?.(busy);
  };
  // When each image's own alt was last CONFIRMED saved, and when the open
  // load request was made: an answer requested before a save must not undo it.
  const altConfirmedAtRef = useRef(new Map<string, number>());
  const reloadForeignAltsRef = useRef<() => void>(() => undefined);
  const altLoadRequestedAtRef = useRef(0);
  // Re-render on a dirty change too (the translate-to-all button reads it).
  const [, setAltDirtyVersion] = useState(0);
  const syncAltDirty = useCallback(() => {
    setAltDirtyVersion((v) => v + 1);
    onDirtyChange?.(dirtyUrlsRef.current.size > 0);
  }, [onDirtyChange]);
  const settleAltSave = useCallback((entry: QueuedAltSave, verdict: AltSaveVerdict) => {
    // Wake the page Save that sent this one (it reports only what was confirmed).
    settleAltTokens((w) => settleAltFlushWaiter(w, entry, verdict.kind === "saved"));
    const scope = altSaveScope(entry, { productId: productIdRef.current, locale: currentLanguageRef.current, marketId: viewMarketRef.current });
    const { sameProduct } = scope;
    // The text only stays in the field where the view still shows exactly the
    // language AND market it was typed for.
    const sameLocale = scope.sameLocale && scope.sameMarket;
    const url = resolveAltUrl(entry.url);
    if (verdict.kind === "saved") {
      if (sameProduct) {
        altConfirmedAtRef.current.set(altConfirmKey(url, entry.locale, entry.marketId), monotonicNow());
      }
      // Only the view the save was made for has its draft state touched: a
      // save of another language or market must not clear (or re-baseline) a
      // draft of the same image the merchant is editing now.
      if (sameProduct && sameLocale) {
        const settleUrl = (tileUrl: string, plannedText: string, savedText: string) => {
          failedAltUrlsRef.current.delete(tileUrl);
          const current = localAltTextsRef.current[tileUrl];
          if (current === undefined || current === plannedText) {
            dirtyUrlsRef.current.delete(tileUrl);
            altBaselinesRef.current.delete(tileUrl);
            if (current !== undefined && current !== savedText) {
              // A second tile of the same medium: it shows what was saved.
              localAltTextsRef.current = { ...localAltTextsRef.current, [tileUrl]: savedText };
              setLocalAltTexts((p) => ({ ...p, [tileUrl]: savedText }));
            }
          } else {
            // Typed on after the save was sent: still a draft, but its way back is now the saved text.
            altBaselinesRef.current.set(tileUrl, savedText);
          }
        };
        settleUrl(url, entry.altText, entry.altText);
        for (const alias of entry.aliases ?? []) settleUrl(resolveAltUrl(alias.url), alias.altText, entry.altText);
        syncAltDirty();
      }
      // "Accept & Translate": the translation starts only now that the
      // primary alt is CONFIRMED saved; a failed save never reaches here.
      if (shouldTranslateAfterSave(entry, verdict.kind, productIdRef.current, primaryLocaleRef.current)) translateAfterAcceptRef.current(entry);
      return;
    }
    if (verdict.kind === "noPrimary") {
      // The image has no alt text in the PRIMARY language, so Shopify offers
      // nothing to translate and no retry could ever store this text. Kept as
      // a failed draft it would hold the save bar open for good, so the field
      // goes back to what this language (and market) holds and the message
      // says what to do instead -- the editor's own rule for the same case.
      if (sameProduct && sameLocale) {
        const plan = revertAltDraftsWithoutPrimary({
          texts: localAltTextsRef.current,
          baselines: altBaselinesRef.current,
          planned: [
            { url, altText: entry.altText },
            ...(entry.aliases ?? []).map((a) => ({ url: resolveAltUrl(a.url), altText: a.altText })),
          ],
        });
        for (const u of plan.reverted) {
          failedAltUrlsRef.current.delete(u);
          dirtyUrlsRef.current.delete(u);
          altBaselinesRef.current.delete(u);
        }
        if (plan.reverted.length > 0) {
          localAltTextsRef.current = plan.texts;
          setLocalAltTexts(plan.texts);
        }
        syncAltDirty();
      }
      const needsPrimary = String(
        t.imageManager?.altSaveNeedsPrimary
          ?? "This alt text was not saved: the image has no alt text in the main language yet. Enter and save one there first, then it can be translated.",
      );
      showInfoBox(!sameProduct && entry.productTitle ? `${entry.productTitle}: ${needsPrimary}` : needsPrimary, "warning");
      return;
    }
    if (sameProduct && sameLocale) {
      // A failed save is a draft that was not written: it stays dirty (the save
      // bar stays up, the next Save sends it again) and is kept over a reload.
      failedAltUrlsRef.current.add(url);
      for (const alias of entry.aliases ?? []) failedAltUrlsRef.current.add(resolveAltUrl(alias.url));
      syncAltDirty();
    }
    const im = t.imageManager;
    let text: string;
    if (!sameLocale) {
      text = String(
        (scope.sameLocale ? im?.altSaveFailedOtherMarket : im?.altSaveFailedOtherLanguage) ?? "The alt text for {locale} could not be saved.",
      ).replace("{locale}", entry.locale ? getLocalizedLanguageName(String(entry.locale), appLocale) : "");
    } else if (verdict.message) {
      text = String(im?.altSaveFailedWithReason ?? "The alt text could not be saved: {error}").replace("{error}", verdict.message);
    } else {
      text = String(im?.altSaveFailed ?? "The alt text could not be saved. Your text is kept, please try again.");
    }
    showInfoBox(!sameProduct && entry.productTitle ? `${entry.productTitle}: ${text}` : text, "critical");
  }, [t, appLocale, showInfoBox, syncAltDirty]); // eslint-disable-line react-hooks/exhaustive-deps
  const dispatchNextAltSave = useCallback(() => {
    if (altSaveInFlightRef.current) return;
    const next = altSaveQueueRef.current.shift();
    if (!next) {
      syncAltSaving();
      return;
    }
    altSaveInFlightRef.current = next;
    syncAltSaving();
    altSaveSawBusyRef.current = false;
    const form = new FormData();
    form.append("action", "saveImageAltText");
    form.append("mediaId", next.mediaId);
    form.append("altText", next.altText);
    if (next.locale) form.append("locale", next.locale);
    // A market save belongs to that market's layer; the server refuses a
    // market on the primary locale, so it only rides foreign saves.
    if (next.marketId && next.locale && next.locale !== primaryLocaleRef.current) form.append("marketId", next.marketId);
    if (primaryLocaleRef.current) form.append("primaryLocale", primaryLocaleRef.current);
    // The product the save was made on: its own image row is the mirror target
    // (one medium may be cached under several products).
    if (next.productId) form.append("productId", next.productId);
    saveAltTextFetcher.submit(form, { method: "post" });
    // A stuck request must not stall the queue for good.
    if (altSaveTimerRef.current) clearTimeout(altSaveTimerRef.current);
    altSaveTimerRef.current = setTimeout(() => {
      if (altSaveInFlightRef.current !== next) return;
      altSaveInFlightRef.current = null;
      // The request is not aborted: remember it, a late success is still settled.
      timedOutAltSaveRef.current = next;
      // A save that timed out never starts the translate, even if it answers late.
      next.thenTranslateAll = false;
      settleAltSave(next, { kind: "failed", message: "" });
      dispatchNextAltSave();
    }, 90000);
  }, [saveAltTextFetcher, settleAltSave]); // eslint-disable-line react-hooks/exhaustive-deps
  const finishAltSave = useCallback((verdict: AltSaveVerdict) => {
    const entry = altSaveInFlightRef.current;
    altSaveInFlightRef.current = null;
    if (altSaveTimerRef.current) { clearTimeout(altSaveTimerRef.current); altSaveTimerRef.current = null; }
    if (entry) settleAltSave(entry, verdict);
    dispatchNextAltSave();
  }, [settleAltSave, dispatchNextAltSave]);
  useEffect(() => () => { if (altSaveTimerRef.current) clearTimeout(altSaveTimerRef.current); }, []);
  // A primary alt save may start a detached re-translation; hand its task ids
  // to the editor's one watcher, or the foreign views never refresh. The
  // verdict decides the dirty flag: it clears ONLY on a confirmed save, and a
  // fetcher that ends without any new answer (network error, rate limit,
  // re-auth) counts as a failure instead of stalling the queue.
  useEffect(() => {
    if (saveAltTextFetcher.state !== "idle") {
      altSaveSawBusyRef.current = true;
      return;
    }
    const data = saveAltTextFetcher.data;
    if (!altSaveInFlightRef.current) {
      const late = timedOutAltSaveRef.current;
      if (late && data && data !== lastHandledSaveDataRef.current) {
        lastHandledSaveDataRef.current = data;
        timedOutAltSaveRef.current = null;
        // Its task ids must reach the watcher; a confirmed save clears the failure.
        onSaveResponse?.(data);
        const verdict = classifyAltSaveResponse(data);
        if (verdict.kind === "saved") {
          settleAltSave(late, verdict);
          // The timeout already told the merchant it failed: correct that.
          showInfoBox(
            String(t.imageManager?.altSaveLateSuccess ?? "The alt text was saved after all."),
            "success",
          );
        }
      }
      return;
    }
    if (data && data !== lastHandledSaveDataRef.current) {
      lastHandledSaveDataRef.current = data;
      timedOutAltSaveRef.current = null;
      onSaveResponse?.(data);
      finishAltSave(classifyAltSaveResponse(data));
      // A changed primary alt of a library file deleted its foreign alt
      // translations on the server: the open foreign view re-reads, or it keeps
      // showing text that no longer exists (a no-op in the primary view).
      if (data.success && Array.isArray(data.libraryAltsPurged) && data.libraryAltsPurged.length > 0) {
        reloadForeignAltsRef.current();
      }
      // Saved on Shopify, but the local mirror the editors render from could
      // not be written: said, not swallowed (the next load would show nothing).
      if (data.success && data.notMirrored) {
        showInfoBox(
          String(t.imageManager?.altSavedNotMirrored ?? "The alt text is saved in Shopify but could not be stored in the app. It will reappear after a sync."),
          "warning",
        );
      }
      return;
    }
    if (altSaveSawBusyRef.current) finishAltSave({ kind: "failed", message: "" });
  }, [saveAltTextFetcher.state, saveAltTextFetcher.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const submitAltSave = useCallback((entry: QueuedAltSave) => {
    // A queued save of the same medium is REPLACED by this newer one: whoever
    // waited for it now waits for the newer one (which writes the latest text).
    const key = altFlushKey(entry);
    const replaced = altSaveQueueRef.current.filter((q) => altFlushKey(q) === key);
    if (replaced.length > 0) {
      for (const w of altFlushWaitersRef.current) for (const r of replaced) transferAltFlushWaiter(w.waiter, r, entry);
    }
    altSaveQueueRef.current = enqueueAltSave(altSaveQueueRef.current, entry);
    dispatchNextAltSave();
    // Queued behind one already in flight: dispatch returned early, so the
    // busy signals (an AI button's immediate save among them) are synced here.
    syncAltSaving();
  }, [dispatchNextAltSave]); // eslint-disable-line react-hooks/exhaustive-deps
  /** True while a text of this image must not be overwritten by a reload. */
  const isAltUrlBusy = (url: string) =>
    (altSaveInFlightRef.current ? resolveAltUrl(altSaveInFlightRef.current.url) === url : false) ||
    altSaveQueueRef.current.some((q) => resolveAltUrl(q.url) === url) ||
    failedAltUrlsRef.current.has(url) ||
    (dirtyUrlsRef.current.has(url) && localAltTextsRef.current[url] !== undefined);
  // …and the SKU-generated alts, which ride the general fetcher. A response
  // without task ids is ignored by the watcher, so forwarding every one is safe.
  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    onSaveResponse?.(fetcher.data);
    // The SKU generator's primary write may have deleted a library file's
    // foreign alt translations: re-read the open foreign view.
    const purged = (fetcher.data as { libraryAltsPurged?: unknown }).libraryAltsPurged;
    if (Array.isArray(purged) && purged.length > 0) reloadForeignAltsRef.current();
  }, [fetcher.state, fetcher.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const translationsFetcher = useFetcher<any>();     // load foreign locale alt texts from DB
  const prevAltFetcherData = useRef<any>(null);
  // ✨ generate's results waiting for the merchant's decision, per (product,
  // language, market, medium) -- never a save-bar draft, see alt-suggestion.ts.
  const [altSuggestions, setAltSuggestions] = useState<AltSuggestionMap>({});
  // Starts the translate-to-all of an "Accept & Translate" once its save is
  // confirmed (assigned every render; the settle callback is not re-created).
  const translateAfterAcceptRef = useRef<(entry: QueuedAltSave) => void>(() => undefined);
  useEffect(() => {
    // A product switch drops every other product's pending suggestions.
    setAltSuggestions((m) => altSuggestionsOfProduct(m, productId));
  }, [productId]);
  // What the single in-flight generate / translate request was made FOR (image,
  // language, product): the reply is applied to that, never to a position.
  const altAiRequestRef = useRef<{ url: string; mediaId?: string; locale?: string; marketId?: string; productId: string } | null>(null);
  // The market layer a foreign-language edit is written to ("" = global).
  const foreignMarketId = currentLanguage && currentLanguage !== primaryLocale ? selectedMarketId || undefined : undefined;
  viewMarketRef.current = foreignMarketId ?? "";
  // Images whose alt text is an unsaved DRAFT (typed, generated or translated):
  // the editor's one save bar sends them (see flushAltDrafts).
  const dirtyUrlsRef = useRef(new Set<string>());
  // Track current media order so we can include it whenever variant galleries change
  const pendingMediaOrderRef = useRef<Array<{ mediaId: string; position: number }>>([]);
  // True once the sync effect has emitted a non-empty pending state to the parent.
  const emittedPendingRef = useRef(false);
  // Always the CURRENT product, so an in-flight delete can tell the merchant switched away.
  const productIdRef = useRef(productId);
  productIdRef.current = productId;
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
  // The product whose variants the list below currently holds. A re-read of THAT product (after a
  // save, an alt template apply, ...) must not swap the list for the spinner: that unmounted every
  // variant gallery, so each one closed again and the page jumped. Only a different product (or
  // none loaded yet) shows the spinner.
  const variantsLoadedForRef = useRef<string | null>(null);
  const variantsRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const variantsRetryAttemptRef = useRef(0);
  const fetchVariantsRef = useRef<((pid: string, resetState: boolean) => void) | null>(null);
  useEffect(() => () => { if (variantsRetryTimerRef.current) clearTimeout(variantsRetryTimerRef.current); }, []);
  // The variants of the open product are known (read and landed): until then a save must not act on
  // them and nothing may be written or cleared for a variant the editor knows nothing about.
  const variantsKnown = variantsLoadedForRef.current === productId && !isLoadingVariants && !variantError;
  const variantsAbortRef = useRef<AbortController | null>(null);

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
    setRemovedMains({});
    setPendingMains({});
    setPendingMoves([]);
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
    setMediaError(null);
    setWebpError(null);
    // The alt-text drafts are NOT touched here: this key also bumps after every
    // gallery save, and a failed alt must stay a draft. A product / language /
    // market switch drops them in the effect below, Discard through the api ref.
  }, [resetKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reload variant data (e.g. after alt text templates are applied) without clearing pending state
  useEffect(() => {
    if (!variantReloadKey || !productId) return;
    fetchVariantsForProduct(productId, false);
  }, [variantReloadKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load foreign-locale alt text translations from DB when language changes
  // or after a bulk apply (variantReloadKey bump) so freshly saved translations show up.
  const lastBgRefreshRef = useRef(backgroundRefreshVersion);
  // The market only matters for the layer it selects: a FOREIGN language's.
  // Primary alts are global, so a market change there is no view change and
  // must not drop (or re-read over) the primary drafts.
  const altLayerMarket = foreignMarketId ?? "";
  const altViewRef = useRef({ productId, currentLanguage, altLayerMarket });
  const altLoadKeysRef = useRef<{ variantReloadKey: unknown; galleryMediaIdsKey: string }>({ variantReloadKey, galleryMediaIdsKey: "" });
  // The MediaImage GIDs the galleries show (Shopify's live media map: product
  // media AND media-library files picked into a variant gallery). A library
  // file has no ProductImage row, so its alt translations live in another
  // store the server only reads for GIDs it is named -- sent with every load,
  // and a changed SET re-reads (the map arrives after the first load).
  const galleryMediaIdsKey = useMemo(
    () => Object.keys(shopifyMediaMap).filter((gid) => gid.startsWith("gid://shopify/MediaImage/")).sort().join(","),
    [shopifyMediaMap],
  );
  useEffect(() => {
    // A background refresh only RE-READS: text the merchant is typing or a save
    // that failed must survive it.
    const isBackgroundRefresh = lastBgRefreshRef.current !== backgroundRefreshVersion;
    lastBgRefreshRef.current = backgroundRefreshVersion;
    // Only the gallery's MediaImage set moved (the media map arrived or a
    // tile settled), with no reload asked for: on the PRIMARY locale there is
    // nothing to re-read (the load below is foreign-only), so the primary
    // values typed or shown must not be cleared for it.
    const prevLoadKeys = altLoadKeysRef.current;
    altLoadKeysRef.current = { variantReloadKey, galleryMediaIdsKey };
    const onlyMediaSetChanged =
      prevLoadKeys.variantReloadKey === variantReloadKey && prevLoadKeys.galleryMediaIdsKey !== galleryMediaIdsKey;
    const prevView = altViewRef.current;
    const viewChanged = prevView.productId !== productId || prevView.currentLanguage !== currentLanguage || prevView.altLayerMarket !== altLayerMarket;
    altViewRef.current = { productId, currentLanguage, altLayerMarket };
    if (viewChanged) {
      // Another product, language or market: the drafts belonged to the view
      // that is gone (the editor confirms the switch while any are unsent).
      // The save QUEUE is not touched: each queued save carries its own
      // product, language and market, and the merchant already pressed Save
      // for it -- a switch must not silently take it back. The same holds for
      // a draft carried over until its new image exists.
      setLocalAltTexts({});
      localAltTextsRef.current = {};
      setInheritedAltTexts({});
      failedAltUrlsRef.current.clear();
      altBaselinesRef.current.clear();
      altEditOrderRef.current.clear();
      if (dirtyUrlsRef.current.size > 0) {
        dirtyUrlsRef.current.clear();
        onDirtyChange?.(false);
      }
    } else if (!isBackgroundRefresh && !(onlyMediaSetChanged && (!currentLanguage || currentLanguage === primaryLocale))) {
      // A plain reload (a gallery save, a bulk apply): the server's answer
      // replaces what is shown, except what the merchant still has as a draft.
      setLocalAltTexts((prev) => Object.fromEntries(Object.entries(prev).filter(([url]) => isAltUrlBusy(url))));
      setInheritedAltTexts({});
    }
    if (!productId || !currentLanguage || currentLanguage === primaryLocale) return;
    const form = new FormData();
    form.append("action", "loadImageAltTranslations");
    form.append("productId", productId);
    form.append("locale", currentLanguage);
    if (selectedMarketId) form.append("marketId", selectedMarketId);
    if (galleryMediaIdsKey) form.append("mediaIds", JSON.stringify(galleryMediaIdsKey.split(",")));
    altLoadRequestedAtRef.current = monotonicNow();
    translationsFetcher.submit(form, { method: "post" });
  }, [currentLanguage, productId, variantReloadKey, backgroundRefreshVersion, altLayerMarket, galleryMediaIdsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-read the open language's alt texts after the server wrote foreign values.
  const reloadForeignAlts = useCallback(() => {
    if (!productId || !currentLanguage || currentLanguage === primaryLocale) return;
    const form = new FormData();
    form.append("action", "loadImageAltTranslations");
    form.append("productId", productId);
    form.append("locale", currentLanguage);
    if (selectedMarketId) form.append("marketId", selectedMarketId);
    if (galleryMediaIdsKey) form.append("mediaIds", JSON.stringify(galleryMediaIdsKey.split(",")));
    altLoadRequestedAtRef.current = monotonicNow();
    translationsFetcher.submit(form, { method: "post" });
  }, [productId, currentLanguage, primaryLocale, translationsFetcher, selectedMarketId, galleryMediaIdsKey]);

  // The save handlers above run before this callback is defined; they reach it
  // through a ref.
  reloadForeignAltsRef.current = reloadForeignAlts;

  // Apply loaded translations to localAltTexts (mediaId → url → altText)
  useEffect(() => {
    const data = translationsFetcher.data;
    if (!data || data.actionType !== "loadImageAltTranslations") return;
    // An answer for another market (a stale response after a switch) is not
    // this view's layer.
    if ((data.marketId ?? "") !== selectedMarketId) return;
    // Same for another language (an answer that outlived a language switch).
    if (data.locale && data.locale !== currentLanguage) return;
    // An image saved since this answer was requested keeps its fresh value.
    const requestedAt = altLoadRequestedAtRef.current;
    const skipUrl = (url: string) =>
      isAltUrlBusy(url) || answerPredatesSave(altConfirmedAtRef.current.get(altConfirmKey(url, data.locale ?? currentLanguage, data.marketId ?? selectedMarketId)), requestedAt);
    const altTexts: Record<string, string> = data.altTexts ?? {};
    const layer = splitLoadedAltTexts(altTexts, data.inheritedMediaIds, (mediaId) => fileUrlMap[mediaId]);
    setLocalAltTexts(prev => {
      const next = { ...prev };
      // The answer is the whole layer: an own value it no longer carries (an
      // override removed on the server) goes, unless the merchant is busy there.
      for (const url of Object.keys(next)) {
        if (!(url in layer.own) && !skipUrl(url)) delete next[url];
      }
      for (const [url, altText] of Object.entries(layer.own)) {
        if (!skipUrl(url)) next[url] = altText;
      }
      return next;
    });
    setInheritedAltTexts(layer.inherited);
  }, [translationsFetcher.data]); // eslint-disable-line react-hooks/exhaustive-deps

  // Extracted so it can be called both on product selection (full reset) and on image reload
  // (variants-only refresh, no pending-state reset). The resetState flag controls whether
  // pending galleries / selection / exclusions are cleared before fetching.
  // `silent` suppresses the loading spinner. Used by the settling-media poll
  // below, which re-fetches every few seconds: without it the whole variant
  // list would blink through its spinner on every tick.
  const fetchVariantsForProduct = useCallback((pid: string, resetState: boolean, opts?: { silent?: boolean; onLanded?: () => void }) => {
    const reqId = ++variantsReqIdRef.current;
    if (variantsRetryTimerRef.current) { clearTimeout(variantsRetryTimerRef.current); variantsRetryTimerRef.current = null; }
    // A newer read ends the older one outright (a read held back by the rate
    // limiter would otherwise keep retrying for a product nobody looks at).
    variantsAbortRef.current?.abort();
    const variantsAbort = new AbortController();
    variantsAbortRef.current = variantsAbort;
    const isStale = () => variantsReqIdRef.current !== reqId;
    if (!opts?.silent && variantsLoadedForRef.current !== pid) setIsLoadingVariants(true);
    // A silent poll must not clear a genuine error banner either — it is
    // forbidden from re-raising one, so clearing would leave the section
    // showing an empty state where a real failure had been reported.
    if (!opts?.silent) setVariantError(null);
    if (resetState) {
      setPendingVariantGalleries({});
      setSelectedGalleryItems(new Map());
      setRemovedMains({});
      setPendingMains({});
      setPendingMoves([]);
    }

    appFetch(`/api/product-variants?productId=${encodeURIComponent(pid)}`, { signal: variantsAbort.signal })
      .then(r => {
        // The limiter's refusal is not a variants answer: its body has an English
        // `error` that would be shown as the banner (the silent poll included).
        // Through the catch below it is local, silent for a poll, translated otherwise.
        if (r.status === 429) throw new Error("rateLimited");
        return r.json();
      })
      .then(({ variants: raw, mediaMap, mediaMetaMap: mmm, error }) => {
        // A newer product was selected while this request was in flight — drop the
        // result so it can't overwrite the current product's variants/galleries.
        if (isStale()) return;
        if (error) { setVariantError(error); return; }
        if (mediaMap) {
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
          // Read from the live ref (effectiveProductImages) instead of the
          // useCallback closure — the closure captures the initial props and
          // so its altText snapshot goes stale after the loader hands back a
          // freshly bulk-applied set (mediaIds unchanged but altTexts new).
          // currentImagesRef is updated every render, so this merge always
          // sees the latest altTexts.
          const liveImages = currentImagesRef.current ?? (refreshedProductImages ?? productImages);
          const existingByMediaId = new Map(
            liveImages.map(img => [img.mediaId, img])
          );
          const fresh: ProductImageRef[] = [];
          // Include every media kind in the product gallery — images, videos,
          // 3D models, external videos. The previous filter dropped non-images,
          // so a .glb uploaded into a variant landed on product.media (via
          // productCreateMedia) but never showed up in the product gallery
          // view after the post-save refetch. The Image Manager renders the
          // right tile per kind via mediaMetaMap; refreshedProductImages just
          // owns the order + altText metadata.
          for (const [gid, url] of Object.entries(mediaMap as Record<string, string>)) {
            if (!(mmm as Record<string, { kind?: string }>)[gid]?.kind) continue;
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
          // Parallel preview JPG URLs from custom.variant_3d_previews — must
          // be parsed alongside threeDModelUrls because the variant tile's
          // thumbnail renderer reads variant.threeDPreviewUrls[i] for the
          // model at index i. Without this branch the tile always fell back
          // to the "3D" placeholder even after the metafield was populated.
          threeDPreviewUrls: (() => {
            try {
              const parsed = JSON.parse(v.threeDPreviewsJson || "[]");
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
        variantsLoadedForRef.current = pid;
        variantsRetryAttemptRef.current = 0;
        onVariantsLoaded?.(sortedVariants);
        // Only a read that LANDED ends what depends on it (a removed main image that the
        // promoted image has replaced): a failed read leaves that state as it is.
        opts?.onLanded?.();

        // Nothing is queued here: opening a product never marks it as changed. A
        // main image that older saves also left in the gallery metafield is shown
        // once (see displayMain) and is dropped by the server on the first real
        // write to that variant.
      })
      // A silent poll must not raise the load-error banner: it runs in the
      // background after a successful save, and a transient network blip
      // there would read as "your save failed".
      .catch(() => {
        if (isStale() || opts?.silent) return;
        setVariantError(t.imageManager.variantsLoadError);
        // Try again by itself (a limiter refusal is gone after a few seconds); bounded, and only while
        // nothing newer has been asked.
        const delay = VARIANTS_RETRY_DELAYS_MS[variantsRetryAttemptRef.current];
        if (delay !== undefined) {
          variantsRetryAttemptRef.current += 1;
          variantsRetryTimerRef.current = setTimeout(() => {
            variantsRetryTimerRef.current = null;
            if (variantsReqIdRef.current === reqId) fetchVariantsRef.current?.(pid, false);
          }, delay);
        }
      })
      // Clearing is NOT gated on `silent`: every call shares variantsReqIdRef,
      // so a poll tick landing while a non-silent load is in flight makes that
      // load stale — it skips its own clear — and a silent-only clear would
      // leave the spinner up forever, with the variant list replaced by it
      // until the next save or product switch. Whoever is the current request
      // owns the flag.
      .finally(() => { if (!isStale()) setIsLoadingVariants(false); });
  }, [t.imageManager.variantsLoadError, onVariantsLoaded]); // eslint-disable-line react-hooks/exhaustive-deps
  fetchVariantsRef.current = fetchVariantsForProduct;

  useEffect(() => {
    if (!productId) return;
    variantsRetryAttemptRef.current = 0;
    fetchVariantsForProduct(productId, true);
  }, [productId, resetKey]); // eslint-disable-line react-hooks/exhaustive-deps

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
        const r = await appFetch(`/api/running-field-tasks?resourceId=${encodeURIComponent(pid)}`);
        const { tasks } = await r.json();
        // The per-IMAGE rows, and only those: a conversion run also has one
        // aggregate row on the same product (`imageWebpConversion` with a
        // `total`), which carries no `mediaId` and would keep this poll's
        // "still converting" count above zero after the last image landed.
        // `isWebpWorkRow` also matches the pre-split rows an older build wrote
        // under the parent type, so a conversion in flight across a deploy
        // keeps its spinners.
        const webpTasks = (tasks ?? []).filter(isWebpWorkRow);
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
            const imgR = await appFetch(`/api/product-images?productId=${encodeURIComponent(pid)}`);
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
          const r = await appFetch(`/api/running-field-tasks?resourceId=${encodeURIComponent(productId)}`);
          const { tasks } = await r.json();
          if (cancelled) return;
          const webpTasks = (tasks ?? []).filter(isWebpWorkRow);
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
              const imgR = await appFetch(`/api/product-images?productId=${encodeURIComponent(productId)}`);
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
            const imgR = await appFetch(`/api/product-images?productId=${encodeURIComponent(productId)}`);
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
        const imgR = await appFetch(`/api/product-images?productId=${encodeURIComponent(productId)}`);
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
  // Hash altText into the key so a bulk-apply (mediaIds unchanged, altTexts new) also
  // invalidates the stale refreshedProductImages and re-triggers the variant fetch.
  const productImagesKey = productImages.map(i => `${i.mediaId}|${i.altText ?? ""}`).join(",");
  useEffect(() => {
    const prev = prevProductImagesKeyRef.current;
    prevProductImagesKeyRef.current = productImagesKey;
    if (prev !== "" && prev !== productImagesKey && !isConvertingWebPRef.current) {
      setRefreshedProductImages(null);
      if (productId) fetchVariantsForProduct(productId, false);
    }
  }, [productImagesKey, productId, fetchVariantsForProduct]); // eslint-disable-line react-hooks/exhaustive-deps

  // After WebP conversion completes, use the refreshed Shopify URLs (with .webp extension)
  // so badges update immediately without a page reload. Falls back to the prop otherwise.
  const effectiveProductImages = refreshedProductImages ?? productImages;
  currentImagesRef.current = effectiveProductImages;

  // ── Saved-but-still-processing media ───────────────────────────────────
  // Shopify's productCreateMedia returns the GID immediately but keeps
  // processing the file; until it finishes, `image.url` is null and
  // /api/product-variants reports the node not at all (see its mediaMap
  // build — a MediaImage without a URL is skipped). Presence in
  // shopifyMediaMap is therefore the readiness signal, uniformly for every
  // kind: a video / model whose poster hasn't rendered yet is missing from
  // that map too.
  const unsettledMedia = useMemo(
    () => unsettledMediaEntries(settlingMedia ?? [], productId, shopifyMediaMap),
    [settlingMedia, productId, shopifyMediaMap],
  );
  // Stable identity for the poll effect — a raw array would restart the
  // timer on every render.
  const unsettledKey = useMemo(
    () => unsettledMedia.map(m => m.mediaId).sort().join("|"),
    [unsettledMedia],
  );

  // Report everything that has arrived (or belongs to a product we left) so
  // the hook drops it. Runs down to a no-op once the list is empty.
  useEffect(() => {
    const entries = settlingMedia ?? [];
    if (entries.length === 0) return;
    const resolved = resolvedMediaIds(entries, productId, shopifyMediaMap);
    if (resolved.length > 0) onSettlingMediaResolved?.(resolved);
  }, [settlingMedia, shopifyMediaMap, productId, onSettlingMediaResolved]);

  // Bounded re-poll while anything is still processing. Backs off from 1.5s
  // to 10s (~55s of patience in total); after that we stop asking but KEEP
  // the tiles — an image that is on Shopify but slow must not disappear from
  // the gallery, which is the whole bug this block exists for. The next
  // product open / reload reconciles it.
  useEffect(() => {
    if (!productId || unsettledKey === "") {
      settlingPollAttemptRef.current = 0;
      prevUnsettledKeyRef.current = "";
      return;
    }
    if (prevUnsettledKeyRef.current !== unsettledKey) {
      // Set changed — either a new save or one of them landed. Either way
      // progress was made, so the patience budget starts over.
      prevUnsettledKeyRef.current = unsettledKey;
      settlingPollAttemptRef.current = 0;
    }
    const attempt = settlingPollAttemptRef.current;
    const delay = settlingPollDelayMs(attempt);
    if (delay === null) {
      // We stopped asking: a Save waiting to send the alt text of an image
      // that is still processing stops waiting (the text stays a draft).
      releaseStuckDeferredAltsRef.current?.();
      return;
    }
    const timer = setTimeout(() => {
      settlingPollAttemptRef.current = attempt + 1;
      setSettlingPollTick(tick => tick + 1);
      fetchVariantsForProduct(productId, false, { silent: true });
    }, delay);
    return () => clearTimeout(timer);
    // settlingPollTick is the re-arm trigger: without it the effect would
    // fire once and never schedule the next poll when nothing changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unsettledKey, settlingPollTick, productId]);

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
    // Saved media Shopify is still processing: the variant metafield already
    // holds the real GID, but no map can resolve it to a URL yet, and the
    // gallery render .filter(Boolean)s anything unresolved — so the tile the
    // merchant just saved would silently drop out of the variant gallery.
    // The local preview stands in until the CDN URL arrives.
    ...Object.fromEntries(
      unsettledMedia
        .filter(m => m.previewUrl)
        .map(m => [m.mediaId, m.previewUrl as string])
    ),
    ...Object.fromEntries(
      pendingProductNewMedia
        .filter(m => m.previewUrl && m.resourceUrl)
        .map(m => [m.resourceUrl, m.previewUrl as string])
    ),
  }), [effectiveProductImages, shopifyMediaMap, pendingProductNewMedia, unsettledMedia]);

  const urlToGid: Record<string, string> = useMemo(() => ({
    ...Object.fromEntries(effectiveProductImages.filter(img => img.mediaId).map(img => [img.url, img.mediaId])),
    ...Object.fromEntries(Object.entries(shopifyMediaMap).map(([gid, url]) => [url, gid])),
    // A settling tile stands in for media that EXISTS on Shopify, so its
    // preview URL has to resolve to the real GID like any other tile —
    // otherwise a reorder or a delete performed while Shopify is still
    // processing would silently skip it.
    ...Object.fromEntries(
      unsettledMedia.filter(m => m.previewUrl).map(m => [m.previewUrl as string, m.mediaId])
    ),
  }), [effectiveProductImages, shopifyMediaMap, unsettledMedia]);

  /** The variant's native image as a GID, tolerant of `?v=` versions; undefined = none, or
   *  one whose URL does not resolve (such a variant is NEVER treated as having no main image
   *  by a save: see buildVariantEmission). */
  const mainGidOfVariant = (v: { defaultImageUrl?: string }): string | undefined =>
    v.defaultImageUrl
      ? (urlToGid[v.defaultImageUrl] ??
         Object.entries(urlToGid).find(([u]) => u.split("?")[0] === v.defaultImageUrl!.split("?")[0])?.[1])
      : undefined;

  /** The ONE resolver from a tile's URL to the reference the save writes: the GID of a saved medium, or
   *  the staged / asset URL of a medium this save creates (a blob preview or a clone's preview URL is
   *  never a reference; it resolves through fileUrlMap to the staged URL). `undefined` = unknown.
   *  Reorder, drop-to-variant, copy and the selection all go through it. */
  const fileRefOfUrl = (u: string): string | undefined => {
    const base = u.split("?")[0];
    return urlToGid[u] ??
      Object.entries(urlToGid).find(([k]) => k.split("?")[0] === base)?.[1] ??
      Object.entries(fileUrlMap).find(([, fu]) => fu === u)?.[0] ??
      Object.entries(fileUrlMap).find(([, fu]) => fu.split("?")[0] === base)?.[0];
  };

  /** The removals that still apply: a removal is the merchant's statement "THIS main image is
   *  gone", so it acts only while the variant's main image still is that GID. Once a read
   *  brings the image that moved up (or any other main image) it has no effect any more,
   *  and a save no longer carries it. */
  const effectiveRemovals = useMemo(() => {
    const out: Record<string, string> = {};
    for (const v of variants) {
      const gid = removedMains[v.id];
      if (gid && mainGidOfVariant(v) === gid) out[v.id] = gid;
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variants, removedMains, urlToGid]);
  /** Variant ids with an effective removal. */
  const locallyExcludedMainGids = useMemo(() => new Set(Object.keys(effectiveRemovals)), [effectiveRemovals]);
  /** The explicit main-image choices, only for variants whose main image is still what it was
   *  when the merchant dragged (a refetch that changed it ends the intent with the old basis). */
  const effectivePendingMains = useMemo(() => {
    const out: Record<string, PendingMain> = {};
    for (const v of variants) {
      const pm = pendingMains[v.id];
      if (!pm) continue;
      const main = mainGidOfVariant(v) ?? null;
      // While a removal of the displayed-as-stale main is in effect the native main is the deleted one
      // and the choice (based on the promoted image) still applies.
      if (effectiveRemovals[v.id] || main === pm.expected || main === pm.gid) out[v.id] = pm;
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variants, pendingMains, urlToGid, effectiveRemovals]);

  /** The moves that still apply: the source's removal of that image is in effect and the target still
   *  holds the image (in its pending list or as its chosen main). Anything else ends the move; the
   *  remaining statements are then ordinary, independent ones. */
  const effectiveMoves = useMemo(
    () => pendingMoves.filter(m => {
      if (effectiveRemovals[m.sourceVariantId] !== m.gid) return false;
      const list = pendingVariantGalleries[m.targetVariantId];
      return effectivePendingMains[m.targetVariantId]?.gid === m.gid || (!!list && list.includes(m.gid));
    }),
    [pendingMoves, effectiveRemovals, effectivePendingMains, pendingVariantGalleries],
  );
  useEffect(() => {
    if (effectiveMoves.length !== pendingMoves.length) setPendingMoves(effectiveMoves);
  }, [effectiveMoves, pendingMoves]);
  /** THE guard of a pending move: while a variant is part of one, every gesture that would change the
   *  main image of either side (a drag to / away from the first slot, a removal or delete of its main
   *  image, dragging the moved image onward) is refused with "save first". Without it the request would
   *  contradict its own move statement and every Save would be refused until Discard. */
  const inPendingMove = (variantId: string): boolean =>
    effectiveMoves.some(m => m.sourceVariantId === variantId || m.targetVariantId === variantId);

  /** An image that could move up as a variant's main image: any MediaImage. A library image
   *  the product does not hold yet is attached by the server on the save (fileUpdate) before
   *  it becomes the main image, so the editor does not skip it; a video, link, 3D model or
   *  generic file never qualifies. */
  const isPromotable = (gid: string): boolean => isImageGid(gid);
  /** Image uploads / clones this save will create (their staged / asset URL is the gallery reference). */
  const stagedImageRefs = new Set(pendingProductNewMedia.filter(m => m.kind === "image").map(m => m.resourceUrl));
  /** A variant with NO native image gets its first own image promoted on a real edit (a pending gallery),
   *  a medium this save creates included: the server does exactly that, so the display shows it. */
  const promoteEmptyOf = (v: { id: string; defaultImageUrl?: string }): boolean =>
    !v.defaultImageUrl && pendingVariantGalleries[v.id] !== undefined && !locallyExcludedMainGids.has(v.id) && !effectivePendingMains[v.id];
  /** A reference a variant gallery (list.file_reference) cannot hold: a 3D model or an external video, saved or
   *  still pending (those belong to the variant's link / model lists and are added through the picker). */
  const notFileEntry = (ref: string, u: string): boolean => {
    const k = imageMetas[u]?.kind;
    if (k === "model" || k === "external_video") return true;
    if (ref.startsWith("gid://")) return !isFileKindGid(ref);
    const queued = pendingProductNewMedia.find(m => m.resourceUrl === ref);
    return !!queued && queued.kind !== "image" && queued.kind !== "video";
  };
  /** What a variant's gallery shows (displayMain with the rules above). */
  const displayFor = (v: { id: string; defaultImageUrl?: string; galleryFileGids: string[]; galleryOrderJson?: string | null }) => {
    const promoteEmpty = promoteEmptyOf(v);
    return displayMain({
      nativeMainGid: mainGidOfVariant(v),
      removed: locallyExcludedMainGids.has(v.id) || promoteEmpty,
      pendingMain: effectivePendingMains[v.id]?.gid,
      stored: pendingVariantGalleries[v.id] ?? v.galleryFileGids,
      orderJson: pendingGalleryOrder[v.id] ?? v.galleryOrderJson,
      // (an empty variant promotes only what is visible: a dead / unresolvable reference is skipped, like on the server)
      isCandidate: promoteEmpty ? (g => (isPromotable(g) || stagedImageRefs.has(g)) && !!fileUrlMap[g]) : isPromotable,
      isStagedImage: promoteEmpty ? (r => stagedImageRefs.has(r)) : undefined,
    });
  };

  /** Point 1: refuses (BEFORE any state change) a move or copy into a variant that already shows the
   *  medium, main image included. The message names the target variant. Returns true when refused. */
  const refuseIfTargetHolds = (variantId: string, ref: string, tileUrl?: string): boolean => {
    const target = variants.find(v => v.id === variantId);
    if (!target) return false;
    if (!variantHoldsMedium({ shownGids: displayFor(target).gids, ref, tileUrl, fileUrlMap, urlToGid })) return false;
    showInfoBox(t.imageManager.targetAlreadyHasMedium.replace("{variant}", target.title), "warning");
    return true;
  };

  /** A variant's gallery tiles in the order the merchant SEES them: saved order JSON first (honouring
   *  per-kind value lookups), then whatever the order does not cover (files, links, models). */
  const orderedVariantTiles = (variantId: string) => {
    const variant = variants.find(v => v.id === variantId);
    const storedGids = pendingVariantGalleries[variantId] ?? variant?.galleryFileGids ?? [];
    // The drag works on what the gallery SHOWS (displayMain). The first slot IS the main
    // image: an image dropped there becomes the main image (the old main image moves to
    // the drop position and stays in the gallery), the main image dragged away hands
    // the first slot to the next image, and nothing but this branch ever chooses a main
    // image (planVariantDrag decides; the save carries it as an explicit intent).
    const shownDrag = variant ? displayFor(variant) : displayMain({ nativeMainGid: undefined, removed: false, stored: storedGids });
    const gids = shownDrag.gids;
    const fileUrls = gids.map(gid => fileUrlMap[gid]).filter(Boolean) as string[];
    const externalUrls = pendingExternalVideos[variantId] ?? variant?.externalVideoUrls ?? [];
    const modelUrls = pendingVariant3dModels[variantId] ?? variant?.threeDModelUrls ?? [];
    // Build the same ordered display list that VariantGallerySection
    // shows the merchant — saved order JSON first (honouring per-kind
    // value lookups), then tail-append any item the order metafield
    // doesn't cover. Without this, dragging a video / 3D model fired a
    // drag-end whose URL wasn't in the (file-only) variantUrls list →
    // indexOf returned -1 → the if-guard rejected the move and nothing
    // happened. The merchant couldn't reorder mixed galleries.
    const orderJsonRaw = orderShowingMain(
      pendingGalleryOrder[variantId] ?? variant?.galleryOrderJson ?? null,
      shownDrag.mainGid,
    );
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
    return { variant, shownDrag, variantUrls, externalSet, modelSet };
  };

  // Variants that have no effective main image (neither native Shopify main nor any gallery image
  // at position 0 that would be promoted on save). Used for tooltip, pulse, and dot indicator.
  const variantsWithMissingMain = useMemo(() => {
    return variants.filter(v => {
      if (locallyExcludedMainGids.has(v.id) || promoteEmptyOf(v)) {
        // Removed: the next image of the gallery moves up on save (see displayMain),
        // so only a variant with no image left is without a main image.
        return displayFor(v).mainGid === null;
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
  }, [variants, urlToGid, locallyExcludedMainGids, effectivePendingMains, pendingGalleryOrder, pendingVariantGalleries, pendingProductNewMedia]);

  const hasAnyVariantMissingMainImage = variantsWithMissingMain.length > 0;

  // Sync the pending gallery state to the parent whenever any of it, or what it is
  // measured against (the variants), changes. Every variant carries an EXPLICIT intent about
  // its main image (see buildVariantEmission): the effect depends on `variants` so that a
  // read that lands (the promoted image after a delete) is never emitted against the main
  // image it replaced.
  useEffect(() => {
    const hasGalleryChanges = Object.keys(pendingVariantGalleries).length > 0;
    const hasRemoval = Object.keys(effectiveRemovals).length > 0;
    const hasProductNewMedia = pendingProductNewMedia.length > 0;
    // Skip the propagation only when ALL the tracked buckets are empty (a bucket missing
    // from this guard leaves the Save button disabled over an unsaved change).
    if (!hasGalleryChanges && !hasRemoval && !hasProductNewMedia) {
      // Everything went back to "no change" (e.g. a refused delete rolled the
      // optimistic exclusion back). The parent still holds what we emitted
      // last, so re-sync it explicitly or the next Save replays stale pending state.
      if (emittedPendingRef.current) {
        emittedPendingRef.current = false;
        onPendingChange?.([], pendingMediaOrderRef.current, [], [], []);
      }
      return;
    }
    emittedPendingRef.current = true;

    const { galleries, removedMainImages } = buildVariantEmission({
      pending: pendingVariantGalleries,
      removed: effectiveRemovals,
      pendingMain: effectivePendingMains,
      variants: variants.map(v => ({ id: v.id, mainGid: mainGidOfVariant(v), hasNativeImage: !v.defaultImageUrl ? false : undefined, galleryFileGids: v.galleryFileGids })),
    });
    onPendingChange?.(galleries, pendingMediaOrderRef.current, pendingProductNewMedia, removedMainImages, effectiveMoves);
  }, [pendingVariantGalleries, pendingProductNewMedia, effectiveRemovals, effectivePendingMains, effectiveMoves, variants]); // eslint-disable-line react-hooks/exhaustive-deps

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
    // Saved-but-still-processing media: keyed by the local preview URL,
    // which is what displayedProductUrls carries for them. isProcessing
    // drives the spinner + badge (distinct from isPending, which means
    // "not saved yet" — these ARE saved).
    for (const m of unsettledMedia) {
      if (!m.previewUrl) continue;
      // previewUrl is set on the meta as well as being the key: the model
      // branch of SortableThumbnail renders meta.previewUrl (the tile's own
      // URL is not a renderable image for a .glb), so without it a settling
      // 3D tile would fall back to the bare "3D" placeholder even though we
      // have its snapshot right here.
      map[m.previewUrl] = {
        ...(map[m.previewUrl] ?? {}),
        kind: m.kind,
        previewUrl: m.previewUrl,
        isProcessing: true,
      };
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
      } else if (m.previewUrl || m.kind) {
        // Seed the entry even when previewUrl is missing — without the kind
        // signal, SortableThumbnail and DragOverlay fall back to the "image"
        // branch and try to render the raw resourceUrl (.glb / .mp4) as an
        // <img>, producing a broken-link icon. With kind populated they
        // render the appropriate placeholder ("3D" / "▶").
        map[key] = { kind: m.kind, previewUrl: m.previewUrl };
      }
    }
    // Variant 3D models live on their own metafield (variant_3d_models +
    // variant_3d_previews) and never pass through mediaMetaMap. Surface
    // their kind + preview URL here so the DragOverlay (which reads from
    // the parent's imageMetas, not from VariantGallerySection's local
    // enrichedImageMetas) can render the real thumbnail during a drag
    // instead of falling back to the generic "3D" placeholder.
    for (const v of variants) {
      const models = pendingVariant3dModels[v.id] ?? v.threeDModelUrls ?? [];
      const previews = pendingVariant3dPreviews[v.id] ?? v.threeDPreviewUrls ?? [];
      for (let i = 0; i < models.length; i++) {
        const u = models[i];
        const previewUrl = previews[i];
        const existing = map[u];
        if (existing) {
          if (!existing.previewUrl && previewUrl) existing.previewUrl = previewUrl;
          if (!existing.kind) existing.kind = "model";
        } else {
          map[u] = { kind: "model", previewUrl: previewUrl && previewUrl.trim() !== "" ? previewUrl : undefined };
        }
      }
    }
    return map;
  }, [effectiveProductImages, convertingImageUrls, shopifyMediaMap, mediaMetaMap, pendingProductNewMedia, unsettledMedia, variants, pendingVariant3dModels, pendingVariant3dPreviews]);

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
    const baseUrls = (showAll || !fullView || variants.length === 0)
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
    // Media that IS saved but is still being processed by Shopify. It cannot
    // be in baseUrls (no CDN URL exists yet), so without this the product
    // gallery loses the image between the save and the end of processing —
    // and the media count silently stays put, which reads as "the upload was
    // thrown away".
    const settlingPreviews = unsettledMedia
      // Its GID is known, so it obeys the same "hide what a variant already
      // uses" filter as every other saved tile.
      .filter(m => showAll || !fullView || variants.length === 0 || !assignedGids.has(m.mediaId))
      .map(m => m.previewUrl)
      .filter((u): u is string => typeof u === "string" && u.length > 0
        && !baseUrls.includes(u) && !pendingPreviews.includes(u));
    return [...baseUrls, ...settlingPreviews, ...pendingPreviews];
  }, [showAll, fullView, pendingProductImageOrder, effectiveProductImages, urlToGid, assignedGids, variants.length, pendingProductNewMedia, unsettledMedia]);


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

  /** `newMain`: the image that now leads the variant's own gallery and did not before (the ONE
   *  place a main image is chosen); `undefined`/`null` = the first slot did not change and
   *  whatever main image was chosen so far stays as it is. */
  const handleVariantReorder = useCallback((variantId: string, newItems: string[], newMain?: string | null) => {
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
    const linkUrlSet = new Set(pendingExternalVideos[variantId] ?? variant?.externalVideoUrls ?? []);
    const fileEntries: string[] = [];
    const orderEntries: Array<{ kind: "file" | "url" | "model"; value: string }> = [];
    for (const it of newItems) {
      // Links and models by MEMBERSHIP in the variant's link / model sets; everything else is a file
      // reference (a GID, or a staged / asset URL that the route resolves): never `startsWith("http")`.
      if (modelUrlSet.has(it)) {
        orderEntries.push({ kind: "model", value: it });
      } else if (linkUrlSet.has(it)) {
        orderEntries.push({ kind: "url", value: it });
      } else {
        fileEntries.push(it);
        orderEntries.push({ kind: "file", value: it });
      }
    }
    // Dragging back to exactly what is stored is no change at all: nothing stays pending (a lit Save for a
    // no-op write otherwise), compared with the stored files, links, models and order.
    const nativeForRestore = variant ? mainGidOfVariant(variant) : undefined;
    const storedFilesNow = galleryWithout(variant?.galleryFileGids ?? [], nativeForRestore);
    const urlsNow = pendingExternalVideos[variantId] ?? variant?.externalVideoUrls ?? [];
    const modelsNow = pendingVariant3dModels[variantId] ?? variant?.threeDModelUrls ?? [];
    const storedOrderEntries = parseGalleryOrder(orderShowingMain(variant?.galleryOrderJson ?? null, nativeForRestore))
      ?? [
        ...(nativeForRestore ? [{ kind: "file" as const, value: nativeForRestore }] : []),
        ...storedFilesNow.map(v => ({ kind: "file" as const, value: v })),
        ...(variant?.externalVideoUrls ?? []).map(v => ({ kind: "url" as const, value: v })),
        ...(variant?.threeDModelUrls ?? []).map(v => ({ kind: "model" as const, value: v })),
      ];
    const pendingMainAfter = newMain
      ? (newMain === (effectiveRemovals[variantId] ? undefined : (effectivePendingMains[variantId]?.expected ?? (variant ? mainGidOfVariant(variant) : undefined))) ? undefined : newMain)
      : effectivePendingMains[variantId]?.gid;
    const isStoredState =
      !pendingMainAfter && !effectiveRemovals[variantId] &&
      JSON.stringify(galleryWithout(fileEntries, nativeForRestore)) === JSON.stringify(storedFilesNow) &&
      JSON.stringify(urlsNow) === JSON.stringify(variant?.externalVideoUrls ?? []) &&
      JSON.stringify(modelsNow) === JSON.stringify(variant?.threeDModelUrls ?? []) &&
      JSON.stringify(orderEntries) === JSON.stringify(storedOrderEntries.map(e => ({ kind: e.kind, value: e.value })));
    if (isStoredState) {
      setPendingVariantGalleries(p => Object.fromEntries(Object.entries(p).filter(([k]) => k !== variantId)));
      const restOrder = Object.fromEntries(Object.entries(pendingGalleryOrderRef.current).filter(([k]) => k !== variantId));
      pendingGalleryOrderRef.current = restOrder;
      setPendingGalleryOrder(restOrder);
      onGalleryOrderChange?.(restOrder);
      setPendingMains(p => Object.fromEntries(Object.entries(p).filter(([k]) => k !== variantId)));
      // links / models equal to the stored ones are no pending change either
      if (pendingExternalVideos[variantId] !== undefined) {
        const restUrls = Object.fromEntries(Object.entries(pendingExternalVideos).filter(([k]) => k !== variantId));
        setPendingExternalVideos(restUrls);
        onExternalVideosChange?.(restUrls);
      }
      if (pendingVariant3dModels[variantId] !== undefined) {
        const restModels = Object.fromEntries(Object.entries(pendingVariant3dModels).filter(([k]) => k !== variantId));
        setPendingVariant3dModels(restModels);
        onThreeDModelsChange?.(restModels);
        // previews are cleared only when they equal the stored ones too (otherwise they stay a pending change)
        if (JSON.stringify(pendingVariant3dPreviews[variantId] ?? []) === JSON.stringify(variant?.threeDPreviewUrls ?? [])) {
          const restPrev = Object.fromEntries(Object.entries(pendingVariant3dPreviews).filter(([k]) => k !== variantId));
          setPendingVariant3dPreviews(restPrev);
          onThreeDPreviewsChange?.(restPrev);
        }
      }
      return;
    }
    setPendingVariantGalleries(p => ({ ...p, [variantId]: fileEntries }));
    setPendingGalleryOrder(p => ({ ...p, [variantId]: JSON.stringify(orderEntries) }));
    onGalleryOrderChange?.({ ...pendingGalleryOrderRef.current, [variantId]: JSON.stringify(orderEntries) });
    if (newMain) {
      const native = variant ? (mainGidOfVariant(variant) ?? null) : null;
      // The basis of the choice stays the main image the merchant first saw, as long as that choice
      // still applies (an ended choice, e.g. after a read that changed the main, has no basis left).
      // While a removal is in effect the basis is the image the editor SHOWS as the main one (what
      // the removal promoted), not the deleted one: the server compares with that.
      const removalActive = !!effectiveRemovals[variantId];
      const shownNow = removalActive
        ? displayMain({
            nativeMainGid: native,
            removed: true,
            stored: pendingVariantGalleries[variantId] ?? variant?.galleryFileGids ?? [],
            orderJson: pendingGalleryOrderRef.current[variantId] ?? variant?.galleryOrderJson ?? null,
            isCandidate: isPromotable,
          }).mainGid
        : null;
      const expected = removalActive ? shownNow : (effectivePendingMains[variantId]?.expected ?? native);
      setPendingMains(p => {
        const next = { ...p };
        if (newMain === expected) delete next[variantId];
        else next[variantId] = { gid: newMain, expected };
        return next;
      });
    }
  }, [variants, pendingVariant3dModels, pendingVariant3dPreviews, pendingExternalVideos, onExternalVideosChange, onThreeDModelsChange, onThreeDPreviewsChange, onGalleryOrderChange, urlToGid, fileUrlMap, effectivePendingMains, effectiveRemovals, pendingVariantGalleries]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleProductReorder = useCallback((newUrls: string[]) => {
    setPendingProductImageOrder(newUrls);
    const mediaOrder = newUrls
      .map((url, idx) => {
        const img = effectiveProductImages.find(i => i.url === url);
        return img?.mediaId ? { mediaId: img.mediaId, position: idx } : null;
      })
      .filter(Boolean) as Array<{ mediaId: string; position: number }>;

    pendingMediaOrderRef.current = mediaOrder;
    // The variants' part is built exactly like the sync effect builds it, from the same
    // intents (nothing new is added to them here): a reorder of the PRODUCT gallery never
    // changes a variant's main image.
    const { galleries } = buildVariantEmission({
      pending: pendingVariantGalleries,
      removed: effectiveRemovals,
      pendingMain: effectivePendingMains,
      variants: variants.map(v => ({ id: v.id, mainGid: mainGidOfVariant(v), hasNativeImage: !v.defaultImageUrl ? false : undefined, galleryFileGids: v.galleryFileGids })),
    });
    onPendingChange?.(galleries, mediaOrder, pendingProductNewMedia);
  }, [effectiveProductImages, pendingVariantGalleries, pendingProductNewMedia, onPendingChange, effectiveRemovals, effectivePendingMains, variants, urlToGid]); // eslint-disable-line react-hooks/exhaustive-deps

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
    // Self-drop: dropped on the exact tile that was picked up — abort.
    if (over.id === active.id) return;

    const sourceContainerId = active.data.current?.containerId as string | undefined;
    const url = active.data.current?.url as string | undefined;
    if (!sourceContainerId || !url) return;

    const overStr = over.id as string;
    const sepIdx = overStr.indexOf("::");
    const targetContainerId = sepIdx !== -1 ? overStr.slice(0, sepIdx) : overStr;
    // overUrl semantics:
    //   - string: dropped on a specific tile (URL of that tile)
    //   - null:   dropped on the container itself (whitespace)
    //   - "__end__": dropped on the upload placeholder → append to end of container
    // Downstream branches that expect a real URL treat "__end__" the same as
    // null (insertGidAtPosition / no-overUrl guards). The variant-to-product
    // explicit-tile guard now also accepts "__end__" so the merchant can drop
    // onto the product gallery's upload tile to remove from the variant.
    const rawOverUrl = sepIdx !== -1 ? overStr.slice(sepIdx + 2) : null;
    const isEndDrop = rawOverUrl === "__end__";
    const overUrl = isEndDrop ? null : rawOverUrl;

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
        const { variant, variantUrls, externalSet, modelSet } = orderedVariantTiles(sourceContainerId);

        {
          // Position 0 is the variant's main image, which only a MediaImage can be. The check
          // covers pendingExternalVideos (YouTube/Vimeo for this variant),
          // pendingVariant3dModels (variant .glb URLs), imageMetas entries whose kind is
          // non-image, and any tile whose GID is not a MediaImage (generic file, an upload
          // that has no GID yet).
          // A library image that is only in this variant's gallery is not in urlToGid: its GID comes
          // from fileUrlMap, so it counts as the image it is.
          const gidOfUrl = fileRefOfUrl;
          const isNonImage = (u: string) => {
            if (externalSet.has(u) || modelSet.has(u)) return true;
            const k = imageMetas[u]?.kind;
            if (k === "video" || k === "model" || k === "external_video") return true;
            const g = gidOfUrl(u);
            return !g || !isImageGid(g);
          };
          const drag = planVariantDrag(
            variantUrls.map((u): DragEntry => ({ id: u, isImage: !isNonImage(u) })),
            url,
            overUrl,
          );
          if (!drag) return;
          if (drag.kind === "refused") {
            setMediaError(drag.reason === "onlyImage" ? t.imageManager.mainOnlyImage : t.imageManager.mainFirstNeedsImage);
            return;
          }
          if (drag.newMain && inPendingMove(sourceContainerId)) { setMediaError(t.imageManager.mainMoveSaveFirst); return; }
          // Only this drag's own refusal is cleared, never an unrelated error.
          setMediaError(cur => (cur === t.imageManager.mainOnlyImage || cur === t.imageManager.mainFirstNeedsImage ? null : cur));
          const moved = drag.order;
          // Every tile must resolve to a reference BEFORE anything changes: a tile that does not would
          // leak its preview URL into the lists.
          if (moved.some(u => !externalSet.has(u) && !modelSet.has(u) && !fileRefOfUrl(u))) {
            setMediaError(t.imageManager.tileNotResolvable);
            return;
          }
          // A variant whose native image cannot be named here keeps it (never guessed at):
          // the drag is a plain reorder for it.
          const nativeUnnameable = !!variant?.defaultImageUrl && !mainGidOfVariant(variant);
          const newMainGid = drag.newMain && !nativeUnnameable ? gidOfUrl(drag.newMain) ?? null : null;
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
              // A file tile becomes its reference (GID, or the staged / asset URL of a medium this save
              // creates), never its preview URL; handleVariantReorder classifies links and models ONLY by
              // membership in the variant's link / model sets.
              return fileRefOfUrl(u) as string;
            });
          handleVariantReorder(sourceContainerId, newItemsForReorder, newMainGid);
        }
      }
      return;
    }

    // Variant → product gallery: remove from variant (no copy)
    // Must be checked before urlToGid lookup — image may not be in urlToGid if resolved via shopifyMediaMap only.
    if (targetContainerId === "product") {
      if (sourceContainerId === "product") return;
      // Destructive cross-gallery moves require Ctrl/Cmd. The gesture is
      // undiscoverable, irreversible without an undo, and was firing on
      // any drop landing inside the product gallery's hit rect (which
      // wraps the whole section, including padding) — merchants kept
      // losing variant images on incidental drag-aborts. The per-tile
      // remove button (handleRemoveFromVariant) stays the discoverable
      // path; modifier-drag is the power-user shortcut.
      if (!isCtrlHeldRef.current) return;
      // Also require a real tile target so an accidental Ctrl-held drop
      // onto product whitespace doesn't fire.
      if (!overUrl) return;
      const sourceVariant = variants.find(v => v.id === sourceContainerId);
      // Main-image-first routing: if the dragged URL matches this variant's
      // defaultImageUrl, treat it as a main-image drag (exclude on save) BEFORE
      // searching the gallery for a same-URL match. Two distinct MediaImage GIDs
      // can share the same CDN URL (Shopify deduplicates the underlying Files
      // asset), so a gallery file with the same URL as the main image would
      // otherwise win the find() below and the main-image exclusion path would
      // never fire — the wrong GID would be stripped from the metafield while
      // the main image stayed on the variant.
      const draggedMatchesMain = sourceVariant?.defaultImageUrl &&
        (sourceVariant.defaultImageUrl === url ||
         sourceVariant.defaultImageUrl.split("?")[0] === url.split("?")[0]);
      if (draggedMatchesMain) {
        // The removal names the GID that is removed (an unnameable one is not guessed at).
        // The save flag is lit by the removal itself (it travels in the pending state); the
        // alt-text dirty flag is not this drag's business.
        const mainGid = sourceVariant ? mainGidOfVariant(sourceVariant) : undefined;
        if (!mainGid) { setMediaError(t.imageManager.mainNotNameable); return; }
        if (inPendingMove(sourceContainerId)) { setMediaError(t.imageManager.mainMoveSaveFirst); return; }
        setRemovedMains(prev => ({ ...prev, [sourceContainerId]: mainGid }));
        return;
      }
      const sourceCurrent = pendingVariantGalleries[sourceContainerId] ?? sourceVariant?.galleryFileGids ?? [];
      const gidToRemove = sourceCurrent.find(g => fileUrlMap[g] === url);
      if (!gidToRemove) return;
      if (effectiveMoves.some(m => m.targetVariantId === sourceContainerId && m.gid === gidToRemove)) { setMediaError(t.imageManager.mainMoveSaveFirst); return; }
      setPendingMains(p => (p[sourceContainerId]?.gid === gidToRemove ? Object.fromEntries(Object.entries(p).filter(([k]) => k !== sourceContainerId)) : p));
      setPendingVariantGalleries(p => ({
        ...p,
        [sourceContainerId]: sourceCurrent.filter(g => g !== gidToRemove),
      }));
      return;
    }

    // urlToGid is built from effectiveProductImages + shopifyMediaMap. The
    // dragged tile's URL can carry a different ?v= query param than the live
    // map entries (Shopify refreshes the version on every metadata save), so
    // the exact-key lookup silently misses and the handler returns early —
    // dragging a product image onto a variant felt like "nothing happens."
    // Fall back to base-URL match.
    const gid = fileRefOfUrl(url);
    if (!gid) return;
    if (notFileEntry(gid, url)) {
      setMediaError(t.imageManager.mediaNotDroppable);
      return;
    }

    if (sourceContainerId !== "product") {
      // A variant's MAIN image dragged onto another variant: a plain drag MOVES it (like a gallery image),
      // Ctrl/Cmd copies it (the branch below). The source's first own image moves up, the image takes the
      // position it was dropped on in the target (slot 1 = the target's new main image). One statement
      // (`pendingMoves`) ties the two variants together so the server writes both or neither.
      const moveSource = variants.find(v => v.id === sourceContainerId);
      const moveGid = moveSource ? mainGidOfVariant(moveSource) : undefined;
      const isStoredMainTile = !!moveSource?.defaultImageUrl &&
        (moveSource.defaultImageUrl === url || moveSource.defaultImageUrl.split("?")[0] === url.split("?")[0]) &&
        !effectivePendingMains[sourceContainerId] && !effectiveRemovals[sourceContainerId];
      // The image comes BACK to the variant that is losing it in a pending removal / move (dragged out of the
      // other variant's gallery onto it): the removal is taken back instead of inserting a reference the
      // removal would strip (the image would be on no variant). Plain: it leaves the other gallery;
      // Ctrl/Cmd (copy): the other gallery keeps it.
      if (effectiveRemovals[targetContainerId] === gid) {
        // (the dragged tile is another variant's stored MAIN image: nothing to take out of its list, so the
        // plain gesture would only copy; refused instead of guessed at)
        if (!isCtrlHeldRef.current && isStoredMainTile) { setMediaError(t.imageManager.mainMoveSaveFirst); return; }
        setRemovedMains(prev => Object.fromEntries(Object.entries(prev).filter(([k]) => k !== targetContainerId)));
        if (!isCtrlHeldRef.current) {
          setPendingMains(p => (p[sourceContainerId]?.gid === gid ? Object.fromEntries(Object.entries(p).filter(([k]) => k !== sourceContainerId)) : p));
          // The other gallery loses the image through the ONE reorder path, so a gallery that ends up as
          // stored leaves no pending write behind.
          const { variantUrls: srcUrls, externalSet: srcExternal, modelSet: srcModels } = orderedVariantTiles(sourceContainerId);
          const goneUrl = fileUrlMap[gid] ?? url;
          const refs = srcUrls.filter(u => u !== goneUrl).map(u => ((srcExternal.has(u) || srcModels.has(u)) ? u : fileRefOfUrl(u)));
          if (refs.every(r => !!r)) {
            handleVariantReorder(sourceContainerId, refs as string[], null);
          } else {
            setPendingVariantGalleries(p => {
              const sv = variants.find(v => v.id === sourceContainerId);
              return { ...p, [sourceContainerId]: (p[sourceContainerId] ?? sv?.galleryFileGids ?? []).filter(g => g !== gid) };
            });
          }
        }
        return;
      }
      // The target already shows this medium (a gallery entry, its main image, or the same file under
      // another GID): a move would only take it off the source, a copy changes nothing. Refused.
      if (refuseIfTargetHolds(targetContainerId, gid, url)) return;
      // The moved image dragged ONWARD to a third variant would drop its coupling: refused (undo = back to the source).
      if (!isCtrlHeldRef.current && effectiveMoves.some(m => m.targetVariantId === sourceContainerId && m.gid === gid)) {
        setMediaError(t.imageManager.mainMoveSaveFirst);
        return;
      }
      if (!isCtrlHeldRef.current && isStoredMainTile) {
        if (!moveGid || !isImageGid(moveGid)) { setMediaError(t.imageManager.mainNotNameable); return; }
        const moveTarget = variants.find(v => v.id === targetContainerId);
        if (!moveTarget) return;
        // a target whose own main image cannot be named here is never guessed at
        if (moveTarget.defaultImageUrl && !mainGidOfVariant(moveTarget)) { setMediaError(t.imageManager.mainNotNameable); return; }
        if (effectiveRemovals[targetContainerId] || effectivePendingMains[targetContainerId] ||
            effectiveMoves.some(m =>
              m.sourceVariantId === targetContainerId || m.targetVariantId === targetContainerId ||
              m.sourceVariantId === sourceContainerId || m.targetVariantId === sourceContainerId)) {
          setMediaError(t.imageManager.mainMoveSaveFirst);
          return;
        }
        const { shownDrag: targetShown, variantUrls: targetUrls, externalSet: targetExternal, modelSet: targetModels } = orderedVariantTiles(targetContainerId);
        if (targetShown.mainGid === moveGid) return;
        const movedUrl = fileUrlMap[moveGid] ?? url;
        const withoutMoved = targetUrls.filter(u => u !== movedUrl);
        const overIdx = overUrl ? withoutMoved.indexOf(overUrl) : -1;
        // The first slot of a target that shows a main image makes the moved image its new main image.
        const slotOne = overIdx === 0 && targetShown.mainGid !== null;
        const insertAt = overIdx === -1 ? withoutMoved.length : overIdx;
        const nextUrls = [...withoutMoved.slice(0, insertAt), movedUrl, ...withoutMoved.slice(insertAt)];
        const refs = nextUrls.map(u => (u === movedUrl ? moveGid : (targetExternal.has(u) || targetModels.has(u)) ? u : fileRefOfUrl(u)));
        if (refs.some(r => !r)) { setMediaError(t.imageManager.tileNotResolvable); return; }
        setMediaError(cur => (cur === t.imageManager.mainMoveSaveFirst || cur === t.imageManager.tileNotResolvable ? null : cur));
        handleVariantReorder(targetContainerId, refs as string[], slotOne ? moveGid : null);
        setRemovedMains(prev => ({ ...prev, [sourceContainerId]: moveGid }));
        setPendingMoves(prev => [
          ...prev.filter(m => m.sourceVariantId !== sourceContainerId && m.targetVariantId !== targetContainerId),
          {
            gid: moveGid,
            sourceVariantId: sourceContainerId,
            sourceExpectedMainGid: moveGid,
            targetVariantId: targetContainerId,
            targetExpectedMainGid: mainGidOfVariant(moveTarget) ?? null,
            targetPosition: slotOne ? 0 : insertAt,
          },
        ]);
        return;
      }
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
        // Variant → Variant: move (remove from source, add to target) in single update.
        // A variant's stored MAIN image never gets here (it is moved above); this is a gallery
        // image. A chosen-but-unsaved main image that is moved away ends that choice.
        setPendingMains(p => (p[sourceContainerId]?.gid === gid ? Object.fromEntries(Object.entries(p).filter(([k]) => k !== sourceContainerId)) : p));
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
          setRemovedMains(prev => Object.fromEntries(Object.entries(prev).filter(([k]) => k !== targetContainerId)));
          return;
        }
      }
      // The variant already shows this medium (its main image included): refused with a message.
      if (refuseIfTargetHolds(targetContainerId, gid, url)) return;
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
        const next = noMain ? [gid, ...existing] : insertGidAtPosition(existing, gid, overUrl, fileUrlMap);
        return { ...p, [targetContainerId]: next };
      });
      // When the drop lands on the end-placeholder, also update the gallery
      // order so the new file appears at the visual end of the COMBINED
      // sequence (files + videos + models), not at the end of the files-only
      // block. Without this, the default tail-append in VariantGallerySection
      // puts a freshly-added file before existing videos/3D models because
      // orderedUrls tail-appends in the order [files, urls, models].
      if (isEndDrop) {
        const existingOrderJson = pendingGalleryOrder[targetContainerId] ?? targetVariant?.galleryOrderJson;
        const existingFileGids = pendingVariantGalleries[targetContainerId] ?? targetVariant?.galleryFileGids ?? [];
        const externalUrls = pendingExternalVideos[targetContainerId] ?? targetVariant?.externalVideoUrls ?? [];
        const modelUrls = pendingVariant3dModels[targetContainerId] ?? targetVariant?.threeDModelUrls ?? [];
        let entries: Array<{ kind: "file" | "url" | "model"; value: string }> = [];
        if (existingOrderJson) {
          try {
            const parsed = JSON.parse(existingOrderJson);
            if (Array.isArray(parsed)) entries = parsed.filter((e: { kind?: string; value?: string }) => e?.kind && e?.value) as typeof entries;
          } catch { /* fall through */ }
        }
        if (entries.length === 0) {
          // Default order MUST include the main image first. variant.galleryFileGids
          // is the raw metafield (gallery files only — main is implicit at position 0
          // via effectiveGids prepend at render time). Without explicitly pushing
          // mainImageGid here, the new order JSON references everything EXCEPT main,
          // and VariantGallerySection's tail-append then pushes main to the very
          // end of the combined sequence — visually moving the featured image to
          // the back of the gallery.
          const mainImageGid = targetVariant?.mainImageGid;
          if (mainImageGid && !locallyExcludedMainGids.has(targetContainerId)) {
            entries.push({ kind: "file", value: mainImageGid });
          }
          for (const g of existingFileGids) {
            if (g !== mainImageGid) entries.push({ kind: "file", value: g });
          }
          for (const u of externalUrls) entries.push({ kind: "url", value: u });
          for (const u of modelUrls) entries.push({ kind: "model", value: u });
        }
        entries = entries.filter(e => !(e.kind === "file" && e.value === gid));
        entries.push({ kind: "file", value: gid });
        const newOrderJson = JSON.stringify(entries);
        setPendingGalleryOrder(p => ({ ...p, [targetContainerId]: newOrderJson }));
        onGalleryOrderChange?.({ ...pendingGalleryOrderRef.current, [targetContainerId]: newOrderJson });
      }
    }
  }, [pendingProductImageOrder, effectiveProductImages, variants, pendingVariantGalleries, pendingGalleryOrder, pendingExternalVideos, pendingVariant3dModels, fileUrlMap, urlToGid, locallyExcludedMainGids, effectivePendingMains, effectiveRemovals, effectiveMoves, imageMetas, t, handleProductReorder, handleVariantReorder, onGalleryOrderChange]); // eslint-disable-line react-hooks/exhaustive-deps

  // prepend=true → image lands at position 0 (main image slot, triggered by placeholder click)
  // prepend=false → image appended to end of gallery
  const handleDropToVariant = useCallback((targetVariantId: string, prepend = false) => {
    const bulkGids = bulkItems
      .filter(i => selectedBulkIds.has(i.uniqueId) && i.status === "ready")
      .map(i => i.resourceUrl);

    let refusedAny = false;
    const galleryGids = [...new Set(
      [...selectedGalleryItems.keys()]
        .map(key => {
          const u = (() => { const sep = key.indexOf("::"); return sep !== -1 ? key.slice(sep + 2) : key; })();
          const ref = fileRefOfUrl(u);
          if (ref && notFileEntry(ref, u)) { refusedAny = true; return undefined; }
          return ref;
        })
        .filter(Boolean) as string[]
    )];
    if (refusedAny) setMediaError(t.imageManager.mediaNotDroppable);

    const newGids = [...bulkGids, ...galleryGids];
    if (newGids.length === 0) return;
    // A selected medium the target already shows: the whole action is refused BEFORE anything changes
    // (a move would take it off its source without adding it anywhere).
    for (const [key, sourceId] of selectedGalleryItems.entries()) {
      if (sourceId === targetVariantId) continue;
      const u = (() => { const sep = key.indexOf("::"); return sep !== -1 ? key.slice(sep + 2) : key; })();
      const ref = fileRefOfUrl(u);
      if (ref && !notFileEntry(ref, u) && refuseIfTargetHolds(targetVariantId, ref, u)) return;
    }
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
        const gid = fileRefOfUrl(url);
        if (!gid || notFileEntry(gid, url)) continue;
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
  }, [bulkItems, selectedBulkIds, selectedGalleryItems, activeAction, variants, urlToGid, fileUrlMap, locallyExcludedMainGids, onRemoveBulk, onSetAction, imageMetas, pendingProductNewMedia, t]); // eslint-disable-line react-hooks/exhaustive-deps

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
        } else if (it.source === "external_url") {
          // Without this, imageMetas had no entry for the queued YouTube/Vimeo
          // URL — the DragOverlay then fell into the "treat as image" branch
          // and rendered the YouTube watch URL inside <img src> (broken link
          // during drag).
          if (!next[it.url]) next[it.url] = { kind: "external_video", previewUrl: youtubeThumbForUrl(it.url) ?? "" };
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
            // Library-picked models inherit Shopify's auto-generated
            // Model3d.preview thumbnail (the same URL the modal grid
            // showed). Without forwarding it the variant tile fell back
            // to the "3D" placeholder even though we already had a real
            // image to display.
            if (it.assetUrl) handleAddThreeDModelUrl(variantId, it.assetUrl, it.previewUrl ?? "");
          } else {
            // A library image this product does not hold is CLONED into the product media on save
            // (productCreateMedia from its asset URL). The gallery then references that clone through
            // the staged URL (resolved to the clone's GID on save), never the library original: the
            // original would later be attached to the product by a promotion and the image would
            // exist twice in the product gallery.
            const willClone = it.kind === "image" && !shopifyMediaMap[it.gid] && !!it.assetUrl;
            refsForGallery.push(willClone ? (it.assetUrl as string) : it.gid);
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

    // Always close the modal once the merchant has hit "Add selected".
    // External URLs used to skip the modal entirely (onAddExternalUrl fired
    // synchronously when the merchant pressed "+ Add URL"), so the modal
    // intentionally stayed open after a URL commit. URLs now queue in the
    // same selection grid as uploads / library picks and ride out via the
    // same Add-selected button — closing the modal afterwards keeps the
    // flow consistent across all three sources.
    setPickerTarget(null);
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
    // Removing the main image of a variant in a pending move (or the moved image itself) is refused.
    if (inPendingMove(variantId) && (
      (!!variant?.defaultImageUrl && urlSet.has(variant.defaultImageUrl)) ||
      effectiveMoves.some(m => m.targetVariantId === variantId && urlSet.has(fileUrlMap[m.gid] ?? "")))) {
      setMediaError(t.imageManager.mainMoveSaveFirst);
      return;
    }

    // If the variant's main image (injected at position 0) is among the removed URLs,
    // mark it as locally excluded so Shopify's mediaId gets cleared on save.
    // The removal names the GID that is removed (an unnameable one is not guessed at).
    if (variant?.defaultImageUrl && urlSet.has(variant.defaultImageUrl)) {
      const mainGid = mainGidOfVariant(variant);
      if (mainGid) setRemovedMains(prev => ({ ...prev, [variantId]: mainGid }));
      else setMediaError(t.imageManager.mainNotNameable);
    }
    // A chosen-but-unsaved main image that is removed hands the first slot to the next image in the
    // visible order (like any removed main image); when that is the main image the merchant first saw,
    // the choice simply ends.
    {
      const pm = effectivePendingMains[variantId];
      if (pm && urlSet.has(fileUrlMap[pm.gid] ?? "")) {
        const nativeNow = variant ? mainGidOfVariant(variant) : undefined;
        const shownNow = displayMain({
          nativeMainGid: nativeNow,
          removed: !!effectiveRemovals[variantId],
          pendingMain: pm.gid,
          stored: pendingVariantGalleries[variantId] ?? variant?.galleryFileGids ?? [],
          orderJson: pendingGalleryOrderRef.current[variantId] ?? variant?.galleryOrderJson ?? null,
          isCandidate: isPromotable,
        });
        const removedGids = new Set(Object.entries(fileUrlMap).filter(([, u]) => urlSet.has(u)).map(([g]) => g));
        const visible = visibleFileOrder(shownNow.gids, orderShowingMain(pendingGalleryOrderRef.current[variantId] ?? variant?.galleryOrderJson ?? null, shownNow.mainGid));
        const nextHead = visible.find(g => isImageGid(g) && !removedGids.has(g));
        setPendingMains(p => {
          const rest = Object.fromEntries(Object.entries(p).filter(([k]) => k !== variantId));
          if (!nextHead || nextHead === pm.expected) return rest;
          return { ...rest, [variantId]: { gid: nextHead, expected: pm.expected } };
        });
      }
    }
    // A removed link or model leaves the pending order too (the embed renders them straight from the
    // order): taken from the pending order, or from the stored one when none is pending yet.
    {
      const raw = pendingGalleryOrderRef.current[variantId] ?? variant?.galleryOrderJson ?? null;
      const entries = parseGalleryOrder(raw);
      if (entries) {
        const kept = entries.filter(e => !((e.kind === "url" || e.kind === "model") && urlSet.has(e.value)));
        if (kept.length !== entries.length) {
          const fixed = orderWithoutFiles(JSON.stringify(kept), new Set());
          const next = Object.fromEntries(Object.entries(pendingGalleryOrderRef.current).filter(([k]) => k !== variantId));
          // no file entry left: the stored order (which still lists the removed entries) is cleared
          if (fixed) next[variantId] = fixed;
          else if (variant?.galleryOrderJson) next[variantId] = "";
          pendingGalleryOrderRef.current = next;
          setPendingGalleryOrder(next);
          onGalleryOrderChange?.(next);
        }
      }
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
  }, [variants, fileUrlMap, urlToGid, t, effectivePendingMains, effectiveRemovals, effectiveMoves, pendingVariantGalleries, onGalleryOrderChange, isPromotable, pendingVariant3dModels, onExternalVideosChange, onThreeDModelsChange, onThreeDPreviewsChange]); // eslint-disable-line react-hooks/exhaustive-deps

  const productSelectedUrls = useMemo(() => {
    const urls: string[] = [];
    for (const [key, sourceVariantId] of selectedGalleryItems) {
      if (sourceVariantId === null && key.startsWith("product::")) {
        urls.push(key.slice("product::".length));
      }
    }
    return urls;
  }, [selectedGalleryItems]);

  // Per-language media state (product page only): the delete path reports a
  // failed clean-up of the deleted originals' replacements through it.
  const localizedMediaState = useLocalizedMediaContext()?.state ?? null;
  const localizedMediaRef = useRef(localizedMediaState);
  localizedMediaRef.current = localizedMediaState;

  const handleConfirmDelete = useCallback(async () => {
    if (!deleteConfirm) return;
    // Deleting an image takes it off every variant that uses it: with the variants unknown (a read that
    // failed or is still out) neither the warning nor the removal of its entries can be right.
    if (!variantsKnown) {
      setDeleteConfirm(null);
      setMediaError(t.imageManager.variantsNotLoadedAction);
      return;
    }
    const { urls } = deleteConfirm;
    const gids = urls.map(url => urlToGid[url]).filter(Boolean) as string[];
    const urlSet = new Set(urls);
    const gidSet = new Set(gids);
    const startedProductId = productId;
    const switchedAway = () => productIdRef.current !== startedProductId;
    // Deleting the main image of a variant in a pending move is refused before anything is sent.
    if (variants.some(v => inPendingMove(v.id) && !!v.defaultImageUrl && urlSet.has(v.defaultImageUrl))) {
      setDeleteConfirm(null);
      setMediaError(t.imageManager.mainMoveSaveFirst);
      return;
    }

    setIsDeleting(true);
    setDeleteConfirm(null);
    // What the optimistic removal takes out, with its positions, so a refused
    // delete can put exactly those entries back into whatever the state has
    // become meanwhile (a whole-state snapshot would discard edits made while
    // the request was in flight).
    // Staged resourceUrls of removed queued tiles: a tile dragged into a variant
    // gallery sits there under its staging URL, which no GID lookup resolves.
    const removedQueuedRefs = queuedResourceUrls(pendingProductNewMedia, urls);
    // Positions are taken from the list AFTER those refs are stripped: that is
    // the list a refused delete reinserts into, and positions counted with the
    // staging refs still in it would put a restored image one slot late.
    const strippedGalleries = stripRefsFromGalleries(pendingVariantGalleries, removedQueuedRefs);
    const removedFromGalleries: Record<string, RemovedEntry<string>[]> = {};
    for (const v of variants) {
      const removed = captureRemoved(strippedGalleries[v.id] ?? v.galleryFileGids, gid => gidSet.has(gid));
      if (removed.length > 0) removedFromGalleries[v.id] = removed;
    }
    const originalOrder = pendingProductImageOrder ?? effectiveProductImages.map(i => i.url);
    const orderWasUnset = pendingProductImageOrder === null;
    const originalGalleries: Record<string, string[] | undefined> = {};
    for (const v of variants) originalGalleries[v.id] = pendingVariantGalleries[v.id];
    const removedSelection: Array<[string, string | null]> = [];
    for (const url of urls) {
      const key = `product::${url}`;
      if (selectedGalleryItems.has(key)) removedSelection.push([key, selectedGalleryItems.get(key) ?? null]);
    }
    // Queued tiles are removed for good (never restored by a failed Shopify delete).
    const queuedUrls = new Set(pendingProductNewMedia.map(m => m.previewUrl).filter((u): u is string => !!u));
    const removedFromOrder = captureRemoved(originalOrder, url => urlSet.has(url) && !queuedUrls.has(url));
    const removedFromRefreshed = captureRemoved(effectiveProductImages, img => urlSet.has(img.url) && !queuedUrls.has(img.url));
    const variantsWithDeletedMainImage = variants.filter(v => v.defaultImageUrl && urlSet.has(v.defaultImageUrl));
    const addedExcludedIds = variantsWithDeletedMainImage.map(v => v.id).filter(id => !locallyExcludedMainGids.has(id));
    // What each of those variants' main image was (the removal names the GID that is removed).
    const deletedMainGidByVariant = new Map<string, string>();
    for (const v of variantsWithDeletedMainImage) {
      const g = mainGidOfVariant(v);
      if (g) deletedMainGidByVariant.set(v.id, g);
    }

    // Optimistically remove from local state
    setPendingVariantGalleries(p => {
      // A copy: with nothing to strip the helper hands back `p` itself, and the
      // loop below must never write into the previous state object.
      const next = { ...stripRefsFromGalleries(p, removedQueuedRefs) };
      const queuedRefSet = new Set(removedQueuedRefs);
      for (const v of variants) {
        // Read the STRIPPED list: starting from `p` here wrote a removed
        // queued tile's staging URL back whenever the same delete also took a
        // saved image out of this variant.
        const current = next[v.id] ?? v.galleryFileGids;
        const filtered = current.filter(gid => !gidSet.has(gid));
        if (filtered.length !== current.length) next[v.id] = filtered;
        // A list the strip returned to exactly the stored gallery is no change
        // at all; keeping the key would light Save up for a no-op write.
        const stored = v.galleryFileGids;
        const now = next[v.id];
        if (
          now &&
          now.length === stored.length &&
          now.every((g, i) => g === stored[i]) &&
          (p[v.id] ?? []).some(ref => queuedRefSet.has(ref))
        ) {
          delete next[v.id];
        }
      }
      return next;
    });
    // Variants whose featured image was deleted: exclude from gallery now,
    // unset on Shopify only after the delete is confirmed.
    setRemovedMains(prev => {
      const next = { ...prev };
      for (const v of variantsWithDeletedMainImage) {
        const gid = mainGidOfVariant(v);
        if (gid) next[v.id] = gid;
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
    // Queued (not yet uploaded) tiles: deleting one removes it from the upload queue.
    const removedQueued = pendingProductNewMedia.filter(m => m.previewUrl && urlSet.has(m.previewUrl));
    if (removedQueued.length > 0) setPendingProductNewMedia(list => removePendingNewMedia(list, urls));

    let deleteOk = false;
    let clearOk: boolean | null = null;
    // Per-id verdict: a partial answer deletes some and keeps others.
    let deletedGids: string[] = [];
    let failedGids: string[] = [...gids];
    try {
      if (gids.length === 0) {
        // Only queued (not yet uploaded) ghost tiles: nothing exists on Shopify
        // to delete, and the route answers 400 for an empty list.
        deleteOk = true;
        failedGids = [];
      } else {
        const deleteRes = await appFetch("/api/delete-product-images", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ productId: startedProductId, mediaIds: gids }),
        });
        const deleteBody = await deleteRes.json().catch(() => null) as { success?: boolean; deletedMediaIds?: string[]; localizedMedia?: { removed?: number; failed?: string } } | null;
        // Only what Shopify ECHOED as deleted counts: every requested id must
        // be in the answer before the variants' main images are cleared.
        const split = splitDeleteAnswer(gids, { ok: deleteRes.ok, body: deleteBody });
        deleteOk = split.allDeleted;
        deletedGids = split.deleted;
        failedGids = split.failed;
        // The route also removes the originals' per-language replacements; the
        // delete stands even if that part failed, and the merchant is told.
        if (deletedGids.length > 0 && deleteBody?.localizedMedia?.failed) localizedMediaRef.current?.reportCleanupFailed(deleteBody.localizedMedia.failed);
        // The server removed the deleted originals' replacements: read the list again.
        if (deletedGids.length > 0) localizedMediaRef.current?.refresh();
      }
      // Shopify does not automatically clear a variant's image when the referenced media is
      // deleted. Unset mediaId for the affected variants, but only AFTER a confirmed delete,
      // so a refused delete changes nothing on Shopify.
      const deletedSet = new Set(deletedGids);
      const clearMainImages = [...deletedMainGidByVariant.entries()]
        .filter(([, gid]) => deletedSet.has(gid))
        .map(([variantId, removedMainGid]) => ({ variantId, removedMainGid }));
      const clearMainImageIds = clearMainImages.map(c => c.variantId);
      // The server promotes what the editor SHOWS: a variant with a pending gallery sends that list,
      // its order and the merchant's explicit main choice together with the removal (a bare removal
      // would promote from the STORED gallery and the two would disagree). Unsaved uploads
      // (staging references) are not sent; they stay pending here.
      const clearBody2 = (pid: string, list: Array<{ variantId: string; removedMainGid: string }>) => {
        const variantGalleries: Array<Record<string, unknown>> = [];
        const variantGalleryOrder: Array<{ variantId: string; orderJson: string }> = [];
        const removedOnly: Array<{ variantId: string; removedMainGid: string }> = [];
        for (const c of list) {
          const pending = pendingVariantGalleries[c.variantId];
          if (!pending) { removedOnly.push(c); continue; }
          const chosen = effectivePendingMains[c.variantId]?.gid;
          variantGalleries.push({
            variantId: c.variantId,
            fileGids: pending.filter(g => g.startsWith("gid://") && !deletedSet.has(g)),
            removedMainGid: c.removedMainGid,
            ...(chosen && !deletedSet.has(chosen) ? { mainGid: chosen } : {}),
          });
          const orderRaw = pendingGalleryOrder[c.variantId];
          if (orderRaw === "") variantGalleryOrder.push({ variantId: c.variantId, orderJson: "" });
          else if (orderRaw) {
            // Only what is stored already goes out now: saved files, and links / models the variant
            // already holds. An unsaved link or model must not go live through a delete (the embed
            // renders them straight from the order, and Discard could not take them back).
            const stored = variants.find(v => v.id === c.variantId);
            // (a stored link / model the merchant removed meanwhile is not sent again)
            const pendingUrls = pendingExternalVideos[c.variantId];
            const pendingModels = pendingVariant3dModels[c.variantId];
            const storedUrls = new Set((stored?.externalVideoUrls ?? []).filter(u => !pendingUrls || pendingUrls.includes(u)));
            const storedModels = new Set((stored?.threeDModelUrls ?? []).filter(u => !pendingModels || pendingModels.includes(u)));
            try {
              const parsed = JSON.parse(orderRaw) as Array<{ kind: string; value: string }>;
              const kept = parsed.filter(e =>
                e.kind === "file" ? e.value.startsWith("gid://") && !deletedSet.has(e.value)
                : e.kind === "url" ? storedUrls.has(e.value)
                : e.kind === "model" ? storedModels.has(e.value) : false);
              const fixed = orderWithoutFiles(JSON.stringify(kept), new Set());
              if (fixed) variantGalleryOrder.push({ variantId: c.variantId, orderJson: fixed });
              else if (stored?.galleryOrderJson) variantGalleryOrder.push({ variantId: c.variantId, orderJson: "" });
            } catch { /* an unreadable order is not sent */ }
          }
        }
        return { productId: pid, removedMainImages: removedOnly, variantGalleries, variantGalleryOrder };
      };
      if (clearMainImageIds.length > 0) {
        try {
          // The removal names the GID that was deleted: the server acts only while the
          // variant's main image still is that one, so a replay changes nothing.
          const clearRes = await appFetch("/api/update-variant-galleries", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(clearBody2(startedProductId, clearMainImages)),
          });
          const clearBody = await clearRes.json().catch(() => null) as { success?: boolean } | null;
          clearOk = clearRes.ok && !!clearBody && clearBody.success !== false;
          if (clearOk) {
            // The write is DONE: the next image of each gallery moved up on Shopify. The
            // removal stays (and shows that image as the main one) until the read that
            // brings it has LANDED, and ends by itself then (it acts only while the main
            // image is still the deleted one), so no save in between, and none after a
            // failed read, can remove the image that just moved up. A chosen main image
            // that was deleted ends with it.
            setPendingMains(p => Object.fromEntries(Object.entries(p).filter(([, pm]) => !deletedSet.has(pm.gid))));
            fetchVariantsForProduct(startedProductId, false, {
              silent: true,
              onLanded: () => setRemovedMains(prev => Object.fromEntries(Object.entries(prev).filter(([k]) => !clearMainImageIds.includes(k)))),
            });
          }
        } catch {
          clearOk = false;
        }
      }
    } catch {
      deleteOk = false;
    }
    if (switchedAway()) {
      // The drafts went with the switch; a queued save of a deleted medium
      // would only come back as "image not found".
      const deletedForQueue = new Set(deletedGids);
      if (deletedForQueue.size > 0) dropQueuedAltSaves(q => deletedForQueue.has(q.mediaId));
      setIsDeleting(false);
      return;
    }
    const failedSet = new Set(failedGids);
    // URLs with no GID were never sent, so they are not deleted either.
    const unsentSet = new Set(unsentUrls(urls, urlToGid, queuedUrls));
    const failedCount = failedGids.length + unsentSet.size;
    const partial = failedCount > 0 && deletedGids.length > 0;
    if (failedCount > 0) {
      // Everything Shopify did NOT confirm deleted comes back.
      const failedUrl = (url: string) => urlNeedsRestore(url, urlToGid, failedSet, unsentSet);
      const restoredOrder = removedFromOrder.filter(e => failedUrl(e.value));
      const restoredRefreshed = removedFromRefreshed.filter(e => (!!e.value.mediaId && failedSet.has(e.value.mediaId)) || failedUrl(e.value.url));
      const failedMainIds = new Set(
        variantsWithDeletedMainImage.filter(v => v.defaultImageUrl && failedUrl(v.defaultImageUrl)).map(v => v.id),
      );
      setPendingVariantGalleries(p => {
        const next = { ...p };
        for (const v of variants) {
          const removed = removedFromGalleries[v.id]?.filter(e => failedSet.has(e.value));
          if (!removed || removed.length === 0) continue;
          const restored = reinsertRemoved(p[v.id] ?? v.galleryFileGids, removed);
          const base = originalGalleries[v.id] ?? v.galleryFileGids;
          const sameAs = (list: readonly string[]) =>
            restored.length === list.length && restored.every((g, i) => g === list[i]);
          // Back to the pre-delete list: restore the prior presence/absence so
          // a no-op does not light up the Save button. Equal to the STORED
          // gallery is a no-op too -- the pre-delete list may have differed only
          // by a queued tile's staging ref, which this delete removed for good.
          if ((sameAs(base) && originalGalleries[v.id] === undefined) || sameAs(v.galleryFileGids)) delete next[v.id];
          else next[v.id] = restored;
        }
        return next;
      });
      setRemovedMains(prev => {
        const next = { ...prev };
        addedExcludedIds.filter(id => failedMainIds.has(id)).forEach(id => { delete next[id]; });
        return next;
      });
      setPendingProductImageOrder(curr => {
        if (!curr) return curr;
        const restored = reinsertRemoved(curr, restoredOrder);
        if (orderWasUnset && restored.length === originalOrder.length && restored.every((u, i) => u === originalOrder[i])) return null;
        return restored;
      });
      setSelectedGalleryItems(m => {
        const next = new Map(m);
        for (const [k, v] of removedSelection) {
          if (failedUrl(k.slice("product::".length)) && !next.has(k)) next.set(k, v);
        }
        return next;
      });
      setRefreshedProductImages(curr => (curr ? reinsertRemoved(curr, restoredRefreshed, (a, b) => a.url === b.url) : curr));
      // A queued tile is removed for good even when the Shopify delete failed.
      setMediaError(
        partial
          ? t.imageManager.mediaDeletePartial.replace("{failed}", String(failedCount)).replace("{deleted}", String(deletedGids.length))
          : t.imageManager.mediaDeleteFailed,
      );
    }
    if (deletedGids.length > 0) {
      // A deleted node can never turn up in shopifyMediaMap, so a settling
      // entry for it would keep its tile on screen forever. Retire it only now
      // that the delete is confirmed (per id: a partial answer retires its half).
      const deletedIdSet = new Set(deletedGids);
      // Deleted files are not written back into any pending order either, and the order must still
      // start with a file (the first remaining file moves to the front; none left drops the order).
      // Computed from the ref and applied OUTSIDE the state updater (an updater must stay pure).
      {
        const next: Record<string, string> = {};
        for (const [vid, raw] of Object.entries(pendingGalleryOrderRef.current)) {
          const fixed = orderWithoutFiles(raw, deletedIdSet);
          if (fixed) next[vid] = fixed;
          else if (variants.find(v => v.id === vid)?.galleryOrderJson) next[vid] = "";
        }
        pendingGalleryOrderRef.current = next;
        setPendingGalleryOrder(next);
        onGalleryOrderChange?.(next);
      }
      // A chosen main image whose medium is deleted ends with it, whatever the removal branch did.
      setPendingMains(p => Object.fromEntries(Object.entries(p).filter(([, pm]) => !deletedIdSet.has(pm.gid))));
      onSettlingMediaResolved?.(deletedGids);
      pendingMediaOrderRef.current = pendingMediaOrderRef.current.filter(o => !deletedIdSet.has(o.mediaId));
      if (clearOk === false) {
        setMediaError(
          partial
            ? `${t.imageManager.mediaDeletePartial.replace("{failed}", String(failedCount)).replace("{deleted}", String(deletedGids.length))} ${t.imageManager.mediaClearMainFailed}`
            : t.imageManager.mediaClearMainFailed,
        );
      }
    }
    // The alt drafts of what is really gone go with it: media Shopify CONFIRMED
    // deleted (looked up in the maps as they were BEFORE the delete -- both
    // galleries, `?v=`-tolerant) and the unsaved uploads removed from the queue.
    const deletedAltLookup: Record<string, string> = {};
    for (const [gid, url] of Object.entries(fileUrlMap)) if (url) deletedAltLookup[url] = gid;
    Object.assign(deletedAltLookup, urlToGid);
    dropAltDraftsOfDeletedMedia(
      new Set(deletedGids),
      new Set(removedQueued.map(m => m.previewUrl).filter((u): u is string => !!u)),
      deletedAltLookup,
    );
    setIsDeleting(false);
  }, [deleteConfirm, variantsKnown, urlToGid, fileUrlMap, variants, effectiveProductImages, productId, onSettlingMediaResolved, pendingVariantGalleries, pendingGalleryOrder, pendingExternalVideos, pendingVariant3dModels, effectivePendingMains, effectiveMoves, locallyExcludedMainGids, pendingProductImageOrder, selectedGalleryItems, pendingProductNewMedia, t, fetchVariantsForProduct]);

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
      const res = await appFetch("/api/convert-webp", {
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
    setMediaError(null);
    const failedFiles: string[] = [];
    for (const file of files) {
      try {
        const res = await appFetch("/api/staged-upload", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filename: file.name, mimeType: file.type, fileSize: file.size }),
        });
        const { url, resourceUrl, parameters, httpMethod, error, code, limit } = await res.json();
        if (code === "IMAGE_QUOTA_EXCEEDED") {
          setWebpError(t.imageManager.imageQuotaExceeded.replace("{limit}", String(limit ?? "")));
          break;
        }
        if (error || !url) {
          failedFiles.push(file.name);
          continue;
        }

        await uploadToStagedTarget({ url, httpMethod, parameters }, file);

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
        // The file is skipped, not added; the merchant is told which one.
        failedFiles.push(file.name);
      }
    }
    if (failedFiles.length > 0) {
      setMediaError(t.imageManager.uploadFailedFiles.replace("{files}", failedFiles.join(", ")));
    }
  }, [variants, urlToGid, locallyExcludedMainGids, t]);

  const handleUploadToProductGallery = useCallback(async (files: File[]) => {
    setWebpError(null); // clear any stale error before a fresh upload
    setMediaError(null);
    const failedFiles: string[] = [];
    for (const file of files) {
      try {
        // Classify so we (a) know what to push into pendingProductNewMedia
        // (which is typed as Array<{resourceUrl, kind, previewUrl?}>) and
        // (b) dispatch the upload XHR correctly per Shopify's resource type.
        const kind: MediaKind = (classifyFile(file.type, file.name) ?? "image");
        const res = await appFetch("/api/staged-upload", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filename: file.name, mimeType: file.type, fileSize: file.size }),
        });
        const { url, resourceUrl, parameters, httpMethod, error, code, limit } = await res.json();
        if (code === "IMAGE_QUOTA_EXCEEDED") {
          setWebpError(t.imageManager.imageQuotaExceeded.replace("{limit}", String(limit ?? "")));
          break;
        }
        if (error || !url) {
          failedFiles.push(file.name);
          continue;
        }

        await uploadToStagedTarget({ url, httpMethod, parameters }, file);

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
        // The file is skipped, not added; the merchant is told which one.
        failedFiles.push(file.name);
      }
    }
    if (failedFiles.length > 0) {
      setMediaError(t.imageManager.uploadFailedFiles.replace("{files}", failedFiles.join(", ")));
    }
  }, [t]);

  // Watch altTextFetcher for AI generate / translate results → auto-save result
  useEffect(() => {
    const data = altTextFetcher.data;
    if (!data || data === prevAltFetcherData.current) return;
    prevAltFetcherData.current = data;
    if (data.errorCode === "imageNotFound") {
      setMediaError(t.imageManager.altImageNotFound);
      return;
    }
    const im = t.imageManager;
    const failText = (message: string) =>
      message
        ? String(im?.altAiFailed ?? "The alt text could not be created: {error}").replace("{error}", message)
        : String(im?.altSaveFailed ?? "The alt text could not be saved. Your text is kept, please try again.");
    if (data.actionType === "translateAltTextToAllLocales") {
      const verdict = classifyAllLocalesResponse(data, enabledLanguages.filter(l => l !== primaryLocale));
      if (verdict.kind === "success") {
        showInfoBox(String(im?.altTranslateAllLocalesSuccess ?? "Alt text translated to {count} language(s).").replace("{count}", String(verdict.savedCount)), "success");
        reloadForeignAlts();
      } else if (verdict.kind === "partial") {
        showInfoBox(String(im?.altTranslateAllLocalesPartial ?? "Alt text partially translated. Language(s) {failedLocales} could not be saved.").replace("{failedLocales}", verdict.failedLocales.join(", ")), "warning");
        reloadForeignAlts();
      } else if (verdict.kind === "refused") {
        showInfoBox(verdict.message || failText(""), "critical");
      } else if (verdict.kind === "noSource") {
        showInfoBox(String(im?.translateAltNoPrimary ?? "This image has no saved alt text in the primary language yet."), "warning");
      } else {
        showInfoBox(failText(verdict.message), "critical");
      }
      return;
    }
    const aiVerdict = classifyAltAiResponse(data);
    if (aiVerdict.kind === "noSource") {
      showInfoBox(String(im?.translateAltNoPrimary ?? "This image has no saved alt text in the primary language yet."), "warning");
      return;
    }
    if (aiVerdict.kind !== "ok") {
      showInfoBox(aiVerdict.kind === "refused" && aiVerdict.message ? aiVerdict.message : failText(aiVerdict.message), "critical");
      return;
    }
    // The reply belongs to the image and language the request was made for,
    // not to whatever sits at that position now.
    const req = altAiRequestRef.current;
    if (!req || req.productId !== productIdRef.current) return;
    const url = req.url;
    // The tile must still show the medium the request was made for -- a
    // product image or a library file in a variant gallery alike.
    const mediaId = urlToGid[url] ?? gidForUrl(altGidLookup, url);
    if (!mediaId || (req.mediaId && req.mediaId !== mediaId)) return;
    const generated =
      data.actionType === "generateAltText" && data.altText !== undefined ? (data.altText as string)
      : data.actionType === "translateAltText" && data.translatedAltText !== undefined ? (data.translatedAltText as string)
      : undefined;
    if (generated === undefined) return;
    // An empty translation is not one: applied and saved, it would CLEAR the
    // alt the merchant asked to fill.
    if (data.actionType === "translateAltText" && generated.trim() === "") {
      showInfoBox(failText(""), "critical");
      return;
    }
    // ✨ generate is a SUGGESTION (owner, 2026-10-03: consistent with every
    // other field): it is shown next to the image's alt field and nothing is
    // written until the merchant accepts it. It is stored under the product,
    // language, market and medium the request was made for, so it only shows
    // there -- a view that moved on simply does not display it.
    if (data.actionType === "generateAltText") {
      setAltSuggestions((m) => withAltSuggestion(m, { productId: req.productId, locale: req.locale, marketId: req.marketId, mediaId }, generated));
      return;
    }
    // 🌍 translate (single language) is saved at once, for this image only
    // (owner's rule, 2026-10-02: AI buttons save immediately, typing stays a
    // draft): the text goes into the field exactly like a typed one, and that
    // one medium's save is queued behind whatever is already out -- with the
    // language and market the request was made for. Every other image's draft
    // stays a draft. A confirmed save clears the image's dirty state; a failed
    // one keeps it dirty and failed, so the page Save sends it again. If the
    // view moved on there is no field to put it in.
    if (req.locale === currentLanguageRef.current && (req.marketId ?? "") === viewMarketRef.current) {
      applyAltDraft(url, generated);
      const entry = planImmediateAltSave({
        url,
        dirtyUrls: dirtyUrlsRef.current,
        texts: localAltTextsRef.current,
        gidOf: (u) => (u === url ? mediaId : gidForUrl(altGidLookup, u)),
        locale: req.locale,
        marketId: req.marketId || undefined,
        productId: req.productId,
        productTitle,
        editOrder: altEditOrderRef.current,
      });
      if (entry) {
        failedAltUrlsRef.current.delete(entry.url);
        for (const alias of entry.aliases ?? []) failedAltUrlsRef.current.delete(alias.url);
        submitAltSave(entry);
      }
    } else {
      showInfoBox(String(im?.altAiResultDiscarded ?? "The generated alt text was not applied because you switched language or market."), "warning");
    }
  }, [altTextFetcher.data, effectiveProductImages]); // eslint-disable-line react-hooks/exhaustive-deps

  // Typing, AI generate and AI translate all end here: the text goes into the
  // field and the image counts as dirty (the page's save bar lights up). Nothing
  // is written until the merchant presses Save.
  const applyAltDraft = useCallback((url: string, value: string) => {
    if (!dirtyUrlsRef.current.has(url) && !altBaselinesRef.current.has(url)) {
      altBaselinesRef.current.set(url, localAltTextsRef.current[url]);
    }
    localAltTextsRef.current = { ...localAltTextsRef.current, [url]: value };
    setLocalAltTexts(p => ({ ...p, [url]: value }));
    dirtyUrlsRef.current.add(url);
    altEditOrderRef.current.set(url, ++altEditSeqRef.current);
    syncAltDirty();
  }, [syncAltDirty]);

  const handleAltTextChange = applyAltDraft;

  /** Every save that is still out: in flight and queued (with the tile url it now has). */
  const pendingAltSaves = (): QueuedAltSave[] => {
    const out: QueuedAltSave[] = [];
    if (altSaveInFlightRef.current) out.push(altSaveInFlightRef.current);
    out.push(...altSaveQueueRef.current);
    return out;
  };

  /**
   * Releases every carried-over draft matching `pick` (it will not be sent)
   * and says so once: `true` = the image is not there yet, a string = that
   * sentence instead (the reason differs), false = silently (Discard, a delete).
   */
  const releaseDeferredAlts = (pick: (url: string, d: { draft: Omit<QueuedAltSave, "mediaId">; applied: string }) => boolean, warn: boolean | string) => {
    const tokens: object[] = [];
    for (const [url, d] of [...deferredAltRef.current]) {
      if (!pick(url, d)) continue;
      deferredAltRef.current.delete(url);
      tokens.push(d.token);
    }
    if (tokens.length === 0) return;
    releaseAltTokens(tokens);
    syncAltSaving();
    if (typeof warn === "string") showInfoBox(warn, "warning");
    else if (warn) {
      showInfoBox(String(t.imageManager?.altDraftNotSavableYet ?? "The alt text of an image that is not saved yet can only be saved after the image itself. Save again once the image is uploaded."), "warning");
    }
  };

  /** Takes the drafts of these urls out entirely (text, dirty and failed flags, baseline, edit order). */
  const dropAltDraftUrls = (urls: readonly string[]) => {
    if (urls.length === 0) return;
    const next = dropAltDrafts({
      texts: localAltTextsRef.current,
      dirty: dirtyUrlsRef.current,
      baselines: altBaselinesRef.current,
      failed: failedAltUrlsRef.current,
      editOrder: altEditOrderRef.current,
    }, urls);
    localAltTextsRef.current = next.texts;
    setLocalAltTexts(next.texts);
    dirtyUrlsRef.current = next.dirty;
    altBaselinesRef.current = next.baselines;
    failedAltUrlsRef.current = next.failed;
    altEditOrderRef.current = next.editOrder;
    syncAltDirty();
  };

  /** Drops the QUEUED saves (never the one in flight) matching `drop`; whoever waited for them counts them as unsent. */
  const dropQueuedAltSaves = (drop: (q: QueuedAltSave) => boolean) => {
    const { kept, dropped } = partitionAltQueue(altSaveQueueRef.current, drop);
    if (dropped.length === 0) return;
    altSaveQueueRef.current = kept;
    releaseAltTokens(dropped);
    syncAltSaving();
  };

  /**
   * After a CONFIRMED delete: the deleted media's drafts, failed flags and
   * queued saves go with them (every language and market -- the medium is
   * gone in all of them), and so do the drafts of removed unsaved uploads.
   * Left behind they kept the save bar up, failed every Save with
   * "image not found" and locked translate-to-all for good.
   */
  const dropAltDraftsOfDeletedMedia = (deletedGids: ReadonlySet<string>, removedPreviewUrls: ReadonlySet<string>, lookup: Readonly<Record<string, string>>) => {
    const urls = altDraftUrlsOfDeletedMedia(
      new Set([...dirtyUrlsRef.current, ...failedAltUrlsRef.current, ...altBaselinesRef.current.keys(), ...Object.keys(localAltTextsRef.current)]),
      lookup,
      deletedGids,
      removedPreviewUrls,
      gidForUrl,
    );
    dropAltDraftUrls(urls);
    const urlSet = new Set(urls);
    dropQueuedAltSaves((q) => deletedGids.has(q.mediaId) || urlSet.has(resolveAltUrl(q.url)));
    releaseDeferredAlts((url) => removedPreviewUrls.has(url) || urlSet.has(url), false);
  };

  /** The page Save: every alt draft through the serial save queue. Resolves when each was answered. */
  const flushAltDrafts = useCallback((opts?: { galleryApply?: Promise<unknown> }): Promise<AltFlushSummary> => {
    const plan = planAltFlush({
      dirtyUrls: [...dirtyUrlsRef.current],
      texts: localAltTextsRef.current,
      urlToGid,
      locale: currentLanguage,
      marketId: foreignMarketId,
      productId,
      productTitle,
      editOrder: altEditOrderRef.current,
    });
    // A second Save while the first one's saves are still out does not send
    // the SAME text again -- it waits for it. A changed text is sent anew.
    const { send, reuse } = selectAltSends(plan.entries, pendingAltSaves());
    const tokens: object[] = [...reuse, ...send];
    // The alt of an image this very Save is only uploading: carried over and
    // sent once the image exists. Without a gallery save there is nothing to
    // wait for, so it is not sendable now and says so.
    let unsent = 0;
    const carried: string[] = [];
    // An earlier Save already carried a draft over and its image is still
    // being processed: this Save waits for that one (with the current text)
    // instead of reporting it as not sendable. That holds when THIS Save also
    // applies the gallery (another upload): the carried draft belongs to the
    // earlier, finished gallery save, and tying it to the new one would release
    // it as "not saved yet" if the new one failed.
    const stillCarried = plan.unaddressable.filter((url) => deferredAltRef.current.has(url));
    for (const url of stillCarried) {
      const d = deferredAltRef.current.get(url)!;
      d.draft = { ...d.draft, altText: localAltTextsRef.current[url] };
      tokens.push(d.token);
    }
    const notCarried = plan.unaddressable.filter((url) => !stillCarried.includes(url));
    if (notCarried.length > 0) {
      const apply = opts?.galleryApply;
      if (!apply) {
        unsent = notCarried.length;
        showInfoBox(String(t.imageManager?.altDraftNotSavableYet ?? "The alt text of an image that is not saved yet can only be saved after the image itself. Save again once the image is uploaded."), "warning");
      } else {
        for (const url of notCarried) {
          const token = {};
          const prev = deferredAltRef.current.get(url);
          // A newer Save of the same draft: whoever waited for the older one waits for this one.
          if (prev) for (const w of altFlushWaitersRef.current) transferAltFlushWaiter(w.waiter, prev.token, token);
          deferredAltRef.current.set(url, {
            draft: { url, altText: localAltTextsRef.current[url], locale: currentLanguage, marketId: foreignMarketId || undefined, productId, productTitle },
            token,
            applied: "running",
          });
          tokens.push(token);
          carried.push(url);
        }
        apply.then(
          (ok) => {
            if (ok === false) {
              // The gallery save failed: the image does not exist, its alt cannot go anywhere.
              releaseDeferredAlts((url, d) => carried.includes(url) && d.applied === "running", true);
            } else {
              for (const url of carried) {
                const d = deferredAltRef.current.get(url);
                if (d) d.applied = "done";
              }
              setDeferredAltTick((n) => n + 1);
            }
          },
          () => releaseDeferredAlts((url, d) => carried.includes(url) && d.applied === "running", true),
        );
      }
    }
    syncAltSaving();
    if (tokens.length === 0) return Promise.resolve({ ok: 0, failed: 0, unsent });
    return new Promise<AltFlushSummary>((resolve) => {
      altFlushWaitersRef.current = [
        ...altFlushWaitersRef.current,
        { waiter: createAltFlushWaiter(tokens, unsent), resolve },
      ];
      for (const entry of send) {
        failedAltUrlsRef.current.delete(entry.url);
        for (const alias of entry.aliases ?? []) failedAltUrlsRef.current.delete(alias.url);
        submitAltSave(entry);
      }
    });
  }, [urlToGid, currentLanguage, foreignMarketId, productId, productTitle, showInfoBox, t, submitAltSave]); // eslint-disable-line react-hooks/exhaustive-deps

  // Carried-over drafts of uploaded images, and every draft that still sits
  // under an upload's PREVIEW url: once Shopify reports the image, the draft
  // moves to the tile's real url (never stranded under a url no tile shows,
  // which would keep the save bar up for good) and a carried-over one is sent.
  const knownSettledAltRef = useRef(new Map<string, SettlingAltSource>());
  useEffect(() => {
    for (const s of settlingMedia ?? []) {
      if (s.previewUrl) knownSettledAltRef.current.set(s.previewUrl, { productId: s.productId, mediaId: s.mediaId, previewUrl: s.previewUrl });
    }
    const known = [...knownSettledAltRef.current.values()];
    // 1. Re-key the drafts of settled uploads.
    const renames = settledAltRenames(known, productId, shopifyMediaMap);
    const touched = Object.keys(renames).filter((from) =>
      from in localAltTextsRef.current || dirtyUrlsRef.current.has(from) || failedAltUrlsRef.current.has(from) || altBaselinesRef.current.has(from));
    for (const [from, to] of Object.entries(renames)) altUrlRenamesRef.current.set(from, to);
    if (touched.length > 0) {
      const next = rekeyAltDrafts({
        texts: localAltTextsRef.current,
        dirty: dirtyUrlsRef.current,
        baselines: altBaselinesRef.current,
        failed: failedAltUrlsRef.current,
        editOrder: altEditOrderRef.current,
      }, Object.fromEntries(touched.map((from) => [from, renames[from]])));
      localAltTextsRef.current = next.texts;
      setLocalAltTexts(next.texts);
      dirtyUrlsRef.current = next.dirty;
      altBaselinesRef.current = next.baselines;
      failedAltUrlsRef.current = next.failed;
      altEditOrderRef.current = next.editOrder;
      syncAltDirty();
    }
    // 2. Send what was carried over, once its image exists.
    const toSend: Array<{ token: object; entry: QueuedAltSave }> = [];
    for (const [url, d] of [...deferredAltRef.current]) {
      if (d.draft.productId !== productId) continue;
      const hit = knownSettledAltRef.current.get(url);
      if (!hit || hit.productId !== productId) continue;
      const realUrl = shopifyMediaMap[hit.mediaId];
      if (!realUrl) continue; // Shopify still processes it.
      deferredAltRef.current.delete(url);
      toSend.push({ token: d.token, entry: { ...d.draft, url: realUrl, mediaId: hit.mediaId } });
    }
    for (const { token, entry } of toSend) {
      for (const w of altFlushWaitersRef.current) transferAltFlushWaiter(w.waiter, token, entry);
      submitAltSave(entry);
    }
    // 3. What can never be sent: another product's (its uploads are no longer
    //    tracked once the merchant switched away -- the image itself WAS
    //    created, so the note says what really happened), or an image the
    //    finished gallery save did not create.
    releaseDeferredAlts((_url, d) => d.draft.productId !== productId,
      String(t.imageManager?.altDraftProductSwitched ?? "The alt text of a newly uploaded image was not saved because you switched to another product while Shopify was still processing the image. Open the product again and enter it once the image shows in the gallery."));
    releaseDeferredAlts((url, d) => d.applied === "done" && !knownSettledAltRef.current.has(url), true);
    // 4. A draft under a url that no tile shows any more, that no medium
    //    resolves and that nothing will move (an upload removed before it was
    //    saved, a medium deleted or swapped for a WebP copy): dropped with a
    //    note rather than holding the bar up and failing every Save. Not while
    //    a delete is in flight: its tiles are already removed optimistically,
    //    and a refused delete brings them back -- with their drafts.
    if (isDeleting) return;
    const shown = new Set<string>([...displayedProductUrls, ...Object.values(fileUrlMap)]);
    const altLookup: Record<string, string> = {};
    for (const [gid, url] of Object.entries(fileUrlMap)) if (url) altLookup[url] = gid;
    Object.assign(altLookup, urlToGid);
    const stranded = strandedAltDraftUrls({
      dirtyUrls: dirtyUrlsRef.current,
      lookup: altLookup,
      shown,
      carried: new Set(deferredAltRef.current.keys()),
      settlingPreviews: new Set(knownSettledAltRef.current.keys()),
      gidOf: gidForUrl,
    });
    if (stranded.length > 0) {
      const anyPreview = stranded.some((url) => url.startsWith("blob:") || url.startsWith("data:"));
      dropAltDraftUrls(stranded);
      showInfoBox(String(anyPreview
        ? (t.imageManager?.altDraftDroppedNoImage ?? "An alt text typed for an image that was removed before it was saved was dropped.")
        : (t.imageManager?.altDraftDroppedImageGone ?? "An alt text draft was dropped because its image no longer exists.")), "warning");
    }
  }, [settlingMedia, shopifyMediaMap, productId, deferredAltTick, displayedProductUrls, fileUrlMap, urlToGid, isDeleting]); // eslint-disable-line react-hooks/exhaustive-deps
  // The settling poll gave up while a carried-over draft's image was still
  // processing: the Save stops waiting for it (it stays a draft for a later Save).
  releaseStuckDeferredAltsRef.current = () =>
    releaseDeferredAlts((url, d) => d.applied === "done" && knownSettledAltRef.current.has(url), true);

  /** Discard: every alt draft goes back to what it was; what is already in flight cannot be taken back. */
  const discardAltDrafts = useCallback(() => {
    const urls = new Set([...dirtyUrlsRef.current, ...failedAltUrlsRef.current]);
    // Only what the merchant is looking at is taken back: a save queued for
    // another product, language or market (pressed Save, then switched) is
    // not this Discard's -- the same image can have a queued save in another
    // language under the very same url.
    const view = { productId, locale: currentLanguage, marketId: foreignMarketId };
    // Carried-over drafts of this view are not in flight yet: they go too.
    releaseDeferredAlts((_url, d) => altSaveInView(d.draft, view), false);
    if (urls.size === 0) return;
    const restored = restoreAltDrafts(localAltTextsRef.current, altBaselinesRef.current, urls);
    localAltTextsRef.current = restored;
    setLocalAltTexts(restored);
    dirtyUrlsRef.current.clear();
    failedAltUrlsRef.current.clear();
    altBaselinesRef.current.clear();
    altEditOrderRef.current.clear();
    dropQueuedAltSaves((q) => urls.has(resolveAltUrl(q.url)) && altSaveInView(q, view));
    syncAltSaving();
    syncAltDirty();
  }, [syncAltDirty, productId, currentLanguage, foreignMarketId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (altDraftApiRef) {
    altDraftApiRef.current = {
      flush: flushAltDrafts,
      discard: discardAltDrafts,
      hasUnsentDrafts: () => unsentAltDrafts(
        dirtyUrlsRef.current,
        localAltTextsRef.current,
        [
          ...pendingAltSaves().map((p) => ({ ...p, url: resolveAltUrl(p.url), aliases: p.aliases?.map((a) => ({ ...a, url: resolveAltUrl(a.url) })) })),
          ...[...deferredAltRef.current.values()].map((d) => d.draft),
        ],
      ).length > 0,
    };
  }
  useEffect(() => () => {
    if (altDraftApiRef) altDraftApiRef.current = null;
    // Unmounted with drafts: they are gone, so the page's dirty flag must not outlive them.
    onDirtyChange?.(false);
    onAltSavingChange?.(false);
    onImmediateAltSavingChange?.(false);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // url -> media GID over both galleries (the variant tiles' fileUrlMap inverse
  // overlaid by the product gallery's own map), for "is this medium's alt dirty".
  const altGidLookup = useMemo(() => {
    const lookup: Record<string, string> = {};
    for (const [gid, url] of Object.entries(fileUrlMap)) if (url) lookup[url] = gid;
    return Object.assign(lookup, urlToGid);
  }, [fileUrlMap, urlToGid]);
  /** True while the PRIMARY alt of this image (on any of its tiles) is an unsaved draft. */
  const isPrimaryAltDirty = (url: string): boolean => {
    if (dirtyUrlsRef.current.has(url)) return true;
    const gid = gidForUrl(altGidLookup, url);
    if (!gid) return false;
    for (const d of dirtyUrlsRef.current) if (gidForUrl(altGidLookup, d) === gid) return true;
    return false;
  };

  /** True while this tile carries an unsaved alt draft of the view on screen. */
  const isAltDraftDirty = (url: string) => dirtyUrlsRef.current.has(url);

  /** Why ✨ / 🌍 cannot run for this tile right now: an image with no media id
   *  yet (an unsaved upload) has nothing its immediate save could address. */
  const altAiBlockedHint = (url: string | null | undefined): string | undefined => {
    if (!url) return undefined;
    const gid = urlToGid[url] ?? gidForUrl(altGidLookup, url);
    return gid && gid.startsWith("gid://")
      ? undefined
      : String(t.imageManager?.aiNeedsSavedImage ?? "Save the image first — only then can the AI write or translate its alt text.");
  };

  /** The SAVED primary alt of the medium behind a tile, or `undefined` when it
   *  is not KNOWN here: a variant-gallery tile can be a media-library file that
   *  is not one of the product's images, and nothing in this component holds
   *  its primary alt. Unknown never locks a box or disables a button -- the
   *  server reads the alt and answers (noSource / noPrimary) itself. */
  const primaryAltForUrl = (url: string): string | undefined =>
    knownPrimaryAlt({ url, gid: urlToGid[url] ?? gidForUrl(altGidLookup, url), images: effectiveProductImages });

  const handleGenerateAltTextForImage = useCallback((url: string) => {
    const imageIndex = effectiveProductImages.findIndex(i => i.url === url);
    if (imageIndex < 0) return;
    // Backstop for the disabled button: the result is saved at once, and an
    // image without a media id cannot be saved to.
    const blocked = altAiBlockedHint(url);
    if (blocked) {
      showInfoBox(blocked, "warning");
      return;
    }
    altAiRequestRef.current = { url, mediaId: urlToGid[url], locale: currentLanguage, marketId: foreignMarketId, productId };
    const form = new FormData();
    form.append("action", "generateAltText");
    form.append("itemId", productId);
    form.append("productId", productId);
    form.append("imageIndex", String(imageIndex));
    form.append("imageUrl", url);
    form.append("productTitle", productTitle ?? "");
    form.append("mainLanguage", primaryLocale ?? "en");
    altTextFetcher.submit(form, { method: "post" });
  }, [productId, effectiveProductImages, productTitle, primaryLocale, altTextFetcher, urlToGid, currentLanguage, foreignMarketId, altGidLookup, showInfoBox, t]); // eslint-disable-line react-hooks/exhaustive-deps

  // Translates the image's SAVED primary-language alt into the language on
  // screen -- never the foreign field's own text: that is already the target
  // language (a typed draft or an existing translation) or empty, and sending
  // it made the AI answer in prose, the reply unparseable and every retry fail
  // the same way. No primary alt = nothing to translate: refused here, with
  // the reason, before any AI call (the button is disabled for it too).
  const handleTranslateAltTextForImage = useCallback((url: string) => {
    const imageIndex = effectiveProductImages.findIndex(i => i.url === url);
    const mediaId = urlToGid[url] ?? gidForUrl(altGidLookup, url);
    if (!currentLanguage || (imageIndex < 0 && !mediaId)) return;
    const blocked = altAiBlockedHint(url);
    if (blocked) {
      showInfoBox(blocked, "warning");
      return;
    }
    // Refused here only where the primary alt is KNOWN to be empty; a library
    // file's is not known here, and the server reads it (and refuses with the
    // same noSource answer when it is empty).
    const knownPrimary = primaryAltForUrl(url);
    const sourceAltText = altTranslateSourceText(knownPrimary);
    if (knownPrimary !== undefined && sourceAltText === null) {
      showInfoBox(String(t.imageManager?.translateAltNoPrimary ?? "This image has no saved alt text in the primary language yet."), "warning");
      return;
    }
    altAiRequestRef.current = { url, mediaId, locale: currentLanguage, marketId: foreignMarketId, productId };
    const form = new FormData();
    form.append("action", "translateAltText");
    form.append("itemId", productId);
    form.append("productId", productId);
    form.append("imageIndex", String(Math.max(imageIndex, 0)));
    // The server takes the source from its own cache by this id.
    if (mediaId) form.append("mediaId", mediaId);
    form.append("sourceAltText", sourceAltText ?? "");
    form.append("targetLocale", currentLanguage);
    if (primaryLocale) form.append("primaryLocale", primaryLocale);
    form.append("productTitle", productTitle ?? "");
    altTextFetcher.submit(form, { method: "post" });
  }, [productId, effectiveProductImages, currentLanguage, altTextFetcher, urlToGid, foreignMarketId, altGidLookup, showInfoBox, t, imageMetas, primaryLocale, productTitle]); // eslint-disable-line react-hooks/exhaustive-deps

  // GLOBAL layer by design, like the editor's own "translate to all languages":
  // it never carries a market. The image is named by its MEDIA id -- a position
  // in this live list is not one in the database, and the server refuses an id
  // it cannot find instead of writing to another image.
  const handleTranslateAltTextToAllLocales = useCallback((url: string, sourceAltText: string, mediaIdOverride?: string) => {
    const imageIndex = effectiveProductImages.findIndex(i => i.url === url);
    const mediaId = mediaIdOverride ?? urlToGid[url] ?? gidForUrl(altGidLookup, url) ?? effectiveProductImages[imageIndex]?.mediaId;
    const targetLocales = enabledLanguages.filter(l => l !== primaryLocale);
    if (targetLocales.length === 0) return;
    // An unsaved primary alt: the translations would be written from the draft
    // and its own Save would then delete them again (a primary change purges or
    // re-translates). The button is disabled for that; this is the backstop.
    if (isPrimaryAltDirty(url)) {
      showInfoBox(String(t.imageManager?.translateAltAllSaveFirst ?? "Save the alt text first, then translate it."), "warning");
      return;
    }
    if (!mediaId || !mediaId.startsWith("gid://")) {
      setMediaError(t.imageManager.altImageNotFound);
      return;
    }
    altAiRequestRef.current = { url, mediaId, locale: currentLanguage, productId };
    const form = new FormData();
    form.append("action", "translateAltTextToAllLocales");
    form.append("itemId", productId);
    form.append("productId", productId);
    form.append("mediaId", mediaId);
    if (imageIndex >= 0) form.append("imageIndex", String(imageIndex));
    form.append("sourceAltText", sourceAltText);
    form.append("targetLocales", JSON.stringify(targetLocales));
    form.append("productTitle", productTitle ?? "");
    if (primaryLocale) form.append("primaryLocale", primaryLocale);
    altTextFetcher.submit(form, { method: "post" });
  }, [productId, effectiveProductImages, urlToGid, enabledLanguages, primaryLocale, altTextFetcher, t, currentLanguage, altGidLookup, showInfoBox]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- ✨ generate's SUGGESTION: Accept / Accept & Translate / Decline ----
  // The suggestion of the view on screen (product, language, market) for the
  // medium behind a tile; nothing of it is written until it is accepted.
  const altSuggestionView = { productId, locale: currentLanguage, marketId: foreignMarketId };
  const altSuggestionFor = (url: string | null | undefined): string | undefined =>
    url ? altSuggestionInView(altSuggestions, altSuggestionView, urlToGid[url] ?? gidForUrl(altGidLookup, url)) : undefined;

  const handleRejectAltSuggestion = (url: string) => {
    const mediaId = urlToGid[url] ?? gidForUrl(altGidLookup, url);
    if (!mediaId) return;
    setAltSuggestions((m) => withoutAltSuggestion(m, { ...altSuggestionView, mediaId }));
  };

  // Accept saves exactly this image's alt (the existing immediate per-image
  // save, with the language and market of the view). Accept & Translate marks
  // that save: only once it is CONFIRMED does the translate-to-all start (the
  // settle callback calls translateAfterAcceptRef). Every refusal is decided
  // before the field, the suggestion or any queue is touched.
  const handleAcceptAltSuggestion = (url: string, translate: boolean) => {
    const mediaId = urlToGid[url] ?? gidForUrl(altGidLookup, url);
    const plan = planAcceptAltSuggestion({
      url,
      mediaId,
      suggestion: altSuggestionFor(url),
      translate,
      isPrimaryLocale: !currentLanguage || currentLanguage === primaryLocale,
      singleLocale: enabledLanguages.filter((l) => l !== primaryLocale).length === 0,
      aiBusy: altTextFetcher.state !== "idle",
      dirtyUrls: dirtyUrlsRef.current,
      texts: localAltTextsRef.current,
      gidOf: (u) => (u === url ? mediaId : gidForUrl(altGidLookup, u)),
      locale: currentLanguage,
      marketId: foreignMarketId,
      productId,
      productTitle,
      editOrder: altEditOrderRef.current,
    });
    if (plan.kind === "refused") {
      if (plan.reason === "noMedia") {
        showInfoBox(altAiBlockedHint(url) ?? String(t.imageManager?.aiNeedsSavedImage ?? "Save the image first — only then can the AI write or translate its alt text."), "warning");
      } else if (plan.reason === "busy") {
        showInfoBox(String(t.imageManager?.altSuggestionBusy ?? "Another AI request is running. Try again in a moment."), "warning");
      } else if (plan.reason === "singleLanguage") {
        showInfoBox(String(t.common?.requiresSecondLanguage ?? ""), "warning");
      }
      return;
    }
    if (mediaId) setAltSuggestions((m) => withoutAltSuggestion(m, { ...altSuggestionView, mediaId }));
    applyAltDraft(url, plan.text);
    const entry = plan.entry;
    failedAltUrlsRef.current.delete(entry.url);
    for (const alias of entry.aliases ?? []) failedAltUrlsRef.current.delete(alias.url);
    submitAltSave(entry);
  };

  translateAfterAcceptRef.current = (entry: QueuedAltSave) => {
    // The field moved on to a newer accepted save of this medium that translates
    // itself: that one's translate runs, this one stays silent.
    const key = altFlushKey(entry);
    if (pendingAltSaves().some((q) => q !== entry && q.thenTranslateAll && altFlushKey(q) === key)) return;
    // One generate / translate request at a time on this fetcher: a new one
    // started while the save was out would be cancelled by this submit.
    if (altTextFetcher.state !== "idle") {
      showInfoBox(String(t.imageManager?.altAcceptTranslateSkipped ?? "The alt text was saved, but translating it into the other languages did not start."), "warning");
      return;
    }
    handleTranslateAltTextToAllLocales(resolveAltUrl(entry.url), entry.altText, entry.mediaId);
  };

  const hasAnySelection = selectedBulkIds.size > 0 || selectedGalleryItems.size > 0;

  const isPrimaryLocale = !currentLanguage || currentLanguage === primaryLocale;

  // Single selected URL in product gallery (for inline alt text editor)
  const productGallerySelectedUrls = selectedUrlsByGallery.get("product") ?? new Set<string>();
  const noneOrAllSelected = productGallerySelectedUrls.size === 0 || productGallerySelectedUrls.size >= displayedProductUrls.length;
  // The kind comes from mediaMetaMap via the row's GID — without it a video's
  // poster url reads as a convertible JPG and the button offers to convert
  // media Shopify cannot convert (isWebpConvertible owns that rule).
  const imagesToConvert = effectiveProductImages.filter(i =>
    isWebpConvertible(i.url, i.mediaId ? mediaMetaMap[i.mediaId]?.kind : undefined) &&
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
      : altFieldView({
        own: localAltTexts[productSingleSelected],
        inherited: inheritedAltTexts[productSingleSelected],
        primaryAlt: "", fallbackPlaceholder: "",
      }).value)
    : "";
  const productInheritedAlt = productSingleSelected && !isPrimaryLocale
    ? (inheritedAltTexts[productSingleSelected] ?? "")
    : "";
  const productPrimaryAltText = productSingleSelected ? (imageMetas[productSingleSelected]?.altText ?? "") : "";
  // Translating to every language is offered only for a SAVED primary alt.
  const productAltDirty = productSingleSelected ? isPrimaryAltDirty(productSingleSelected) : false;
  const productAltAiBlocked = altAiBlockedHint(productSingleSelected);
  // Translating needs a SAVED primary alt to start from (it is the source).
  const productTranslateAltBlocked = productAltAiBlocked
    ?? (productSingleSelected && altTranslateSourceText(productPrimaryAltText) === null
      ? String(t.imageManager?.translateAltNoPrimary ?? "This image has no saved alt text in the primary language yet.")
      : undefined);
  // A FOREIGN alt can only be stored where the image has a saved primary alt
  // (Shopify offers nothing to translate otherwise): the box is locked with the
  // reason rather than collecting a draft no Save could ever store.
  const altNeedsPrimaryHint = String(
    t.products?.altTextNeedsPrimaryHint
      ?? "Enter and save an alt text in the main language first — then it can be translated.",
  );
  const productAltLocked = !!productSingleSelected && foreignAltLocked({
    isPrimaryLocale,
    primaryAlt: productPrimaryAltText,
    own: localAltTexts[productSingleSelected],
    dirty: dirtyUrlsRef.current.has(productSingleSelected),
  });
  const translateAltAllSaveFirstHint = String(t.imageManager?.translateAltAllSaveFirst ?? "Save the alt text first, then translate it.");
  const productHasTranslation = productSingleSelected
    ? (localAltTexts[productSingleSelected] !== undefined && localAltTexts[productSingleSelected] !== "")
    : false;

  // Per-language replacement (foreign language only, product gallery only):
  // a tile whose medium has one SHOWS it in place of the original, with the
  // corner symbol that flips it back to the original. The selected, SAVED
  // medium gets the replace button next to its alt-text controls. An unsaved
  // tile has no GID and is not offered; a still-processing one is said to be
  // unavailable by the button. Tiles stay keyed by the ORIGINAL's URL.
  const localizedMedia = localizedMediaState;
  // Resolved per SHOWN tile url (exact, then without the `?v=` query -- the same
  // lookup the replace button uses), never by walking the url->gid map: a tile
  // whose url is not a key of that map got no replacement although its button
  // worked, so a pick (draft) or a saved replacement never showed on it.
  // Memoised on the provider's STABLE members (tileOf / mediaById are
  // memoised there), never on the whole state object, which is new every render.
  const lmActive = !!localizedMedia?.active;
  const lmTileOf = localizedMedia?.tileOf;
  const lmMediaById = localizedMedia?.mediaById;
  const replacementsByUrl = useMemo(() => {
    if (!lmActive || !lmTileOf) return {} as Record<string, LocalizedMediaTile>;
    return tilesByUrl(displayedProductUrls, urlToGid, (gid) => lmTileOf(gid));
  }, [lmActive, lmTileOf, urlToGid, displayedProductUrls]);
  // The variant galleries show the SAME replacement on a tile of the same
  // product medium (one entry per medium GID, so both galleries stay coupled
  // and the symbol's flip state is shared). Variant tiles are keyed by
  // fileUrlMap[gid]; the url->gid lookup is the fileUrlMap inverse overlaid by
  // the product gallery's own map, with the same exact-then-without-`?v=` rule.
  const variantReplacementsByUrl = useMemo(() => {
    if (!lmActive || !lmTileOf) return {} as Record<string, LocalizedMediaTile>;
    return fileTilesByUrl(fileUrlMap, urlToGid, (gid) => lmTileOf(gid));
  }, [lmActive, lmTileOf, urlToGid, fileUrlMap]);
  // The product's OWN media (what a replacement can be set for), from what
  // the SERVER reports for this product: the fetched media map, the cached
  // product images, the media this product's saves created (settling), and the
  // localized-media read of the product's live media. Never the client-side
  // meta map, which a library pick from another product pre-fills.
  const productMediaIds = useMemo(() => {
    const ids = new Set<string>(Object.keys(shopifyMediaMap));
    for (const img of effectiveProductImages) if (img.mediaId) ids.add(img.mediaId);
    for (const m of settlingMedia ?? []) if (m.productId === productId) ids.add(m.mediaId);
    if (lmMediaById) for (const id of lmMediaById.keys()) ids.add(id);
    return ids;
  }, [shopifyMediaMap, effectiveProductImages, settlingMedia, productId, lmMediaById]);
  // Only a real GID: a url (an unsaved tile) is never handed on as a media id.
  const productSingleSelectedGid = productSingleSelected ? gidForUrl(urlToGid, productSingleSelected) : null;

  return (
    <DndContext
      sensors={sharedSensors}
      collisionDetection={imageManagerCollision}
      onDragStart={handleSharedDragStart}
      onDragOver={handleSharedDragOver}
      onDragEnd={handleSharedDragEnd}
    >
    <div ref={managerRootRef} data-im-view={fullView ? "full" : "preview"}>
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
          {fullView ? (
            <span key="im-close" data-im-close>
              <Button size="slim" onClick={closeFullView}>{t.imageManager.closeFullView}</Button>
            </span>
          ) : (
            <span key="im-open" data-im-open>
              <Button size="slim" variant="plain" onClick={openFullView}>{t.imageManager.openManager}</Button>
            </span>
          )}
        </InlineStack>

        <div>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {mediaError && (
        <Banner tone="critical" onDismiss={() => setMediaError(null)}>
          <p>{mediaError}</p>
        </Banner>
      )}
      {webpError && (
        <Banner tone="critical" onDismiss={() => setWebpError(null)}>
          <p>{webpError}</p>
        </Banner>
      )}

      {/* Produktbilder allgemein */}
      <div>
        <div style={fullView ? undefined : { display: "none" }}>
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
              {webpAllowed ? (
                <Button size="slim" onClick={() => handleConvertToWebP(imagesToConvert)} disabled={isConvertingWebP}>
                  {isConvertingWebP
                    ? t.imageManager.webpConverting
                    : t.imageManager.webpConvertButton.replace("{count}", String(imagesToConvert.length)) + webpFormatBreakdown}
                </Button>
              ) : (
                <Tooltip content={webpPlanNote} dismissOnMouseOut>
                  <Button size="slim" disabled>
                    {t.imageManager.webpConvertButton.replace("{count}", String(imagesToConvert.length)) + webpFormatBreakdown}
                  </Button>
                </Tooltip>
              )}
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
                appFetch("/api/image-manager-settings", {
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
        </div>
        <div style={{ marginTop: 6, display: fullView ? "flex" : "none", alignItems: "center", gap: 6 }}>
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
            // Preview: one clipped row that is not operable; a click on it opens the full view.
            style={fullView ? { overflowX: "hidden" } : { maxHeight: thumbSize + 24, overflow: "hidden", cursor: "pointer" }}
            onClick={fullView ? undefined : openFullView}
            ref={setProductDropRef}
          >
          <div style={fullView ? undefined : { pointerEvents: "none" }}>
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
              replacements={replacementsByUrl}
            />
          </div>
          </div>
        </div>

        <div style={fullView ? undefined : { display: "none" }}>
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
            {/* The replacement buttons of the ONE selected medium (foreign language
                only) sit between "move" and "delete"; nothing renders otherwise. */}
            {productSingleSelectedGid && (isModel3dGid(productSingleSelectedGid)
              ? <LocalizedMediaNotReplaceable reason="model3d" />
              : <LocalizedMediaReplaceButtons mediaId={productSingleSelectedGid} />)}
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
              <AutoGrowTextarea
                value={productCurrentAltText}
                readOnly={productAltLocked}
                aria-readonly={productAltLocked || undefined}
                title={productAltLocked ? altNeedsPrimaryHint : undefined}
                onValueChange={(next) => { if (!productAltLocked) handleAltTextChange(productSingleSelected, next); }}
                placeholder={isPrimaryLocale ? t.imageManager.altTextPlaceholder : altFieldView({ own: productCurrentAltText, inherited: productInheritedAlt, primaryAlt: productPrimaryAltText, fallbackPlaceholder: t.imageManager.altTextPlaceholder }).placeholder}
                style={{
                  flex: "1 1 200px",
                  minWidth: 180,
                  // Height and vertical padding come from AutoGrowTextarea's
                  // class (button height at rest, 44px on touch); a long alt
                  // text wraps and grows instead of scrolling sideways.
                  paddingLeft: 8,
                  paddingRight: 8,
                  fontSize: 13,
                  border: "1px solid var(--app-field-border-color)",
                  borderRadius: "var(--app-field-border-radius)",
                  outline: "none",
                  background: !isPrimaryLocale && !productHasTranslation ? "#fff8f0" : "white",
                }}
                onFocus={(e) => { e.target.style.borderColor = "#005bd3"; e.target.style.background = "white"; }}
                onBlur={(e) => {
                  e.target.style.borderColor = "var(--app-field-border-color)";
                  e.target.style.background = !isPrimaryLocale && !productHasTranslation ? "#fff8f0" : "white";
                  // No save here: the text is a draft until the editor's save bar writes it.
                }}
              />
              <div style={{ display: "flex", gap: 4, flexShrink: 0, flexWrap: "wrap" }}>
                {isPrimaryLocale && (
                  <DisabledActionTooltip hint={productAltAiBlocked}>
                    <Button
                      size="slim"
                      disabled={altTextFetcher.state !== "idle" || !!productAltAiBlocked}
                      loading={altTextFetcher.state !== "idle"}
                      onClick={() => handleGenerateAltTextForImage(productSingleSelected)}
                    >
                      {`✨ ${t.imageManager.aiGenerate}`}
                    </Button>
                  </DisabledActionTooltip>
                )}
                {isPrimaryLocale && (
                  <DisabledActionTooltip hint={singleLocaleHint ?? (productAltDirty ? translateAltAllSaveFirstHint : undefined)}>
                    <Button
                      size="slim"
                      disabled={altTextFetcher.state !== "idle" || !!singleLocaleHint || productAltDirty}
                      loading={altTextFetcher.state !== "idle"}
                      onClick={() => handleTranslateAltTextToAllLocales(productSingleSelected, productCurrentAltText)}
                    >
                      {`🌍 ${t.imageManager.translateAltAll}`}
                    </Button>
                  </DisabledActionTooltip>
                )}
                {!isPrimaryLocale && (
                  <DisabledActionTooltip hint={productTranslateAltBlocked}>
                    <Button
                      size="slim"
                      disabled={altTextFetcher.state !== "idle" || !!productTranslateAltBlocked}
                      loading={altTextFetcher.state !== "idle"}
                      onClick={() => handleTranslateAltTextForImage(productSingleSelected)}
                    >
                      {`🌍 ${t.imageManager.translateAlt}`}
                    </Button>
                  </DisabledActionTooltip>
                )}
              </div>
            </div>
            {altSuggestionFor(productSingleSelected) !== undefined && (
              <AISuggestionBanner
                fieldType="altText"
                suggestionText={altSuggestionFor(productSingleSelected) as string}
                onAccept={() => handleAcceptAltSuggestion(productSingleSelected, false)}
                onDecline={() => handleRejectAltSuggestion(productSingleSelected)}
                onAcceptAndTranslate={isPrimaryLocale ? () => handleAcceptAltSuggestion(productSingleSelected, true) : undefined}
                acceptLabel={t.products?.accept || "Accept"}
                declineLabel={t.products?.decline || "Decline"}
                acceptAndTranslateLabel={t.products?.acceptTranslate || "Accept & Translate"}
                titleLabel={t.products?.aiSuggestion || "AI suggestion:"}
                singleLocaleHint={singleLocaleHint}
                disabled={altTextFetcher.state !== "idle"}
              />
            )}
            {productAltLocked && (
              <div style={{ marginTop: 6, fontSize: 12, color: "#6d7175" }}>
                {altNeedsPrimaryHint}
              </div>
            )}
            {!isPrimaryLocale && productPrimaryAltText && (
              <div style={{ marginTop: 6, fontSize: 12, color: "#6d7175" }}>
                <span style={{ fontWeight: 600 }}>{t.imageManager.primaryRef}: </span>
                {productPrimaryAltText}
              </div>
            )}
          </div>
        )}
        <LocalizedMediaOrphanNotice />
        </div>
      </div>

      <div style={fullView ? { display: "flex", flexDirection: "column", gap: 16 } : { display: "none" }}>
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
            <Banner
              tone="warning"
              action={{ content: t.imageManager.variantsRetry, onAction: () => { variantsRetryAttemptRef.current = 0; fetchVariantsForProduct(productId, false); } }}
            >
              <p>{variantError}</p>
            </Banner>
          ) : variants.length === 0 ? (
            <Text as="p" tone="subdued">{t.imageManager.noVariants}</Text>
          ) : (
            variants.map(v => {
              const storedGids = pendingVariantGalleries[v.id] ?? v.galleryFileGids;
              const nativeMainGid = mainGidOfVariant(v);
              // What the gallery SHOWS (displayMain): the main image once, at the place the saved
              // order gives it (put first when the order does not list it); the image the
              // merchant dragged to the first slot is the main image right away, and so is
              // the one that moves up when the merchant removed the main image (the same
              // rule the server applies). A variant with no main image and none removed
              // keeps its placeholder: nothing is promoted for it before a real edit.
              const shown = displayFor(v);
              const hasMainImageForVariant = Boolean(shown.mainGid);
              const effectiveGids = shown.gids;
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
                  galleryOrderJson: orderShowingMain(pendingGalleryOrder[v.id] ?? v.galleryOrderJson, shown.mainGid),
                  // Inject the in-session preview URLs so a freshly library-
                  // picked 3D model (where the modal grid already had the
                  // Shopify thumbnail) renders with that thumbnail in the
                  // variant gallery, not just the "3D" placeholder. Without
                  // this the tile waited until the next save → /api/product-
                  // variants refetch before showing the preview.
                  threeDPreviewUrls: pendingVariant3dPreviews[v.id] ?? v.threeDPreviewUrls,
                }}
                hasMainImage={hasMainImageForVariant}
                mainFileGid={shown.mainGid}
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
                inheritedAltTexts={inheritedAltTexts}
                onGenerateAltText={handleGenerateAltTextForImage}
                onTranslateAltText={handleTranslateAltTextForImage}
                onTranslateAltToAllLocales={handleTranslateAltTextToAllLocales}
                altSuggestionFor={altSuggestionFor}
                onAcceptAltSuggestion={handleAcceptAltSuggestion}
                onRejectAltSuggestion={handleRejectAltSuggestion}
                isAltDirty={isPrimaryAltDirty}
                isAltDraftDirty={isAltDraftDirty}
                altAiBlockedHint={altAiBlockedHint}
                primaryAltForUrl={primaryAltForUrl}
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
                replacements={variantReplacementsByUrl}
                productMediaIds={productMediaIds}
              />
              );
            })
          )}
        </div>
      </div>
      </div>

        </div>
        </div>
      </BlockStack>
    </Card>
    </div>
    <DragOverlay>
      {activeDragUrl ? (() => {
        // Non-image tiles can't render the resourceUrl directly as an <img>
        // (.mp4 / .glb / youtube watch URLs are not images). Use the meta's
        // previewUrl (variant_3d_previews snapshot, YouTube/Vimeo thumb,
        // video poster) and fall back to a kind-specific placeholder when
        // no preview exists.
        //
        // URL-pattern fallback: variant-scope external videos and 3D models
        // live in their own metafields (variant_external_videos /
        // variant_3d_models), so their URLs never get seeded into mediaMetaMap.
        // Inferring kind from the URL itself keeps the overlay correct without
        // having to mirror every variant-mode write into mediaMetaMap.
        const meta = imageMetas[activeDragUrl];
        const inferredKind: MediaKind | undefined = meta?.kind
          ?? (parseExternalVideoUrl(activeDragUrl) ? "external_video"
            : /\.(glb|gltf)(\?|$)/i.test(activeDragUrl) ? "model"
            : /\.(mp4|mov|webm)(\?|$)/i.test(activeDragUrl) ? "video"
            : undefined);
        const isImage = !inferredKind || inferredKind === "image";
        const ytThumb = inferredKind === "external_video" ? youtubeThumbForUrl(activeDragUrl) : undefined;
        const thumbSrc = isImage ? activeDragUrl : (meta?.previewUrl || ytThumb || null);
        const placeholderLabel = inferredKind === "model" ? "3D" : inferredKind === "video" ? "▶" : inferredKind === "external_video" ? "▶" : null;
        return (
        <div style={{ position: "relative", display: "inline-block" }}>
          {thumbSrc ? (
            <img
              src={thumbSrc}
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
          ) : (
            <div
              style={{
                width: thumbSize,
                height: thumbSize,
                borderRadius: 6,
                opacity: 0.9,
                boxShadow: "0 4px 16px rgba(0,0,0,0.3)",
                pointerEvents: "none",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: "#1a1a1a",
                color: "#fff",
                fontWeight: 700,
                fontSize: meta?.kind === "model" ? 24 : 32,
              }}
            >{placeholderLabel}</div>
          )}
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
        );
      })() : null}
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

