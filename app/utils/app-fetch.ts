/**
 * Plain `fetch` to this app's own JSON routes (`/api/*`), with the embedded
 * app's session token handled in ONE place.
 *
 * Why it exists: `authenticate.admin` treats a request without an
 * `Authorization: Bearer <session token>` header as a DOCUMENT request and
 * answers it with Shopify's App Bridge bounce page — status 200,
 * `text/html;charset=utf-8`. Every caller then reported that as "Server
 * returned 200: Expected JSON but got text/html;charset=utf-8" (the improve
 * button, 2026-10-02), or worse, as `Unexpected token '<'`. The token header
 * is normally added by App Bridge's own `fetch` wrapper; this helper does not
 * depend on that wrapper having run:
 *
 *  1. It asks App Bridge for a token itself (`shopify.idToken()`) and sends it,
 *     unless the caller set an `Authorization` header of its own.
 *  2. It classifies the answer (`classifyAuthResponse`). Only THREE shapes are
 *     a RETRYABLE bounce, because only these are known to be answered before
 *     any route code ran:
 *       - anything carrying `X-Shopify-Retry-Invalid-Session-Request: 1` (the
 *         library's answer to an invalid token on a fetch, and the server's
 *         own conversion of the bounce for `/api/*`, api-auth-bounce.server.ts);
 *       - a 200 `text/html` answer (the bounce page itself);
 *       - a `text/html` answer `fetch` reached by following a redirect.
 *     A 401 WITHOUT that header is NOT retried: the library also answers 401
 *     after the route's own code has started (a token exchange failing inside
 *     `admin.graphql` answers through `respondToInvalidSessionToken` without
 *     the retry flag), so a resend could repeat a write. It throws
 *     `SessionExpiredError` straight away — unless it is a route's own JSON
 *     401 (`/api/ai`'s INVALID_AI_KEY), which is the route's answer and is
 *     passed through untouched.
 *     A 401 carrying `X-Shopify-API-Request-Failure-Reauthorize-Url` is a
 *     third thing (the library's out-of-app redirect, e.g. billing): it throws
 *     `ReauthorizeRequiredError` (code `reauthorizeRequired`, the URL on
 *     `.url`). Calling it an expired session would send the merchant to reload
 *     a page that will only ask again.
 *  3. It retries a bounce at most ONCE, with a freshly requested token, and
 *     never when the caller supplied its own `Authorization` header (that
 *     token is the caller's business) or when the body cannot be re-sent.
 *     The second token request gets a shorter deadline (3 s against 10 s): a
 *     token that did not come quickly the first time rarely comes at all, and
 *     the merchant is watching a spinner.
 *  4. A second bounce throws `SessionExpiredError`, whose message is the code
 *     `sessionExpired` — `translateErrorMessage` turns it into "the session
 *     has expired, reload the page" in the merchant's language. Raw
 *     "Expected JSON" text never reaches the UI again.
 *
 * Double retries: App Bridge (the CDN script) may also patch the global
 * `fetch` and retry a response carrying the retry header once by itself. That
 * cannot be detected reliably from here, so the worst case is 2 x 2 = four
 * requests for one call. It is bounded, and harmless for the same reason the
 * retry is: every shape this helper retries is answered before route code
 * runs. Nothing here loops.
 *
 * Client-only in practice (it reads `window.shopify`), but deliberately NOT a
 * `*.client` module: those are `undefined` in the server build, and the hooks
 * importing this are evaluated there too. On the server the token lookup is
 * simply skipped.
 */

export const SESSION_EXPIRED_CODE = "sessionExpired";
export const REAUTHORIZE_REQUIRED_CODE = "reauthorizeRequired";
const RETRY_HEADER = "X-Shopify-Retry-Invalid-Session-Request";
const REAUTHORIZE_HEADER = "X-Shopify-API-Request-Failure-Reauthorize-Url";
const TOKEN_TIMEOUT_MS = 10_000;
const RETRY_TOKEN_TIMEOUT_MS = 3_000;

export class SessionExpiredError extends Error {
  readonly code = SESSION_EXPIRED_CODE;
  readonly status: number;
  constructor(status: number) {
    super(SESSION_EXPIRED_CODE);
    this.name = "SessionExpiredError";
    this.status = status;
  }
}

export class ReauthorizeRequiredError extends Error {
  readonly code = REAUTHORIZE_REQUIRED_CODE;
  readonly status: number;
  readonly url: string;
  constructor(status: number, url: string) {
    super(REAUTHORIZE_REQUIRED_CODE);
    this.name = "ReauthorizeRequiredError";
    this.status = status;
    this.url = url;
  }
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}

export function isSessionExpiredError(error: unknown): error is SessionExpiredError {
  return error instanceof SessionExpiredError || hasCode(error, SESSION_EXPIRED_CODE);
}

export function isReauthorizeRequiredError(error: unknown): error is ReauthorizeRequiredError {
  return error instanceof ReauthorizeRequiredError || hasCode(error, REAUTHORIZE_REQUIRED_CODE);
}

/** Either of the two auth errors above — both carry a code `translateErrorMessage` phrases. */
export function isAuthError(error: unknown): error is SessionExpiredError | ReauthorizeRequiredError {
  return isSessionExpiredError(error) || isReauthorizeRequiredError(error);
}

/**
 * What an answer means for authentication:
 *  - `bounce`      — answered before route code ran; one retry with a fresh token is safe;
 *  - `expired`     — a library 401 without the retry flag; NOT retried;
 *  - `reauthorize` — Shopify wants the merchant to approve something outside the app;
 *  - `null`        — the route's own answer (including its own JSON 401).
 */
export type AuthResponseKind = "bounce" | "expired" | "reauthorize";

export function classifyAuthResponse(response: Response): AuthResponseKind | null {
  if (response.headers.get(RETRY_HEADER) === "1") return "bounce";
  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  if (response.status === 401) {
    if (response.headers.get(REAUTHORIZE_HEADER)) return "reauthorize";
    // A 401 the ROUTE wrote is an answer, not an auth failure: `/api/ai`
    // answers an invalid provider key with a JSON 401 (`INVALID_AI_KEY`).
    if (contentType.includes("application/json")) return null;
    return "expired";
  }
  if (!contentType.startsWith("text/html")) return null;
  // A JSON route never answers HTML with 200; nor does anything a followed
  // redirect lands on. Both are the App Bridge bounce page.
  return response.status === 200 || response.redirected ? "bounce" : null;
}

/** Whether `response` is a RETRYABLE authentication bounce. */
export function isAuthBounce(response: Response): boolean {
  return classifyAuthResponse(response) === "bounce";
}

/** A fresh App Bridge session token, or null where none can be had. */
export async function getSessionToken(timeoutMs: number = TOKEN_TIMEOUT_MS): Promise<string | null> {
  if (typeof window === "undefined") return null;
  const idToken = (window as unknown as { shopify?: { idToken?: unknown } }).shopify?.idToken;
  if (typeof idToken !== "function") return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const token = await Promise.race([
      Promise.resolve((idToken as () => Promise<unknown>).call((window as unknown as { shopify: unknown }).shopify)),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
    return typeof token === "string" && token ? token : null;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function canResend(body: RequestInit["body"]): boolean {
  if (body == null) return true;
  if (typeof ReadableStream !== "undefined" && body instanceof ReadableStream) return false;
  return true;
}

async function send(
  input: string,
  init: RequestInit,
  callerSetAuth: boolean,
  tokenTimeoutMs: number,
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has("Accept")) headers.set("Accept", "application/json");
  if (!callerSetAuth) {
    const token = await getSessionToken(tokenTimeoutMs);
    if (token) headers.set("Authorization", `Bearer ${token}`);
  }
  return fetch(input, { ...init, headers });
}

/**
 * The route's answer ⇒ `false`. A retryable bounce ⇒ `true` (body drained).
 * `expired` / `reauthorize` throw their error.
 */
async function isRetryableBounce(response: Response): Promise<boolean> {
  const kind = classifyAuthResponse(response);
  if (kind === null) return false;
  await response.text().catch(() => "");
  if (kind === "reauthorize") {
    throw new ReauthorizeRequiredError(response.status, response.headers.get(REAUTHORIZE_HEADER) || "");
  }
  if (kind === "expired") throw new SessionExpiredError(response.status);
  return true;
}

/**
 * `fetch` for this app's JSON routes. Resolves with the route's own response;
 * throws `SessionExpiredError` when the session cannot be re-established and
 * `ReauthorizeRequiredError` when Shopify asks for an approval outside the app.
 */
export async function appFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const callerSetAuth = new Headers(init.headers).has("Authorization");
  const first = await send(input, init, callerSetAuth, TOKEN_TIMEOUT_MS);
  if (!(await isRetryableBounce(first))) return first;
  if (callerSetAuth || !canResend(init.body)) throw new SessionExpiredError(first.status);
  // One retry, never more, with a fresh token on a shorter deadline.
  const second = await send(input, init, false, RETRY_TOKEN_TIMEOUT_MS);
  if (!(await isRetryableBounce(second))) return second;
  throw new SessionExpiredError(second.status);
}

/**
 * `appFetch` + parse the JSON body. A non-JSON answer that is NOT an auth
 * bounce (a proxy's 502 page, say) throws with the status, never with the
 * body's text.
 */
export async function appFetchJson<T = Record<string, unknown>>(
  input: string,
  init: RequestInit = {},
): Promise<{ response: Response; data: T }> {
  const response = await appFetch(input, init);
  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  if (!contentType.includes("application/json")) {
    await response.text().catch(() => "");
    throw new Error(`Server returned ${response.status}: Expected JSON but got ${contentType || "unknown content type"}`);
  }
  return { response, data: (await response.json()) as T };
}
