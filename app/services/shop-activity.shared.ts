/**
 * Pure rules of the per-shop usage statistics (PLAN_ADMIN_SHOP_OVERVIEW 3.2).
 * Import-free on purpose: the tracker (server) and its tests share it.
 *
 * What counts:
 *  - a REQUEST is "polling" when it hits one of the background endpoints the
 *    open tabs call every few seconds; polling never counts as a window or an
 *    action, and never refreshes "last opened". A tab that was only opened and
 *    left idle still counts through its own navigations/revalidations (owner
 *    decision 2026-11: an open idle tab counts as opened, its polling does not).
 *  - an ACTION is any request that is not GET/HEAD/OPTIONS.
 *  - a WINDOW is a 5-minute slot of the UTC clock with at least one non-polling
 *    request.
 *
 * Only the PATH is ever looked at, never the query string.
 */

export const ACTIVITY_SLOT_MS = 5 * 60 * 1000;
/** lastActivityAt is written at most this often per shop. */
export const ACTIVITY_WRITE_INTERVAL_MS = 5 * 60 * 1000;
/** The "last action" columns are rewritten at most this often per shop while the area stays the same. */
export const ACTION_WRITE_INTERVAL_MS = 30 * 1000;

/**
 * Endpoints that tabs call on a timer. Mirrors the polling endpoints the rate
 * limiter exempts (server.js `apiExcludedPaths`) plus the other status pollers
 * of the app; a poller missing here costs an inflated window count, never a
 * wrong action count (pollers are GETs).
 */
// Known limit: a page that revalidates every few seconds while a task runs (not in
// this list, it is a page loader) counts as an active window and refreshes "last
// opened" for the task's duration. See KNOWN_ISSUES.md "Server und Betrieb".
export const POLLING_PATH_PREFIXES: readonly string[] = [
  "/api/running-tasks-count",
  "/api/running-tasks-list",
  "/api/running-field-tasks",
  "/api/recently-completed-tasks",
  "/api/task-status",
  "/api/task-result",
  "/api/sync-status",
  "/api/billing/status",
];

/** Matches the path itself and anything below it ("/api/task-status", "/api/task-status.data"), not a longer sibling name. */
export function isPollingPath(pathname: string): boolean {
  const p = pathname.toLowerCase();
  return POLLING_PATH_PREFIXES.some((prefix) => {
    if (!p.startsWith(prefix)) return false;
    const next = p.charAt(prefix.length);
    return next === "" || next === "/" || next === ".";
  });
}

export function isActionMethod(method: string): boolean {
  const m = method.toUpperCase();
  return m !== "GET" && m !== "HEAD" && m !== "OPTIONS";
}

/**
 * "/app/products.data" -> "app.products", "/api/ai/generate" -> "api.ai.generate".
 * Path only. Segments that look like ids (digits, GIDs, long tokens) are
 * dropped, at most three segments are kept, and the result is a plain code
 * (lowercase letters, digits, `_`, `-`, `.`), 64 characters at most.
 */
export function pathArea(pathname: string): string {
  const cleaned = pathname.split("?")[0].split("#")[0].replace(/\.data$/i, "");
  const segments = cleaned
    .split("/")
    .map((s) => {
      // Decode first, so an encoded GID ("gid%3A%2F%2F...") is recognised as one.
      try {
        return decodeURIComponent(s).trim().toLowerCase();
      } catch {
        return "";
      }
    })
    .filter((s) => s.length > 0)
    .filter((s) => !/^\d+$/.test(s) && !/^gid:/.test(s) && s.length <= 40)
    .map((s) => s.replace(/[^a-z0-9_-]/g, "_"))
    .slice(0, 3);
  const area = segments.join(".").slice(0, 64);
  return area || "root";
}

export function slotOf(nowMs: number): number {
  return Math.floor(nowMs / ACTIVITY_SLOT_MS);
}

/** The UTC calendar day of `nowMs` as a Date at 00:00 UTC (for a `@db.Date` column). */
export function utcDay(nowMs: number): Date {
  const d = new Date(nowMs);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
