/**
 * A request our OWN rate limiter refused is waited out and sent again -- and
 * when that does not work, the router is not handed a thrown error.
 *
 * Why here: React Router, App Bridge and `appFetch` all call the global
 * `fetch`, so ONE wrapper covers router fetcher GETs and POSTs, navigations
 * and plain fetches. Without it a 429 reached the router as
 * `ErrorResponse(429)`, which a fetcher or a navigation hands to the route's
 * ErrorBoundary: the whole page was replaced, unsaved input and all (on a
 * document load the browser showed the raw JSON).
 *
 * What counts as "refused by us": status 429 AND the marker header
 * `X-CP-Rate-Limited` (set by `standardHandler` in rate-limit-cjs.cjs, value =
 * the limiter's bucket name). Any other 429 -- Shopify throttling a handler's
 * call, an app-level plan limit a route passes through -- is a handler's own
 * answer, may have done part of its work, and is returned untouched. A request
 * the limiter refused never reached a handler, so sending it again is safe even
 * for a POST.
 *
 * Retry: at most MAX_RETRIES more sends, after `Retry-After` plus jitter, and
 * only when `Retry-After` is within MAX_WAIT_MS (waiting less than the limiter
 * asked burns another refusal). Everything refused by one bucket shares one
 * "blocked until": a request whose path the wrapper has already seen refused is
 * not sent into the closed window, so N waiting requests of that path do not
 * become N refusals and N log lines (the first send of any other path goes out
 * regardless, and may be refused). An abort (the router's
 * own signal on a product switch or a newer load) ends the wait with the
 * abort error and nothing is sent afterwards.
 *
 * When the retries run out, by kind of request:
 *  - a router POST (`*.data`): a real, decodable single-fetch result with the
 *    status 429 and `{ success: false, error, rateLimited: true }`. The
 *    fetcher gets `data`, nothing is thrown, the router does not revalidate
 *    after a 4xx action. Nothing is thrown at the router; the caller sees an
 *    ordinary failed answer and decides what to show.
 *  - a router GET of an `/api/*` resource route (a fetcher load): the same,
 *    keyed by the route id the request named.
 *  - a router GET of a page (a navigation, a revalidation): there is no data
 *    to invent, so the request is HELD until the router aborts it (the next
 *    click / load). The page on screen stays; the navigation stays pending.
 *  - a plain fetch: the real 429 response, as before (callers see
 *    `response.ok === false`).
 * Each of them also raises a calm notice (see RateLimitNotice).
 *
 * Install once, before hydration (entry.client.tsx). App Bridge's script runs
 * earlier in <head> and patches `fetch`; the wrapper sits OUTSIDE it, so every
 * retry gets a fresh session token from it.
 */
import { encodeTurboStreamValue } from "./turbo-stream-lite";

export const RATE_LIMIT_MARKER_HEADER = "X-CP-Rate-Limited";
export const MAX_RETRIES = 2;
/** Longest `Retry-After` that is waited out; a longer one is not worth a spinner. */
export const MAX_WAIT_MS = 30_000;
export const MIN_WAIT_MS = 1_000;
export const JITTER_MS = 1_500;
const DEFAULT_RETRY_AFTER_MS = 5_000;
const MAX_GATE_WAITS = 5;
/** 25 ms each: a write waits at most a minute for older held writes. */
const MAX_TURN_WAITS = 2400;

export type RateLimitEvent =
  | { type: "waiting"; seconds: number }
  | { type: "gave-up"; retryAfterSeconds: number; /** a write (a POST...) was given up, not a read */ write: boolean };

type Listener = (event: RateLimitEvent) => void;
const listeners = new Set<Listener>();

/** Subscribe to waits and give-ups (the notice component). Returns the unsubscribe. */
export function subscribeRateLimitEvents(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(event: RateLimitEvent) {
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch {
      // A notice failing must never fail the request.
    }
  }
}

let messageProvider: () => string = () => "Too many requests right now. Please try again in a moment.";
/** The merchant-language sentence put into a synthesized answer's `error`. */
export function setRateLimitMessage(provider: () => string) {
  messageProvider = provider;
}

export interface RateLimitFetchOptions {
  /** Injected for tests. */
  random?: () => number;
  now?: () => number;
}

const blockedUntilByBucket = new Map<string, number>();
/** Writes of one bucket that are waiting for its window, by call order. */
const waitingWrites = new Map<string, Set<number>>();
let callSeq = 0;
const bucketByKey = new Map<string, string>();

/** Test seam: forget what earlier requests learned. */
export function resetRateLimitState() {
  blockedUntilByBucket.clear();
  waitingWrites.clear();
  bucketByKey.clear();
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

function sleep(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortReason(signal));
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal as AbortSignal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Pending until the signal aborts (then rejects with its reason). */
function holdUntilAborted(signal: AbortSignal | null | undefined): Promise<never> {
  return new Promise((_, reject) => {
    if (!signal) return;
    if (signal.aborted) return reject(abortReason(signal));
    signal.addEventListener("abort", () => reject(abortReason(signal)), { once: true });
  });
}

function parseRetryAfterMs(header: string | null): number {
  const seconds = header == null ? NaN : Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) return DEFAULT_RETRY_AFTER_MS;
  return Math.max(MIN_WAIT_MS, Math.ceil(seconds) * 1000);
}

function canResend(input: RequestInfo | URL, init: RequestInit | undefined): boolean {
  const body = init?.body;
  if (body != null && typeof ReadableStream !== "undefined" && body instanceof ReadableStream) return false;
  return true;
}

function describeRequest(input: RequestInfo | URL, init: RequestInit | undefined) {
  const isRequest = typeof Request !== "undefined" && input instanceof Request;
  const rawUrl = isRequest ? (input as Request).url : String(input);
  let url: URL | null = null;
  try {
    url = new URL(rawUrl, typeof location !== "undefined" ? location.origin : "http://localhost");
  } catch {
    url = null;
  }
  const method = (init?.method ?? (isRequest ? (input as Request).method : "GET")).toUpperCase();
  const signal = init?.signal ?? (isRequest ? (input as Request).signal : undefined);
  return { url, method, signal, isRequest };
}

function synthesized(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { "X-Remix-Response": "yes", "Content-Type": "text/x-script; charset=utf-8" },
  });
}

/** The answer a router `.data` request gets when the retries ran out, or null where none can be made. */
function singleFetchAnswer(url: URL, method: string, retryAfterSeconds: number): Response | null {
  // `ok: false` for the settings tabs that test it instead of `success`.
  const data = { success: false, ok: false, error: messageProvider(), rateLimited: true, retryAfter: retryAfterSeconds };
  if (method !== "GET" && method !== "HEAD") {
    // A POST: the router decodes `{ data }` as the action's result.
    return synthesized(429, encodeTurboStreamValue({ data }));
  }
  // A GET names the routes it wants; one route of the resource-route namespace
  // is a fetcher load. Pages (navigations, revalidations) are held instead: a
  // loader's data cannot be invented, and wrong-shaped data would crash the page.
  if (!url.pathname.startsWith("/api/")) return null;
  const routes = (url.searchParams.get("_routes") ?? "").split(",").filter(Boolean);
  if (routes.length !== 1) return null;
  return synthesized(429, encodeTurboStreamValue({ [routes[0]]: { data } }));
}

export function createRateLimitFetch(inner: typeof fetch, options: RateLimitFetchOptions = {}): typeof fetch {
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;

  const wrapped = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const { url, method, signal, isRequest } = describeRequest(input, init);
    const key = url ? `${method} ${url.pathname}` : "";
    const isSingleFetch = !!url && url.pathname.endsWith(".data");
    const resendable = canResend(input, init);
    let retries = 0;
    let gateWaits = 0;
    let announced = false;
    const seq = ++callSeq;
    const isWrite = method !== "GET" && method !== "HEAD";
    let registeredBucket: string | undefined;
    // A write the limiter holds back queues behind OLDER writes that are held in
    // the same bucket (copy to all languages, a save and an AI accept share one).
    // The slot is free the moment the older write is SENT again, not when its
    // handler finishes, and waiting for it is capped. Limit: ordering holds among
    // writes that are already held or whose path is known to belong to a bucket;
    // the FIRST send of a path the wrapper has never seen refused can still
    // overtake a held write while it sleeps.
    const register = (bucket: string) => {
      if (!isWrite || registeredBucket) return;
      registeredBucket = bucket;
      let set = waitingWrites.get(bucket);
      if (!set) waitingWrites.set(bucket, (set = new Set()));
      set.add(seq);
    };
    const release = () => {
      if (!registeredBucket) return;
      waitingWrites.get(registeredBucket)?.delete(seq);
      registeredBucket = undefined;
    };
    let turnWaits = 0;
    const hasOlderWaiting = () =>
      !!registeredBucket && [...(waitingWrites.get(registeredBucket) ?? [])].some((other) => other < seq);

    try {
    for (;;) {
      // A bucket this kind of request is known to belong to may be closed: do
      // not send into a closed window, wait for it (or give up when that is too long).
      const knownBucket = key ? bucketByKey.get(key) : undefined;
      const closedFor = knownBucket ? (blockedUntilByBucket.get(knownBucket) ?? 0) - now() : 0;
      let refused: Response | null = null;
      let retryAfterMs = 0;

      if (closedFor > 0 && resendable && gateWaits < MAX_GATE_WAITS) {
        retryAfterMs = closedFor;
        gateWaits++;
        if (knownBucket) register(knownBucket);
      } else {
        // A path known to belong to a bucket takes its turn behind older held writes
        // of it even when the window is already open again (the older one may be
        // asleep in its jitter).
        if (knownBucket) register(knownBucket);
        while (hasOlderWaiting() && ++turnWaits <= MAX_TURN_WAITS) await sleep(25, signal);
        release();
        const attempt = isRequest ? (input as Request).clone() : input;
        const response = await inner(attempt, init);
        const bucket = response.status === 429 ? response.headers.get(RATE_LIMIT_MARKER_HEADER) : null;
        if (!bucket) return response; // not ours: untouched, whatever the status
        if (key) bucketByKey.set(key, bucket);
        register(bucket);
        retryAfterMs = parseRetryAfterMs(response.headers.get("Retry-After"));
        blockedUntilByBucket.set(bucket, Math.max(blockedUntilByBucket.get(bucket) ?? 0, now() + retryAfterMs));
        refused = response;
      }

      const retryAfterSeconds = Math.ceil(retryAfterMs / 1000);
      if ((refused && retries >= MAX_RETRIES) || retryAfterMs > MAX_WAIT_MS || !resendable) {
        emit({ type: "gave-up", retryAfterSeconds, write: isWrite });
        if (isSingleFetch && url) {
          // Free the connection; the router must not see this body.
          await refused?.body?.cancel().catch(() => undefined);
          const answer = singleFetchAnswer(url, method, retryAfterSeconds);
          return answer ?? holdUntilAborted(signal);
        }
        if (refused) return refused;
        // Nothing was sent (the window is closed and too long to wait): answer
        // like the limiter would, for a caller that reads `response.ok`.
        return new Response(JSON.stringify({ error: messageProvider(), rateLimited: true, retryAfter: retryAfterSeconds }), {
          status: 429,
          headers: { "Content-Type": "application/json", "Retry-After": String(retryAfterSeconds) },
        });
      }

      await refused?.body?.cancel().catch(() => undefined);
      if (!announced) {
        announced = true;
        emit({ type: "waiting", seconds: retryAfterSeconds });
      }
      // Only a real send is a retry; waiting for a closed window is not.
      if (refused) retries++;
      await sleep(retryAfterMs + Math.floor(random() * JITTER_MS), signal);
    }
    } finally {
      release();
    }
  };
  return wrapped as typeof fetch;
}

const INSTALLED = Symbol.for("contentpilot.rateLimitRetry");

/** Wrap `window.fetch` once. Safe to call again. */
export function installRateLimitRetry(): void {
  if (typeof window === "undefined" || typeof window.fetch !== "function") return;
  if ((window.fetch as unknown as Record<symbol, unknown>)[INSTALLED]) return;
  const wrapped = createRateLimitFetch(window.fetch.bind(window));
  (wrapped as unknown as Record<symbol, unknown>)[INSTALLED] = true;
  window.fetch = wrapped;
}
