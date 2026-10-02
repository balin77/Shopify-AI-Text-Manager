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
