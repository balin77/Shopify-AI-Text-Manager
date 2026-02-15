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

const DEFAULT_TTL_MS = 60_000;
const MAX_ENTRIES = 500;

const recentlySavedItems = new Map<string, number>();

function evictExpired(): void {
  const now = Date.now();
  for (const [id, ts] of recentlySavedItems) {
    if (now - ts > DEFAULT_TTL_MS) recentlySavedItems.delete(id);
  }
}

/**
 * Mark an item as recently saved.
 */
export function markRecentlySaved(itemId: string): void {
  recentlySavedItems.set(itemId, Date.now());
  if (recentlySavedItems.size > MAX_ENTRIES) evictExpired();
}

/**
 * Check if an item was recently saved (within the given TTL).
 * @param itemId - The resource ID to check
 * @param ttlMs - Time-to-live in milliseconds (default: 60 seconds)
 */
export function wasRecentlySaved(itemId: string, ttlMs = DEFAULT_TTL_MS): boolean {
  const savedAt = recentlySavedItems.get(itemId);
  if (!savedAt) return false;
  if (Date.now() - savedAt < ttlMs) return true;
  recentlySavedItems.delete(itemId);
  return false;
}
