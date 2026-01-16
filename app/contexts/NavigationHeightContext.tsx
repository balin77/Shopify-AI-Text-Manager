import { createContext, useContext, useState, useCallback, ReactNode } from "react";

interface NavigationHeightContextType {
  mainNavHeight: number;
  contentNavHeight: number;
  setMainNavHeight: (height: number) => void;
  setContentNavHeight: (height: number) => void;
  getTotalNavHeight: () => number;
}

const NavigationHeightContext = createContext<NavigationHeightContextType | undefined>(undefined);

export function NavigationHeightProvider({ children }: { children: ReactNode }) {
  // Use reasonable defaults that match approximate SSR heights to prevent hydration errors
  // These will be updated to actual values once components mount on the client
  const [mainNavHeight, setMainNavHeight] = useState(73);
  const [contentNavHeight, setContentNavHeight] = useState(0);

  const getTotalNavHeight = useCallback(() => mainNavHeight + contentNavHeight, [mainNavHeight, contentNavHeight]);

  return (
    <NavigationHeightContext.Provider
      value={{
        mainNavHeight,
        contentNavHeight,
        setMainNavHeight,
        setContentNavHeight,
        getTotalNavHeight
      }}
    >
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
