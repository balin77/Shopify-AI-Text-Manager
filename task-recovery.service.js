/**
 * Task Recovery Service (Standalone)
 * Recovers pending/queued tasks after server restart
 * This file is imported directly by server.js and not processed by Remix build
 */

import { PrismaClient } from "@prisma/client";
import { refundImageOperations } from "./image-op-refund.js";
import {
  WEBP_NON_TERMINAL_STATUS,
  WEBP_PARENT_TASK_TYPE,
  isWebpWorkRow,
  webpWorkRowWhere,
} from "./app/config/webp-tasks.js";
import {
  HEARTBEAT_TASK_TYPES,
  HEARTBEAT_STALL_MS,
  recoverOrphanedRuns,
  reconcileOrphanCrawlSnapshots,
} from "./orphan-run-recovery.js";

// Reuse the global PrismaClient shared with the Remix app (db.server.ts)
// instead of creating a separate instance with its own connection pool.
const prisma = globalThis.__db ?? new PrismaClient();
if (!globalThis.__db) globalThis.__db = prisma;

// R4-H2: a task is "stuck" only if its updatedAt has not advanced for this
// long. ANY running/pending/queued task older than this is blanket-failed,
// so a LEGITIMATELY long task is killed unless it heartbeats. Contract:
// long-running task handlers MUST bump updatedAt periodically (a progress
// write does this; webp-processor heartbeats explicitly and is also
// recovered before this reaper runs). Env-overridable so an operator can
// raise it for shops with legitimately long bulk jobs without a redeploy.
const STUCK_TASK_TIMEOUT_MS = parseInt(process.env.STUCK_TASK_TIMEOUT_MS || String(10 * 60 * 1000), 10);

// Check for stuck tasks on this interval (env-configurable; default 5 min).
const STUCK_CHECK_INTERVAL_MS = parseInt(process.env.STUCK_CHECK_INTERVAL_MS || String(5 * 60 * 1000), 10);

// R4-H2 (core): a SINGLE global 10-min threshold mis-classifies legitimately
// long bulk AI work (translating a large catalog across many locales, bulk
// generation, alt-text-template apply) as "stuck" and kills it mid-run.
// These task types get a much larger threshold; everything else (incl. the
// WebP types — a work item has its own 4-min internal timeout + dedicated
// recovery, and an aggregate row is heartbeated by the processor for as long
// as any of its items is still open) keeps the default. Env-overridable.
const LONG_TASK_TIMEOUT_MS = parseInt(process.env.LONG_TASK_TIMEOUT_MS || String(45 * 60 * 1000), 10);
const LONG_RUNNING_TASK_TYPES = [
  // A renamed blog gets one redirect per article, and Shopify redirects have
  // no wildcards — a 200-article blog is 200 lookups plus 200 creates through
  // a rate-limited API. Minutes, not seconds, so the short stuck-threshold
  // would reap it while it is working (PLAN_CONTENT_CREATION §Phase 3.3).
  'blogArticleRedirects',
  'bulkTranslation',
  // The SAME task type, spelled two ways, and both must be listed. The
  // alt-text paths create `bulkAIGeneration` (alt-text.handler.ts L227,
  // alt-text.action.ts L247); the notification-title generator creates
  // `bulkAiGeneration` (template-titles.handler.ts L89) — an AI call per batch
  // over every untitled row, i.e. exactly the minutes-long shape this list
  // exists for, which was reaped at the 10-minute default and marked stuck
  // mid-flight. NEITHER may be renamed: running rows carry the old string, and
  // the reaper matches the string it finds in the database.
  'bulkAIGeneration',
  'bulkAiGeneration',
  'altTextTemplateApply',
  'translation',
  'aiGeneration',
  'aiFormatting',
  'templates',
  'metaobjects',
  'menus',
  // SEO Audit Dashboard "Fix with AI" bulk action (seo-bulk-fix.handler.ts) —
  // up to 100 sequential AI generations + Shopify saves, same shape as
  // bulkAIGeneration, so it needs the same generous stuck-task threshold.
  'seoBulkFix',
  // SEO Audit Dashboard "Rescan" action (seo-audit.handler.ts) — a full
  // content-cache scan (up to 4×1000 rows + groupBys) can run long on large
  // shops; give it the same generous stuck-task threshold as other detached
  // Task runners rather than the short default cutoff.
  'seoAudit',
  // Manual bulk-meta editor's large-batch save (Anhang C3, seo-bulk-meta.handler.ts) —
  // up to 500 sequential Shopify saves + DB updates, same shape as seoBulkFix
  // minus the AI call, so it needs the same generous stuck-task threshold.
  'seoBulkMeta',
  // Bulk editor "Translate missing" (PLAN_BULK_EDITOR.md §6.5,
  // bulk-editor-translate.handler.ts) — up to 500 sequential AI translations
  // plus (in save mode) verified translationsRegister writes, same shape as
  // seoBulkFix, so it needs the same generous stuck-task threshold.
  'bulkEditorTranslate',
  // AI keyword distribution (PLAN_KEYWORDS_EXPANSION.md §5.4,
  // keyword-distribution.handler.ts) — dozens of sequential LLM batch calls
  // (suggest stage) or hundreds of DB upserts (apply stage), same shape as
  // seoBulkFix, so it needs the same generous stuck-task threshold.
  'distributeKeywords',
  // JSON-LD batch audit (PLAN_SEO_SUITE_COMPLETION.md §7, Phase 5,
  // seo-json-ld-audit.handler.ts) — builds + validates JSON-LD for every
  // cached product/collection/article (up to 3×1000 rows), same DB-cache
  // scan shape as seoAudit, so it needs the same generous stuck-task
  // threshold rather than the short default cutoff.
  'seoJsonLdAudit',
  // Internal-linking suggestions (PLAN_SEO_SUITE_COMPLETION.md §4.3, Phase 2,
  // internal-links.handler.ts) — a synonym LLM call per target product/
  // collection (up to a few hundred) followed by an LLM-free cheerio match
  // loop over every article/page/product body, same fan-out shape as
  // seoBulkFix, so it needs the same generous stuck-task threshold.
  'seoInternalLinks',
  // Deliberately NOT here: 'seoCrawl'. It is a HEARTBEAT type
  // (orphan-run-recovery.js) and is reaped on the much shorter heartbeat
  // threshold instead — a crawl writes Task.progress at least every 10s through
  // every phase, so silence means the runner died. Until it is reaped,
  // single-flight refuses every new crawl and the crawl page shows a scan that
  // never finishes: 45 minutes of that is the hang a redeploy used to produce.
];

// R4-H2 (core): cap how many rows a single reaper pass flips per statement
// (the old blanket updateMany had no bound). Loop until drained.
const STUCK_REAP_BATCH = Math.max(1, parseInt(process.env.STUCK_REAP_BATCH || '500', 10));
const NON_TERMINAL = ['running', 'pending', 'queued'];

export class TaskRecoveryService {
  static instance = null;
  stuckCheckInterval = null;

  constructor() {}

  static getInstance() {
    if (!TaskRecoveryService.instance) {
      TaskRecoveryService.instance = new TaskRecoveryService();
    }
    return TaskRecoveryService.instance;
  }

  /**
   * Start periodic check for stuck tasks
   * This should be called once at server startup after initial recovery
   */
  startStuckTaskMonitoring() {
    if (this.stuckCheckInterval) {
      console.log('[TaskRecovery] Stuck task monitoring already running');
      return;
    }

    console.log(`[TaskRecovery] Starting stuck task monitoring (every ${Math.round(STUCK_CHECK_INTERVAL_MS / 60000)} min; stuck threshold ${Math.round(STUCK_TASK_TIMEOUT_MS / 60000)} min, heartbeat types ${Math.round(HEARTBEAT_STALL_MS / 60000)} min)`);

    this.stuckCheckInterval = setInterval(async () => {
      try {
        const stuckCount = await this.markStuckTasksAsFailed();
        if (stuckCount > 0) {
          console.log(`[TaskRecovery] Periodic check: marked ${stuckCount} stuck task(s) as failed`);
        }
      } catch (error) {
        console.error('[TaskRecovery] Error during stuck task check:', error);
      }
    }, STUCK_CHECK_INTERVAL_MS);
  }

  /**
   * Stop the stuck task monitoring
   */
  stopStuckTaskMonitoring() {
    if (this.stuckCheckInterval) {
      clearInterval(this.stuckCheckInterval);
      this.stuckCheckInterval = null;
      console.log('[TaskRecovery] Stopped stuck task monitoring');
    }
  }

  /**
   * Recover all pending tasks after server restart
   * Called once at server startup
   */
  async recoverPendingTasks() {
    console.log('[TaskRecovery] Starting task recovery...');

    // Recover WebP tasks that were "running" when the server stopped, BEFORE
    // markStuckTasksAsFailed would blanket-fail them. Step boundaries inside
    // webp-processor.service.js processTask determine whether a partial run
    // is safe to retry or must be flagged for manual review.
    const webpRecovered = await this.recoverRunningWebpTasks();

    // …and keep the aggregate row ABOVE them out of the reaper that runs three
    // lines down. Nothing bumped its `updatedAt` while the process was down, so
    // a restart that took longer than the stuck threshold (a slow redeploy)
    // would flip a batch to `failed` — permanently, since the settlement is
    // guarded on a non-terminal status — and hand the merchant a red "timed
    // out" for a run whose twenty images then convert successfully. Its items
    // were just reset or flagged above; whichever of the two, the processor's
    // first poll settles the batch from what they really are.
    await this.touchOpenWebpBatches();

    // A detached runner cannot outlive its process, so every `running`
    // heartbeat-type row we find while booting belongs to a process that is
    // gone — no age check here (orphan-run-recovery.js, rule 2). This is what
    // makes a crawl interrupted by a redeploy restartable immediately instead
    // of after the reaper's timeout, and it closes the SeoCrawlSnapshot the
    // reaper never touched.
    const orphaned = await this.recoverOrphanedDetachedRuns();

    // Mark stuck tasks as failed
    const stuckCount = await this.markStuckTasksAsFailed();

    // Reset queued/pending tasks so they can be retried.
    // DELIBERATE: we do NOT auto-re-enqueue AI tasks here. Re-enqueueing
    // needs per-shop AI settings + provider keys + queue rate limits, which
    // must be resolved in a user/request context, not blindly from a
    // background restart hook. This standalone service SUPERSEDES the old
    // src/services/task-recovery.service.ts (deleted), whose recoverTask()/
    // queue.enqueueFromTask() did exactly that background auto-requeue — it
    // was never wired into server.js (server.js only loads THIS .js) and was
    // intentionally dropped. Tasks left "queued" are re-driven on the next
    // user interaction instead.
    const resetCount = await this.resetPendingTasks();

    console.log(`[TaskRecovery] Recovery complete: ${resetCount} reset to queued, ${stuckCount} marked as failed, ${orphaned.tasks} orphaned run(s) + ${orphaned.snapshots} crawl snapshot(s) closed, ${webpRecovered.retried} WebP retried, ${webpRecovered.failed} WebP flagged`);

    return {
      recovered: resetCount,
      failed: stuckCount,
      orphaned: orphaned.tasks,
      orphanedSnapshots: orphaned.snapshots,
      webpRetried: webpRecovered.retried,
      webpFailed: webpRecovered.failed,
    };
  }

  /**
   * Boot-time half of the orphan rule: fail heartbeat-type runs regardless of
   * age and close the crawl snapshots behind them.
   *
   * Multi-instance caveat (same class as the R4-C2 note in server.js): with
   * more than one replica, a booting instance would reap a run that is alive on
   * another one. The app is deployed as a single web process; a run that IS
   * still alive elsewhere is a run whose container is being replaced anyway,
   * and its own finalizer keeps writing its own terminal state.
   */
  async recoverOrphanedDetachedRuns() {
    // Never let this abort the rest of the boot recovery (and with it the
    // monitoring interval that would clean up later): a failure here costs one
    // delayed reap, a thrown one costs the reaper.
    const result = await recoverOrphanedRuns(prisma, { olderThan: null }).catch((error) => {
      console.error('[TaskRecovery] Orphaned-run recovery failed:', error);
      return { tasks: 0, snapshots: 0, shops: [] };
    });
    if (result.tasks > 0 || result.snapshots > 0) {
      console.log(
        `[TaskRecovery] Orphaned detached runs: ${result.tasks} task(s) failed, ` +
          `${result.snapshots} crawl snapshot(s) closed`,
      );
    }
    return result;
  }

  /**
   * Give every open WebP batch a fresh heartbeat at boot.
   *
   * Deliberately unconditional: a batch whose items are ALL terminal is settled
   * by the processor's next poll (seconds), and one whose items are gone is
   * failed by the same sweep once past its grace period — so the only thing
   * this can delay is a verdict that something else is about to write anyway.
   * The reverse mistake, reaping a live batch, is not recoverable.
   */
  async touchOpenWebpBatches() {
    try {
      const res = await prisma.task.updateMany({
        where: {
          type: WEBP_PARENT_TASK_TYPE,
          total: { not: null },
          status: { in: WEBP_NON_TERMINAL_STATUS },
        },
        data: { updatedAt: new Date() },
      });
      if (res.count > 0) {
        console.log(`[TaskRecovery] Kept ${res.count} open WebP batch(es) alive across the restart`);
      }
      return res.count;
    } catch (error) {
      console.error('[TaskRecovery] Failed to heartbeat open WebP batches:', error);
      return 0;
    }
  }

  /**
   * Recover WebP conversion tasks that were "running" at server stop.
   *
   * Step boundaries (progress field, set in webp-processor.service.js processTask):
   *   <70:   nothing changed on Shopify yet -> safe to retry (reset to pending)
   *   70-89: new WebP may already exist on Shopify -> retry would duplicate
   *   >=90:  old PNG already deleted on Shopify, only DB swap missing -> manual review
   *
   * retryCount is capped at 3 to prevent loops when the underlying source is broken.
   *
   * WORK ITEMS ONLY (`webpWorkRowWhere`: the `imageWebpConversionItem` rows this
   * build creates plus the pre-split rows an older one wrote under the parent
   * type). The aggregate row deliberately does NOT come through here: its
   * `progress` is percent-of-batch and has none of the step meaning above, and
   * resetting it to `pending` would hand the processor an aggregate to run as
   * an image. An open batch needs no boot recovery — its items are reset or
   * flagged here, and the processor's first poll settles the parent from them.
   */
  async recoverRunningWebpTasks() {
    const tasks = await prisma.task.findMany({
      where: webpWorkRowWhere({ status: 'running' }),
      select: { id: true, progress: true, retryCount: true, shop: true },
    });

    let retried = 0;
    let failed = 0;
    for (const t of tasks) {
      if ((t.progress ?? 0) < 70 && (t.retryCount ?? 0) < 3) {
        await prisma.task.update({
          where: { id: t.id },
          data: {
            status: 'pending',
            retryCount: { increment: 1 },
            error: null,
            progress: 0,
          },
        });
        retried++;
      } else {
        await prisma.task.update({
          where: { id: t.id },
          data: {
            status: 'failed',
            completedAt: new Date(),
            error: `Server restarted at progress ${t.progress ?? 0} — partial Shopify state, manual review needed`,
          },
        });
        failed++;
        // R3-C4: this task consumed an image op at batch creation but
        // produced no result. Refund it (the status:'running' query filter
        // means a re-run won't re-select/double-refund this now-'failed'
        // task). The retry branch above intentionally does NOT refund — it
        // will run again.
        await refundImageOperations(prisma, t.shop, 1);
      }
    }

    if (retried > 0 || failed > 0) {
      console.log(`[TaskRecovery] WebP running-task recovery: ${retried} retried, ${failed} flagged for review`);
    }

    return { retried, failed };
  }

  /**
   * Mark tasks stuck in "running" or "pending" status as failed
   * A task is considered stuck if it's been running/pending for more than 10 minutes without update
   *
   * R4-DI9 — known, ACCEPTED reaper↔finalizer interaction (LOW, not fixed):
   * task finalizers across the app call `task.update({ where: { id } })`
   * WITHOUT a status precondition. If a genuinely-slow task is reaped here
   * (running → failed) and then finishes, its finalizer can overwrite that
   * back to completed/failed (a "lost transition"). This is intentionally
   * left as-is: it is observability-only — the task's actual side effects
   * (Shopify writes / DB upserts) are independent of the row's status and
   * are themselves idempotent, so no data is lost or duplicated; only the
   * final status label can thrash for one >10-min task. The proportionate
   * fix is NOT a status precondition sprinkled over ~100 update sites (risky,
   * for a cosmetic edge); if a STRICTER reaper is ever added (one whose
   * decision must be authoritative), make finalizers monotonic via
   * `updateMany({ where: { id, status: { notIn: TERMINAL } } })` instead —
   * see the matching note in src/services/task-recovery.service.ts.
   */
  async markStuckTasksAsFailed() {
    const now = Date.now();
    const defaultCutoff = new Date(now - STUCK_TASK_TIMEOUT_MS);
    const longCutoff = new Date(now - LONG_TASK_TIMEOUT_MS);
    const heartbeatCutoff = new Date(now - HEARTBEAT_STALL_MS);

    // R3-C4: each stuck WebP WORK ITEM consumed an image op at batch creation,
    // so we must refund it when WE flip it to 'failed'.
    // We select rows (incl. type+shop), then updateMany ONLY those ids that
    // are still non-terminal, and refund webp rows. Once 'failed' a row no
    // longer matches the selector, so a later pass cannot re-select /
    // double-refund (idempotent across runs, same guarantee as before).
    //
    // The AGGREGATE row spent nothing: its items each spent one and each refund
    // themselves, here or in the processor. Refunding for it too would give a
    // twenty-image batch twenty-one operations back, and refunding for it
    // INSTEAD (which is what "one row per conversion" would have meant) would
    // give the merchant one image's quota back for a run of twenty. That is why
    // `total` is in the select — it is what tells an aggregate row from a
    // pre-split row of the same type (app/config/webp-tasks.js).
    const refundByShop = new Map();
    let total = 0;

    // Reap one selector in bounded batches so a single statement can never
    // flip an unbounded number of rows (R4-H2 batch cap).
    const reapBatched = async (where) => {
      for (;;) {
        const rows = await prisma.task.findMany({
          where,
          select: { id: true, shop: true, type: true, total: true },
          take: STUCK_REAP_BATCH,
        });
        if (rows.length === 0) break;
        const res = await prisma.task.updateMany({
          where: { id: { in: rows.map((r) => r.id) }, status: { in: NON_TERMINAL } },
          data: {
            status: 'failed',
            // Machine code, not prose: this runs outside any request, so there
            // is no merchant locale here. The UI translates it via
            // app/utils/task-error-text.ts (`taskTimedOut`).
            error: 'task_timed_out',
            completedAt: new Date(),
          },
        });
        total += res.count;
        for (const r of rows) {
          if (isWebpWorkRow(r)) {
            refundByShop.set(r.shop, (refundByShop.get(r.shop) ?? 0) + 1);
          }
        }
        if (rows.length < STUCK_REAP_BATCH) break;
      }
    };

    // Pass 0: heartbeat types (orphan-run-recovery.js) — their runner reports
    // progress at a bounded interval, so a gap this long is evidence the
    // process is gone rather than of a long-running job. Reaped here rather
    // than in pass 1 because a 45-minute wait IS the hang for a task whose
    // single-flight blocks the merchant from starting a new one.
    await reapBatched({
      type: { in: HEARTBEAT_TASK_TYPES },
      status: { in: NON_TERMINAL },
      updatedAt: { lt: heartbeatCutoff },
    });

    // Pass 1: legitimately-long types — only stuck after the LONG cutoff.
    await reapBatched({
      type: { in: LONG_RUNNING_TASK_TYPES, notIn: HEARTBEAT_TASK_TYPES },
      status: { in: NON_TERMINAL },
      updatedAt: { lt: longCutoff },
    });

    // Pass 2: everything else (incl. imageWebpConversion) — default cutoff.
    await reapBatched({
      type: { notIn: [...LONG_RUNNING_TASK_TYPES, ...HEARTBEAT_TASK_TYPES] },
      status: { in: NON_TERMINAL },
      updatedAt: { lt: defaultCutoff },
    });

    // The snapshot half of a reaped crawl. Runs on every pass, not just at
    // boot: a crawl that times out here leaves the same open SeoCrawlSnapshot
    // as one killed by a redeploy, and an open snapshot is what makes the
    // newest crawl read as zero pages.
    const closedSnapshots = await reconcileOrphanCrawlSnapshots(prisma).catch((err) => {
      console.error('[TaskRecovery] Failed to close orphaned crawl snapshots:', err);
      return 0;
    });
    if (closedSnapshots > 0) {
      console.log(`[TaskRecovery] Closed ${closedSnapshots} orphaned crawl snapshot(s)`);
    }

    if (total > 0) {
      console.log(`[TaskRecovery] Marked ${total} stuck task(s) as failed`);
    }

    for (const [shop, n] of refundByShop) {
      await refundImageOperations(prisma, shop, n);
    }

    return total;
  }

  /**
   * Reset pending tasks to queued status
   * Tasks that were "pending" when the server restarted are reset to "queued"
   * so the queue processor will pick them up again
   */
  async resetPendingTasks() {
    const result = await prisma.task.updateMany({
      where: {
        status: 'pending',
        expiresAt: { gt: new Date() }, // Not expired
      },
      data: {
        status: 'queued',
        error: null,
      },
    });

    if (result.count > 0) {
      console.log(`[TaskRecovery] Reset ${result.count} pending task(s) to queued`);
    }

    return result.count;
  }
}
