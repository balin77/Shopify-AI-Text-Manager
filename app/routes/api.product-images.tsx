/**
 * API: On-Demand Product Images Loading
 *
 * Fetches all product images directly from Shopify API.
 * Used for loading images beyond the first one (which is cached in DB).
 *
 * This reduces database storage significantly for multi-tenant SaaS.
 */

import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

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

    const data = await response.json();

    if (data.errors) {
      console.error("[API:ProductImages] GraphQL error:", data.errors);
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

    console.log(`[API:ProductImages] Loaded ${mediaImages.length} images for product ${productId}`);

    return json({
      success: true,
      images: mediaImages,
      count: mediaImages.length,
    });
  } catch (error: any) {
    console.error("[API:ProductImages] Error:", error);
    return json({ error: error.message }, { status: 500 });
  }
};
