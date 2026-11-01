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
 * `unverifiedIds`). Comparing against `selectedItem` instead cannot work: React
 * Router commits the fetcher's `idle` and the reloaded loader data in the SAME
 * update, so by the time the answer is processed the item is usually already
 * POST-save, and an edit then reads as "unchanged" (never settled) or, for a
 * reordered option, as a mismatch.
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
}

/** A deep copy: later state updates must not reach into what was sent. */
export function snapshotPrimaryEdits(args: {
  metafieldEdits: Readonly<Record<string, string>>;
  optionEdits: Readonly<Record<string, OptionEdit>>;
  optionsToDelete: readonly string[];
  valuesToDelete: Readonly<Record<string, readonly string[]>>;
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
