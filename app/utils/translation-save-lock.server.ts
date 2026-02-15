/**
 * Translation Save Lock
 *
 * Prevents webhook-triggered syncs from overwriting translations
 * that were recently saved/cleared by the user. When a user saves
 * translations (including Clear All), Shopify fires a webhook that
 * re-fetches translations. Due to eventual consistency, the fetch
 * may return stale data, undoing the user's changes.
 */

const EXPIRY_MS = 60_000;
const MAX_ENTRIES = 500;

const recentSaves = new Map<string, number>();

function evictExpired(): void {
  const now = Date.now();
  for (const [id, ts] of recentSaves) {
    if (now - ts > EXPIRY_MS) recentSaves.delete(id);
  }
}

export function markTranslationSaved(resourceId: string): void {
  recentSaves.set(resourceId, Date.now());
  if (recentSaves.size > MAX_ENTRIES) evictExpired();
}

export function isTranslationRecentlySaved(
  resourceId: string,
  windowMs = 30_000,
): boolean {
  const ts = recentSaves.get(resourceId);
  if (!ts) return false;
  if (Date.now() - ts < windowMs) return true;
  recentSaves.delete(resourceId);
  return false;
}
