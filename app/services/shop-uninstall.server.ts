/**
 * What happens when a shop uninstalls the app (PLAN_ADMIN_SHOP_OVERVIEW 2.4).
 *
 * The body of the app/uninstalled webhook, extracted so every path that decides
 * "this shop is gone" does the SAME thing: the webhook (source "webhook"), and
 * later the operator script and the optional automatic marking of a stale
 * install ("operator", "stale_auto"). Full data deletion stays with shop/redact
 * and the 30-day reaper; this only cuts the shop off and records it.
 *
 * Besides the session cleanup it
 *  - LIFTS a connection block (the access is gone for good, a reinstall must
 *    never inherit a stale block; clearing stamps the fence), and
 *  - sets `resyncRequiredSince`, because changes made in the shop between the
 *    uninstall and a reinstall inside the 48 h before redact are never seen by
 *    a webhook: the catch-up (webhook-catchup.server.ts) closes that gap on the
 *    next sign-in. The earliest owed moment is kept.
 *
 * Every step has its own try/catch: the webhook owes Shopify a 200. Never throws.
 */

import { db } from "~/db.server";
import { syncScheduler } from "~/services/sync-scheduler.service";
import { logger } from "~/utils/logger.server";
import { forgetOfflineTokenMigration, invalidateOfflineAdmin } from "~/utils/offline-admin.server";
import { clearConnectionBlock } from "~/utils/shop-connection-state.server";

export type UninstallSource = "webhook" | "operator" | "stale_auto";

/**
 * `ifBlockedSince` (stale marking only): mark ONLY IF the shop is still not
 * uninstalled and its connection block is still the one that was reviewed
 * (same `connectionStateSince`). The claim happens first, before any session is
 * deleted, so a sign-in between review and mark is not destroyed. Returns false
 * (nothing touched) when the claim fails; true otherwise.
 */
export async function markShopUninstalled(
  shop: string,
  opts: { source: UninstallSource; ifBlockedSince?: Date },
): Promise<boolean> {
  const { source } = opts;
  const tag = `[APP_UNINSTALLED]`;

  if (opts.ifBlockedSince) {
    try {
      const claim = await db.shopInstallState.updateMany({
        where: {
          shop,
          uninstalledAt: null,
          connectionState: { not: null },
          connectionStateSince: opts.ifBlockedSince,
        },
        data: { uninstalledAt: new Date(), uninstallSource: source },
      });
      if (claim.count === 0) {
        logger.info(`${tag} Not marking ${shop}: its state changed since it was reviewed`);
        return false;
      }
    } catch (error) {
      logger.error(`${tag} Claim for ${shop} failed:`, error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  // Stop background sync immediately — the access token is now revoked.
  try {
    if (syncScheduler.isShopActive(shop)) {
      syncScheduler.stopSyncForShop(shop);
      logger.info(`${tag} Stopped sync scheduler for ${shop}`);
    }
  } catch (error) {
    logger.error(`${tag} Failed to stop the scheduler for ${shop}:`, error instanceof Error ? error.message : String(error));
  }

  // Delete sessions so a reinstall always starts with a clean OAuth grant.
  try {
    const deleted = await db.session.deleteMany({ where: { shop } });
    logger.info(`${tag} Deleted ${deleted.count} session(s) for ${shop}`);
  } catch (error) {
    logger.error(`${tag} Failed to delete sessions for ${shop}:`, error instanceof Error ? error.message : String(error));
  }

  // Background callers in this process must not keep serving the cached
  // offline token. Done even when the delete failed — Shopify revoked it.
  invalidateOfflineAdmin(shop);

  // A pending token migration holds the shop's old token (encrypted); it dies
  // with the install. `force`: also with the switches off (rollback case).
  await forgetOfflineTokenMigration(shop, { force: true });

  // Stamp the uninstall time: the reliable "inactive since" anchor for the
  // 30-day reaper. Cleared again on any (re)install in afterAuth.
  try {
    const now = new Date();
    await db.shopInstallState.upsert({
      where: { shop },
      create: { shop, uninstalledAt: now, uninstallSource: source, resyncRequiredSince: now },
      update: { uninstalledAt: now, uninstallSource: source },
    });
    // The catch-up is owed from here on; an earlier owed moment (dropped
    // webhooks of a blocked shop) stays.
    await db.shopInstallState.updateMany({
      where: { shop, resyncRequiredSince: null },
      data: { resyncRequiredSince: now },
    });
    logger.info(`${tag} Marked uninstalledAt for ${shop} (source=${source})`);
  } catch (error) {
    logger.error(`${tag} Failed to record uninstalledAt for ${shop}:`, error instanceof Error ? error.message : String(error));
  }

  // The access is gone for good, so whatever block the shop carried is moot.
  // After the upsert: the clear only touches an existing row. Never throws.
  await clearConnectionBlock(shop, "uninstalled");

  // Uninstalling cancels the subscription on Shopify's side, so the verified
  // managed-AI entitlement ends here too (a reinstall re-syncs it in afterAuth).
  try {
    await db.aISettings.updateMany({
      where: { shop, managedAiActive: true },
      data: { managedAiActive: false },
    });
  } catch (error) {
    logger.error(
      `${tag} Failed to clear the managed-AI entitlement for ${shop}:`,
      error instanceof Error ? error.message : String(error),
    );
  }
  return true;
}
