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

import { json, type LoaderFunctionArgs, type ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher, useRevalidator, useNavigation } from "@remix-run/react";
import { authenticate } from "../shopify.server";
import { MainNavigation } from "../components/MainNavigation";
import { ContentTypeNavigation } from "../components/ContentTypeNavigation";
import { UnifiedContentEditor } from "../components/UnifiedContentEditor";
import { useUnifiedContentEditor } from "../hooks/useUnifiedContentEditor";
import { handleUnifiedContentActions } from "../actions/unified-content.actions";
import { PRODUCTS_CONFIG } from "../config/content-fields.config";
import { useI18n } from "../contexts/I18nContext";
import { useInfoBox } from "../contexts/InfoBoxContext";
import { usePlan } from "../contexts/PlanContext";
import { useNavigationHeight } from "../contexts/NavigationHeightContext";
import { useEffect, useState, useRef } from "react";
import { Spinner, Text } from "@shopify/polaris";
import type { ContentItem } from "../types/content-editor.types";
import { logger } from "~/utils/logger.server";
import { measurePageLoad } from "~/utils/performance.client";

// ============================================================================
// LOADER - Load data from database
// ============================================================================

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  logger.debug("[PRODUCTS-LOADER] Loading products from DATABASE for shop", { context: "Products", shop: session.shop });

  try {
    const { db } = await import("../db.server");
    const { getPlanLimits } = await import("../utils/planUtils");
    const { loadAISettingsForValidation } = await import("../utils/loader-helpers");

    // Load plan settings
    const settings = await db.aISettings.findUnique({
      where: { shop: session.shop },
    });
    const plan = (settings?.subscriptionPlan || "free") as "free" | "basic" | "pro" | "max";
    const planLimits = getPlanLimits(plan);

    logger.debug("[PRODUCTS-LOADER] Current plan and limits", { context: "Products", plan, maxProducts: planLimits.maxProducts });

    // 1. Fetch shop locales (with caching)
    const { getCachedShopLocales } = await import("../utils/shop-locales-cache.server");
    const shopLocales = await getCachedShopLocales(admin, session.shop);
    const primaryLocale = shopLocales.find((l: any) => l.primary)?.locale || "en";

    logger.debug("[PRODUCTS-LOADER] Locales loaded", { context: "Products", primaryLocale, availableLocales: shopLocales.length });

    // 2. Incremental sync: fetch product IDs from Shopify (paginated), sync only missing ones
    const shopifyProducts: any[] = [];
    let hasNextPage = true;
    let cursor: string | null = null;

    while (hasNextPage) {
      const shopifyResponse = await admin.graphql(
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
                }
              }
            }
          }`,
        { variables: { first: 250, after: cursor } }
      );
      const shopifyData: any = await shopifyResponse.json();
      const page: any = shopifyData.data?.products;
      const nodes = page?.edges?.map((e: any) => e.node) || [];
      shopifyProducts.push(...nodes);
      hasNextPage = page?.pageInfo?.hasNextPage ?? false;
      cursor = page?.pageInfo?.endCursor ?? null;
    }

    const shopifyProductIds = new Set(shopifyProducts.map((p: any) => p.id));

    const localProducts = await db.product.findMany({
      where: { shop: session.shop },
      select: { id: true },
    });
    const localProductIds = new Set(localProducts.map(p => p.id));

    // Sync missing products (lightweight: basic data only, no translations)
    const missingProducts = shopifyProducts.filter((p: any) => !localProductIds.has(p.id));
    if (missingProducts.length > 0) {
      logger.info(`[PRODUCTS-LOADER] Syncing ${missingProducts.length} new product(s) from Shopify`);
      for (const product of missingProducts) {
        await db.product.upsert({
          where: { shop_id: { shop: session.shop, id: product.id } },
          create: {
            id: product.id, shop: session.shop, title: product.title,
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

        // Save images if plan allows
        if (planLimits.cacheEnabled.productImages) {
          const mediaImages = product.media?.edges
            ?.filter((edge: any) => edge.node.id && edge.node.image?.url)
            .map((edge: any) => edge.node) || [];
          if (mediaImages.length > 0) {
            await db.productImage.deleteMany({ where: { productId: product.id } });
            await db.productImage.createMany({
              data: mediaImages.map((media: any, index: number) => ({
                productId: product.id, url: media.image.url,
                altText: media.alt || null, mediaId: media.id, position: index,
              })),
            });
          }
        }
      }
    }

    // Remove deleted products
    const removedIds = [...localProductIds].filter(id => !shopifyProductIds.has(id));
    if (removedIds.length > 0) {
      logger.info(`[PRODUCTS-LOADER] Removing ${removedIds.length} deleted product(s) from DB`);
      await db.productImage.deleteMany({ where: { productId: { in: removedIds } } });
      await db.product.deleteMany({ where: { shop: session.shop, id: { in: removedIds } } });
      await db.contentTranslation.deleteMany({
        where: { resourceType: 'Product', resourceId: { in: removedIds } },
      });
    }

    // 3. Fetch products from DATABASE
    const [initialDbProducts, aiSettings] = await Promise.all([
      db.product.findMany({
        where: {
          shop: session.shop,
        },
        include: {
          images: planLimits.cacheEnabled.productImages ? {
            include: {
              altTextTranslations: true,
            },
            orderBy: {
              position: 'asc', // CRITICAL: Must match order used in save action
            },
          } : false, // Don't load images if not cached in free plan
          // NOTE: Options excluded for now
        },
        orderBy: {
          title: "asc",
        },
      }),
      loadAISettingsForValidation(db, session.shop),
    ]);

    logger.debug("[PRODUCTS-LOADER] Loaded products from database", { context: "Products", count: initialDbProducts.length });

    // Log sample of productTypes to debug NULL issue
    const productsWithNullType = initialDbProducts.filter(p => p.productType === null || p.productType === undefined);
    if (productsWithNullType.length > 0) {
      logger.warn("[PRODUCTS-LOADER] ⚠️ Products with NULL productType found in DB:", {
        context: "Products",
        count: productsWithNullType.length,
        examples: productsWithNullType.slice(0, 3).map(p => ({
          id: p.id,
          title: p.title,
          productType: p.productType,
          lastSyncedAt: p.lastSyncedAt,
        })),
      });
    }

    // 3. Fetch translations only for products that belong to this shop
    const productIds = initialDbProducts.map(p => p.id);
    const allTranslations = productIds.length > 0
      ? await db.contentTranslation.findMany({
          where: {
            resourceType: 'Product',
            resourceId: { in: productIds }
          }
        })
      : [];

    logger.debug("[PRODUCTS-LOADER] Loaded translations from database", {
      context: "Products",
      totalTranslations: allTranslations.length,
      uniqueProducts: new Set(allTranslations.map(t => t.resourceId)).size,
    });

    // Use initialDbProducts directly - sync is now done via separate API call
    const dbProducts = initialDbProducts;

    // Group translations by resourceId (unified pattern)
    const translationsByResource = allTranslations.reduce((acc: Record<string, any[]>, trans) => {
      if (!acc[trans.resourceId]) {
        acc[trans.resourceId] = [];
      }
      acc[trans.resourceId].push(trans);
      return acc;
    }, {});

    // Log products WITHOUT translations
    const productsWithoutTranslations = dbProducts.filter(p => !translationsByResource[p.id] || translationsByResource[p.id].length === 0);
    if (productsWithoutTranslations.length > 0) {
      logger.warn("[PRODUCTS-LOADER] ⚠️ Products without translations found:", {
        context: "Products",
        count: productsWithoutTranslations.length,
        examples: productsWithoutTranslations.slice(0, 3).map(p => ({
          id: p.id,
          title: p.title,
          productType: p.productType,
          lastSyncedAt: p.lastSyncedAt,
        })),
      });
    }

    // 3. Transform to frontend format (unified pattern)
    const products = dbProducts.map((p) => ({
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
      images: p.images ? p.images.map((img: any) => ({
        url: img.url,
        altText: img.altText,
        altTextTranslations: img.altTextTranslations ? img.altTextTranslations.map((t: any) => ({
          locale: t.locale,
          altText: t.altText,
        })) : [],
      })) : [],
      seo: {
        title: p.seoTitle || "",
        description: p.seoDescription || "",
      },
      // IMPORTANT: Translations loaded from ContentTranslation table (unified)
      translations: translationsByResource[p.id] || [],
    }));

    logger.debug("[PRODUCTS-LOADER] Total translations loaded", { context: "Products", count: products.reduce((sum, p) => sum + p.translations.length, 0) });

    // Debug: Log a sample product to see the full data structure
    if (products.length > 0) {
      const sampleProduct = products[0];
      logger.debug("[PRODUCTS-LOADER] Sample product data:", {
        context: "Products",
        id: sampleProduct.id,
        title: sampleProduct.title,
        productType: sampleProduct.productType === "" ? "EMPTY_STRING" : sampleProduct.productType,
        productTypeFromDB: dbProducts[0].productType === null ? "NULL_IN_DB" : dbProducts[0].productType,
        translationCount: sampleProduct.translations.length,
        hasImages: sampleProduct.images.length > 0,
      });
    }

    // Log products with null alt-texts to debug clearing issue
    const productsWithNullAlt = products.filter((p: any) =>
      p.images?.some((img: any) => img.altText === null)
    );
    if (productsWithNullAlt.length > 0) {
      logger.debug("[LOADER] Products with null alt-texts found", { context: "Products", count: productsWithNullAlt.length });
    } else {
      logger.debug("[LOADER] No products with null alt-texts found", { context: "Products" });
    }

    return json({
      products,
      shop: session.shop,
      shopLocales,
      primaryLocale,
      error: null,
      plan,
      maxProducts: planLimits.maxProducts,
      productCount: dbProducts.length,
      aiSettings,
    });
  } catch (error: any) {
    logger.error("[PRODUCTS-LOADER] Error", { context: "Products", error: error.message, stack: error.stack });
    return json(
      {
        products: [],
        shop: session.shop,
        shopLocales: [],
        primaryLocale: "en",
        error: error.message,
        plan: "basic",
        maxProducts: 100,
        productCount: 0,
        aiSettings: null,
      },
      { status: 500 }
    );
  }
};

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
  const { products, shopLocales, primaryLocale, error, aiSettings, plan, maxProducts } = useLoaderData<typeof loader>();
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

  // Get selected product AFTER editor is initialized
  const selectedProductId = editor.state.selectedItemId;
  const selectedProduct = editor.selectedItem;

  // ============================================================================
  // RESTORE SELECTION AFTER RELOAD
  // If user clicked reload button, restore the previously selected product
  // ============================================================================

  useEffect(() => {
    // Wait for products to load and editor to be ready
    if (!isMountedRef.current || !products.length || !editor.handlers || typeof editor.handlers.handleItemSelect !== 'function') {
      return;
    }

    // Check URL for selected parameter
    const urlParams = new URLSearchParams(window.location.search);
    const selectedFromUrl = urlParams.get('selected');

    if (selectedFromUrl) {
      // Find the product in the list
      const productExists = products.find((p: any) => p.id === selectedFromUrl);

      if (productExists) {
        // Restore selection via editor
        try {
          editor.handlers.handleItemSelect(selectedFromUrl);
        } catch (error) {
          // Selection restoration failed - non-critical
        }

        // Clean up URL parameter
        urlParams.delete('selected');
        urlParams.delete('_t');
        const newUrl = `${window.location.pathname}${urlParams.toString() ? '?' + urlParams.toString() : ''}`;
        window.history.replaceState({}, '', newUrl);
      }
    } else {
      // Fallback: Check localStorage
      try {
        const stored = localStorage.getItem('lastSelectedResource');
        if (stored) {
          const parsed = JSON.parse(stored);

          // Only restore if it's recent (within last 10 seconds)
          if (Date.now() - parsed.timestamp < 10000) {
            const productExists = products.find((p: any) => p.id === parsed.id);
            if (productExists) {
              try {
                editor.handlers.handleItemSelect(parsed.id);
              } catch (error) {
                // Selection restoration failed - non-critical
              }
            }
          }

          // Clean up localStorage
          localStorage.removeItem('lastSelectedResource');
        }
      } catch (e) {
        // Failed to restore from localStorage - non-critical
      }
    }
  }, [products, editor.handlers]); // Run when products or editor changes

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
        hasImages: products.some(p => p?.images && p.images.length > 0),
      });
    }
  }, [isInitialLoad, products]);

  useEffect(() => {
    // DEBUG MODE: Skip auto-sync if skipShopifySync is enabled
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('skipShopifySync') === 'true') {
      return;
    }

    // Skip if no product selected or already loading or component unmounted
    if (!selectedProductId || !selectedProduct || isLoadingTranslations || !isMountedRef.current) return;

    // Skip if we've already synced this product
    if (syncedProductsRef.current.has(selectedProductId)) return;

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
          revalidator.revalidate();
        }
      }
    }
  }, [isLoadingTranslations, translationSyncFetcher.state, translationSyncFetcher.data, revalidator, selectedProduct]);

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
  }, [isSyncing, syncFetcher, showInfoBox, setGlobalLoading, t]);

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
      showInfoBox(error, "critical", t.common?.error || "Error");
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
          editor={editor}
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
        />
      </div>
    </div>
  );
}
