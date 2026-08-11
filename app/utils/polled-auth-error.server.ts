import { data as json } from "react-router";
import { logger } from "~/utils/logger.server";
import type { DataResponse } from "~/types/data-response";

/**
 * Normalise an error thrown by `authenticate.admin` inside a BACKGROUND/polled
 * loader (the task-count / recently-completed / running-tasks pollers, etc.).
 *
 * Shopify's Remix adapter THROWS a `Response` to drive re-auth / token exchange
 * when the embedded session token is missing or expired. The old handling did
 * `return json(fallback, { status: authError.status })` — which, when Shopify
 * threw a 3xx redirect, produced a `json()` with a 3xx status but NO `Location`
 * header. Remix rejects that with:
 *
 *   "Redirects returned/thrown from loaders/actions must have a Location header"
 *
 * → the poll 500s on every tick while the session is being refreshed, spamming
 * the logs and wedging the client's task poller in a stuck-loading state.
 *
 * Correct handling:
 *  - 429 (rate limit): degrade to 200 with `fallback` so the poller backs off
 *    gracefully instead of surfacing an error.
 *  - any other thrown `Response` (302 redirect, or 401/403 carrying the
 *    `X-Shopify-Retry-Invalid-Session-Request` header): RE-THROW the ORIGINAL
 *    Response unchanged, so its Location / retry headers survive and App Bridge
 *    can run the token-exchange retry. Never re-wrap its status into a new json.
 *  - a non-Response (genuinely unexpected) error: 500 with `fallback`.
 *
 * Returns a data() result for the graceful cases; re-throws for the auth cases.
 */
export function handlePolledAuthError(err: unknown, fallback: Record<string, unknown>): DataResponse {
  if (err instanceof Response) {
    if (err.status === 429) {
      logger.warn("[PolledAuth] rate limited — returning graceful fallback");
      return json({ ...fallback, warning: "Rate limited" }, { status: 200, headers: { "Retry-After": "60" } });
    }
    // Expected on session-token expiry: hand the original Response back to the
    // framework / App Bridge so it can refresh the token and retry.
    throw err;
  }
  logger.error("[PolledAuth] unexpected non-Response error", { error: err instanceof Error ? err.message : String(err) });
  return json({ ...fallback, error: "Authentication failed" }, { status: 500 });
}
