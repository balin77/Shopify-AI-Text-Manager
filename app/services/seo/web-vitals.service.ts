/**
 * Real-user web-vitals (RUM) collector — SEO tab "Performance" section,
 * Phase 2. Two halves:
 *
 *  - `recordWebVitalSample` validates + clamps an untrusted storefront beacon
 *    body (see web-vitals.types.ts's WebVitalBeaconPayload) and persists it to
 *    `SeoWebVitalSample`, pruning that shop's history to a 45-day retention
 *    window every so often.
 *  - `getWebVitalsSummary` aggregates the window into the `WebVitalsSummary`
 *    contract the SEO Performance page renders (p75 buckets by
 *    template/device, worst slow paths, most-blamed elements).
 *
 * `allowWebVitalSample` is a per-shop rate limiter for the beacon route
 * (proxy.web-vitals.tsx), mirroring `allow404Hit` in redirects.service.ts:
 * same single-process-in-memory rationale (this app currently deploys as one
 * Node process — see server.js / railway.json — so a module-level Map is
 * sufficient; a multi-instance deploy would need a shared store instead).
 *
 * `db` params are typed loosely (`any`) rather than `PrismaClient`, same as
 * pagespeed.service.ts: this file is built against a schema.prisma model
 * (SeoWebVitalSample) whose Prisma Client has not been regenerated in this
 * environment, so `PrismaClient` would not carry the `seoWebVitalSample`
 * delegate yet and the file would fail to typecheck. Once `prisma generate`
 * runs against the new schema this can be tightened back to `PrismaClient`
 * like the sibling seo/*.service.ts files.
 */

import type { WebVitalDevice, WebVitalsSummary, WebVitalsSummaryRow, WebVitalsSlowPath, WebVitalsElementIssue } from "./web-vitals.types";

// ── Beacon rate limiting (per-shop token bucket) ────────────────────────────
//
// The beacon is triggered by ordinary storefront page loads — Shopify's
// app-proxy HMAC proves the request came through the proxy, but does nothing
// to bound HOW OFTEN one shop's storefront can fire it, and every accepted
// hit costs a DB write. A busy storefront (or a misbehaving script loop)
// must not translate into unbounded DB load. A token bucket per shop caps
// sustained throughput while still allowing a normal burst of page loads.
//
// Single-process-in-memory rationale: same as allow404Hit in
// redirects.service.ts — server.js documents that this app currently deploys
// as a single Node process (railway.json: `startCommand: npm run
// start:production`, replica count dashboard-owned), so a module-level Map is
// sufficient. Multi-instance would need a shared store (e.g. Redis) since each
// replica would otherwise keep its own independent bucket per shop.
const WV_BUCKET_CAPACITY = 120; // max burst samples per shop
const WV_BUCKET_REFILL_PER_MIN = 120; // steady-state samples/min per shop
const WV_BUCKET_STALE_MS = 60 * 60 * 1000; // 1h idle -> bucket is dropped, not refilled forever

interface TokenBucket {
  tokens: number;
  lastRefillAt: number; // ms (Date.now())
}

const webVitalBuckets = new Map<string, TokenBucket>();

/** Drop buckets for shops that haven't hit the beacon in over an hour — bounds Map growth across all shops ever seen. */
function purgeStaleWebVitalBuckets(now: number): void {
  for (const [shop, bucket] of webVitalBuckets) {
    if (now - bucket.lastRefillAt > WV_BUCKET_STALE_MS) webVitalBuckets.delete(shop);
  }
}

/**
 * In-memory per-shop rate limiter (mirror allow404Hit): max 120 samples/min
 * per shop, refilling continuously. Never throws — a limiter failure must
 * never take the beacon route down, so it fails open (allows the sample)
 * rather than risk dropping legitimate traffic over an internal bug.
 */
export function allowWebVitalSample(shop: string): boolean {
  try {
    const now = Date.now();
    purgeStaleWebVitalBuckets(now);

    let bucket = webVitalBuckets.get(shop);
    if (!bucket) {
      bucket = { tokens: WV_BUCKET_CAPACITY, lastRefillAt: now };
      webVitalBuckets.set(shop, bucket);
    } else {
      const elapsedMs = Math.max(0, now - bucket.lastRefillAt);
      const refill = (elapsedMs / 60_000) * WV_BUCKET_REFILL_PER_MIN;
      bucket.tokens = Math.min(WV_BUCKET_CAPACITY, bucket.tokens + refill);
      bucket.lastRefillAt = now;
    }

    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  } catch {
    return true;
  }
}

// ── Recording ────────────────────────────────────────────────────────────────

const PATH_MAX_LENGTH = 512;
const TEMPLATE_MAX_LENGTH = 64;
const ELEMENT_MAX_LENGTH = 120;
const MS_CEILING = 120_000; // lcp/inp/fcp/ttfb sanity ceiling
const CLS_CEILING = 10; // cls sanity ceiling

/** Retention window enforced by the probabilistic-but-deterministic prune below. */
const RETENTION_DAYS = 45;
/** Prune every Nth write per shop (plus the very first write) instead of on every insert. */
const PRUNE_EVERY_N_WRITES = 50;

// Per-shop write counters used to decide when to run the retention prune.
// Module-level (single-process) like the rate-limit buckets above — a
// counter reset on redeploy just means the shop's next write re-triggers the
// "first write" prune, which is harmless.
const writeCounters = new Map<string, number>();

function bumpWriteCounter(shop: string): number {
  const next = (writeCounters.get(shop) ?? 0) + 1;
  writeCounters.set(shop, next);
  return next;
}

function stripQueryAndHash(raw: string): string {
  const queryIdx = raw.indexOf("?");
  const hashIdx = raw.indexOf("#");
  let end = raw.length;
  if (queryIdx >= 0) end = Math.min(end, queryIdx);
  if (hashIdx >= 0) end = Math.min(end, hashIdx);
  return raw.slice(0, end);
}

function clampMs(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.round(Math.min(value, MS_CEILING));
}

function clampCls(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  const clamped = Math.min(value, CLS_CEILING);
  return Math.round(clamped * 10_000) / 10_000;
}

function normalizeElement(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  return value.slice(0, ELEMENT_MAX_LENGTH);
}

interface NormalizedSample {
  path: string;
  template: string;
  device: WebVitalDevice;
  lcpMs: number | null;
  cls: number | null;
  inpMs: number | null;
  fcpMs: number | null;
  ttfbMs: number | null;
  lcpElement: string | null;
  clsElement: string | null;
  inpElement: string | null;
}

/**
 * Validate + normalize an untrusted beacon body. Returns null when the
 * payload is unusable — missing/malformed path or template, or a payload
 * where every metric was missing/invalid (nothing worth storing).
 */
function normalizeBeaconPayload(payload: unknown): NormalizedSample | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;

  const rawPath = p.path;
  if (typeof rawPath !== "string" || rawPath.length === 0 || !rawPath.startsWith("/")) return null;

  const rawTemplate = p.template;
  if (typeof rawTemplate !== "string" || rawTemplate.length === 0) return null;

  const path = stripQueryAndHash(rawPath).slice(0, PATH_MAX_LENGTH);
  if (!path) return null;
  const template = rawTemplate.slice(0, TEMPLATE_MAX_LENGTH);
  const device: WebVitalDevice = p.device === "desktop" ? "desktop" : "mobile";

  const metricsRaw =
    p.metrics && typeof p.metrics === "object" ? (p.metrics as Record<string, unknown>) : {};
  const lcpMs = clampMs(metricsRaw.lcpMs);
  const inpMs = clampMs(metricsRaw.inpMs);
  const fcpMs = clampMs(metricsRaw.fcpMs);
  const ttfbMs = clampMs(metricsRaw.ttfbMs);
  const cls = clampCls(metricsRaw.cls);

  if (lcpMs === null && inpMs === null && fcpMs === null && ttfbMs === null && cls === null) {
    return null;
  }

  const elementsRaw =
    p.elements && typeof p.elements === "object" ? (p.elements as Record<string, unknown>) : {};

  return {
    path,
    template,
    device,
    lcpMs,
    cls,
    inpMs,
    fcpMs,
    ttfbMs,
    lcpElement: normalizeElement(elementsRaw.lcp),
    clsElement: normalizeElement(elementsRaw.cls),
    inpElement: normalizeElement(elementsRaw.inp),
  };
}

async function pruneWebVitalRetention(db: any, shop: string): Promise<void> {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  await db.seoWebVitalSample.deleteMany({ where: { shop, createdAt: { lt: cutoff } } });
}

export interface RecordWebVitalSampleOptions {
  db: any; // Prisma client (see file header re: loose typing)
  shop: string;
  payload: unknown;
}

/**
 * Validate + clamp an untrusted beacon body and persist it. Returns false
 * (and writes nothing) when the payload is unusable. Never throws — DB work
 * is guarded so a transient failure degrades to a dropped sample instead of
 * an unhandled rejection on the beacon route (which also guards itself).
 */
export async function recordWebVitalSample(opts: RecordWebVitalSampleOptions): Promise<boolean> {
  const { db, shop, payload } = opts;

  const normalized = normalizeBeaconPayload(payload);
  if (!normalized) return false;

  try {
    await db.seoWebVitalSample.create({ data: { shop, ...normalized } });
  } catch {
    return false;
  }

  // Prune retention probabilistically-but-deterministically: on the first
  // write after process start, then every 50th write per shop thereafter —
  // avoids a DELETE query on every single beacon hit while still bounding
  // table growth. Best-effort: a prune failure must not undo the sample that
  // was just successfully persisted above, so it's isolated in its own
  // try/catch rather than the one guarding the insert.
  const writeCount = bumpWriteCounter(shop);
  if (writeCount === 1 || writeCount % PRUNE_EVERY_N_WRITES === 0) {
    try {
      await pruneWebVitalRetention(db, shop);
    } catch {
      // Swallow — retention pruning is maintenance, not part of the sample's
      // success contract.
    }
  }

  return true;
}

// ── Aggregation ──────────────────────────────────────────────────────────────

const SUMMARY_ROW_CAP = 20_000;
const DEFAULT_WINDOW_DAYS = 28;
const MAX_SLOW_PATHS = 10;
const MIN_SLOW_PATH_SAMPLES = 5;
const MAX_ELEMENT_ISSUES = 10;

interface SummaryRawRow {
  path: string;
  template: string;
  device: string;
  lcpMs: number | null;
  cls: number | null;
  inpMs: number | null;
  lcpElement: string | null;
  clsElement: string | null;
  inpElement: string | null;
}

/** p75 over ascending-sorted values: index ceil(0.75 * n) - 1. Null for an empty set. */
function p75(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil(0.75 * sorted.length) - 1;
  return sorted[idx];
}

function buildSummaryRows(rows: SummaryRawRow[]): WebVitalsSummaryRow[] {
  interface Bucket {
    template: string;
    device: WebVitalDevice;
    samples: number;
    lcp: number[];
    cls: number[];
    inp: number[];
  }
  const buckets = new Map<string, Bucket>();

  for (const r of rows) {
    const device: WebVitalDevice = r.device === "desktop" ? "desktop" : "mobile";
    const key = `${r.template} ${device}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { template: r.template, device, samples: 0, lcp: [], cls: [], inp: [] };
      buckets.set(key, bucket);
    }
    bucket.samples += 1;
    if (typeof r.lcpMs === "number") bucket.lcp.push(r.lcpMs);
    if (typeof r.cls === "number") bucket.cls.push(r.cls);
    if (typeof r.inpMs === "number") bucket.inp.push(r.inpMs);
  }

  return Array.from(buckets.values())
    .map((b) => ({
      template: b.template,
      device: b.device,
      samples: b.samples,
      lcpP75Ms: p75(b.lcp),
      clsP75: p75(b.cls),
      inpP75Ms: p75(b.inp),
    }))
    .sort((a, b) => b.samples - a.samples);
}

function buildSlowPaths(rows: SummaryRawRow[]): WebVitalsSlowPath[] {
  const byPath = new Map<string, number[]>();
  for (const r of rows) {
    if (typeof r.lcpMs !== "number") continue;
    const arr = byPath.get(r.path);
    if (arr) arr.push(r.lcpMs);
    else byPath.set(r.path, [r.lcpMs]);
  }

  const out: WebVitalsSlowPath[] = [];
  for (const [path, values] of byPath) {
    if (values.length < MIN_SLOW_PATH_SAMPLES) continue;
    const lcpP75Ms = p75(values);
    if (lcpP75Ms === null) continue;
    out.push({ path, samples: values.length, lcpP75Ms });
  }

  out.sort((a, b) => b.lcpP75Ms - a.lcpP75Ms);
  return out.slice(0, MAX_SLOW_PATHS);
}

function buildElementIssues(rows: SummaryRawRow[]): WebVitalsElementIssue[] {
  const counts = new Map<string, WebVitalsElementIssue>();

  const bump = (kind: WebVitalsElementIssue["kind"], label: string | null) => {
    if (!label) return;
    const key = `${kind} ${label}`;
    const existing = counts.get(key);
    if (existing) existing.occurrences += 1;
    else counts.set(key, { kind, label, occurrences: 1 });
  };

  for (const r of rows) {
    bump("lcp", r.lcpElement);
    bump("cls", r.clsElement);
    bump("inp", r.inpElement);
  }

  return Array.from(counts.values())
    .sort((a, b) => b.occurrences - a.occurrences)
    .slice(0, MAX_ELEMENT_ISSUES);
}

export interface GetWebVitalsSummaryOptions {
  db: any; // Prisma client (see file header re: loose typing)
  shop: string;
  days?: number; // default 28
}

/** Aggregate the last `days` (default 28) into the summary contract. */
export async function getWebVitalsSummary(opts: GetWebVitalsSummaryOptions): Promise<WebVitalsSummary> {
  const { db, shop, days = DEFAULT_WINDOW_DAYS } = opts;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const rows: SummaryRawRow[] = await db.seoWebVitalSample.findMany({
    where: { shop, createdAt: { gte: since } },
    orderBy: { createdAt: "desc" },
    take: SUMMARY_ROW_CAP,
    select: {
      path: true,
      template: true,
      device: true,
      lcpMs: true,
      cls: true,
      inpMs: true,
      lcpElement: true,
      clsElement: true,
      inpElement: true,
    },
  });

  return {
    windowDays: days,
    totalSamples: rows.length,
    rows: buildSummaryRows(rows),
    slowPaths: buildSlowPaths(rows),
    elements: buildElementIssues(rows),
  };
}
