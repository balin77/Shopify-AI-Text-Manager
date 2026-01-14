/**
 * Collections Page - UNIFIED VERSION
 *
 * Migrated to use the unified content editor system.
 * Compare to app.collections.old.tsx - we went from ~990 lines to ~130 lines (87% reduction!)
 */

import { json, type LoaderFunctionArgs, type ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import { authenticate } from "../shopify.server";
import { MainNavigation } from "../components/MainNavigation";
import { ContentTypeNavigation } from "../components/ContentTypeNavigation";
import { UnifiedContentEditor } from "../components/UnifiedContentEditor";
import { ApiKeyWarningBanner } from "../components/ApiKeyWarningBanner";
import { useUnifiedContentEditor } from "../hooks/useUnifiedContentEditor";
import { handleUnifiedContentActions } from "../actions/unified-content.actions";
import { COLLECTIONS_CONFIG } from "../config/content-fields.config";
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

    // Load shopLocales
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

    // Load collections from database
    const [collections, allTranslations, aiSettings] = await Promise.all([
      db.collection.findMany({
        where: { shop: session.shop },
        orderBy: { title: 'asc' },
      }),
      db.contentTranslation.findMany({
        where: { resourceType: 'Collection' }
      }),
      loadAISettingsForValidation(db, session.shop),
    ]);

    // Group translations by resourceId
    const translationsByResource = allTranslations.reduce((acc: Record<string, any[]>, trans) => {
      if (!acc[trans.resourceId]) {
        acc[trans.resourceId] = [];
      }
      acc[trans.resourceId].push(trans);
      return acc;
    }, {});

    // Transform collections
    const transformedCollections = collections.map(c => ({
      id: c.id,
      title: c.title,
      handle: c.handle,
      descriptionHtml: c.descriptionHtml,
      seo: {
        title: c.seoTitle,
        description: c.seoDescription,
      },
      translations: translationsByResource[c.id] || [],
    }));

    return json({
      collections: transformedCollections,
      shop: session.shop,
      shopLocales,
      primaryLocale,
      error: null,
      aiSettings,
    });
  } catch (error: any) {
    console.error("[COLLECTIONS-LOADER] Error:", error);
    return json({
      collections: [],
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
    contentConfig: COLLECTIONS_CONFIG,
    db,
    aiSettings,
    aiInstructions,
  });
};

// ============================================================================
// COMPONENT - Just configuration, no logic!
// ============================================================================

export default function CollectionsPage() {
  const { collections, shopLocales, primaryLocale, error, aiSettings } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const { t } = useI18n();
  const { showInfoBox } = useInfoBox();

  // Initialize unified content editor
  const editor = useUnifiedContentEditor({
    config: COLLECTIONS_CONFIG,
    items: collections as ContentItem[],
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
      <ApiKeyWarningBanner aiSettings={aiSettings} t={t} />
      <UnifiedContentEditor
        config={COLLECTIONS_CONFIG}
        items={collections as ContentItem[]}
        shopLocales={shopLocales}
        primaryLocale={primaryLocale}
        editor={editor}
        fetcherState={fetcher.state}
        fetcherFormData={fetcher.formData}
        t={t}
      />
    </>
  );
}
