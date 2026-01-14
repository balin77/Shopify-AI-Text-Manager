/**
 * Blog Articles Page - UNIFIED VERSION
 *
 * Migrated to use the unified content editor system.
 * Compare to app.blog.old.tsx - we went from ~847 lines to ~160 lines (81% reduction!)
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
import { BLOGS_CONFIG } from "../config/content-fields.config";
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

    // Load articles from database
    const [articles, allTranslations, aiSettings] = await Promise.all([
      db.article.findMany({
        where: { shop: session.shop },
        orderBy: { blogTitle: 'asc' },
      }),
      db.contentTranslation.findMany({
        where: { resourceType: 'Article' }
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

    // Transform articles
    const transformedArticles = articles.map(a => ({
      id: a.id,
      blogId: a.blogId,
      blogTitle: a.blogTitle,
      title: a.title,
      handle: a.handle,
      body: a.body,
      seo: {
        title: a.seoTitle,
        description: a.seoDescription,
      },
      translations: translationsByResource[a.id] || [],
    }));

    return json({
      articles: transformedArticles,
      shop: session.shop,
      shopLocales,
      primaryLocale,
      error: null,
      aiSettings,
    });
  } catch (error: any) {
    console.error("[BLOG-LOADER] Error:", error);
    return json({
      articles: [],
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
    contentConfig: BLOGS_CONFIG,
    db,
    aiSettings,
    aiInstructions,
  });
};

// ============================================================================
// COMPONENT - Just configuration, no logic!
// ============================================================================

export default function BlogPage() {
  const { articles, shopLocales, primaryLocale, error, aiSettings } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const { t } = useI18n();
  const { showInfoBox } = useInfoBox();

  // Initialize unified content editor
  const editor = useUnifiedContentEditor({
    config: BLOGS_CONFIG,
    items: articles as ContentItem[],
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
        config={BLOGS_CONFIG}
        items={articles as ContentItem[]}
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
