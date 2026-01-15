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

      return json({ count: runningTaskCount });
    } catch (error: any) {
      console.error("Error fetching running tasks count:", error);
      return json({ count: 0 }, { status: 500 });
    }
  } catch (authError: any) {
    // Handle authentication errors (including rate limiting)
    console.error("Authentication error in running-tasks-count:", authError);

    // Return a valid JSON response even on auth errors
    return json(
      { count: 0, error: "Authentication failed" },
      {
        status: authError.status || 401,
        headers: {
          "Content-Type": "application/json",
        },
      }
    );
  }
};
