/**
 * Task Recovery Service (Standalone)
 * Recovers pending/queued tasks after server restart
 * This file is imported directly by server.js and not processed by Remix build
 */

import { PrismaClient } from "@prisma/client";
import { refundImageOperations } from "./image-op-refund.js";

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
// These task types get a much larger threshold; everything else (incl.
// imageWebpConversion, which has its own 4-min internal timeout + dedicated
// recovery) keeps the default. Env-overridable.
const LONG_TASK_TIMEOUT_MS = parseInt(process.env.LONG_TASK_TIMEOUT_MS || String(45 * 60 * 1000), 10);
const LONG_RUNNING_TASK_TYPES = [
  'bulkTranslation',
  'bulkAIGeneration',
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
  // Storefront crawler / site audit (PLAN_SEO_SUITE_COMPLETION.md §3.5,
  // Phase 1, seo-crawl.handler.ts) — a live BFS crawl of up to 2000 pages
  // (5 parallel requests, ~200ms spacing, 10s timeout + one retry on
  // 5xx/timeout) can legitimately run for many minutes on a large shop, so it
  // needs the same generous stuck-task threshold as the other detached scans.
  'seoCrawl',
  // Internal-linking suggestions (PLAN_SEO_SUITE_COMPLETION.md §4.3, Phase 2,
  // internal-links.handler.ts) — a synonym LLM call per target product/
  // collection (up to a few hundred) followed by an LLM-free cheerio match
  // loop over every article/page/product body, same fan-out shape as
  // seoBulkFix, so it needs the same generous stuck-task threshold.
  'seoInternalLinks',
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

    console.log(`[TaskRecovery] Starting stuck task monitoring (every ${Math.round(STUCK_CHECK_INTERVAL_MS / 60000)} min; stuck threshold ${Math.round(STUCK_TASK_TIMEOUT_MS / 60000)} min)`);

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

    console.log(`[TaskRecovery] Recovery complete: ${resetCount} reset to queued, ${stuckCount} marked as failed, ${webpRecovered.retried} WebP retried, ${webpRecovered.failed} WebP flagged`);

    return { recovered: resetCount, failed: stuckCount, webpRetried: webpRecovered.retried, webpFailed: webpRecovered.failed };
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
   */
  async recoverRunningWebpTasks() {
    const tasks = await prisma.task.findMany({
      where: { type: 'imageWebpConversion', status: 'running' },
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

    // R3-C4: each stuck imageWebpConversion task consumed an image op at
    // batch creation, so we must refund it when WE flip it to 'failed'.
    // We select rows (incl. type+shop), then updateMany ONLY those ids that
    // are still non-terminal, and refund webp rows. Once 'failed' a row no
    // longer matches the selector, so a later pass cannot re-select /
    // double-refund (idempotent across runs, same guarantee as before).
    const refundByShop = new Map();
    let total = 0;

    // Reap one selector in bounded batches so a single statement can never
    // flip an unbounded number of rows (R4-H2 batch cap).
    const reapBatched = async (where) => {
      for (;;) {
        const rows = await prisma.task.findMany({
          where,
          select: { id: true, shop: true, type: true },
          take: STUCK_REAP_BATCH,
        });
        if (rows.length === 0) break;
        const res = await prisma.task.updateMany({
          where: { id: { in: rows.map((r) => r.id) }, status: { in: NON_TERMINAL } },
          data: {
            status: 'failed',
            error: 'Task timed out - no progress within the stuck threshold',
            completedAt: new Date(),
          },
        });
        total += res.count;
        for (const r of rows) {
          if (r.type === 'imageWebpConversion') {
            refundByShop.set(r.shop, (refundByShop.get(r.shop) ?? 0) + 1);
          }
        }
        if (rows.length < STUCK_REAP_BATCH) break;
      }
    };

    // Pass 1: legitimately-long types — only stuck after the LONG cutoff.
    await reapBatched({
      type: { in: LONG_RUNNING_TASK_TYPES },
      status: { in: NON_TERMINAL },
      updatedAt: { lt: longCutoff },
    });

    // Pass 2: everything else (incl. imageWebpConversion) — default cutoff.
    await reapBatched({
      type: { notIn: LONG_RUNNING_TASK_TYPES },
      status: { in: NON_TERMINAL },
      updatedAt: { lt: defaultCutoff },
    });

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
