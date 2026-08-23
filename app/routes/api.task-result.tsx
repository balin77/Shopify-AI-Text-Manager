import { data as json, type LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { logger } from "~/utils/logger.server";
import { summariseTaskResult } from "~/services/tasks/task-details.shared";

/**
 * Fetch a single task's status + result by id. Used by the client to wait for
 * fire-and-forget AI tasks (e.g. bulk alt-text generation) to finish without
 * blocking the original request handler — so the user can navigate away mid-run.
 *
 * `detail=1` additionally returns `prompt` — the full AI prompt log INCLUDING
 * every response, which is megabytes on a long bulk run. It is OPT-IN because
 * the two polling callers (useUnifiedContentEditor, app.bulk_.translate) hit
 * this route every second and want none of it; without the parameter the
 * response is byte-identical to what it always was — `result` very much
 * included, since those two callers parse that blob themselves. Only the
 * Tasks page's expanded card asks for it, once per expand.
 *
 * The detail path trades the raw `result` for a `resultSummary` computed HERE.
 * `summariseTaskResult` is pure and client-safe, so it runs on either side —
 * but a `distributeKeywords`(suggest) row stores `suggestions[]` plus an
 * `itemTitles{}` map in `result`, and shipping that to render four numbers
 * meant an expand could download megabytes and then throw nearly all of it
 * away. The summary is what the panel renders; the blob it is derived from
 * never leaves the server on this path.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  try {
    const { session } = await authenticate.admin(request);
    const url = new URL(request.url);
    const taskId = url.searchParams.get("taskId");
    const wantsDetail = url.searchParams.get("detail") === "1";

    if (!taskId) {
      return json({ error: "taskId is required" }, { status: 400 });
    }

    const { db } = await import("../db.server");
    const task = await db.task.findUnique({
      where: { id: taskId },
      select: {
        id: true,
        shop: true,
        type: true,
        status: true,
        progress: true,
        processed: true,
        total: true,
        result: true,
        error: true,
        completedAt: true,
        // Opt-in only — see the note above the loader.
        ...(wantsDetail ? { prompt: true } : {}),
      },
    });

    // The shop check is the same one on both paths: a task id is a cuid, but
    // it is client-supplied either way.
    if (!task || task.shop !== session.shop) {
      return json({ error: "Task not found" }, { status: 404 });
    }

    if (wantsDetail) {
      // `result` is READ (it is what the summary is made of) and deliberately
      // not returned. The summariser answers `null` for a type it has no
      // branch for, for a malformed blob and for one that summarises to
      // nothing — the panel already distinguishes that from a failed fetch.
      const { result, ...rest } = task;
      return json(
        { task: { ...rest, resultSummary: summariseTaskResult(task.type, result) } },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    return json(
      { task },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err: unknown) {
    logger.error("Error in api.task-result", {
      error: err instanceof Error ? err.message : String(err),
    });
    const errStatus = err instanceof Response ? err.status : undefined;
    return json({ error: "Failed to fetch task" }, { status: errStatus || 500 });
  }
};
