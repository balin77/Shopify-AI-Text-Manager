import { createContext, useContext, useState, useCallback, useMemo, ReactNode } from "react";

interface NavigationHeightContextType {
  mainNavHeight: number;
  rubricNavHeight: number;
  contentNavHeight: number;
  setMainNavHeight: (height: number) => void;
  setRubricNavHeight: (height: number) => void;
  setContentNavHeight: (height: number) => void;
  getTotalNavHeight: () => number;
}

const NavigationHeightContext = createContext<NavigationHeightContextType | undefined>(undefined);

export function NavigationHeightProvider({ children }: { children: ReactNode }) {
  // Use reasonable defaults that match approximate SSR heights to prevent hydration errors
  // These will be updated to actual values once components mount on the client
  const [mainNavHeight, setMainNavHeight] = useState(73);
  // Level 2 (rubric) bar — seeded to its approximate rendered height so the
  // Level-3 bar isn't positioned on top of it for one frame before measurement
  // (on non-content pages nothing consumes this value). Re-measured on mount.
  const [rubricNavHeight, setRubricNavHeight] = useState(36);
  const [contentNavHeight, setContentNavHeight] = useState(0);

  const getTotalNavHeight = useCallback(
    () => mainNavHeight + rubricNavHeight + contentNavHeight,
    [mainNavHeight, rubricNavHeight, contentNavHeight]
  );

  const value = useMemo(() => ({
    mainNavHeight,
    rubricNavHeight,
    contentNavHeight,
    setMainNavHeight,
    setRubricNavHeight,
    setContentNavHeight,
    getTotalNavHeight
  }), [mainNavHeight, rubricNavHeight, contentNavHeight, getTotalNavHeight]);

  return (
    <NavigationHeightContext.Provider value={value}>
      {children}
    </NavigationHeightContext.Provider>
  );
}

export function useNavigationHeight() {
  const context = useContext(NavigationHeightContext);

  // Provide safe fallback values if context is not available (e.g., during SSR)
  if (context === undefined) {
    return {
      mainNavHeight: 73,
      rubricNavHeight: 0,
      contentNavHeight: 0,
      setMainNavHeight: () => {},
      setRubricNavHeight: () => {},
      setContentNavHeight: () => {},
      getTotalNavHeight: () => 73,
    };
  }

  return context;
}
