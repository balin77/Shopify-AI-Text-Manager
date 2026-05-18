import { json, type ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { requestInitialResync } from "../services/initial-sync.service";
import { syncScheduler } from "../services/sync-scheduler.service";
import { logger } from "~/utils/logger.server";

/**
 * API Route: Trigger Force Re-Sync (server-side)
 *
 * Replaces the old browser-driven SSE force re-sync. Clears the
 * initialSyncCompletedAt marker and flags a forced (delete + full re-pull)
 * run, then ensures the scheduler is running. The scheduler picks it up on its
 * next cycle via runInitialFullSync — progress is surfaced by the persistent
 * InitialSyncBanner (it polls /api/sync-status), so the re-sync survives the
 * user navigating away or closing the tab.
 *
 * POST /api/sync-trigger
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  let admin: any;
  let shop: string;
  try {
    const auth = await authenticate.admin(request);
    admin = auth.admin;
    shop = auth.session.shop;
  } catch (error) {
    if (error instanceof Response) throw error;
    logger.error("[SYNC-TRIGGER] Authentication failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return new Response(JSON.stringify({ error: "Authentication failed" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Force re-sync = delete + full re-pull (manual Settings action).
  await requestInitialResync(shop, { force: true });

  // Ensure the scheduler is running so it picks up the initial-sync branch.
  // startSyncForShop restarts cleanly if already active (idempotent).
  try {
    syncScheduler.startSyncForShop(shop, admin);
  } catch (error) {
    logger.warn("[SYNC-TRIGGER] scheduler start failed", {
      shop, error: error instanceof Error ? error.message : String(error),
    });
  }

  logger.info("[SYNC-TRIGGER] Force re-sync requested", { shop });
  return json({ ok: true });
};
