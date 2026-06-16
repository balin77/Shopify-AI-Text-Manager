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

/**
 * Gate programmatic navigation on the native save bar.
 *
 * Resolves immediately when there are no unsaved changes (no save bar visible)
 * or when App Bridge is unavailable (e.g. local dev outside the Admin). When
 * the save bar IS visible, this displays the native "unsaved changes"
 * confirmation dialog and shakes/re-focuses the bar; it resolves only if the
 * merchant confirms leaving. If the merchant cancels (stays), the native promise
 * never resolves — so simply `await` this before navigating and navigation is
 * skipped when the merchant chooses to stay.
 *
 * Latest-intent guard: each call takes a token. If several confirmation promises
 * are outstanding and resolve together (e.g. the merchant clicked multiple
 * targets before confirming), only the most recent call proceeds; older ones are
 * abandoned so we never fire stale/duplicate navigations.
 *
 * This replaces the custom NavigationGuard + highlightSaveButton mechanism.
 * Docs: https://shopify.dev/docs/api/app-bridge-library/apis/save-bar
 */
let navigationToken = 0;

export async function confirmNavigation(): Promise<void> {
  const saveBar = getSaveBar();
  if (!saveBar) return;
  const myToken = ++navigationToken;
  await saveBar.leaveConfirmation();
  // A newer confirmNavigation() was started after this one — abandon this stale
  // resolution (never resolve) so the caller does not navigate to an old target.
  if (myToken !== navigationToken) {
    return new Promise<void>(() => {});
  }
}

export function useSaveBar(id: string) {
  const show = useCallback(() => {
    getSaveBar()?.show(id);
  }, [id]);

  const hide = useCallback(() => {
    getSaveBar()?.hide(id);
  }, [id]);

  return { show, hide, leaveConfirmation: confirmNavigation };
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
