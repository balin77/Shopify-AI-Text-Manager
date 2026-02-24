import { json, type ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { ProductSyncService } from "../services/product-sync.service";
import { ContentSyncService } from "../services/content-sync.service";
import { BackgroundSyncService } from "../services/background-sync.service";
import { getPlanLimits } from "../utils/planUtils";
import { logger } from "~/utils/logger.server";
import { isValidShopifyGID } from "~/utils/validation";

// Resource types whose resourceId must be a valid Shopify GID
const GID_RESOURCE_TYPES = new Set(["product", "products", "collection", "collections", "article", "page"]);

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

    // Validate GID format for resource types that use Shopify GIDs
    if (GID_RESOURCE_TYPES.has(resourceType) && resourceId.includes("gid://") && !isValidShopifyGID(resourceId)) {
      return json(
        { success: false, error: "Invalid resourceId format" },
        { status: 400 }
      );
    }


    // Get subscription plan for image limits
    const settings = await db.aISettings.findUnique({
      where: { shop: session.shop },
      select: { subscriptionPlan: true },
    });
    const plan = (settings?.subscriptionPlan || "free") as "free" | "basic" | "pro" | "max";
    const planLimits = getPlanLimits(plan);

    let result;

    switch (resourceType) {
      case "product":
      case "products": {
        const productSyncService = new ProductSyncService(
          admin,
          session.shop
        );

        // Extract numeric ID from Shopify GID
        const shopifyId = resourceId.includes("gid://")
          ? resourceId.split("/").pop()!
          : resourceId;

        // Sync single product with plan-aware image loading
        result = await productSyncService.syncSingleProduct(
          shopifyId,
          planLimits.cacheEnabled.productImages
        );
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
        break;
      }

      case "page": {
        const backgroundSyncService = new BackgroundSyncService(
          admin,
          session.shop
        );

        result = await backgroundSyncService.syncSinglePage(resourceId);
        break;
      }

      case "policy": {
        const backgroundSyncService = new BackgroundSyncService(
          admin,
          session.shop
        );

        result = await backgroundSyncService.syncSinglePolicy(resourceId);
        break;
      }

      case "templates": {
        const backgroundSyncService = new BackgroundSyncService(
          admin,
          session.shop
        );

        const groupId = resourceId.startsWith("group_")
          ? resourceId.replace("group_", "")
          : resourceId;

        result = await backgroundSyncService.syncSingleThemeGroup(groupId);
        break;
      }

      case "metaobjects": {
        // Sync single metaobject type from Shopify to DB
        const typeId = resourceId.startsWith("metaobject_type_")
          ? resourceId.replace("metaobject_type_", "")
          : resourceId;

        logger.info("[Manual Sync] Metaobjects reload requested", {
          context: "ManualSync",
          typeId,
          shop: session.shop
        });

        const { MetaobjectSyncService } = await import("../services/metaobject-sync.service");
        const metaobjectSync = new MetaobjectSyncService(admin, session.shop);

        result = await metaobjectSync.syncSingleType(typeId);
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
        error: "Failed to sync resource",
      },
      { status: 500 }
    );
  }
}
