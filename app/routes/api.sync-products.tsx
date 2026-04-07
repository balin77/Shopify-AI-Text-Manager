import { json } from "@remix-run/node";
import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { db, upsertProductMetafields } from "../db.server";
import { getPlanLimits } from "../utils/planUtils";
import { logger } from "~/utils/logger.server";

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
  try {
    const { admin, session } = await authenticate.admin(request);
    const shop = session.shop;

    const url = new URL(request.url);
    const force = url.searchParams.get("force") === "true";

    // Get settings for plan limits
    const settings = await db.aISettings.findUnique({
      where: { shop },
    });

    const plan = (settings?.subscriptionPlan || "free") as "free" | "basic" | "pro" | "max";
    const planLimits = getPlanLimits(plan);

    // Check if products already exist (skip if not force)
    if (!force) {
      const existingCount = await db.product.count({
        where: { shop },
      });

      if (existingCount > 0) {
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

      }
    }

    // FAST BULK FETCH: Get all products in batches of 250 (GraphQL limit)
    const maxToFetch = planLimits.maxProducts === Infinity ? 10000 : planLimits.maxProducts;
    let allProducts: any[] = [];
    let hasNextPage = true;
    let cursor: string | null = null;

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
                  productType
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
                    linkedMetafield {
                      namespace
                      key
                    }
                    optionValues {
                      id
                      name
                      linkedMetafieldValue
                    }
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
        logger.error("[SYNC-PRODUCTS] GraphQL error", { context: "SyncProducts", errors: data.errors });
        throw new Error(data.errors[0]?.message || "GraphQL error");
      }

      if (!data.data?.products) {
        logger.error("[SYNC-PRODUCTS] Unexpected GraphQL response: missing products data", { context: "SyncProducts" });
        throw new Error("Unexpected Shopify response: no products data returned");
      }

      const pageInfo: any = data.data?.products?.pageInfo;
      const products = data.data?.products?.edges?.map((e: any) => e.node) || [];

      allProducts = [...allProducts, ...products];
      hasNextPage = pageInfo?.hasNextPage || false;
      cursor = pageInfo?.endCursor || null;

    }

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
              productType: product.productType || null,
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
              productType: product.productType || null,
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
            try {
              await tx.productOption.createMany({
                data: product.options.map((opt: any) => ({
                  id: opt.id,
                  productId: product.id,
                  name: opt.name,
                  position: opt.position,
                  values: opt.optionValues
                    ? JSON.stringify(opt.optionValues.map((v: any) => ({ id: v.id, name: v.name, linked: !!v.linkedMetafieldValue, linkedValue: v.linkedMetafieldValue || undefined })))
                    : JSON.stringify(opt.values),
                  linkedMetafieldKey: opt.linkedMetafield ? `${opt.linkedMetafield.namespace}--${opt.linkedMetafield.key}` : null,
                })),
              });
            } catch (optErr: unknown) {
              logger.error(`[SYNC-PRODUCTS] OPTIONS createMany FAILED: ${optErr instanceof Error ? optErr.message : String(optErr)}`);
              await tx.productOption.createMany({
                data: product.options.map((opt: any) => ({
                  id: opt.id,
                  productId: product.id,
                  name: opt.name,
                  position: opt.position,
                  values: opt.optionValues
                    ? JSON.stringify(opt.optionValues.map((v: any) => ({ id: v.id, name: v.name, linked: !!v.linkedMetafieldValue, linkedValue: v.linkedMetafieldValue || undefined })))
                    : JSON.stringify(opt.values),
                })),
              });
            }
          }

          // Upsert metafields (idempotent — safe under concurrent execution)
          const metafields = product.metafields?.edges?.map((edge: any) => edge.node) || [];
          await upsertProductMetafields(tx, product.id, metafields);
        });

        synced++;

        // Log progress every 50 products
        if (synced % 50 === 0) {
          logger.debug("[SYNC-PRODUCTS] Progress", { context: "SyncProducts", synced, total: allProducts.length });
        }
      } catch (err: unknown) {
        logger.error("[SYNC-PRODUCTS] Failed to save product", { context: "SyncProducts", productId: product.id, error: err instanceof Error ? err.message : String(err) });
        failed++;
        errors.push(`${product.id}: Failed to sync products`);
      }
    }

    logger.info("[SYNC-PRODUCTS] Complete", { context: "SyncProducts", synced, failed, total: allProducts.length });

    return json({
      success: true,
      message: `Synced ${synced} products${failed > 0 ? ` (${failed} failed)` : ""}`,
      synced,
      failed,
      errors: errors.slice(0, 10), // Only return first 10 errors
    });
  } catch (error: unknown) {
    logger.error("[SYNC-PRODUCTS] Error", { context: "SyncProducts", error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
    return json(
      {
        success: false,
        error: "Failed to sync products",
      },
      { status: 500 }
    );
  }
};
