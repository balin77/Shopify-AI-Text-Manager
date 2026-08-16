/**
 * Redirect chains (PLAN_SEO_CRAWL_EXPANSION §4).
 *
 * A chain is `A → B` where `B` is itself the source of `B → C`: every visitor
 * (and Googlebot) pays two round-trips and the link equity is passed through
 * one more hop than it needs to be.
 *
 * The whole thing is computable from Shopify's OWN redirect list — `listRedirects`
 * already loads it for the redirects section — so this needs not a single HTTP
 * request and no crawl. That is also the point where this app beats a desktop
 * crawler: Screaming Frog can only REPORT the chain, while `updateRedirect`
 * sits right next to this module and repoints the first hop straight at the
 * final target.
 *
 * Pure and client-safe on purpose (no `.server` suffix, no Prisma, no Admin
 * API): the route loader computes the chains, the component renders them, and
 * the rules are unit-tested without a live shop.
 */

import type { UrlRedirect } from "./redirects.service";

/** Beyond this a chain is, for every practical purpose, a loop — and Google
 *  gives up long before. Also the guard that keeps a cyclic list from spinning. */
export const MAX_CHAIN_HOPS = 10;

export interface RedirectChain {
  /** The full chain including its end: `["/old", "/middle", "/new"]`. */
  hops: string[];
  /** True when the chain bites its own tail instead of ending somewhere. */
  isLoop: boolean;
  /** GID of the FIRST redirect — the one that gets repointed by the fix. */
  firstRedirectId: string;
  /** The resolved end of the chain; null on a loop (there is nothing to point at). */
  finalTarget: string | null;
}

/**
 * Shopify matches redirect paths case-insensitively, so the lookup key must be
 * lowercased — otherwise `/Alt → /b` and `/b → /c` are never recognised as one
 * chain. The DISPLAYED hops keep their original casing; only the map key is
 * normalized. A trailing slash is collapsed for the same reason (except on the
 * root), matching `normalize404Path`.
 */
export function normalizeRedirectPath(raw: string): string {
  let p = (raw ?? "").trim().toLowerCase();
  if (!p) return "";
  if (p.length > 1 && p.endsWith("/")) p = p.replace(/\/+$/, "");
  return p;
}

/**
 * Reduce a redirect TARGET to the path a chain can continue from, or null when
 * it leaves the shop.
 *
 * Shopify stores `path` as a leading-slash path without a host, but `target`
 * may be an ABSOLUTE URL. An absolute target on the shop's own primary host is
 * still an internal hop and must be followed (a merchant who typed the full URL
 * built the same chain as one who typed the path); a foreign host ENDS the
 * chain — we neither know nor control what happens over there.
 *
 * `primaryHost` is optional: without it, absolute targets simply end the chain,
 * which is the safe direction (a missed chain, never a wrong fix).
 */
export function targetToInternalPath(target: string, primaryHost?: string | null): string | null {
  const raw = (target ?? "").trim();
  if (!raw) return null;
  if (raw.startsWith("/")) return raw;
  if (!/^https?:\/\//i.test(raw)) return null; // mailto:, tel:, relative junk — not a hop
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const primary = (primaryHost ?? "").toLowerCase();
  if (!primary || host !== primary) return null;
  // The query/fragment are part of the target and must survive: a chain fix
  // that dropped `?variant=…` would change where the visitor lands.
  return `${u.pathname}${u.search}${u.hash}`;
}

/**
 * Every redirect chain in `redirects`.
 *
 * Only chains are returned — two redirects pointing at the SAME target
 * (`A → B`, `C → B`) are perfectly normal and produce nothing. Each chain is
 * reported once, from its head: a middle link of a chain already reported is
 * not a second finding, it is the same defect seen from further down.
 */
export function findRedirectChains(
  redirects: UrlRedirect[],
  primaryHost?: string | null,
): RedirectChain[] {
  const byPath = new Map<string, UrlRedirect>();
  for (const r of redirects) {
    const key = normalizeRedirectPath(r.path);
    // First writer wins: Shopify enforces path uniqueness, so a duplicate here
    // can only come from a case/slash variant — either resolves to the same
    // redirect for a visitor.
    if (key && !byPath.has(key)) byPath.set(key, r);
  }

  /** Normalized paths that already appeared as a non-head hop of a chain. */
  const coveredAsInnerHop = new Set<string>();
  const chains: RedirectChain[] = [];
  /** Cycles already reported, keyed by their sorted member set. */
  const reportedCycles = new Set<string>();
  /** Heads of closed cycles — exempt from the sub-chain filter below. */
  const cycleHeads = new Set<string>();

  for (const start of redirects) {
    const startKey = normalizeRedirectPath(start.path);
    if (!startKey) continue;

    const hops: string[] = [start.path];
    const seen = new Set<string>([startKey]);
    /** Non-head hops of THIS walk, folded into `coveredAsInnerHop` on success. */
    const innerKeys: string[] = [];
    let current: UrlRedirect = start;
    let isLoop = false;
    /** The walk ended by pointing back at its OWN head — a closed cycle. */
    let closedOnHead = false;
    let finalTarget: string | null = null;

    for (let hop = 0; ; hop++) {
      const nextPath = targetToInternalPath(current.target, primaryHost);
      if (nextPath === null) {
        // Leaves the shop (or isn't a path at all) — the chain ends here.
        finalTarget = current.target;
        hops.push(current.target);
        break;
      }
      const nextKey = normalizeRedirectPath(nextPath);
      if (seen.has(nextKey)) {
        // Back into the chain: a loop has no end a fix could point at.
        isLoop = true;
        closedOnHead = nextKey === startKey;
        hops.push(nextPath);
        break;
      }
      const nextRedirect = byPath.get(nextKey);
      if (!nextRedirect) {
        // The target is a real page, not another redirect — chain ends.
        finalTarget = nextPath;
        hops.push(nextPath);
        break;
      }
      if (hop >= MAX_CHAIN_HOPS) {
        // Practically a loop: nothing sane redirects ten times, and Google has
        // long stopped following. Treated as one so no auto-fix is offered.
        isLoop = true;
        hops.push(nextPath);
        break;
      }
      seen.add(nextKey);
      innerKeys.push(nextKey);
      hops.push(nextPath);
      current = nextRedirect;
    }

    // `hops` holds start + every following hop; 2 entries is a plain redirect.
    if (hops.length < 3) continue;

    if (isLoop && !closedOnHead && hops.length <= MAX_CHAIN_HOPS + 1) {
      // This walk RAN INTO a cycle it isn't part of (`/x → /a → /b → /a`).
      // Every member of that cycle is itself a redirect source, so the cycle is
      // always also reached by a walk that closes on its own head — reporting
      // this one too would list the same defect once per entry point.
      continue;
    }
    if (closedOnHead) {
      // One entry per CYCLE, not per member: `/a → /b → /a` is discovered
      // again walking from `/b`, and it is the same loop.
      const cycleKey = Array.from(seen).sort().join(">");
      if (reportedCycles.has(cycleKey)) continue;
      reportedCycles.add(cycleKey);
      cycleHeads.add(startKey);
    } else {
      // Loop walks deliberately contribute nothing here: in a cycle EVERY
      // member is an inner hop of some other member's walk, so folding them in
      // would suppress all of them and the loop would vanish from the report.
      for (const key of innerKeys) coveredAsInnerHop.add(key);
    }

    chains.push({
      hops,
      isLoop,
      firstRedirectId: start.id,
      finalTarget: isLoop ? null : finalTarget,
    });
  }

  // Drop the sub-chains: walking from the middle of `A → B → C` rediscovers
  // `B → C`… which is the same defect, and "fixing" it would leave A untouched.
  // Done after the full sweep because the head is not necessarily visited first.
  // Closed cycles are exempt — every member is an inner hop of another member.
  return chains.filter((c) => {
    const head = normalizeRedirectPath(c.hops[0]);
    return cycleHeads.has(head) || !coveredAsInnerHop.has(head);
  });
}
