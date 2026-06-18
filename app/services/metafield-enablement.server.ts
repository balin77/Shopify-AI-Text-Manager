/**
 * Helpers around EnabledMetafieldDefinition — the per-shop set of product
 * metafield definitions enabled for the ContentPilot translation pipeline.
 *
 * Used by the settings tab (read/write) and by the product/settings loaders
 * (gating which metafields show in the editor + one-time lazy backfill).
 */

import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import type { PrismaClient } from "@prisma/client";
import { ContentService } from "./content.service";
import { logger } from "~/utils/logger.server";

/** Build the `namespace.key` key used to match metafields against enabled defs. */
export function metafieldEnableKey(namespace: string, key: string): string {
  return `${namespace}.${key}`;
}

/**
 * Return the set of `namespace.key` strings the shop has enabled for product
 * metafield translation. The product loader intersects this with the
 * translatable text-type metafields to decide editor visibility.
 */
export async function getEnabledMetafieldKeySet(
  db: Pick<PrismaClient, "enabledMetafieldDefinition">,
  shop: string,
): Promise<Set<string>> {
  const rows = await db.enabledMetafieldDefinition.findMany({
    where: { shop, ownerType: "PRODUCT" },
    select: { namespace: true, key: true },
  });
  return new Set(rows.map((r) => metafieldEnableKey(r.namespace, r.key)));
}

/**
 * One-time lazy backfill for existing merchants.
 *
 * Editor visibility now requires an EnabledMetafieldDefinition row (decided
 * design point 1). Without a backfill, every existing shop's product editor
 * would lose its already-translatable metafields the day this ships. So the
 * FIRST time a shop hits a loader after deploy (guarded by
 * AISettings.metafieldsLastScanAt being null), we scan its product metafield
 * definitions and enable every one that is already translatable
 * (patchedTranslatable:false — we did not change Shopify state).
 *
 * Idempotent: the metafieldsLastScanAt timestamp is set even when zero
 * definitions are translatable, so a shop with no translatable metafields does
 * not re-scan on every load. Safe to call from multiple loaders.
 *
 * Resilience: this runs in the products loader, which fires on EVERY navigation
 * and prefetch. A per-process in-memory guard ensures we attempt the backfill
 * at most once per shop per process — so a persistently failing scan (e.g. a
 * Shopify API/schema error) cannot spam the logs or add a failing round-trip to
 * every page load. The guard is set BEFORE the await, which also collapses
 * concurrent loaders for the same shop into a single scan. A process restart
 * (deploy) clears it, and the manual "Scan now" button is a separate path.
 */
const backfillAttempted = new Set<string>();

export async function backfillEnabledMetafieldDefinitionsIfNeeded(
  admin: AdminApiContext,
  db: PrismaClient,
  shop: string,
): Promise<void> {
  if (backfillAttempted.has(shop)) return;
  try {
    const settings = await db.aISettings.findUnique({
      where: { shop },
      select: { metafieldsLastScanAt: true },
    });

    // Already scanned/backfilled once → nothing to do.
    if (settings?.metafieldsLastScanAt) {
      backfillAttempted.add(shop);
      return;
    }

    // Mark attempted up front so concurrent loaders and subsequent requests in
    // this process don't re-run (even if the scan below throws).
    backfillAttempted.add(shop);

    const service = new ContentService(admin);
    const definitions = await service.getProductMetafieldDefinitions();
    const translatable = definitions.filter((d) => d.translatable);

    await db.$transaction(async (tx) => {
      for (const def of translatable) {
        await tx.enabledMetafieldDefinition.upsert({
          where: { shop_definitionId: { shop, definitionId: def.id } },
          create: {
            shop,
            definitionId: def.id,
            namespace: def.namespace,
            key: def.key,
            ownerType: "PRODUCT",
            patchedTranslatable: false,
          },
          update: {},
        });
      }
      // Mark scanned regardless of count so the guard never re-runs.
      await tx.aISettings.upsert({
        where: { shop },
        create: { shop, metafieldsLastScanAt: new Date() },
        update: { metafieldsLastScanAt: new Date() },
      });
    });

    logger.info(
      `[Metafields] Backfilled ${translatable.length} translatable product metafield definitions`,
      { context: "MetafieldEnablement", shop },
    );
  } catch (error) {
    // Backfill is best-effort — never block a page load on it.
    logger.error("[Metafields] Backfill failed", {
      context: "MetafieldEnablement",
      shop,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
