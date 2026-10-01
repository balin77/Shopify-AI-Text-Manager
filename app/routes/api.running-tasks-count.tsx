import { data as json, type LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { logger } from "~/utils/logger.server";
import { handlePolledAuthError } from "~/utils/polled-auth-error.server";
import { WEBP_ITEM_TASK_TYPE } from "~/config/webp-tasks.js";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  try {
    const { session } = await authenticate.admin(request);

    try {
      const { db } = await import("../db.server");

      // Count active tasks (pending → queued → running).
      //
      // The per-image work items of a WebP conversion are excluded — a 20-image
      // upload would otherwise put "21" on the badge for one merchant action.
      // The run's own aggregate row (`imageWebpConversion`) stays counted for
      // as long as any of its items is open, so the badge still says something
      // is running. Legacy rows from before the split carry the aggregate type
      // and keep counting one per image, as they always did.
      const runningTaskCount = await db.task.count({
        where: {
          shop: session.shop,
          type: { not: WEBP_ITEM_TASK_TYPE },
          status: {
            in: ["pending", "queued", "running"],
          },
        },
      });

      return json(
        { count: runningTaskCount },
        {
          headers: {
            "Cache-Control": "no-store",
          },
        }
      );
    } catch (dbError: unknown) {
      logger.error("Database error in running-tasks-count", { error: dbError instanceof Error ? dbError.message : String(dbError) });
      return json(
        { count: 0, error: "Database error" },
        { status: 500 }
      );
    }
  } catch (authError: unknown) {
    // Re-throws a Shopify auth Response unchanged (so App Bridge can refresh the
    // token) instead of re-wrapping it as a 3xx json that crashes; 429 degrades
    // to a graceful 200. See handlePolledAuthError.
    return handlePolledAuthError(authError, { count: 0 });
  }
};
