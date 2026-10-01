/**
 * The sub-resource editor's staged-value overlay: how a confirmed save, a
 * primary save's purge and a late translate answer move it.
 *
 * The overlay is `{ localeKey: { resourceId: { key: value } } }`; a reader
 * merges it OVER the loaded item, so an entry that outlives the truth it
 * staged shadows fresh data. Client-safe and import-free.
 */

export type SubResourceOverlay = Record<string, Record<string, Record<string, string>>>;

/** Only these two keys exist on option / metafield resources. */
const STAGEABLE_KEYS = new Set(["name", "value"]);

/**
 * Writes what a foreign save CONFIRMED into `overlay[localeKey]`: every
 * submitted resource except the failed ones. Without it a value staged by an
 * earlier translate keeps shadowing what the merchant typed and saved.
 * Resources named in `skipIds` (not translatable, so nothing was saved) are
 * left alone.
 */
export function recordConfirmedForeignSave(
  overlay: SubResourceOverlay,
  localeKey: string,
  submitted: Record<string, Record<string, string>>,
  failedIds: readonly string[] = [],
  skipIds: readonly string[] = [],
): boolean {
  const failed = new Set(failedIds);
  const skip = new Set(skipIds);
  let touched = false;
  for (const [resourceId, fields] of Object.entries(submitted)) {
    if (failed.has(resourceId) || skip.has(resourceId)) continue;
    for (const [key, value] of Object.entries(fields || {})) {
      if (!STAGEABLE_KEYS.has(key) || typeof value !== "string") continue;
      ((overlay[localeKey] ??= {})[resourceId] ??= {})[key] = value;
      touched = true;
    }
  }
  return touched;
}

/**
 * A primary save changed these resources' source text, so every language's
 * staged value for them describes text that no longer exists. Removed from
 * all locale keys, EXCEPT ids whose stale translation could not be removed on
 * Shopify (still live: their staged value is what the card must keep).
 */
export function dropOverlayForPrimaryChange(
  overlay: SubResourceOverlay,
  changedIds: Iterable<string>,
  keepIds: ReadonlySet<string> | readonly string[] = [],
): boolean {
  const keep = keepIds instanceof Set ? keepIds : new Set(keepIds as readonly string[]);
  const ids = [...changedIds].filter((id) => !keep.has(id));
  let touched = false;
  for (const localeKey of Object.keys(overlay)) {
    const byResource = overlay[localeKey];
    for (const id of ids) {
      if (id in byResource) {
        delete byResource[id];
        touched = true;
      }
    }
    if (Object.keys(byResource).length === 0) delete overlay[localeKey];
  }
  return touched;
}

/** The overlay reduced to the kept ids (an empty keep set empties it). */
export function overlayKeepingOnly(
  overlay: SubResourceOverlay,
  keepIds: ReadonlySet<string>,
): SubResourceOverlay {
  if (keepIds.size === 0) return {};
  const kept: SubResourceOverlay = {};
  for (const [key, byResource] of Object.entries(overlay)) {
    for (const [resourceId, fields] of Object.entries(byResource)) {
      if (!keepIds.has(resourceId)) continue;
      (kept[key] ??= {})[resourceId] = fields;
    }
  }
  return kept;
}

/**
 * Keep-list bookkeeping after a primary save: ids this save changed and that
 * came back NOT unconfirmed are no longer live-stale, so they leave the list;
 * unconfirmed ones join it.
 */
export function updateKeepIds(
  keep: Set<string>,
  changedIds: Iterable<string>,
  unconfirmedIds: readonly string[],
): void {
  for (const id of changedIds) keep.delete(id);
  for (const id of unconfirmedIds) keep.add(id);
}

/** Where a request was made from (captured at submit time). */
export interface TranslateTarget {
  itemId: string;
  locale: string;
  marketId: string;
}

/**
 * What to do with a translate answer that arrives later:
 * - `apply`: the editor still shows the requested item/language/market, so the
 *   answer is put into the visible state (and staged, in the global layer);
 * - `stage`: same item, a different view now — staged under the REQUESTED
 *   language only (never into what is showing);
 * - `skip`: another item is open (the overlay belongs to it), or the request
 *   was for a market view that is no longer showing.
 */
export function translateAnswerPlan(
  target: TranslateTarget | null,
  current: { itemId: string | undefined; locale: string; marketId: string },
): "apply" | "stage" | "skip" {
  if (!target || !target.itemId || target.itemId !== current.itemId) return "skip";
  if (target.locale === current.locale && target.marketId === current.marketId) return "apply";
  // A translate writes the global layer; a different market view has nothing to stage.
  if (target.marketId) return "skip";
  return "stage";
}

/** Stages answers under the requested locale; returns whether anything was staged. */
export function stageTranslateAnswer(
  overlay: SubResourceOverlay,
  localeKey: string,
  translations: Record<string, Record<string, string>> | undefined | null,
): boolean {
  if (!translations) return false;
  let touched = false;
  for (const [resourceId, fields] of Object.entries(translations)) {
    for (const [key, value] of Object.entries(fields || {})) {
      if (!STAGEABLE_KEYS.has(key) || typeof value !== "string" || !value) continue;
      ((overlay[localeKey] ??= {})[resourceId] ??= {})[key] = value;
      touched = true;
    }
  }
  return touched;
}

/** Resource ids a primary-save payload changes (options, their values, metafields). */
export function changedIdsOfPrimarySave(
  optionsChanges: Record<string, { valueUpdates?: Array<{ id: string }> }>,
  metafieldChanges: Record<string, unknown>,
): string[] {
  const ids = new Set<string>();
  for (const [optionId, change] of Object.entries(optionsChanges)) {
    ids.add(optionId);
    for (const v of change.valueUpdates ?? []) ids.add(v.id);
  }
  for (const id of Object.keys(metafieldChanges)) ids.add(id);
  return [...ids];
}
