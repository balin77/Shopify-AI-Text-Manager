/**
 * API Route: Initial Setup
 *
 * Automatically runs on first app load after installation:
 * 1. Registers all webhooks (if not already registered)
 * 2. Performs FAST product sync (only products, no translations)
 *
 * This replaces the manual setup steps in SettingsSetupTab.
 * Setup is skipped if products already exist in the database.
 */

import { json } from "@remix-run/node";
import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { WebhookRegistrationService } from "../services/webhook-registration.service";
import { getPlanLimits } from "../utils/planUtils";
import { logger } from "~/utils/logger.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const { admin, session } = await authenticate.admin(request);
    const shop = session.shop;

    // Check if products already exist (= setup was already done)
    const existingProductCount = await db.product.count({
      where: { shop },
    });

    if (existingProductCount > 0) {
      return json({
        success: true,
        skipped: true,
        message: "Setup already completed (products exist)",
      });
    }

    // Get settings for plan limits
    const settings = await db.aISettings.findUnique({
      where: { shop },
    });

    // Step 1: Register Webhooks
    const webhookService = new WebhookRegistrationService(admin);

    try {
      await webhookService.registerAllWebhooks();
    } catch (webhookError: any) {
      logger.error("[INITIAL-SETUP] Webhook registration error", { context: "InitialSetup", error: webhookError.message });
      // Continue even if webhook registration fails - products can still be synced
    }

    // Step 2: Fast Product Sync
    const plan = (settings?.subscriptionPlan || "free") as "free" | "basic" | "pro" | "max";
    const planLimits = getPlanLimits(plan);

    let productsSynced = 0;

    // FAST: Fetch ALL products in ONE bulk request
    const maxToFetch = planLimits.maxProducts === Infinity ? 250 : planLimits.maxProducts;

    const response = await admin.graphql(
      `#graphql
        query getProductsBulk($first: Int!) {
          products(first: $first) {
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
                media(first: 20) {
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
              }
            }
          }
        }`,
      { variables: { first: maxToFetch } }
    );

    const data = await response.json();
    const shopifyProducts = data.data?.products?.edges?.map((e: any) => e.node) || [];

    if (shopifyProducts.length > 0) {

      for (const product of shopifyProducts) {
        try {
          await db.product.upsert({
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
              await db.productImage.deleteMany({ where: { productId: product.id } });
              await db.productImage.createMany({
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

          productsSynced++;
        } catch (err: any) {
          logger.error("[INITIAL-SETUP] Failed to save product", { context: "InitialSetup", productId: product.id, error: err.message });
        }
      }

      logger.info("[INITIAL-SETUP] Products synced", { context: "InitialSetup", shop, productsSynced });
    }

    // Step 3: Sync Metaobjects
    let metaobjectsSynced = 0;
    let metaobjectDefinitionsSynced = 0;

    try {
      const { MetaobjectSyncService } = await import("../services/metaobject-sync.service");
      const metaobjectSync = new MetaobjectSyncService(admin, shop);

      const metaobjectResult = await metaobjectSync.syncAll();
      metaobjectDefinitionsSynced = metaobjectResult.definitions;
      metaobjectsSynced = metaobjectResult.metaobjects;

      logger.info("[INITIAL-SETUP] Metaobjects synced", {
        context: "InitialSetup",
        shop,
        definitions: metaobjectDefinitionsSynced,
        metaobjects: metaobjectsSynced
      });
    } catch (metaobjectError: any) {
      logger.error("[INITIAL-SETUP] Metaobject sync error", {
        context: "InitialSetup",
        error: metaobjectError.message
      });
      // Continue even if metaobject sync fails
    }

    return json({
      success: true,
      skipped: false,
      webhooksRegistered: true,
      productsSynced,
      metaobjectDefinitionsSynced,
      metaobjectsSynced,
      message: `Initial setup complete. Synced ${productsSynced} products and ${metaobjectsSynced} metaobjects.`,
    });
  } catch (error: any) {
    logger.error("[INITIAL-SETUP] Error", { context: "InitialSetup", error: error.message, stack: error.stack });
    return json(
      {
        success: false,
        error: "Initial setup failed",
      },
      { status: 500 }
    );
  }
};
