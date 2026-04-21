import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { logger } from "~/utils/logger.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  try {
    const { session } = await authenticate.admin(request);

    const url = new URL(request.url);
    const resourceId = url.searchParams.get("resourceId");

    if (!resourceId) {
      return json({ tasks: [] }, { headers: { "Cache-Control": "no-store" } });
    }

    try {
      const { db } = await import("../db.server");

      const tasks = await db.task.findMany({
        where: {
          shop: session.shop,
          resourceId,
          status: { in: ["pending", "queued", "running"] },
        },
        select: {
          id: true,
          fieldType: true,
          targetLocale: true,
          type: true,
          status: true,
          result: true,
        },
      });

      return json(
        { tasks },
        { headers: { "Cache-Control": "no-store" } }
      );
    } catch (dbError: unknown) {
      logger.error("Database error in running-field-tasks", {
        error: dbError instanceof Error ? dbError.message : String(dbError),
      });
      return json({ tasks: [], error: "Database error" }, { status: 500 });
    }
  } catch (authError: unknown) {
    logger.error("Authentication error in running-field-tasks", {
      error: authError instanceof Error ? authError.message : String(authError),
    });

    const errStatus = authError instanceof Response ? authError.status : undefined;

    if (errStatus === 429) {
      logger.warn("Rate limit hit on running-field-tasks, returning empty tasks");
      return json(
        { tasks: [], warning: "Rate limited" },
        { status: 200, headers: { "Retry-After": "60" } }
      );
    }

    return json(
      { tasks: [], error: "Authentication failed" },
      { status: errStatus || 401 }
    );
  }
};
