/**
 * Client-safe half of the external-link feature (PLAN_SEO_CRAWL_EXPANSION §6).
 *
 * The crawl report renders these constants and classifications in COMPONENT
 * scope, and `external-links.server.ts` reaches for `node:dns` to resolve a
 * host before fetching it — so the two must not live in one module. Same split
 * as `crawl.shared.ts` / `crawl.service.ts`, for the same bundling reason.
 */

/** Distinct target URLs recorded per crawl. Past this only `count` keeps
 *  rising — and the UI SAYS so (§6.1: silent truncation has hurt this codebase
 *  before). */
export const MAX_EXTERNAL_TARGETS = 2000;
/** Source URLs kept per target for the "linked from" list. */
export const MAX_SAMPLE_SOURCES = 5;

/**
 * `statusCode` sentinel for a target the pass never got to — the 120s budget
 * ran out (§6.3). Persisted rather than dropped, because "we did not check
 * these" and "these are fine" must not look the same in the report.
 */
export const EXTERNAL_NOT_CHECKED = -2;

/**
 * True when a result is a genuine dead link.
 *
 * 403/429 are excluded, for exactly the reason `isBotBlockStatus`
 * (crawl.service.ts) excludes them from the internal broken-link list: they
 * mean "a bot filter refused US", not "the target is gone" — a visitor and
 * Googlebot still reach the page. Here the risk is higher, not lower: the
 * check already retries a HEAD-403 with a GET, so a 403 that survives is
 * almost always a shield that refuses non-browser clients outright. Counting
 * those as dead links would flood the report with false positives, which is
 * the failure mode §6.2 exists to avoid.
 *
 * `EXTERNAL_NOT_CHECKED` is not broken either — it is unknown, and the UI says
 * so separately.
 */
export function isExternalLinkBroken(statusCode: number): boolean {
  if (statusCode === EXTERNAL_NOT_CHECKED) return false;
  if (statusCode === 403 || statusCode === 429) return false;
  return statusCode <= 0 || statusCode >= 400;
}

/** A bot filter refused the check — reported, but never as a dead link. */
export function isExternalLinkBlocked(statusCode: number): boolean {
  return statusCode === 403 || statusCode === 429;
}

export interface ExternalTarget {
  url: string;
  /** How many pages link here (every occurrence, not just the sampled ones). */
  count: number;
  /** Up to MAX_SAMPLE_SOURCES source page URLs. */
  sources: string[];
  anchor: string | null;
}

export interface ExternalCheckResult {
  url: string;
  /** HTTP status, `0` = timeout/DNS/refused by the safety guard, `-1` = redirect
   *  loop or more than EXTERNAL_MAX_HOPS, `-2` = not checked (budget). Same
   *  sentinel convention as SeoCrawlPage. */
  statusCode: number;
  /** Set when the link redirected. "points at http://, redirects to https://"
   *  is a useful finding in its own right. */
  finalUrl: string | null;
  sourceCount: number;
  sampleSources: string;
  anchor: string | null;
}
