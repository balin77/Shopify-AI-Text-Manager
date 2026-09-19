import { data as json, type LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { logger } from "~/utils/logger.server";
import { handlePolledAuthError } from "~/utils/polled-auth-error.server";

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

/** How many ids one call may ask about — a save's groups are capped at 25. */
const MAX_IDS = 50;

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
      return json({ statuses }, { headers: { "Cache-Control": "no-store" } });
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
