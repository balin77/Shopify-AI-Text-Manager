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
import { Card, Button, Popover, ActionList } from "@shopify/polaris";
import { MenuHorizontalIcon } from "@shopify/polaris-icons";
import { useLocaleButtonStyle } from "../../utils/contentEditor.utils";
import { ReloadButton } from "../ReloadButton";
import type { ShopLocale, TranslatableItem, ContentType } from "../../types/contentEditor.types";

interface MobileToolbarProps {
  shopLocales: ShopLocale[];
  currentLanguage: string;
  primaryLocale: string;
  selectedItem: TranslatableItem | null;
  contentType: ContentType;
  hasChanges: boolean;
  onLanguageChange: (locale: string) => void;
  enabledLanguages?: string[];
  isLoadingData?: boolean;

  // Operation handlers
  onTranslateAll: () => void;
  onClearAll: () => void;
  onSave: () => void;
  onDiscard: () => void;

  // Fetcher state for loading indicators
  fetcherState: string;
  fetcherFormData: FormData | undefined;

  // Save button highlight
  highlightSaveButton?: boolean;

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
    save?: string;
    discardChanges?: string;
  };
}

export function MobileToolbar({
  shopLocales,
  currentLanguage,
  primaryLocale,
  selectedItem,
  contentType,
  hasChanges,
  onLanguageChange,
  enabledLanguages,
  isLoadingData = false,
  onTranslateAll,
  onClearAll,
  onSave,
  onDiscard,
  fetcherState,
  fetcherFormData,
  highlightSaveButton = false,
  reloadResourceId,
  reloadResourceType,
  reloadLocale,
  onReloadComplete,
  revalidator,
  t = {},
}: MobileToolbarProps) {
  const [popoverActive, setPopoverActive] = useState(false);

  const togglePopover = useCallback(() => setPopoverActive((prev) => !prev), []);
  const closePopover = useCallback(() => setPopoverActive(false), []);

  const currentAction = fetcherFormData?.get("action");
  const isTranslating =
    fetcherState !== "idle" &&
    (currentAction === "translateAll" || currentAction === "translateAllForLocale");
  const isSaving = fetcherState !== "idle" && currentAction === "updateContent";

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
              isLoadingData
            );

            const isEnabled = !enabledLanguages || enabledLanguages.includes(locale.locale);
            const isPrimary = locale.primary;
            const isCurrentLanguage = currentLanguage === locale.locale;
            const shortLabel = locale.locale.charAt(0).toUpperCase() + locale.locale.slice(1);

            return (
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
          })}
        </div>

        {/* Right: Save + Reload icon + More Actions Popover */}
        <div style={{ flexShrink: 0, display: "flex", gap: "0.25rem", alignItems: "center" }}>
          <div
            style={{
              animation: highlightSaveButton ? "pulse 1.5s ease-in-out infinite" : "none",
              borderRadius: "8px",
            }}
          >
            <Button
              variant={hasChanges ? "primary" : undefined}
              onClick={onSave}
              disabled={!hasChanges}
              loading={isSaving}
              size="slim"
            >
              {t.save || "Save"}
            </Button>
          </div>
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
                {
                  content: t.discardChanges || "Discard Changes",
                  onAction: () => {
                    onDiscard();
                    closePopover();
                  },
                  disabled: !hasChanges || fetcherState !== "idle",
                },
              ]}
            />
          </Popover>
        </div>
      </div>
    </Card>
  );
}
