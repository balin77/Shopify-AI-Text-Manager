import { data as json } from "react-router";
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { db, upsertProductMetafields } from "../db.server";
import {
  PRODUCT_VIDEO_MEDIA_FIELDS,
  videoUploadDatesFromMedia,
} from "../services/seo/video-schema.shared";
import { persistVideoSchema } from "../services/seo/video-schema.server";
import { getPlanLimits } from "../utils/planUtils";
import { logger } from "~/utils/logger.server";
import {
  PRODUCT_ATTRIBUTE_SELECTION,
  PRODUCT_COLLECTIONS_SELECTION,
  productAttributeColumns,
  productCollectionRows,
} from "../services/attribute-sync.shared";

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

    // Snapshot the cached ids BEFORE the pull so we can report how many products
    // this run actually discovered. This used to be an early return ("already
    // synced N products, use ?force=true") which made the list-level reload
    // button a permanent no-op after the first sync — the one path a merchant
    // has to pull in a product Shopify's products/create webhook missed. The
    // pass below is a pure upsert, so re-running it is cheap and never
    // destroys local state; ?force=true stays the explicit delete + re-pull.
    const knownIds = new Set(
      (await db.product.findMany({ where: { shop }, select: { id: true } })).map((p) => p.id)
    );

    // If force, delete all existing products first
    if (force) {
      // knownIds is the same snapshot the cascade deletes need
      const productIds = [...knownIds];

      if (productIds.length > 0) {
        // Delete in transaction for consistency
        await db.$transaction([
          db.contentTranslation.deleteMany({
            where: { shop, resourceId: { in: productIds }, resourceType: "Product" },
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

      // Everything below is a fresh create — don't report the wiped rows as
      // newly discovered products.
      knownIds.clear();
    }

    // FAST BULK FETCH: Get all products in batches of 250 (GraphQL limit).
    // Sorted UPDATED_AT desc (see the query below): on a catalog larger than the
    // plan cap the fetch window has to contain the products most likely to be
    // missing locally. Shopify's default order is ID ascending, which puts newly
    // created products last — exactly the ones a discovery run needs to find.
    const maxToFetch = planLimits.maxProducts === Infinity ? 10000 : planLimits.maxProducts;
    let allProducts: any[] = [];
    let hasNextPage = true;
    let cursor: string | null = null;

    while (hasNextPage && allProducts.length < maxToFetch) {
      const batchSize = Math.min(250, maxToFetch - allProducts.length);

      const response: Response = await admin.graphql(
        `#graphql
          query getProductsBulk($first: Int!, $after: String) {
            products(first: $first, after: $after, sortKey: UPDATED_AT, reverse: true) {
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
                  updatedAt${PRODUCT_ATTRIBUTE_SELECTION}${PRODUCT_COLLECTIONS_SELECTION}
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
                        ${PRODUCT_VIDEO_MEDIA_FIELDS}
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
    let discovered = 0;
    const errors: string[] = [];

    for (const product of allProducts) {
      try {
        // Use transaction for each product to ensure consistency
        await db.$transaction(async (tx) => {
          // PLAN_CONTENT_CREATION Phase 0 — this route is a THIRD full product
          // write path next to the two in product-sync.service.ts. It has to
          // fetch and map the attribute block through the same shared module,
          // or a merchant who syncs from this button ends up with rows whose
          // attributesSyncedAt stays null forever: permanently "unknown".
          const attributes = productAttributeColumns(product);
          const membership = productCollectionRows(shop, product.id, product.collections);

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
              ...attributes,
              ...(membership ? { hasMoreCollections: membership.hasMore } : {}),
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
              ...attributes,
              ...(membership ? { hasMoreCollections: membership.hasMore } : {}),
              shopifyUpdatedAt: new Date(product.updatedAt),
              lastSyncedAt: new Date(),
            },
          });

          if (membership) {
            await tx.productCollection.deleteMany({ where: { productId: product.id } });
            if (membership.rows.length > 0) {
              await tx.productCollection.createMany({ data: membership.rows, skipDuplicates: true });
            }
          }

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
            } catch (optErr: any) {
              logger.error(`[SYNC-PRODUCTS] OPTIONS createMany FAILED: ${optErr.message}`);
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
        if (!knownIds.has(product.id)) discovered++;

        // Log progress every 50 products
        if (synced % 50 === 0) {
          logger.debug("[SYNC-PRODUCTS] Progress", { context: "SyncProducts", synced, total: allProducts.length });
        }
      } catch (err: any) {
        logger.error("[SYNC-PRODUCTS] Failed to save product", { context: "SyncProducts", productId: product.id, error: err.message });
        failed++;
        errors.push(`${product.id}: Failed to sync products`);
      }
    }

    // Video upload dates → product metafield (services/seo/video-schema.*).
    // After the write loop, so the mirror column it diffs against exists; one
    // pass for the whole set, and no Shopify call at all when nothing changed.
    if (synced > 0) {
      await persistVideoSchema(
        admin as never,
        db,
        allProducts.map((product: any) => ({
          productId: product.id,
          uploadDates: videoUploadDatesFromMedia(product.media?.edges),
        })),
      );
    }

    logger.info("[SYNC-PRODUCTS] Complete", { context: "SyncProducts", synced, discovered, failed, total: allProducts.length });

    return json({
      success: true,
      message: `Synced ${synced} products${discovered > 0 ? `, ${discovered} new` : ""}${failed > 0 ? ` (${failed} failed)` : ""}`,
      synced,
      discovered,
      failed,
      errors: errors.slice(0, 10), // Only return first 10 errors
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error("[SYNC-PRODUCTS] Error", { context: "SyncProducts", error: msg, stack: error instanceof Error ? error.stack : undefined });
    return json(
      {
        success: false,
        error: "Failed to sync products",
      },
      { status: 500 }
    );
  }
};
