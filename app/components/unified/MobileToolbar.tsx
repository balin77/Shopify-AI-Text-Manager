/**
 * MobileToolbar - Compact single-row toolbar for mobile devices
 *
 * Combines language selection + action buttons into one space-efficient bar:
 * - Horizontally scrollable language buttons (no wrapping)
 * - Save button always visible (primary action)
 * - ReloadButton visible as icon button
 * - Secondary actions (Translate All, Clear All, Discard) in a Popover menu
 *
 * Replaces the two separate Cards (LanguageBar + OperationButtons) on mobile.
 */

import type { ReloadResourceType } from "../../utils/reload-resource-type";
import { useState, useCallback } from "react";
import { Card, Button, Popover, ActionList, Tooltip } from "@shopify/polaris";
import { MenuHorizontalIcon } from "@shopify/polaris-icons";
import { useLocaleButtonStyle, getLocaleButtonTooltip } from "../../utils/contentEditor.utils";
import type { ValidationOverlays } from "../../utils/contentEditor.utils";
import { ReloadButton } from "../ReloadButton";
import { HelpTooltip } from "../HelpTooltip";
import { MarketSelector } from "./MarketSelector";
import { useI18n } from "../../contexts/I18nContext";
import type { ShopLocale, TranslatableItem, ContentType, MarketInfo } from "../../types/content-editor.types";

interface MobileToolbarProps {
  shopLocales: ShopLocale[];
  currentLanguage: string;
  primaryLocale: string;
  selectedItem: TranslatableItem | null;
  contentType: ContentType;
  onLanguageChange: (locale: string) => void;
  /** Markets for the market selector ([] hides it) */
  markets?: MarketInfo[];
  /** Selected market ("" = global) */
  selectedMarketId?: string;
  /** Callback when the market changes */
  onMarketChange?: (marketId: string) => void;
  enabledLanguages?: string[];
  isLoadingData?: boolean;
  validationOverlays?: ValidationOverlays;
  validationVersion?: number;

  /**
   * The item-level actions the desktop bar shows as buttons: the visibility
   * switch, Duplicate, Delete.
   *
   * They are in this menu rather than only on desktop because the switch
   * REPLACED the status field in the form — leaving it out here would make a
   * product's status unreachable on a phone. `statusLabel` arrives ready to
   * read (an ActionList row has no room to explain itself), and a `null`
   * status means the item's state is not known, which renders as a disabled
   * row rather than a guess.
   */
  itemActions?: {
    statusLabel?: string;
    statusChecked?: boolean;
    statusDisabled?: boolean;
    statusHelp?: string;
    onToggleStatus?: () => void;
    onDuplicate?: () => void;
    duplicateLabel?: string;
    onDelete?: () => void;
    deleteLabel?: string;
  };

  // Operation handlers (Save/Discard are handled by the native save bar)
  onTranslateAll: () => void;
  onClearAll: () => void;
  /** Hides Translate All / Clear All — used for locked app-embed technical groups. */
  disableBulkActions?: boolean;


  // Global AI action state (from global store, persists across navigation)
  isTranslatingGlobal?: boolean;

  // Reload button props
  reloadResourceId: string;
  reloadResourceType: ReloadResourceType;
  reloadLocale: string;
  onReloadComplete: () => void;
  revalidator?: { state: "idle" | "loading"; revalidate: () => void };

  t?: {
    primaryLocaleSuffix?: string;
    translateAll?: string;
    translating?: string;
    clearAll?: string;
      reloadItemTooltip?: string;
    allMarketsGlobal?: string;
    marketSelectorLabel?: string;
    marketTooltip?: string;
    marketPrimaryDisabledHint?: string;
    marketDisabledReason?: string;
  };
}

export function MobileToolbar({
  shopLocales,
  currentLanguage,
  primaryLocale,
  selectedItem,
  contentType,
  onLanguageChange,
  markets = [],
  selectedMarketId = "",
  onMarketChange,
  enabledLanguages,
  isLoadingData = false,
  validationOverlays,
  validationVersion,
  onTranslateAll,
  onClearAll,
  itemActions,
  disableBulkActions = false,
  isTranslatingGlobal = false,
  reloadResourceId,
  reloadResourceType,
  reloadLocale,
  onReloadComplete,
  revalidator,
  t = {},
}: MobileToolbarProps) {
  const { t: i18n } = useI18n();
  const tooltipI18n = {
    missingContent: i18n.common.missingContent,
    missingTranslations: i18n.common.missingTranslations,
    fieldLabels: i18n.common.fieldLabels,
  };
  const [popoverActive, setPopoverActive] = useState(false);
  // Single-language shop: no locale row (one dead button), and "Translate All"
  // stays in the menu but greyed out with an explanation.
  const isSingleLocale = shopLocales.length <= 1;
  const singleLocaleHint = isSingleLocale ? i18n.common?.requiresSecondLanguage : undefined;

  const togglePopover = useCallback(() => setPopoverActive((prev) => !prev), []);
  const closePopover = useCallback(() => setPopoverActive(false), []);

  // Global store state for translation (persists across navigation)
  const isTranslating = isTranslatingGlobal;

  const popoverActivator = (
    <Button icon={MenuHorizontalIcon} size="slim" onClick={togglePopover} accessibilityLabel="More actions" />
  );

  return (
    <Card padding="300">
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
        {/* Left: Horizontally scrollable language buttons (hidden when the shop
            has a single language — nothing to switch between) */}
        <div className="mobile-language-scroll">
          {(isSingleLocale ? [] : shopLocales).map((locale) => (
            <MobileLocaleButton
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
              tooltipI18n={tooltipI18n}
            />
          ))}
        </div>

        {/* Right: Reload icon + More Actions Popover. Save/Discard are handled
            by the native Shopify save bar (AppSaveBar in UnifiedContentEditor). */}
        <div style={{ flexShrink: 0, display: "flex", gap: "0.25rem", alignItems: "center" }}>
          <ReloadButton
            resourceId={reloadResourceId}
            resourceType={reloadResourceType}
            locale={reloadLocale}
            tooltip={t.reloadItemTooltip}
            onReloadComplete={onReloadComplete}
            revalidator={revalidator}
          />
          <Popover
            active={popoverActive}
            activator={popoverActivator}
            onClose={closePopover}
            autofocusTarget="first-node"
          >
            <ActionList
              actionRole="menuitem"
              items={[
                ...(disableBulkActions ? [] : [
                {
                  content: isTranslating
                    ? (t.translating || "Translating...")
                    : (t.translateAll || "Translate All"),
                  onAction: () => {
                    onTranslateAll();
                    closePopover();
                  },
                  // Greyed out with the reason inline (ActionList can't host a
                  // hover tooltip) when the shop has nothing to translate into.
                  disabled: isTranslating || isSingleLocale,
                  helpText: singleLocaleHint,
                },
                {
                  content: t.clearAll || "Clear All",
                  onAction: () => {
                    onClearAll();
                    closePopover();
                  },
                  destructive: true,
                },
                ]),
                // The item itself: visible or not, copy it, delete it. Same
                // set and same order as the desktop action bar.
                ...(itemActions?.onToggleStatus && itemActions.statusLabel ? [{
                  content: `${itemActions.statusChecked ? "✓" : ""} ${itemActions.statusLabel}`,
                  onAction: () => {
                    itemActions.onToggleStatus?.();
                    closePopover();
                  },
                  disabled: itemActions.statusDisabled,
                  helpText: itemActions.statusHelp,
                }] : []),
                ...(itemActions?.onDuplicate ? [{
                  content: itemActions.duplicateLabel || "Duplicate",
                  onAction: () => {
                    itemActions.onDuplicate?.();
                    closePopover();
                  },
                }] : []),
                ...(itemActions?.onDelete ? [{
                  content: itemActions.deleteLabel || "Delete",
                  onAction: () => {
                    itemActions.onDelete?.();
                    closePopover();
                  },
                  destructive: true,
                }] : []),
              ]}
            />
          </Popover>
          <HelpTooltip helpKey="mobileToolbarActions" position="below" />
        </div>
      </div>

      {/* Market selector — its own full-width row below the toolbar. Shown for
          foreign locales when the shop has markets, or whenever a disabledReason
          is present (e.g. cookie banner shows it greyed with an explanation).
          MarketSelector itself guards the primary-locale / no-applicable cases. */}
      {onMarketChange && markets.length > 0 && (currentLanguage !== primaryLocale || !!t.marketDisabledReason) && (
        <div style={{ marginTop: "0.5rem" }}>
          <MarketSelector
            markets={markets}
            selectedMarketId={selectedMarketId}
            currentLanguage={currentLanguage}
            primaryLocale={primaryLocale}
            onMarketChange={onMarketChange}
            t={{
              allMarketsGlobal: t.allMarketsGlobal || "All markets (global)",
              selectorLabel: t.marketSelectorLabel || "Market",
              tooltip: t.marketTooltip,
              primaryDisabledHint: t.marketPrimaryDisabledHint,
              disabledReason: t.marketDisabledReason,
            }}
          />
        </div>
      )}
    </Card>
  );
}

/**
 * One locale chip — a component rather than an inline `.map()` body because
 * `useLocaleButtonStyle` is a hook: rendering the list inline made the hook
 * count depend on `shopLocales.length`, so a shop going 1 → 2 locales on a
 * revalidation would throw "Rendered more hooks than during the previous
 * render". Mirrors `LocaleButton` in UnifiedLanguageBar.
 */
function MobileLocaleButton({
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
  tooltipI18n,
}: {
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
  tooltipI18n: {
    missingContent: string;
    missingTranslations: string;
    fieldLabels: Record<string, string>;
  };
}) {
  const buttonStyle = useLocaleButtonStyle(
    locale,
    selectedItem,
    primaryLocale,
    contentType,
    isLoadingData,
    validationOverlays,
    validationVersion,
  );

  const tooltip = getLocaleButtonTooltip(
    locale,
    selectedItem,
    primaryLocale,
    contentType,
    isLoadingData,
    tooltipI18n,
    validationOverlays,
  );

  const isEnabled = !enabledLanguages || enabledLanguages.includes(locale.locale);
  const isPrimary = locale.primary;
  const isCurrentLanguage = currentLanguage === locale.locale;
  const shortLabel = locale.locale.charAt(0).toUpperCase() + locale.locale.slice(1);

  const buttonEl = (
    <div style={{ ...buttonStyle, flexShrink: 0 }}>
      <Button
        variant={isCurrentLanguage ? "primary" : undefined}
        onClick={() => onLanguageChange(locale.locale)}
        size="slim"
        tone={!isEnabled && !isPrimary ? "critical" : undefined}
      >
        {shortLabel}
      </Button>
    </div>
  );

  if (tooltip) {
    return (
      <Tooltip content={tooltip} dismissOnMouseOut preferredPosition="below">
        {buttonEl}
      </Tooltip>
    );
  }

  return buttonEl;
}
