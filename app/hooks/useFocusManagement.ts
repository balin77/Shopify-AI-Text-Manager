/**
 * Focus Management Hook
 *
 * Provides utilities for managing keyboard focus for accessibility.
 * Following WCAG 2.1 guidelines for focus management.
 */

import { useEffect, useRef, useCallback } from "react";

interface UseFocusManagementOptions {
  /** Auto-focus when component mounts */
  autoFocus?: boolean;
  /** Return focus to previous element on unmount */
  returnFocus?: boolean;
  /** Focus trap (for modals/dialogs) */
  trapFocus?: boolean;
}

/**
 * Hook for managing focus on a specific element
 *
 * @example
 * ```tsx
 * const { focusRef, setFocus } = useFocusManagement({ autoFocus: true });
 *
 * return <input ref={focusRef} />;
 * ```
 */
export function useFocusManagement<T extends HTMLElement = HTMLElement>(
  options: UseFocusManagementOptions = {}
) {
  const { autoFocus = false, returnFocus = false } = options;
  const elementRef = useRef<T>(null);
  const previousActiveElement = useRef<HTMLElement | null>(null);

  // Store the currently focused element when component mounts
  useEffect(() => {
    if (returnFocus) {
      previousActiveElement.current = document.activeElement as HTMLElement;
    }
  }, [returnFocus]);

  // Auto-focus on mount
  useEffect(() => {
    if (autoFocus && elementRef.current) {
      // Small delay to ensure DOM is ready
      const timer = setTimeout(() => {
        elementRef.current?.focus();
      }, 100);

      return () => clearTimeout(timer);
    }
  }, [autoFocus]);

  // Return focus on unmount
  useEffect(() => {
    return () => {
      if (returnFocus && previousActiveElement.current) {
        previousActiveElement.current.focus();
      }
    };
  }, [returnFocus]);

  // Manual focus setter
  const setFocus = useCallback(() => {
    elementRef.current?.focus();
  }, []);

  return {
    focusRef: elementRef,
    setFocus,
  };
}

/**
 * Hook for focus trap (useful for modals and dialogs)
 *
 * @example
 * ```tsx
 * const trapRef = useFocusTrap<HTMLDivElement>(isModalOpen);
 *
 * return (
 *   <div ref={trapRef}>
 *     <button>First</button>
 *     <button>Last</button>
 *   </div>
 * );
 * ```
 */
export function useFocusTrap<T extends HTMLElement = HTMLElement>(active: boolean = true) {
  const containerRef = useRef<T>(null);

  useEffect(() => {
    if (!active || !containerRef.current) return;

    const container = containerRef.current;

    // Get all focusable elements
    const getFocusableElements = () => {
      return container.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;

      const focusableElements = getFocusableElements();
      if (focusableElements.length === 0) return;

      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];

      // Shift + Tab (backwards)
      if (e.shiftKey) {
        if (document.activeElement === firstElement) {
          e.preventDefault();
          lastElement.focus();
        }
      } else {
        // Tab (forwards)
        if (document.activeElement === lastElement) {
          e.preventDefault();
          firstElement.focus();
        }
      }
    };

    // Focus first element when trap activates
    const focusableElements = getFocusableElements();
    if (focusableElements.length > 0) {
      focusableElements[0].focus();
    }

    container.addEventListener("keydown", handleKeyDown);

    return () => {
      container.removeEventListener("keydown", handleKeyDown);
    };
  }, [active]);

  return containerRef;
}

/**
 * Hook to restore scroll position after focus change
 * Useful when focus changes cause unwanted scrolling
 */
export function useScrollPreservation() {
  const scrollPositionRef = useRef({ x: 0, y: 0 });

  const saveScrollPosition = useCallback(() => {
    scrollPositionRef.current = {
      x: window.scrollX,
      y: window.scrollY,
    };
  }, []);

  const restoreScrollPosition = useCallback(() => {
    window.scrollTo(scrollPositionRef.current.x, scrollPositionRef.current.y);
  }, []);

  return {
    saveScrollPosition,
    restoreScrollPosition,
  };
}

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

/**
 * Hook for keyboard shortcuts
 *
 * @example
 * ```tsx
 * useKeyboardShortcut("s", handleSave, { ctrlKey: true });
 * ```
 */
export function useKeyboardShortcut(
  key: string,
  callback: () => void,
  options: {
    ctrlKey?: boolean;
    shiftKey?: boolean;
    altKey?: boolean;
    metaKey?: boolean;
    preventDefault?: boolean;
  } = {}
) {
  const { ctrlKey = false, shiftKey = false, altKey = false, metaKey = false, preventDefault = true } = options;

  // Store callback in a ref to avoid re-registering the listener on every render
  const callbackRef = useRef(callback);
  useEffect(() => {
    callbackRef.current = callback;
  });

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const keyMatch = e.key.toLowerCase() === key.toLowerCase();
      const modifiersMatch =
        e.ctrlKey === ctrlKey &&
        e.shiftKey === shiftKey &&
        e.altKey === altKey &&
        e.metaKey === metaKey;

      if (keyMatch && modifiersMatch) {
        if (preventDefault) {
          e.preventDefault();
        }
        callbackRef.current();
      }
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [key, ctrlKey, shiftKey, altKey, metaKey, preventDefault]);
}

/**
 * Hook to announce content changes to screen readers
 * Uses aria-live regions
 *
 * @example
 * ```tsx
 * const { announce } = useScreenReaderAnnouncement();
 *
 * const handleSave = () => {
 *   // ... save logic
 *   announce("Changes saved successfully");
 * };
 * ```
 */
export function useScreenReaderAnnouncement() {
  const announcementRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // Create announcement region if it doesn't exist
    if (!announcementRef.current) {
      const div = document.createElement("div");
      div.setAttribute("role", "status");
      div.setAttribute("aria-live", "polite");
      div.setAttribute("aria-atomic", "true");
      div.style.position = "absolute";
      div.style.left = "-10000px";
      div.style.width = "1px";
      div.style.height = "1px";
      div.style.overflow = "hidden";
      document.body.appendChild(div);
      announcementRef.current = div;
    }

    return () => {
      if (announcementRef.current) {
        document.body.removeChild(announcementRef.current);
      }
    };
  }, []);

  const announce = useCallback((message: string) => {
    if (announcementRef.current) {
      // Clear first to ensure screen reader picks up the change
      announcementRef.current.textContent = "";
      // Set message after a brief delay
      setTimeout(() => {
        if (announcementRef.current) {
          announcementRef.current.textContent = message;
        }
      }, 100);
    }
  }, []);

  return { announce };
}
