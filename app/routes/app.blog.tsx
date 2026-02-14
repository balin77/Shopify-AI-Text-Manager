/**
 * Blog Articles Page - UNIFIED VERSION
 *
 * Migrated to use the unified content editor system.
 * Compare to app.blog.old.tsx - we went from ~847 lines to ~160 lines (81% reduction!)
 */

import { json, type LoaderFunctionArgs, type ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher, useRevalidator } from "@remix-run/react";
import { authenticate } from "../shopify.server";
import { MainNavigation } from "../components/MainNavigation";
import { ContentTypeNavigation } from "../components/ContentTypeNavigation";
import { UnifiedContentEditor } from "../components/UnifiedContentEditor";
import { useUnifiedContentEditor } from "../hooks/useUnifiedContentEditor";
import { handleUnifiedContentActions } from "../actions/unified-content.actions";
import { BLOGS_CONFIG } from "../config/content-fields.config";
import { useI18n } from "../contexts/I18nContext";
import { useInfoBox } from "../contexts/InfoBoxContext";
import { useEffect } from "react";
import type { ContentItem } from "../types/content-editor.types";
import { measurePageLoad } from "~/utils/performance.client";
import { logger } from "~/utils/logger.server";

// ============================================================================
// LOADER - Load data from database
// ============================================================================

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  try {
    const { db } = await import("../db.server");
    const { loadAISettingsForValidation } = await import("../utils/loader-helpers");
    const { getCachedShopLocales } = await import("../utils/shop-locales-cache.server");

    // Load shopLocales (with caching)
    const shopLocales = await getCachedShopLocales(admin, session.shop);
    const primaryLocale = shopLocales.find((l: any) => l.primary)?.locale || "en";

    // Incremental sync: fetch article IDs from Shopify, sync only missing ones
    const { ContentSyncService } = await import("../services/content-sync.service");
    const syncService = new ContentSyncService(admin, session.shop);

    const blogsResponse = await admin.graphql(
      `#graphql
        query getBlogs {
          blogs(first: 250) {
            edges {
              node {
                id
                articles(first: 250) {
                  edges {
                    node {
                      id
                    }
                  }
                }
              }
            }
          }
        }`
    );
    const blogsData = await blogsResponse.json();
    const blogs = blogsData.data?.blogs?.edges?.map((e: any) => e.node) || [];
    const shopifyArticleIds = new Set<string>();
    for (const blog of blogs) {
      for (const edge of blog.articles?.edges || []) {
        shopifyArticleIds.add(edge.node.id);
      }
    }

    // Compare with local DB
    const localArticles = await db.article.findMany({
      where: { shop: session.shop },
      select: { id: true },
    });
    const localArticleIds = new Set(localArticles.map(a => a.id));

    // Sync missing articles (in Shopify but not in DB)
    const missingIds = [...shopifyArticleIds].filter(id => !localArticleIds.has(id));
    if (missingIds.length > 0) {
      logger.info(`[BLOG-LOADER] Syncing ${missingIds.length} new article(s) from Shopify`);
      await Promise.all(missingIds.map(id => syncService.syncArticle(id)));
    }

    // Remove deleted articles (in DB but not in Shopify)
    const removedIds = [...localArticleIds].filter(id => !shopifyArticleIds.has(id));
    if (removedIds.length > 0) {
      logger.info(`[BLOG-LOADER] Removing ${removedIds.length} deleted article(s) from DB`);
      await db.article.deleteMany({
        where: { shop: session.shop, id: { in: removedIds } },
      });
      await db.contentTranslation.deleteMany({
        where: { resourceType: 'Article', resourceId: { in: removedIds } },
      });
    }

    // Load articles from database
    const [articles, aiSettings] = await Promise.all([
      db.article.findMany({
        where: { shop: session.shop },
        orderBy: { blogTitle: 'asc' },
      }),
      loadAISettingsForValidation(db, session.shop),
    ]);

    // Load translations only for this shop's articles
    const articleIds = articles.map(a => a.id);
    const allTranslations = articleIds.length > 0
      ? await db.contentTranslation.findMany({
          where: {
            resourceType: 'Article',
            resourceId: { in: articleIds }
          }
        })
      : [];

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
      summary: a.summary,
      featuredImage: a.imageUrl ? {
        url: a.imageUrl,
        altText: a.imageAltText || '',
      } : undefined,
      images: [], // Blogs only have featured image, no gallery
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
    logger.error("[BLOG-LOADER] Error", { error: error instanceof Error ? error.message : String(error) });
    return json({
      articles: [],
      shop: session.shop,
      shopLocales: [],
      primaryLocale: "en",
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
  const revalidator = useRevalidator();
  const { t } = useI18n();
  const { showInfoBox } = useInfoBox();

  // Initialize unified content editor
  const editor = useUnifiedContentEditor({
    config: BLOGS_CONFIG,
    items: articles as unknown as ContentItem[],
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

  // Measure page load performance
  useEffect(() => {
    measurePageLoad('BlogPage', {
      articleCount: articles.length,
    });
  }, [articles]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", overflow: "hidden" }}>
      <MainNavigation />
      <ContentTypeNavigation />
      <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
        <UnifiedContentEditor
          config={BLOGS_CONFIG}
          items={articles as unknown as ContentItem[]}
          shopLocales={shopLocales}
          primaryLocale={primaryLocale}
          editor={editor}
          fetcherState={fetcher.state}
          fetcherFormData={fetcher.formData}
          t={t}
          hideItemListImages={false}
          hideItemListStatusBars={true}
          showItemListCategoryBadge={true}
          revalidator={revalidator}
          sortOptions={[
            { field: "title", label: "Title" },
            { field: "shopifyUpdatedAt", label: "Last Updated" },
          ]}
        />
      </div>
    </div>
  );
}
