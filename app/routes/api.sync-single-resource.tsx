import { json, type ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { ProductSyncService } from "../services/product-sync.service";
import { ContentSyncService } from "../services/content-sync.service";
import { BackgroundSyncService } from "../services/background-sync.service";
import { getPlanLimits } from "../utils/planUtils";

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

    console.log(
      `[Manual Sync] Starting sync for ${resourceType} ${resourceId} (locale: ${locale})`
    );

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
        console.log(`🔴🔴🔴 [RELOAD-BUTTON] Product reload triggered for ${resourceId} 🔴🔴🔴`);
        const productSyncService = new ProductSyncService(
          admin,
          session.shop
        );

        // Extract numeric ID from Shopify GID
        const shopifyId = resourceId.includes("gid://")
          ? resourceId.split("/").pop()!
          : resourceId;

        // Sync single product with plan-aware image loading
        console.log(`🔴 [RELOAD-BUTTON] Calling syncSingleProduct for ${shopifyId}...`);
        result = await productSyncService.syncSingleProduct(
          shopifyId,
          planLimits.cacheEnabled.productImages // true for all images, false for featured only
        );

        console.log(
          `🔴 [RELOAD-BUTTON] Product ${shopifyId} synced successfully (images: ${planLimits.cacheEnabled.productImages ? "all" : "featured only"})`
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
        console.log(`[Manual Sync] Collection ${collectionId} synced successfully`);
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
        console.log(`[Manual Sync] Article ${articleId} synced successfully`);
        break;
      }

      case "page": {
        const backgroundSyncService = new BackgroundSyncService(
          admin,
          session.shop
        );

        // Pass the full resourceId - syncSinglePage will handle GID conversion
        result = await backgroundSyncService.syncSinglePage(resourceId);
        console.log(`[Manual Sync] Page ${resourceId} synced successfully`);
        break;
      }

      case "policy": {
        const backgroundSyncService = new BackgroundSyncService(
          admin,
          session.shop
        );

        // Policies use type as identifier (e.g., "PRIVACY_POLICY")
        result = await backgroundSyncService.syncSinglePolicy(resourceId);
        console.log(`[Manual Sync] Policy ${resourceId} synced successfully`);
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
    console.error("[Manual Sync] Error:", error);
    return json(
      {
        success: false,
        error: error.message || "Sync failed",
      },
      { status: 500 }
    );
  }
}
