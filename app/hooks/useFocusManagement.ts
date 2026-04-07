/**
 * Focus Management Hook
 *
 * Provides utilities for managing keyboard focus for accessibility.
 * Following WCAG 2.1 guidelines for focus management.
 */

import { useRef, useCallback } from "react";

/**
 * Hook to manage focus when navigating between items
 * Useful for list-based interfaces
 *
 * @example
 * ```tsx
 * const { setItemFocus } = useItemFocus(selectedItemId);
 *
 * useEffect(() => {
 *   if (selectedItemId) {
 *     setItemFocus();
 *   }
 * }, [selectedItemId, setItemFocus]);
 * ```
 */
export function useItemFocus(itemId: string | null) {
  const firstFieldRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);

  const setItemFocus = useCallback(() => {
    // Wait for DOM to update
    setTimeout(() => {
      if (firstFieldRef.current) {
        firstFieldRef.current.focus({ preventScroll: false });
      }
    }, 150);
  }, []);

  return {
    firstFieldRef,
    setItemFocus,
  };
}

