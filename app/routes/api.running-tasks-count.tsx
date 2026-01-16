import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  try {
    const { session } = await authenticate.admin(request);

    try {
      const { db } = await import("../db.server");

      // Count only running and pending tasks
      const runningTaskCount = await db.task.count({
        where: {
          shop: session.shop,
          status: {
            in: ["pending", "running"],
          },
        },
      });

      return json(
        { count: runningTaskCount },
        {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET",
          },
        }
      );
    } catch (dbError: any) {
      console.error("Database error in running-tasks-count:", dbError);
      return json(
        { count: 0, error: "Database error" },
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
    // Handle authentication errors (including rate limiting)
    console.error("Authentication error in running-tasks-count:", authError);

    // If this is a rate limit error, return 200 with count 0 to prevent client errors
    if (authError.status === 429) {
      console.warn("Rate limit hit on running-tasks-count, returning 0");
      return json(
        { count: 0, warning: "Rate limited" },
        {
          status: 200, // Return 200 to prevent client-side errors
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Retry-After": "60",
          },
        }
      );
    }

    // Return a valid JSON response even on auth errors
    return json(
      { count: 0, error: "Authentication failed" },
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
