import { useSyncExternalStore } from "react";

/**
 * Global store that tracks which resource IDs are currently being reloaded from Shopify.
 * The fetch happens outside React's component lifecycle so it survives navigation
 * between items. The ReloadButton just reads/writes this store.
 */

type ReloadData = { success: boolean; error?: string; [key: string]: unknown };

const reloadingIds = new Set<string>();
const completedReloads = new Map<string, ReloadData>();
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

export function startReload(
  resourceId: string,
  resourceType: string,
  locale: string,
) {
  if (reloadingIds.has(resourceId)) return;

  reloadingIds.add(resourceId);
  completedReloads.delete(resourceId);
  notify();

  const formData = new FormData();
  formData.append("resourceId", resourceId);
  formData.append("resourceType", resourceType);
  formData.append("locale", locale);

  fetch("/api/sync-single-resource", {
    method: "POST",
    body: formData,
  })
    .then((res) => res.json())
    .then((data: ReloadData) => {
      completedReloads.set(resourceId, data);
      // Keep in reloadingIds — the component calls clearReloading() after revalidation.
      // For errors, clear immediately since there's no revalidation step.
      if (!data.success) {
        reloadingIds.delete(resourceId);
      }
      notify();
    })
    .catch((err) => {
      completedReloads.set(resourceId, {
        success: false,
        error: err?.message || "Network error",
      });
      reloadingIds.delete(resourceId);
      notify();
    });
}

export function clearReloading(resourceId: string) {
  if (reloadingIds.has(resourceId)) {
    reloadingIds.delete(resourceId);
    notify();
  }
}

export function isResourceReloading(resourceId: string): boolean {
  return reloadingIds.has(resourceId);
}

export function consumeCompleted(resourceId: string): ReloadData | undefined {
  const data = completedReloads.get(resourceId);
  if (data) {
    completedReloads.delete(resourceId);
    // Don't notify here — the consumer will trigger its own state updates
  }
  return data;
}

/**
 * React hook: returns true while the given resourceId is reloading.
 */
export function useIsReloading(resourceId: string): boolean {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return reloadingIds.has(resourceId);
}

/**
 * React hook: returns completed reload data for the given resourceId (once).
 * After reading, the data is consumed (removed from the store).
 */
export function useCompletedReload(resourceId: string): ReloadData | undefined {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return completedReloads.get(resourceId);
}
