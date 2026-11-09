/**
 * Activity Tracker Middleware
 *
 * Tracks user activity: Session.lastActivityAt (the background sync scheduler's
 * inactivity gate) plus the durable per-shop statistics of the /admin overview
 * (ShopInstallState.lastActivityAt / lastAction*, ShopUsageDay).
 */

import { logger } from '~/utils/logger.server';
import {
  ACTION_WRITE_INTERVAL_MS,
  ACTIVITY_WRITE_INTERVAL_MS,
  isActionMethod,
  isPollingPath,
  pathArea,
  slotOf,
  utcDay,
} from '~/services/shop-activity.shared';

// ── in-memory throttles (one instance, see RAILWAY-SETUP) ───────────────────
// A restart forgets them: at worst one extra write / one double-counted window.
const lastActivityWrittenAt = new Map<string, number>();
const lastCountedSlot = new Map<string, number>();
const lastActionWritten = new Map<string, { area: string; at: number }>();
/** A request is tracked once even if several loaders authenticate it. */
let seenRequests = new WeakSet<Request>();

/** Test seam. */
export function __resetActivityTrackerForTests(): void {
  lastActivityWrittenAt.clear();
  lastCountedSlot.clear();
  lastActionWritten.clear();
  seenRequests = new WeakSet<Request>();
}

/**
 * The ONE hook for per-shop usage tracking (PLAN_ADMIN_SHOP_OVERVIEW 3.2). It is
 * called from `enhancedAuthenticate.admin` (shopify.server.ts), the single door
 * every app page loader/action and every /api route passes through, so no route
 * has to remember it. It:
 *
 *  1. keeps `Session.lastActivityAt` fresh (the sync scheduler's inactivity gate
 *     and the migration's quiet window read it; polling counts there, as before);
 *  2. for a NON-polling request, writes the durable `ShopInstallState.lastActivityAt`
 *     (at most once per 5 min per shop; also clears `lastActivityApprox`),
 *     counts the 5-minute window into `ShopUsageDay.activeSlots` (once per slot),
 *     and, if the request is not a GET, counts one action into
 *     `ShopUsageDay.actions` and records `lastActionAt` / `lastActionArea`
 *     (the path AREA only, never the query).
 *
 * Fire-and-forget by the caller; it never throws and all in-memory decisions
 * are made before the first await, so the request pays nothing. Without a
 * `request` (legacy callers) only step 1 runs.
 *
 * ShopInstallState is only UPDATED, never created here: a fresh row would read
 * as a new install (initialSyncCompletedAt null) and trigger onboarding.
 *
 * @param shop - The shop domain (e.g., "example.myshopify.com")
 */
export async function trackActivity(shop: string, request?: Request): Promise<void> {
  try {
    const { db } = await import("../db.server");

    // 1. Scheduler / migration gate (unchanged behaviour).
    const sessionWrite = db.session
      .updateMany({ where: { shop }, data: { lastActivityAt: new Date() } })
      .catch((error: unknown) => {
        logger.error('[ActivityTracker] Error updating activity', { error });
      });

    // 2. Usage statistics.
    await trackUsage(db, shop, request);
    await sessionWrite;
    // Note: We don't log here to avoid spam - this runs on every request
  } catch (error) {
    logger.error('[ActivityTracker] Error updating activity', { error });
    // Don't throw - activity tracking should never break the app
  }
}

async function trackUsage(
  db: typeof import("../db.server").db,
  shop: string,
  request?: Request,
): Promise<void> {
  try {
    if (!request) return;
    if (seenRequests.has(request)) return;
    seenRequests.add(request);

    let pathname: string;
    try {
      pathname = new URL(request.url).pathname;
    } catch {
      return;
    }
    if (isPollingPath(pathname)) return;

    const nowMs = Date.now();
    const writes: Array<Promise<unknown>> = [];

    // Durable "last opened".
    const lastWritten = lastActivityWrittenAt.get(shop);
    if (lastWritten === undefined || nowMs - lastWritten >= ACTIVITY_WRITE_INTERVAL_MS) {
      lastActivityWrittenAt.set(shop, nowMs);
      writes.push(
        db.shopInstallState
          .updateMany({ where: { shop }, data: { lastActivityAt: new Date(nowMs), lastActivityApprox: false } })
          .catch(() => {
            lastActivityWrittenAt.delete(shop);
          }),
      );
    }

    const day = utcDay(nowMs);

    // Active 5-minute window (once per slot) and the action (once per request)
    // go into ONE upsert, so two concurrent upserts cannot race on a new
    // (shop, day) row.
    const slot = slotOf(nowMs);
    const countSlot = lastCountedSlot.get(shop) !== slot;
    const isAction = isActionMethod(request.method);
    if (countSlot) lastCountedSlot.set(shop, slot);
    if (countSlot || isAction) {
      writes.push(
        db.shopUsageDay
          .upsert({
            where: { shop_day: { shop, day } },
            create: { shop, day, activeSlots: countSlot ? 1 : 0, actions: isAction ? 1 : 0 },
            update: {
              ...(countSlot ? { activeSlots: { increment: 1 } } : {}),
              ...(isAction ? { actions: { increment: 1 } } : {}),
            },
          })
          .catch(() => {
            if (countSlot && lastCountedSlot.get(shop) === slot) lastCountedSlot.delete(shop);
          }),
      );
    }

    if (isAction) {
      const area = pathArea(pathname);
      const prev = lastActionWritten.get(shop);
      if (!prev || prev.area !== area || nowMs - prev.at >= ACTION_WRITE_INTERVAL_MS) {
        lastActionWritten.set(shop, { area, at: nowMs });
        writes.push(
          db.shopInstallState
            .updateMany({ where: { shop }, data: { lastActionAt: new Date(nowMs), lastActionArea: area } })
            .catch(() => {
              lastActionWritten.delete(shop);
            }),
        );
      }
    }

    await Promise.all(writes);
  } catch {
    /* tracking must never break a request */
  }
}

/**
 * Gets the last activity time for a shop
 * @param shop - The shop domain
 * @returns The last activity timestamp or null if no session found
 */
export async function getLastActivity(shop: string): Promise<Date | null> {
  try {
    const { db } = await import("../db.server");

    const session = await db.session.findFirst({
      where: { shop },
      orderBy: { lastActivityAt: 'desc' },
      select: { lastActivityAt: true }
    });

    return session?.lastActivityAt || null;
  } catch (error) {
    logger.error('[ActivityTracker] Error getting last activity', { error });
    return null;
  }
}

/**
 * Checks if a shop has been active within the specified time window
 * @param shop - The shop domain
 * @param minutesThreshold - Number of minutes to consider as "active" (default: 5)
 * @returns True if shop was active within the threshold, false otherwise
 */
export async function isShopActive(shop: string, minutesThreshold: number = 5): Promise<boolean> {
  try {
    const lastActivity = await getLastActivity(shop);

    if (!lastActivity) {
      return false;
    }

    const minutesSinceActivity = (Date.now() - lastActivity.getTime()) / 60000;
    return minutesSinceActivity < minutesThreshold;
  } catch (error) {
    logger.error('[ActivityTracker] Error checking if shop is active', { error });
    return false;
  }
}
