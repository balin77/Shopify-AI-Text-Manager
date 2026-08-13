import { json } from "@remix-run/node";
import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { getPlanLimits, isValidPlan } from "../utils/planUtils";
import { syncMediaLibrary } from "../services/media-library/sync.server";
import { logger } from "~/utils/logger.server";

/**
 * API Route: Sync Media Library
 *
 * POST /api/sync-media-library
 *
 * Manueller Trigger für den MediaImage-Cache (Bildbibliothek des Shops) —
 * analog zu /api/sync-content. Für Bilder gibt es bewusst keinen Zeitplan:
 * der Bulk-Editor lädt aus dem Cache, und der Merchant stösst den Abgleich an,
 * wenn er neue Dateien hochgeladen hat.
 *
 * Antwort: `{ success: true, stats: { synced, removed } }`
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  // Ausserhalb des try/catch: authenticate.admin wirft Redirect-/401-Responses,
  // die nicht als 500 verpackt werden dürfen.
  const { admin, session } = await authenticate.admin(request);

  try {
    // Plan-Gate — dasselbe Flag wie die Produktbilder. Der Service prüft es
    // selbst noch einmal (defense in depth); hier gibt es zusätzlich eine klare
    // 403-Antwort statt eines stillen No-Ops.
    const settings = await db.aISettings.findUnique({
      where: { shop: session.shop },
      select: { subscriptionPlan: true },
    });
    const rawPlan = settings?.subscriptionPlan ?? "free";
    const plan = isValidPlan(rawPlan) ? rawPlan : "free";

    if (!getPlanLimits(plan).cacheEnabled.productImages) {
      return json(
        { success: false, error: "Image cache is not available on this plan" },
        { status: 403 },
      );
    }

    const stats = await syncMediaLibrary(admin, db, session.shop);

    logger.info("[SYNC-MEDIA-LIBRARY] Complete", {
      context: "SyncMediaLibrary",
      shop: session.shop,
      ...stats,
    });

    return json({ success: true, stats });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error("[SYNC-MEDIA-LIBRARY] Error", {
      context: "SyncMediaLibrary",
      shop: session.shop,
      error: msg,
      stack: error instanceof Error ? error.stack : undefined,
    });
    return json({ success: false, error: "Failed to sync media library" }, { status: 500 });
  }
};
