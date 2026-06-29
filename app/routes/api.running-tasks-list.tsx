import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { logger } from "~/utils/logger.server";

// Lightweight preview of the currently running tasks, used by the hover card
// on the "Tasks" navigation badge. Only the top few active tasks are returned
// with just enough info to render name / type / progress — no prompts, results
// or other heavy detail fields.
const PREVIEW_LIMIT = 5;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  try {
    const { session } = await authenticate.admin(request);

    try {
      const { db } = await import("../db.server");

      const where = {
        shop: session.shop,
        status: { in: ["pending", "queued", "running"] },
      };

      // Fetch the preview slice and the authoritative total together so the
      // hover card can render "+N more" from a single, consistent source
      // instead of subtracting two independently-polled numbers.
      const [tasks, totalCount] = await Promise.all([
        db.task.findMany({
          where,
          orderBy: { startedAt: "desc" },
          take: PREVIEW_LIMIT,
          select: {
            id: true,
            type: true,
            status: true,
            resourceType: true,
            resourceTitle: true,
            fieldType: true,
            targetLocale: true,
            progress: true,
            processed: true,
            total: true,
            startedAt: true,
          },
        }),
        db.task.count({ where }),
      ]);

      return json(
        {
          totalCount,
          tasks: tasks.map((task) => ({
            ...task,
            startedAt: task.startedAt.toISOString(),
          })),
        },
        { headers: { "Cache-Control": "no-store" } }
      );
    } catch (dbError: unknown) {
      logger.error("Database error in running-tasks-list", {
        error: dbError instanceof Error ? dbError.message : String(dbError),
      });
      return json({ tasks: [], totalCount: 0, error: "Database error" }, { status: 500 });
    }
  } catch (authError: unknown) {
    logger.error("Authentication error in running-tasks-list", {
      error: authError instanceof Error ? authError.message : String(authError),
    });

    const errStatus = authError instanceof Response ? authError.status : undefined;

    if (errStatus === 429) {
      logger.warn("Rate limit hit on running-tasks-list, returning empty list");
      return json(
        { tasks: [], totalCount: 0, warning: "Rate limited" },
        { status: 200, headers: { "Retry-After": "60" } }
      );
    }

    return json(
      { tasks: [], totalCount: 0, error: "Authentication failed" },
      { status: errStatus || 401 }
    );
  }
};
