/**
 * GDPR Audit Log Cleanup Service (Standalone)
 *
 * Enforces the mandatory 3-year retention limit (DSGVO / GDPR Art. 5(1)(e)
 * storage limitation) on the GdprAuditLog table.
 *
 * GdprAuditLog is deliberately NOT deleted on shop/redact (Art. 5(2)
 * accountability). This job is the only time-based upper bound: it removes
 * audit rows once they are older than 3 years, based on `requestedAt`.
 * It touches NOTHING but GdprAuditLog rows past the retention window.
 *
 * This file is imported directly by server.js and not processed by Remix build.
 * Keep it in sync with src/services/gdpr-audit-cleanup.service.ts.
 */

import { PrismaClient } from "@prisma/client";

// Reuse the global PrismaClient shared with the Remix app (db.server.ts)
// instead of creating a separate instance with its own connection pool.
const prisma = globalThis.__db ?? new PrismaClient();
if (!globalThis.__db) globalThis.__db = prisma;

// Retention window: 3 years (Art. 5(2) accountability obligation).
const RETENTION_MS = 3 * 365 * 24 * 60 * 60 * 1000;

export class GdprAuditLogCleanupService {
  static instance = null;
  intervalId = null;
  isRunning = false;

  constructor() {}

  static getInstance() {
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
      console.log('[GdprAuditCleanup] Service already running');
      return;
    }

    console.log('[GdprAuditCleanup] Starting GDPR audit log cleanup service...');
    this.isRunning = true;

    // Run immediately on start
    this.cleanup();

    // Then run once per day
    this.intervalId = setInterval(() => {
      this.cleanup();
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
      console.log('[GdprAuditCleanup] Service stopped');
    }
  }

  /**
   * Delete GdprAuditLog rows older than the 3-year retention window.
   * Filters strictly on `requestedAt` — no shop/customer scope.
   */
  async cleanup() {
    try {
      const cutoff = new Date(Date.now() - RETENTION_MS);
      console.log(`[GdprAuditCleanup] Running cleanup (retention cutoff ${cutoff.toISOString()})...`);

      const result = await prisma.gdprAuditLog.deleteMany({
        where: {
          requestedAt: {
            lt: cutoff,
          },
        },
      });

      if (result.count > 0) {
        console.log(`[GdprAuditCleanup] Deleted ${result.count} GDPR audit log row(s) older than 3 years`);
      } else {
        console.log('[GdprAuditCleanup] No GDPR audit log rows older than 3 years to delete');
      }
    } catch (error) {
      console.error('[GdprAuditCleanup] Error during cleanup:', error);
    }
  }

  /**
   * Manually trigger cleanup (useful for testing or API endpoints)
   */
  async triggerCleanup() {
    const cutoff = new Date(Date.now() - RETENTION_MS);
    const result = await prisma.gdprAuditLog.deleteMany({
      where: {
        requestedAt: {
          lt: cutoff,
        },
      },
    });
    return result.count;
  }
}
