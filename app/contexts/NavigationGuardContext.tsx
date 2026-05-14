import { createContext, useContext, useRef, useCallback, type ReactNode } from "react";

interface NavigationGuardContextType {
  registerGuard: (guard: () => boolean) => void;
  unregisterGuard: () => void;
  checkGuard: () => boolean;
}

const NavigationGuardContext = createContext<NavigationGuardContextType | null>(null);

export function NavigationGuardProvider({ children }: { children: ReactNode }) {
  const guardRef = useRef<(() => boolean) | null>(null);

  const registerGuard = useCallback((guard: () => boolean) => {
    guardRef.current = guard;
  }, []);

  const unregisterGuard = useCallback(() => {
    guardRef.current = null;
  }, []);

  const checkGuard = useCallback(() => {
    if (guardRef.current) {
      return guardRef.current();
    }
    return true;
  }, []);

  return (
    <NavigationGuardContext.Provider value={{ registerGuard, unregisterGuard, checkGuard }}>
      {children}
    </NavigationGuardContext.Provider>
  );
}

export function useNavigationGuard() {
  const ctx = useContext(NavigationGuardContext);
  if (!ctx) throw new Error("useNavigationGuard must be used within NavigationGuardProvider");
  return ctx;
}
