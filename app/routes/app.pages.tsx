/**
 * Pages Page - UNIFIED VERSION
 *
 * Migrated to use the unified content editor system.
 * Compare to app.pages.old.tsx - we went from ~734 lines to ~150 lines (80% reduction!)
 */

import { json, type LoaderFunctionArgs, type ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import { authenticate } from "../shopify.server";
import { MainNavigation } from "../components/MainNavigation";
import { ContentTypeNavigation } from "../components/ContentTypeNavigation";
import { UnifiedContentEditor } from "../components/UnifiedContentEditor";
import { useUnifiedContentEditor } from "../hooks/useUnifiedContentEditor";
import { handleUnifiedContentActions } from "../actions/unified-content.actions";
import { PAGES_CONFIG } from "../config/content-fields.config";
import { useI18n } from "../contexts/I18nContext";
import { useInfoBox } from "../contexts/InfoBoxContext";
import { useEffect } from "react";
import type { ContentItem } from "../types/content-editor.types";

// ============================================================================
// LOADER - Load data from database
// ============================================================================

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  try {
    const { db } = await import("../db.server");
    const { loadAISettingsForValidation } = await import("../utils/loader-helpers");

    // Load shopLocales and pages from Shopify in parallel
    const [localesResponse, pagesResponse, allTranslations, aiSettings] = await Promise.all([
      admin.graphql(
        `#graphql
          query getShopLocales {
            shopLocales {
              locale
              name
              primary
              published
            }
          }`
      ),
      // Load pages directly from Shopify (not from DB)
      // This reduces database storage for multi-tenant SaaS
      admin.graphql(
        `#graphql
          query getPages {
            pages(first: 250) {
              edges {
                node {
                  id
                  title
                  handle
                  body
                }
              }
            }
          }`
      ),
      // Still load translations from DB (needed for performance)
      db.contentTranslation.findMany({
        where: { resourceType: 'Page' }
      }),
      loadAISettingsForValidation(db, session.shop),
    ]);

    const localesData = await localesResponse.json();
    const shopLocales = localesData.data?.shopLocales || [];
    const primaryLocale = shopLocales.find((l: any) => l.primary)?.locale || "de";

    const pagesData = await pagesResponse.json();
    const pages = pagesData.data?.pages?.edges?.map((e: any) => e.node) || [];

    // Group translations by resourceId
    const translationsByResource = allTranslations.reduce((acc: Record<string, any[]>, trans) => {
      if (!acc[trans.resourceId]) {
        acc[trans.resourceId] = [];
      }
      acc[trans.resourceId].push(trans);
      return acc;
    }, {});

    // Transform pages (data from Shopify, translations from DB)
    const transformedPages = pages.map((p: any) => ({
      id: p.id,
      title: p.title,
      handle: p.handle,
      body: p.body,
      translations: translationsByResource[p.id] || [],
    }));

    return json({
      pages: transformedPages,
      shop: session.shop,
      shopLocales,
      primaryLocale,
      error: null,
      aiSettings,
    });
  } catch (error: any) {
    console.error("[PAGES-LOADER] Error:", error);
    return json({
      pages: [],
      shop: session.shop,
      shopLocales: [],
      primaryLocale: "de",
      error: error.message,
      aiSettings: null,
    }, { status: 500 });
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

  // Use unified action handler
  return handleUnifiedContentActions({
    admin,
    session,
    formData,
    contentConfig: PAGES_CONFIG,
    db,
    aiSettings,
    aiInstructions,
  });
};

// ============================================================================
// COMPONENT - Just configuration, no logic!
// ============================================================================

export default function PagesPage() {
  const { pages, shopLocales, primaryLocale, error, aiSettings } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const { t } = useI18n();
  const { showInfoBox } = useInfoBox();

  // Initialize unified content editor
  const editor = useUnifiedContentEditor({
    config: PAGES_CONFIG,
    items: pages as ContentItem[],
    shopLocales,
    primaryLocale,
    fetcher,
    showInfoBox,
    t,
  });

  // Show loader error
  useEffect(() => {
    if (error) {
      showInfoBox(error, "critical", t.content?.error || "Error");
    }
  }, [error, showInfoBox, t]);

  return (
    <>
      <MainNavigation />
      <ContentTypeNavigation />
      <UnifiedContentEditor
        config={PAGES_CONFIG}
        items={pages}
        shopLocales={shopLocales}
        primaryLocale={primaryLocale}
        editor={editor}
        fetcherState={fetcher.state}
        fetcherFormData={fetcher.formData}
        t={t}
        hideItemListImages={true}
        hideItemListStatusBars={true}
      />
    </>
  );
}
