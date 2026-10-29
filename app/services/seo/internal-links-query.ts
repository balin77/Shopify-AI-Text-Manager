/**
 * How the internal-linking suggestion list is sliced: the two views, the type
 * filters and the WHERE clause they turn into.
 *
 * Shared by the page's loader and the apply endpoint so that "everything that
 * is listed" means the same set in both — the bulk actions must never act on a
 * wider set than the merchant is looking at. Client-safe (plain data), because
 * the page also renders the filter options from FILTER_TYPES.
 */

export const FILTER_TYPES = ["Product", "Collection", "Article", "Page"] as const;
export type FilterType = (typeof FILTER_TYPES)[number];

export const VIEWS = ["open", "rejected"] as const;
export type View = (typeof VIEWS)[number];

/** URL `view` -> the DB status that view lists. */
export const VIEW_STATUS: Record<View, string> = { open: "pending", rejected: "dismissed" };

export function parseView(raw: string | null): View {
  return VIEWS.includes(raw as View) ? (raw as View) : "open";
}

export function parseTypeFilter(raw: string | null): FilterType | null {
  return FILTER_TYPES.includes(raw as FilterType) ? (raw as FilterType) : null;
}

/**
 * The listed set. Filters belong in SQL, not in the client — otherwise page 1
 * of a filtered list would only contain whatever survived filtering out of the
 * first unfiltered page.
 */
export function suggestionWhere(shop: string, view: View, fromFilter: FilterType | null, toFilter: FilterType | null) {
  return {
    shop,
    status: VIEW_STATUS[view],
    ...(fromFilter ? { fromResourceType: fromFilter } : {}),
    ...(toFilter ? { toResourceType: toFilter } : {}),
  };
}

/**
 * What the page says about the latest finished generation run. Without it a
 * run that found nothing, or one that failed, left the page exactly as it was
 * — the merchant pressed "Generieren", watched the spinner and saw no result
 * and no reason. Read from the run's own Task row (`result` is the runner's
 * InternalLinksSummary JSON, `error` its failure text).
 */
export type LastRunOutcome =
  | { status: "completed"; created: number; updated: number; sourcesScanned: number }
  | { status: "failed"; error: string };

/**
 * How long the latest run's "found nothing" / "failed" banner stays up on its
 * own. A weeks-old failure must not keep the page red for good; past this the
 * banner only shows again after a generate started in the current session.
 */
export const LAST_RUN_BANNER_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Whether the latest finished run is recent enough for its outcome banner.
 * Decided on the SERVER (the loader), so the first client render agrees with
 * the server's HTML. `completedAt` first, `updatedAt` for a row a reaper
 * closed without one; neither known ⇒ not recent.
 */
export function isRecentRun(
  task: { completedAt?: Date | null; updatedAt?: Date | null } | null | undefined,
  now: number,
  windowMs: number = LAST_RUN_BANNER_WINDOW_MS,
): boolean {
  const at = runFinishedAt(task);
  if (at === null) return false;
  return now - at <= windowMs;
}

/**
 * When a finished run finished, as epoch ms: `completedAt`, else `updatedAt`
 * for a row a reaper closed without one; `null` when neither is a real date.
 * The ONE answer to that question — `isRecentRun` and the choice of WHICH run
 * is the latest (`latestFinishedRun`) both read it, so the banner can never be
 * judged on one row while another one is reported.
 */
export function runFinishedAt(
  task: { completedAt?: Date | null; updatedAt?: Date | null } | null | undefined,
): number | null {
  const finished = task?.completedAt ?? task?.updatedAt ?? null;
  if (!finished) return null;
  const at = finished.getTime();
  return Number.isFinite(at) ? at : null;
}

/**
 * The latest finished run out of the loader's candidates. The loader cannot
 * ask Postgres for "ORDER BY COALESCE(completedAt, updatedAt) DESC" through
 * Prisma, and a plain `completedAt desc` puts NULLs FIRST in Postgres — so a
 * failed run a reaper closed without `completedAt`, weeks ago, outranked every
 * newer run and the page reported that old failure as the latest outcome. The
 * loader therefore fetches the newest row WITH `completedAt` and the newest
 * row WITHOUT it, and this picks between them by `runFinishedAt`. Ties go to
 * the earlier candidate (the one with a real `completedAt`).
 */
export function latestFinishedRun<T extends { completedAt?: Date | null; updatedAt?: Date | null }>(
  candidates: ReadonlyArray<T | null | undefined>,
): T | null {
  let best: T | null = null;
  let bestAt = -Infinity;
  for (const candidate of candidates) {
    if (!candidate) continue;
    const at = runFinishedAt(candidate);
    // A row with no usable time still beats having nothing at all.
    const rank = at ?? -Infinity;
    if (best === null || rank > bestAt) {
      best = candidate;
      bestAt = rank;
    }
  }
  return best;
}

export function parseLastRunOutcome(
  task: { status: string; result: string | null; error: string | null } | null | undefined,
): LastRunOutcome | null {
  if (!task) return null;
  if (task.status === "failed") return { status: "failed", error: (task.error || "").trim() };
  if (task.status !== "completed") return null;
  let summary: Record<string, unknown> = {};
  try {
    const parsed: unknown = task.result ? JSON.parse(task.result) : null;
    if (parsed && typeof parsed === "object") summary = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    status: "completed",
    created: num(summary.created),
    updated: num(summary.updated),
    sourcesScanned: num(summary.sourcesScanned),
  };
}
