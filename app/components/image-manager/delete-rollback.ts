/**
 * Pure helpers for the product-image delete: undoing the optimistic removal
 * itself (instead of restoring a whole-state snapshot that would discard
 * edits made while the request was in flight) and deciding what a pair of
 * server answers means.
 */

export interface RemovedEntry<T> {
  index: number;
  value: T;
}

/** The entries `isRemoved` matches, with the index each had in `list`. */
export function captureRemoved<T>(list: readonly T[], isRemoved: (value: T) => boolean): RemovedEntry<T>[] {
  const out: RemovedEntry<T>[] = [];
  list.forEach((value, index) => {
    if (isRemoved(value)) out.push({ index, value });
  });
  return out;
}

/**
 * Put removed entries back into the CURRENT list at their former positions
 * (clamped), skipping any `same` already present. Ascending insertion keeps
 * the original relative order.
 */
export function reinsertRemoved<T>(
  current: readonly T[],
  removed: readonly RemovedEntry<T>[],
  same: (a: T, b: T) => boolean = (a, b) => a === b,
): T[] {
  const next = [...current];
  for (const { index, value } of [...removed].sort((a, b) => a.index - b.index)) {
    if (next.some(v => same(v, value))) continue;
    next.splice(Math.min(index, next.length), 0, value);
  }
  return next;
}

export type DeleteOutcome = "ok" | "deleteFailed" | "clearFailed";

/** `clearOk` is null when no variant main image needed clearing. */
export function deleteOutcome(deleteOk: boolean, clearOk: boolean | null): DeleteOutcome {
  if (!deleteOk) return "deleteFailed";
  if (clearOk === false) return "clearFailed";
  return "ok";
}

/** Drops queued (not yet uploaded) media whose local preview is among `previewUrls`. */
export function removePendingNewMedia<T extends { previewUrl?: string }>(
  list: T[],
  previewUrls: Iterable<string>,
): T[] {
  const set = new Set(previewUrls);
  return list.filter(m => !(m.previewUrl && set.has(m.previewUrl)));
}
