import { useRef } from "react";
import { Button, InlineStack } from "@shopify/polaris";

interface SaveDiscardButtonsProps {
  hasChanges: boolean;
  onSave: () => void;
  onDiscard: () => void;
  isLoading?: boolean;
  highlightSaveButton?: boolean;
  saveText?: string;
  discardText?: string;
  action?: string;
  fetcherState?: string;
  fetcherFormData?: FormData | null;
}

/**
 * Unified Save/Discard buttons component
 * Used across all content editing pages (Collections, Blog, Pages, Policies, Templates)
 *
 * Features:
 * - Discard button only visible when hasChanges is true
 * - Save button always visible but disabled when no changes
 * - Pulse animation on save button when highlightSaveButton is true
 * - Loading state on save button during submission
 * - Primary variant on save button when changes exist
 */
export function SaveDiscardButtons({
  hasChanges,
  onSave,
  onDiscard,
  isLoading = false,
  highlightSaveButton = false,
  saveText = "Save Changes",
  discardText = "Discard",
  action = "updateContent",
  fetcherState = "idle",
  fetcherFormData = null,
}: SaveDiscardButtonsProps) {
  const saveButtonRef = useRef<HTMLDivElement>(null);

  // Determine if currently submitting this specific action
  const isSubmitting = fetcherState !== "idle" &&
    fetcherFormData?.get("action") === action;

  return (
    <div ref={saveButtonRef}>
      <InlineStack gap="200">
        {hasChanges && (
          <Button
            onClick={onDiscard}
            disabled={fetcherState !== "idle"}
          >
            {discardText}
          </Button>
        )}
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
            loading={isSubmitting}
          >
            {saveText}
          </Button>
        </div>
      </InlineStack>
    </div>
  );
}
