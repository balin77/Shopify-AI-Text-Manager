import { data as json, type LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { logger } from "~/utils/logger.server";

/**
 * API Route: Initial Sync Status
 *
 * Lightweight polling endpoint for the persistent onboarding banner. Reads the
 * scheduler-written progress columns on ShopInstallState (single indexed PK
 * lookup → safe to poll). No SSE / open connection: the sync itself runs
 * server-side via the scheduler, this just reports its state.
 *
 * GET /api/sync-status
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  let shop: string;
  try {
    const { session } = await authenticate.admin(request);
    shop = session.shop;
  } catch (error) {
    // Let auth redirects (e.g. to /auth/login) pass through unchanged.
    if (error instanceof Response) throw error;
    logger.error("[SYNC-STATUS] Authentication failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return new Response(JSON.stringify({ error: "Authentication failed" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const state = await db.shopInstallState.findUnique({
    where: { shop },
    select: {
      initialSyncCompletedAt: true,
      initialSyncPhase: true,
      initialSyncPercent: true,
      initialSyncStats: true,
      initialSyncError: true,
    },
  });

  return json(
    {
      needsSetup: !state?.initialSyncCompletedAt,
      phase: state?.initialSyncPhase ?? null,
      percent: state?.initialSyncPercent ?? 0,
      stats: state?.initialSyncStats ?? null,
      error: state?.initialSyncError ?? null,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
};
