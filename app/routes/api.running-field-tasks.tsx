import { data as json, type LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { logger } from "~/utils/logger.server";
import { handlePolledAuthError } from "~/utils/polled-auth-error.server";

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
    return handlePolledAuthError(authError, { tasks: [] });
  }
};
