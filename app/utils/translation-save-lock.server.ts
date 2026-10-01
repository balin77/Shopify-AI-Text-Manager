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

/**
 * WHEN the resource was last marked, or null. `isTranslationRecentlySaved`
 * answers "did anyone write recently", which cannot distinguish someone else's
 * save from a mark this very code path just made — a detached re-translation
 * that reads the boolean aborts on its own sibling's purge. Comparing this
 * timestamp against one captured at the start of the run answers the question
 * that path actually has: "did a write land AFTER I started?"
 */
export function translationSavedAt(resourceId: string): number | null {
  return recentSaves.get(resourceId) ?? null;
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
