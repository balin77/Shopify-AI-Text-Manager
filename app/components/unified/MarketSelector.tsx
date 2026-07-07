/**
 * MarketSelector — dropdown for the market dimension of translations
 * ("Translate & Adapt"). Lets the merchant target a market so the same locale
 * can be translated differently per market (e.g. English for UK vs. US).
 *
 * Placement: right-aligned in the language bar, to the right of the locale
 * buttons. Default option is "All markets (global)" (value ""). A market with an
 * explicit web-presence locale list is offered only for those locales; a market
 * that shares the primary web presence (no dedicated locale list) is offered for
 * every locale, matching Shopify's "Translate & Adapt". Disabled in the primary
 * locale (Shopify has no market-specific primary content) and hidden entirely
 * when the shop has no markets.
 */

import { Select, Tooltip } from "@shopify/polaris";
import type { MarketInfo } from "../../types/content-editor.types";

interface MarketSelectorProps {
  markets: MarketInfo[];
  selectedMarketId: string;
  currentLanguage: string;
  primaryLocale: string;
  onMarketChange: (marketId: string) => void;
  /**
   * Allow market selection in the primary locale. Off by default: Shopify's
   * translatable content has no market-specific primary value. DirectTranslations
   * is the exception — it is a custom storefront dictionary where a market
   * override is valid for any locale, including the primary one.
   */
  allowPrimaryLocale?: boolean;
  /** i18n strings */
  t: {
    allMarketsGlobal: string;
    selectorLabel: string;
    /** Hover hint explaining the selector (shown when it is usable). */
    tooltip?: string;
    /** Hover hint explaining WHY the selector is greyed out in the primary locale. */
    primaryDisabledHint?: string;
  };
}

export function MarketSelector({
  markets,
  selectedMarketId,
  currentLanguage,
  primaryLocale,
  onMarketChange,
  allowPrimaryLocale = false,
  t,
}: MarketSelectorProps) {
  // Nothing to choose from → render nothing (keeps the bar clean).
  if (!markets || markets.length === 0) return null;

  const isPrimaryLocale = currentLanguage === primaryLocale;

  // A market with an explicit web-presence locale list is offered only for those
  // locales. A market with no dedicated web presence (localeCodes empty) shares
  // the shop's presence and can carry market-specific translations for ANY of the
  // shop's locales, so it always applies.
  const applicableMarkets = markets.filter(
    (m) => m.localeCodes.length === 0 || m.localeCodes.includes(currentLanguage),
  );

  // Disabled in the primary locale (unless the caller opts in, e.g.
  // DirectTranslations) or when no market serves this locale — only "global"
  // is available; the disabled control keeps the layout stable.
  const disabled = (isPrimaryLocale && !allowPrimaryLocale) || applicableMarkets.length === 0;

  const options = [
    { label: t.allMarketsGlobal, value: "" },
    ...applicableMarkets.map((m) => ({ label: m.name, value: m.id })),
  ];

  // Only the primary locale gets a tooltip — it explains why the control is
  // greyed out there. Foreign locales have a usable selector and need no hint.
  // Show only the first clause (before the dash) per product decision. Wraps the
  // control so the hint is reachable even though the disabled <Select> swallows
  // hover events.
  const showPrimaryHint = disabled && isPrimaryLocale && !allowPrimaryLocale;
  const primaryHint = (
    t.primaryDisabledHint || "Market selection is only available in a translation language"
  )
    .split(/\s[–—-]\s/)[0]
    .trim();

  const control = (
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

  return showPrimaryHint ? (
    <Tooltip content={primaryHint} preferredPosition="below" dismissOnMouseOut>
      {control}
    </Tooltip>
  ) : control;
}
