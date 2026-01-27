import { json, type ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { ProductSyncService } from "../services/product-sync.service";
import { ContentSyncService } from "../services/content-sync.service";
import { BackgroundSyncService } from "../services/background-sync.service";
import { getPlanLimits } from "../utils/planUtils";
import { logger } from "~/utils/logger.server";

export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);

  try {
    const formData = await request.formData();
    const resourceId = formData.get("resourceId") as string;
    const resourceType = formData.get("resourceType") as string;
    const locale = formData.get("locale") as string;

    if (!resourceId || !resourceType) {
      return json(
        { success: false, error: "Missing resourceId or resourceType" },
        { status: 400 }
      );
    }

    logger.debug("[Manual Sync] Starting sync", { context: "ManualSync", resourceType, resourceId, locale });

    // Get subscription plan for image limits
    const settings = await db.aISettings.findUnique({
      where: { shop: session.shop },
      select: { subscriptionPlan: true },
    });
    const plan = (settings?.subscriptionPlan || "basic") as "free" | "basic" | "pro" | "max";
    const planLimits = getPlanLimits(plan);

    let result;

    switch (resourceType) {
      case "product":
      case "products": {
        logger.debug("[RELOAD-BUTTON] Product reload triggered", { context: "ManualSync", resourceId });
        const productSyncService = new ProductSyncService(
          admin,
          session.shop
        );

        // Extract numeric ID from Shopify GID
        const shopifyId = resourceId.includes("gid://")
          ? resourceId.split("/").pop()!
          : resourceId;

        // Sync single product with plan-aware image loading
        logger.debug("[RELOAD-BUTTON] Calling syncSingleProduct", { context: "ManualSync", shopifyId });
        result = await productSyncService.syncSingleProduct(
          shopifyId,
          planLimits.cacheEnabled.productImages // true for all images, false for featured only
        );

        logger.debug("[RELOAD-BUTTON] Product synced successfully", { context: "ManualSync", shopifyId, imageMode: planLimits.cacheEnabled.productImages ? "all" : "featured only" });
        break;
      }

      case "collection":
      case "collections": {
        const contentSyncService = new ContentSyncService(
          admin,
          session.shop
        );

        const collectionId = resourceId.includes("gid://")
          ? resourceId.split("/").pop()!
          : resourceId;

        result = await contentSyncService.syncSingleCollection(collectionId);
        logger.debug("[Manual Sync] Collection synced successfully", { context: "ManualSync", collectionId });
        break;
      }

      case "article": {
        const contentSyncService = new ContentSyncService(
          admin,
          session.shop
        );

        const articleId = resourceId.includes("gid://")
          ? resourceId.split("/").pop()!
          : resourceId;

        result = await contentSyncService.syncSingleArticle(articleId);
        logger.debug("[Manual Sync] Article synced successfully", { context: "ManualSync", articleId });
        break;
      }

      case "page": {
        const backgroundSyncService = new BackgroundSyncService(
          admin,
          session.shop
        );

        // Pass the full resourceId - syncSinglePage will handle GID conversion
        result = await backgroundSyncService.syncSinglePage(resourceId);
        logger.debug("[Manual Sync] Page synced successfully", { context: "ManualSync", resourceId });
        break;
      }

      case "policy": {
        const backgroundSyncService = new BackgroundSyncService(
          admin,
          session.shop
        );

        // Policies use type as identifier (e.g., "PRIVACY_POLICY")
        result = await backgroundSyncService.syncSinglePolicy(resourceId);
        logger.debug("[Manual Sync] Policy synced successfully", { context: "ManualSync", resourceId });
        break;
      }

      case "templates": {
        const backgroundSyncService = new BackgroundSyncService(
          admin,
          session.shop
        );

        // Extract groupId from resourceId (format: "group_xxx")
        const groupId = resourceId.startsWith("group_")
          ? resourceId.replace("group_", "")
          : resourceId;

        result = await backgroundSyncService.syncSingleThemeGroup(groupId);
        logger.debug("[Manual Sync] Theme group synced successfully", { context: "ManualSync", groupId });
        break;
      }

      default:
        return json(
          { success: false, error: `Unknown resource type: ${resourceType}` },
          { status: 400 }
        );
    }

    return json({
      success: true,
      resourceType,
      resourceId,
      locale,
      data: result,
      plan,
      imageMode: planLimits.cacheEnabled.productImages ? "all" : "featured-only",
    });
  } catch (error: any) {
    logger.error("[Manual Sync] Error", { context: "ManualSync", error: error.message, stack: error.stack });
    return json(
      {
        success: false,
        error: error.message || "Sync failed",
      },
      { status: 500 }
    );
  }
}
