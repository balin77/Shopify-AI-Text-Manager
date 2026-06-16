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

import { useState, useCallback } from "react";
import { Card, Button, Popover, ActionList, Tooltip } from "@shopify/polaris";
import { MenuHorizontalIcon } from "@shopify/polaris-icons";
import { useLocaleButtonStyle, getLocaleButtonTooltip } from "../../utils/contentEditor.utils";
import type { ValidationOverlays } from "../../utils/contentEditor.utils";
import { ReloadButton } from "../ReloadButton";
import { HelpTooltip } from "../HelpTooltip";
import { useI18n } from "../../contexts/I18nContext";
import type { ShopLocale, TranslatableItem, ContentType, ContentImage } from "../../types/content-editor.types";

interface MobileToolbarProps {
  shopLocales: ShopLocale[];
  currentLanguage: string;
  primaryLocale: string;
  selectedItem: TranslatableItem | null;
  contentType: ContentType;
  onLanguageChange: (locale: string) => void;
  enabledLanguages?: string[];
  isLoadingData?: boolean;
  validationOverlays?: ValidationOverlays;
  validationVersion?: number;

  // Operation handlers (Save/Discard are handled by the native save bar)
  onTranslateAll: () => void;
  onClearAll: () => void;
  onToggleSendImageToAI?: () => void;

  // Send image to AI feature
  sendImageToAI?: boolean;
  images?: ContentImage[];
  featuredImage?: ContentImage;

  // Global AI action state (from global store, persists across navigation)
  isTranslatingGlobal?: boolean;

  // Reload button props
  reloadResourceId: string;
  reloadResourceType: "product" | "collection" | "page" | "article" | "policy" | "templates";
  reloadLocale: string;
  onReloadComplete: () => void;
  revalidator?: { state: "idle" | "loading"; revalidate: () => void };

  t?: {
    primaryLocaleSuffix?: string;
    translateAll?: string;
    translating?: string;
    clearAll?: string;
    sendImageToAI?: string;
  };
}

export function MobileToolbar({
  shopLocales,
  currentLanguage,
  primaryLocale,
  selectedItem,
  contentType,
  onLanguageChange,
  enabledLanguages,
  isLoadingData = false,
  validationOverlays,
  validationVersion,
  onTranslateAll,
  onClearAll,
  onToggleSendImageToAI,
  sendImageToAI = false,
  images = [],
  featuredImage,
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
        {/* Left: Horizontally scrollable language buttons */}
        <div className="mobile-language-scroll">
          {shopLocales.map((locale) => {
            const buttonStyle = useLocaleButtonStyle(
              locale,
              selectedItem,
              primaryLocale,
              contentType,
              isLoadingData,
              validationOverlays,
              validationVersion
            );

            const tooltip = getLocaleButtonTooltip(locale, selectedItem, primaryLocale, contentType, isLoadingData, tooltipI18n, validationOverlays);

            const isEnabled = !enabledLanguages || enabledLanguages.includes(locale.locale);
            const isPrimary = locale.primary;
            const isCurrentLanguage = currentLanguage === locale.locale;
            const shortLabel = locale.locale.charAt(0).toUpperCase() + locale.locale.slice(1);

            const buttonEl = (
              <div key={locale.locale} style={{ ...buttonStyle, flexShrink: 0 }}>
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
                <Tooltip key={locale.locale} content={tooltip} dismissOnMouseOut preferredPosition="below">
                  {buttonEl}
                </Tooltip>
              );
            }

            return buttonEl;
          })}
        </div>

        {/* Right: Reload icon + More Actions Popover. Save/Discard are handled
            by the native Shopify save bar (AppSaveBar in UnifiedContentEditor). */}
        <div style={{ flexShrink: 0, display: "flex", gap: "0.25rem", alignItems: "center" }}>
          <ReloadButton
            resourceId={reloadResourceId}
            resourceType={reloadResourceType}
            locale={reloadLocale}
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
                {
                  content: isTranslating
                    ? (t.translating || "Translating...")
                    : (t.translateAll || "Translate All"),
                  onAction: () => {
                    onTranslateAll();
                    closePopover();
                  },
                  disabled: isTranslating,
                },
                {
                  content: t.clearAll || "Clear All",
                  onAction: () => {
                    onClearAll();
                    closePopover();
                  },
                  destructive: true,
                },
                // Send image to AI checkbox (only in main language for products/collections/blogs with images)
                ...((currentLanguage === primaryLocale &&
                   (contentType === "products" || contentType === "collections" || contentType === "blogs") &&
                   (images.length > 0 || featuredImage?.url) &&
                   onToggleSendImageToAI) ? [{
                  content: `${sendImageToAI ? '✓' : ''} ${t.sendImageToAI || "📷 Send image to AI"}`,
                  onAction: () => {
                    onToggleSendImageToAI();
                    closePopover();
                  },
                }] : []),
              ]}
            />
          </Popover>
          <HelpTooltip helpKey="mobileToolbarActions" position="below" />
        </div>
      </div>
    </Card>
  );
}
