/**
 * UnifiedOperationsBarMobile - Compact dropdown for operations/actions on mobile
 *
 * Features:
 * - Compact dropdown button showing available actions
 * - Expandable list of all operations (Translate, Clear, Save, Discard, Reload)
 * - Different actions based on locale (primary vs foreign)
 */

import { useState } from "react";
import { Card, Button, BlockStack, InlineStack, Text, Icon } from "@shopify/polaris";
import { ChevronDownIcon, ChevronUpIcon } from "@shopify/polaris-icons";
import { ReloadButton } from "../ReloadButton";

interface UnifiedOperationsBarMobileProps {
  /** Whether we're on the primary locale */
  isPrimaryLocale: boolean;

  /** Whether there are unsaved changes */
  hasChanges: boolean;

  /** Fetcher state */
  fetcherState: string;

  /** Fetcher form data */
  fetcherFormData: FormData | undefined;

  /** Resource ID for reload button */
  resourceId: string;

  /** Resource type for reload button */
  resourceType: "product" | "collection" | "page" | "article" | "policy" | "templates";

  /** Current language locale */
  locale: string;

  /** Handlers */
  onTranslateAll: () => void;
  onClearAll: () => void;
  onSave: () => void;
  onDiscard: () => void;
  onReloadComplete: () => void;

  /** Save button highlight state */
  highlightSaveButton?: boolean;

  /** Translation strings */
  t?: {
    actions?: string;
    translateAll?: string;
    translating?: string;
    clearAll?: string;
    saveChanges?: string;
    discard?: string;
  };
}

export function UnifiedOperationsBarMobile({
  isPrimaryLocale,
  hasChanges,
  fetcherState,
  fetcherFormData,
  resourceId,
  resourceType,
  locale,
  onTranslateAll,
  onClearAll,
  onSave,
  onDiscard,
  onReloadComplete,
  highlightSaveButton = false,
  t = {},
}: UnifiedOperationsBarMobileProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  // Check which action is currently running
  const currentAction = fetcherFormData?.get("action");
  const isTranslating =
    fetcherState !== "idle" &&
    (currentAction === "translateAll" || currentAction === "translateAllForLocale");
  const isSaving = fetcherState !== "idle" && currentAction === "updateContent";

  return (
    <div className="operations-dropdown-mobile">
      {/* Collapsed: Show "Actions" button */}
      <Card padding="0">
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          style={{
            width: "100%",
            padding: "0.75rem",
            border: "none",
            background: "transparent",
            cursor: "pointer",
            textAlign: "left",
          }}
        >
          <InlineStack align="space-between" blockAlign="center">
            <Text as="span" variant="bodyMd" fontWeight="semibold">
              {t.actions || "Actions"}
            </Text>
            <Icon source={isExpanded ? ChevronUpIcon : ChevronDownIcon} />
          </InlineStack>
        </button>
      </Card>

      {/* Expanded: Show all actions */}
      {isExpanded && (
        <Card padding="300">
          <BlockStack gap="200">
            {/* Translate All Button */}
            <Button
              onClick={() => {
                onTranslateAll();
                setIsExpanded(false);
              }}
              loading={isTranslating}
              disabled={isTranslating}
              size="slim"
              fullWidth
            >
              {isTranslating
                ? (t.translating || "Translating...")
                : (t.translateAll || "🌍 Translate All")}
            </Button>

            {/* Clear All Button */}
            <Button
              onClick={() => {
                onClearAll();
                setIsExpanded(false);
              }}
              size="slim"
              tone="critical"
              fullWidth
            >
              🗑️ {t.clearAll || "Clear All"}
            </Button>

            {/* Save Button */}
            <Button
              onClick={() => {
                onSave();
                setIsExpanded(false);
              }}
              variant={hasChanges ? "primary" : undefined}
              disabled={!hasChanges || isSaving}
              loading={isSaving}
              size="slim"
              fullWidth
              tone={highlightSaveButton ? "success" : undefined}
            >
              {t.saveChanges || "Save Changes"}
            </Button>

            {/* Discard Button */}
            <Button
              onClick={() => {
                onDiscard();
                setIsExpanded(false);
              }}
              disabled={!hasChanges}
              size="slim"
              fullWidth
            >
              {t.discard || "Discard"}
            </Button>

            {/* Reload Button */}
            <div style={{ marginTop: "0.25rem" }}>
              <ReloadButton
                resourceId={resourceId}
                resourceType={resourceType}
                locale={locale}
                onReloadComplete={onReloadComplete}
              />
            </div>
          </BlockStack>
        </Card>
      )}
    </div>
  );
}
