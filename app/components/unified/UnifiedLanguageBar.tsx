/**
 * UnifiedLanguageBar - Advanced language navigation with translation features
 *
 * Combines the best features from both systems:
 * - Language switching with visual indicators
 * - Translate All button (from products page)
 * - Ctrl+Click to enable/disable languages
 * - ReloadButton integration
 * - Color-coded translation status
 * - Responsive layout
 *
 * Used by: Products, Collections, Pages, Blogs, Articles, Policies, etc.
 */

import { useRef } from "react";
import { Button, InlineStack, ButtonGroup, Tooltip } from "@shopify/polaris";
import { useLocaleButtonStyle, getLocaleButtonTooltip, getLocalizedLanguageName } from "../../utils/contentEditor.utils";
import type { ValidationOverlays } from "../../utils/contentEditor.utils";
import { ReloadButton } from "../ReloadButton";
import { HelpTooltip } from "../HelpTooltip";
import { MarketSelector } from "./MarketSelector";
import { useI18n } from "../../contexts/I18nContext";
import type { ShopLocale, TranslatableItem, ContentType, MarketInfo } from "../../types/content-editor.types";

interface UnifiedLanguageBarProps {
  /** Shop locales from Shopify */
  shopLocales: ShopLocale[];

  /** Currently selected language */
  currentLanguage: string;

  /** Primary locale (e.g., "de") */
  primaryLocale: string;

  /** Currently selected item */
  selectedItem: TranslatableItem | null;

  /** Content type for translation status */
  contentType: ContentType;

  /** Whether there are unsaved changes */
  hasChanges: boolean;

  /** Callback when language changes */
  onLanguageChange: (locale: string) => void;

  /** Markets for the market selector ([] hides it) */
  markets?: MarketInfo[];

  /** Selected market ("" = global) */
  selectedMarketId?: string;

  /** Callback when the market changes */
  onMarketChange?: (marketId: string) => void;

  /** Allow market selection in the primary locale (DirectTranslations only) */
  allowPrimaryLocaleMarket?: boolean;

  /** Optional: Array of enabled languages */
  enabledLanguages?: string[];

  /** Optional: Callback to toggle language on/off (Ctrl+Click) */
  onToggleLanguage?: (locale: string) => void;

  /** Optional: Callback for "Translate All" button */
  onTranslateAll?: () => void;

  /** Optional: Whether translation is in progress */
  isTranslating?: boolean;

  /** Optional: Show Translate All button (default: true for primary locale) */
  showTranslateAll?: boolean;

  /** Optional: Show Reload button (default: true) */
  showReloadButton?: boolean;

  /** Optional: Whether data is currently loading (suppresses blinking) */
  isLoadingData?: boolean;

  /** Overlay snapshot for overlay-aware validation markers */
  validationOverlays?: ValidationOverlays;
  /** Version counter — increments when overlays change */
  validationVersion?: number;

  /** Translation strings */
  t?: {
    primaryLocaleSuffix?: string;
    translateAll?: string;
    translating?: string;
    allMarketsGlobal?: string;
    marketSelectorLabel?: string;
    marketTooltip?: string;
    marketPrimaryDisabledHint?: string;
    marketDisabledReason?: string;
  };
}

export function UnifiedLanguageBar({
  shopLocales,
  currentLanguage,
  primaryLocale,
  selectedItem,
  contentType,
  hasChanges,
  onLanguageChange,
  markets = [],
  selectedMarketId = "",
  onMarketChange,
  allowPrimaryLocaleMarket = false,
  enabledLanguages,
  onToggleLanguage,
  onTranslateAll,
  isTranslating = false,
  showTranslateAll = true,
  showReloadButton = true,
  isLoadingData = false,
  validationOverlays,
  validationVersion,
  t = {},
}: UnifiedLanguageBarProps) {
  const isPrimaryLocale = currentLanguage === primaryLocale;
  const ctrlPressedRef = useRef<Record<string, boolean>>({});
  const { t: i18n, locale: appLocale } = useI18n();
  const tooltipI18n = {
    missingContent: i18n.common.missingContent,
    missingTranslations: i18n.common.missingTranslations,
    fieldLabels: i18n.common.fieldLabels,
  };

  // Map content type to resource type for the API
  const resourceTypeMap: Record<string, string> = {
    blogs: "article",
    pages: "page",
    policies: "policy",
    collections: "collection",
    products: "product",
  };
  const resourceType = resourceTypeMap[contentType] || contentType;

  return (
    <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", flex: 1, minWidth: 0, alignItems: "center" }}>
      {[...shopLocales].sort((a, b) => {
        if (a.primary) return -1;
        if (b.primary) return 1;
        return (a.name || a.locale).localeCompare(b.name || b.locale);
      }).map((locale) => (
        <LocaleButton
          key={locale.locale}
          locale={locale}
          selectedItem={selectedItem}
          primaryLocale={primaryLocale}
          contentType={contentType}
          isLoadingData={isLoadingData}
          validationOverlays={validationOverlays}
          validationVersion={validationVersion}
          enabledLanguages={enabledLanguages}
          currentLanguage={currentLanguage}
          onLanguageChange={onLanguageChange}
          onToggleLanguage={onToggleLanguage}
          ctrlPressedRef={ctrlPressedRef}
          appLocale={appLocale}
          tooltipI18n={tooltipI18n}
          primaryLocaleSuffix={t.primaryLocaleSuffix}
        />
      ))}
      <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "0.5rem" }}>
        {onMarketChange && markets.length > 0 && (
          <MarketSelector
            markets={markets}
            selectedMarketId={selectedMarketId}
            currentLanguage={currentLanguage}
            primaryLocale={primaryLocale}
            onMarketChange={onMarketChange}
            allowPrimaryLocale={allowPrimaryLocaleMarket}
            t={{
              allMarketsGlobal: t.allMarketsGlobal || "All markets (global)",
              selectorLabel: t.marketSelectorLabel || "Market",
              tooltip: t.marketTooltip,
              primaryDisabledHint: t.marketPrimaryDisabledHint,
              disabledReason: t.marketDisabledReason,
            }}
          />
        )}
        <HelpTooltip helpKey="ctrlClickLanguage" position="below" />
      </div>
    </div>
  );
}

/**
 * One locale button — extracted as a component so the `useLocaleButtonStyle`
 * hook isn't called inside a `.map()` callback (would violate React's Rules of
 * Hooks; the previous inline call only worked because the locale list happens
 * to be stable per render).
 */
interface LocaleButtonProps {
  locale: ShopLocale;
  selectedItem: TranslatableItem | null;
  primaryLocale: string;
  contentType: ContentType;
  isLoadingData: boolean;
  validationOverlays?: ValidationOverlays;
  validationVersion?: number;
  enabledLanguages?: string[];
  currentLanguage: string;
  onLanguageChange: (locale: string) => void;
  onToggleLanguage?: (locale: string) => void;
  ctrlPressedRef: React.MutableRefObject<Record<string, boolean>>;
  appLocale: string;
  tooltipI18n: {
    missingContent: string;
    missingTranslations: string;
    fieldLabels: Record<string, string>;
  };
  primaryLocaleSuffix?: string;
}

function LocaleButton({
  locale,
  selectedItem,
  primaryLocale,
  contentType,
  isLoadingData,
  validationOverlays,
  validationVersion,
  enabledLanguages,
  currentLanguage,
  onLanguageChange,
  onToggleLanguage,
  ctrlPressedRef,
  appLocale,
  tooltipI18n,
  primaryLocaleSuffix,
}: LocaleButtonProps) {
  const buttonStyle = useLocaleButtonStyle(
    locale,
    selectedItem,
    primaryLocale,
    contentType,
    isLoadingData,
    validationOverlays,
    validationVersion,
  );

  const isEnabled = !enabledLanguages || enabledLanguages.includes(locale.locale);
  const isPrimary = locale.primary;
  const isCurrentLanguage = currentLanguage === locale.locale;

  const buttonProps = {
    variant: isCurrentLanguage ? ("primary" as const) : undefined,
    onClick: () => {
      if (ctrlPressedRef.current[locale.locale]) {
        ctrlPressedRef.current[locale.locale] = false;
        return;
      }
      onLanguageChange(locale.locale);
    },
    onPointerDown: (event: React.PointerEvent) => {
      if (event.ctrlKey && onToggleLanguage && !isPrimary) {
        ctrlPressedRef.current[locale.locale] = true;
        event.preventDefault();
        onToggleLanguage(locale.locale);
      }
    },
    size: "slim" as const,
    tone: (!isEnabled && !isPrimary ? ("critical" as const) : undefined),
  };

  const fullLabel = `${getLocalizedLanguageName(locale.locale, appLocale, locale.name)}${
    locale.primary ? ` (${primaryLocaleSuffix || "Primary"})` : ""
  }`;
  const shortLabel = locale.locale.charAt(0).toUpperCase() + locale.locale.slice(1);

  const tooltip = getLocaleButtonTooltip(
    locale,
    selectedItem,
    primaryLocale,
    contentType,
    isLoadingData,
    tooltipI18n,
    validationOverlays,
  );

  const buttonContent = (
    <div style={buttonStyle}>
      <div className="lang-full">
        <Button {...buttonProps}>{fullLabel}</Button>
      </div>
      <div className="lang-short">
        <Button {...buttonProps}>{shortLabel}</Button>
      </div>
    </div>
  );

  if (tooltip) {
    return (
      <Tooltip content={tooltip} dismissOnMouseOut preferredPosition="below">
        {buttonContent}
      </Tooltip>
    );
  }
  return buttonContent;
}
