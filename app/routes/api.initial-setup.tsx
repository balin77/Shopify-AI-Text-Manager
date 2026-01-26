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

export const action = async ({ request }: ActionFunctionArgs) => {
  console.log("🚀 [INITIAL-SETUP] Starting automatic initial setup...");

  try {
    const { admin, session } = await authenticate.admin(request);
    const shop = session.shop;

    console.log(`[INITIAL-SETUP] Shop: ${shop}`);

    // Check if products already exist (= setup was already done)
    const existingProductCount = await db.product.count({
      where: { shop },
    });

    if (existingProductCount > 0) {
      console.log(`[INITIAL-SETUP] ${existingProductCount} products already exist, skipping setup...`);
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
    console.log("[INITIAL-SETUP] Step 1: Registering webhooks...");

    const webhookService = new WebhookRegistrationService(admin);

    try {
      await webhookService.registerAllWebhooks();
      console.log("[INITIAL-SETUP] ✓ Webhooks registered successfully");
    } catch (webhookError: any) {
      console.error("[INITIAL-SETUP] Webhook registration error:", webhookError.message);
      // Continue even if webhook registration fails - products can still be synced
    }

    // ========================================
    // STEP 2: Fast Product Sync
    // ========================================
    console.log("[INITIAL-SETUP] Step 2: Running FAST product sync...");

    const plan = (settings?.subscriptionPlan || "basic") as "free" | "basic" | "pro" | "max";
    const planLimits = getPlanLimits(plan);

    console.log(`[INITIAL-SETUP] Plan: ${plan}, Max products: ${planLimits.maxProducts}`);

    let productsSynced = 0;

    // FAST: Fetch ALL products in ONE bulk request
    const maxToFetch = planLimits.maxProducts === Infinity ? 250 : planLimits.maxProducts;

    console.log(`[INITIAL-SETUP] Fetching up to ${maxToFetch} products from Shopify...`);

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

    console.log(`[INITIAL-SETUP] Fetched ${shopifyProducts.length} products from Shopify`);

    if (shopifyProducts.length > 0) {
      console.log(`[INITIAL-SETUP] Saving ${shopifyProducts.length} products...`);

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
          console.error(`[INITIAL-SETUP] Failed to save product ${product.id}:`, err.message);
        }
      }

      console.log(`[INITIAL-SETUP] ✓ Synced ${productsSynced} products`);
    } else {
      console.log("[INITIAL-SETUP] No products found in Shopify");
    }

    console.log("✅ [INITIAL-SETUP] Setup complete!");

    return json({
      success: true,
      skipped: false,
      webhooksRegistered: true,
      productsSynced,
      message: `Initial setup complete. Synced ${productsSynced} products.`,
    });
  } catch (error: any) {
    console.error("❌ [INITIAL-SETUP] Error:", error);
    return json(
      {
        success: false,
        error: error.message,
      },
      { status: 500 }
    );
  }
};
