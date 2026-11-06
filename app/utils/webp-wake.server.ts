/**
 * Nudge the WebP conversion worker to poll NOW.
 *
 * The worker (`webp-processor.service.js`, a root module started by server.js)
 * polls the task table every 10 seconds, so a freshly queued conversion used to
 * wait up to that long before it started. It runs in the same process but
 * outside the React Router bundle's module graph, so the bundle reaches it
 * through a process-wide hook — the same way the root-JS workers reach
 * `globalThis.__getShopAccessToken`.
 *
 * The worker owns the concurrency rule (never two polls at once: a wake-up
 * during a poll is folded into "poll again when it ends"). This side only
 * guarantees that a nudge can never hurt the request that sends it: no hook
 * (the worker is not started — the production review gate, a test, a worker
 * that failed to boot) is a no-op that leaves the regular tick in charge, and
 * anything the hook throws is swallowed.
 */

declare global {
  // eslint-disable-next-line no-var
  var __wakeWebpProcessor: (() => void) | undefined;
}

/** True when a hook was there to call (for logs/tests); never throws. */
export function nudgeWebpProcessor(): boolean {
  try {
    const wake = globalThis.__wakeWebpProcessor;
    if (typeof wake !== "function") return false;
    wake();
    return true;
  } catch {
    return false;
  }
}
