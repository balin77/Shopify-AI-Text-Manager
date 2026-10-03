/**
 * What the sub-resource card still has UNSAVED, as one pure answer.
 *
 * `hasChanges` used to be a flag that every translate/copy response forced to
 * `false`, so an unrelated unsaved edit (another option, a created or deleted
 * option, a reorder) lost its save bar the moment one field was translated.
 * The flag is now recomputed from the pending sets instead.
 *
 * Client-safe, imports nothing.
 */

export interface SubResourcePendingState {
  dirtyOptionIds: ReadonlySet<string>;
  dirtyOptionValueIds: ReadonlySet<string>;
  dirtyMetafieldIds: ReadonlySet<string>;
  primaryOptionEdits: Readonly<Record<string, unknown>>;
  primaryMetafieldEdits: Readonly<Record<string, unknown>>;
  optionValuesToAdd: Readonly<Record<string, readonly unknown[]>>;
  optionLinkedValuesToAdd: Readonly<Record<string, readonly unknown[]>>;
  optionValuesToDelete: Readonly<Record<string, readonly unknown[]>>;
  optionsToCreate: readonly unknown[];
  optionsToDelete: readonly unknown[];
  optionOrder: readonly unknown[] | null;
  optionValueOrder: Readonly<Record<string, readonly unknown[]>>;
}

const anyNonEmpty = (record: Readonly<Record<string, readonly unknown[]>>): boolean =>
  Object.values(record).some((list) => list.length > 0);

/** True while anything the merchant did in the card is still waiting for a save. */
export function hasPendingSubResourceChanges(p: SubResourcePendingState): boolean {
  return (
    p.dirtyOptionIds.size > 0 ||
    p.dirtyOptionValueIds.size > 0 ||
    p.dirtyMetafieldIds.size > 0 ||
    Object.keys(p.primaryOptionEdits).length > 0 ||
    Object.keys(p.primaryMetafieldEdits).length > 0 ||
    anyNonEmpty(p.optionValuesToAdd) ||
    anyNonEmpty(p.optionLinkedValuesToAdd) ||
    anyNonEmpty(p.optionValuesToDelete) ||
    p.optionsToCreate.length > 0 ||
    p.optionsToDelete.length > 0 ||
    p.optionOrder !== null ||
    Object.keys(p.optionValueOrder).length > 0
  );
}

/** A copy of `set` without `ids` (the resources a save just confirmed). */
export function withoutIds(set: ReadonlySet<string>, ids: Iterable<string>): Set<string> {
  const next = new Set(set);
  for (const id of ids) next.delete(id);
  return next;
}

/**
 * The warning the primary save answers with when removing stale foreign
 * translations was not confirmed. Fields may be absent on older servers.
 */
export function unconfirmedPurgeOf(
  data: { warnings?: unknown; unconfirmedPurge?: unknown } | null | undefined,
): { unconfirmed: boolean; resourceIds: string[] } {
  const warnings = Array.isArray(data?.warnings) ? (data!.warnings as unknown[]) : [];
  const ids = Array.isArray(data?.unconfirmedPurge)
    ? (data!.unconfirmedPurge as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
  return { unconfirmed: warnings.includes("translationPurgeUnconfirmed") || ids.length > 0, resourceIds: ids };
}
