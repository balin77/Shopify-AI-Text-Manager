import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { logger } from "~/utils/logger.server";

/**
 * API endpoint to fetch recently completed tasks (last 30 seconds)
 * Used by MainNavigation to show completion notifications
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  try {
    const { session } = await authenticate.admin(request);

    try {
      const { db } = await import("../db.server");

      // Get tasks that completed in the last 30 seconds
      const thirtySecondsAgo = new Date(Date.now() - 30000);

      const recentlyCompletedTasks = await db.task.findMany({
        where: {
          shop: session.shop,
          status: "completed",
          completedAt: {
            gte: thirtySecondsAgo,
          },
        },
        select: {
          id: true,
          type: true,
          resourceType: true,
          resourceTitle: true,
          fieldType: true,
          completedAt: true,
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
    } catch (dbError: any) {
      logger.error("Database error in recently-completed-tasks", { error: dbError instanceof Error ? dbError.message : String(dbError) });
      return json(
        { tasks: [], error: "Database error" },
        { status: 500 }
      );
    }
  } catch (authError: any) {
    logger.error("Authentication error in recently-completed-tasks", { error: authError instanceof Error ? authError.message : String(authError) });

    // If this is a rate limit error, return 200 with empty tasks to prevent client errors
    if (authError.status === 429) {
      logger.warn("Rate limit hit on recently-completed-tasks, returning empty result");
      return json(
        { tasks: [], warning: "Rate limited" },
        {
          status: 200,
          headers: {
            "Retry-After": "60",
          },
        }
      );
    }

    return json(
      { tasks: [], error: "Authentication failed" },
      { status: authError.status || 401 }
    );
  }
};
