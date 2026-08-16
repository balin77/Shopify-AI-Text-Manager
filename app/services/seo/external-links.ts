/**
 * Outbound links to OTHER domains (PLAN_SEO_CRAWL_EXPANSION §6).
 *
 * Two halves:
 *  - COLLECTION happens inside the crawl's existing `<a href>` sweep and costs
 *    nothing (`normalizeExternalUrl` below). `normalizeCrawlUrl` deliberately
 *    keeps discarding foreign origins — this runs alongside it rather than
 *    changing it.
 *  - CHECKING is a SECOND PASS after the crawl is already persisted, with its
 *    own rate regime: Shopify's storefront shield does not apply to strangers'
 *    servers, so the crawl's deliberately glacial 2-at-a-time/1s spacing would
 *    turn a few hundred links into an hour of wall clock for no reason. What
 *    DOES apply is basic manners toward each individual host, hence the
 *    per-host cap.
 *
 * The pure half is exported separately from the fetching half so the rules
 * (what counts as an external link, what a status means) are unit-testable
 * without a network.
 */

import { isPrivateOrLoopbackHost } from "../../utils/private-host";

/** Distinct target URLs recorded per crawl. Past this only `count` keeps
 *  rising — and the UI SAYS so (§6.1: silent truncation has hurt this codebase
 *  before). */
export const MAX_EXTERNAL_TARGETS = 2000;
/** Source URLs kept per target for the "linked from" list. */
export const MAX_SAMPLE_SOURCES = 5;

/** Parallel checks. Three times the crawl's, because these requests go to many
 *  different strangers rather than all to one storefront edge. */
export const EXTERNAL_CONCURRENCY = 6;
/** …but never more than this against ONE host, however many links point there. */
export const EXTERNAL_PER_HOST_CONCURRENCY = 2;
export const EXTERNAL_TIMEOUT_MS = 8_000;
/** Hard ceiling for the whole pass. The crawl is already persisted when this
 *  starts and must never fail because someone else's server is slow (§6.3). */
export const EXTERNAL_CHECK_BUDGET_MS = 120_000;
/** Redirect hops followed per external target. */
export const EXTERNAL_MAX_HOPS = 5;

/**
 * Hosts whose URLs are ASSETS, not links: images, fonts and scripts served
 * from Shopify's own CDN. They appear in `<a href>` occasionally (a linked
 * PDF, an image lightbox) and checking them would fill the report with rows a
 * merchant can neither read nor act on.
 */
const ASSET_HOST_SUFFIXES = [
  "cdn.shopify.com",
  // The whole `*.shopifycdn.net` family (`foo.shopifycdn.net`), not just a
  // `cdn.` sub-host: Shopify serves assets from several names under it.
  "shopifycdn.net",
  "shopifycdn.com",
  "shopifycloud.com",
];

/**
 * The URL to record for an outbound `<a href>`, or null when it is not an
 * external link at all.
 *
 * Dedup is by the FULL url INCLUDING the query string — unlike the internal
 * crawl, which strips it. On a foreign target the query usually carries
 * meaning (a product id, a UTM-free deep link), and two URLs differing only in
 * their query genuinely can answer differently.
 */
export function normalizeExternalUrl(
  rawHref: string,
  baseUrl: string,
  canonicalHost: string,
  aliasHosts: string[] = [],
): string | null {
  let u: URL;
  try {
    u = new URL(rawHref, baseUrl);
  } catch {
    return null;
  }
  // mailto:, tel:, javascript:, data: — not links to a page.
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;

  const host = u.hostname.toLowerCase();
  if (!host) return null;
  // Same-origin (either hostname) is the internal crawl's job.
  if (host === canonicalHost.toLowerCase()) return null;
  if (aliasHosts.some((h) => h.toLowerCase() === host)) return null;
  if (ASSET_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) return null;
  // A private/loopback target is never checked (§6.2), so it is not recorded
  // either — a row we would have to explain and could never verify.
  if (isPrivateOrLoopbackHost(host)) return null;

  u.hash = "";
  u.username = "";
  u.password = "";
  return u.toString();
}

export interface ExternalTarget {
  url: string;
  /** How many pages link here (every occurrence, not just the sampled ones). */
  count: number;
  /** Up to MAX_SAMPLE_SOURCES source page URLs. */
  sources: string[];
  anchor: string | null;
}

/**
 * `statusCode` sentinel for a target the pass never got to — the 120s budget
 * ran out (§6.3). Persisted rather than dropped, because "we did not check
 * these" and "these are fine" must not look the same in the report.
 */
export const EXTERNAL_NOT_CHECKED = -2;

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

interface CheckDeps {
  fetchImpl?: typeof fetch;
  userAgent: string;
  timeoutMs?: number;
}

/**
 * One external URL: `HEAD` first, falling back to a one-byte `GET`.
 *
 * The fallback is not an optimisation, it is the difference between a usable
 * report and a useless one: a very large share of hosts (Cloudflare-fronted
 * ones especially) answer `HEAD` with 403/405 while serving the page perfectly
 * well to a `GET`. Without it the report claims hundreds of healthy links are
 * dead.
 *
 * Redirects are followed manually so every hop can be re-checked: an external
 * link may by definition point anywhere, which is exactly why the guard
 * matters MORE here than in the same-origin crawl. Non-http(s) schemes and
 * private/loopback IPs end the chain as a refusal, never as a fetch.
 */
export async function checkExternalUrl(url: string, deps: CheckDeps): Promise<{ statusCode: number; finalUrl: string | null }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? EXTERNAL_TIMEOUT_MS;

  const isFetchable = (candidate: string): boolean => {
    try {
      const u = new URL(candidate);
      if (u.protocol !== "http:" && u.protocol !== "https:") return false;
      return !isPrivateOrLoopbackHost(u.hostname);
    } catch {
      return false;
    }
  };

  const run = async (method: "HEAD" | "GET"): Promise<{ statusCode: number; finalUrl: string | null }> => {
    let current = url;
    const seen = new Set<string>([url]);
    for (let hop = 0; hop <= EXTERNAL_MAX_HOPS; hop++) {
      if (!isFetchable(current)) return { statusCode: 0, finalUrl: current === url ? null : current };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let res: Response;
      try {
        res = await fetchImpl(current, {
          method,
          redirect: "manual",
          headers: {
            "User-Agent": deps.userAgent,
            Accept: "text/html,*/*",
            // A one-byte GET: enough to learn the status without pulling a
            // stranger's whole page down.
            ...(method === "GET" ? { Range: "bytes=0-0" } : {}),
          },
          signal: controller.signal,
        });
      } catch {
        return { statusCode: 0, finalUrl: current === url ? null : current };
      } finally {
        clearTimeout(timer);
      }

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (!location) return { statusCode: res.status, finalUrl: current === url ? null : current };
        let next: string;
        try {
          next = new URL(location, current).toString();
        } catch {
          return { statusCode: -1, finalUrl: current === url ? null : current };
        }
        if (seen.has(next) || hop === EXTERNAL_MAX_HOPS) {
          return { statusCode: -1, finalUrl: next };
        }
        seen.add(next);
        current = next;
        continue;
      }

      return { statusCode: res.status, finalUrl: current === url ? null : current };
    }
    return { statusCode: -1, finalUrl: current === url ? null : current };
  };

  const head = await run("HEAD");
  // 403 included on purpose — see the note above; a bot shield refusing HEAD
  // is the single most common cause of a false "dead link".
  if (head.statusCode === 405 || head.statusCode === 501 || head.statusCode === 403) {
    return run("GET");
  }
  return head;
}

export interface ExternalPassResult {
  results: ExternalCheckResult[];
  /** Targets left unchecked because the time budget ran out (§6.3). */
  unchecked: number;
  timedOut: boolean;
}

/**
 * Checks every collected target, bounded by concurrency, per-host concurrency
 * and a hard wall-clock budget.
 *
 * `onProgress` is called as results come in and MUST be wired to the task
 * heartbeat: this pass runs after the crawl loop's own heartbeat has stopped,
 * so without it the merchant watches a frozen progress bar for up to two
 * minutes — the same trap `detectMerchantCloudflare` documents.
 */
export async function runExternalLinkPass(
  targets: ExternalTarget[],
  deps: CheckDeps & {
    budgetMs?: number;
    concurrency?: number;
    perHostConcurrency?: number;
    onProgress?: (checked: number, total: number) => void | Promise<void>;
    progressEvery?: number;
    now?: () => number;
  },
): Promise<ExternalPassResult> {
  const now = deps.now ?? Date.now;
  const deadline = now() + (deps.budgetMs ?? EXTERNAL_CHECK_BUDGET_MS);
  const concurrency = deps.concurrency ?? EXTERNAL_CONCURRENCY;
  const perHost = deps.perHostConcurrency ?? EXTERNAL_PER_HOST_CONCURRENCY;
  const progressEvery = deps.progressEvery ?? 25;

  interface Lane {
    items: ExternalTarget[];
    inFlight: number;
  }
  const lanes: Lane[] = [];
  const laneByHost = new Map<string, Lane>();
  for (const target of targets) {
    let host: string;
    try {
      host = new URL(target.url).hostname.toLowerCase();
    } catch {
      host = target.url;
    }
    let lane = laneByHost.get(host);
    if (!lane) {
      lane = { items: [], inFlight: 0 };
      laneByHost.set(host, lane);
      lanes.push(lane);
    }
    lane.items.push(target);
  }

  const results: ExternalCheckResult[] = [];
  let remaining = targets.length;
  let checked = 0;
  let timedOut = false;
  let cursor = 0;

  /** Next target from any host that still has a free slot; null when every
   *  remaining target belongs to a host already at its limit. */
  const takeNext = (): { lane: Lane; target: ExternalTarget } | null => {
    for (let i = 0; i < lanes.length; i++) {
      const index = (cursor + i) % lanes.length;
      const lane = lanes[index];
      if (lane.items.length > 0 && lane.inFlight < perHost) {
        cursor = (index + 1) % lanes.length;
        lane.inFlight += 1;
        return { lane, target: lane.items.shift() as ExternalTarget };
      }
    }
    return null;
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      if (remaining <= 0) return;
      if (now() >= deadline) {
        timedOut = true;
        return;
      }
      const next = takeNext();
      if (!next) {
        // Every remaining target's host is busy — wait rather than spin.
        await new Promise((resolve) => setTimeout(resolve, 20));
        continue;
      }
      try {
        const outcome = await checkExternalUrl(next.target.url, deps);
        results.push({
          url: next.target.url,
          statusCode: outcome.statusCode,
          finalUrl: outcome.finalUrl,
          sourceCount: next.target.count,
          sampleSources: next.target.sources.slice(0, MAX_SAMPLE_SOURCES).join("\n"),
          anchor: next.target.anchor,
        });
      } catch {
        // A throw here would kill the worker and strand its lane's slot.
        results.push({
          url: next.target.url,
          statusCode: 0,
          finalUrl: null,
          sourceCount: next.target.count,
          sampleSources: next.target.sources.slice(0, MAX_SAMPLE_SOURCES).join("\n"),
          anchor: next.target.anchor,
        });
      } finally {
        next.lane.inFlight -= 1;
        remaining -= 1;
        checked += 1;
      }
      if (deps.onProgress && checked % progressEvery === 0) {
        await deps.onProgress(checked, targets.length);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, targets.length)) }, worker));
  if (deps.onProgress) await deps.onProgress(checked, targets.length);

  // Anything the budget cut short is RECORDED as not-checked rather than
  // silently dropped: a target missing from the table is indistinguishable
  // from one that came back healthy, and "0 dead links" after checking a
  // tenth of them is the most misleading number this report could show.
  const checkedUrls = new Set(results.map((r) => r.url));
  const leftovers: ExternalCheckResult[] = [];
  for (const lane of lanes) {
    for (const target of lane.items) {
      if (checkedUrls.has(target.url)) continue;
      leftovers.push({
        url: target.url,
        statusCode: EXTERNAL_NOT_CHECKED,
        finalUrl: null,
        sourceCount: target.count,
        sampleSources: target.sources.slice(0, MAX_SAMPLE_SOURCES).join("\n"),
        anchor: target.anchor,
      });
    }
  }

  return { results: [...results, ...leftovers], unchecked: leftovers.length, timedOut };
}
