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
import { useLoaderData, useFetcher, useRevalidator } from "@remix-run/react";
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
import type { ContentItem } from "../types/content-editor.types";
import { logger } from "~/utils/logger.server";

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
    const plan = (settings?.subscriptionPlan || "basic") as "free" | "basic" | "pro" | "max";
    const planLimits = getPlanLimits(plan);

    logger.debug("[PRODUCTS-LOADER] Current plan and limits", { context: "Products", plan, maxProducts: planLimits.maxProducts });

    // 1. Fetch shop locales
    const localesResponse = await admin.graphql(
      `#graphql
        query getShopLocales {
          shopLocales {
            locale
            name
            primary
            published
          }
        }`
    );

    const localesData = await localesResponse.json();
    const shopLocales = localesData.data?.shopLocales || [];
    const primaryLocale = shopLocales.find((l: any) => l.primary)?.locale || "de";

    logger.debug("[PRODUCTS-LOADER] Locales loaded", { context: "Products", primaryLocale, availableLocales: shopLocales.length });

    // 2. Fetch products from DATABASE and translations
    const [initialDbProducts, allTranslations, aiSettings] = await Promise.all([
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
      db.contentTranslation.findMany({
        where: { resourceType: 'Product' }
      }),
      loadAISettingsForValidation(db, session.shop),
    ]);

    logger.debug("[PRODUCTS-LOADER] Loaded products from database", { context: "Products", count: initialDbProducts.length });

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

    // 3. Transform to frontend format (unified pattern)
    const products = dbProducts.map((p) => ({
      id: p.id,
      title: p.title,
      descriptionHtml: p.descriptionHtml || "",
      handle: p.handle,
      status: p.status,
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
        primaryLocale: "de",
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

  // Track which products we've already synced translations for (to avoid duplicate syncs)
  const syncedProductsRef = useRef<Set<string>>(new Set());

  // Initialize unified content editor
  const editor = useUnifiedContentEditor({
    config: PRODUCTS_CONFIG,
    items: products as ContentItem[],
    shopLocales,
    primaryLocale,
    fetcher,
    showInfoBox,
    t,
  });

  // ============================================================================
  // ON-DEMAND TRANSLATION LOADING
  // When a product is selected, check if it has translations. If not, load them.
  // ============================================================================

  const selectedProductId = editor.state.selectedItemId;
  const selectedProduct = editor.selectedItem;

  useEffect(() => {
    // Skip if no product selected or already loading
    if (!selectedProductId || !selectedProduct || isLoadingTranslations) return;

    // Skip if we've already synced this product
    if (syncedProductsRef.current.has(selectedProductId)) return;

    // Check if product has any translations
    const hasTranslations = selectedProduct.translations && selectedProduct.translations.length > 0;

    // If product has no translations, trigger sync
    if (!hasTranslations) {
      console.log(`🔄 [ON-DEMAND] Product "${selectedProduct.title}" has no translations, loading...`);
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
    if (isLoadingTranslations && translationSyncFetcher.state === "idle" && translationSyncFetcher.data) {
      console.log("✅ [ON-DEMAND] Translation sync complete:", translationSyncFetcher.data);
      setIsLoadingTranslations(false);

      if (translationSyncFetcher.data.success) {
        // Revalidate to fetch fresh data with translations
        if (revalidator.state === "idle") {
          console.log("🔄 [ON-DEMAND] Revalidating to load translations...");
          revalidator.revalidate();
        }
      }
    }
  }, [isLoadingTranslations, translationSyncFetcher.state, translationSyncFetcher.data, revalidator]);

  // Reset ContentNavigation height to 0 (since we don't have ContentTypeNavigation on Products page)
  useEffect(() => {
    setContentNavHeight(0);
  }, [setContentNavHeight]);

  // Check for sync parameter and trigger background sync
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.has("sync") && !isSyncing && syncFetcher.state === "idle") {
      console.log("🔄 [ProductsPage] Triggering background sync...");
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
    if (isSyncing && syncFetcher.state === "idle" && syncFetcher.data) {
      console.log("✅ [ProductsPage] Sync complete:", syncFetcher.data);

      // Hide loading spinner
      setGlobalLoading(false);

      if (syncFetcher.data.success && syncFetcher.data.synced > 0) {
        const message = t.products.syncComplete.replace("{count}", String(syncFetcher.data.synced));
        showInfoBox(message, "success", t.products.syncCompleteTitle);
        // Reload to show new products
        window.location.reload();
      } else {
        setIsSyncing(false);
      }
    }
  }, [isSyncing, syncFetcher.state, syncFetcher.data, showInfoBox, setGlobalLoading, t]);

  // Show loader error
  useEffect(() => {
    if (error) {
      showInfoBox(error, "critical", t.common?.error || "Error");
    }
  }, [error, showInfoBox, t]);

  return (
    <>
      <MainNavigation />
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
      />
    </>
  );
}
