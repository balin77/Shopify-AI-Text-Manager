/**
 * GDPR Audit Log Cleanup Service
 *
 * Enforces the mandatory 3-year retention limit (DSGVO / GDPR Art. 5(1)(e)
 * storage limitation) on the GdprAuditLog table.
 *
 * GdprAuditLog is deliberately NOT deleted on shop/redact (Art. 5(2)
 * accountability — we must be able to prove GDPR requests were handled).
 * This job provides the only time-based upper bound: it removes audit rows
 * once they are older than 3 years, based on `requestedAt` (the point the
 * request arrived; `@@index([requestedAt])` keeps the delete cheap).
 *
 * It touches NOTHING but GdprAuditLog rows past the retention window.
 */

import { db } from "../../app/db.server";
import { loggers } from '../../app/utils/logger.server';

/** Retention window: 3 years (Art. 5(2) accountability obligation). */
const RETENTION_DAYS = 3 * 365;
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;

export class GdprAuditLogCleanupService {
  private static instance: GdprAuditLogCleanupService;
  private intervalId: NodeJS.Timeout | null = null;
  private isRunning = false;

  private constructor() {}

  static getInstance(): GdprAuditLogCleanupService {
    if (!GdprAuditLogCleanupService.instance) {
      GdprAuditLogCleanupService.instance = new GdprAuditLogCleanupService();
    }
    return GdprAuditLogCleanupService.instance;
  }

  /**
   * Start the cleanup service.
   * Runs once immediately, then daily.
   */
  start() {
    if (this.isRunning) {
      loggers.queue('info', 'GDPR audit log cleanup service already running');
      return;
    }

    loggers.queue('info', 'Starting GDPR audit log cleanup service...');
    this.isRunning = true;

    // Run immediately on start (handle rejected promise to avoid unhandled rejection)
    this.cleanup().catch(err =>
      loggers.queue('error', 'Unhandled error in initial GDPR audit cleanup', { error: err instanceof Error ? err.message : String(err) })
    );

    // Then run once per day
    this.intervalId = setInterval(() => {
      this.cleanup().catch(err =>
        loggers.queue('error', 'Unhandled error in scheduled GDPR audit cleanup', { error: err instanceof Error ? err.message : String(err) })
      );
    }, 24 * 60 * 60 * 1000); // 1 day
  }

  /**
   * Stop the cleanup service
   */
  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      this.isRunning = false;
      loggers.queue('info', 'GDPR audit log cleanup service stopped');
    }
  }

  /**
   * Delete GdprAuditLog rows older than the 3-year retention window.
   * Filters strictly on `requestedAt` — no shop/customer scope, so it can
   * never affect rows still within retention.
   */
  async cleanup() {
    try {
      const cutoff = new Date(Date.now() - RETENTION_MS);
      loggers.queue('info', `Running GDPR audit log cleanup (retention cutoff ${cutoff.toISOString()})...`);

      const result = await db.gdprAuditLog.deleteMany({
        where: {
          requestedAt: {
            lt: cutoff,
          },
        },
      });

      if (result.count > 0) {
        loggers.queue('info', `Deleted ${result.count} GDPR audit log row(s) older than 3 years`);
      } else {
        loggers.queue('debug', 'No GDPR audit log rows older than 3 years to delete');
      }
    } catch (error) {
      loggers.queue('error', 'Error during GDPR audit log cleanup', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  /**
   * Manually trigger cleanup (useful for testing or API endpoints).
   * Returns the number of deleted rows.
   */
  async triggerCleanup(): Promise<number> {
    const cutoff = new Date(Date.now() - RETENTION_MS);
    const result = await db.gdprAuditLog.deleteMany({
      where: {
        requestedAt: {
          lt: cutoff,
        },
      },
    });
    return result.count;
  }
}
