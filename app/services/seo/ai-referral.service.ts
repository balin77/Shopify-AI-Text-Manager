/**
 * AI referral tracking — "did anyone actually arrive from an AI answer?"
 *
 * The AEO section can say whether crawlers may read the shop, whether the
 * discovery files are ours and whether the product data is complete. It could
 * not say whether any of it produced a visit. This closes that loop with the
 * cheapest honest measurement available: the storefront beacon classifies the
 * referrer against a list of AI assistants and reports the resulting SOURCE —
 * never the referrer itself.
 *
 * What this deliberately is NOT: prompt-level visibility monitoring (does the
 * brand appear when someone asks ChatGPT for a recommendation). That needs
 * paid, recurring model runs and is a separate product decision. What we
 * measure is arrivals, which is a fact rather than a sample.
 *
 * Two limits are stated in the UI rather than hidden:
 *  - Google AI Overviews sends the ordinary `google.com` referrer, so an AI
 *    Overview visit is indistinguishable from a classic search visit and is NOT
 *    counted here. Reporting it as zero would be a lie of omission; the UI says
 *    so.
 *  - A visitor whose browser strips the referrer (and whose URL carries no
 *    `utm_source`) cannot be classified at all. Undercounting is the designed
 *    failure mode — never guessing.
 *
 * Privacy: aggregate only, no cookie, no identifier, no IP, no raw referrer.
 * See the SeoAiReferral model comment.
 */

import { createHash } from "crypto";
import type { PrismaClient } from "@prisma/client";

/** Known AI assistants, mapped from referrer host / `utm_source` to a stable key. */
const SOURCE_BY_HOST: Array<{ key: string; test: RegExp }> = [
  // ChatGPT also appends `?utm_source=chatgpt.com` to links it hands out,
  // which is why the utm value is matched against the same table.
  { key: "chatgpt", test: /(^|\.)chatgpt\.com$|(^|\.)chat\.openai\.com$|(^|\.)openai\.com$/ },
  { key: "perplexity", test: /(^|\.)perplexity\.ai$/ },
  { key: "claude", test: /(^|\.)claude\.ai$/ },
  { key: "gemini", test: /(^|\.)gemini\.google\.com$|(^|\.)bard\.google\.com$/ },
  { key: "copilot", test: /(^|\.)copilot\.microsoft\.com$/ },
  { key: "grok", test: /(^|\.)grok\.com$|(^|\.)x\.ai$/ },
  { key: "deepseek", test: /(^|\.)deepseek\.com$/ },
  { key: "you", test: /(^|\.)you\.com$/ },
  { key: "poe", test: /(^|\.)poe\.com$/ },
  { key: "mistral", test: /(^|\.)chat\.mistral\.ai$|(^|\.)lechat\.mistral\.ai$/ },
];

/** Stable list for the UI, so a report can show a zero row for a known source. */
export const AI_REFERRAL_SOURCES = SOURCE_BY_HOST.map((s) => s.key);

function hostOf(raw: string): string {
  const value = (raw || "").trim();
  if (!value) return "";
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    // A bare host ("chatgpt.com") is what `utm_source` carries.
    return value.toLowerCase().replace(/^\/+/, "").split("/")[0];
  }
}

/**
 * Classify a referrer (and/or a `utm_source` value) into an AI source key, or
 * null when it is not an AI assistant. Pure.
 *
 * The referrer DECIDES whenever there is one: `utm_source` is copyable and
 * survives being shared onwards, so a ChatGPT link someone pasted into a
 * newsletter would otherwise report every click from that newsletter as a
 * ChatGPT visit — forever. The parameter is only consulted when the browser
 * sent no referrer at all, which is exactly the case it exists for.
 */
export function classifyAiReferral(
  referrer: string | null | undefined,
  utmSource?: string | null,
): string | null {
  const referrerHost = hostOf(referrer || "");
  if (referrerHost) {
    return SOURCE_BY_HOST.find((s) => s.test.test(referrerHost))?.key ?? null;
  }
  const utmHost = hostOf(utmSource || "");
  if (!utmHost) return null;
  return SOURCE_BY_HOST.find((s) => s.test.test(utmHost))?.key ?? null;
}

/**
 * Normalize a landing path for storage: strip origin and query, collapse the
 * trailing slash. Same rule as the 404 collector — a landing URL carries the
 * `utm_source` that got it classified, and keeping it would fragment one page
 * into a row per visitor.
 */
export function normalizeReferralPath(raw: string): string {
  let path = (raw ?? "").trim();
  if (!path) return "";
  try {
    if (/^https?:\/\//i.test(path)) path = new URL(path).pathname;
  } catch {
    /* keep the raw value */
  }
  const queryIdx = path.indexOf("?");
  if (queryIdx >= 0) path = path.slice(0, queryIdx);
  const hashIdx = path.indexOf("#");
  if (hashIdx >= 0) path = path.slice(0, hashIdx);
  if (!path.startsWith("/")) path = "/" + path;
  if (path.length > 1 && path.endsWith("/")) path = path.replace(/\/+$/, "");
  return path.slice(0, 2000);
}

/** UTC midnight of `at` — the day bucket rows are keyed by. */
export function referralDay(at: Date = new Date()): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

function pathHash(normalizedPath: string): string {
  return createHash("sha256").update(normalizedPath).digest("hex");
}

/** Rows kept per shop. Oldest days are evicted first when the cap is passed. */
export const MAX_REFERRAL_ROWS_PER_SHOP = 5000;

/** Days of history the report reads and the pruner keeps. */
export const REFERRAL_RETENTION_DAYS = 180;

/**
 * Record one classified AI visit. Returns false when the input was unusable —
 * never throws, the caller is a storefront beacon.
 */
export async function recordAiReferral(
  db: PrismaClient,
  shop: string,
  input: { source: string; path: string },
  now: Date = new Date(),
): Promise<boolean> {
  const source = (input.source || "").trim().slice(0, 40);
  if (!source || !AI_REFERRAL_SOURCES.includes(source)) return false;
  const path = normalizeReferralPath(input.path);
  if (!path) return false;

  const day = referralDay(now);
  const row = await db.seoAiReferral.upsert({
    where: {
      shop_source_day_pathHash: { shop, source, day, pathHash: pathHash(path) },
    },
    create: { shop, source, day, path, pathHash: pathHash(path) },
    update: { count: { increment: 1 }, lastSeenAt: now },
    select: { count: true },
  });

  // Only on a brand-new row: existing rows increment in place and never grow
  // the table, so counting the shop's rows on every hit would be wasted work on
  // the beacon path (the same rule the 404 collector follows).
  if (row.count === 1) await pruneReferrals(db, shop, now);
  return true;
}

/** Drop rows outside the retention window, then enforce the per-shop row cap. */
async function pruneReferrals(db: PrismaClient, shop: string, now: Date): Promise<void> {
  const cutoff = referralDay(new Date(now.getTime() - REFERRAL_RETENTION_DAYS * 86_400_000));
  await db.seoAiReferral.deleteMany({ where: { shop, day: { lt: cutoff } } }).catch(() => {});

  const total = await db.seoAiReferral.count({ where: { shop } });
  if (total <= MAX_REFERRAL_ROWS_PER_SHOP) return;
  const stale = await db.seoAiReferral.findMany({
    where: { shop },
    // Oldest day first, then the least-visited path — a one-off page dies
    // before a landing page that keeps receiving traffic.
    orderBy: [{ day: "asc" }, { count: "asc" }],
    take: total - MAX_REFERRAL_ROWS_PER_SHOP,
    select: { id: true },
  });
  if (stale.length > 0) {
    await db.seoAiReferral
      .deleteMany({ where: { id: { in: stale.map((r) => r.id) } } })
      .catch(() => {});
  }
}

export interface AiReferralSourceStat {
  source: string;
  visits: number;
}

export interface AiReferralPageStat {
  path: string;
  visits: number;
}

export interface AiReferralSummary {
  /** Window the numbers cover. */
  days: number;
  totalVisits: number;
  /** Per source, busiest first. Sources with no visit are omitted. */
  bySource: AiReferralSourceStat[];
  /** Busiest landing pages across all sources, capped. */
  topPages: AiReferralPageStat[];
  /** True once anything was ever recorded — separates "no visits in the window"
   *  from "the beacon has never reported anything", which usually means the app
   *  embed is not enabled. */
  everRecorded: boolean;
}

export const TOP_REFERRAL_PAGES = 10;

export async function loadAiReferralSummary(
  db: PrismaClient,
  shop: string,
  days = 30,
  now: Date = new Date(),
): Promise<AiReferralSummary> {
  const since = referralDay(new Date(now.getTime() - (days - 1) * 86_400_000));

  const [bySourceRaw, byPathRaw, everCount] = await Promise.all([
    db.seoAiReferral.groupBy({
      by: ["source"],
      where: { shop, day: { gte: since } },
      _sum: { count: true },
    }),
    db.seoAiReferral.groupBy({
      by: ["path"],
      where: { shop, day: { gte: since } },
      _sum: { count: true },
      orderBy: { _sum: { count: "desc" } },
      take: TOP_REFERRAL_PAGES,
    }),
    db.seoAiReferral.count({ where: { shop } }),
  ]);

  const bySource = bySourceRaw
    .map((r) => ({ source: r.source, visits: r._sum.count ?? 0 }))
    .sort((a, b) => b.visits - a.visits);

  return {
    days,
    totalVisits: bySource.reduce((sum, r) => sum + r.visits, 0),
    bySource,
    topPages: byPathRaw.map((r) => ({ path: r.path, visits: r._sum.count ?? 0 })),
    everRecorded: everCount > 0,
  };
}

// ── Beacon rate limit ────────────────────────────────────────────────────────
//
// Its own bucket rather than the 404 collector's: the two beacons have very
// different natural rates, and sharing one budget would let a 404 flood
// silence referral collection (and vice versa) for reasons neither report
// could explain.

const BUCKET_CAPACITY = 120;
const BUCKET_REFILL_PER_MIN = 60;
const BUCKET_STALE_MS = 60 * 60 * 1000;

interface TokenBucket {
  tokens: number;
  lastRefillAt: number;
}

const buckets = new Map<string, TokenBucket>();

/**
 * Token-bucket rate limit for the referral beacon, keyed per shop. `now` is
 * injectable so tests can fast-forward refills instead of sleeping.
 */
export function allowReferralHit(shop: string, now: number = Date.now()): boolean {
  for (const [key, bucket] of buckets) {
    if (now - bucket.lastRefillAt > BUCKET_STALE_MS) buckets.delete(key);
  }

  let bucket = buckets.get(shop);
  if (!bucket) {
    bucket = { tokens: BUCKET_CAPACITY, lastRefillAt: now };
    buckets.set(shop, bucket);
  } else {
    const elapsedMs = Math.max(0, now - bucket.lastRefillAt);
    bucket.tokens = Math.min(
      BUCKET_CAPACITY,
      bucket.tokens + (elapsedMs / 60_000) * BUCKET_REFILL_PER_MIN,
    );
    bucket.lastRefillAt = now;
  }

  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

/** Test seam — drops all buckets. */
export function resetReferralRateLimit(): void {
  buckets.clear();
}
