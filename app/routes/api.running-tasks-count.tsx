import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
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
};
