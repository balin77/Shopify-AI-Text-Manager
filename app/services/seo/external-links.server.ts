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
 * without a network — see `external-links.shared.ts`, which is also what the
 * report component imports (this module reaches for `node:dns`).
 */

import { isPrivateOrLoopbackHost } from "../../utils/private-host";
import {
  MAX_EXTERNAL_TARGETS,
  MAX_SAMPLE_SOURCES,
  EXTERNAL_NOT_CHECKED,
  type ExternalTarget,
  type ExternalCheckResult,
} from "./external-links.shared";

// Re-exported so callers need only one import; the definitions live in the
// client-safe module.
export {
  MAX_EXTERNAL_TARGETS,
  MAX_SAMPLE_SOURCES,
  EXTERNAL_NOT_CHECKED,
  isExternalLinkBroken,
  isExternalLinkBlocked,
} from "./external-links.shared";
export type { ExternalTarget, ExternalCheckResult } from "./external-links.shared";

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

interface CheckDeps {
  fetchImpl?: typeof fetch;
  userAgent: string;
  timeoutMs?: number;
  /** Injectable resolver (tests). Defaults to `dns.promises.lookup`. */
  lookupImpl?: (hostname: string) => Promise<string[]>;
  /** Shared across one pass so a host is resolved once, not once per link. */
  resolvedHostCache?: Map<string, boolean>;
}

/** Budget for the pre-fetch DNS check. A name that cannot be resolved this
 *  fast would not have been fetchable either. */
const DNS_LOOKUP_TIMEOUT_MS = 2_000;

/**
 * True when `hostname` is safe to fetch — LEXICALLY and by RESOLUTION.
 *
 * `isPrivateOrLoopbackHost` can only judge literals, so a plain NAME pointing
 * inside the network walks straight past it. That is not hypothetical here:
 * this app deploys on Railway, where `*.railway.internal` names resolve to
 * private addresses, and an external link is by definition attacker-influenced
 * — anyone who can get an `<a href>` into the storefront (the merchant, but
 * also a reviews/UGC app) would otherwise have a blind SSRF oracle whose
 * results this feature helpfully persists and exports as CSV.
 *
 * Fails CLOSED: an unresolvable or slow name is refused. That costs nothing —
 * the fetch would have failed too — and keeps a resolver hiccup from becoming
 * a hole. DNS rebinding (a name that resolves differently between this check
 * and the fetch) is explicitly out of scope; closing it needs connection-level
 * control this runtime does not offer.
 */
async function isPublicHost(hostname: string, deps: CheckDeps): Promise<boolean> {
  if (isPrivateOrLoopbackHost(hostname)) return false;
  const cache = deps.resolvedHostCache;
  const cached = cache?.get(hostname);
  if (cached !== undefined) return cached;

  const lookup =
    deps.lookupImpl ??
    (async (host: string) => {
      const { promises } = await import("node:dns");
      const records = await promises.lookup(host, { all: true });
      return records.map((r) => r.address);
    });

  let ok: boolean;
  try {
    const addresses = await Promise.race([
      lookup(hostname),
      new Promise<string[]>((_, reject) =>
        setTimeout(() => reject(new Error("dns_timeout")), DNS_LOOKUP_TIMEOUT_MS),
      ),
    ]);
    ok = addresses.length > 0 && addresses.every((address) => !isPrivateOrLoopbackHost(address));
  } catch {
    ok = false;
  }
  cache?.set(hostname, ok);
  return ok;
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

  const isFetchable = async (candidate: string): Promise<boolean> => {
    let u: URL;
    try {
      u = new URL(candidate);
    } catch {
      return false;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    return isPublicHost(u.hostname, deps);
  };

  const run = async (method: "HEAD" | "GET"): Promise<{ statusCode: number; finalUrl: string | null }> => {
    let current = url;
    const seen = new Set<string>([url]);
    for (let hop = 0; hop <= EXTERNAL_MAX_HOPS; hop++) {
      // Every hop, not just the first: an external link may point anywhere,
      // and a cooperative host can redirect the checker inward.
      if (!(await isFetchable(current))) {
        return { statusCode: 0, finalUrl: current === url ? null : current };
      }
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

      // Nothing below reads the body (HEAD has none, and the GET only asks for
      // one byte — `Range` is advisory, so hosts that ignore it stream a full
      // page). Undici holds the socket until the body is consumed or cancelled,
      // and a pass can make 2000 of these.
      void res.body?.cancel().catch(() => {});

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
  // One DNS answer per host for the whole pass, not one per link.
  const resolvedHostCache = deps.resolvedHostCache ?? new Map<string, boolean>();
  const checkDeps: CheckDeps = { ...deps, resolvedHostCache };
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
        const outcome = await checkExternalUrl(next.target.url, checkDeps);
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
