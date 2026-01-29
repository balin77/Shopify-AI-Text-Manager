import { json } from "@remix-run/node";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { ContentSyncService } from "../services/content-sync.service";

/**
 * DEBUG: Check what Shopify returns for blogs/articles
 *
 * Access via: /api/debug-blogs
 * With sync: /api/debug-blogs?sync=true
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const shouldSync = url.searchParams.get("sync") === "true";

  try {
    // 1. Check AISettings for plan
    const aiSettings = await db.aISettings.findUnique({
      where: { shop: session.shop },
    });

    // 2. Query Shopify for blogs
    const blogsResponse = await admin.graphql(
      `#graphql
        query getBlogs {
          blogs(first: 250) {
            edges {
              node {
                id
                title
                handle
                articles(first: 250) {
                  edges {
                    node {
                      id
                      title
                      handle
                    }
                  }
                }
              }
            }
          }
        }`
    );

    const blogsData = await blogsResponse.json() as { data?: any; errors?: any };
    const blogs = blogsData.data?.blogs?.edges || [];

    // 3. Get first article ID for detailed test
    let articleTest: any = null;
    let syncResult: any = null;

    if (blogs.length > 0 && blogs[0].node.articles?.edges?.length > 0) {
      const firstArticleId = blogs[0].node.articles.edges[0].node.id;

      // Test fetching single article with the query used by syncArticle
      const articleResponse = await admin.graphql(
        `#graphql
          query getArticle($id: ID!) {
            article(id: $id) {
              id
              title
              handle
              body
              updatedAt
              blog {
                id
                title
              }
            }
          }`,
        { variables: { id: firstArticleId } }
      );

      const articleData = await articleResponse.json() as { data?: any; errors?: any };
      articleTest = {
        queryId: firstArticleId,
        result: articleData.data?.article || null,
        errors: articleData.errors || null,
      };

      // 4. Try sync if requested
      if (shouldSync && articleData.data?.article) {
        try {
          const syncService = new ContentSyncService(admin, session.shop);
          await syncService.syncArticle(firstArticleId);
          syncResult = { success: true, articleId: firstArticleId };
        } catch (syncError: any) {
          syncResult = { success: false, error: syncError.message };
        }
      }
    }

    // 5. Check local database
    const localArticles = await db.article.findMany({
      where: { shop: session.shop },
    });

    return json({
      shop: session.shop,
      plan: aiSettings?.subscriptionPlan || "not found",
      shopifyBlogsCount: blogs.length,
      shopifyBlogs: blogs,
      shopifyErrors: blogsData.errors || null,
      articleTest,
      syncResult,
      localArticlesCount: localArticles.length,
      localArticles: localArticles.map(a => ({ id: a.id, title: a.title })),
      hint: shouldSync ? null : "Add ?sync=true to URL to attempt sync",
    });
  } catch (error: any) {
    return json({
      error: error.message,
      stack: error.stack,
    }, { status: 500 });
  }
};
