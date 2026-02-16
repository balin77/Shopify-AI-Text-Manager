import { createContext, useContext, useState, useRef, useCallback, useMemo, ReactNode } from "react";

export type InfoBoxTone = "success" | "info" | "warning" | "critical";

export interface InfoBoxState {
  message: string;
  tone: InfoBoxTone;
  title?: string;
  id: string; // Unique ID to track individual messages
}

export interface InfoBoxHistoryEntry extends InfoBoxState {
  timestamp: Date;
}

interface InfoBoxContextType {
  infoBox: InfoBoxState | null;
  showInfoBox: (message: string, tone?: InfoBoxTone, title?: string) => void;
  hideInfoBox: () => void;
  isGlobalLoading: boolean;
  setGlobalLoading: (loading: boolean, message?: string) => void;
  messageHistory: InfoBoxHistoryEntry[];
  unreadCount: number;
  markAllRead: () => void;
  clearHistory: () => void;
}

const InfoBoxContext = createContext<InfoBoxContextType | undefined>(undefined);

export function InfoBoxProvider({ children }: { children: ReactNode }) {
  const [infoBox, setInfoBox] = useState<InfoBoxState | null>(null);
  const [isGlobalLoading, setIsGlobalLoading] = useState(false);
  const [globalLoadingMessage, setGlobalLoadingMessage] = useState<string | undefined>();
  const [messageHistory, setMessageHistory] = useState<InfoBoxHistoryEntry[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const dismissedMessages = useRef<Set<string>>(new Set());
  const autoHideTimer = useRef<NodeJS.Timeout | null>(null);
  // Ref to access infoBox in hideInfoBox without adding it as a dependency
  const infoBoxRef = useRef(infoBox);
  infoBoxRef.current = infoBox;

  const showInfoBox = useCallback((message: string, tone: InfoBoxTone = "success", title?: string) => {
    // Create unique ID based on message + tone + timestamp
    const id = `${message}-${tone}-${Date.now()}`;

    // Don't show if this exact message was recently dismissed
    const messageKey = `${message}-${tone}`;
    if (dismissedMessages.current.has(messageKey)) {
      console.error('[TRANSLATE-DEBUG] showInfoBox SUPPRESSED by dismissedMessages:', { message: message.slice(0, 50), tone });
      return;
    }
    console.error('[TRANSLATE-DEBUG] showInfoBox CALLED:', { message: message.slice(0, 80), tone, title });

    // Clear any existing auto-hide timer
    if (autoHideTimer.current) {
      clearTimeout(autoHideTimer.current);
    }

    const entry: InfoBoxHistoryEntry = { message, tone, title, id, timestamp: new Date() };
    setInfoBox({ message, tone, title, id });

    // Add to history and increment unread count
    setMessageHistory(prev => [entry, ...prev]);
    setUnreadCount(prev => prev + 1);

    // Auto-hide nach 5 Sekunden bei success oder info
    if (tone === "success" || tone === "info") {
      autoHideTimer.current = setTimeout(() => {
        setInfoBox(null);
        // Clear dismissed messages after hiding
        dismissedMessages.current.clear();
      }, 5000);
    }
  }, []);

  const hideInfoBox = useCallback(() => {
    const currentInfoBox = infoBoxRef.current;
    if (currentInfoBox) {
      // Mark this message as dismissed
      const messageKey = `${currentInfoBox.message}-${currentInfoBox.tone}`;
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
  }, []);

  const setGlobalLoading = useCallback((loading: boolean, message?: string) => {
    setIsGlobalLoading(loading);
    setGlobalLoadingMessage(loading ? message : undefined);
  }, []);

  const markAllRead = useCallback(() => {
    setUnreadCount(0);
  }, []);

  const clearHistory = useCallback(() => {
    setMessageHistory([]);
    setUnreadCount(0);
  }, []);

  const value = useMemo(() => ({
    infoBox,
    showInfoBox,
    hideInfoBox,
    isGlobalLoading,
    setGlobalLoading,
    messageHistory,
    unreadCount,
    markAllRead,
    clearHistory,
  }), [infoBox, showInfoBox, hideInfoBox, isGlobalLoading, setGlobalLoading, messageHistory, unreadCount, markAllRead, clearHistory]);

  return (
    <InfoBoxContext.Provider value={value}>
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
