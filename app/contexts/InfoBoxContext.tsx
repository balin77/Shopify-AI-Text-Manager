import { createContext, useContext, useState, useRef, useCallback, ReactNode } from "react";

export type InfoBoxTone = "success" | "info" | "warning" | "critical";

export interface InfoBoxState {
  message: string;
  tone: InfoBoxTone;
  title?: string;
  id: string; // Unique ID to track individual messages
}

interface InfoBoxContextType {
  infoBox: InfoBoxState | null;
  showInfoBox: (message: string, tone?: InfoBoxTone, title?: string) => void;
  hideInfoBox: () => void;
}

const InfoBoxContext = createContext<InfoBoxContextType | undefined>(undefined);

export function InfoBoxProvider({ children }: { children: ReactNode }) {
  const [infoBox, setInfoBox] = useState<InfoBoxState | null>(null);
  const dismissedMessages = useRef<Set<string>>(new Set());
  const autoHideTimer = useRef<NodeJS.Timeout | null>(null);

  const showInfoBox = useCallback((message: string, tone: InfoBoxTone = "success", title?: string) => {
    // Create unique ID based on message + tone + timestamp
    const id = `${message}-${tone}-${Date.now()}`;

    // Don't show if this exact message was recently dismissed
    const messageKey = `${message}-${tone}`;
    if (dismissedMessages.current.has(messageKey)) {
      return;
    }

    // Clear any existing auto-hide timer
    if (autoHideTimer.current) {
      clearTimeout(autoHideTimer.current);
    }

    setInfoBox({ message, tone, title, id });

    // Auto-hide nach 10 Sekunden bei success oder info (verlängert für bessere Sichtbarkeit)
    if (tone === "success" || tone === "info") {
      autoHideTimer.current = setTimeout(() => {
        setInfoBox(null);
        // Clear dismissed messages after hiding
        dismissedMessages.current.clear();
      }, 10000);
    }
  }, []);

  const hideInfoBox = useCallback(() => {
    if (infoBox) {
      // Mark this message as dismissed
      const messageKey = `${infoBox.message}-${infoBox.tone}`;
      dismissedMessages.current.add(messageKey);

      // Clear dismissed messages after 30 seconds
      setTimeout(() => {
        dismissedMessages.current.delete(messageKey);
      }, 30000);
    }

    // Clear timer if manually dismissed
    if (autoHideTimer.current) {
      clearTimeout(autoHideTimer.current);
      autoHideTimer.current = null;
    }

    setInfoBox(null);
  }, [infoBox]);

  return (
    <InfoBoxContext.Provider value={{ infoBox, showInfoBox, hideInfoBox }}>
      {children}
    </InfoBoxContext.Provider>
  );
}

export function useInfoBox() {
  const context = useContext(InfoBoxContext);
  if (context === undefined) {
    throw new Error("useInfoBox must be used within an InfoBoxProvider");
  }
  return context;
}
