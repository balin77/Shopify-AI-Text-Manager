import { json, type ActionFunctionArgs } from "@remix-run/node";
import { z } from "zod";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { ProductSyncService } from "../services/product-sync.service";
import { ContentSyncService } from "../services/content-sync.service";
import { BackgroundSyncService } from "../services/background-sync.service";
import { getPlanLimits } from "../utils/planUtils";
import { logger } from "~/utils/logger.server";
import { isValidShopifyGID, isValidLocale } from "~/utils/validation";

const VALID_RESOURCE_TYPES = [
  "product", "products",
  "collection", "collections",
  "article", "articles",
  "blog", "blogs",
  "page", "pages",
  "policy", "policies",
  "template", "templates",
  "theme", "themes",
  "menu", "menus",
  "metaobject", "metaobjects",
] as const;

// Resource types whose resourceId must be a valid Shopify GID
const GID_RESOURCE_TYPES = new Set(["product", "products", "collection", "collections", "article", "page"]);

const SyncSingleResourceSchema = z.object({
  resourceId: z.string().min(1).max(500),
  resourceType: z.enum(VALID_RESOURCE_TYPES),
  locale: z.string().refine(
    v => !v || isValidLocale(v),
    { message: "Invalid locale format (expected e.g. 'de' or 'de-AT')" }
  ).optional(),
});

export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);

  try {
    const formData = await request.formData();
    const parsed = SyncSingleResourceSchema.safeParse({
      resourceId: formData.get("resourceId"),
      resourceType: formData.get("resourceType"),
      locale: formData.get("locale") ?? undefined,
    });

    if (!parsed.success) {
      const issues = parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join(", ");
      return json({ success: false, error: `Invalid request: ${issues}` }, { status: 400 });
    }

    const { resourceId, resourceType, locale } = parsed.data;

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
  } catch (error: unknown) {
    logger.error("[Manual Sync] Error", { context: "ManualSync", error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
    return json(
      {
        success: false,
        error: "Failed to sync resource",
      },
      { status: 500 }
    );
  }
}
