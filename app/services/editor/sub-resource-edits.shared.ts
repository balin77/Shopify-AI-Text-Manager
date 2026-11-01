/**
 * What the primary card's edit maps hold AFTER a save answered.
 *
 * Both maps (`primaryMetafieldEdits`, `primaryOptionEdits`) used to be cleared
 * wholesale on a full success and pruned only for the FAILED ids on a partial
 * one. Two opposite bugs followed: on a clean save a field the merchant retyped
 * while the request was out was wiped (the save bar is not locked while a save
 * is in flight), and after a partial save the SAVED edits stayed behind, were
 * re-sent by the next Save and kept "Translate all" on "Save first".
 *
 * THE RULE, and why it never looks at the item. At submit the hook snapshots
 * the exact edits it sent. When the answer lands, an edit is SETTLED if it still
 * equals its snapshot, whatever the answer was for it (saved, or failed and
 * reverted): it goes. It STAYS if it differs from the snapshot (the merchant
 * retyped it while the request was out), if it has no snapshot (typed after
 * submit), or if it is a kept draft (nothing was written for it, see
 * `unverifiedIds`). Comparing against `selectedItem` instead cannot work: when
 * the answer is processed the item may be PRE-save or already the reloaded
 * POST-save one (the reload is asked for by the answer itself and lands later,
 * but a background refresh can beat it), and an edit then reads as "unchanged"
 * (never settled) or, for a reordered option, as a mismatch.
 *
 * Option edits are keyed by the value's stable GID, not by position: a save
 * that adds, removes or reorders values renumbers the list under a positional
 * edit and would pair a name with the wrong value.
 *
 * Client-safe, imports only another shared module.
 */

import { hasUnsavedPrimaryMetafieldEdits } from "../product-metafields.shared";

/**
 * One option's pending text edit. `name` is set only if the merchant touched it;
 * `values` holds ONLY the values they renamed, keyed by the value's GID (a value
 * that exists only locally has no GID and lives in `optionValuesToAdd`).
 */
export interface OptionEdit {
  name?: string;
  values: Record<string, string>;
}

export interface OptionLike {
  id: string;
  name: string;
  values: Array<{ id: string; name: string }>;
}

interface MetafieldOriginal {
  id: string;
  type: string;
  value: string;
}

/** The exact edits a save sent, captured at submit. */
export interface PrimarySaveSnapshot {
  metafieldEdits: Readonly<Record<string, string>>;
  optionEdits: Readonly<Record<string, OptionEdit>>;
  /** Options deleted by this save, and values removed from the surviving ones. */
  optionsToDelete: readonly string[];
  valuesToDelete: Readonly<Record<string, readonly string[]>>;
  /** Every structural list as it went out (what the answer may clear). */
  structural: StructuralLists;
}

/** A deep copy: later state updates must not reach into what was sent. */
export function snapshotPrimaryEdits(args: {
  metafieldEdits: Readonly<Record<string, string>>;
  optionEdits: Readonly<Record<string, OptionEdit>>;
  optionsToDelete: readonly string[];
  valuesToDelete: Readonly<Record<string, readonly string[]>>;
  structural: StructuralLists;
}): PrimarySaveSnapshot {
  const optionEdits: Record<string, OptionEdit> = {};
  for (const [id, edit] of Object.entries(args.optionEdits)) {
    optionEdits[id] = { ...(edit.name !== undefined ? { name: edit.name } : {}), values: { ...edit.values } };
  }
  return {
    metafieldEdits: { ...args.metafieldEdits },
    optionEdits,
    optionsToDelete: [...args.optionsToDelete],
    valuesToDelete: Object.fromEntries(Object.entries(args.valuesToDelete).map(([k, v]) => [k, [...v]])),
    structural: snapshotStructural(args.structural),
  };
}

/** Does this option edit differ from the option it edits (name or any renamed value)? */
export function isOptionEditUnsaved(original: OptionLike, edit: OptionEdit): boolean {
  if (edit.name !== undefined && edit.name !== original.name) return true;
  return Object.entries(edit.values ?? {}).some(([valueId, name]) => {
    const value = original.values.find((v) => v.id === valueId);
    return !!value && value.name !== name;
  });
}

export function metafieldEditsAfterSave(args: {
  edits: Readonly<Record<string, string>>;
  snapshot: Readonly<Record<string, string>>;
  /** Failed, but nothing was written and the text stays as a draft. */
  unverifiedIds: ReadonlySet<string>;
  /**
   * Cleared slots this save filled again: the slot's old id -> the GID Shopify
   * gave the re-created metafield. The old id is gone from the item after the
   * save, so a retype of such a field is re-keyed to the new one.
   */
  recreated?: Readonly<Record<string, string>>;
}): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [id, value] of Object.entries(args.edits)) {
    const target = args.recreated?.[id] ?? id;
    if (args.unverifiedIds.has(id)) {
      kept[id] = value; // nothing was written: the id is unchanged
      continue;
    }
    const snap = args.snapshot[id];
    if (snap === undefined || value !== snap) kept[target] = value; // typed after submit / retyped
  }
  return kept;
}

export function optionEditsAfterSave(args: {
  edits: Readonly<Record<string, OptionEdit>>;
  snapshot: PrimarySaveSnapshot;
}): Record<string, OptionEdit> {
  const kept: Record<string, OptionEdit> = {};
  const deletedOptions = new Set(args.snapshot.optionsToDelete);
  for (const [optionId, edit] of Object.entries(args.edits)) {
    if (deletedOptions.has(optionId)) continue; // the option itself is gone
    const snap = args.snapshot.optionEdits[optionId];
    const removed = new Set(args.snapshot.valuesToDelete[optionId] ?? []);
    const next: OptionEdit = { values: {} };
    // Name: stays only if retyped (or typed after submit).
    if (edit.name !== undefined && (!snap || snap.name === undefined || edit.name !== snap.name)) {
      next.name = edit.name;
    }
    // Values: each by its OWN id, so adds / removals / reorders in the same
    // save change nothing about which value an edit belongs to.
    for (const [valueId, name] of Object.entries(edit.values ?? {})) {
      if (removed.has(valueId)) continue; // that value no longer exists
      const sentName = snap?.values[valueId];
      if (sentName === undefined || name !== sentName) next.values[valueId] = name;
    }
    if (next.name !== undefined || Object.keys(next.values).length > 0) kept[optionId] = next;
  }
  return kept;
}

/** Anything left in the maps after a save is, by construction, still unsaved. */
export function hasKeptEdits(
  metafieldEdits: Readonly<Record<string, unknown>>,
  optionEdits: Readonly<Record<string, unknown>>,
): boolean {
  return Object.keys(metafieldEdits).length > 0 || Object.keys(optionEdits).length > 0;
}

/** Is anything in the two edit maps a real difference from the item? (item-relative; for the live card) */
export function hasUnsavedPrimaryEdits(args: {
  metafieldEdits: Readonly<Record<string, string>>;
  optionEdits: Readonly<Record<string, OptionEdit>>;
  metafields: ReadonlyArray<MetafieldOriginal> | undefined;
  clearedMetafields: ReadonlyArray<MetafieldOriginal> | undefined;
  options: ReadonlyArray<OptionLike> | undefined;
}): boolean {
  if (hasUnsavedPrimaryMetafieldEdits(args.metafieldEdits, args.metafields, args.clearedMetafields)) return true;
  for (const [id, edit] of Object.entries(args.optionEdits)) {
    const original = args.options?.find((o) => o.id === id);
    if (original && isOptionEditUnsaved(original, edit)) return true;
  }
  return false;
}

// ============================================================================
// Structural lists and foreign (translation) edits: settle only what a save carried
// ============================================================================
//
// The same rule as the text edits above, for the rest of what a Save sends. The
// answer used to clear EVERY structural list and EVERY dirty id wholesale, so an
// option value added, a field typed or a translation changed AFTER the press was
// dropped with a green toast. Now an answer removes exactly what its own payload
// carried (taken at press time) and leaves the rest.

export interface StructuralLists {
  valuesToAdd: Record<string, string[]>;
  linkedToAdd: Record<string, Array<{ id: string; name: string }>>;
  valuesToDelete: Record<string, string[]>;
  optionsToCreate: Array<{ name: string; values: string[] }>;
  optionsToDelete: string[];
  optionOrder: string[] | null;
  valueOrder: Record<string, string[]>;
}

export function snapshotStructural(lists: StructuralLists): StructuralLists {
  return JSON.parse(JSON.stringify(lists)) as StructuralLists;
}

/** `current` minus `carried`, each carried item removed ONCE (a multiset), by `key`. */
function minusOnce<T>(current: readonly T[], carried: readonly T[], key: (item: T) => string): T[] {
  const left = new Map<string, number>();
  for (const item of carried) left.set(key(item), (left.get(key(item)) ?? 0) + 1);
  const rest: T[] = [];
  for (const item of current) {
    const k = key(item);
    const n = left.get(k) ?? 0;
    if (n > 0) left.set(k, n - 1);
    else rest.push(item);
  }
  return rest;
}

/** What is left of the structural lists once the save that carried `carried` has answered. */
export function structuralAfterSave(current: StructuralLists, carried: StructuralLists): StructuralLists {
  const perOption = <T,>(cur: Record<string, T[]>, was: Record<string, T[]>, key: (item: T) => string) => {
    const out: Record<string, T[]> = {};
    for (const [optionId, list] of Object.entries(cur)) {
      const rest = minusOnce(list, was[optionId] ?? [], key);
      if (rest.length > 0) out[optionId] = rest;
    }
    return out;
  };
  const sameOrder = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const valueOrder: Record<string, string[]> = {};
  for (const [optionId, order] of Object.entries(current.valueOrder)) {
    if (!sameOrder(order, carried.valueOrder[optionId])) valueOrder[optionId] = order;
  }
  return {
    valuesToAdd: perOption(current.valuesToAdd, carried.valuesToAdd, (v) => v),
    linkedToAdd: perOption(current.linkedToAdd, carried.linkedToAdd, (v) => v.id),
    valuesToDelete: perOption(current.valuesToDelete, carried.valuesToDelete, (v) => v),
    optionsToCreate: minusOnce(current.optionsToCreate, carried.optionsToCreate, (o) => JSON.stringify(o)),
    optionsToDelete: minusOnce(current.optionsToDelete, carried.optionsToDelete, (o) => o),
    optionOrder: sameOrder(current.optionOrder, carried.optionOrder) ? null : current.optionOrder,
    valueOrder,
  };
}

export function hasStructural(lists: StructuralLists): boolean {
  const any = (r: Record<string, unknown[]>) => Object.values(r).some((l) => l.length > 0);
  return (
    any(lists.valuesToAdd) ||
    any(lists.linkedToAdd) ||
    any(lists.valuesToDelete) ||
    lists.optionsToCreate.length > 0 ||
    lists.optionsToDelete.length > 0 ||
    lists.optionOrder !== null ||
    Object.keys(lists.valueOrder).length > 0
  );
}

/**
 * The ids of a foreign save whose text was changed AFTER the press: what the
 * field holds now differs from what was sent. They stay dirty (and are neither
 * reverted nor marked saved); everything else the save carried is settled.
 */
export function retypedForeignIds(
  sent: Readonly<Record<string, Record<string, string>>>,
  currentText: (resourceId: string, key: string) => string | undefined,
): Set<string> {
  const retyped = new Set<string>();
  for (const [resourceId, fields] of Object.entries(sent)) {
    for (const [key, text] of Object.entries(fields)) {
      const now = currentText(resourceId, key);
      if (now !== undefined && now !== text) retyped.add(resourceId);
    }
  }
  return retyped;
}
