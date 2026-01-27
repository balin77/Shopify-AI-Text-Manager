/**
 * API: On-Demand Product Images Loading
 *
 * Fetches all product images directly from Shopify API and caches them in DB.
 * Used as a fallback when images are not yet in the database.
 *
 * Flow:
 * 1. Fetch images from Shopify API
 * 2. Save them to database (for future instant loading)
 * 3. Return images to frontend
 */

import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { logger } from "~/utils/logger.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  const url = new URL(request.url);
  const productId = url.searchParams.get("productId");

  if (!productId) {
    return json({ error: "productId is required" }, { status: 400 });
  }

  try {
    // Fetch all images from Shopify
    const response = await admin.graphql(
      `#graphql
        query getProductImages($id: ID!) {
          product(id: $id) {
            media(first: 250) {
              edges {
                node {
                  ... on MediaImage {
                    id
                    alt
                    image {
                      url
                      width
                      height
                    }
                  }
                }
              }
            }
          }
        }`,
      { variables: { id: productId } }
    );

    const data = await response.json() as { data?: any; errors?: Array<{ message: string }> };

    if (data.errors) {
      logger.error("[API:ProductImages] GraphQL error", { context: "ProductImages", errors: data.errors });
      return json({ error: data.errors[0]?.message || "GraphQL error" }, { status: 500 });
    }

    const mediaImages = data.data?.product?.media?.edges
      ?.filter((edge: any) => edge.node.id && edge.node.image?.url)
      .map((edge: any, index: number) => ({
        url: edge.node.image.url,
        altText: edge.node.alt || null,
        mediaId: edge.node.id,
        position: index,
        width: edge.node.image.width,
        height: edge.node.image.height,
      })) || [];

    logger.debug("[API:ProductImages] Loaded images from Shopify", { context: "ProductImages", count: mediaImages.length, productId });

    // Save images to database for future instant loading (non-blocking)
    if (mediaImages.length > 0) {
      try {
        // Check if product exists in our DB
        const product = await db.product.findUnique({
          where: {
            shop_id: {
              shop: session.shop,
              id: productId,
            },
          },
          select: { id: true },
        });

        if (product) {
          // Delete existing images and insert new ones
          await db.$transaction(async (tx) => {
            await tx.productImage.deleteMany({
              where: { productId: productId },
            });

            await tx.productImage.createMany({
              data: mediaImages.map((img: any) => ({
                productId: productId,
                url: img.url,
                altText: img.altText,
                mediaId: img.mediaId,
                position: img.position,
              })),
            });
          });

          logger.debug("[API:ProductImages] Cached images to DB", { context: "ProductImages", count: mediaImages.length, productId });
        }
      } catch (dbError) {
        // Don't fail the request if DB save fails - images are still returned
        logger.error("[API:ProductImages] Failed to cache images to DB", { context: "ProductImages", error: dbError instanceof Error ? dbError.message : String(dbError) });
      }
    }

    return json({
      success: true,
      images: mediaImages,
      count: mediaImages.length,
    });
  } catch (error: any) {
    logger.error("[API:ProductImages] Error", { context: "ProductImages", error: error.message, stack: error.stack });
    return json({ error: error.message }, { status: 500 });
  }
};
