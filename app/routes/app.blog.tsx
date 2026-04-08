/**
 * Blog Articles Page - UNIFIED VERSION
 *
 * Migrated to use the unified content editor system.
 * Compare to app.blog.old.tsx - we went from ~847 lines to ~160 lines (81% reduction!)
 */

import { type ActionFunctionArgs } from "@remix-run/node";
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
import { PlanAccessGate } from "../components/PlanAccessGate";
import { useEffect } from "react";
import type { ContentItem } from "../types/content-editor.types";
import { measurePageLoad } from "~/utils/performance.client";
import { createContentLoader, incrementalSync } from "~/utils/loader-factory.server";

// ============================================================================
// LOADER - Incremental sync + load from database
// ============================================================================

export const loader = createContentLoader({
  logPrefix: "BLOG",
  resourceType: ["Article", "Blog"],
  itemsKey: "articles",

  async loadData(ctx) {
    const { ContentSyncService } = await import("../services/content-sync.service");
    const syncService = new ContentSyncService(ctx.admin, ctx.session.shop);

    // Fetch blogs with their titles and article IDs from Shopify
    const blogsResponse = await ctx.admin.graphql(
      `#graphql
        query getBlogs {
          blogs(first: 250) {
            edges {
              node {
                id
                title
                handle
                seoTitle: metafield(namespace: "global", key: "title_tag") { value }
                seoDescription: metafield(namespace: "global", key: "description_tag") { value }
                articles(first: 250) {
                  edges { node { id } }
                }
              }
            }
          }
        }`,
    );
    const blogsData = await blogsResponse.json();

    interface BlogNode {
      id: string;
      title: string;
      handle: string;
      seoTitle?: { value: string } | null;
      seoDescription?: { value: string } | null;
      articles?: { edges: Array<{ node: { id: string } }> };
    }

    const blogs: BlogNode[] = blogsData.data?.blogs?.edges?.map(
      (e: { node: BlogNode }) => e.node
    ) || [];

    const shopifyIds = new Set<string>();
    for (const blog of blogs) {
      for (const edge of blog.articles?.edges || []) {
        shopifyIds.add(edge.node.id);
      }
    }

    // Sync missing + remove deleted
    await incrementalSync(ctx, {
      shopifyIds,
      dbModel: ctx.db.article,
      resourceType: "Article",
      logPrefix: "BLOG",
      syncFn: (id) => syncService.syncArticle(id),
    });

    // Load articles from database
    const articles = await ctx.db.article.findMany({
      where: { shop: ctx.session.shop },
      orderBy: { blogTitle: "asc" },
    });

    interface ArticleRow {
      id: string;
      blogId: string;
      blogTitle: string;
      title: string;
      handle: string;
      body: string | null;
      summary: string | null;
      imageUrl: string | null;
      imageAltText: string | null;
      seoTitle: string | null;
      seoDescription: string | null;
    }

    // Build Blog container items (appear as section headers in the list)
    const blogItems = blogs.map((blog) => ({
      id: blog.id,
      title: blog.title,
      handle: blog.handle,
      isBlogContainer: true as const,
      blogTitle: blog.title, // Used for category badge
      seo: {
        title: blog.seoTitle?.value ?? null,
        description: blog.seoDescription?.value ?? null,
      },
      translations: [],
      images: [],
    }));

    // Build Article items
    const articleItems = (articles as ArticleRow[]).map((a) => ({
      id: a.id,
      blogId: a.blogId,
      blogTitle: a.blogTitle,
      title: a.title,
      handle: a.handle,
      body: a.body,
      summary: a.summary,
      featuredImage: a.imageUrl
        ? { url: a.imageUrl, altText: a.imageAltText || "" }
        : undefined,
      images: [],
      seo: { title: a.seoTitle, description: a.seoDescription },
    }));

    // Combine: blog containers first, then articles (sorted by blog title)
    const allItems = [...blogItems, ...articleItems];

    return {
      items: allItems,
      ids: allItems.map((item) => item.id),
    };
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
    <PlanAccessGate contentType="articles">
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
            { field: "shopifyUpdatedAt", label: "Last Updated", type: "date" },
          ]}
        />
      </div>
    </div>
    </PlanAccessGate>
  );
}
