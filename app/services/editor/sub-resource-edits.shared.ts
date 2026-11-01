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
 * One rule for both, in one place: an edit goes when the save settled it
 * (saved with the value the field still holds, or failed and is reverted); it
 * stays when it is still unsaved (a kept draft, something typed after the save
 * went out, or a retype of a field that was sent).
 *
 * Client-safe, imports only another shared module.
 */

import { isSentMetafieldEdit, hasUnsavedPrimaryMetafieldEdits } from "../product-metafields.shared";

export interface OptionEdit {
  name: string;
  values: string[];
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

/** The sent shape of one option (see `optionsChanges` in the hook's save). */
export interface SentOptionChange {
  name?: string;
  valueUpdates?: Array<{ id: string; name: string }>;
  valuesToAdd?: unknown;
  valuesToDelete?: unknown;
  valuesToAddLinked?: unknown;
}

/** Does this option edit differ from the option it edits (name or any value)? */
export function isOptionEditUnsaved(original: OptionLike, edit: OptionEdit): boolean {
  if (edit.name !== undefined && edit.name !== original.name) return true;
  if (edit.values === undefined) return false;
  return original.values.some((v, i) => (edit.values[i] ?? v.name) !== v.name);
}

export function metafieldEditsAfterSave(args: {
  edits: Readonly<Record<string, string>>;
  /** metafieldId -> the value the save sent (`primaryMetafieldChange`'s value). */
  sent: Readonly<Record<string, unknown>>;
  failedIds: readonly string[];
  /** Failed, but nothing was written and the text stays as a draft. */
  unverifiedIds: ReadonlySet<string>;
  findOriginal: (id: string) => MetafieldOriginal | undefined;
}): Record<string, string> {
  const failed = new Set(args.failedIds.map(String));
  const kept: Record<string, string> = {};
  for (const [id, value] of Object.entries(args.edits)) {
    let stays: boolean;
    if (args.unverifiedIds.has(id)) {
      stays = true;
    } else if (failed.has(id)) {
      stays = false; // reverted
    } else if (!(id in args.sent)) {
      stays = true; // never sent: typed after the save went out
    } else {
      const original = args.findOriginal(id);
      // Saved: it goes unless the field was retyped since.
      stays = original ? !isSentMetafieldEdit(original, value, args.sent[id]) : false;
    }
    if (stays) kept[id] = value;
  }
  return kept;
}

export function optionEditsAfterSave(args: {
  edits: Readonly<Record<string, OptionEdit>>;
  sent: Readonly<Record<string, SentOptionChange>>;
  failedIds: readonly string[];
  findOriginal: (id: string) => OptionLike | undefined;
}): Record<string, OptionEdit> {
  const failed = new Set(args.failedIds.map(String));
  const kept: Record<string, OptionEdit> = {};
  for (const [id, edit] of Object.entries(args.edits)) {
    const original = args.findOriginal(id);
    if (!original || failed.has(id)) continue; // reverted / gone
    const change = args.sent[id];
    if (!change) {
      // Not part of the save: it stays only if it is a real, unsaved edit.
      if (isOptionEditUnsaved(original, edit)) kept[id] = edit;
      continue;
    }
    // Values were added or removed in the same save: the reload re-numbers the
    // option's values, so a positional edit cannot be carried across it.
    if (change.valuesToAdd || change.valuesToDelete || change.valuesToAddLinked) continue;
    const renamed = new Map((change.valueUpdates ?? []).map((u) => [u.id, u.name]));
    const expectedName = change.name ?? original.name;
    const holdsSent =
      edit.name === expectedName &&
      original.values.every((v, i) => (edit.values?.[i] ?? v.name) === (renamed.get(v.id) ?? v.name));
    if (!holdsSent) kept[id] = edit; // retyped while the save was out
  }
  return kept;
}

/** Is anything in the two edit maps still a real difference from the item? */
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
