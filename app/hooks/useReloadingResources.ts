import { useSyncExternalStore } from "react";

/**
 * Global store that owns the manual reload lifecycle.
 * The full flow (fetch → DB-settle → revalidate → wait-for-idle → cleanup) runs
 * inside this module so it survives component un-/remount and concurrent
 * revalidations from other sources (image manager, sub-resources, …).
 * Components only read `useIsReloading` and call `startReload`.
 */

const reloadingIds = new Set<string>();
const listeners = new Set<() => void>();

// Snapshot identity must change when state changes for useSyncExternalStore
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

// ---------------------------------------------------------------------------
// Lifecycle constants
// ---------------------------------------------------------------------------

const FETCH_TIMEOUT_MS = 30_000;     // hard cutoff on the sync API call
const DB_SETTLE_MS = 1_000;          // wait for write to be visible before revalidate
const REVAL_WATCHDOG_MS = 15_000;    // give up on revalidator state if it never returns to idle
const POLL_INTERVAL_MS = 100;
const LOADING_OBSERVED_TIMEOUT_MS = 2_000; // fallback if our revalidate() never visibly toggles state

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RevalidatorAdapter = {
  getState: () => "idle" | "loading";
  revalidate: () => void;
};

export type ReloadCallbacks = {
  onSuccess?: () => void;
  onComplete?: () => void;
  onError?: (message: string) => void;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Wait until `getState()` returns 'idle' AFTER having observed a 'loading' state.
 * Returns true on clean completion, false if the watchdog fired.
 *
 * Two phases:
 *  1. Wait up to LOADING_OBSERVED_TIMEOUT_MS for state to become 'loading'.
 *     If never seen, fall through to phase 2 anyway (another revalidation may
 *     already have been running and absorbed our trigger).
 *  2. Wait up to the remaining watchdog window for state to become 'idle'.
 */
function waitForIdle(getState: () => string): Promise<boolean> {
  return new Promise((resolve) => {
    const start = Date.now();
    let loadingSeen = false;

    const interval = setInterval(() => {
      const state = getState();
      const elapsed = Date.now() - start;

      if (state === "loading") {
        loadingSeen = true;
      }

      // Success: we either saw the full loading→idle transition,
      // or we waited long enough that we accept any idle state as done.
      if (state === "idle" && (loadingSeen || elapsed >= LOADING_OBSERVED_TIMEOUT_MS)) {
        clearInterval(interval);
        clearTimeout(watchdog);
        resolve(true);
        return;
      }

      if (elapsed >= REVAL_WATCHDOG_MS) {
        clearInterval(interval);
        clearTimeout(watchdog);
        resolve(false);
      }
    }, POLL_INTERVAL_MS);

    const watchdog = setTimeout(() => {
      clearInterval(interval);
      resolve(false);
    }, REVAL_WATCHDOG_MS + POLL_INTERVAL_MS);
  });
}

function cacheBustUrl() {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  url.searchParams.set("_reload", Date.now().toString());
  window.history.replaceState({}, "", url.toString());
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function startReload(
  resourceId: string,
  resourceType: string,
  locale: string,
  revalidator: RevalidatorAdapter | null,
  callbacks: ReloadCallbacks = {},
): Promise<void> {
  if (reloadingIds.has(resourceId)) return;

  reloadingIds.add(resourceId);
  notify();

  const abort = new AbortController();
  const fetchTimer = setTimeout(() => {
    abort.abort(new DOMException("Server timeout", "TimeoutError"));
  }, FETCH_TIMEOUT_MS);

  try {
    const formData = new FormData();
    formData.append("resourceId", resourceId);
    formData.append("resourceType", resourceType);
    formData.append("locale", locale);

    const res = await fetch("/api/sync-single-resource", {
      method: "POST",
      body: formData,
      signal: abort.signal,
    });
    clearTimeout(fetchTimer);

    const data = (await res.json()) as { success: boolean; error?: string };

    if (!data.success) {
      callbacks.onError?.(data.error || "Unknown error");
      return;
    }

    // Wait for the DB write to settle before triggering a revalidation,
    // otherwise the loader may read stale rows.
    await sleep(DB_SETTLE_MS, abort.signal);

    if (revalidator) {
      cacheBustUrl();
      revalidator.revalidate();

      const cleared = await waitForIdle(revalidator.getState);
      if (!cleared) {
        // Watchdog fired — fresh data is likely already in the loader response,
        // but we cannot confirm it. Surface a soft error so the user can retry.
        callbacks.onError?.("Reload took too long — please try again");
      }
    }

    callbacks.onComplete?.();
    callbacks.onSuccess?.();
  } catch (err) {
    const name = (err as { name?: string } | null)?.name;
    if (name === "TimeoutError") {
      callbacks.onError?.("Server timeout while reloading");
    } else if (name !== "AbortError") {
      callbacks.onError?.((err as Error)?.message || "Network error");
    }
  } finally {
    clearTimeout(fetchTimer);
    reloadingIds.delete(resourceId);
    notify();
  }
}

export function isResourceReloading(resourceId: string): boolean {
  return reloadingIds.has(resourceId);
}

/**
 * React hook: returns true while the given resourceId is reloading.
 */
export function useIsReloading(resourceId: string): boolean {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return reloadingIds.has(resourceId);
}
