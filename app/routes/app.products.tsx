/**
 * Products Page - UNIFIED VERSION
 *
 * Uses UnifiedContentEditor for all fields (text fields + images)
 * Product Options are excluded for now (will be added later)
 *
 * This gives us:
 * - 100% consistent behavior with Collections/Pages/etc.
 * - ImageGalleryField handles all image logic (AI, Translation, Alt-text)
 * - Single action handler for everything
 * - Minimal code (~150 lines vs 779 lines)
 */

import { type ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher, useRevalidator, useNavigation, useSearchParams } from "@remix-run/react";
import { authenticate } from "../shopify.server";
import { confirmNavigation } from "../hooks/useSaveBar";
import { UnifiedContentEditor } from "../components/UnifiedContentEditor";
import { useUnifiedContentEditor } from "../hooks/useUnifiedContentEditor";
import { useProductSubResources } from "../hooks/useProductSubResources";
import { handleUnifiedContentActions } from "../actions/unified-content.actions";
import { PRODUCTS_CONFIG } from "../config/content-fields.config";
import { useI18n } from "../contexts/I18nContext";
import { useInfoBox } from "../contexts/InfoBoxContext";
import { usePlan } from "../contexts/PlanContext";
import { getPlanDisplayName } from "../utils/planUtils";
import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { useVariantImageManager } from "../hooks/useVariantImageManager";
import { VariantImageManager } from "../components/image-manager/VariantImageManager";
import { Spinner, Text } from "@shopify/polaris";
import type { ContentItem } from "../types/content-editor.types";
import { logger } from "~/utils/logger.server";
import { wasRecentlySaved } from "~/utils/translation-timing";
import { isDefaultTitleOption } from "~/utils/shopify-product.utils";
import { measurePageLoad } from "~/utils/performance.client";
import { createContentLoader } from "~/utils/loader-factory.server";

// ============================================================================
// LOADER - Paginated upsert sync + load from database
// ============================================================================

export const loader = createContentLoader({
  logPrefix: "PRODUCTS",
  resourceType: "Product",
  itemsKey: "products",
  errorFallback: { plan: "free", maxProducts: 100, productCount: 0 },

  async loadData(ctx) {
    const { getPlanLimits } = await import("../utils/planUtils");

    // Load plan settings
    const settings = await ctx.db.aISettings.findUnique({
      where: { shop: ctx.session.shop },
    });
    const plan = (settings?.subscriptionPlan || "free") as "free" | "basic" | "pro" | "max";
    const planLimits = getPlanLimits(plan);

    // R3-C3: do NOT resync the entire Shopify catalog on every page load.
    // This loader runs on every navigation/revalidation (incl. Remix
    // prefetch). The previous inline implementation paginated the WHOLE
    // catalog and ran per-product upsert + deleteMany/createMany for images
    // and options on every load (~10k upserts + ~30k delete/create + dozens
    // of Shopify GraphQL calls for a 10k-product shop, even when nothing
    // changed). Catalog -> DB synchronization is the dedicated job of
    // ProductSyncService, driven by the background SyncScheduler (initial
    // full sync + periodic reconcile, started at afterAuth). The loader now
    // only READS from the DB; we just ensure the scheduler is running for
    // this shop (idempotent + non-blocking — never restarts an active one).
    try {
      const { syncScheduler } = await import("../services/sync-scheduler.service");
      if (!syncScheduler.isShopActive(ctx.session.shop)) {
        syncScheduler.startSyncForShop(ctx.session.shop, ctx.admin as never);
      }
    } catch (err) {
      logger.error("[PRODUCTS-LOADER] Could not ensure background sync scheduler", {
        context: "PRODUCTS",
        shop: ctx.session.shop,
        error: err instanceof Error ? err.message : String(err),
      });
    }


    // R3-H2: this loader serialises the WHOLE result (deep includes:
    // images→altTranslations, options, metafields) into ONE JSON payload,
    // and the factory then runs contentTranslation.findMany({ resourceId:
    // { in: ids } }) over every id. On unlimited (Pro/Max) plans there was
    // NO `take`, so a 10k-product shop produced a multi-MB payload + huge
    // IN() query → OOM/timeout. There is no server-side pagination yet (the
    // UI filters client-side), so until that exists we apply a hard upper
    // bound even for unlimited plans. A bounded list degrades gracefully;
    // an unbounded query takes the page down entirely. Configurable via
    // PRODUCTS_MAX_LOADED. extraData still returns the true productCount so
    // the UI can show "X of Y".
    const HARD_CAP = (() => {
      const raw = Number(process.env.PRODUCTS_MAX_LOADED);
      return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 2000;
    })();
    const effectiveTake =
      planLimits.maxProducts === Infinity
        ? HARD_CAP
        : Math.min(planLimits.maxProducts, HARD_CAP);

    const totalForShop = await ctx.db.product.count({ where: { shop: ctx.session.shop } });
    if (totalForShop > effectiveTake) {
      logger.warn(
        `[PRODUCTS-LOADER] Catalog (${totalForShop}) exceeds load cap (${effectiveTake}) — returning a bounded slice. Server-side pagination is required for this shop.`,
        { context: "PRODUCTS", shop: ctx.session.shop, totalForShop, effectiveTake },
      );
    }

    // Fetch products from DATABASE (bounded — see R3-H2 note above)
    const dbProducts = await ctx.db.product.findMany({
      where: { shop: ctx.session.shop },
      include: {
        images: planLimits.cacheEnabled.productImages
          ? { include: { altTextTranslations: true }, orderBy: { position: "asc" } }
          : false,
        options: { orderBy: { position: "asc" } },
        metafields: true,
      },
      orderBy: { title: "asc" },
      take: effectiveTake,
    });

    // Metafields settings tab gate: the product editor shows a metafield only
    // when its definition is BOTH translatable AND enabled by the merchant
    // (decided design point 1). Run the one-time lazy backfill first so
    // existing shops keep their already-translatable metafields, then load the
    // enabled set used to filter below.
    const { backfillEnabledMetafieldDefinitionsIfNeeded, getEnabledMetafieldKeySet, isEditableProductMetafield } =
      await import("../services/metafield-enablement.server");
    await backfillEnabledMetafieldDefinitionsIfNeeded(ctx.admin as never, ctx.db as never, ctx.session.shop);
    const enabledMetafieldKeys = await getEnabledMetafieldKeySet(ctx.db, ctx.session.shop);

    // Load sub-resource translations (options, option values, metafields) from DB
    // Uses the same ContentTranslation pipeline as main product translations
    const allSubResourceIds: string[] = [];
    for (const p of dbProducts) {
      for (const opt of (p as any).options || []) {
        allSubResourceIds.push(opt.id);
        try {
          const vals = JSON.parse(opt.values || "[]");
          for (const v of vals) { if (v.id) allSubResourceIds.push(v.id); }
        } catch { /* ignore parse errors */ }
      }
      for (const mf of (p as any).metafields || []) {
        allSubResourceIds.push(mf.id);
      }
    }

    let subTransByResource: Record<string, any[]> = {};
    if (allSubResourceIds.length > 0) {
      const subTrans = await ctx.db.contentTranslation.findMany({
        where: { shop: ctx.session.shop, resourceId: { in: allSubResourceIds } },
      });
      // Group by resourceId
      subTransByResource = subTrans.reduce((acc: Record<string, any[]>, t: any) => {
        if (!acc[t.resourceId]) acc[t.resourceId] = [];
        acc[t.resourceId].push(t);
        return acc;
      }, {});
    }

    // Transform to frontend format
    const products = dbProducts.map((p: any) => ({
      id: p.id,
      title: p.title,
      descriptionHtml: p.descriptionHtml || "",
      handle: p.handle,
      status: p.status,
      productType: p.productType || "",
      featuredImage: {
        url: p.featuredImageUrl || "",
        altText: p.featuredImageAlt || undefined,
      },
      images: p.images
        ? p.images.map((img: any) => ({
            url: img.url,
            altText: img.altText,
            mediaId: img.mediaId ?? null,
            altTextTranslations: img.altTextTranslations
              ? img.altTextTranslations.map((t: any) => ({ locale: t.locale, altText: t.altText, marketId: t.marketId ?? "" }))
              : [],
          }))
        : [],
      seo: {
        title: p.seoTitle || "",
        description: p.seoDescription || "",
      },
      options: p.options?.filter((opt: any) => {
        try {
          const parsed = JSON.parse(opt.values || "[]");
          const valNames = Array.isArray(parsed)
            ? parsed.map((v: any) => typeof v === "string" ? v : v.name)
            : [];
          return !isDefaultTitleOption({ name: opt.name, values: valNames });
        } catch { return true; }
      }).map((opt: any) => {
        let values: Array<{ id: string; name: string; linked?: boolean }> = [];
        try {
          const parsed = JSON.parse(opt.values || "[]");
          // Support both new format [{id, name, linked}] and legacy ["string"] format
          values = Array.isArray(parsed)
            ? parsed.map((v: any) => typeof v === "string" ? { id: "", name: v } : { id: v.id, name: v.name, linked: !!v.linked })
            : [];
        } catch { values = []; }
        // Option is linked if linkedMetafieldKey is set (most reliable) OR any value has linked flag
        const isLinked = !!opt.linkedMetafieldKey || values.some(v => v.linked);
        return { id: opt.id, name: opt.name, position: opt.position, values, isLinked, linkedMetaobjectType: opt.linkedMetafieldKey || undefined };
      }) || [],
      metafields: p.metafields?.filter((mf: any) =>
        // Shared predicate — the bulk editor's metafield columns use the SAME
        // filter (isEditableProductMetafield), so both surfaces show the same
        // fields (Plan §4.1).
        isEditableProductMetafield(mf, enabledMetafieldKeys)
      ).map((mf: any) => ({
        id: mf.id, namespace: mf.namespace, key: mf.key, value: mf.value, type: mf.type,
      })) || [],
      // Sub-resource translations loaded via same DB pipeline as main translations
      subResourceTranslations: (() => {
        // Carry marketId per row so the client can layer market → global (see
        // useProductSubResources). "" = global.
        const result: Record<string, Array<{ key: string; value: string; locale: string; marketId: string }>> = {};
        for (const opt of p.options || []) {
          if (subTransByResource[opt.id]) {
            result[opt.id] = subTransByResource[opt.id].map((t: any) => ({
              key: t.key, value: t.value, locale: t.locale, marketId: t.marketId ?? "",
            }));
          }
          try {
            const vals = JSON.parse(opt.values || "[]");
            for (const v of vals) {
              if (v.id && subTransByResource[v.id]) {
                result[v.id] = subTransByResource[v.id].map((t: any) => ({
                  key: t.key, value: t.value, locale: t.locale, marketId: t.marketId ?? "",
                }));
              }
            }
          } catch { /* ignore */ }
        }
        for (const mf of p.metafields || []) {
          if (subTransByResource[mf.id]) {
            result[mf.id] = subTransByResource[mf.id].map((t: any) => ({
              key: t.key, value: t.value, locale: t.locale, marketId: t.marketId ?? "",
            }));
          }
        }
        return result;
      })(),
    }));

    return {
      items: products,
      ids: dbProducts.map((p: any) => p.id),
    };
  },

  async extraData(ctx) {
    const { getPlanLimits, canAccessVariantImageManagerInEnv, isProductionLocked, canAccessImageProcessingTab } = await import("../utils/planUtils");
    const settings = await ctx.db.aISettings.findUnique({ where: { shop: ctx.session.shop } });
    const plan = (settings?.subscriptionPlan || "free") as "free" | "basic" | "pro" | "max";
    const planLimits = getPlanLimits(plan);
    const productCount = await ctx.db.product.count({ where: { shop: ctx.session.shop } });
    const imageManagerSettings = await ctx.db.imageManagerSettings.findUnique({
      where: { shopId: ctx.session.shop },
    }) ?? { enabled: true, firstImageBig: false, showAltTags: false, autoAltText: false, thumbSize: 80 };
    const newFeaturesEnabled = !isProductionLocked();
    const showImageManager = canAccessVariantImageManagerInEnv(plan, newFeaturesEnabled) && (imageManagerSettings.enabled ?? true);
    const showImageProcessingTab = canAccessImageProcessingTab(plan, newFeaturesEnabled);
    return { plan, maxProducts: planLimits.maxProducts, productCount, showImageManager, showImageProcessingTab, imageManagerSettings };
  },
});

// ============================================================================
// ACTION - Handle all actions via unified handler
// ============================================================================

export const action = async (args: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(args.request);
  const formData = await args.request.formData();

  // Load AI settings
  const { db } = await import("../db.server");
  const [aiSettings, aiInstructions] = await Promise.all([
    db.aISettings.findUnique({ where: { shop: session.shop } }),
    db.aIInstructions.findUnique({ where: { shop: session.shop } }),
  ]);

  // Use unified action handler (handles text fields + images)
  return handleUnifiedContentActions({
    admin,
    session,
    formData,
    contentConfig: PRODUCTS_CONFIG,
    db,
    aiSettings,
    aiInstructions,
  });
};

// ============================================================================
// COMPONENT - Simple, unified approach (like Collections)
// ============================================================================

export default function ProductsPage() {
  const { products, shopLocales, primaryLocale, markets, error, aiSettings, plan, maxProducts, productCount, showImageManager, imageManagerSettings } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const fetcher = useFetcher<typeof action>();
  const syncFetcher = useFetcher<{ success: boolean; synced: number; total: number }>();
  const translationSyncFetcher = useFetcher<{ success: boolean }>();
  const revalidator = useRevalidator();
  const { t } = useI18n();
  const { showInfoBox, setGlobalLoading } = useInfoBox();
  const { getNextPlanUpgrade } = usePlan();
  const [isSyncing, setIsSyncing] = useState(false);
  const [isLoadingTranslations, setIsLoadingTranslations] = useState(false);
  const [isInitialLoad, setIsInitialLoad] = useState(true);

  // Track which products we've already synced translations for (to avoid duplicate syncs)
  // IMPORTANT: All hooks must be called before any conditional returns
  const syncedProductsRef = useRef<Set<string>>(new Set());
  const isMountedRef = useRef(true); // Track mount status to prevent state updates after unmount
  // Track that revalidation was triggered by on-demand translation sync
  // so we can refresh the editor when fresh data arrives
  const pendingTranslationSyncRefreshRef = useRef(false);

  // Deep-link from the SEO dashboard: ?select=<Shopify GID> preselects the item.
  const [searchParams] = useSearchParams();
  const initialItemId = searchParams.get("select") || undefined;

  // Initialize unified content editor - MUST be called before any conditional returns
  const editor = useUnifiedContentEditor({
    config: PRODUCTS_CONFIG,
    items: products as ContentItem[],
    shopLocales,
    primaryLocale,
    markets,
    fetcher,
    showInfoBox,
    t,
    initialItemId,
  });

  // Image Manager state (Pro/Max only - always call hook, gated in UI)
  const imageManagerState = useVariantImageManager();

  // Reset image manager state when product selection changes
  const prevSelectedItemId = useRef<string | null>(null);
  useEffect(() => {
    const currentId = editor.state.selectedItemId;
    if (currentId && currentId !== prevSelectedItemId.current) {
      prevSelectedItemId.current = currentId;
      imageManagerState.resetForProduct();
    }
  }, [editor.state.selectedItemId, imageManagerState.resetForProduct]);

  // Per-product override of product images. Populated when WebP conversion completes
  // (either while the product is open or detected on return after a background completion),
  // so the new WebP URLs survive product switches without needing a full revalidate.
  // Cleared whenever the loader returns fresh data (loader is then the authoritative source).
  type ProductImageEntry = { url: string; mediaId: string; id: string; altText?: string | null };
  const [productImagesOverride, setProductImagesOverride] = useState<Map<string, ProductImageEntry[]>>(new Map());
  useEffect(() => {
    setProductImagesOverride(new Map());
  }, [products]);
  const handleProductImagesRefreshed = useCallback((pid: string, images: ProductImageEntry[]) => {
    setProductImagesOverride(prev => {
      const next = new Map(prev);
      next.set(pid, images);
      return next;
    });
  }, []);

  // Memoised so VariantImageManager's onMissingMainImageChange-deps useEffect
  // does not refire on every render. An inline arrow here had a new identity
  // each render → effect always fired → loop (before the hook setter's
  // bail-out was added). Kept memoised even now to avoid wasted effect runs.
  const handleMissingMainImageChangeForSelected = useCallback(
    (hasMissing: boolean) => {
      const selectedId = editor.selectedItem?.id;
      if (!selectedId) return;
      imageManagerState.handleMissingMainImageChange(selectedId, hasMissing);
    },
    [editor.selectedItem?.id, imageManagerState.handleMissingMainImageChange],
  );

  // Initialize sub-resources hook for options + metafields translations
  // Uses its own internal fetcher to avoid race conditions with the main editor
  const subResources = useProductSubResources({
    selectedItem: editor.selectedItem,
    currentLanguage: editor.state.currentLanguage,
    primaryLocale,
    selectedMarketId: editor.state.selectedMarketId,
    revalidator,
    showInfoBox,
    enabledLanguages: editor.state.enabledLanguages,
    strings: {
      optionsSavedSuccess: t.products.optionsSavedSuccess,
      saveFailed: t.products.saveFailed,
      saveFailedOptions: t.products.saveFailedOptions,
      saveFailedItems: t.products.saveFailedItems,
      validationError: t.products.validationError,
      optionNameEmpty: t.products.optionNameEmpty,
      optionValuesEmpty: t.products.optionValuesEmpty,
      metafieldValuesEmpty: t.products.metafieldValuesEmpty,
      success: t.products.successTitle,
    },
  });

  // Extend subResource state/handlers to include pending gallery changes so the
  // main Speichern/Verwerfen buttons also save and reset variant gallery
  // assignments. Every per-variant pending bucket has to be listed here —
  // missing one means the Save button stays disabled while the merchant's
  // unsaved change is sitting in the corresponding state slot, looking
  // applied but never reaching Shopify. Buckets:
  //   • pendingVariantGalleries   — file-backed gallery edits
  //   • pendingMediaOrder         — product-media reorder
  //   • pendingProductNewMedia    — fresh uploads + library picks (product mode)
  //   • bulkItems (ready)         — bulk-uploaded files awaiting assignment
  //   • hasAltTextEdits           — alt-text per image
  //   • pendingExternalVideos     — YouTube / Vimeo URLs per variant
  //   • pendingVariant3dModels    — .glb URLs per variant (list.url metafield)
  //   • pendingGalleryOrder       — combined file+url+model order per variant
  //   • pendingClearVariantMainImages — explicit clear-main-image requests
  //   • pendingKnownModelGids     — carry-over from a prior "processing" save
  //                                 so a second click on Save retries the GID
  //                                 polling even when nothing else changed
  const hasPendingImageChanges = showImageManager && (
    imageManagerState.pendingVariantGalleries.length > 0 ||
    imageManagerState.pendingMediaOrder.length > 0 ||
    imageManagerState.pendingProductNewMedia.length > 0 ||
    imageManagerState.pendingClearVariantMainImages.length > 0 ||
    imageManagerState.bulkItems.some(i => i.status === "ready") ||
    imageManagerState.hasAltTextEdits ||
    Object.keys(imageManagerState.pendingExternalVideos).length > 0 ||
    Object.keys(imageManagerState.pendingVariant3dModels).length > 0 ||
    Object.keys(imageManagerState.pendingGalleryOrder).length > 0 ||
    Object.keys(imageManagerState.pendingKnownModelGids).length > 0
  );

  // Background 3D asset backfill. Sync save only waits ~1.5s for
  // Model3d.sources[0].url + preview, anything slower lands here.
  //
  // Refs (not deps) for the imageManager handle and the editor's
  // selected product. Without them the tick() closure captured stale
  // state from BEFORE the post-save deferred-clear populated the
  // carry-over — pendingModels resolved to [] and the endpoint
  // returned "nothing to do", stopping the loop the moment it
  // started. By always reading from a fresh ref we pick up the
  // carry-over the next time tick() fires regardless of which render
  // schedulePreviewBackfill was bound on.
  const imageManagerStateRef = useRef(imageManagerState);
  imageManagerStateRef.current = imageManagerState;
  const previewBackfillTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previewBackfillStepRef = useRef(0);
  const previewBackfillProductIdRef = useRef<string | null>(null);
  const previewBackfillTick = useCallback(async () => {
    previewBackfillTimerRef.current = null;
    const productId = previewBackfillProductIdRef.current;
    if (!productId) return;
    // Cancel if the merchant switched products mid-flight. Without this,
    // a tick scheduled for product A would POST to the refresh endpoint
    // with productId=A but using imageManagerStateRef which has been
    // overwritten with product B's state — resolvedEntries belonging to
    // A's variants would clobber B's pending state.
    if (editor.selectedItem?.id && editor.selectedItem.id !== productId) return;
    const state = imageManagerStateRef.current;
    const pendingModels: Array<{ variantId: string; modelGid: string; stagingUrl: string }> = [];
    for (const [variantId, urls] of Object.entries(state.pendingVariant3dModels ?? {})) {
      for (const u of urls) {
        const gid = state.pendingKnownModelGids?.[u];
        if (gid) pendingModels.push({ variantId, modelGid: gid, stagingUrl: u });
      }
    }
    const delays = [10000, 15000, 30000, 45000, 60000, 60000, 60000, 60000];
    try {
      const r = await fetch("/api/refresh-3d-previews", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId, pendingModels }),
      });
      const data = await r.json();
      const resolved = Array.isArray(data?.resolvedEntries) ? data.resolvedEntries as Array<{ variantId: string; stagingUrl: string; finalUrl: string; previewUrl: string }> : [];
      if (resolved.length > 0) {
        // In-place URL substitution: replace each resolved staging URL with
        // its final CDN URL inside pendingVariant3dModels (and the parallel
        // preview slot with the resolved preview URL). The pending state
        // continues to act as the optimistic override — preserving removals
        // and any concurrent edits the merchant made during the polling
        // window — but with the freshly-persisted CDN URL + preview instead
        // of the staging URL + empty preview slot. Once reloadVariants lands,
        // variant.threeDModelUrls / variant.threeDPreviewUrls match.
        const stagingToFinal = new Map<string, { variantId: string; finalUrl: string; previewUrl: string }>();
        for (const r of resolved) stagingToFinal.set(r.stagingUrl, { variantId: r.variantId, finalUrl: r.finalUrl, previewUrl: r.previewUrl });
        // Snapshot the pre-substitution models so the preview setter can
        // index against the original staging-URL positions.
        const modelsBeforeSubstitution = state.pendingVariant3dModels;
        state.setPendingVariant3dModels(prev => {
          const next = { ...prev };
          for (const [vid, urls] of Object.entries(prev)) {
            let changed = false;
            const replaced = urls.map(u => {
              const m = stagingToFinal.get(u);
              if (m && m.variantId === vid) {
                changed = true;
                return m.finalUrl;
              }
              return u;
            });
            if (changed) next[vid] = replaced;
          }
          return next;
        });
        state.setPendingVariant3dPreviews(prev => {
          const next = { ...prev };
          for (const [vid, oldPreviews] of Object.entries(prev)) {
            const oldModels = modelsBeforeSubstitution[vid];
            if (!oldModels) continue;
            let changed = false;
            const updated = oldPreviews.map((p, i) => {
              const oldModelUrl = oldModels[i];
              const m = oldModelUrl ? stagingToFinal.get(oldModelUrl) : undefined;
              if (m && m.variantId === vid && m.previewUrl && m.previewUrl !== p) {
                changed = true;
                return m.previewUrl;
              }
              return p;
            });
            if (changed) next[vid] = updated;
          }
          return next;
        });
        state.setPendingKnownModelGids(prev => {
          const next = { ...prev };
          for (const r of resolved) delete next[r.stagingUrl];
          return next;
        });
      }
      // Orphans: Model3d GIDs the server can't find on product.media (deleted,
      // typo, wrong product). Without an exit the backfill would poll them
      // forever. Drop them from pending state and warn so the merchant can
      // see something happened.
      const orphans = Array.isArray(data?.orphanedStagingUrls) ? data.orphanedStagingUrls as string[] : [];
      if (orphans.length > 0) {
        console.warn(`[preview-backfill] dropping ${orphans.length} orphaned pending 3D model(s) — Model3d GID not found on product.media`, orphans);
        const orphanSet = new Set(orphans);
        state.setPendingVariant3dModels(prev => {
          const next = { ...prev };
          for (const [vid, urls] of Object.entries(prev)) {
            const kept = urls.filter(u => !orphanSet.has(u));
            if (kept.length === 0) delete next[vid];
            else next[vid] = kept;
          }
          return next;
        });
        state.setPendingKnownModelGids(prev => {
          const next = { ...prev };
          for (const u of orphans) delete next[u];
          return next;
        });
      }
      if (data?.updated > 0) state.reloadVariants();
      const stillPending = data?.stillPending ?? 0;
      const hasPendingLocally = pendingModels.length > 0 || resolved.length > 0;
      if ((stillPending > 0 || hasPendingLocally) && previewBackfillStepRef.current < delays.length) {
        const delay = delays[previewBackfillStepRef.current];
        previewBackfillStepRef.current += 1;
        previewBackfillTimerRef.current = setTimeout(previewBackfillTick, delay);
      }
    } catch {
      if (previewBackfillStepRef.current < delays.length) {
        const delay = delays[previewBackfillStepRef.current];
        previewBackfillStepRef.current += 1;
        previewBackfillTimerRef.current = setTimeout(previewBackfillTick, delay);
      }
    }
  }, []);
  const schedulePreviewBackfill = useCallback((productId: string) => {
    if (previewBackfillTimerRef.current) clearTimeout(previewBackfillTimerRef.current);
    previewBackfillProductIdRef.current = productId;
    previewBackfillStepRef.current = 0;
    const firstDelay = 10000;
    previewBackfillStepRef.current = 1;
    previewBackfillTimerRef.current = setTimeout(previewBackfillTick, firstDelay);
  }, [previewBackfillTick]);
  useEffect(() => () => {
    if (previewBackfillTimerRef.current) clearTimeout(previewBackfillTimerRef.current);
  }, []);
  // Cancel any pending backfill tick when the merchant switches products.
  // The previewBackfillProductIdRef stays bound to the original product —
  // without cancelling, the next scheduled tick would still fire (and the
  // in-tick productId-guard would no-op it, but we save the wasted timer
  // and any in-flight fetch race).
  useEffect(() => {
    return () => {
      if (previewBackfillTimerRef.current) {
        clearTimeout(previewBackfillTimerRef.current);
        previewBackfillTimerRef.current = null;
      }
      previewBackfillProductIdRef.current = null;
    };
  }, [editor.selectedItem?.id]);
  const wrappedSubResourceState = useMemo(() => ({
    ...subResources.state,
    hasChanges: subResources.state.hasChanges || hasPendingImageChanges,
    // OR isApplying into isSaving so the Save button shows a spinner and
    // stays disabled while imageManagerState.handleApply is in flight.
    // The image-manager save can run for up to ~38s (server-side polling
    // for big 3D model previews) — without this wiring the button stayed
    // active during the wait, the merchant double-clicked, and the second
    // POST hit /api/update-variant-galleries with the same staging URL
    // (duplicate productCreateMedia → Shopify 422).
    isSaving: subResources.state.isSaving || imageManagerState.isApplying,
  }), [subResources.state, hasPendingImageChanges, imageManagerState.isApplying]);

  const wrappedSubResourceHandlers = useMemo(() => ({
    ...subResources.handlers,
    saveSubResources: () => {
      subResources.handlers.saveSubResources();
      if (hasPendingImageChanges && editor.selectedItem) {
        const productId = editor.selectedItem.id;
        imageManagerState.handleApply(productId).then(err => {
          if (err) {
            showInfoBox(err, "critical", t.products.galleryErrorTitle);
          } else {
            showInfoBox(t.products.gallerySaveSuccess, "success");
            // Kick off background polling for 3D model previews. Shopify
            // takes minutes to generate the .glb thumbnail server-side —
            // the save route only waits ~25s (enough for source URL), the
            // preview lands later. This loop calls /api/refresh-3d-previews
            // with exponential backoff until every Model3d has a preview
            // or we hit the ~5min budget. Each successful update triggers
            // a variant data refresh so the merchant sees the thumbnail
            // appear automatically.
            schedulePreviewBackfill(productId);
          }
        }).catch(() => {
          showInfoBox(t.products.gallerySaveError, "critical");
        });
      }
    },
    resetChanges: () => {
      subResources.handlers.resetChanges();
      imageManagerState.resetForProduct();
    },
    resetForReload: () => {
      subResources.handlers.resetForReload();
      imageManagerState.resetForProduct();
    },
  }), [subResources.handlers, hasPendingImageChanges, editor.selectedItem, imageManagerState, showInfoBox]);

  // Wrap translate-all handlers to also translate product options and metafields.
  // Uses a separate internal fetcher in useProductSubResources to avoid conflicting
  // with the shared fetcher used by the main editor.
  const editorWithSubResources = {
    ...editor,
    handlers: {
      ...editor.handlers,
      handleTranslateAll: () => {
        editor.handlers.handleTranslateAll();
        subResources.handlers.translateAllSubResourcesToAllLocales();
      },
      handleTranslateAllForLocale: () => {
        editor.handlers.handleTranslateAllForLocale();
        subResources.handlers.translateAllSubResources();
      },
      // Navigation guard hooks: the editor's own handleLanguageChange /
      // handleItemSelect only gate on editor.state.hasChanges (field-level
      // text edits) — they don't know about image-manager pending state
      // (uploads / library picks / variant gallery edits / 3D models /
      // external videos). When image changes are pending, the native save
      // bar is visible and confirmNavigation() shows the native confirm
      // dialog before letting the action proceed.
      handleLanguageChange: async (locale: string) => {
        if (hasPendingImageChanges && !editor.state.hasChanges) {
          await confirmNavigation();
        }
        editor.handlers.handleLanguageChange(locale);
      },
      handleItemSelect: async (itemId: string) => {
        if (hasPendingImageChanges && !editor.state.hasChanges) {
          await confirmNavigation();
        }
        editor.handlers.handleItemSelect(itemId);
      },
    },
  };

  // Get selected product AFTER editor is initialized
  const selectedProductId = editor.state.selectedItemId;
  const selectedProduct = editor.selectedItem;

  // ============================================================================
  // ON-DEMAND TRANSLATION LOADING
  // When a product is selected, check if it has translations. If not, load them.
  // ============================================================================

  // Track component mount status to prevent state updates after unmount
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Mark initial load as complete after first render
  useEffect(() => {
    if (isInitialLoad && products.length >= 0 && isMountedRef.current) {
      // Small delay to ensure smooth transition
      const timer = setTimeout(() => {
        if (isMountedRef.current) {
          setIsInitialLoad(false);
        }
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [products, isInitialLoad]);

  // Measure page load performance
  useEffect(() => {
    if (!isInitialLoad && products.length >= 0) {
      measurePageLoad('ProductsPage', {
        productCount: products.length,
        hasImages: products.some((p: any) => p?.images && p.images.length > 0),
      });
    }
  }, [isInitialLoad, products]);

  useEffect(() => {
    // Skip if no product selected or already loading or component unmounted
    if (!selectedProductId || !selectedProduct || isLoadingTranslations || !isMountedRef.current) return;

    // Skip if we've already synced this product
    if (syncedProductsRef.current.has(selectedProductId)) return;

    // Skip if translations were recently saved by the user (prevents re-fetching stale
    // data from Shopify after Clear All due to eventual consistency)
    if (wasRecentlySaved(selectedProductId)) {
      syncedProductsRef.current.add(selectedProductId);
      return;
    }

    // Check if product has any translations
    const hasTranslations = selectedProduct.translations && selectedProduct.translations.length > 0;

    // If product has no translations, trigger sync
    if (!hasTranslations && isMountedRef.current) {
      setIsLoadingTranslations(true);

      // Mark as synced to prevent duplicate syncs
      syncedProductsRef.current.add(selectedProductId);

      // Trigger the sync API for this product
      translationSyncFetcher.submit(
        {
          resourceId: selectedProductId,
          resourceType: "product",
          locale: primaryLocale,
        },
        { method: "POST", action: "/api/sync-single-resource" }
      );
    }
  }, [selectedProductId, selectedProduct, isLoadingTranslations, primaryLocale]);

  // Handle translation sync completion
  useEffect(() => {
    if (isLoadingTranslations && translationSyncFetcher.state === "idle" && translationSyncFetcher.data && isMountedRef.current) {
      if (isMountedRef.current) {
        setIsLoadingTranslations(false);
      }

      if (translationSyncFetcher.data.success && isMountedRef.current) {
        // Revalidate to fetch fresh data with translations
        if (revalidator.state === "idle") {
          pendingTranslationSyncRefreshRef.current = true;
          revalidator.revalidate();
        }
      }
    }
  }, [isLoadingTranslations, translationSyncFetcher.state, translationSyncFetcher.data, revalidator.state]);

  // After revalidation from translation sync delivers fresh data, tell the editor
  // to re-resolve field values. Without this, the data loading effect skips because
  // selectedItemId/currentLanguage haven't changed, leaving editableValues blank.
  useEffect(() => {
    if (pendingTranslationSyncRefreshRef.current) {
      pendingTranslationSyncRefreshRef.current = false;
      editor.helpers.triggerDataRefresh();
      subResources.handlers.resetForReload();
    }
  }, [products]); // eslint-disable-line react-hooks/exhaustive-deps -- intentionally fires when products changes after sync

  // Check for sync parameter and trigger background sync
  useEffect(() => {
    if (!isMountedRef.current) return;

    const url = new URL(window.location.href);
    if (url.searchParams.has("sync") && !isSyncing && syncFetcher.state === "idle" && isMountedRef.current) {
      setIsSyncing(true);

      // Remove sync parameter from URL
      url.searchParams.delete("sync");
      window.history.replaceState({}, "", url.toString());

      // Show loading spinner and message via InfoBox
      setGlobalLoading(true);
      showInfoBox(t.products.syncInProgress, "info");

      // Trigger the sync API
      syncFetcher.submit(
        {},
        { method: "POST", action: "/api/sync-missing-products" }
      );
    }
  }, [isSyncing, syncFetcher.state, showInfoBox, setGlobalLoading, t]);

  // Handle sync completion
  useEffect(() => {
    if (isSyncing && syncFetcher.state === "idle" && syncFetcher.data && isMountedRef.current) {
      // Hide loading spinner
      if (isMountedRef.current) {
        setGlobalLoading(false);
      }

      if (syncFetcher.data.success && syncFetcher.data.synced > 0 && isMountedRef.current) {
        const message = t.products.syncComplete.replace("{count}", String(syncFetcher.data.synced));
        showInfoBox(message, "success", t.products.syncCompleteTitle);
        // Reload to show new products
        window.location.reload();
      } else if (isMountedRef.current) {
        setIsSyncing(false);
      }
    }
  }, [isSyncing, syncFetcher.state, syncFetcher.data, showInfoBox, setGlobalLoading, t]);

  // Show loader error
  useEffect(() => {
    if (error && isMountedRef.current) {
      const message = error.startsWith("GraphQL error")
        ? (t.errors?.graphqlError || error)
        : error;
      showInfoBox(message, "critical", t.common?.error || "Error");
    }
  }, [error, showInfoBox, t]);

  // Show loading spinner during initial page load or navigation
  const isPageLoading = navigation.state === "loading" && navigation.location?.pathname === "/app/products";
  const shouldShowLoader = isInitialLoad || isPageLoading;

  // IMPORTANT: Return loading UI at the end, after ALL hooks and effects are defined
  // This prevents React error #425 (inconsistent hook count between renders)
  if (shouldShowLoader) {
    return (
      <div
        style={{
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexDirection: "column",
          gap: "16px",
        }}
      >
        <Spinner accessibilityLabel="Loading products" size="large" />
        <Text as="p" variant="bodyMd" tone="subdued">
          {t.products?.loading || "Loading Products"}
        </Text>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
        <UnifiedContentEditor
          config={PRODUCTS_CONFIG}
          items={products as ContentItem[]}
          shopLocales={shopLocales}
          primaryLocale={primaryLocale}
          editor={editorWithSubResources}
          extraMissingPrimaryIds={imageManagerState.missingMainImageProductIds}
          fetcherState={fetcher.state}
          fetcherFormData={fetcher.formData}
          t={t}
          planLimit={{
            // Use the TRUE catalog count from extraData, not products.length —
            // the latter is capped to min(maxProducts, HARD_CAP=2000) by the
            // loader, so on Max (maxProducts=2500) products.length tops out at
            // 2000 and the "at limit" banner would never fire even when the
            // merchant is genuinely over quota.
            isAtLimit: productCount >= maxProducts && maxProducts !== Infinity,
            maxItems: maxProducts,
            currentPlan: getPlanDisplayName(plan),
            nextPlan: (() => { const n = getNextPlanUpgrade(); return n ? getPlanDisplayName(n) : undefined; })(),
          }}
          revalidator={revalidator}
          sortOptions={[
            { field: "title", label: "Title" },
            { field: "productType", label: "Product Type" },
            { field: "status", label: "Status" },
            { field: "shopifyUpdatedAt", label: "Last Updated", type: "date" },
          ]}
          subResourceState={wrappedSubResourceState}
          subResourceHandlers={wrappedSubResourceHandlers}
          showImageManager={showImageManager}
          imageManager={showImageManager ? {
            bulkItems: imageManagerState.bulkItems,
            onBulkItemsChange: imageManagerState.handleBulkItemsChange,
            selectedBulkIds: imageManagerState.selectedBulkIds,
            activeAction: imageManagerState.activeAction,
            onSetAction: imageManagerState.setActiveAction,
            onBulkSelect: imageManagerState.handleBulkSelect,
            onRemoveBulk: imageManagerState.handleRemoveBulk,
            activeRightTab: imageManagerState.activeRightTab,
            onTabChange: imageManagerState.setActiveRightTab,
            activeImageSubTab: imageManagerState.activeImageSubTab,
            onImageSubTabChange: imageManagerState.setActiveImageSubTab,
            productId: editor.selectedItem?.id ?? "",
            imageManagerSettings: imageManagerSettings ?? { firstImageBig: false, showAltTags: false, autoAltText: false, thumbSize: 80 },
            variantsForBulk: imageManagerState.variantsForBulk,
            onVariantsLoaded: imageManagerState.handleVariantsLoaded,
            selectedGalleryGids: imageManagerState.selectedGalleryGids,
            onConfirm: async () => {
              const err = await imageManagerState.handleApply(editor.selectedItem?.id ?? "");
              if (err) {
                showInfoBox(err, "critical", t.products.galleryErrorTitle);
              } else {
                showInfoBox(t.products.gallerySaveSuccess, "success");
                revalidator.revalidate();
              }
              return err;
            },
            isApplying: imageManagerState.isApplying,
            productTitle: editor.selectedItem?.title ?? "",
            onApplySuccess: () => {
              imageManagerState.reloadVariants();
              revalidator.revalidate();
            },
          } : undefined}
          imageGalleryReplacement={showImageManager && editor.selectedItem ? (
            <VariantImageManager
              productId={editor.selectedItem.id}
              productImages={
                productImagesOverride.get(editor.selectedItem.id) ??
                (editor.selectedItem.images ?? []).map((img: any) => ({
                  url: img.url ?? "",
                  mediaId: img.mediaId ?? img.url ?? "",
                  id: img.id ?? img.url ?? "",
                  altText: img.altText ?? null,
                }))
              }
              bulkItems={imageManagerState.bulkItems}
              activeAction={imageManagerState.activeAction}
              selectedBulkIds={imageManagerState.selectedBulkIds}
              onRemoveBulk={imageManagerState.handleRemoveBulk}
              onSetAction={imageManagerState.setActiveAction}
              imageManagerSettings={imageManagerSettings ?? { firstImageBig: false, showAltTags: false, autoAltText: false, thumbSize: 80 }}
              onPendingChange={imageManagerState.handlePendingChange}
              onExternalVideosChange={imageManagerState.setPendingExternalVideos}
              onThreeDModelsChange={imageManagerState.setPendingVariant3dModels}
              onThreeDPreviewsChange={imageManagerState.setPendingVariant3dPreviews}
              // Feeds the carry-over from a prior "processing" drop back
              // into VariantImageManager's local state so the merchant
              // keeps seeing the tile after Save and the next save still
              // includes the staging URL in its payload. Owned by the
              // hook (single source of truth for the next save's body).
              seedThreeDModelUrls={imageManagerState.pendingVariant3dModels}
              seedThreeDPreviewUrls={imageManagerState.pendingVariant3dPreviews}
              onGalleryOrderChange={imageManagerState.setPendingGalleryOrder}
              onVariantsLoaded={imageManagerState.handleVariantsLoaded}
              resetKey={imageManagerState.resetCounter}
              currentLanguage={editor.state.currentLanguage}
              primaryLocale={primaryLocale}
              productTitle={editor.selectedItem.title}
              enabledLanguages={shopLocales.map((l: any) => l.locale)}
              variantReloadKey={imageManagerState.variantReloadCounter}
              onDirtyChange={imageManagerState.setHasAltTextEdits}
              onMissingMainImageChange={handleMissingMainImageChangeForSelected}
              onProductImagesRefreshed={handleProductImagesRefreshed}
              onGallerySelectionGidsChange={imageManagerState.handleGallerySelectionGidsChange}
            />
          ) : undefined}
        />
      </div>
    </div>
  );
}
