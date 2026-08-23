import { createContext, useContext, useState, useRef, useCallback, useMemo, ReactNode } from "react";

export type InfoBoxTone = "success" | "info" | "warning" | "critical";

/** Optional in-app link rendered after the message (e.g. deep-link to a settings tab). */
export interface InfoBoxLink {
  url: string;
  label: string;
}

/**
 * A message is a TONE and a SENTENCE — there is deliberately no `title`.
 * The box is a ~600px inline strip in the navigation bar, not a card with
 * room for a heading, and no renderer ever read the title this state used to
 * carry: the banner renders `message` and the history list `message`. Of the
 * call sites that passed one, nearly all passed a generic word ("Error",
 * "Success", "Validation Error") that the tone colour already says. Dropping
 * the parameter makes that duplication structurally impossible instead of a
 * rule someone has to remember — anything the merchant must read belongs in
 * `message`.
 */
export interface InfoBoxState {
  message: string;
  tone: InfoBoxTone;
  link?: InfoBoxLink;
  id: string; // Unique ID to track individual messages
  /**
   * Optional stable identifier used to dismiss the message programmatically
   * when the underlying condition is resolved (e.g. a "corrupted API key"
   * warning is removed once the merchant re-enters a key for that provider).
   * Multiple messages can share a key prefix — `dismissByKey` matches by
   * full string OR `startsWith(prefix + ":")`.
   */
  dedupeKey?: string;
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
  showInfoBox: (message: string, tone?: InfoBoxTone, link?: InfoBoxLink, dedupeKey?: string) => void;
  hideInfoBox: () => void;
  /**
   * Remove any message (active toast + history) whose `dedupeKey` equals
   * `keyOrPrefix` exactly OR starts with `keyOrPrefix + ":"`. Used to clear
   * a warning once its cause is resolved (e.g. user re-enters an API key
   * that was previously corrupted).
   */
  dismissByKey: (keyOrPrefix: string) => void;
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
  const messageQueue = useRef<Array<{ message: string; tone: InfoBoxTone; link?: InfoBoxLink; dedupeKey?: string }>>([]);

  // Ref-based functions so setTimeout always calls the latest version
  const displayToastRef = useRef<(msg: { message: string; tone: InfoBoxTone; link?: InfoBoxLink; dedupeKey?: string }) => void>(undefined);
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
    setInfoBox({ message: msg.message, tone: msg.tone, link: msg.link, id, dedupeKey: msg.dedupeKey });

    if (autoHideTimer.current) clearTimeout(autoHideTimer.current);

    // Auto-hide nach 5 Sekunden bei success oder info, then process queue
    if (msg.tone === "success" || msg.tone === "info") {
      autoHideTimer.current = setTimeout(() => {
        processQueueRef.current?.();
      }, 5000);
    }
  };

  const showInfoBox = useCallback((message: string, tone: InfoBoxTone = "success", link?: InfoBoxLink, dedupeKey?: string) => {
    // Don't show if this exact message was recently dismissed
    const messageKey = `${message}-${tone}`;
    if (dismissedMessages.current.has(messageKey)) {
      return;
    }

    const id = `${message}-${tone}-${Date.now()}`;
    const entry: InfoBoxHistoryEntry = { message, tone, link, id, timestamp: new Date(), dedupeKey };

    // Always add to history and increment unread count
    setMessageHistory(prev => [entry, ...prev]);
    setUnreadCount(prev => prev + 1);

    // If a toast is currently showing, queue this one instead of replacing it
    if (infoBoxRef.current) {
      messageQueue.current.push({ message, tone, link, dedupeKey });
      return;
    }

    // No current toast — show immediately
    displayToastRef.current?.({ message, tone, link, dedupeKey });
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

  const dismissByKey = useCallback((keyOrPrefix: string) => {
    const matches = (k: string | undefined) =>
      !!k && (k === keyOrPrefix || k.startsWith(`${keyOrPrefix}:`));

    // Drop from the queue so it never gets shown after dismissal.
    messageQueue.current = messageQueue.current.filter(m => !matches(m.dedupeKey));

    // Drop the active toast if it matches; show the next queued (or clear).
    if (matches(infoBoxRef.current?.dedupeKey)) {
      if (autoHideTimer.current) {
        clearTimeout(autoHideTimer.current);
        autoHideTimer.current = null;
      }
      processQueueRef.current?.();
    }

    // Drop matching entries from history AND decrement unread by the
    // number of removed entries (clamped at 0 so the badge never goes
    // negative if some entries were already marked read).
    setMessageHistory(prev => {
      const next = prev.filter(e => !matches(e.dedupeKey));
      const removed = prev.length - next.length;
      if (removed > 0) {
        setUnreadCount(u => Math.max(0, u - removed));
      }
      return next;
    });
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
    dismissByKey,
    isGlobalLoading,
    setGlobalLoading,
    messageHistory,
    unreadCount,
    markAllRead,
    clearHistory,
    syncProgress,
    setSyncProgress,
  }), [infoBox, showInfoBox, hideInfoBox, dismissByKey, isGlobalLoading, setGlobalLoading, messageHistory, unreadCount, markAllRead, clearHistory, syncProgress]);

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
