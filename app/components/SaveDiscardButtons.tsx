import { Button } from "@shopify/polaris";

const PULSE_STYLE = `
  @keyframes save-btn-pulse {
    0%, 100% { box-shadow: 0 0 0 0 rgba(255, 149, 0, 0.7); }
    50% { box-shadow: 0 0 12px 6px rgba(255, 149, 0, 0.3); }
  }
`;

interface SaveDiscardButtonsProps {
  hasChanges: boolean;
  onSave: () => void;
  onDiscard: () => void;
  highlightSaveButton?: boolean;
  saveText?: string;
  discardText?: string;
  action?: string;
  fetcherState?: string;
  fetcherFormData?: FormData | null;
  isSavingCurrentItem?: boolean;
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
  highlightSaveButton = false,
  saveText = "Save Changes",
  discardText = "Discard",
  action = "updateContent",
  fetcherState = "idle",
  fetcherFormData = null,
  isSavingCurrentItem,
}: SaveDiscardButtonsProps) {
  // Determine if currently submitting this specific action.
  // Prefer the item-scoped isSavingCurrentItem when available (prevents
  // spinner/disabled state from leaking to a different item after navigation).
  const isSubmitting = isSavingCurrentItem ?? (fetcherState !== "idle" &&
    fetcherFormData?.get("action") === action);

  return (
    <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", flex: 1, minWidth: 0, alignItems: "center" }}>
      {highlightSaveButton && <style>{PULSE_STYLE}</style>}
      <Button
        onClick={onDiscard}
        disabled={!hasChanges || isSubmitting}
        size="slim"
      >
        {discardText}
      </Button>
      <div
        style={{
          animation: highlightSaveButton ? "save-btn-pulse 1.5s ease-in-out infinite" : "none",
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
