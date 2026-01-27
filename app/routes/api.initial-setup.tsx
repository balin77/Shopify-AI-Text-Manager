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
  logger.debug("[INITIAL-SETUP] Starting automatic initial setup...", { context: "InitialSetup" });

  try {
    const { admin, session } = await authenticate.admin(request);
    const shop = session.shop;

    logger.debug("[INITIAL-SETUP] Shop", { context: "InitialSetup", shop });

    // Check if products already exist (= setup was already done)
    const existingProductCount = await db.product.count({
      where: { shop },
    });

    if (existingProductCount > 0) {
      logger.debug("[INITIAL-SETUP] Products already exist, skipping setup", { context: "InitialSetup", existingProductCount });
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

    // ========================================
    // STEP 1: Register Webhooks
    // ========================================
    logger.debug("[INITIAL-SETUP] Step 1: Registering webhooks...", { context: "InitialSetup" });

    const webhookService = new WebhookRegistrationService(admin);

    try {
      await webhookService.registerAllWebhooks();
      logger.debug("[INITIAL-SETUP] Webhooks registered successfully", { context: "InitialSetup" });
    } catch (webhookError: any) {
      logger.error("[INITIAL-SETUP] Webhook registration error", { context: "InitialSetup", error: webhookError.message });
      // Continue even if webhook registration fails - products can still be synced
    }

    // ========================================
    // STEP 2: Fast Product Sync
    // ========================================
    logger.debug("[INITIAL-SETUP] Step 2: Running FAST product sync...", { context: "InitialSetup" });

    const plan = (settings?.subscriptionPlan || "basic") as "free" | "basic" | "pro" | "max";
    const planLimits = getPlanLimits(plan);

    logger.debug("[INITIAL-SETUP] Plan and limits", { context: "InitialSetup", plan, maxProducts: planLimits.maxProducts });

    let productsSynced = 0;

    // FAST: Fetch ALL products in ONE bulk request
    const maxToFetch = planLimits.maxProducts === Infinity ? 250 : planLimits.maxProducts;

    logger.debug("[INITIAL-SETUP] Fetching products from Shopify", { context: "InitialSetup", maxToFetch });

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

    logger.debug("[INITIAL-SETUP] Fetched products from Shopify", { context: "InitialSetup", count: shopifyProducts.length });

    if (shopifyProducts.length > 0) {
      logger.debug("[INITIAL-SETUP] Saving products...", { context: "InitialSetup", count: shopifyProducts.length });

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

      logger.debug("[INITIAL-SETUP] Synced products", { context: "InitialSetup", productsSynced });
    } else {
      logger.debug("[INITIAL-SETUP] No products found in Shopify", { context: "InitialSetup" });
    }

    logger.debug("[INITIAL-SETUP] Setup complete!", { context: "InitialSetup" });

    return json({
      success: true,
      skipped: false,
      webhooksRegistered: true,
      productsSynced,
      message: `Initial setup complete. Synced ${productsSynced} products.`,
    });
  } catch (error: any) {
    logger.error("[INITIAL-SETUP] Error", { context: "InitialSetup", error: error.message, stack: error.stack });
    return json(
      {
        success: false,
        error: error.message,
      },
      { status: 500 }
    );
  }
};
