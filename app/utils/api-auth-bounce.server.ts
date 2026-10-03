import { logger } from "~/utils/logger.server";

/**
 * A JSON API must never answer with Shopify's App Bridge BOUNCE PAGE.
 *
 * `authenticate.admin` treats every request WITHOUT an `Authorization: Bearer
 * <session token>` header as a DOCUMENT request. For a `fetch('/api/ai')` that
 * carries no `shop`/`host` query either, that ends in `renderAppBridge`: a
 * thrown `Response` with status **200** and `content-type:
 * text/html;charset=utf-8` holding two `<script>` tags. (With `shop` +
 * `embedded=1` it is a 302 to `/auth/session-token`, which `fetch` FOLLOWS into
 * the very same 200 page.) Measured from the merchant side as "Server returned
 * 200: Expected JSON but got text/html;charset=utf-8" in the editor's InfoBox,
 * on the improve-with-AI button (2026-10-02).
 *
 * A bounce page is the right answer to a NAVIGATION — it loads App Bridge,
 * which fetches a token and reloads — and a useless one to a `fetch`: nothing
 * runs its scripts, and a 200 reads as success to any caller that checks
 * `response.ok`. So for an `/api/*` request that is clearly NOT a navigation,
 * the bounce is turned into what the library itself answers for an invalid
 * token on a fetch: a 401 carrying `X-Shopify-Retry-Invalid-Session-Request`,
 * the header App Bridge's fetch wrapper (and `fetchApi` on our side) reads as
 * "get a fresh session token and retry". The body is JSON with the code
 * `sessionExpired`, so a caller that cannot retry still shows a sentence.
 *
 * Deliberately narrow:
 *  - only a thrown `Response` that IS a bounce (200 HTML, or a redirect to the
 *    session-token path) — the OAuth/exit-iframe/bot answers pass untouched;
 *  - only when the request carried no `Authorization` header (with one, the
 *    library already answers 401 itself);
 *  - only under `/api/`, and never for a navigation (`Sec-Fetch-Mode:
 *    navigate`, or an `Accept` that asks for HTML — a CSV download link, an
 *    iframe `src`), where the bounce page is what makes the request work.
 *
 * The warn line is this case's only trace in the logs: the library logs the
 * bounce at debug, and the access log shows a plain `POST /api/ai 200`.
 */
export const SESSION_EXPIRED_CODE = "sessionExpired";
const RETRY_HEADER = "X-Shopify-Retry-Invalid-Session-Request";
const SESSION_TOKEN_PATH = "/auth/session-token";

function isBouncePage(response: Response): "bouncePage" | "bounceRedirect" | null {
  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  if (response.status === 200 && contentType.startsWith("text/html")) return "bouncePage";
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location") || "";
    if (location.includes(SESSION_TOKEN_PATH)) return "bounceRedirect";
  }
  return null;
}

function isNavigation(request: Request): boolean {
  const mode = (request.headers.get("sec-fetch-mode") || "").toLowerCase();
  if (mode === "navigate") return true;
  const accept = (request.headers.get("accept") || "").toLowerCase();
  return accept.includes("text/html");
}

export function apiAuthBounceRejection(error: unknown, request: Request): Response | null {
  if (!(error instanceof Response)) return null;
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/")) return null;
  if (request.headers.get("authorization")) return null;
  if (isNavigation(request)) return null;
  const kind = isBouncePage(error);
  if (!kind) return null;

  logger.warn("[AUTH] API request without a session token — answered 401 instead of the App Bridge bounce page", {
    context: "Auth",
    method: request.method,
    pathname: url.pathname,
    bounce: kind,
    secFetchMode: request.headers.get("sec-fetch-mode") || null,
    hasShopParam: url.searchParams.has("shop"),
  });

  return new Response(
    JSON.stringify({ success: false, error: SESSION_EXPIRED_CODE, code: SESSION_EXPIRED_CODE }),
    {
      status: 401,
      statusText: "Unauthorized",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        [RETRY_HEADER]: "1",
      },
    },
  );
}
