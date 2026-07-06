/**
 * MarketSelector — dropdown for the market dimension of translations
 * ("Translate & Adapt"). Lets the merchant target a market so the same locale
 * can be translated differently per market (e.g. English for UK vs. US).
 *
 * Placement: right-aligned in the language bar, to the right of the locale
 * buttons. Default option is "All markets (global)" (value ""). Only markets
 * that serve the currently-viewed locale are offered — a market-specific
 * translation for a locale the market doesn't publish would never render on the
 * storefront. Disabled in the primary locale (Shopify has no market-specific
 * primary content) and hidden entirely when the shop has no markets.
 */

import { Select } from "@shopify/polaris";
import type { MarketInfo } from "../../types/content-editor.types";

interface MarketSelectorProps {
  markets: MarketInfo[];
  selectedMarketId: string;
  currentLanguage: string;
  primaryLocale: string;
  onMarketChange: (marketId: string) => void;
  /** i18n strings */
  t: {
    allMarketsGlobal: string;
    selectorLabel: string;
  };
}

export function MarketSelector({
  markets,
  selectedMarketId,
  currentLanguage,
  primaryLocale,
  onMarketChange,
  t,
}: MarketSelectorProps) {
  // Nothing to choose from → render nothing (keeps the bar clean).
  if (!markets || markets.length === 0) return null;

  const isPrimaryLocale = currentLanguage === primaryLocale;

  // Only markets that publish the current locale can carry a meaningful
  // market-specific translation for it.
  const applicableMarkets = markets.filter((m) =>
    m.localeCodes.includes(currentLanguage),
  );

  // In the primary locale (or when no market serves this locale) only "global"
  // is available — show the disabled selector so the control stays in place.
  const disabled = isPrimaryLocale || applicableMarkets.length === 0;

  const options = [
    { label: t.allMarketsGlobal, value: "" },
    ...applicableMarkets.map((m) => ({ label: m.name, value: m.id })),
  ];

  return (
    <div style={{ minWidth: "12rem" }}>
      <Select
        label={t.selectorLabel}
        labelHidden
        options={options}
        // If the selected market no longer applies (locale changed), the value
        // falls back to "" so the control never shows a stale selection.
        value={disabled ? "" : selectedMarketId}
        onChange={onMarketChange}
        disabled={disabled}
      />
    </div>
  );
}
