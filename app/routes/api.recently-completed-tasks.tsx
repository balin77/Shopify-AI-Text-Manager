import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";

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
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
            // Add CORS headers for embedded app
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET",
          },
        }
      );
    } catch (dbError: any) {
      console.error("Database error in recently-completed-tasks:", dbError);
      return json(
        { tasks: [], error: "Database error" },
        {
          status: 500,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        }
      );
    }
  } catch (authError: any) {
    console.error("Authentication error in recently-completed-tasks:", authError);

    // If this is a rate limit error, return 200 with empty tasks to prevent client errors
    if (authError.status === 429) {
      console.warn("Rate limit hit on recently-completed-tasks, returning empty result");
      return json(
        { tasks: [], warning: "Rate limited" },
        {
          status: 200, // Return 200 to prevent client-side errors
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Retry-After": "60", // Tell client to wait 60 seconds
          },
        }
      );
    }

    return json(
      { tasks: [], error: "Authentication failed" },
      {
        status: authError.status || 401,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }
};
