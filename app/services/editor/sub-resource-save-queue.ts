/**
 * The options & metafields card's SAVES, outside any React component.
 *
 * Switching products while a save runs is wanted, so a second Save (of the next
 * product) can be pressed before the first has answered, and the merchant can
 * leave the page altogether (Bulk, Settings) with saves still out or waiting.
 * Saves therefore live HERE, at module scope:
 *
 *  - ONE chain, in press order. Two saves never run at once (the server writes
 *    one product's options and metafields in several Shopify calls and the
 *    second must see the first), none is dropped, none is sent twice.
 *  - Plain `fetch` through `appFetch` (the session token, the bounce retry and
 *    `SessionExpiredError` are handled there), the same door the card's
 *    translates and copies already use. The first cut kept the saves on the
 *    hook's `useFetcher`: that dies with the component, so a queued save was
 *    silently dropped when the merchant navigated away, and an unmount aborts a
 *    request in flight client-side. A promise chain survives both.
 *  - Each entry carries its OWNER (the hook instance that pressed it). The
 *    answer is handed to the owner only while it is mounted; otherwise it is
 *    announced with a toast and touches no state at all.
 *  - A tab close is the one thing JavaScript cannot outlive: while anything is
 *    out or waiting, `beforeunload` asks the browser to confirm leaving.
 *  - A request that never answers is cut off after SAVE_TIMEOUT_MS and reported
 *    as NOT CONFIRMED (never as failed, and never as saved): the write may or
 *    may not have landed, and the chain moves on instead of waiting forever.
 *
 * Client-only in practice, but safe to import on the server (no top-level
 * browser access).
 */

import { appFetch } from "../../utils/app-fetch";
import { CONTENT_EDITOR_ACTION_ENDPOINT, setContentEditorPage } from "./content-action-endpoint.shared";

/** How long one save may take before it is reported as not confirmed. */
export const SAVE_TIMEOUT_MS = 120_000;

/** The code a timed-out save is answered with (the card words it). */
export const SAVE_NOT_CONFIRMED_CODE = "saveNotConfirmed";

export type SaveAnswer = Record<string, any> & { success?: boolean };

export interface SaveOwner {
  /** The hook instance that pressed the save is still mounted. */
  mounted: boolean;
  /** Read the answer against the owner's CURRENT state. Only called while mounted. */
  handle: (entry: QueuedSave, data: SaveAnswer | null) => void;
}

export interface QueuedSave {
  kind: "primary" | "foreign";
  itemId: string | null;
  /** The product's title, so an answer that lands elsewhere can name it. */
  title: string | null;
  /** primary: product + market; foreign: product + language + market. */
  viewKey: string;
  /** foreign only: the language it writes. */
  locale: string;
  /** What the press carried, to tell edits typed after it from edits it holds. */
  fingerprint: string;
  formData: FormData;
  owner: SaveOwner;
  /** The text for an answer that finds no mounted owner. */
  describe: (data: SaveAnswer | null) => { text: string; tone: "success" | "info" | "warning" | "critical" };
  /** Anything the owner needs to read the answer (what was sent). Opaque here. */
  sent: any;
}

const store: {
  entries: QueuedSave[];
  chain: Promise<void>;
  listeners: Set<() => void>;
} = { entries: [], chain: Promise.resolve(), listeners: new Set() };

const notify = () => {
  for (const listener of [...store.listeners]) listener();
};

/** The saves out or waiting, the one in flight first. */
export function getSaveEntries(): readonly QueuedSave[] {
  return store.entries;
}

export function subscribeSaves(listener: () => void): () => void {
  store.listeners.add(listener);
  return () => {
    store.listeners.delete(listener);
  };
}

// ---- leaving the tab -------------------------------------------------------
const onBeforeUnload = (event: BeforeUnloadEvent) => {
  event.preventDefault();
  // Legacy browsers read the return value.
  event.returnValue = "";
};
let unloadGuardOn = false;
const syncUnloadGuard = () => {
  if (typeof window === "undefined") return;
  const wanted = store.entries.length > 0;
  if (wanted && !unloadGuardOn) {
    window.addEventListener("beforeunload", onBeforeUnload);
    unloadGuardOn = true;
  } else if (!wanted && unloadGuardOn) {
    window.removeEventListener("beforeunload", onBeforeUnload);
    unloadGuardOn = false;
  }
};

/**
 * One save request. Never throws: a network failure, a non-JSON body and an
 * empty body are `null` (a failed request); a session that expired carries its
 * code so the merchant is told to reload; a request that does not answer in
 * time is `notConfirmed`.
 */
export async function postSave(
  fd: FormData,
  timeoutMs: number = SAVE_TIMEOUT_MS,
): Promise<SaveAnswer | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await appFetch(CONTENT_EDITOR_ACTION_ENDPOINT, {
      method: "POST",
      body: setContentEditorPage(fd, "/app/products"),
      signal: controller.signal,
    });
    const data = (await resp.json().catch(() => null)) as SaveAnswer | null;
    if (!data || typeof data !== "object") return null;
    // A 4xx/5xx JSON body that forgot to say `success: false` is still a failure.
    if (resp.ok === false && data.success !== false) return { ...data, success: false };
    return data;
  } catch (error) {
    if ((error as { name?: string } | null)?.name === "AbortError") {
      return { success: false, error: SAVE_NOT_CONFIRMED_CODE, notConfirmed: true };
    }
    const message = (error as { message?: string } | null)?.message;
    const code = (error as { code?: string } | null)?.code;
    // SessionExpiredError's message IS the code `translateErrorMessage` renders;
    // ReauthorizeRequiredError carries it as `.code`.
    for (const candidate of [message, code]) {
      if (typeof candidate === "string" && /^sessionExpired$|^reauthorizeRequired$/.test(candidate)) {
        return { success: false, error: candidate };
      }
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Tell the merchant about an answer nobody mounted can read. */
function announceDetached(entry: QueuedSave, data: SaveAnswer | null) {
  const { text, tone } = entry.describe(data);
  try {
    // App Bridge toast: lives in the Shopify admin shell, not in our page.
    (globalThis as any).shopify?.toast?.show?.(text, { isError: tone === "critical" || tone === "warning" });
  } catch {
    /* no shell, nothing to say it to */
  }
}

/** Test seam: replace the request function. */
let poster: typeof postSave = postSave;
export function __setSavePosterForTests(fn: typeof postSave | null): void {
  poster = fn ?? postSave;
}
export function __resetSaveQueueForTests(): void {
  store.entries = [];
  store.chain = Promise.resolve();
  store.listeners.clear();
  poster = postSave;
  syncUnloadGuard();
}

/**
 * Queue a save behind every earlier one. The returned promise settles when THIS
 * save has been answered and delivered.
 */
export function enqueueSave(entry: QueuedSave): Promise<void> {
  store.entries = [...store.entries, entry];
  syncUnloadGuard();
  notify();
  const run = async () => {
    let data: SaveAnswer | null = null;
    try {
      data = await poster(entry.formData);
    } catch {
      data = null;
    }
    // Out of the list BEFORE the answer is read: `isSaving` and the confirm
    // must already be right when the owner re-renders from it.
    store.entries = store.entries.filter((e) => e !== entry);
    syncUnloadGuard();
    try {
      if (entry.owner.mounted) entry.owner.handle(entry, data);
      else announceDetached(entry, data);
    } catch (error) {
      // An owner that throws must not break the chain or surface as an
      // unhandled rejection of a fire-and-forget save.
      console.error("[SubResourceSaveQueue] handling a save answer failed:", error);
    } finally {
      notify();
    }
  };
  const next = store.chain.then(run, run);
  // The chain itself never rejects (run swallows), so it can always continue.
  store.chain = next.catch(() => undefined);
  return next;
}
