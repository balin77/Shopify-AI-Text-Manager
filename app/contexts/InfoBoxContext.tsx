import { createContext, useContext, useState, useRef, useCallback, useMemo, useEffect, ReactNode } from "react";

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
   * Optional stable identifier naming the CONDITION a message reports (e.g. a
   * "corrupted API key" warning for one provider). It is read twice: once by
   * `dismissByKey` to remove the message when the condition is resolved, and
   * once on INSERT to recognise a repeat of a condition already reported.
   * Multiple messages can share a key prefix — `dismissByKey` matches by
   * full string OR `startsWith(prefix + ":")`.
   */
  dedupeKey?: string;
}

export interface InfoBoxHistoryEntry extends InfoBoxState {
  timestamp: Date;
  /**
   * Whether the merchant has seen this row in the bell. The unread COUNT is
   * derived from these flags rather than kept as its own number: a separate
   * counter had to be adjusted on every insert, removal and clear, and
   * `dismissByKey` subtracted the number of removed rows regardless of
   * whether they had been read — so resolving four old warnings zeroed the
   * badge of a genuinely unread fifth message.
   */
  read: boolean;
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

/**
 * The HISTORY is the record, the TOAST is the glance. Every rule in this
 * module follows from that split, and each one was a defect first:
 *
 * - A message ALWAYS reaches the history. The "recently dismissed"
 *   suppression used to sit in front of the history write, so a repeated
 *   failure the merchant had clicked away once was swallowed whole — no
 *   toast, no row, no badge — and read to them as success.
 * - Every tone auto-hides. `warning` and `critical` used to stand forever,
 *   and because a standing toast QUEUES everything behind it, one missing API
 *   key made every later save error invisible for the rest of the session.
 *   Hiding an error loses nothing now: the bell is always on screen and the
 *   row stays in the list.
 * - A `dedupeKey` is read on INSERT, not only on removal. `app.tsx` re-runs
 *   its API-key effect on every loader revalidation — i.e. after every action
 *   anywhere in the app — and each run appended another identical row.
 */
const AUTO_HIDE_MS: Record<InfoBoxTone, number> = {
  success: 5000,
  info: 5000,
  // Long enough to read a failure without blocking the next message forever.
  warning: 15000,
  critical: 15000,
};

/** Newest first; older rows fall off. Nothing pages this list. */
const MAX_HISTORY = 50;

/** A burst that outruns the display must not grow without bound either. */
const MAX_QUEUE = 20;

/** How long a manually dismissed message stays suppressed as a TOAST. */
const DISMISS_SUPPRESSION_MS = 30000;

/** What "the same message on screen" means for the dismiss suppression. */
const toastKey = (m: { message: string; tone: InfoBoxTone }) => `${m.message}-${m.tone}`;

interface QueuedMessage {
  message: string;
  tone: InfoBoxTone;
  link?: InfoBoxLink;
  dedupeKey?: string;
  /** Carried from the history row, so a toast and its row share one id. */
  id: string;
}

/**
 * Whether two progress states say the same thing. `InitialSyncBanner` polls
 * every 4s and hands over a fresh object each time; without this the context
 * value changed on every tick and re-rendered the whole outlet tree —
 * `TaskCountContext` carries the same bail-out for the same reason.
 */
function sameSyncProgress(a: SyncProgressState | null, b: SyncProgressState | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.phase !== b.phase || a.percent !== b.percent || a.error !== b.error) return false;
  if (a.stats === b.stats) return true;
  if (!a.stats || !b.stats) return false;
  const aKeys = Object.keys(a.stats);
  if (aKeys.length !== Object.keys(b.stats).length) return false;
  return aKeys.every((k) => a.stats![k] === b.stats![k]);
}

const InfoBoxContext = createContext<InfoBoxContextType | undefined>(undefined);

export function InfoBoxProvider({ children }: { children: ReactNode }) {
  const [infoBox, setInfoBox] = useState<InfoBoxState | null>(null);
  const [isGlobalLoading, setIsGlobalLoading] = useState(false);
  const [globalLoadingMessage, setGlobalLoadingMessage] = useState<string | undefined>();
  const [messageHistory, setMessageHistory] = useState<InfoBoxHistoryEntry[]>([]);
  const [syncProgress, setSyncProgressState] = useState<SyncProgressState | null>(null);

  /**
   * Keys of messages the merchant clicked away, each with the timer that
   * releases it. A Map rather than a Set so a key can expire on its own: the
   * previous code cleared the WHOLE set from `processQueue`, which runs one
   * statement after `hideInfoBox` has just added to it — the 30-second
   * suppression it documents never survived its own turn, and in the one case
   * where it did survive (a non-empty queue) it suppressed the history row
   * along with the toast.
   */
  const dismissedToasts = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const autoHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * The active toast as the MUTATORS see it, maintained by hand exactly like
   * `historyRef` below. It used to be assigned during render
   * (`infoBoxRef.current = infoBox`), which is one render too late: several
   * `showInfoBox` calls in one tick — the corrupted-key loop in
   * `app.settings.tsx`, the task-completion loop in MainNavigation — all read
   * `null`, all took the "nothing is showing" branch, and each overwrote the
   * previous one's toast and cleared its auto-hide timer. Only the last of
   * them was ever displayed, and the queue this module is built around was
   * dead code for precisely the callers that need it.
   */
  const infoBoxRef = useRef<InfoBoxState | null>(null);

  /** The one place the toast is set, so the ref can never drift from it. */
  const applyToast = (next: InfoBoxState | null) => {
    infoBoxRef.current = next;
    setInfoBox(next);
  };

  /**
   * The history as the mutators see it. All three writers below compute the
   * next list from this ref, assign it, and set state — so two calls in the
   * same tick see each other. Reading `messageHistory` instead would make a
   * second call in the same tick miss the first one's dedupe.
   */
  const historyRef = useRef<InfoBoxHistoryEntry[]>([]);

  /**
   * Monotonic id source. Ids used to be `${message}-${tone}-${Date.now()}`,
   * so two identical messages emitted in one tick — which the task-completion
   * loop in MainNavigation does — collided and produced duplicate React keys.
   */
  const nextId = useRef(0);

  // Queue for messages that arrive while a toast is already showing
  const messageQueue = useRef<QueuedMessage[]>([]);

  // Ref-based functions so setTimeout always calls the latest version
  const displayToastRef = useRef<(msg: QueuedMessage) => void>(undefined);
  const processQueueRef = useRef<() => void>(undefined);

  processQueueRef.current = () => {
    // Skip anything dismissed while it waited. The old loop shifted blind, so
    // clicking × on one of several identical errors showed the next identical
    // one instantly and read as "the close button does nothing".
    while (messageQueue.current.length > 0) {
      const next = messageQueue.current.shift()!;
      if (dismissedToasts.current.has(toastKey(next))) continue;
      displayToastRef.current?.(next);
      return;
    }
    applyToast(null);
  };

  displayToastRef.current = (msg) => {
    applyToast({ message: msg.message, tone: msg.tone, link: msg.link, id: msg.id, dedupeKey: msg.dedupeKey });

    if (autoHideTimer.current) clearTimeout(autoHideTimer.current);
    autoHideTimer.current = setTimeout(() => {
      autoHideTimer.current = null;
      processQueueRef.current?.();
    }, AUTO_HIDE_MS[msg.tone]);
  };

  /** Keep this message off the SCREEN for a while. It stays in the history. */
  const suppressToast = (key: string) => {
    const previous = dismissedToasts.current.get(key);
    if (previous) clearTimeout(previous);
    dismissedToasts.current.set(
      key,
      setTimeout(() => dismissedToasts.current.delete(key), DISMISS_SUPPRESSION_MS),
    );
  };

  /**
   * Put a message ON SCREEN, or behind whatever is already there. The history
   * row is written by the caller first and is never affected by any of this:
   * the suppression below is about not repeating something visually.
   */
  const queueOrShow = (queued: QueuedMessage) => {
    if (dismissedToasts.current.has(toastKey(queued))) return;

    // If a toast is currently showing, queue this one instead of replacing it
    if (infoBoxRef.current) {
      if (messageQueue.current.length < MAX_QUEUE) messageQueue.current.push(queued);
      return;
    }

    // No current toast — show immediately
    displayToastRef.current?.(queued);
  };

  const showInfoBox = useCallback((message: string, tone: InfoBoxTone = "success", link?: InfoBoxLink, dedupeKey?: string) => {
    // A dedupeKey names a CONDITION, not an event: the same missing API key
    // reported again on the next navigation is the row that is already there.
    const previous = dedupeKey
      ? historyRef.current.find((e) => e.dedupeKey === dedupeKey)
      : undefined;

    if (previous) {
      const rewordedLink =
        previous.link?.url !== link?.url || previous.link?.label !== link?.label;
      const unchanged = previous.message === message && previous.tone === tone && !rewordedLink;

      // Identical repeat ⇒ NOTHING happens. Not a new row, not a new array,
      // not a new context value, and above all not a row that goes unread
      // again: `app.tsx` reports this after every action in the app, so a
      // rebuilt row put the badge back to 1 forever on a shop with no API key
      // — and each report re-rendered the whole outlet tree for nothing.
      if (unchanged) return;

      // Reworded ⇒ the CONDITION changed (the merchant switched to a second
      // provider that also has no key), so this is news like any other
      // message: unread again, toasted again. Its POSITION in the list is
      // kept so nothing reshuffles under the merchant, but it takes a NEW
      // id — an id identifies one message EVENT, and reusing it made the
      // live region skip the announcement, since that is exactly how it
      // tells a new message from a re-render.
      const refreshed: InfoBoxHistoryEntry = {
        ...previous,
        message,
        tone,
        link,
        id: `infobox-${++nextId.current}`,
        timestamp: new Date(),
        read: false,
      };
      historyRef.current = historyRef.current.map((e) => (e === previous ? refreshed : e));
      setMessageHistory(historyRef.current);

      const queued: QueuedMessage = { message, tone, link, dedupeKey, id: refreshed.id };
      if (infoBoxRef.current?.dedupeKey === dedupeKey) {
        // The standing toast IS this condition, in its superseded wording.
        // Queueing behind it would leave the strip naming the old provider
        // for the full dwell time and then say the same thing over again.
        displayToastRef.current?.(queued);
      } else {
        queueOrShow(queued);
      }
      return;
    }

    // Built only once the message is known to be a new event, so an
    // identical repeat does not burn an id.
    const entry: InfoBoxHistoryEntry = {
      message,
      tone,
      link,
      dedupeKey,
      id: `infobox-${++nextId.current}`,
      timestamp: new Date(),
      read: false,
    };

    historyRef.current = [entry, ...historyRef.current].slice(0, MAX_HISTORY);
    setMessageHistory(historyRef.current);
    queueOrShow({ message, tone, link, dedupeKey, id: entry.id });
  }, []);

  const hideInfoBox = useCallback(() => {
    const current = infoBoxRef.current;
    if (current) suppressToast(toastKey(current));

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

    const next = historyRef.current.filter(e => !matches(e.dedupeKey));
    // Nothing matched ⇒ no new array, no new context value. `app.tsx` calls
    // this twice per loader revalidation on the healthy path, and each call
    // used to re-render the whole outlet tree for nothing.
    if (next.length === historyRef.current.length) return;
    historyRef.current = next;
    setMessageHistory(next);
  }, []);

  const setGlobalLoading = useCallback((loading: boolean, message?: string) => {
    setIsGlobalLoading(loading);
    setGlobalLoadingMessage(loading ? message : undefined);
  }, []);

  const markAllRead = useCallback(() => {
    if (!historyRef.current.some(e => !e.read)) return;
    historyRef.current = historyRef.current.map(e => (e.read ? e : { ...e, read: true }));
    setMessageHistory(historyRef.current);
  }, []);

  const clearHistory = useCallback(() => {
    historyRef.current = [];
    setMessageHistory(historyRef.current);

    // "Clear all" has to mean all. The queue and the standing toast used to
    // survive it, so messages kept popping up that the list no longer knew
    // about — and the panel read "No messages" directly under a visible one.
    messageQueue.current = [];
    if (autoHideTimer.current) {
      clearTimeout(autoHideTimer.current);
      autoHideTimer.current = null;
    }
    applyToast(null);
  }, []);

  const setSyncProgress = useCallback((p: SyncProgressState | null) => {
    setSyncProgressState(prev => (sameSyncProgress(prev, p) ? prev : p));
  }, []);

  const unreadCount = useMemo(
    () => messageHistory.reduce((n, e) => (e.read ? n : n + 1), 0),
    [messageHistory],
  );

  useEffect(() => {
    const dismissed = dismissedToasts.current;
    return () => {
      if (autoHideTimer.current) clearTimeout(autoHideTimer.current);
      dismissed.forEach((timer) => clearTimeout(timer));
      dismissed.clear();
    };
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
  }), [infoBox, showInfoBox, hideInfoBox, dismissByKey, isGlobalLoading, setGlobalLoading, messageHistory, unreadCount, markAllRead, clearHistory, syncProgress, setSyncProgress]);

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
