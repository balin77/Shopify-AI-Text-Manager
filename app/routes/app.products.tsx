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
import { useLoaderData, useFetcher } from "@remix-run/react";
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
import { useEffect, useState } from "react";
import type { ContentItem } from "../types/content-editor.types";

// ============================================================================
// LOADER - Load data from database
// ============================================================================

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  console.log("[PRODUCTS-LOADER] Loading products from DATABASE for shop:", session.shop);

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

    console.log("[PRODUCTS-LOADER] Current plan:", plan);
    console.log("[PRODUCTS-LOADER] Max products:", planLimits.maxProducts);

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

    console.log("[PRODUCTS-LOADER] Primary locale:", primaryLocale);
    console.log("[PRODUCTS-LOADER] Available locales:", shopLocales.length);

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

    console.log("[PRODUCTS-LOADER] Loaded", initialDbProducts.length, "products from database");

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

    console.log("[PRODUCTS-LOADER] Total translations loaded:", products.reduce((sum, p) => sum + p.translations.length, 0));

    // Log products with null alt-texts to debug clearing issue
    const productsWithNullAlt = products.filter((p: any) =>
      p.images?.some((img: any) => img.altText === null)
    );
    if (productsWithNullAlt.length > 0) {
      console.log(`🟠🟠🟠 [LOADER] Products with null alt-texts: ${productsWithNullAlt.length} 🟠🟠🟠`);
      productsWithNullAlt.slice(0, 3).forEach((p: any) => {
        console.log(`🟠 [LOADER] Product "${p.title}" (${p.id}):`);
        p.images?.forEach((img: any, i: number) => {
          console.log(`🟠   Image ${i}: altText="${img.altText}" (isNull: ${img.altText === null})`);
        });
      });
    } else {
      console.log(`🟠 [LOADER] No products with null alt-texts found`);
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
    console.error("[PRODUCTS-LOADER] Error:", error);
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
  const { t } = useI18n();
  const { showInfoBox } = useInfoBox();
  const { getNextPlanUpgrade } = usePlan();
  const { setContentNavHeight } = useNavigationHeight();
  const [isSyncing, setIsSyncing] = useState(false);

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

      // Show loading message via InfoBox
      showInfoBox(t.products.syncInProgress, "info");

      // Trigger the sync API
      syncFetcher.submit(
        {},
        { method: "POST", action: "/api/sync-missing-products" }
      );
    }
  }, [isSyncing, syncFetcher, showInfoBox, t]);

  // Handle sync completion
  useEffect(() => {
    if (isSyncing && syncFetcher.state === "idle" && syncFetcher.data) {
      console.log("✅ [ProductsPage] Sync complete:", syncFetcher.data);

      if (syncFetcher.data.success && syncFetcher.data.synced > 0) {
        const message = t.products.syncComplete.replace("{count}", String(syncFetcher.data.synced));
        showInfoBox(message, "success", t.products.syncCompleteTitle);
        // Reload to show new products
        window.location.reload();
      } else {
        setIsSyncing(false);
      }
    }
  }, [isSyncing, syncFetcher.state, syncFetcher.data, showInfoBox, t]);

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
