/**
 * What a 403 from Shopify means, and what we do about it
 * (PLAN_ADMIN_SHOP_OVERVIEW 2.5).
 *
 * A 403 is NEVER evidence that one shop's access is dead. Four things produce
 * it, and only one of them is about the shop:
 *
 *  - `non_expiring_rejected`: the deadline answer for a NON-expiring offline
 *    token ("Non-expiring access tokens are no longer accepted ..."). The token
 *    is not revoked, it can still be migrated. The existing detection, moved here.
 *  - `ip_allowlist`: the text itself names the IP / allowlist. The production
 *    app enforces Shopify's Admin API IP allowlist (CLAUDE.md "Deploy-critical
 *    gotchas"); if our outbound address changes, EVERY shop gets this.
 *  - `ip_allowlist_suspected`: no such text, but several (3) distinct shops got a
 *    403 within the window and no OTHER shop (one that did not 403 itself)
 *    succeeded in it. Shopify's answer to a blocked address is not always
 *    worded; "everybody fails at once" is the signal. With ONE active shop this
 *    can be wrong, in the safe direction: a pause, never a block.
 *  - `shop_specific`: anything else (a missing scope, one shop's own refusal).
 *
 * Consequences, all in this module or its callers:
 *  - a 403 never sets a connection block and never empties a stored token;
 *  - on an allowlist kind: ONE loud `[ShopifyIP] IP_ALLOWLIST_403` line at most
 *    every 5 min (pointing at the CLAUDE.md note), an ops alert at most once an
 *    hour, and a global 30-minute PAUSE of the token migration and the probe of
 *    blocked shops (`isIpAllowlistPaused`). The pause counts no attempts.
 *
 * Success feeds the "no other shop succeeded" signal from memory only
 * (`noteApiSuccess`, called by the two refreshing admin clients and the probe).
 * In-app requests through the library's own client do not feed it; that only
 * makes the suspicion more likely, i.e. the safe direction.
 *
 * Nothing here reads or logs a token. Module state is process-local (one
 * instance, RAILWAY-SETUP).
 */

import { logger } from "./logger.server";
import { notifyOps } from "../services/ops-alert.server";

export type ForbiddenKind = "non_expiring_rejected" | "ip_allowlist" | "ip_allowlist_suspected" | "shop_specific";

/** What Shopify answers an Admin API request made with a non-expiring offline token, from 2027-01-01. */
const NON_EXPIRING_REJECTED = /Non-expiring access tokens are no longer accepted/i;
/** The 403 text names the address list ("IP address is not allowed", "... allowlist"). */
const IP_WORD = /\bIP\b/; // case-sensitive: the bare letters "ip" in any other spelling are not a hint
const IP_PHRASE = /\bip[- ]address|\ballow[- ]?list|\ballowed[- ]ips?\b/i;

export const FORBIDDEN_WINDOW_MS = 10 * 60 * 1000;
/** Distinct shops with a 403 inside the window before "everybody fails" is suspected. */
export const FORBIDDEN_SUSPECT_SHOPS = 3;
export const IP_ALLOWLIST_PAUSE_MS = 30 * 60 * 1000;
/** One incident pauses for at most this long in total, however often it is reported. */
export const IP_ALLOWLIST_PAUSE_MAX_MS = 2 * 60 * 60 * 1000;
export const IP_ALLOWLIST_LOG_INTERVAL_MS = 5 * 60 * 1000;
export const IP_ALLOWLIST_ALERT_INTERVAL_MS = 60 * 60 * 1000;

/** shop -> when it last got a (non-deadline) 403. */
const rawBodyLogged = new Set<string>();
const recentForbidden = new Map<string, number>();
/** shop -> when a call with its stored access last succeeded. */
const recentSuccess = new Map<string, number>();
let pausedUntil = 0;
let incidentStartedAt = 0;
let lastLoggedAt = 0;

/** Test seam. */
export function __resetForbiddenForTests(): void {
  recentForbidden.clear();
  recentSuccess.clear();
  rawBodyLogged.clear();
  pausedUntil = 0;
  incidentStartedAt = 0;
  lastLoggedAt = 0;
}

/** Is this a 403? Matched by shape, not by class: two copies of the library can coexist in the bundle. */
export function isForbiddenByShape(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if (error instanceof Response) return error.status === 403;
  const e = error as { response?: { code?: number; status?: number }; status?: number };
  return e.response?.code === 403 || e.response?.status === 403 || e.status === 403;
}

/**
 * The words of a 403, from every place a caller may have put them: the error's
 * message (the library's `HttpResponseError` embeds the `errors` of the body
 * there), its parsed body, and, for a thrown/returned `Response`, a CLONE of its
 * body (the original stays readable). Never throws; "" when nothing is readable.
 */
export async function forbiddenText(error: unknown): Promise<string> {
  try {
    if (error instanceof Response) return await error.clone().text();
    const e = error as { message?: unknown; body?: unknown; errors?: unknown; response?: { body?: unknown } };
    return [e.message, e.errors, e.body, e.response?.body]
      .filter((part) => part !== undefined && part !== null)
      .map((part) => (typeof part === "string" ? part : JSON.stringify(part)))
      .join("\n");
  } catch {
    return "";
  }
}

/** Is this the 403 Shopify sends for a NON-expiring offline token after the 2027-01-01 deadline? */
export async function isNonExpiringRejection(error: unknown): Promise<boolean> {
  if (!isForbiddenByShape(error)) return false;
  return NON_EXPIRING_REJECTED.test(await forbiddenText(error));
}

/** A call made with `shop`'s stored access succeeded. In memory, cheap, never throws. */
export function noteApiSuccess(shop: string): void {
  const now = Date.now();
  recentSuccess.set(shop, now);
  if (recentSuccess.size > 500) {
    for (const [s, at] of recentSuccess) if (now - at > FORBIDDEN_WINDOW_MS) recentSuccess.delete(s);
  }
}

function suspectsAllowlist(now: number): boolean {
  const failing = new Set<string>();
  for (const [s, at] of recentForbidden) {
    if (now - at > FORBIDDEN_WINDOW_MS) recentForbidden.delete(s);
    else failing.add(s);
  }
  if (failing.size < FORBIDDEN_SUSPECT_SHOPS) return false;
  for (const [s, at] of recentSuccess) {
    if (now - at > FORBIDDEN_WINDOW_MS) recentSuccess.delete(s);
    // A shop that itself got a 403 inside the window proves nothing: it may
    // have succeeded just before the address stopped being accepted.
    else if (!failing.has(s)) return false;
  }
  return true;
}

/**
 * Classify a 403 for `shop`, or `null` when `error` is not a 403 at all. Every
 * non-deadline 403 is remembered for the "several shops" signal (unless
 * `opts.record === false`). Never throws.
 */
export async function classifyForbidden(
  shop: string,
  error: unknown,
  opts: { record?: boolean } = {},
): Promise<ForbiddenKind | null> {
  try {
    if (!isForbiddenByShape(error)) return null;
    const text = await forbiddenText(error);
    if (NON_EXPIRING_REJECTED.test(text)) return "non_expiring_rejected";
    const now = Date.now();
    // The probe of an ALREADY-BLOCKED shop passes record:false: a shop that is
    // dead for its own reasons answers 403 to everything and says nothing about
    // our address. It is still classified against what the others show.
    if (opts.record !== false) recentForbidden.set(shop, now);
    if (IP_WORD.test(text) || IP_PHRASE.test(text)) {
      logFirstAllowlistBody(shop, "ip_allowlist", text);
      return "ip_allowlist";
    }
    if (suspectsAllowlist(now)) {
      logFirstAllowlistBody(shop, "ip_allowlist_suspected", text);
      return "ip_allowlist_suspected";
    }
    return "shop_specific";
  } catch {
    return null;
  }
}

/** Token-like strings, IP addresses and base64-ish runs are masked; the text is cut to 300 characters. */
function redactBody(text: string): string {
  return text
    .replace(/shp[a-z]{2}_[A-Za-z0-9]+/g, "[token]")
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, "[ip]")
    .replace(/\b[0-9a-fA-F]{0,4}(?::[0-9a-fA-F]{0,4}){2,7}\b/g, "[ip]")
    .replace(/[A-Za-z0-9+/=_-]{20,}/g, "[opaque]")
    .replace(/\s+/g, " ")
    .slice(0, 300);
}

/**
 * The wording of Shopify's allowlist answer is not measured. The first time a
 * 403 is classified as an allowlist kind (per kind and process) its raw body is
 * logged, redacted and truncated, so the real text can be checked afterwards.
 */
function logFirstAllowlistBody(shop: string, kind: ForbiddenKind, text: string): void {
  if (rawBodyLogged.has(kind)) return;
  rawBodyLogged.add(kind);
  logger.warn(`[ShopifyIP] first 403 classified as ${kind} on ${shop}; raw body (truncated, redacted): ${redactBody(text) || "(empty)"}`);
}

/** Is the global pause of the migration and the probe in force? */
export function isIpAllowlistPaused(): boolean {
  return Date.now() < pausedUntil;
}

/**
 * React to a classified 403. Only the two allowlist kinds do anything: extend
 * the 30-minute global pause, log ONE loud line at most every 5 minutes, and
 * alert ops at most once an hour (ALERT_WEBHOOK_URL; without it the alert is a
 * no-op and only the log line exists). Never blocks a shop, never touches a
 * token. Never throws.
 */
export function reportForbidden(shop: string, kind: ForbiddenKind): void {
  if (kind !== "ip_allowlist" && kind !== "ip_allowlist_suspected") return;
  try {
    const now = Date.now();
    // A report after the pause ran out starts a new incident; within one, the
    // pause grows by reports but never past IP_ALLOWLIST_PAUSE_MAX_MS in total.
    if (now >= pausedUntil) incidentStartedAt = now;
    pausedUntil = Math.max(pausedUntil, Math.min(now + IP_ALLOWLIST_PAUSE_MS, incidentStartedAt + IP_ALLOWLIST_PAUSE_MAX_MS));
    if (now - lastLoggedAt >= IP_ALLOWLIST_LOG_INTERVAL_MS) {
      lastLoggedAt = now;
      logger.error(
        `[ShopifyIP] IP_ALLOWLIST_403 -- Shopify answered 403 (${kind === "ip_allowlist" ? "the text names the IP allowlist" : `${recentForbidden.size} shops within ${Math.round(FORBIDDEN_WINDOW_MS / 60000)} min, no other shop succeeded`}), ` +
          `first seen on ${shop}. This looks like the Admin API IP allowlist, not like merchants. No shop is blocked and no token is touched; ` +
          `token migration and the probe of blocked shops pause for ${Math.round(IP_ALLOWLIST_PAUSE_MS / 60000)} min. ` +
          `See the IP-allowlist note under "Deploy-critical gotchas" in CLAUDE.md (Railway static outbound IPs vs. the Dev Dashboard allowlist).`,
      );
    }
    notifyOps(
      "ip_allowlist_403",
      "Shopify answers Admin API calls with 403 and it looks like the IP allowlist (several shops fail at once). " +
        "Check Railway's static outbound IPs against the Dev Dashboard allowlist (CLAUDE.md, Deploy-critical gotchas).",
      { throttleMs: IP_ALLOWLIST_ALERT_INTERVAL_MS },
    );
  } catch {
    /* never throws */
  }
}
