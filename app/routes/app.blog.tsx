/**
 * Blog Articles Page - UNIFIED VERSION
 *
 * Migrated to use the unified content editor system.
 * Compare to app.blog.old.tsx - we went from ~847 lines to ~160 lines (81% reduction!)
 */

import { type ActionFunctionArgs } from "react-router";
import { useLoaderData, useFetcher, useRevalidator, useSearchParams } from "react-router";
import { authenticate } from "../shopify.server";
import { UnifiedContentEditor } from "../components/UnifiedContentEditor";
import { useUnifiedContentEditor } from "../hooks/useUnifiedContentEditor";
import { handleUnifiedContentActions } from "../actions/unified-content.actions";
import { BLOGS_CONFIG } from "../config/content-fields.config";
import { useI18n } from "../contexts/I18nContext";
import { useInfoBox } from "../contexts/InfoBoxContext";
import { PlanAccessGate } from "../components/PlanAccessGate";
import { useEffect, useRef } from "react";
import type { ContentItem } from "../types/content-editor.types";
import { measurePageLoad } from "~/utils/performance.client";
import { createContentLoader, incrementalSync } from "~/utils/loader-factory.server";
import type { FetcherData } from "~/types/content-editor.types";

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

    // Fetch blogs with their titles and article IDs from Shopify.
    //
    // `templateSuffix` is PLAN §Phase 3 — a blog container's one merchandising
    // attribute. Read LIVE, so unlike the cached types there is no "written by
    // an older sync" ambiguity: whatever comes back IS current.
    //
    // The prose stays out here on purpose: a `#` comment inside the document
    // travels to Shopify (see the GraphQL-comment gotcha in CLAUDE.md).
    const blogsResponse = await ctx.admin.graphql(
      `#graphql
        query getBlogs {
          blogs(first: 250) {
            edges {
              node {
                id
                title
                handle
                templateSuffix
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
      templateSuffix?: string | null;
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

    // Sync translations for articles that have none yet (one-time backfill).
    // Articles synced before translation support may be missing translations.
    if (articles.length > 0 && ctx.shopLocales.length > 1) {
      try {
        const articleIds = articles.map((a: { id: string }) => a.id);
        const existingTranslations = await ctx.db.contentTranslation.groupBy({
          by: ["resourceId"],
          where: { shop: ctx.session.shop, resourceType: "Article", resourceId: { in: articleIds } },
        });
        const idsWithTranslations = new Set(existingTranslations.map((g: { resourceId: string }) => g.resourceId));
        const idsWithoutTranslations = articleIds.filter((id: string) => !idsWithTranslations.has(id));
        if (idsWithoutTranslations.length > 0) {
          const { logger } = await import("../utils/logger.server");
          logger.info(`[BLOG-LOADER] Backfilling translations for ${idsWithoutTranslations.length} article(s)`);
          // Sync individually so one failure doesn't block others
          await Promise.allSettled(idsWithoutTranslations.map((id: string) => syncService.syncArticle(id)));
        }
      } catch {
        // Non-fatal: translations will be loaded on next reload
      }
    }

    // Sync translations for blog containers that have none yet.
    // Blog containers are not stored in a dedicated DB model, but their
    // translations are stored in contentTranslation with resourceType "Blog".
    if (blogs.length > 0 && ctx.shopLocales.length > 1) {
      try {
        const blogIds = blogs.map((b) => b.id);
        const existingBlogTranslations = await ctx.db.contentTranslation.groupBy({
          by: ["resourceId"],
          where: { shop: ctx.session.shop, resourceType: "Blog", resourceId: { in: blogIds } },
        });
        const blogIdsWithTranslations = new Set(existingBlogTranslations.map((g: { resourceId: string }) => g.resourceId));
        const blogIdsWithoutTranslations = blogIds.filter((id) => !blogIdsWithTranslations.has(id));
        if (blogIdsWithoutTranslations.length > 0) {
          const { logger } = await import("../utils/logger.server");
          const { fetchAllTranslations } = await import("../services/sync-utils");
          logger.info(`[BLOG-LOADER] Backfilling translations for ${blogIdsWithoutTranslations.length} blog container(s)`);
          const nonPrimaryLocales = ctx.shopLocales
            .filter((l) => !l.primary)
            .map((l) => ({ ...l, published: true }));
          await Promise.allSettled(blogIdsWithoutTranslations.map(async (blogId) => {
            const translations = await fetchAllTranslations(
              ctx.admin.graphql.bind(ctx.admin),
              blogId,
              nonPrimaryLocales,
              "Blog",
            );
            const valid = translations.filter((t) => t.value != null && t.value !== undefined);
            if (valid.length > 0) {
              await ctx.db.contentTranslation.createMany({
                data: valid.map((t) => ({
                  shop: ctx.session.shop,
                  resourceId: blogId,
                  resourceType: "Blog",
                  key: t.key,
                  value: t.value,
                  locale: t.locale,
                  digest: t.digest || null,
                })),
              });
            }
          }));
        }
      } catch {
        // Non-fatal: translations will be loaded on next reload
      }
    }

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
      // PLAN §2.2 attribute block. `attributesSyncedAt` is the discriminator —
      // without it the defaults below (null / [] / true) would be read as the
      // merchant's own data instead of "never fetched".
      attributesSyncedAt: Date | null;
      author: string | null;
      tags: string[];
      templateSuffix: string | null;
      isPublished: boolean;
    }

    // Build Blog container items (appear as section headers in the list)
    // NOTE: Do NOT set translations here — the loader factory attaches them
    // from the DB. Setting translations: [] would prevent that ([] is truthy).
    const blogItems = blogs.map((blog) => ({
      id: blog.id,
      title: blog.title,
      handle: blog.handle,
      isBlogContainer: true as const,
      blogTitle: blog.title, // Used for category badge
      // Type icon + filter metadata (mirrors the theme-domain loader): the list
      // holds two types — Blog containers and their articles.
      icon: "📓",
      iconTooltip: "Blog",
      type: "Blog",
      seo: {
        title: blog.seoTitle?.value ?? null,
        description: blog.seoDescription?.value ?? null,
      },
      images: [],
      // The query above just delivered it, so the editor may judge and edit it.
      // The stamp is what the attribute controls gate on — without it they read
      // "known" by default, which on the one type this data is live for would
      // be the only place the discriminator lied.
      attributesSyncedAt: new Date().toISOString(),
      templateSuffix: blog.templateSuffix ?? null,
    }));

    // Load article image alt-text translations from contentTranslation table
    const articleIds = (articles as ArticleRow[]).map((a: ArticleRow) => a.id);
    const articleImageAltTranslations = articleIds.length > 0
      ? await ctx.db.contentTranslation.findMany({
          where: {
            shop: ctx.session.shop,
            resourceId: { in: articleIds },
            resourceType: "Article",
            key: "image_alt_text",
          },
        })
      : [];

    const altTranslationsByArticle = new Map<string, Array<{ locale: string; altText: string }>>();
    for (const t of articleImageAltTranslations) {
      if (!altTranslationsByArticle.has(t.resourceId)) {
        altTranslationsByArticle.set(t.resourceId, []);
      }
      altTranslationsByArticle.get(t.resourceId)!.push({ locale: t.locale, altText: t.value });
    }

    // Build Article items
    const articleItems = (articles as ArticleRow[]).map((a) => ({
      id: a.id,
      blogId: a.blogId,
      blogTitle: a.blogTitle,
      title: a.title,
      handle: a.handle,
      icon: "📝",
      iconTooltip: "Blogeintrag",
      type: "Article",
      body: a.body,
      summary: a.summary,
      featuredImage: a.imageUrl
        ? {
            url: a.imageUrl,
            altText: a.imageAltText || "",
            altTextTranslations: altTranslationsByArticle.get(a.id) || [],
          }
        : undefined,
      images: [],
      seo: { title: a.seoTitle, description: a.seoDescription },
      // §2.2 attribute checklist (articles only — a Blog CONTAINER has no
      // attribute block and gets no tab).
      attributesSyncedAt: a.attributesSyncedAt ?? null,
      author: a.author ?? null,
      tags: Array.isArray(a.tags) ? a.tags : null,
      templateSuffix: a.templateSuffix ?? null,
      isPublished: a.isPublished,
      featuredImageUrl: a.imageUrl || null,
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
  const { articles, shopLocales, primaryLocale, markets, error, aiSettings } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<FetcherData>();
  const revalidator = useRevalidator();
  const { t } = useI18n();
  const { showInfoBox } = useInfoBox();

  // Deep-link from the SEO dashboard: ?select=<Shopify GID> preselects the item.
  const [searchParams] = useSearchParams();
  const initialItemId = searchParams.get("select") || undefined;
  // Locale of the deep link (the SEO dashboard passes the language it was
  // showing). Validated against the shop's locales inside the editor hook.
  const initialLocale = searchParams.get("locale") || undefined;

  // Content-Freshness deep-link (PLAN_SEO_SUITE_COMPLETION.md §5.3): the
  // "Mit AI überarbeiten" button on the Freshness panel links here with
  // ?select=<GID>&preset=refresh — a one-time hint pointing at the existing
  // "Generate with AI" action, not a new AI-instructions plumbing/template
  // system (the plan explicitly rules that out).
  const shownRefreshPresetRef = useRef(false);
  useEffect(() => {
    if (shownRefreshPresetRef.current) return;
    if (searchParams.get("preset") === "refresh" && initialItemId) {
      shownRefreshPresetRef.current = true;
      showInfoBox(t.seo.dashboard.freshnessPresetHint, "info");
    }
  }, [searchParams, initialItemId, showInfoBox, t]);

  // Initialize unified content editor
  const editor = useUnifiedContentEditor({
    config: BLOGS_CONFIG,
    items: articles as unknown as ContentItem[],
    shopLocales,
    primaryLocale,
    markets,
    fetcher,
    showInfoBox,
    t,
    initialItemId,
    initialLocale,
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
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
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
