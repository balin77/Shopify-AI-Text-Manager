import { useId } from "react";
import { useSaveBarVisibility } from "../hooks/useSaveBar";

interface AppSaveBarProps {
  /** Whether there are unsaved changes. Controls visibility of the native bar. */
  hasChanges: boolean;
  /** Called when the merchant clicks the native Save button. */
  onSave: () => void;
  /** Called when the merchant clicks the native Discard button. */
  onDiscard: () => void;
  /** Label for the Save button. */
  saveText?: string;
  /** Label for the Discard button. */
  discardText?: string;
  /** Shows the Save button spinner and disables both buttons while submitting. */
  loading?: boolean;
  /**
   * Optional stable id for the save bar element. Auto-generated when omitted.
   * Provide an explicit id only when you need to call the imperative
   * `useSaveBar(id)` helpers (e.g. `leaveConfirmation`) for the same bar.
   */
  id?: string;
}

/**
 * AppSaveBar — native Shopify save/discard bar.
 *
 * Wraps the App Bridge `ui-save-bar` web component, which renders the native
 * Shopify save bar ABOVE the embedded app (outside the iframe). This is the
 * "Built for Shopify"-compliant replacement for custom in-page save/discard
 * buttons and the deprecated Polaris ContextualSaveBar.
 *
 * The bar is shown automatically while `hasChanges` is true and hidden after a
 * save/discard or on unmount. The buttons MUST be native `<button>` elements
 * (not Polaris `<Button>`) because App Bridge projects them into the Admin and
 * reads their `variant`/`loading` attributes. The `variant="primary"` button is
 * the Save action; the variant-less button is Discard.
 *
 * Docs: https://shopify.dev/docs/api/app-bridge-library/web-components/ui-save-bar
 */
export function AppSaveBar({
  hasChanges,
  onSave,
  onDiscard,
  saveText = "Save",
  discardText = "Discard",
  loading = false,
  id: providedId,
}: AppSaveBarProps) {
  // Sanitize useId() output (colons) so it is a safe DOM id / saveBar key.
  const generatedId = `app-save-bar-${useId().replace(/:/g, "")}`;
  const id = providedId ?? generatedId;

  useSaveBarVisibility(id, hasChanges);

  // App Bridge reads `variant`/`loading` attributes off these buttons; they are
  // not standard HTML button props, so they are spread via an `any` bag.
  const saveProps: Record<string, unknown> = {
    variant: "primary",
    onClick: onSave,
  };
  // While submitting, show the spinner AND disable Save so a second click can't
  // fire a duplicate submit.
  if (loading) {
    saveProps.loading = "";
    saveProps.disabled = true;
  }

  const discardProps: Record<string, unknown> = {
    onClick: onDiscard,
  };
  if (loading) discardProps.disabled = true;

  return (
    <ui-save-bar id={id}>
      <button {...(saveProps as any)}>{saveText}</button>
      <button {...(discardProps as any)}>{discardText}</button>
    </ui-save-bar>
  );
}
