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
 *  - A tab close or reload is the one thing JavaScript cannot outlive: while
 *    anything is out or waiting, `beforeunload` asks the BROWSER to confirm. That
 *    is all that is claimed. Whether leaving through the Shopify admin's own
 *    navigation (which removes the app's iframe) fires it is NOT verified, and
 *    App Bridge's `saveBar.leaveConfirmation()` only covers programmatic
 *    navigation with a visible save bar (shopify.dev/docs/api/app-home/apis/save-bar
 *    says nothing about admin navigation): a live test item for the owner.
 *  - A request that never answers is cut off after SAVE_TIMEOUT_MS and reported
 *    as NOT CONFIRMED (never as failed, and never as saved): the write may or
 *    may not have landed. The SERVER serialises one product's primary saves
 *    (keyed-serial-lock.server.ts), so a cut-off request that is still being
 *    worked on cannot be overtaken by the next one.
 *  - An unknown outcome is always `notConfirmed` with a reason code: a dropped
 *    connection, an abort while the answer body was still arriving, a gateway
 *    status (502/503/504/408/524) WITH ANY BODY unless the body carries the app's
 *    own `actionType`, a body that is not an object with a boolean `success`, or
 *    HTML from a proxy. Only an answer that proves the request was refused before
 *    it ran is a plain failure: an expired / re-authorise session (app-fetch.ts
 *    throws before the request is sent or answers with the library's 401), or a
 *    non-JSON 4xx.
 *
 * Client-only in practice, but safe to import on the server (no top-level
 * browser access).
 */

import { appFetch } from "../../utils/app-fetch";
import { CONTENT_EDITOR_ACTION_ENDPOINT, setContentEditorPage } from "./content-action-endpoint.shared";

/**
 * How long one save may take before it is reported as not confirmed. A product
 * save is several sequential Shopify calls (options, values, a variant matrix
 * rebuild, metafields in batches of 25, a purge of stale translations) with their
 * own retries and no overall time budget, so it can honestly take minutes; the
 * cut-off is the last resort against a request that never answers, not a
 * performance bound. The server lock's wait (5 min) is longer on purpose.
 */
export const SAVE_TIMEOUT_MS = 240_000;

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
  /**
   * The owner's view generation at press time. A reset of the view (switching
   * product / language / market and coming back) bumps it, so an answer can tell
   * "the view I was pressed for, as I left it" from "the same key, re-read since".
   * Generations are unique across hook instances.
   */
  epoch: number;
  formData: FormData;
  owner: SaveOwner;
  /**
   * The text for an answer that finds no mounted owner or lands elsewhere.
   * `reloading` says whether a mounted hook is re-reading the product (true) or
   * nobody is (false: the merchant has to open it again).
   */
  describe: (
    data: SaveAnswer | null,
    options?: { reloading?: boolean },
  ) => { text: string; tone: "success" | "info" | "warning" | "critical" };
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

/** The reasons an outcome is UNKNOWN (the write may or may not have landed). */
export type NotConfirmedReason = "timeout" | "connectionLost" | "badGateway" | "badResponse";

const notConfirmed = (reason: NotConfirmedReason): SaveAnswer => ({
  success: false,
  error: SAVE_NOT_CONFIRMED_CODE,
  notConfirmed: true,
  notConfirmedReason: reason,
});

/**
 * One save request. Never throws.
 *
 *  - an answer with a JSON body is that body (a 4xx/5xx body that forgot
 *    `success: false` is still a failure);
 *  - an expired session carries its code, so the merchant is told to reload;
 *  - everything where the request MAY have reached the handler and the outcome
 *    is unknown is NOT CONFIRMED with a reason: the cut-off, a connection that
 *    dropped (a fetch that rejects after it was sent looks the same as one that
 *    never left), an abort or stream error while the body was still arriving, a
 *    gateway answer (502/503/504/408/524) and any non-JSON 2xx/5xx body (a proxy
 *    page);
 *  - a non-JSON 4xx is a plain failure (a proxy refused it before the app ran).
 */
export async function postSave(
  fd: FormData,
  timeoutMs: number = SAVE_TIMEOUT_MS,
): Promise<SaveAnswer | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let timedOut = false;
  controller.signal.addEventListener("abort", () => {
    timedOut = true;
  });
  try {
    const resp = await appFetch(CONTENT_EDITOR_ACTION_ENDPOINT, {
      method: "POST",
      body: setContentEditorPage(fd, "/app/products"),
      signal: controller.signal,
    });
    const status = typeof resp.status === "number" ? resp.status : 0;
    const gateway = status === 502 || status === 503 || status === 504 || status === 408 || status === 524;
    let body: SaveAnswer | null;
    try {
      body = (await resp.json()) as SaveAnswer | null;
    } catch (error) {
      // Aborted / reset while the answer was arriving, or not JSON at all.
      if (timedOut || (error as { name?: string } | null)?.name === "AbortError") return notConfirmed(timedOut ? "timeout" : "connectionLost");
      if (gateway) return notConfirmed("badGateway");
      // A non-JSON 4xx: refused by something in front of the app. The status
      // travels so the merchant is told WHY (413 too large, 429 rate limited...).
      if (status >= 400 && status < 500) return { success: false, httpStatus: status };
      return notConfirmed(error instanceof SyntaxError ? "badResponse" : "connectionLost");
    }
    const isObject = !!body && typeof body === "object" && !Array.isArray(body);
    // A gateway status is an UNKNOWN outcome whatever the body says, unless the
    // body is the app's own answer (it carries the action it answers for): an
    // edge / proxy JSON like {status:"error",code:502} says nothing about the
    // write.
    if (gateway && !(isObject && typeof (body as SaveAnswer).actionType === "string")) return notConfirmed("badGateway");
    if (!isObject) return notConfirmed("badResponse");
    const answer = body as SaveAnswer;
    if (typeof answer.success !== "boolean") {
      // No verdict in it. Refused (4xx/5xx) without one is a failure; a 2xx
      // without one is NOT a clean save.
      if (resp.ok === false) return { ...answer, success: false, httpStatus: status };
      return notConfirmed("badResponse");
    }
    return answer;
  } catch (error) {
    const name = (error as { name?: string } | null)?.name;
    if (name === "AbortError" || timedOut) return notConfirmed("timeout");
    const message = (error as { message?: string } | null)?.message;
    const code = (error as { code?: string } | null)?.code;
    // SessionExpiredError's message IS the code `translateErrorMessage` renders;
    // ReauthorizeRequiredError carries it as `.code`. Both are answered BEFORE
    // any route code ran, so this is a plain failure.
    for (const candidate of [message, code]) {
      if (typeof candidate === "string" && /^sessionExpired$|^reauthorizeRequired$/.test(candidate)) {
        return { success: false, error: candidate };
      }
    }
    return notConfirmed("connectionLost");
  } finally {
    clearTimeout(timer);
  }
}

/** Tell the merchant about an answer nobody mounted can read. */
function announceDetached(entry: QueuedSave, data: SaveAnswer | null) {
  const { text, tone } = entry.describe(data, { reloading: false });
  try {
    // App Bridge toast: lives in the Shopify admin shell, not in our page. Its
    // default lasts 5 s; a message that says text must be entered again, or that
    // an outcome is unknown, has to stay readable.
    (globalThis as any).shopify?.toast?.show?.(text, {
      isError: tone === "critical" || tone === "warning",
      duration: tone === "success" || tone === "info" ? 5000 : 15000,
    });
  } catch {
    /* no shell, nothing to say it to */
  }
}

// A hook that mounted AFTER the save was pressed (the merchant went to Settings
// and came back before the answer): its predecessor is gone, but the product may
// be on screen again. It is told, so it can reload, lock and track the tasks.
const observers = new Set<(entry: QueuedSave, data: SaveAnswer | null) => void>();
export function observeFinishedSaves(fn: (entry: QueuedSave, data: SaveAnswer | null) => void): () => void {
  observers.add(fn);
  return () => {
    observers.delete(fn);
  };
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
  observers.clear();
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
      if (entry.owner.mounted) {
        entry.owner.handle(entry, data);
      } else {
        // The newest mounted hook reads it (it knows whether the product is on
        // screen); with none mounted the merchant gets a toast.
        const observer = [...observers].pop();
        if (observer) observer(entry, data);
        else announceDetached(entry, data);
      }
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
