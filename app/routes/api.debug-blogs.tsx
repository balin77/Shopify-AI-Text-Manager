import { json } from "@remix-run/node";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";

/**
 * DEBUG: Check what Shopify returns for blogs/articles
 *
 * Access via: /api/debug-blogs
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

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

    // 3. Check local database
    const localArticles = await db.article.findMany({
      where: { shop: session.shop },
    });

    return json({
      shop: session.shop,
      plan: aiSettings?.subscriptionPlan || "not found",
      shopifyBlogs: blogsData.data?.blogs?.edges || [],
      shopifyErrors: blogsData.errors || null,
      localArticlesCount: localArticles.length,
      localArticles: localArticles.map(a => ({ id: a.id, title: a.title })),
    });
  } catch (error: any) {
    return json({
      error: error.message,
      stack: error.stack,
    }, { status: 500 });
  }
};
