/**
 * Activity Tracker Middleware
 *
 * Tracks user activity by updating lastActivityAt timestamp in Session model.
 * Used by the background sync scheduler to determine if a shop is still active.
 */

/**
 * Updates the lastActivityAt timestamp for all sessions of a given shop
 * @param shop - The shop domain (e.g., "example.myshopify.com")
 */
export async function trackActivity(shop: string): Promise<void> {
  try {
    const { db } = await import("../db.server");

    // Update lastActivityAt for all sessions of this shop
    await db.session.updateMany({
      where: { shop },
      data: { lastActivityAt: new Date() }
    });

    // Note: We don't log here to avoid spam - this runs on every request
  } catch (error) {
    console.error('[ActivityTracker] Error updating activity:', error);
    // Don't throw - activity tracking should never break the app
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
    console.error('[ActivityTracker] Error getting last activity:', error);
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
    console.error('[ActivityTracker] Error checking if shop is active:', error);
    return false;
  }
}
