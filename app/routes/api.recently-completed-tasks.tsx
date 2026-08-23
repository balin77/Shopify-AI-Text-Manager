import { data as json, type LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { logger } from "~/utils/logger.server";
import { handlePolledAuthError } from "~/utils/polled-auth-error.server";

/**
 * API endpoint to fetch recently completed tasks (last 30 seconds)
 * Used by MainNavigation to show completion notifications
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  try {
    const { session } = await authenticate.admin(request);

    try {
      const { db } = await import("../db.server");

      // Get tasks that reached a terminal state in the last 30 seconds.
      // `failed` is included so the navigation can raise a critical toast, and
      // `completed_with_errors` so a run that only PARTLY succeeded raises a
      // warning one — the four translation paths write that status, and while
      // the filter carried only the two extremes a bulk translation whose
      // locales failed ended completely silently.
      // `cancelled` stays out on purpose: the merchant pressed the button, so
      // announcing the outcome tells them what they already know.
      const thirtySecondsAgo = new Date(Date.now() - 30000);

      const recentlyCompletedTasks = await db.task.findMany({
        where: {
          shop: session.shop,
          status: { in: ["completed", "completed_with_errors", "failed"] },
          completedAt: {
            gte: thirtySecondsAgo,
          },
        },
        select: {
          id: true,
          type: true,
          status: true,
          resourceType: true,
          resourceTitle: true,
          fieldType: true,
          completedAt: true,
          processed: true,
          total: true,
          error: true,
        },
        orderBy: {
          completedAt: "desc",
        },
        take: 5, // Only return the 5 most recent
      });

      return json(
        { tasks: recentlyCompletedTasks },
        {
          headers: {
            "Cache-Control": "no-store",
          },
        }
      );
    } catch (dbError: unknown) {
      logger.error("Database error in recently-completed-tasks", { error: dbError instanceof Error ? dbError.message : String(dbError) });
      return json(
        { tasks: [], error: "Database error" },
        { status: 500 }
      );
    }
  } catch (authError: unknown) {
    // See handlePolledAuthError: re-throw the Shopify auth Response (App Bridge
    // token refresh) instead of the 3xx-json crash; 429 → graceful 200.
    return handlePolledAuthError(authError, { tasks: [] });
  }
};
