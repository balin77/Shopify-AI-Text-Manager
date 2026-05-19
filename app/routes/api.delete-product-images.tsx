import { json, type ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { isValidShopifyGID } from "../utils/validation";

export const action = async ({ request }: ActionFunctionArgs) => {
  if (process.env.APP_ENV === "production") throw new Response("Not Found", { status: 404 });
  const { admin } = await authenticate.admin(request);
  const { productId, mediaIds } = await request.json();

  if (!productId || !Array.isArray(mediaIds) || mediaIds.length === 0) {
    return json({ success: false, error: "Missing required fields" }, { status: 400 });
  }

  // Reject malformed GIDs before they reach the Shopify mutation.
  if (!isValidShopifyGID(productId) || !mediaIds.every((id) => typeof id === "string" && isValidShopifyGID(id))) {
    return json({ success: false, error: "Invalid Shopify GID format" }, { status: 400 });
  }

  const r = await admin.graphql(`
    mutation productDeleteMedia($productId: ID!, $mediaIds: [ID!]!) {
      productDeleteMedia(productId: $productId, mediaIds: $mediaIds) {
        deletedMediaIds
        userErrors { field message }
      }
    }
  `, {
    variables: { productId, mediaIds },
  });

  const d = await r.json();
  const userErrors = d.data?.productDeleteMedia?.userErrors ?? [];
  if (userErrors.length > 0) {
    return json({ success: false, errors: userErrors.map((e: { message: string }) => e.message) }, { status: 422 });
  }

  return json({ success: true, deletedMediaIds: d.data?.productDeleteMedia?.deletedMediaIds ?? [] });
};
