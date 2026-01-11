import { createContext, useContext, useState, useEffect, ReactNode } from "react";

interface DevModeContextType {
  isDevMode: boolean;
  toggleDevMode: () => void;
}

const DevModeContext = createContext<DevModeContextType | undefined>(undefined);

export function DevModeProvider({ children }: { children: ReactNode }) {
  const [isDevMode, setIsDevMode] = useState(false);

  // Load dev mode state from localStorage on mount
  useEffect(() => {
    const savedDevMode = localStorage.getItem("devMode");
    if (savedDevMode === "true") {
      setIsDevMode(true);
    }
  }, []);

  const toggleDevMode = () => {
    setIsDevMode((prev) => {
      const newValue = !prev;
      localStorage.setItem("devMode", String(newValue));
      return newValue;
    });
  };

  return (
    <DevModeContext.Provider value={{ isDevMode, toggleDevMode }}>
      {children}
    </DevModeContext.Provider>
  );
}

export function useDevMode() {
  const context = useContext(DevModeContext);
  if (context === undefined) {
    throw new Error("useDevMode must be used within a DevModeProvider");
  }
  return context;
}
