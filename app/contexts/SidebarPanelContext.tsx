/**
 * SidebarPanelContext — makes the editor's right-hand sidebar (SEO score,
 * keywords, JSON-LD, image manager) reachable on screens too narrow to show it.
 *
 * Below 1100px `content-editor-global.css` hides `.seo-sidebar-container`
 * outright, so everything in it was simply unreachable on phones and narrow
 * tablets. The pieces now cooperate:
 *
 *  - UnifiedContentEditor REGISTERS that a sidebar exists for the current item
 *    (`setAvailable`) and, while `open`, hands the whole content area over to it.
 *  - MainNavigation swaps its plan button for a toggle whenever one is
 *    registered — the plan is still reachable via Settings → Plan.
 *
 * The breakpoint itself stays in CSS: both consumers gate on the same
 * `max-width: 1100px` media query, so nothing here needs a resize listener and
 * no re-render happens on rotation. This context only carries "is there a
 * sidebar" and "is it open".
 */

import { createContext, useContext, useState, useCallback, useEffect, useMemo, type ReactNode } from "react";

/**
 * The width below which the sidebar column is hidden and the panel takes over.
 * MUST match the media queries in content-editor-global.css (the hiding rule),
 * responsive.css (the nav toggle) and UnifiedContentEditor.css (the panel
 * layout). Used here only to DROP the open state when the viewport grows past
 * it — the layout itself stays CSS-driven.
 */
const PANEL_BREAKPOINT = "(max-width: 1100px)";

interface SidebarPanelContextValue {
  /** A sidebar exists for the currently selected item. */
  available: boolean;
  /** The sidebar is showing in place of the content (narrow screens only). */
  open: boolean;
  /** Editors register/unregister their sidebar here. Losing it closes the panel. */
  setAvailable: (available: boolean) => void;
  toggle: () => void;
  close: () => void;
}

const SidebarPanelContext = createContext<SidebarPanelContextValue | undefined>(undefined);

/** No-op fallback so the hook is safe outside the provider (SSR, tests). */
const FALLBACK: SidebarPanelContextValue = {
  available: false,
  open: false,
  setAvailable: () => {},
  toggle: () => {},
  close: () => {},
};

export function SidebarPanelProvider({ children }: { children: ReactNode }) {
  const [available, setAvailableState] = useState(false);
  const [open, setOpen] = useState(false);

  const setAvailable = useCallback((next: boolean) => {
    setAvailableState(next);
    // Navigating away or deselecting the item takes the panel's content with
    // it — leaving `open` set would blank the editor on the next page that
    // happens to have a sidebar.
    if (!next) setOpen(false);
  }, []);

  const toggle = useCallback(() => setOpen((prev) => !prev), []);
  const close = useCallback(() => setOpen(false), []);

  // Wide enough for the real sidebar → drop the panel state. Above the
  // breakpoint neither the nav toggle nor the in-panel back button is visible,
  // so a stale `open` would silently re-enter panel mode on the way back down
  // (tablet rotated portrait → landscape → portrait). A matchMedia listener
  // fires only when the breakpoint is actually crossed, not on every resize
  // pixel, and setting `false` twice bails out of re-rendering.
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const query = window.matchMedia(PANEL_BREAKPOINT);
    const sync = () => { if (!query.matches) setOpen(false); };
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  const value = useMemo(
    () => ({ available, open, setAvailable, toggle, close }),
    [available, open, setAvailable, toggle, close],
  );

  return <SidebarPanelContext.Provider value={value}>{children}</SidebarPanelContext.Provider>;
}

export function useSidebarPanel(): SidebarPanelContextValue {
  return useContext(SidebarPanelContext) ?? FALLBACK;
}
