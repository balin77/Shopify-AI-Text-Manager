/**
 * useSaveBar
 *
 * Thin helpers around the native App Bridge Save Bar API
 * (`window.shopify.saveBar`). The save bar is the native Shopify save/discard
 * bar rendered ABOVE the embedded app (outside the iframe) and is required for
 * "Built for Shopify". It replaces the deprecated Polaris ContextualSaveBar and
 * any custom in-page save/discard buttons.
 *
 * Docs: https://shopify.dev/docs/api/app-bridge-library/apis/save-bar
 */
import { useCallback, useEffect } from "react";

function getSaveBar() {
  if (typeof window === "undefined") return undefined;
  return window.shopify?.saveBar;
}

export function useSaveBar(id: string) {
  const show = useCallback(() => {
    getSaveBar()?.show(id);
  }, [id]);

  const hide = useCallback(() => {
    getSaveBar()?.hide(id);
  }, [id]);

  /**
   * Prompts the merchant to confirm before leaving when there are unsaved
   * changes (re-focuses / shakes the save bar). Resolves immediately when no
   * save bar is visible. Use this to replace custom navigation guards.
   */
  const leaveConfirmation = useCallback(async () => {
    const saveBar = getSaveBar();
    if (!saveBar) return;
    await saveBar.leaveConfirmation(id);
  }, [id]);

  return { show, hide, leaveConfirmation };
}

/**
 * Keeps the native save bar visibility in sync with a `hasChanges` flag and
 * always hides it on unmount so it never leaks across navigation.
 */
export function useSaveBarVisibility(id: string, hasChanges: boolean) {
  useEffect(() => {
    const saveBar = getSaveBar();
    if (!saveBar) return;
    if (hasChanges) {
      saveBar.show(id);
    } else {
      saveBar.hide(id);
    }
  }, [id, hasChanges]);

  // Defensive cleanup: hide the bar if this component unmounts while dirty.
  useEffect(() => {
    return () => {
      getSaveBar()?.hide(id);
    };
  }, [id]);
}
