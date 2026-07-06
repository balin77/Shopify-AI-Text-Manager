/**
 * Helpers for the market-specific translation layer.
 *
 * ContentTranslation rows now carry a `marketId` ("" = global, otherwise
 * gid://shopify/Market/<id>). Loaders keep the global rows in the existing
 * per-item `translations` array (unchanged behaviour) and surface the
 * market-specific rows separately as a nested lookup so the editor's resolve()
 * chain can layer them on top of the global values.
 */

import type { MarketTranslations } from "../types/content-editor.types";

/** Minimal row shape needed to bucket a translation into the market lookup. */
interface MarketTranslationRow {
  marketId: string;
  key: string;
  locale: string;
  value: string;
}

/**
 * Group market-specific rows (marketId !== "") into
 *   { [marketId]: { [translationKey]: { [locale]: value } } }.
 *
 * Global rows (marketId === "") are ignored — they belong in `translations`.
 */
export function buildMarketTranslations(rows: MarketTranslationRow[]): MarketTranslations {
  const result: MarketTranslations = {};
  for (const row of rows) {
    if (!row.marketId) continue; // global row — not part of the market layer
    const byKey = (result[row.marketId] ??= {});
    const byLocale = (byKey[row.key] ??= {});
    byLocale[row.locale] = row.value;
  }
  return result;
}
