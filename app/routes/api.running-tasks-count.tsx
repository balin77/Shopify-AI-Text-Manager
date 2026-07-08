import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { logger } from "~/utils/logger.server";
import { handlePolledAuthError } from "~/utils/polled-auth-error.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  try {
    const { session } = await authenticate.admin(request);

    try {
      const { db } = await import("../db.server");

      // Count active tasks (pending → queued → running)
      const runningTaskCount = await db.task.count({
        where: {
          shop: session.shop,
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
