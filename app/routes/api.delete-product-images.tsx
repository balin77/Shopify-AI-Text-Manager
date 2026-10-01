import { data as json, type ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { isValidShopifyGID } from "../utils/validation";
import { db } from "../db.server";
import { removeEntriesForDeletedMedia } from "../services/localized-media/localized-media.server";
import { logger } from "../utils/logger.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const { productId, mediaIds } = await request.json();

  if (!productId || !Array.isArray(mediaIds) || mediaIds.length === 0) {
    return json({ success: false, error: "Missing required fields" }, { status: 400 });
  }

  // Reject malformed GIDs before they reach the Shopify mutation.
  if (!isValidShopifyGID(productId) || !mediaIds.every((id) => typeof id === "string" && isValidShopifyGID(id))) {
    return json({ success: false, error: "Invalid Shopify GID format" }, { status: 400 });
  }

  // Fail-closed ownership guard (strong `shop_id` compound), consistent with
  // the other product-mutating routes (N-H6).
  const owned = await db.product.findUnique({
    where: { shop_id: { shop: session.shop, id: productId } },
    select: { id: true },
  });
  if (!owned) {
    return json({ success: false, error: "Product not found for this shop" }, { status: 404 });
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

  const deletedMediaIds: string[] = d.data?.productDeleteMedia?.deletedMediaIds ?? [];

  // The originals are gone, so their per-language replacements (custom.localized_media,
  // every language and market) go with them. Only what Shopify ECHOED as deleted
  // counts. It never fails the delete: that has happened; a failure is reported.
  let localizedMedia: { removed: number } | { failed: string } | undefined;
  if (deletedMediaIds.length > 0) {
    try {
      const cleaned = await removeEntriesForDeletedMedia({
        graphql: admin.graphql as unknown as Parameters<typeof removeEntriesForDeletedMedia>[0]["graphql"],
        productId,
        mediaIds: deletedMediaIds,
      });
      localizedMedia = cleaned.ok ? { removed: cleaned.removed } : { failed: cleaned.code };
    } catch (error) {
      logger.warn("[delete-product-images] localized media cleanup failed", { error: error instanceof Error ? error.message : String(error) });
      localizedMedia = { failed: "readFailed" };
    }
  }

  return json({ success: true, deletedMediaIds, localizedMedia });
};
