/**
 * "Clear all" for a FOREIGN locale on the product page, sub-resource half.
 *
 * The editor's clear-all empties the product's own fields and alt texts, but a
 * product's option names, option values and metafields translate on their OWN
 * Shopify resources (ProductOption / ProductOptionValue / Metafield GIDs), so
 * the product's `updateContent` never reaches them. This builds the payload of
 * the sub-resource save that removes them: every resource that holds a value
 * IN THE LAYER BEING CLEARED (the selected market's, else the global one) gets
 * its key sent as `""`, which the server turns into an echo-verified removal
 * and deletes the local row only for a confirmed key.
 *
 * Only resources that hold something are sent: an empty one would cost a
 * removal plus a gap re-read for nothing. Evidence of "holds something" is the
 * union of the loaded rows of that exact layer, the hook's resolved state
 * (minus values INHERITED from the global layer while a market is selected —
 * those are not the market's to clear) and the staged overlay of that layer.
 *
 * Linked option VALUES are left out, exactly like the foreign save: their
 * text comes from a metaobject entry and is translated there.
 *
 * Client-safe and import-free.
 */

export interface ClearAllSubResourceItem {
  options?: Array<{
    id: string;
    isLinked?: boolean;
    values: Array<{ id?: string }>;
  }>;
  metafields?: Array<{ id: string }>;
  subResourceTranslations?: Record<string, Array<{ key: string; value: string; locale: string; marketId?: string }>>;
}

export interface ClearAllSubResourceInput {
  item: ClearAllSubResourceItem;
  locale: string;
  /** "" = the global layer. */
  marketId: string;
  /** The hook's resolved state for the CURRENT view. */
  optionTranslations: Record<string, { name: string; values: string[] }>;
  metafieldTranslations: Record<string, string>;
  /** Resources whose displayed value is inherited from the global layer. */
  fallbackResourceIds: ReadonlySet<string>;
  /** The staged overlay entries of this exact (locale, market) layer. */
  overlayForLayer?: Record<string, Record<string, string>>;
}

export interface ClearAllSubResourcePayload {
  translationsData: Record<string, Record<string, string>>;
  resourceTypes: Record<string, string>;
}

export function buildClearAllSubResourcePayload(input: ClearAllSubResourceInput): ClearAllSubResourcePayload {
  const { item, locale, optionTranslations, metafieldTranslations, fallbackResourceIds } = input;
  const layer = input.marketId || "";
  const overlay = input.overlayForLayer || {};
  const rows = item.subResourceTranslations || {};

  const holdsValue = (resourceId: string, key: string, stateValue: string | undefined): boolean => {
    if ((rows[resourceId] || []).some(
      (r) => r.locale === locale && (r.marketId ?? "") === layer && r.key === key && (r.value ?? "") !== "",
    )) return true;
    if ((overlay[resourceId]?.[key] ?? "") !== "") return true;
    // An inherited global value is shown, not held, by a market layer.
    if (layer && fallbackResourceIds.has(resourceId)) return false;
    return (stateValue ?? "") !== "";
  };

  const translationsData: Record<string, Record<string, string>> = {};
  const resourceTypes: Record<string, string> = {};
  const add = (resourceId: string, key: string, type: string) => {
    translationsData[resourceId] = { [key]: "" };
    resourceTypes[resourceId] = type;
  };

  for (const opt of item.options || []) {
    const state = optionTranslations[opt.id];
    if (holdsValue(opt.id, "name", state?.name)) add(opt.id, "name", "ProductOption");
    if (opt.isLinked) continue;
    opt.values.forEach((val, index) => {
      if (!val.id) return;
      if (holdsValue(val.id, "name", state?.values?.[index])) add(val.id, "name", "ProductOptionValue");
    });
  }

  for (const mf of item.metafields || []) {
    if (holdsValue(mf.id, "value", metafieldTranslations[mf.id])) add(mf.id, "value", "Metafield");
  }

  return { translationsData, resourceTypes };
}

// ============================================================================
// Overlay bookkeeping of a clear-all request
// ============================================================================
//
// A clear-all is its OWN request (several translates, copies and the save bar
// can be out beside it), so it carries its own record of what it staged. While
// it is in flight, and after Shopify CONFIRMED a removal, the cleared field is
// a STAGED EMPTY VALUE in the overlay: every reader (the Phase-1 re-read, a
// Phase-2 Shopify supplement, a reload's overlay reset within the two-minute
// keep) merges the overlay over the loaded item, and the item still carries
// the removed row until the next loader run -- without the staged "" a reload
// or a late Phase-2 answer resurrected exactly what the merchant had cleared.

export type SubResourceOverlayMap = Record<string, Record<string, Record<string, string>>>;

/** What the overlay of one layer held for each cleared (resource, key) before the clear. */
export type ClearAllSnapshot = Record<string, Record<string, string | undefined>>;

/** Stages `""` for every sent pair in `overlay[layerKey]`; returns what was there. */
export function stageClearAll(
  overlay: SubResourceOverlayMap,
  layerKey: string,
  sent: Record<string, Record<string, string>>,
): ClearAllSnapshot {
  const snapshot: ClearAllSnapshot = {};
  for (const [resourceId, fields] of Object.entries(sent)) {
    for (const key of Object.keys(fields || {})) {
      (snapshot[resourceId] ??= {})[key] = overlay[layerKey]?.[resourceId]?.[key];
      ((overlay[layerKey] ??= {})[resourceId] ??= {})[key] = "";
    }
  }
  return snapshot;
}

function restorePair(
  overlay: SubResourceOverlayMap,
  layerKey: string,
  resourceId: string,
  key: string,
  value: string | undefined,
): void {
  if (value !== undefined) {
    ((overlay[layerKey] ??= {})[resourceId] ??= {})[key] = value;
    return;
  }
  const entry = overlay[layerKey]?.[resourceId];
  if (!entry || !(key in entry)) return;
  delete entry[key];
  if (Object.keys(entry).length === 0) delete overlay[layerKey][resourceId];
  if (Object.keys(overlay[layerKey]).length === 0) delete overlay[layerKey];
}

/**
 * The ids of a clear-all request that Shopify CONFIRMED: sent, not failed, not
 * untranslatable, and -- where the server names what it saved -- on that list.
 * A whole-request failure confirms nothing.
 */
export function confirmedClearIds(
  sent: Record<string, Record<string, string>>,
  answer: { success?: boolean; failedResources?: string[]; notTranslatable?: string[]; savedResources?: string[] } | null,
): Set<string> {
  const confirmed = new Set<string>();
  if (!answer || answer.success === false) return confirmed;
  const failed = new Set(answer.failedResources || []);
  const skip = new Set(answer.notTranslatable || []);
  const saved = Array.isArray(answer.savedResources) ? new Set(answer.savedResources) : null;
  for (const resourceId of Object.keys(sent)) {
    if (failed.has(resourceId) || skip.has(resourceId)) continue;
    if (saved && !saved.has(resourceId)) continue;
    confirmed.add(resourceId);
  }
  return confirmed;
}

/**
 * Settles the overlay once the answer is in:
 * - UNCONFIRMED ids get back what the overlay held before (the translation is
 *   still live, so the staged "" would hide it);
 * - a confirmed GLOBAL removal keeps its staged "" (see the note above);
 * - a confirmed MARKET removal drops the entry: the market now inherits the
 *   global value, which a staged "" would hide behind an empty field.
 */
export function settleClearAll(
  overlay: SubResourceOverlayMap,
  layerKey: string,
  snapshot: ClearAllSnapshot,
  confirmed: ReadonlySet<string>,
  marketLayer: boolean,
): void {
  for (const [resourceId, keys] of Object.entries(snapshot)) {
    for (const [key, previous] of Object.entries(keys)) {
      if (!confirmed.has(resourceId)) restorePair(overlay, layerKey, resourceId, key, previous);
      else if (marketLayer) restorePair(overlay, layerKey, resourceId, key, undefined);
    }
  }
}

/**
 * Applies the overlay's staged EMPTY values to the option state. The field
 * merges skip empty values on purpose (an answer that carries nothing for a
 * field must not blank it), so a staged clear has to be applied on its own
 * after them, or a Shopify read taken before the removal puts the value back.
 */
export function applyStagedOptionClears<T extends { name: string; values: string[] }>(
  prev: Record<string, T>,
  item: { options?: Array<{ id: string; values: Array<{ id?: string }> }> } | null | undefined,
  overlayForView: Record<string, Record<string, string>>,
): Record<string, T> {
  let next = prev;
  for (const opt of item?.options || []) {
    const current = next[opt.id];
    if (!current) continue;
    const clearName = overlayForView[opt.id]?.name === "" && current.name !== "";
    const clearIdx: number[] = [];
    opt.values.forEach((v, i) => {
      if (v.id && overlayForView[v.id]?.name === "" && (current.values[i] ?? "") !== "") clearIdx.push(i);
    });
    if (!clearName && clearIdx.length === 0) continue;
    const values = [...current.values];
    for (const i of clearIdx) values[i] = "";
    if (next === prev) next = { ...prev };
    next[opt.id] = { ...current, name: clearName ? "" : current.name, values };
  }
  return next;
}

/** The metafield half of `applyStagedOptionClears`. */
export function applyStagedMetafieldClears(
  prev: Record<string, string>,
  overlayForView: Record<string, Record<string, string>>,
): Record<string, string> {
  let next = prev;
  for (const [id, fields] of Object.entries(overlayForView)) {
    if (fields?.value !== "" || !(id in prev) || prev[id] === "") continue;
    if (next === prev) next = { ...prev };
    next[id] = "";
  }
  return next;
}
