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
 * Detached runners that write a liveness heartbeat from a TIMER (every 15 s,
 * independent of their progress, because a bulk AI job may make no progress
 * for minutes between two provider calls) and cannot outlive their process.
 * At boot they are failed only once silent for BOOT_SILENCE_MS (a live run in
 * another container during a deploy keeps beating), and the periodic reaper
 * fails them after the heartbeat stall threshold with `task_interrupted`
 * instead of the 45-minute rule. Without that a restart in the middle of a
 * run left the Task "running" for ~45-50 minutes and single-flight refused a
 * new run for all that time.
 * Keep this list to types whose run is a fire-and-forget promise in the web
 * process and whose rerun is safe.
 */
export const BOOT_ORPHAN_TASK_TYPES = ["bulkEditorTranslate"];

/**
 * Boot recovery fails a BOOT type only after this silence. The runner heartbeats every 15 s
 * (bulk-editor-translate.handler.ts), so a run that is alive in ANOTHER container during a zero-downtime deploy
 * overlap (railway.json drainingSeconds) is never failed by the new one; a run killed with its process falls
 * silent and is failed here when the silence has passed, else by the periodic reaper (heartbeat stall).
 */
export const BOOT_SILENCE_MS = 90_000;

/** What boot recovery fails: heartbeat types plus the boot-only ones. */
export const BOOT_RECOVERY_TASK_TYPES = [...HEARTBEAT_TASK_TYPES, ...BOOT_ORPHAN_TASK_TYPES];

/**
 * Task types that can WAIT for a provider batch (PLAN_BULK_TRANSLATE_BATCHING
 * 19.4). Their open states are `submitting`, `waiting_batch` and
 * `cancel_requested` (app/config/task-statuses.js), and the recovery here
 * treats them in two different ways on purpose:
 *
 *  - `waiting_batch` / `cancel_requested` are NEVER touched. Nothing in this
 *    process "runs" a waiting batch -- the provider holds it and its state
 *    lives in BulkTranslateBatch -- so "no heartbeat" is the normal condition,
 *    not evidence of death. Every `status: "running"` filter below (and the
 *    reaper's NON_TERMINAL list) simply does not match them; do not widen those
 *    filters to "any open status" or a restart would orphan every waiting
 *    batch.
 *  - `submitting` HAS a runner (it uploads / creates the batch and heartbeats).
 *    When that runner is gone, what happens depends on whether the provider
 *    batch id was PERSISTED: yes -> the run is a waiting batch after all
 *    (`waiting_batch`, nothing lost, the poller takes over); no -> there is
 *    nothing to wait for and the task fails as interrupted. The window between
 *    the provider's `create` and the saved id is a stated residual (19.10).
 */
export const BATCH_TASK_TYPES = ["bulkEditorTranslate"];

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
 * @param {{ olderThan?: Date | null, types?: string[], shops?: string[] | null, createdBefore?: Date | null, silentTypes?: { types: string[], silentMs: number } | null }} [options]
 * @returns {Promise<{ count: number, shops: string[] }>}
 */
export async function failOrphanedRuns(prisma, options = {}) {
  const { olderThan = null, types = HEARTBEAT_TASK_TYPES, shops = null, createdBefore = null, silentTypes = null } = options;
  // An EMPTY list means "no shops", never "every shop": a caller that computed
  // its scope and came up empty must sweep nothing. Reading it as unscoped is
  // how a multi-tenant guard fails open.
  if (shops && shops.length === 0) return { count: 0, shops: [] };
  const where = { type: { in: types }, status: "running" };
  if (olderThan) where.updatedAt = { lt: olderThan };
  // Only rows that existed BEFORE this process started: a request served in the seconds after listen() may
  // already have created a live run, and it is not an orphan.
  if (createdBefore) where.createdAt = { lt: createdBefore };
  // Types that must also have been SILENT for `silentMs` (they heartbeat; see BOOT_SILENCE_MS): the rest of
  // `types` is failed regardless of silence, exactly as before.
  if (silentTypes && silentTypes.types.length > 0) {
    const plain = types.filter((t) => !silentTypes.types.includes(t));
    const silentCutoff = new Date(Date.now() - silentTypes.silentMs);
    const clauses = [];
    if (plain.length > 0) clauses.push({ type: { in: plain } });
    clauses.push({ type: { in: silentTypes.types }, updatedAt: { lt: silentCutoff } });
    delete where.type;
    where.OR = clauses;
  }
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
 * Resolve `submitting` batch tasks whose submit runner is gone.
 *
 * `olderThan` (a Date) = only rows silent that long (the periodic reaper);
 * `silentMs` + `createdBefore` = the boot rule (existed before this process,
 * and silent for BOOT_SILENCE_MS so a run alive in another container during a
 * deploy overlap is left alone); neither = every one (a caller that knows no
 * runner can be alive). `shops` scopes; `[]` sweeps nothing.
 *
 * @param {any} prisma
 * @param {{ types?: string[], olderThan?: Date | null, createdBefore?: Date | null, silentMs?: number | null, shops?: string[] | null }} [options]
 * @returns {Promise<{ resumed: number, failed: number, shops: string[] }>}
 */
export async function recoverSubmittingBatchTasks(prisma, options = {}) {
  const { types = BATCH_TASK_TYPES, olderThan = null, createdBefore = null, silentMs = null, shops = null } = options;
  const none = { resumed: 0, failed: 0, shops: [] };
  if (shops && shops.length === 0) return none;
  const where = { type: { in: types }, status: "submitting" };
  if (olderThan) where.updatedAt = { lt: olderThan };
  else if (silentMs) where.updatedAt = { lt: new Date(Date.now() - silentMs) };
  if (createdBefore) where.createdAt = { lt: createdBefore };
  if (shops) where.shop = { in: shops };

  const rows = await prisma.task.findMany({ where, select: { id: true, shop: true } });
  if (rows.length === 0) return none;

  const batches = await prisma.bulkTranslateBatch.findMany({
    where: { taskId: { in: rows.map((r) => r.id) } },
    select: { taskId: true, batchIds: true },
  });
  const persisted = new Set(
    batches.filter((b) => Array.isArray(b.batchIds) && b.batchIds.length > 0).map((b) => b.taskId),
  );
  const resumeIds = rows.filter((r) => persisted.has(r.id)).map((r) => r.id);
  const failIds = rows.filter((r) => !persisted.has(r.id)).map((r) => r.id);

  let resumed = 0;
  let failed = 0;
  // The Task row and its batch row move TOGETHER: two separate updates that
  // died between them left a task `waiting_batch` over a batch row still
  // `submitting` (or the reverse), a pair no poller query matches. One
  // transaction where the client has one; the unit-test doubles have none.
  const together = async (fn) =>
    typeof prisma.$transaction === "function" ? prisma.$transaction(fn) : fn(prisma);
  // Conditional on the row still being `submitting`: a runner that finished
  // between the select and here keeps its own state.
  if (resumeIds.length > 0) {
    resumed = await together(async (tx) => {
      const res = await tx.task.updateMany({
        where: { id: { in: resumeIds }, status: "submitting" },
        data: { status: "waiting_batch" },
      });
      await tx.bulkTranslateBatch.updateMany({
        where: { taskId: { in: resumeIds }, state: "submitting" },
        data: { state: "waiting" },
      });
      return res.count;
    });
  }
  if (failIds.length > 0) {
    failed = await together(async (tx) => {
      const res = await tx.task.updateMany({
        where: { id: { in: failIds }, status: "submitting" },
        data: { status: "failed", error: INTERRUPTED_TASK_ERROR, completedAt: new Date() },
      });
      // The batch row is settled too ('done'), so the reservation sweep
      // (usage-meter.server.ts releaseSettledReservations) frees what the run
      // had reserved before it died.
      await tx.bulkTranslateBatch.updateMany({
        where: { taskId: { in: failIds }, state: "submitting" },
        data: { state: "done", lastError: INTERRUPTED_TASK_ERROR },
      });
      return res.count;
    });
  }
  return { resumed, failed, shops: Array.from(new Set(rows.map((r) => r.shop))) };
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
 * @param {{ olderThan?: Date | null, types?: string[], shops?: string[] | null, createdBefore?: Date | null, silentTypes?: { types: string[], silentMs: number } | null }} [options]
 * @returns {Promise<{ tasks: number, snapshots: number, shops: string[], resumedBatches: number }>}
 */
export async function recoverOrphanedRuns(prisma, options = {}) {
  const { count, shops: failedShops } = await failOrphanedRuns(prisma, options);
  const snapshots = await reconcileOrphanCrawlSnapshots(prisma, options.shops ?? null);

  // `submitting` batch tasks: only for a caller that NAMED a batch type (the
  // boot recovery does; the crawl's request-scoped sweep does not, and an
  // unscoped "every one" must never reach another feature's live submit).
  let submittingFailed = 0;
  let resumed = 0;
  const batchTypes = BATCH_TASK_TYPES.filter((type) => (options.types ?? HEARTBEAT_TASK_TYPES).includes(type));
  if (batchTypes.length > 0) {
    try {
      const silentMs = options.silentTypes?.types?.some((type) => batchTypes.includes(type))
        ? options.silentTypes.silentMs
        : null;
      const sub = await recoverSubmittingBatchTasks(prisma, {
        types: batchTypes,
        olderThan: options.olderThan ?? null,
        createdBefore: options.createdBefore ?? null,
        silentMs,
        shops: options.shops ?? null,
      });
      submittingFailed = sub.failed;
      resumed = sub.resumed;
    } catch (error) {
      // Never let this abort the rest of the recovery: a delayed resolution
      // of a submitting row costs a retry on the next pass.
      console.error("[OrphanRecovery] Resolving submitting batch tasks failed:", error);
    }
  }
  return { tasks: count + submittingFailed, snapshots, shops: failedShops, resumedBatches: resumed };
}
