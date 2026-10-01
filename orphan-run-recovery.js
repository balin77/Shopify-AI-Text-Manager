/**
 * Orphaned detached runs — the ONE place that decides a run is dead.
 *
 * A crawl (and every other "detached runner" task in this app) is a
 * fire-and-forget promise inside the web process: `startCrawlRun` creates the
 * Task row plus the SeoCrawlSnapshot row and then returns, while `runCrawl`
 * keeps fetching for minutes. Nothing outside that process knows about it. So
 * the moment the process goes away — a Railway redeploy of a new app version,
 * an OOM kill, a crash — the runner is gone while BOTH rows still say
 * "running", and nothing ever writes their terminal state:
 *
 *   • `startCrawlRun`'s single-flight refuses every new crawl
 *     ("A site crawl is already running"), so the merchant cannot restart it;
 *   • `loadLatestSnapshot` reports `running: true`, so the crawl page shows
 *     "Crawl läuft — wird automatisch aktualisiert…" forever and disables the
 *     scan button;
 *   • the weekly sweep stamps `lastAutoCrawlAt` and skips the shop;
 *   • and the newest snapshot is an EMPTY one (pages are persisted in a single
 *     bulk insert at the very end of `runCrawl`), so the report reads as zero
 *     pages instead of showing the last complete crawl.
 *
 * The old safety net was the stuck-task reaper's 45-minute `LONG_TASK_TIMEOUT_MS`
 * — three quarters of an hour of exactly the hang above, and it never touched
 * the snapshot row at all, which therefore stayed "running" for good.
 *
 * Two rules, and the difference between them is the whole design:
 *
 *  1. HEARTBEAT types (`HEARTBEAT_TASK_TYPES`) report progress at a BOUNDED
 *     interval — the crawl writes `Task.progress` at least every 10s inside the
 *     fetch loop, at every boundary of the post-crawl tail, and throughout the
 *     external-link pass. For those, silence longer
 *     than `heartbeatStallMs` means the runner is gone, not that it is busy.
 *     A type that can legitimately go quiet for minutes (a bulk AI job between
 *     two provider calls) must NOT be listed here: it keeps the generous
 *     `LONG_TASK_TIMEOUT_MS` threshold.
 *  2. At BOOT the age check is dropped entirely (`olderThan: null`), because a
 *     detached runner cannot outlive its process: any `running` row we find
 *     while starting up belongs to a process that no longer exists.
 *
 * Lives at the repo root, imports nothing, and takes the Prisma client as an
 * argument, so the standalone boot recovery (task-recovery.service.js, outside
 * the React Router bundle) and the app itself (crawl-run.server.ts, inside it)
 * share one implementation. Two copies of "is this run dead" is how one of them
 * ends up reaping a task whose snapshot the other one leaves open.
 */

/** `Task.error` code — a machine code, not prose: this runs outside any request,
 *  so there is no merchant locale here. Rendered via app/utils/task-error-text.ts. */
export const INTERRUPTED_TASK_ERROR = "task_interrupted";

/** `SeoCrawlSnapshot.error` code for the same event (see `parseCrawlError`). */
export const INTERRUPTED_SNAPSHOT_ERROR = "interrupted";

/**
 * Task types whose runner writes progress at a bounded interval, so a gap is
 * evidence of death rather than of work. Keep this list short and only add a
 * type whose handler actually guarantees the cadence.
 */
export const HEARTBEAT_TASK_TYPES = ["seoCrawl"];

/**
 * Longest silence a heartbeat-type run may have before it counts as orphaned.
 *
 * The crawl's own ceiling inside the fetch loop is 10s
 * (HEARTBEAT_MAX_INTERVAL_MS in crawl.service.ts) and its post-crawl tail beats
 * at every boundary (URL resolve, head drift, bulk insert), so the longest
 * silence a HEALTHY run can produce is one DB round trip over `maxPages` rows.
 * Five minutes is an order of magnitude above that: the cost of being wrong here
 * is not a delayed cleanup but a LIVE crawl reaped mid-run — its snapshot closed
 * under it and single-flight opened for a second crawl against the same
 * storefront. The deploy case does not depend on this number at all (boot
 * recovery drops the age check), so headroom is nearly free.
 *
 * Env-overridable so an operator can raise it without a redeploy.
 */
export const HEARTBEAT_STALL_MS = Math.max(
  60_000,
  parseInt(process.env.HEARTBEAT_TASK_TIMEOUT_MS || String(5 * 60 * 1000), 10) || 5 * 60 * 1000,
);

const NON_TERMINAL = ["running", "pending", "queued"];

/**
 * Fail heartbeat-type tasks whose runner is gone.
 *
 * `olderThan` is the discriminator between the two callers: a Date means "only
 * rows that have been silent that long" (the periodic reaper, which runs while
 * live runs exist in this same process), `null` means "every one of them" (boot
 * recovery — see rule 2 in the header).
 *
 * `shops` scopes the sweep. Boot recovery leaves it out (the whole table is
 * orphaned at that point); a REQUEST-context caller must always pass its own
 * shop — an unscoped sweep from inside a request would fail another merchant's
 * live crawl, which is a multi-tenant leak, not a cleanup.
 *
 * Only `running` rows: `pending`/`queued` are the queue's business and are
 * reset by `resetPendingTasks`, not failed.
 */
/**
 * @param {any} prisma
 * @param {{ olderThan?: Date | null, types?: string[], shops?: string[] | null }} [options]
 * @returns {Promise<{ count: number, shops: string[] }>}
 */
export async function failOrphanedRuns(prisma, options = {}) {
  const { olderThan = null, types = HEARTBEAT_TASK_TYPES, shops = null } = options;
  // An EMPTY list means "no shops", never "every shop": a caller that computed
  // its scope and came up empty must sweep nothing. Reading it as unscoped is
  // how a multi-tenant guard fails open.
  if (shops && shops.length === 0) return { count: 0, shops: [] };
  const where = { type: { in: types }, status: "running" };
  if (olderThan) where.updatedAt = { lt: olderThan };
  if (shops) where.shop = { in: shops };

  const rows = await prisma.task.findMany({ where, select: { id: true, shop: true, type: true } });
  if (rows.length === 0) return { count: 0, shops: [] };

  // Re-check the status in the UPDATE: a run that finished between the select
  // and here must keep its own terminal state.
  const res = await prisma.task.updateMany({
    where: { id: { in: rows.map((r) => r.id) }, status: { in: NON_TERMINAL } },
    data: {
      status: "failed",
      error: INTERRUPTED_TASK_ERROR,
      completedAt: new Date(),
    },
  });

  return { count: res.count, shops: Array.from(new Set(rows.map((r) => r.shop))) };
}

/**
 * Close `SeoCrawlSnapshot` rows left "running" with no crawl behind them.
 *
 * The snapshot is the second half of the same orphan and the half no reaper
 * ever touched: it is what `loadLatestSnapshot` reads, so leaving it open makes
 * the newest crawl an empty one forever. "No running `seoCrawl` task for this
 * shop" is the test — single-flight means one crawl per shop, so once the task
 * is terminal every still-open snapshot of that shop is an orphan.
 *
 * It is marked `failed` rather than deleted: the crawl page already knows how to
 * render a failed snapshot (empty report + the reason), and deleting rows to
 * hide a failure is how a merchant ends up with no explanation for why nothing
 * changed.
 */
/**
 * @param {any} prisma
 * @param {string[] | null} [shops] `null` sweeps the whole table; `[]` sweeps nothing.
 * @returns {Promise<number>}
 */
export async function reconcileOrphanCrawlSnapshots(prisma, shops = null) {
  // Same rule as `failOrphanedRuns`: `[]` scopes to nothing, `null` is the
  // deliberate table-wide sweep.
  if (shops && shops.length === 0) return 0;
  const openWhere = { status: "running" };
  if (shops) openWhere.shop = { in: shops };

  const open = await prisma.seoCrawlSnapshot.findMany({
    where: openWhere,
    select: { id: true, shop: true },
  });
  if (open.length === 0) return 0;

  const liveShops = new Set(
    (
      await prisma.task.findMany({
        where: {
          type: "seoCrawl",
          status: "running",
          shop: { in: Array.from(new Set(open.map((s) => s.shop))) },
        },
        select: { shop: true },
      })
    ).map((t) => t.shop),
  );

  const orphanIds = open.filter((s) => !liveShops.has(s.shop)).map((s) => s.id);
  if (orphanIds.length === 0) return 0;

  const res = await prisma.seoCrawlSnapshot.updateMany({
    // Same precondition as above: never overwrite a status somebody else settled.
    where: { id: { in: orphanIds }, status: "running" },
    data: {
      status: "failed",
      error: INTERRUPTED_SNAPSHOT_ERROR,
      finishedAt: new Date(),
    },
  });
  return res.count;
}

/**
 * Both halves, in the order they have to happen: the task first, then the
 * snapshots (which read the task status to decide what is an orphan).
 *
 * `olderThan` and `shops` are passed straight through — see `failOrphanedRuns`.
 * Unscoped (boot recovery), the snapshot half sweeps the whole table on
 * purpose: a snapshot can be orphaned while its task was already reaped by an
 * earlier pass — or by the 45-minute reaper before this module existed, which
 * never touched snapshots at all — and those rows would otherwise stay open for
 * good.
 */
/**
 * @param {any} prisma
 * @param {{ olderThan?: Date | null, types?: string[], shops?: string[] | null }} [options]
 * @returns {Promise<{ tasks: number, snapshots: number, shops: string[] }>}
 */
export async function recoverOrphanedRuns(prisma, options = {}) {
  const { count, shops: failedShops } = await failOrphanedRuns(prisma, options);
  const snapshots = await reconcileOrphanCrawlSnapshots(prisma, options.shops ?? null);
  return { tasks: count, snapshots, shops: failedShops };
}
