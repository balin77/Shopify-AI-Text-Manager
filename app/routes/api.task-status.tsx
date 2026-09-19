import { data as json, type LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { logger } from "~/utils/logger.server";
import { handlePolledAuthError } from "~/utils/polled-auth-error.server";
import {
  MAX_TASK_STATUS_IDS,
  TERMINAL_TASK_STATUSES,
} from "~/hooks/useBackgroundTaskRefresh";

/**
 * "Are these particular Task rows still working?" — for a surface that started
 * background work and has to know when to reload its DISPLAY.
 *
 * The bulk editor is the reason it exists. Its save revalidates immediately,
 * which is seconds before the first answer of a detached auto-translation run
 * comes back, and nothing else ever tells the page the run finished — so a
 * merchant who switches languages right after saving sees empty foreign cells
 * for translations that are on their way. The page polls the ids the save
 * handed it and, once they are all terminal, reloads the loader ONCE. It never
 * writes anything: there is no autosave anywhere in this flow.
 *
 * Deliberately id-scoped rather than a second "what is running" feed: the page
 * may only poll while a known task OF ITS OWN SAVE is alive, so the poll ends
 * by itself instead of following whatever else the shop is doing.
 *
 * Shop-scoped, like every other task read — the ids are opaque cuids/uuids, but
 * a row belonging to another shop must not be answerable even so.
 *
 * A row that is not there is reported as `missing`, NOT as finished: the run is
 * spawned and not awaited, and one queued behind another for the same resource
 * creates its row only when it starts. Which of the two "missing" means is the
 * caller's to bound — it is the only honest answer this loader can give.
 */

/**
 * How many ids one call may ask about. The constant lives with the CALLER, so
 * the two cannot disagree: a client asking about more than this gets no status
 * for the surplus, and a non-answer reads as "still working" — correct about
 * the unknown id, and a watch that then only ever ends on its timeout.
 */
const MAX_IDS = MAX_TASK_STATUS_IDS;

/**
 * The repair Task ids a finished task's stored result points at, if any.
 *
 * Tolerant by construction: `Task.result` is a free-form JSON string written by
 * a dozen different task types, so anything that is not this exact shape simply
 * yields nothing. A parse error here must never fail a poll.
 */
function repairTaskIdsOf(result: string | null): string[] {
  if (!result) return [];
  try {
    const parsed = JSON.parse(result) as { retranslation?: { taskIds?: unknown } };
    const ids = parsed?.retranslation?.taskIds;
    if (!Array.isArray(ids)) return [];
    return ids.filter((id): id is string => typeof id === "string" && id.length > 0);
  } catch {
    return [];
  }
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  try {
    const { session } = await authenticate.admin(request);
    const ids = [
      ...new Set(
        (new URL(request.url).searchParams.get("ids") ?? "")
          .split(",")
          .map((id) => id.trim())
          .filter(Boolean),
      ),
    ].slice(0, MAX_IDS);

    if (ids.length === 0) {
      return json({ statuses: {} as Record<string, string> }, { headers: { "Cache-Control": "no-store" } });
    }

    try {
      const { db } = await import("../db.server");
      const rows = await db.task.findMany({
        where: { shop: session.shop, id: { in: ids } },
        select: { id: true, status: true },
      });
      const statuses: Record<string, string> = {};
      for (const id of ids) statuses[id] = "missing";
      for (const row of rows) statuses[row.id] = row.status;

      // A bulk-editor save of more than MAX_SYNC_SAVE cells runs INSIDE a
      // `seoBulkMeta` task, so the auto-translation repairs it starts are Task
      // rows that only that task's result names — and those are exactly the
      // large saves the grid most needs to reload for. `result` is a second
      // query over the terminal rows only: it carries every failure of the
      // save and must not ride on every poll of a run that is still going.
      const finishedIds = rows.filter((row) => TERMINAL_TASK_STATUSES.has(row.status)).map((row) => row.id);
      const follow: string[] = [];
      if (finishedIds.length > 0) {
        const finished = await db.task.findMany({
          where: { shop: session.shop, id: { in: finishedIds } },
          select: { id: true, result: true },
        });
        for (const row of finished) {
          for (const id of repairTaskIdsOf(row.result)) follow.push(id);
        }
      }

      return json(
        { statuses, ...(follow.length > 0 ? { follow: [...new Set(follow)] } : {}) },
        { headers: { "Cache-Control": "no-store" } },
      );
    } catch (dbError: unknown) {
      logger.error("Database error in task-status", {
        error: dbError instanceof Error ? dbError.message : String(dbError),
      });
      return json({ statuses: {} as Record<string, string>, error: "Database error" }, { status: 500 });
    }
  } catch (authError: unknown) {
    return handlePolledAuthError(authError, { statuses: {} });
  }
};
