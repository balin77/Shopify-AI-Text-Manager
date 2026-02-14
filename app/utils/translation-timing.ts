/**
 * In-memory tracking for recently saved translations.
 *
 * Replaces sessionStorage to comply with Shopify's requirement that
 * embedded apps work without third-party cookies/localStorage
 * (e.g. Chrome Incognito mode).
 *
 * Used to prevent on-demand sync from re-fetching stale translations
 * from Shopify immediately after a save (eventual consistency race condition).
 */
export const recentlySavedItems = new Map<string, number>();

/**
 * Check if an item was recently saved (within the given TTL).
 * @param itemId - The resource ID to check
 * @param ttlMs - Time-to-live in milliseconds (default: 60 seconds)
 */
export function wasRecentlySaved(itemId: string, ttlMs = 60_000): boolean {
  const savedAt = recentlySavedItems.get(itemId);
  if (!savedAt) return false;
  if (Date.now() - savedAt < ttlMs) return true;
  // Expired - clean up
  recentlySavedItems.delete(itemId);
  return false;
}
