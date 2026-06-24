import { createContext, useContext, useState, useCallback, useMemo, ReactNode } from "react";

interface NavigationHeightContextType {
  mainNavHeight: number;
  contentNavHeight: number;
  setMainNavHeight: (height: number) => void;
  setContentNavHeight: (height: number) => void;
  getTotalNavHeight: () => number;
}

const NavigationHeightContext = createContext<NavigationHeightContextType | undefined>(undefined);

export function NavigationHeightProvider({ children }: { children: ReactNode }) {
  // Defaults seeded to approximate rendered heights so first-paint positioning
  // of downstream sticky elements (UnifiedItemList, UnifiedContentEditor) is
  // already close to correct before the bars publish their measured sizes.
  const [mainNavHeight, setMainNavHeight] = useState(73);
  const [contentNavHeight, setContentNavHeight] = useState(0);

  const getTotalNavHeight = useCallback(
    () => mainNavHeight + contentNavHeight,
    [mainNavHeight, contentNavHeight]
  );

  const value = useMemo(() => ({
    mainNavHeight,
    contentNavHeight,
    setMainNavHeight,
    setContentNavHeight,
    getTotalNavHeight
  }), [mainNavHeight, contentNavHeight, getTotalNavHeight]);

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
      contentNavHeight: 0,
      setMainNavHeight: () => {},
      setContentNavHeight: () => {},
      getTotalNavHeight: () => 73,
    };
  }

  return context;
}
