import { useRef, useEffect } from "react";
import { Button } from "@shopify/polaris";

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
 * Used across all content editing pages (Collections, Blog, Pages, Policies, Templates, Products)
 *
 * Features:
 * - Discard button always visible but disabled when no changes
 * - Save button always visible but disabled when no changes
 * - Pulse animation on save button when highlightSaveButton is true
 * - Loading state on save button during submission
 * - Primary variant on save button when changes exist
 * - Consistent flex layout matching UnifiedLanguageBar styling
 * - Responsive wrapping with proper gap spacing on mobile
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

  // DEBUG: Log fetcher state changes
  useEffect(() => {
    console.log('🔘 [SAVE-BUTTON] State changed:', {
      fetcherState,
      hasFormData: !!fetcherFormData,
      formDataAction: fetcherFormData?.get("action"),
      expectedAction: action,
      isSubmitting,
      hasChanges,
    });
  }, [fetcherState, fetcherFormData, isSubmitting, hasChanges, action]);

  return (
    <div ref={saveButtonRef} style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", flex: 1, minWidth: 0, alignItems: "center" }}>
      <Button
        onClick={onDiscard}
        disabled={!hasChanges || fetcherState !== "idle"}
        size="slim"
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
          size="slim"
        >
          {saveText}
        </Button>
      </div>
    </div>
  );
}
