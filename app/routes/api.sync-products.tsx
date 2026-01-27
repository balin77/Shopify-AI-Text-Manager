import { json } from "@remix-run/node";
import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { getPlanLimits } from "../utils/planUtils";

/**
 * API Route: Fast Product Sync (Bulk)
 *
 * Synchronizes all products from Shopify to local database using FAST bulk loading.
 * This method fetches all products in a single GraphQL request WITHOUT translations.
 * Translations can be loaded later on-demand when editing products.
 *
 * Usage: POST /api/sync-products
 *
 * Optional query params:
 * - force=true: Delete all existing products and re-sync from scratch
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  console.log("🚀 [SYNC-PRODUCTS] Starting FAST bulk product sync...");

  try {
    const { admin, session } = await authenticate.admin(request);
    const shop = session.shop;

    const url = new URL(request.url);
    const force = url.searchParams.get("force") === "true";

    console.log(`[SYNC-PRODUCTS] Shop: ${shop}`);
    console.log(`[SYNC-PRODUCTS] Force re-sync: ${force}`);

    // Get settings for plan limits
    const settings = await db.aISettings.findUnique({
      where: { shop },
    });

    const plan = (settings?.subscriptionPlan || "basic") as "free" | "basic" | "pro" | "max";
    const planLimits = getPlanLimits(plan);

    console.log(`[SYNC-PRODUCTS] Plan: ${plan}, Max products: ${planLimits.maxProducts}`);

    // Check if products already exist (skip if not force)
    if (!force) {
      const existingCount = await db.product.count({
        where: { shop },
      });

      if (existingCount > 0) {
        console.log(`[SYNC-PRODUCTS] Found ${existingCount} existing products, skipping sync`);
        return json({
          success: true,
          message: `Already synced ${existingCount} products. Use ?force=true to re-sync.`,
          synced: 0,
          existing: existingCount,
        });
      }
    }

    // If force, delete all existing products first
    if (force) {
      console.log("[SYNC-PRODUCTS] Force mode: Deleting all existing products...");

      // Get product IDs first for cascade deletes
      const existingProducts = await db.product.findMany({
        where: { shop },
        select: { id: true },
      });

      const productIds = existingProducts.map(p => p.id);

      if (productIds.length > 0) {
        // Delete in transaction for consistency
        await db.$transaction([
          db.contentTranslation.deleteMany({
            where: { resourceId: { in: productIds }, resourceType: "Product" },
          }),
          db.productImage.deleteMany({
            where: { productId: { in: productIds } },
          }),
          db.productOption.deleteMany({
            where: { productId: { in: productIds } },
          }),
          db.productMetafield.deleteMany({
            where: { productId: { in: productIds } },
          }),
          db.product.deleteMany({
            where: { shop },
          }),
        ]);

        console.log(`[SYNC-PRODUCTS] Deleted ${productIds.length} existing products`);
      }
    }

    // FAST BULK FETCH: Get all products in batches of 250 (GraphQL limit)
    const maxToFetch = planLimits.maxProducts === Infinity ? 10000 : planLimits.maxProducts;
    let allProducts: any[] = [];
    let hasNextPage = true;
    let cursor: string | null = null;

    console.log(`[SYNC-PRODUCTS] Fetching up to ${maxToFetch} products from Shopify...`);

    while (hasNextPage && allProducts.length < maxToFetch) {
      const batchSize = Math.min(250, maxToFetch - allProducts.length);

      const response: Response = await admin.graphql(
        `#graphql
          query getProductsBulk($first: Int!, $after: String) {
            products(first: $first, after: $after) {
              pageInfo {
                hasNextPage
                endCursor
              }
              edges {
                node {
                  id
                  title
                  descriptionHtml
                  handle
                  status
                  updatedAt
                  seo {
                    title
                    description
                  }
                  featuredImage {
                    url
                    altText
                  }
                  media(first: 250) {
                    edges {
                      node {
                        ... on MediaImage {
                          id
                          alt
                          image {
                            url
                          }
                        }
                      }
                    }
                  }
                  options {
                    id
                    name
                    position
                    values
                  }
                  metafields(first: 50) {
                    edges {
                      node {
                        id
                        namespace
                        key
                        value
                        type
                      }
                    }
                  }
                }
              }
            }
          }`,
        { variables: { first: batchSize, after: cursor } }
      );

      const data: any = await response.json();

      if (data.errors) {
        console.error("[SYNC-PRODUCTS] GraphQL error:", data.errors);
        throw new Error(data.errors[0]?.message || "GraphQL error");
      }

      const pageInfo: any = data.data?.products?.pageInfo;
      const products = data.data?.products?.edges?.map((e: any) => e.node) || [];

      allProducts = [...allProducts, ...products];
      hasNextPage = pageInfo?.hasNextPage || false;
      cursor = pageInfo?.endCursor || null;

      console.log(`[SYNC-PRODUCTS] Fetched batch: ${products.length} products (total: ${allProducts.length})`);

      if (hasNextPage && allProducts.length < maxToFetch) {
        console.log(`[SYNC-PRODUCTS] Fetching next page...`);
      }
    }

    console.log(`[SYNC-PRODUCTS] Total products fetched: ${allProducts.length}`);

    if (allProducts.length === 0) {
      return json({
        success: true,
        message: "No products found in shop",
        synced: 0,
      });
    }

    // FAST SAVE: Bulk upsert all products
    let synced = 0;
    let failed = 0;
    const errors: string[] = [];

    console.log(`[SYNC-PRODUCTS] Saving ${allProducts.length} products to database...`);

    for (const product of allProducts) {
      try {
        // Use transaction for each product to ensure consistency
        await db.$transaction(async (tx) => {
          // Upsert product
          await tx.product.upsert({
            where: {
              shop_id: { shop, id: product.id },
            },
            create: {
              id: product.id,
              shop,
              title: product.title,
              descriptionHtml: product.descriptionHtml || "",
              handle: product.handle,
              status: product.status,
              seoTitle: product.seo?.title || null,
              seoDescription: product.seo?.description || null,
              featuredImageUrl: product.featuredImage?.url || null,
              featuredImageAlt: product.featuredImage?.altText || null,
              shopifyUpdatedAt: new Date(product.updatedAt),
              lastSyncedAt: new Date(),
            },
            update: {
              title: product.title,
              descriptionHtml: product.descriptionHtml || "",
              handle: product.handle,
              status: product.status,
              seoTitle: product.seo?.title || null,
              seoDescription: product.seo?.description || null,
              featuredImageUrl: product.featuredImage?.url || null,
              featuredImageAlt: product.featuredImage?.altText || null,
              shopifyUpdatedAt: new Date(product.updatedAt),
              lastSyncedAt: new Date(),
            },
          });

          // Save images if plan allows
          if (planLimits.cacheEnabled.productImages) {
            const mediaImages = product.media?.edges
              ?.filter((edge: any) => edge.node.id && edge.node.image?.url)
              .map((edge: any) => edge.node) || [];

            if (mediaImages.length > 0) {
              // Delete existing images first
              await tx.productImage.deleteMany({ where: { productId: product.id } });

              // Create new images
              await tx.productImage.createMany({
                data: mediaImages.map((media: any, index: number) => ({
                  productId: product.id,
                  url: media.image.url,
                  altText: media.alt || null,
                  mediaId: media.id,
                  position: index,
                })),
              });
            }
          }

          // Save options
          if (product.options && product.options.length > 0) {
            await tx.productOption.deleteMany({ where: { productId: product.id } });
            await tx.productOption.createMany({
              data: product.options.map((opt: any) => ({
                id: opt.id,
                productId: product.id,
                name: opt.name,
                position: opt.position,
                values: JSON.stringify(opt.values),
              })),
            });
          }

          // Save metafields
          const metafields = product.metafields?.edges?.map((edge: any) => edge.node) || [];
          if (metafields.length > 0) {
            await tx.productMetafield.deleteMany({ where: { productId: product.id } });
            await tx.productMetafield.createMany({
              data: metafields.map((mf: any) => ({
                id: mf.id,
                productId: product.id,
                namespace: mf.namespace,
                key: mf.key,
                value: mf.value,
                type: mf.type,
              })),
            });
          }
        });

        synced++;

        // Log progress every 50 products
        if (synced % 50 === 0) {
          console.log(`[SYNC-PRODUCTS] Progress: ${synced}/${allProducts.length} products saved`);
        }
      } catch (err: any) {
        console.error(`[SYNC-PRODUCTS] Failed to save product ${product.id}:`, err.message);
        failed++;
        errors.push(`${product.id}: ${err.message}`);
      }
    }

    console.log(`✅ [SYNC-PRODUCTS] Sync complete! Synced: ${synced}, Failed: ${failed}`);

    return json({
      success: true,
      message: `Synced ${synced} products${failed > 0 ? ` (${failed} failed)` : ""}`,
      synced,
      failed,
      errors: errors.slice(0, 10), // Only return first 10 errors
    });
  } catch (error: any) {
    console.error("❌ [SYNC-PRODUCTS] Error:", error);
    return json(
      {
        success: false,
        error: error.message,
      },
      { status: 500 }
    );
  }
};
