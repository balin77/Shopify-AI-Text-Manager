import { AppSaveBar } from "./AppSaveBar";

interface SaveDiscardButtonsProps {
  hasChanges: boolean;
  onSave: () => void;
  onDiscard: () => void;
  saveText?: string;
  discardText?: string;
  action?: string;
  fetcherState?: string;
  fetcherFormData?: FormData | null;
  isSavingCurrentItem?: boolean;
}

/**
 * Unified Save/Discard control.
 *
 * Renders the native Shopify save bar (`AppSaveBar` / `ui-save-bar`) above the
 * embedded app instead of in-page buttons. This is the "Built for Shopify"
 * compliant approach and replaces the deprecated Polaris ContextualSaveBar.
 * The component keeps its original prop API so existing callers (Settings tabs)
 * work unchanged.
 */
export function SaveDiscardButtons({
  hasChanges,
  onSave,
  onDiscard,
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
    <AppSaveBar
      hasChanges={hasChanges}
      onSave={onSave}
      onDiscard={onDiscard}
      saveText={saveText}
      discardText={discardText}
      loading={isSubmitting}
    />
  );
}
