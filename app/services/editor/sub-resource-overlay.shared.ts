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
  opts: { marketLayer?: boolean; savedIds?: readonly string[] | null } = {},
): boolean {
  const failed = new Set(failedIds);
  const skip = new Set(skipIds);
  // The server's own list of what it saved, where it sent one.
  const saved = opts.savedIds ? new Set(opts.savedIds) : null;
  let touched = false;
  for (const [resourceId, fields] of Object.entries(submitted)) {
    if (failed.has(resourceId) || skip.has(resourceId)) continue;
    if (saved && !saved.has(resourceId)) continue;
    for (const [key, value] of Object.entries(fields || {})) {
      if (!STAGEABLE_KEYS.has(key) || typeof value !== "string") continue;
      if (value === "" && opts.marketLayer) {
        // A confirmed removal of a market override: the market now INHERITS the
        // global value, which a staged "" would hide behind an empty field.
        const entry = overlay[localeKey]?.[resourceId];
        if (entry && key in entry) {
          delete entry[key];
          touched = true;
          if (Object.keys(entry).length === 0) delete overlay[localeKey][resourceId];
          if (Object.keys(overlay[localeKey]).length === 0) delete overlay[localeKey];
        }
        continue;
      }
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
 * - `apply`: the editor still shows the requested item/language (global
 *   layer), so the answer is put into the visible state (and staged);
 * - `stage`: same item, but the view is not the requested global one (another
 *   language, or a MARKET view: the server wrote the GLOBAL layer, which a
 *   market view must not show as its own override) -- staged under the
 *   requested language's global key only, never into what is showing;
 * - `skip`: another item is open (the overlay belongs to it).
 */
export function translateAnswerPlan(
  target: TranslateTarget | null,
  current: { itemId: string | undefined; locale: string; marketId: string },
): "apply" | "stage" | "skip" {
  if (!target || !target.itemId || target.itemId !== current.itemId) return "skip";
  if (!target.marketId && target.locale === current.locale && current.marketId === "") return "apply";
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
  optionsChanges: Record<string, { name?: string; valueUpdates?: Array<{ id: string }> }>,
  metafieldChanges: Record<string, unknown>,
): string[] {
  const ids = new Set<string>();
  for (const [optionId, change] of Object.entries(optionsChanges)) {
    // Mirrors the server's purge: the option's own name translation goes only
    // when the name was changed; added/deleted values touch no existing one.
    if (change?.name !== undefined) ids.add(optionId);
    for (const v of change?.valueUpdates ?? []) if (v?.id) ids.add(v.id);
  }
  for (const id of Object.keys(metafieldChanges)) ids.add(id);
  return [...ids];
}

/**
 * The ids of a primary save that a PARTIAL failure still saved: the sent ids
 * minus failed metafields, minus failed options and the value ids that
 * belong to a failed option.
 */
export function savedIdsAfterPartialSave(
  optionsChanges: Record<string, { name?: string; valueUpdates?: Array<{ id: string }> }>,
  metafieldChanges: Record<string, unknown>,
  failedOptionIds: readonly string[],
  failedMetafieldIds: readonly string[],
): string[] {
  const failedOptions = new Set(failedOptionIds);
  const failedMetafields = new Set(failedMetafieldIds);
  const okOptions: Record<string, { name?: string; valueUpdates?: Array<{ id: string }> }> = {};
  for (const [id, change] of Object.entries(optionsChanges)) if (!failedOptions.has(id)) okOptions[id] = change;
  const okMetafields: Record<string, unknown> = {};
  for (const [id, change] of Object.entries(metafieldChanges)) if (!failedMetafields.has(id)) okMetafields[id] = change;
  return changedIdsOfPrimarySave(okOptions, okMetafields);
}

// ============================================================================
// Expiry of staged entries
// ============================================================================
//
// An overlay entry exists to bridge the window between a confirmed write and
// the loaded item catching up with it. Nothing used to END that window: a
// staged value (a translate answer, a confirmed clear's "") outlived every
// locale switch and revalidation and kept shadowing newer server values --
// e.g. the translations a primary translate-to-all had just written. Each
// staged pair is therefore STAMPED (per layer key and resource) when it is
// written, and a reader prunes an entry once it is older than the keep window
// AND the item was loaded after it was staged -- by then the item carries the
// write, so the entry has nothing left to bridge.

/** `${layerKey}\u0000${resourceId}` -> when that entry was staged. */
export type OverlayStamps = Map<string, number>;

export function overlayStampKey(layerKey: string, resourceId: string): string {
  return `${layerKey}\u0000${resourceId}`;
}

/** Stamps the given resources of one layer key as staged at `at`. */
export function stampOverlay(
  stamps: OverlayStamps,
  layerKey: string,
  resourceIds: Iterable<string>,
  at: number,
): void {
  for (const id of resourceIds) stamps.set(overlayStampKey(layerKey, id), at);
}

/**
 * Removes every stamped entry older than `maxAgeMs` that the item, loaded at
 * `itemLoadedAt`, post-dates. Unstamped entries and `keepIds` (translations a
 * primary save could not remove -- still live) are left alone. Returns whether
 * anything was removed.
 */
export function pruneExpiredOverlay(
  overlay: SubResourceOverlay,
  stamps: OverlayStamps,
  opts: { now: number; itemLoadedAt: number; maxAgeMs: number; keepIds?: ReadonlySet<string> },
): boolean {
  let touched = false;
  for (const layerKey of Object.keys(overlay)) {
    const byResource = overlay[layerKey];
    for (const resourceId of Object.keys(byResource)) {
      if (opts.keepIds?.has(resourceId)) continue;
      const stampKey = overlayStampKey(layerKey, resourceId);
      const at = stamps.get(stampKey);
      if (at === undefined) continue;
      if (opts.now - at <= opts.maxAgeMs || opts.itemLoadedAt <= at) continue;
      delete byResource[resourceId];
      stamps.delete(stampKey);
      touched = true;
    }
    if (Object.keys(byResource).length === 0) delete overlay[layerKey];
  }
  return touched;
}
