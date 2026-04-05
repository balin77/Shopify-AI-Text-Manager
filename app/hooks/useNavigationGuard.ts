import { useState, useRef } from "react";
import { TIMING } from "~/constants/timing";

function safeScrollToTop(): void {
  try {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (error) {
    // Fallback for browsers that don't support smooth scrolling
    try {
      window.scrollTo(0, 0);
    } catch (e) {
      // Ignore scroll errors
    }
  }
}

function safeScrollIntoView(element: HTMLElement | null): void {
  if (!element) return;

  try {
    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (error) {
    // Fallback for browsers that don't support smooth scrolling
    try {
      element.scrollIntoView();
    } catch (e) {
      // Ignore scroll errors
    }
  }
}

/**
 * Handle navigation attempt with unsaved changes warning
 */
export function useNavigationGuard() {
  const [pendingNavigation, setPendingNavigation] = useState<(() => void) | null>(null);
  const [highlightSaveButton, setHighlightSaveButton] = useState(false);
  const saveButtonRef = useRef<HTMLDivElement>(null);

  const handleNavigationAttempt = (navigationAction: () => void, hasChanges: boolean): void => {
    if (hasChanges) {
      // Prevent navigation
      setPendingNavigation(() => navigationAction);

      // Safely scroll to top
      safeScrollToTop();

      // Highlight and scroll to save button
      setHighlightSaveButton(true);
      safeScrollIntoView(saveButtonRef.current);
      return;
    }

    // Allow navigation
    setHighlightSaveButton(false);
    setPendingNavigation(null);
    navigationAction();
  };

  const clearPendingNavigation = () => {
    setTimeout(() => {
      if (pendingNavigation) {
        pendingNavigation();
      }
      setPendingNavigation(null);
      setHighlightSaveButton(false);
    }, TIMING.NAVIGATION_DELAY_MS);
  };

  return {
    pendingNavigation,
    setPendingNavigation,
    highlightSaveButton,
    setHighlightSaveButton,
    saveButtonRef,
    handleNavigationAttempt,
    clearPendingNavigation,
  };
}
