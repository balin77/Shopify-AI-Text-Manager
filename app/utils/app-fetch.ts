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
 *  2. It recognises an auth bounce in every shape it reaches the browser in:
 *     anything carrying `X-Shopify-Retry-Invalid-Session-Request` (the server
 *     now answers `/api/*` this way, see api-auth-bounce.server.ts), the
 *     library's body-less 401 — but never a JSON 401 a route wrote itself,
 *     like `/api/ai`'s INVALID_AI_KEY —
 *     the 200 HTML bounce page, or a redirect `fetch` followed into HTML.
 *  3. It retries ONCE with a freshly requested token. A bounce happens before
 *     any route code runs, so the retry cannot double a write.
 *  4. A second bounce throws `SessionExpiredError`, whose message is the code
 *     `sessionExpired` — `translateErrorMessage` turns it into "the session
 *     has expired, reload the page" in the merchant's language. Raw
 *     "Expected JSON" text never reaches the UI again.
 *
 * Client-only in practice (it reads `window.shopify`), but deliberately NOT a
 * `*.client` module: those are `undefined` in the server build, and the hooks
 * importing this are evaluated there too. On the server the token lookup is
 * simply skipped.
 */

export const SESSION_EXPIRED_CODE = "sessionExpired";
const RETRY_HEADER = "X-Shopify-Retry-Invalid-Session-Request";
const TOKEN_TIMEOUT_MS = 10_000;

export class SessionExpiredError extends Error {
  readonly code = SESSION_EXPIRED_CODE;
  readonly status: number;
  constructor(status: number) {
    super(SESSION_EXPIRED_CODE);
    this.name = "SessionExpiredError";
    this.status = status;
  }
}

export function isSessionExpiredError(error: unknown): error is SessionExpiredError {
  return (
    error instanceof SessionExpiredError ||
    (typeof error === "object" && error !== null && (error as { code?: unknown }).code === SESSION_EXPIRED_CODE)
  );
}

/** Whether `response` is an authentication bounce rather than the route's answer. */
export function isAuthBounce(response: Response): boolean {
  if (response.headers.get(RETRY_HEADER) === "1") return true;
  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  // A 401 the ROUTE wrote is an answer, not a bounce: `/api/ai` answers an
  // invalid provider key with a JSON 401 (`INVALID_AI_KEY`) that must reach
  // the caller. The library's own 401 has an empty body.
  if (response.status === 401) return !contentType.includes("application/json");
  if (!contentType.startsWith("text/html")) return false;
  // A JSON route never answers HTML with 200; nor does anything a followed
  // redirect lands on. Both are the App Bridge bounce page.
  return response.status === 200 || response.redirected;
}

/** A fresh App Bridge session token, or null where none can be had. */
export async function getSessionToken(): Promise<string | null> {
  if (typeof window === "undefined") return null;
  const idToken = (window as unknown as { shopify?: { idToken?: unknown } }).shopify?.idToken;
  if (typeof idToken !== "function") return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const token = await Promise.race([
      Promise.resolve((idToken as () => Promise<unknown>).call((window as unknown as { shopify: unknown }).shopify)),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), TOKEN_TIMEOUT_MS);
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

async function send(input: string, init: RequestInit, callerSetAuth: boolean): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has("Accept")) headers.set("Accept", "application/json");
  if (!callerSetAuth) {
    const token = await getSessionToken();
    if (token) headers.set("Authorization", `Bearer ${token}`);
  }
  return fetch(input, { ...init, headers });
}

/**
 * `fetch` for this app's JSON routes. Resolves with the route's own response;
 * throws `SessionExpiredError` when the session cannot be re-established.
 */
export async function appFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const callerSetAuth = new Headers(init.headers).has("Authorization");
  const first = await send(input, init, callerSetAuth);
  if (!isAuthBounce(first)) return first;
  await first.text().catch(() => "");
  if (callerSetAuth || !canResend(init.body)) throw new SessionExpiredError(first.status);
  const second = await send(input, init, false);
  if (!isAuthBounce(second)) return second;
  await second.text().catch(() => "");
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
