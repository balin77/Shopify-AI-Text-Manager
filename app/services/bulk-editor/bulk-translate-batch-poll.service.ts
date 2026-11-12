/**
 * The periodic tick that settles provider batches of "add missing translations"
 * (PLAN_BULK_TRANSLATE_BATCHING 5.4). Singleton with the same shape as
 * `TranslationDriftAutoRunService` / `OfflineTokenSweepService`: an idempotent
 * `start()` called from the app boot, an interval, an env switch, a re-entrancy
 * guard.
 *
 * WHY EVERY 5 MINUTES. A batch ends minutes to hours after submit (the provider
 * promises no more than 24 h), the merchant sees "waiting" until the tick finds
 * it ended, and a tick over the open rows is one indexed query plus one provider
 * status call per open batch. Faster buys the merchant little; slower makes a
 * result that arrived after four minutes wait for fifteen. Failed rows back off
 * (5, 10, 20, then 30 minutes), so a provider outage is not hammered.
 *
 * The decisions live in translate-batch-poll.server.ts; this class only ticks.
 * It is built for ONE instance like its siblings; with several instances the
 * lease on the batch row (compare-and-swap token) keeps two of them from
 * collecting the same batch.
 *
 * Disable without a redeploy: BULK_TRANSLATE_BATCH_POLL_DISABLED=true. The
 * absolute end of an open run (batch_unreachable after 48 h) is ALSO enforced
 * by the scheduler's daily cleanup, so switching the poll off does not leave
 * runs open for ever -- it only stops results from being collected.
 */

import { logger } from "~/utils/logger.server";
import { pollBatchesOnce, type PollStats } from "./translate-batch-poll.server";

const POLL_DISABLED = process.env.BULK_TRANSLATE_BATCH_POLL_DISABLED === "true";
const TICK_INTERVAL_MS = Math.max(
  30_000,
  parseInt(process.env.BULK_TRANSLATE_BATCH_POLL_INTERVAL_MS || String(5 * 60 * 1000), 10) || 5 * 60 * 1000,
);

export class BulkTranslateBatchPollService {
  private static instance: BulkTranslateBatchPollService;
  private intervalId: NodeJS.Timeout | null = null;
  private isRunning = false;
  private tickInFlight = false;

  private constructor() {}

  static getInstance(): BulkTranslateBatchPollService {
    if (!BulkTranslateBatchPollService.instance) {
      BulkTranslateBatchPollService.instance = new BulkTranslateBatchPollService();
    }
    return BulkTranslateBatchPollService.instance;
  }

  /** Start ticking. Runs once immediately, then every TICK_INTERVAL_MS. Idempotent. */
  start(): void {
    if (this.isRunning) return;
    if (POLL_DISABLED) {
      logger.info("[BatchPoll] Disabled via BULK_TRANSLATE_BATCH_POLL_DISABLED - not starting");
      return;
    }
    this.isRunning = true;
    logger.info(`[BatchPoll] Starting (every ${Math.round(TICK_INTERVAL_MS / 1000)}s)`);
    const run = () =>
      this.tick().catch((error) =>
        logger.error("[BatchPoll] Unhandled error in tick", {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    void run();
    this.intervalId = setInterval(run, TICK_INTERVAL_MS);
    // The tick must never keep the process alive on its own.
    this.intervalId.unref?.();
  }

  stop(): void {
    if (this.intervalId) clearInterval(this.intervalId);
    this.intervalId = null;
    this.isRunning = false;
    logger.info("[BatchPoll] Stopped");
  }

  /** One pass. A tick that is still running (a collect writes for minutes) is not started twice. */
  async tick(now: Date = new Date()): Promise<PollStats | null> {
    if (this.tickInFlight) return null;
    this.tickInFlight = true;
    try {
      const { db } = await import("~/db.server");
      const stats = await pollBatchesOnce({ db, now });
      if (stats.rows > 0 || stats.expired > 0) {
        logger.info(`[BatchPoll] Tick done: ${stats.rows} open row(s), ${stats.expired} closed as unreachable`, {
          outcomes: stats.outcomes,
        });
      }
      return stats;
    } finally {
      this.tickInFlight = false;
    }
  }
}
