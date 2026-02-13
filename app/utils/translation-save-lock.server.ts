/**
 * Translation Save Lock
 *
 * Prevents webhook-triggered syncs from overwriting translations
 * that were recently saved/cleared by the user. When a user saves
 * translations (including Clear All), Shopify fires a webhook that
 * re-fetches translations. Due to eventual consistency, the fetch
 * may return stale data, undoing the user's changes.
 */

const recentSaves = new Map<string, number>();

export function markTranslationSaved(resourceId: string): void {
  recentSaves.set(resourceId, Date.now());
  // Cleanup old entries
  for (const [id, ts] of recentSaves) {
    if (Date.now() - ts > 60_000) recentSaves.delete(id);
  }
}

export function isTranslationRecentlySaved(
  resourceId: string,
  windowMs = 30_000,
): boolean {
  const ts = recentSaves.get(resourceId);
  if (!ts) return false;
  return Date.now() - ts < windowMs;
}
