import { createContext, useContext, useState, ReactNode } from "react";

interface NavigationHeightContextType {
  mainNavHeight: number;
  contentNavHeight: number;
  setMainNavHeight: (height: number) => void;
  setContentNavHeight: (height: number) => void;
  getTotalNavHeight: () => number;
}

const NavigationHeightContext = createContext<NavigationHeightContextType | undefined>(undefined);

export function NavigationHeightProvider({ children }: { children: ReactNode }) {
  const [mainNavHeight, setMainNavHeight] = useState(0);
  const [contentNavHeight, setContentNavHeight] = useState(0);

  const getTotalNavHeight = () => mainNavHeight + contentNavHeight;

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
  if (context === undefined) {
    throw new Error("useNavigationHeight must be used within a NavigationHeightProvider");
  }
  return context;
}
