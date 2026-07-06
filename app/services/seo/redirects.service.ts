/**
 * Redirects & 404 tracking service (SEO_TAB_IMPLEMENTATION_PLAN.md Phase 3 / A4).
 *
 * Two halves:
 *  - Native URL redirects via Shopify's `urlRedirect*` Admin API (live, small,
 *    paginated — no catalog sweep). Requires `write_online_store_navigation`.
 *  - A self-hosted 404 collector (`Seo404Hit`) fed by the storefront app-embed
 *    beacon, because Shopify exposes no 404 logs via API. Loosely inspired by
 *    the DirectTranslationCandidate upsert-increment pattern, but pruning is
 *    lowest-count-then-oldest (not pure FIFO) — see record404Hit.
 *
 * `validateRedirect` and `record404Hit` are pure / DB-only so they are unit
 * tested without a live Admin API.
 */

import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import {
  GET_URL_REDIRECTS,
} from "../../graphql/content.queries";
import {
  URL_REDIRECT_CREATE,
  URL_REDIRECT_UPDATE,
  URL_REDIRECT_DELETE,
} from "../../graphql/content.mutations";

/** Max distinct 404 rows kept per shop (lowest-count, then oldest, pruned). */
export const MAX_404_HITS_PER_SHOP = 1000;

export interface RedirectInput {
  path: string;
  target: string;
}

export interface UrlRedirect {
  id: string;
  path: string;
  target: string;
}

/**
 * Pure validation for a redirect pair. Returns an i18n error CODE
 * (t.seo.redirectsPage.errors.*) or null when valid. Codes, never strings, so
 * the same check is reusable server- and client-side.
 */
export function validateRedirect({ path, target }: RedirectInput): string | null {
  const p = (path ?? "").trim();
  const t = (target ?? "").trim();

  if (!p || p === "/") return "pathRequired";
  if (!p.startsWith("/")) return "pathLeadingSlash";
  if (!t) return "targetRequired";
  // A redirect to itself is a loop Shopify would also reject.
  if (p === t) return "loop";
  return null;
}

/**
 * Normalize a storefront path for hashing/storage (strip origin, trim,
 * lower-host-less). The query string is dropped ENTIRELY (not just tracking
 * params such as utm_ / fbclid / gclid) — 404 dedup is purely path-based, and
 * every hit naturally carries a distinct query string (random cache-busters,
 * referral params, ...) that would otherwise fragment one broken path into
 * unbounded rows. The path itself stays case-preserved (unlike hosts, paths
 * can be case-sensitive on some storefronts).
 */
export function normalize404Path(raw: string): string {
  let path = (raw ?? "").trim();
  if (!path) return "";
  // Strip an accidental absolute URL down to just the path.
  try {
    if (/^https?:\/\//i.test(path)) {
      const u = new URL(path);
      path = u.pathname;
    }
  } catch {
    /* keep the raw value */
  }
  // Relative input (no scheme) may still carry "?...": drop it too.
  const queryIdx = path.indexOf("?");
  if (queryIdx >= 0) path = path.slice(0, queryIdx);
  if (!path.startsWith("/")) path = "/" + path;
  // Collapse trailing slash (except root) so "/x" and "/x/" are one row.
  if (path.length > 1 && path.endsWith("/")) path = path.replace(/\/+$/, "");
  return path.slice(0, 2000);
}

function pathHash(normalizedPath: string): string {
  return createHash("sha256").update(normalizedPath).digest("hex");
}

export interface Hit404 {
  id: string;
  path: string;
  referrer: string | null;
  count: number;
  status: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

/**
 * Record a storefront 404. Upsert-increments the (shop, pathHash) row and, for
 * newly-created rows, prunes the shop down to MAX_404_HITS_PER_SHOP by
 * evicting the lowest-count / oldest-lastSeen rows first. Returns false for
 * empty input.
 */
export async function record404Hit(
  db: PrismaClient,
  shop: string,
  input: { path: string; referrer?: string | null },
): Promise<boolean> {
  const path = normalize404Path(input.path);
  if (!path) return false;
  const hash = pathHash(path);
  const referrer = input.referrer ? String(input.referrer).slice(0, 2000) : null;

  const row = await db.seo404Hit.upsert({
    where: { shop_pathHash: { shop, pathHash: hash } },
    // A dismissed/redirected path that recurs advances count/lastSeen but keeps
    // its status (so the merchant's decision isn't silently undone).
    create: { shop, path, pathHash: hash, referrer },
    // A follow-up hit with no referrer (e.g. direct navigation / referrer
    // stripped by the browser) must not clobber a referrer recorded earlier —
    // only overwrite it when this hit actually carried one.
    update: {
      count: { increment: 1 },
      lastSeenAt: new Date(),
      ...(referrer !== null ? { referrer } : {}),
    },
    select: { count: true },
  });

  // Only run the prune check for a brand-new row (count === 1). Existing rows
  // just increment in place — they never grow the table — so checking the
  // shop's total on every single hit is wasted work on the hot beacon path.
  if (row.count === 1) {
    const total = await db.seo404Hit.count({ where: { shop } });
    if (total > MAX_404_HITS_PER_SHOP) {
      const stale = await db.seo404Hit.findMany({
        where: { shop },
        // Evict the least-significant rows first: lowest hit count, then
        // oldest lastSeenAt as a tiebreaker — so one-off flood noise dies
        // before a path merchants are actually still hitting repeatedly.
        orderBy: [{ count: "asc" }, { lastSeenAt: "asc" }],
        take: total - MAX_404_HITS_PER_SHOP,
        select: { id: true },
      });
      if (stale.length) {
        await db.seo404Hit.deleteMany({ where: { id: { in: stale.map((s) => s.id) } } });
      }
    }
  }
  return true;
}

/** List 404 hits for the admin panel (most frequent first), optionally by status. */
export async function list404Hits(
  db: PrismaClient,
  shop: string,
  opts: { status?: string; limit?: number } = {},
): Promise<Hit404[]> {
  const rows = await db.seo404Hit.findMany({
    where: { shop, ...(opts.status ? { status: opts.status } : {}) },
    orderBy: [{ count: "desc" }, { lastSeenAt: "desc" }],
    take: opts.limit ?? 100,
    select: {
      id: true,
      path: true,
      referrer: true,
      count: true,
      status: true,
      firstSeenAt: true,
      lastSeenAt: true,
    },
  });
  return rows;
}

/** Flip a 404 hit's status ("dismissed" | "redirected") — scoped to the shop. */
export async function set404Status(
  db: PrismaClient,
  shop: string,
  id: string,
  status: "new" | "dismissed" | "redirected",
): Promise<void> {
  await db.seo404Hit.updateMany({ where: { id, shop }, data: { status } });
}

export interface Analyze404Result {
  newCount: number;
  topPaths: Array<{ path: string; count: number }>;
}

/** Lightweight 404 summary for the section header / dashboard hook. */
export async function analyze404(db: PrismaClient, shop: string): Promise<Analyze404Result> {
  const [newCount, top] = await Promise.all([
    db.seo404Hit.count({ where: { shop, status: "new" } }),
    db.seo404Hit.findMany({
      where: { shop, status: "new" },
      orderBy: [{ count: "desc" }, { lastSeenAt: "desc" }],
      take: 5,
      select: { path: true, count: true },
    }),
  ]);
  return { newCount, topPaths: top };
}

// ── 404-beacon rate limiting (per-shop token bucket) ─────────────────────────
//
// The beacon (proxy.seo-404.tsx) is triggered by ordinary storefront visitors
// hitting a 404 page — Shopify's app-proxy HMAC proves the request came
// through the proxy, but it does nothing to bound HOW OFTEN one shop's
// storefront can fire it, and every hit costs 2-3 DB queries (record404Hit).
// A bot crawling a scraped list of dead links, or a themed page looping the
// beacon, must not translate into unbounded DB load. A simple token bucket
// per shop caps sustained throughput while still allowing a normal burst
// (e.g. a merchant testing several broken links in a row).
//
// Single-process-in-memory rationale: same as the OAuth nonce store in
// google-search-console.server.ts — server.js documents that this app
// currently deploys as a single Node process (Procfile:
// `web: npm run start:production`; no replica/scale config), so a
// module-level Map is sufficient. Multi-instance would need a shared store
// (e.g. Redis) since each replica would otherwise keep its own independent
// bucket per shop.
const BUCKET_CAPACITY = 30; // max burst tokens per shop
const BUCKET_REFILL_PER_MIN = 10; // steady-state tokens/min per shop
const BUCKET_STALE_MS = 60 * 60 * 1000; // 1h idle -> bucket is dropped, not refilled forever

interface TokenBucket {
  tokens: number;
  lastRefillAt: number; // ms (from the injectable clock)
}

const hitBuckets = new Map<string, TokenBucket>();

/** Drop buckets for shops that haven't hit the beacon in over an hour — bounds Map growth across all shops ever seen. */
function purgeStaleBuckets(now: number): void {
  for (const [shop, bucket] of hitBuckets) {
    if (now - bucket.lastRefillAt > BUCKET_STALE_MS) hitBuckets.delete(shop);
  }
}

/**
 * Token-bucket rate limit for the 404 beacon, keyed per shop. Returns true
 * (and consumes one token) when the hit is allowed, false when the shop's
 * bucket is drained. `now` is injectable so tests can fast-forward refills
 * deterministically instead of sleeping on the wall clock.
 */
export function allow404Hit(shop: string, now: number = Date.now()): boolean {
  purgeStaleBuckets(now);

  let bucket = hitBuckets.get(shop);
  if (!bucket) {
    bucket = { tokens: BUCKET_CAPACITY, lastRefillAt: now };
    hitBuckets.set(shop, bucket);
  } else {
    const elapsedMs = Math.max(0, now - bucket.lastRefillAt);
    const refill = (elapsedMs / 60_000) * BUCKET_REFILL_PER_MIN;
    bucket.tokens = Math.min(BUCKET_CAPACITY, bucket.tokens + refill);
    bucket.lastRefillAt = now;
  }

  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

// ── Native Shopify redirects (Admin API) ─────────────────────────────────────

export interface ListRedirectsResult {
  redirects: UrlRedirect[];
  hasNextPage: boolean;
  endCursor: string | null;
}

export async function listRedirects(
  admin: AdminApiContext,
  opts: { first?: number; after?: string | null; query?: string | null } = {},
): Promise<ListRedirectsResult> {
  const response = await admin.graphql(GET_URL_REDIRECTS, {
    variables: {
      first: Math.min(opts.first ?? 50, 250),
      after: opts.after ?? null,
      query: opts.query?.trim() ? opts.query.trim() : null,
    },
  });
  const body = await response.json();
  const conn = body?.data?.urlRedirects;
  const redirects: UrlRedirect[] =
    conn?.edges?.map((e: { node: UrlRedirect }) => e.node) ?? [];
  return {
    redirects,
    hasNextPage: !!conn?.pageInfo?.hasNextPage,
    endCursor: conn?.pageInfo?.endCursor ?? null,
  };
}

export interface RedirectMutationResult {
  redirect: UrlRedirect | null;
  userErrors: Array<{ field?: string[] | null; message: string }>;
}

export async function createRedirect(
  admin: AdminApiContext,
  input: RedirectInput,
): Promise<RedirectMutationResult> {
  const response = await admin.graphql(URL_REDIRECT_CREATE, {
    variables: { urlRedirect: { path: input.path.trim(), target: input.target.trim() } },
  });
  const body = await response.json();
  const payload = body?.data?.urlRedirectCreate;
  return { redirect: payload?.urlRedirect ?? null, userErrors: payload?.userErrors ?? [] };
}

export async function updateRedirect(
  admin: AdminApiContext,
  id: string,
  input: RedirectInput,
): Promise<RedirectMutationResult> {
  const response = await admin.graphql(URL_REDIRECT_UPDATE, {
    variables: { id, urlRedirect: { path: input.path.trim(), target: input.target.trim() } },
  });
  const body = await response.json();
  const payload = body?.data?.urlRedirectUpdate;
  return { redirect: payload?.urlRedirect ?? null, userErrors: payload?.userErrors ?? [] };
}

export async function deleteRedirect(
  admin: AdminApiContext,
  id: string,
): Promise<{ deletedId: string | null; userErrors: Array<{ message: string }> }> {
  const response = await admin.graphql(URL_REDIRECT_DELETE, { variables: { id } });
  const body = await response.json();
  const payload = body?.data?.urlRedirectDelete;
  return {
    deletedId: payload?.deletedUrlRedirectId ?? null,
    userErrors: payload?.userErrors ?? [],
  };
}
