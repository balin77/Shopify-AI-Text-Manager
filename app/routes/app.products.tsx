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
import { useLoaderData, useFetcher, useRevalidator, useNavigation } from "@remix-run/react";
import { upsertProductMetafields } from "../db.server";
import { authenticate } from "../shopify.server";
import { MainNavigation } from "../components/MainNavigation";
import { ContentTypeNavigation } from "../components/ContentTypeNavigation";
import { UnifiedContentEditor } from "../components/UnifiedContentEditor";
import { useUnifiedContentEditor } from "../hooks/useUnifiedContentEditor";
import { useProductSubResources } from "../hooks/useProductSubResources";
import { handleUnifiedContentActions } from "../actions/unified-content.actions";
import { PRODUCTS_CONFIG } from "../config/content-fields.config";
import { useI18n } from "../contexts/I18nContext";
import { useInfoBox } from "../contexts/InfoBoxContext";
import { usePlan } from "../contexts/PlanContext";
import { useNavigationHeight } from "../contexts/NavigationHeightContext";
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

    // Paginated fetch from Shopify (capped to plan limit)
    const maxToFetch = planLimits.maxProducts === Infinity ? 10000 : planLimits.maxProducts;
    const shopifyProducts: any[] = [];
    let hasNextPage = true;
    let cursor: string | null = null;

    while (hasNextPage && shopifyProducts.length < maxToFetch) {
      const batchSize = Math.min(250, maxToFetch - shopifyProducts.length);
      const shopifyResponse = await ctx.admin.graphql(
        `#graphql
          query getProductIds($first: Int!, $after: String) {
            products(first: $first, after: $after) {
              pageInfo { hasNextPage endCursor }
              edges {
                node {
                  id
                  title
                  descriptionHtml
                  handle
                  status
                  productType
                  updatedAt
                  seo { title description }
                  featuredImage { url altText }
                  media(first: 20) {
                    edges {
                      node {
                        ... on MediaImage {
                          id
                          alt
                          image { url }
                        }
                      }
                    }
                  }
                  options {
                    id
                    name
                    position
                    linkedMetafield {
                      namespace
                      key
                    }
                    optionValues {
                      id
                      name
                      linkedMetafieldValue
                    }
                  }
                  metafields(first: 50) {
                    edges {
                      node {
                        id
                        namespace
                        key
                        value
                        type
                      }
                    }
                  }
                }
              }
            }
          }`,
        { variables: { first: batchSize, after: cursor } },
      );
      const shopifyData: any = await shopifyResponse.json();

      if (shopifyData.errors) {
        logger.error("[PRODUCTS-LOADER] GraphQL error fetching products", {
          context: "PRODUCTS",
          errors: shopifyData.errors,
        });
        throw new Error(
          `GraphQL error: ${shopifyData.errors.map((e: any) => e.message).join(", ")}`,
        );
      }

      const page: any = shopifyData.data?.products;
      const nodes = page?.edges?.map((e: any) => e.node) || [];
      shopifyProducts.push(...nodes);
      hasNextPage = page?.pageInfo?.hasNextPage ?? false;
      cursor = page?.pageInfo?.endCursor ?? null;
    }

    // Track whether we fetched ALL products from Shopify (loop ended naturally)
    // vs. stopped early due to plan cap
    const fetchedAllFromShopify = !hasNextPage;

    const shopifyProductIds = new Set(shopifyProducts.map((p: any) => p.id));

    const localProducts = await ctx.db.product.findMany({
      where: { shop: ctx.session.shop },
      select: { id: true },
    });
    const localProductIds = new Set(localProducts.map((p: any) => p.id));

    // Upsert ALL products (create new + update existing)
    const newProductIds = new Set(
      shopifyProducts.filter((p: any) => !localProductIds.has(p.id)).map((p: any) => p.id),
    );

    if (newProductIds.size > 0) {
      logger.info(`[PRODUCTS-LOADER] Creating ${newProductIds.size} new product(s) from Shopify`);
    }

    for (const product of shopifyProducts) {
      await ctx.db.product.upsert({
        where: { shop_id: { shop: ctx.session.shop, id: product.id } },
        create: {
          id: product.id, shop: ctx.session.shop, title: product.title,
          descriptionHtml: product.descriptionHtml || "", handle: product.handle,
          status: product.status, productType: product.productType || null,
          seoTitle: product.seo?.title || null, seoDescription: product.seo?.description || null,
          featuredImageUrl: product.featuredImage?.url || null,
          featuredImageAlt: product.featuredImage?.altText || null,
          shopifyUpdatedAt: new Date(product.updatedAt), lastSyncedAt: new Date(),
        },
        update: {
          title: product.title, descriptionHtml: product.descriptionHtml || "",
          handle: product.handle, status: product.status,
          productType: product.productType || null,
          seoTitle: product.seo?.title || null, seoDescription: product.seo?.description || null,
          featuredImageUrl: product.featuredImage?.url || null,
          featuredImageAlt: product.featuredImage?.altText || null,
          shopifyUpdatedAt: new Date(product.updatedAt), lastSyncedAt: new Date(),
        },
      });

      // Save images only for NEW products (existing products keep their images)
      if (newProductIds.has(product.id) && planLimits.cacheEnabled.productImages) {
        const mediaImages = product.media?.edges
          ?.filter((edge: any) => edge.node.id && edge.node.image?.url)
          .map((edge: any) => edge.node) || [];
        if (mediaImages.length > 0) {
          await ctx.db.productImage.deleteMany({ where: { productId: product.id } });
          await ctx.db.productImage.createMany({
            data: mediaImages.map((media: any, index: number) => ({
              productId: product.id, url: media.image.url,
              altText: media.alt || null, mediaId: media.id, position: index,
            })),
          });
        }
      }

      // Sync options (always update to keep optionValues GIDs fresh)
      // Filter out Shopify's internal "Default Title" placeholder (products with no real variants)
      const realOptions = (product.options || []).filter((opt: any) => !isDefaultTitleOption(opt));
      if (realOptions.length > 0) {
        // Log what Shopify API returns for the first product's options
        if (product === shopifyProducts[0]) {
          for (const opt of realOptions) {
            logger.info(`[PRODUCTS-LOADER] Option "${opt.name}": linkedMetafield=${JSON.stringify(opt.linkedMetafield)}, optionValues=${opt.optionValues?.length ?? 'none'}`);
          }
        }
        try {
          await ctx.db.productOption.deleteMany({ where: { productId: product.id } });
          const createData = realOptions.map((opt: any) => ({
            id: opt.id,
            productId: product.id,
            name: opt.name,
            position: opt.position,
            values: opt.optionValues
              ? JSON.stringify(opt.optionValues.map((v: any) => ({ id: v.id, name: v.name, linked: !!v.linkedMetafieldValue })))
              : JSON.stringify(opt.values),
            linkedMetafieldKey: opt.linkedMetafield ? `${opt.linkedMetafield.namespace}--${opt.linkedMetafield.key}` : null,
          }));
          if (product === shopifyProducts[0]) {
            logger.info(`[PRODUCTS-LOADER] createMany data sample: linkedMetafieldKey=${createData[0]?.linkedMetafieldKey}, valuesFormat=${createData[0]?.values?.substring(0, 60)}`);
          }
          await ctx.db.productOption.createMany({ data: createData });
          if (product === shopifyProducts[0]) {
            logger.info(`[PRODUCTS-LOADER] Options saved OK for ${product.id}`);
          }
        } catch (optErr: unknown) {
          logger.error(`[PRODUCTS-LOADER] OPTIONS SAVE FAILED for ${product.id}: ${optErr instanceof Error ? optErr.message : String(optErr)}`);
          // If the column doesn't exist, createMany fails — try without linkedMetafieldKey
          try {
            await ctx.db.productOption.createMany({
              data: realOptions.map((opt: any) => ({
                id: opt.id,
                productId: product.id,
                name: opt.name,
                position: opt.position,
                values: opt.optionValues
                  ? JSON.stringify(opt.optionValues.map((v: any) => ({ id: v.id, name: v.name, linked: !!v.linkedMetafieldValue })))
                  : JSON.stringify(opt.values),
              })),
            });
            logger.info(`[PRODUCTS-LOADER] Options saved (without linkedMetafieldKey) for ${product.id}`);
          } catch (fallbackErr: unknown) {
            logger.error(`[PRODUCTS-LOADER] OPTIONS FALLBACK ALSO FAILED for ${product.id}: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}`);
          }
        }
      }

      // Sync metafields (idempotent upsert — safe under concurrent execution)
      const metafields = product.metafields?.edges?.map((e: any) => e.node) || [];
      await upsertProductMetafields(ctx.db, product.id, metafields);
    }

    // Remove deleted products — only when we fetched ALL from Shopify.
    // When the fetch was capped by plan limits, we can't distinguish
    // "deleted from Shopify" vs "not fetched due to plan cap".
    if (fetchedAllFromShopify) {
      const removedIds = [...localProductIds].filter((id) => !shopifyProductIds.has(id));
      if (removedIds.length > 0) {
        logger.info(`[PRODUCTS-LOADER] Removing ${removedIds.length} deleted product(s) from DB`);
        await ctx.db.productImage.deleteMany({ where: { productId: { in: removedIds } } });
        await ctx.db.product.deleteMany({ where: { shop: ctx.session.shop, id: { in: removedIds } } });
        await ctx.db.contentTranslation.deleteMany({
          where: { shop: ctx.session.shop, resourceType: "Product", resourceId: { in: removedIds } },
        });
      }
    }

    // Fetch products from DATABASE (capped to plan limit)
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
      ...(planLimits.maxProducts !== Infinity ? { take: planLimits.maxProducts } : {}),
    });

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
              ? img.altTextTranslations.map((t: any) => ({ locale: t.locale, altText: t.altText }))
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
        ["single_line_text_field", "multi_line_text_field", "rich_text_field", "list.single_line_text_field"].includes(mf.type)
      ).map((mf: any) => ({
        id: mf.id, namespace: mf.namespace, key: mf.key, value: mf.value, type: mf.type,
      })) || [],
      // Sub-resource translations loaded via same DB pipeline as main translations
      subResourceTranslations: (() => {
        const result: Record<string, Array<{ key: string; value: string; locale: string }>> = {};
        for (const opt of p.options || []) {
          if (subTransByResource[opt.id]) {
            result[opt.id] = subTransByResource[opt.id].map((t: any) => ({
              key: t.key, value: t.value, locale: t.locale,
            }));
          }
          try {
            const vals = JSON.parse(opt.values || "[]");
            for (const v of vals) {
              if (v.id && subTransByResource[v.id]) {
                result[v.id] = subTransByResource[v.id].map((t: any) => ({
                  key: t.key, value: t.value, locale: t.locale,
                }));
              }
            }
          } catch { /* ignore */ }
        }
        for (const mf of p.metafields || []) {
          if (subTransByResource[mf.id]) {
            result[mf.id] = subTransByResource[mf.id].map((t: any) => ({
              key: t.key, value: t.value, locale: t.locale,
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
    const { getPlanLimits, canAccessVariantImageManager } = await import("../utils/planUtils");
    const settings = await ctx.db.aISettings.findUnique({ where: { shop: ctx.session.shop } });
    const plan = (settings?.subscriptionPlan || "free") as "free" | "basic" | "pro" | "max";
    const planLimits = getPlanLimits(plan);
    const productCount = await ctx.db.product.count({ where: { shop: ctx.session.shop } });
    const imageManagerSettings = await ctx.db.imageManagerSettings.findUnique({
      where: { shopId: ctx.session.shop },
    }) ?? { enabled: true, firstImageBig: false, showAltTags: false, autoAltText: false, thumbSize: 80 };
    const showImageManager = canAccessVariantImageManager(plan) && (imageManagerSettings.enabled ?? true);
    return { plan, maxProducts: planLimits.maxProducts, productCount, showImageManager, imageManagerSettings };
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
  const { products, shopLocales, primaryLocale, error, aiSettings, plan, maxProducts, showImageManager, imageManagerSettings } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const fetcher = useFetcher<typeof action>();
  const syncFetcher = useFetcher<{ success: boolean; synced: number; total: number }>();
  const translationSyncFetcher = useFetcher<{ success: boolean }>();
  const revalidator = useRevalidator();
  const { t } = useI18n();
  const { showInfoBox, setGlobalLoading } = useInfoBox();
  const { getNextPlanUpgrade } = usePlan();
  const { setContentNavHeight } = useNavigationHeight();
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

  // Initialize unified content editor - MUST be called before any conditional returns
  const editor = useUnifiedContentEditor({
    config: PRODUCTS_CONFIG,
    items: products as ContentItem[],
    shopLocales,
    primaryLocale,
    fetcher,
    showInfoBox,
    t,
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

  // Initialize sub-resources hook for options + metafields translations
  // Uses its own internal fetcher to avoid race conditions with the main editor
  const subResources = useProductSubResources({
    selectedItem: editor.selectedItem,
    currentLanguage: editor.state.currentLanguage,
    primaryLocale,
    revalidator,
    showInfoBox,
    enabledLanguages: editor.state.enabledLanguages,
  });

  // Extend subResource state/handlers to include pending gallery changes so the
  // main Speichern/Verwerfen buttons also save and reset variant gallery assignments.
  const hasPendingImageChanges = showImageManager && (
    imageManagerState.pendingVariantGalleries.length > 0 ||
    imageManagerState.pendingMediaOrder.length > 0 ||
    imageManagerState.bulkItems.some(i => i.status === "ready")
  );

  const wrappedSubResourceState = useMemo(() => ({
    ...subResources.state,
    hasChanges: subResources.state.hasChanges || hasPendingImageChanges,
  }), [subResources.state, hasPendingImageChanges]);

  const wrappedSubResourceHandlers = useMemo(() => ({
    ...subResources.handlers,
    saveSubResources: () => {
      subResources.handlers.saveSubResources();
      if (hasPendingImageChanges && editor.selectedItem) {
        imageManagerState.handleApply(editor.selectedItem.id).then(err => {
          if (err) {
            showInfoBox(err, "critical", "Galerie-Fehler");
          } else {
            showInfoBox("Galerie erfolgreich auf Shopify gespeichert.", "success");
          }
        }).catch(() => {
          showInfoBox("Galerie konnte nicht gespeichert werden.", "critical");
        });
      }
    },
    resetChanges: () => {
      subResources.handlers.resetChanges();
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
    },
  };

  // Get selected product AFTER editor is initialized
  const selectedProductId = editor.state.selectedItemId;
  const selectedProduct = editor.selectedItem;

  // ============================================================================
  // RESTORE SELECTION AFTER RELOAD
  // If user clicked reload button, restore the previously selected product
  // ============================================================================

  // Ref to access editor.handlers without adding as dependency (unstable reference)
  const editorHandlersRef = useRef(editor.handlers);
  editorHandlersRef.current = editor.handlers;

  useEffect(() => {
    // Wait for products to load
    if (!isMountedRef.current || !products.length) {
      return;
    }

    // Check URL for selected parameter
    const urlParams = new URLSearchParams(window.location.search);
    const selectedFromUrl = urlParams.get('selected');

    if (selectedFromUrl) {
      // Find the product in the list
      const productExists = products.find((p: any) => p.id === selectedFromUrl);

      if (productExists && typeof editorHandlersRef.current?.handleItemSelect === 'function') {
        // Restore selection via editor
        try {
          editorHandlersRef.current.handleItemSelect(selectedFromUrl);
        } catch (error) {
          // Selection restoration failed - non-critical
        }

        // Clean up URL parameter
        urlParams.delete('selected');
        urlParams.delete('_t');
        const newUrl = `${window.location.pathname}${urlParams.toString() ? '?' + urlParams.toString() : ''}`;
        window.history.replaceState({}, '', newUrl);
      }
    }
  }, [products]); // Only run when products load

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

  // Reset ContentNavigation height to 0 (since we don't have ContentTypeNavigation on Products page)
  useEffect(() => {
    setContentNavHeight(0);
  }, [setContentNavHeight]);

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
          height: "100vh",
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
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", overflow: "hidden" }}>
      <MainNavigation />
      <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
        <UnifiedContentEditor
          config={PRODUCTS_CONFIG}
          items={products as ContentItem[]}
          shopLocales={shopLocales}
          primaryLocale={primaryLocale}
          editor={editorWithSubResources}
          fetcherState={fetcher.state}
          fetcherFormData={fetcher.formData}
          t={t}
          planLimit={{
            isAtLimit: products.length >= maxProducts && maxProducts !== Infinity,
            maxItems: maxProducts,
            currentPlan: plan,
            nextPlan: getNextPlanUpgrade() || undefined,
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
            imageManagerSettings: imageManagerSettings ?? { firstImageBig: false, showAltTags: false, autoAltText: false, thumbSize: 80 },
          } : undefined}
          imageGalleryReplacement={showImageManager && editor.selectedItem ? (
            <VariantImageManager
              productId={editor.selectedItem.id}
              productImages={(editor.selectedItem.images ?? []).map((img: any) => ({
                url: img.url ?? "",
                mediaId: img.mediaId ?? img.url ?? "",
                id: img.id ?? img.url ?? "",
                altText: img.altText ?? null,
              }))}
              bulkItems={imageManagerState.bulkItems}
              activeAction={imageManagerState.activeAction}
              selectedBulkIds={imageManagerState.selectedBulkIds}
              onRemoveBulk={imageManagerState.handleRemoveBulk}
              onSetAction={imageManagerState.setActiveAction}
              imageManagerSettings={imageManagerSettings ?? { firstImageBig: false, showAltTags: false, autoAltText: false, thumbSize: 80 }}
              onPendingChange={imageManagerState.handlePendingChange}
            />
          ) : undefined}
        />
      </div>
    </div>
  );
}
