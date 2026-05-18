import { createContext, useContext, useState, useRef, useCallback, useMemo, ReactNode } from "react";

export type InfoBoxTone = "success" | "info" | "warning" | "critical";

/** Optional in-app link rendered after the message (e.g. deep-link to a settings tab). */
export interface InfoBoxLink {
  url: string;
  label: string;
}

export interface InfoBoxState {
  message: string;
  tone: InfoBoxTone;
  title?: string;
  link?: InfoBoxLink;
  id: string; // Unique ID to track individual messages
}

export interface InfoBoxHistoryEntry extends InfoBoxState {
  timestamp: Date;
}

export interface SyncProgressState {
  phase: string | null;
  percent: number;
  error: string | null;
  /** Running per-phase counts of what has been synced so far. */
  stats: Record<string, number> | null;
}

interface InfoBoxContextType {
  infoBox: InfoBoxState | null;
  showInfoBox: (message: string, tone?: InfoBoxTone, title?: string, link?: InfoBoxLink) => void;
  hideInfoBox: () => void;
  isGlobalLoading: boolean;
  setGlobalLoading: (loading: boolean, message?: string) => void;
  messageHistory: InfoBoxHistoryEntry[];
  unreadCount: number;
  markAllRead: () => void;
  clearHistory: () => void;
  // Persistent initial-sync progress, rendered in the nav infobox slot
  // (takes precedence over toasts, never auto-hides). null = no sync running.
  syncProgress: SyncProgressState | null;
  setSyncProgress: (p: SyncProgressState | null) => void;
}

const InfoBoxContext = createContext<InfoBoxContextType | undefined>(undefined);

export function InfoBoxProvider({ children }: { children: ReactNode }) {
  const [infoBox, setInfoBox] = useState<InfoBoxState | null>(null);
  const [isGlobalLoading, setIsGlobalLoading] = useState(false);
  const [globalLoadingMessage, setGlobalLoadingMessage] = useState<string | undefined>();
  const [messageHistory, setMessageHistory] = useState<InfoBoxHistoryEntry[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [syncProgress, setSyncProgress] = useState<SyncProgressState | null>(null);
  const dismissedMessages = useRef<Set<string>>(new Set());
  const autoHideTimer = useRef<NodeJS.Timeout | null>(null);
  // Ref to access infoBox in hideInfoBox without adding it as a dependency
  const infoBoxRef = useRef(infoBox);
  infoBoxRef.current = infoBox;

  // Queue for messages that arrive while a toast is already showing
  const messageQueue = useRef<Array<{ message: string; tone: InfoBoxTone; title?: string; link?: InfoBoxLink }>>([]);

  // Ref-based functions so setTimeout always calls the latest version
  const displayToastRef = useRef<(msg: { message: string; tone: InfoBoxTone; title?: string; link?: InfoBoxLink }) => void>(undefined);
  const processQueueRef = useRef<() => void>(undefined);

  processQueueRef.current = () => {
    if (messageQueue.current.length > 0) {
      const next = messageQueue.current.shift()!;
      displayToastRef.current?.(next);
    } else {
      setInfoBox(null);
      dismissedMessages.current.clear();
    }
  };

  displayToastRef.current = (msg) => {
    const id = `${msg.message}-${msg.tone}-${Date.now()}`;
    setInfoBox({ message: msg.message, tone: msg.tone, title: msg.title, link: msg.link, id });

    if (autoHideTimer.current) clearTimeout(autoHideTimer.current);

    // Auto-hide nach 5 Sekunden bei success oder info, then process queue
    if (msg.tone === "success" || msg.tone === "info") {
      autoHideTimer.current = setTimeout(() => {
        processQueueRef.current?.();
      }, 5000);
    }
  };

  const showInfoBox = useCallback((message: string, tone: InfoBoxTone = "success", title?: string, link?: InfoBoxLink) => {
    // Don't show if this exact message was recently dismissed
    const messageKey = `${message}-${tone}`;
    if (dismissedMessages.current.has(messageKey)) {
      return;
    }

    const id = `${message}-${tone}-${Date.now()}`;
    const entry: InfoBoxHistoryEntry = { message, tone, title, link, id, timestamp: new Date() };

    // Always add to history and increment unread count
    setMessageHistory(prev => [entry, ...prev]);
    setUnreadCount(prev => prev + 1);

    // If a toast is currently showing, queue this one instead of replacing it
    if (infoBoxRef.current) {
      messageQueue.current.push({ message, tone, title, link });
      return;
    }

    // No current toast — show immediately
    displayToastRef.current?.({ message, tone, title, link });
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

    // Show next queued message instead of just clearing
    processQueueRef.current?.();
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
    syncProgress,
    setSyncProgress,
  }), [infoBox, showInfoBox, hideInfoBox, isGlobalLoading, setGlobalLoading, messageHistory, unreadCount, markAllRead, clearHistory, syncProgress]);

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
