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

import { createContext, useContext, useState, useCallback, useMemo, type ReactNode } from "react";

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

  const value = useMemo(
    () => ({ available, open, setAvailable, toggle, close }),
    [available, open, setAvailable, toggle, close],
  );

  return <SidebarPanelContext.Provider value={value}>{children}</SidebarPanelContext.Provider>;
}

export function useSidebarPanel(): SidebarPanelContextValue {
  return useContext(SidebarPanelContext) ?? FALLBACK;
}
