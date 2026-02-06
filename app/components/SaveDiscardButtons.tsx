import { useRef } from "react";
import { Button, InlineStack, BlockStack } from "@shopify/polaris";
import "../styles/SaveDiscardButtons.css";

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
  /** Optional: Use vertical layout (default: false) */
  vertical?: boolean;
  /** Optional: Use slim button size (default: false) */
  slim?: boolean;
}

/**
 * Unified Save/Discard buttons component
 * Used across all content editing pages (Collections, Blog, Pages, Policies, Templates, Products)
 *
 * Features:
 * - Discard button always visible but disabled when no changes
 * - Save button always visible but disabled when no changes
 * - Pulse animation on save button when highlightSaveButton is true
 * - Loading state on save button during submission
 * - Primary variant on save button when changes exist
 * - Responsive design with proper wrapping
 * - Uses Polaris InlineStack/BlockStack for proper event handling
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
  vertical = false,
  slim = false,
}: SaveDiscardButtonsProps) {
  const saveButtonRef = useRef<HTMLDivElement>(null);

  // Determine if currently submitting this specific action
  const isSubmitting = fetcherState !== "idle" &&
    fetcherFormData?.get("action") === action;

  const buttons = (
    <>
      <Button
        onClick={onDiscard}
        disabled={!hasChanges || fetcherState !== "idle"}
        size={slim ? "slim" : undefined}
      >
        {discardText}
      </Button>
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
          size={slim ? "slim" : undefined}
        >
          {saveText}
        </Button>
      </div>
    </>
  );

  const className = `save-discard-buttons-container${slim ? " slim-buttons" : ""}`;

  return (
    <div ref={saveButtonRef} className={className}>
      {vertical ? (
        <BlockStack gap="200">
          {buttons}
        </BlockStack>
      ) : (
        <InlineStack gap="200" wrap={true}>
          {buttons}
        </InlineStack>
      )}
    </div>
  );
}
