import { useSyncExternalStore } from "react";
import {
  ALL_LOCALES_AI_ACTIONS,
  PER_LOCALE_AI_ACTIONS,
} from "../constants/ai-actions";

/**
 * Global store that tracks all running AI operations across the app.
 * Lives outside React's component lifecycle so spinners persist when
 * the user navigates between items.
 *
 * Three concerns:
 * 1. Active operations  → drives spinner display
 * 2. Completed results  → parked responses consumed when user navigates back
 * 3. Stale cleanup      → hard timeout + DB reconciliation
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The editor state the request was made FROM. Carried through so a parked
 * answer can be applied to the locale and market the merchant asked from,
 * not to whichever one they happen to be looking at when they come back —
 * the same reason `useAISuggestionStore` keys by scope at all.
 */
export interface OperationScope {
  locale: string;
  marketId: string;
}

export interface ActiveOperation {
  resourceId: string;
  fieldKey: string;
  action: string;
  targetLocale?: string;
  scope?: OperationScope;
  startedAt: number;
}

export interface CompletedResult {
  resourceId: string;
  fieldKey: string;
  action: string;
  result: Record<string, unknown>;
  scope?: OperationScope;
  completedAt: number;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const STALE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

/** Composite key: `${resourceId}::${fieldKey}` */
const activeOps = new Map<string, ActiveOperation>();
const completedResults = new Map<string, CompletedResult>();

const listeners = new Set<() => void>();
let snapshotVersion = 0;
let currentSnapshot = { version: snapshotVersion };

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify() {
  snapshotVersion++;
  currentSnapshot = { version: snapshotVersion };
  for (const listener of listeners) {
    listener();
  }
}

function getSnapshot() {
  return currentSnapshot;
}

function makeKey(resourceId: string, fieldKey: string) {
  return `${resourceId}::${fieldKey}`;
}

// ---------------------------------------------------------------------------
// Stale cleanup (lazy — runs on read, not on a timer)
// ---------------------------------------------------------------------------

/**
 * Purge stale operations and completed results older than STALE_TIMEOUT_MS.
 * Called from imperative write paths (markOperationActive, reconcileWithServer)
 * to avoid mutating the store during React's render phase.
 */
function purgeStale() {
  const now = Date.now();
  let changed = false;
  for (const [key, op] of activeOps) {
    if (now - op.startedAt > STALE_TIMEOUT_MS) {
      activeOps.delete(key);
      changed = true;
    }
  }
  // Also purge old completed results (> 10 min)
  for (const [key, res] of completedResults) {
    if (now - res.completedAt > STALE_TIMEOUT_MS) {
      completedResults.delete(key);
      changed = true;
    }
  }
  if (changed) notify();
}

// ---------------------------------------------------------------------------
// Public API — imperative (callable from anywhere)
// ---------------------------------------------------------------------------

/** Check if an operation is currently active (non-reactive, for imperative guards). */
export function isOperationActive(resourceId: string, fieldKey: string): boolean {
  return activeOps.has(makeKey(resourceId, fieldKey));
}

export function markOperationActive(
  resourceId: string,
  fieldKey: string,
  action: string,
  targetLocale?: string,
  scope?: OperationScope,
) {
  purgeStale(); // opportunistic cleanup on write (safe — not in render path)
  const key = makeKey(resourceId, fieldKey);
  activeOps.set(key, { resourceId, fieldKey, action, targetLocale, scope, startedAt: Date.now() });
  completedResults.delete(key); // clear any stale completed result for this field
  notify();
}

export function markOperationCompleted(
  resourceId: string,
  fieldKey: string,
  action: string,
  result: Record<string, unknown>,
) {
  const key = makeKey(resourceId, fieldKey);
  // The scope travels with the ANSWER, so read it off the active op before
  // dropping it — the consumer runs long after the request and has no other
  // way of knowing which locale it was asked from.
  const scope = activeOps.get(key)?.scope;
  activeOps.delete(key);
  completedResults.set(key, { resourceId, fieldKey, action, result, scope, completedAt: Date.now() });
  notify();
}

export function markOperationFailed(resourceId: string, fieldKey: string) {
  const key = makeKey(resourceId, fieldKey);
  activeOps.delete(key);
  completedResults.delete(key);
  notify();
}

/**
 * Consume (and remove) the completed result for a given resource+field.
 * Returns undefined if none exists.
 */
export function consumeCompletedResult(
  resourceId: string,
  fieldKey: string,
): CompletedResult | undefined {
  const key = makeKey(resourceId, fieldKey);
  const result = completedResults.get(key);
  if (result) {
    completedResults.delete(key);
    // No notify needed — the consumer drives its own re-render
  }
  return result;
}

/**
 * Get all completed results for a given resource.
 * Does NOT consume them — caller must call consumeCompletedResult per field.
 */
export function getCompletedResultsForResource(resourceId: string): CompletedResult[] {
  const results: CompletedResult[] = [];
  for (const [, res] of completedResults) {
    if (res.resourceId === resourceId) {
      results.push(res);
    }
  }
  return results;
}

/**
 * DB reconciliation: given the set of field keys that the server says are
 * still running for a resource, clear any active ops that are NOT in that set.
 */
export function reconcileWithServer(
  resourceId: string,
  serverActiveFieldKeys: Set<string>,
) {
  purgeStale(); // opportunistic cleanup on write (safe — not in render path)
  let changed = false;
  for (const [key, op] of activeOps) {
    if (op.resourceId !== resourceId) continue;
    if (!serverActiveFieldKeys.has(op.fieldKey)) {
      activeOps.delete(key);
      changed = true;
    }
  }
  if (changed) notify();
}

/**
 * Clear all active operations for a given resource.
 * Used when the resource data is fully reloaded.
 */
export function clearAllForResource(resourceId: string) {
  let changed = false;
  for (const [key, op] of activeOps) {
    if (op.resourceId === resourceId) {
      activeOps.delete(key);
      changed = true;
    }
  }
  if (changed) notify();
}

// ---------------------------------------------------------------------------
// React hooks
// ---------------------------------------------------------------------------

/** True if the given field on the given resource has an active AI operation. */
export function useIsFieldLoading(resourceId: string, fieldKey: string): boolean {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return activeOps.has(makeKey(resourceId, fieldKey));
}

/**
 * Returns the set of all field keys with active operations for a resource.
 * Useful for passing into components that need the full set.
 */
export function useLoadingFieldKeys(resourceId: string): Set<string> {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const keys = new Set<string>();
  for (const [, op] of activeOps) {
    if (op.resourceId === resourceId) {
      keys.add(op.fieldKey);
    }
  }
  return keys;
}

/**
 * Derives the "Translate All" / "Translate All For Locale" running state
 * from the global store — replaces the old fetcherState-based derivation.
 */
export function useGlobalActionState(resourceId: string, currentLocale: string) {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  let isAllLocalesRunning = false;
  let isPerLocaleRunning = false;

  for (const [, op] of activeOps) {
    if (op.resourceId !== resourceId) continue;
    if ((ALL_LOCALES_AI_ACTIONS as readonly string[]).includes(op.action)) {
      isAllLocalesRunning = true;
    }
    if (
      (PER_LOCALE_AI_ACTIONS as readonly string[]).includes(op.action) &&
      op.targetLocale === currentLocale
    ) {
      isPerLocaleRunning = true;
    }
  }

  return { isAllLocalesRunning, isPerLocaleRunning };
}

/**
 * Returns all completed results for a resource (without consuming).
 * Components use this to detect parked responses.
 */
export function useCompletedResults(resourceId: string): CompletedResult[] {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return getCompletedResultsForResource(resourceId);
}

/**
 * Returns true if any sub-resource field is translating for a resource.
 */
export function useIsSubResourceTranslating(resourceId: string, fieldId: string): boolean {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return activeOps.has(makeKey(resourceId, `sub::${fieldId}`));
}

// Sub-resource helpers use a prefix to avoid key collisions with main fields
export function markSubResourceActive(resourceId: string, fieldId: string, action: string) {
  markOperationActive(resourceId, `sub::${fieldId}`, action);
}

export function markSubResourceCompleted(resourceId: string, fieldId: string) {
  const key = makeKey(resourceId, `sub::${fieldId}`);
  activeOps.delete(key);
  completedResults.delete(key);
  notify();
}

/**
 * Returns the set of sub-resource field IDs with active translations for a resource.
 */
export function useTranslatingSubResourceIds(resourceId: string): Set<string> {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const ids = new Set<string>();
  for (const [, op] of activeOps) {
    if (op.resourceId === resourceId && op.fieldKey.startsWith("sub::")) {
      ids.add(op.fieldKey.slice(5)); // strip "sub::" prefix
    }
  }
  return ids;
}
