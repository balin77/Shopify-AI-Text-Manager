/**
 * The embedded-app `host` query parameter, checked the way
 * `@shopify/shopify-api`'s `sanitizeHost` checks it — minus the throw that
 * library lets escape.
 *
 * `sanitizeHost` tests the value against a base64 pattern and then runs
 * `new URL(`https://${atob(host)}`)` with no guard. A value that PASSES the
 * pattern but does not decode into a hostname — `9993237716999999999` is all
 * digits, which the pattern accepts — throws a `TypeError: Invalid URL` (or a
 * `DOMException` from `atob` for a length the decoder refuses) out of
 * `authenticate.admin`, before the library's own "invalid host" branch can
 * answer. Every loader that authenticates outside a try then answered 500, the
 * root error boundary rendered, and Sentry got three events for one tampered
 * URL. Seen in production on 2026-09-13: Shopify's App Review sends exactly
 * such requests (`host=9993237716999999999`) against `/app` and `/app/products`.
 *
 * The conversion happens AFTER the library has thrown, never before it runs:
 * the library answers bots, OPTIONS, the bounce and exit-iframe paths, and any
 * request carrying a session token without ever reading `host`, and a check in
 * front of it would refuse those. So the only request this changes is one the
 * library itself has just crashed on — every other outcome stays the library's.
 */
import { logger } from "./logger.server";

const BASE64 = /^[0-9a-zA-Z+/]+={0,2}$/;

/** True when `sanitizeHost` would THROW for this value (not merely reject it). */
export function isUnparseableHostParam(host: string | null): boolean {
  if (!host || !BASE64.test(host)) return false;
  try {
    new URL(`https://${atob(host)}`);
    return false;
  } catch {
    return true;
  }
}

/**
 * The 400 to throw instead of `error`, or `null` to rethrow `error` unchanged.
 *
 * Only a NON-Response throw qualifies (a thrown `Response` is the library's
 * auth handshake and must pass through untouched), and only when the request's
 * `host` really is one the library cannot parse — anything else is a different
 * failure and keeps its own treatment.
 *
 * The warn line is this refusal's only trace: React Router does not hand a
 * thrown `Response` to `handleError`, so nothing else logs it besides the
 * access log's status code. It never goes to Sentry — a tampered URL is
 * traffic, not a fault.
 */
export function hostParamRejection(error: unknown, request: Request): Response | null {
  if (error instanceof Response) return null;
  const url = new URL(request.url);
  if (!isUnparseableHostParam(url.searchParams.get("host"))) return null;

  logger.warn("Refused request with an unparseable host parameter", {
    context: "Auth",
    method: request.method,
    pathname: url.pathname,
    reason: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  });
  return new Response("Invalid host parameter", {
    status: 400,
    statusText: "Bad Request",
  });
}
