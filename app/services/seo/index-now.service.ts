/**
 * IndexNow / instant indexing (SEO section `indexNow`, Pro+).
 *
 * Pings IndexNow (Bing + partner AI crawlers) with changed/all storefront URLs
 * so they re-crawl fast. The IndexNow `key` is a PUBLIC token by design — it is
 * served at `keyLocation` for verification — so it is stored in plaintext.
 *
 * ── Key file hosting: MEASURED — the app proxy alone is NOT enough ──────────
 * Shopify blocks arbitrary root files, so the key is served via an **app
 * proxy** on the shop host (`/apps/contentpilot/indexnow-key`): Shopify
 * HMAC-signs the forwarded request, so the unauthenticated IndexNow fetch
 * reaches our route and returns the key. That half demonstrably works — the
 * IndexNow probe (Settings → Translation Probe, api.indexnow-probe.tsx)
 * fetched it on a live shop: HTTP 200, no redirect, content matches the key.
 *
 * The SUBMISSION is still rejected. Measured 2026-08-15 on a live shop whose
 * host matched the primary domain in every field:
 *
 *   POST /indexnow → 422 InvalidRequestParameters
 *   "One or more URLs are not related to your site verified through the
 *    keylocation parameter."
 *
 * A non-root `keyLocation` therefore verifies only its OWN sub-path: with the
 * key under `/apps/contentpilot/…`, a `/products/…` URL counts as unrelated.
 * That is a SCOPE rule, not a host rule — do not re-diagnose it as a domain
 * problem (the host bug was real, separate, and is already fixed), and do not
 * expect a different status code to appear. The key has to be reachable at the
 * ROOT of the storefront domain; on Shopify the remaining lever is a URL
 * redirect from `/<key>.txt`, and the probe verifies the whole chain end to end
 * once one exists.
 *
 * ── Host: the PRIMARY domain, never *.myshopify.com ─────────────────────────
 * `host`, every entry of `urlList` and `keyLocation` share the shop's primary
 * domain. Using the myshopify host (what this service did originally) meant
 * every submitted URL 301s to the primary domain and — worse — the ownership
 * fetch of `keyLocation` follows that redirect onto a DIFFERENT host than the
 * declared `host`, which is precisely what IndexNow's host check is about. The
 * resolved host is persisted on the config row (`SeoIndexNowConfig.host`) so
 * webhooks can build URLs from the row they already loaded, and
 * `syncIndexNowHost` refreshes it whenever the section is opened — a merchant
 * who adds a custom domain later is corrected without minting a new key.
 *
 * Bulk submit is synchronous (one POST per ≤10k-URL chunk): the Max plan caps
 * at 2500 products + 500 collections + 300 articles + 200 pages, so a full
 * catalog is always a single chunk and no background task is needed. If the
 * caps ever exceed that, move submitAll into a Task (section contract §8).
 *
 * Pure helpers (key gen, submit body, chunking, URL building, status
 * classification) are unit-tested.
 */

import { createHash, randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { logger } from "../../utils/logger.server";

const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";
/** App-proxy path that serves the key file (see proxy.indexnow-key.tsx). */
export const KEY_PROXY_PATH = "/apps/contentpilot/indexnow-key";
/** IndexNow accepts at most 10,000 URLs per request. */
export const INDEXNOW_MAX_URLS_PER_REQUEST = 10000;
/** Cap on how many storefront URLs a single bulk submit gathers per type. */
export const URL_COLLECT_CAP = 5000;
/** The submit fetch must not hang a webhook/route forever. */
const FETCH_TIMEOUT_MS = 10_000;

/**
 * How long a full-catalog submit blocks the next one. IndexNow explicitly asks
 * callers not to resubmit unchanged URLs, and answers 429 when they do — the
 * button is one click and the catalog does not change between two of them.
 * Incremental drains are NOT affected (that's what the queue is for).
 */
export const SUBMIT_ALL_COOLDOWN_MS = Math.max(
  0,
  parseInt(process.env.INDEXNOW_SUBMIT_ALL_COOLDOWN_MS || String(60 * 60 * 1000), 10),
);

/** Queued URLs older than this are dropped instead of retried forever. Default 7 days. */
const QUEUE_TTL_MS = parseInt(
  process.env.INDEXNOW_QUEUE_TTL_MS || String(7 * 24 * 60 * 60 * 1000),
  10,
);

/**
 * Upper bound on one drain, so a shop whose submissions are being rejected
 * cannot turn every sweep tick into an unbounded read. Two full chunks: the
 * remainder is picked up by the next tick, oldest first.
 */
const MAX_URLS_PER_DRAIN = INDEXNOW_MAX_URLS_PER_REQUEST * 2;

/** Don't rewrite `hostCheckedAt` more often than this when nothing changed. */
const HOST_STAMP_MIN_AGE_MS = 60 * 60 * 1000;

export type IndexNowResourceType = "product" | "collection" | "page" | "article";

export function generateIndexNowKey(): string {
  // 32 hex chars — within IndexNow's 8–128 hex-char requirement.
  return randomBytes(16).toString("hex");
}

function normalizeHost(host: string): string {
  return host.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

export function keyLocationFor(host: string): string {
  return `https://${normalizeHost(host)}${KEY_PROXY_PATH}`;
}

export function homepageUrl(host: string): string {
  return `https://${normalizeHost(host)}/`;
}

/**
 * Storefront URL for the three "flat" types. Articles need their blog's handle
 * and go through `articleUrl` instead.
 */
export function storefrontUrl(
  host: string,
  type: Exclude<IndexNowResourceType, "article">,
  handle: string,
): string {
  const base = `https://${normalizeHost(host)}`;
  switch (type) {
    case "product":
      return `${base}/products/${handle}`;
    case "collection":
      return `${base}/collections/${handle}`;
    case "page":
      return `${base}/pages/${handle}`;
  }
}

/** `/blogs/<blogHandle>/<articleHandle>` — the blog handle is NOT cached (no Blog model). */
export function articleUrl(host: string, blogHandle: string, articleHandle: string): string {
  return `https://${normalizeHost(host)}/blogs/${blogHandle}/${articleHandle}`;
}

/**
 * Is this product change worth telling a search engine about?
 *
 * A URL is only worth submitting if it is live NOW, or if it WAS live the last
 * time we saw it — in which case it just turned into a 404 and reporting
 * removals is half of what IndexNow is for.
 *
 * current UNLISTED → never. Live, but served `noindex,nofollow` and absent
 *                    from sitemap.xml: the merchant deliberately kept it out of
 *                    search, so asking an engine to crawl it would publish a
 *                    link they chose not to publish.
 * current ACTIVE   → yes, re-crawl it.
 * otherwise        → only if `previous` was ACTIVE. A product CREATED as a
 *                    draft was never reachable, so its URL is a 404 that no
 *                    engine ever knew about; submitting it would be noise.
 *
 * `previous` is the cached status from BEFORE the sync overwrote it (and, on
 * delete, the last state we hold). The BULK path stays ACTIVE-only: "submit my
 * catalog" is about the indexable catalog, not a sweep of dead handles.
 */
export function shouldEnqueueProductChange(
  previous: string | null | undefined,
  current: string | null | undefined,
): boolean {
  if (current === "UNLISTED") return false;
  if (current === "ACTIVE") return true;
  return previous === "ACTIVE";
}

export interface IndexNowSubmitBody {
  host: string;
  key: string;
  keyLocation: string;
  urlList: string[];
}

export function buildSubmitBody(
  host: string,
  key: string,
  keyLocation: string,
  urls: string[],
): IndexNowSubmitBody {
  return { host: normalizeHost(host), key, keyLocation, urlList: urls };
}

/** Split into IndexNow-sized batches. Generic so the queue can chunk ROWS, not just URLs. */
export function chunkUrls<T>(items: T[], size = INDEXNOW_MAX_URLS_PER_REQUEST): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function urlHash(url: string): string {
  return createHash("sha256").update(url).digest("hex");
}

/**
 * IndexNow's diagnostics live entirely in the status code — collapsing them
 * into "failed" leaves a merchant with a number and no cause. Kept as a pure
 * mapping so the UI can show a specific reason and the log a specific label.
 */
export type SubmitStatusKind =
  | "ok"
  | "badRequest"
  | "keyInvalid"
  | "hostMismatch"
  | "rateLimited"
  | "serverError"
  | "networkError"
  | "unknown";

export function describeSubmitStatus(status: number | null): SubmitStatusKind {
  if (status === null) return "networkError";
  if (status === 200 || status === 202) return "ok";
  if (status === 400) return "badRequest";
  if (status === 403) return "keyInvalid";
  if (status === 422) return "hostMismatch";
  if (status === 429) return "rateLimited";
  if (status >= 500) return "serverError";
  return "unknown";
}

// ── Config ───────────────────────────────────────────────────────────────────

export async function getIndexNowConfig(db: PrismaClient, shop: string) {
  return db.seoIndexNowConfig.findUnique({ where: { shop } });
}

export type IndexNowConfig = Awaited<ReturnType<typeof getIndexNowConfig>>;

/**
 * Load the config and return it only when IndexNow is enabled, otherwise
 * `null`. Lets a caller (e.g. a webhook) do a *single* query that both gates
 * ("is IndexNow on for this shop") and feeds `enqueueResource`.
 */
export async function getEnabledConfig(db: PrismaClient, shop: string): Promise<IndexNowConfig | null> {
  const config = await getIndexNowConfig(db, shop);
  return config?.enabled ? config : null;
}

/**
 * Enable IndexNow for a shop: create the key on first use, and re-enable an
 * existing (disabled) config WITHOUT minting a new key — the key is the shop's
 * identity towards the search engines, so toggling the feature must not change
 * it. `host` is the resolved primary domain (see the header).
 */
export async function provisionIndexNow(
  db: PrismaClient,
  shop: string,
  host: string,
  /**
   * Whether `host` is a RESOLVED primary domain rather than the myshopify
   * fallback. When false the host is only used to seed a brand-new row and
   * `hostCheckedAt` stays null, so an existing (correct) host is never
   * overwritten and the sweep re-resolves it.
   */
  hostVerified = true,
): Promise<{ key: string; keyLocation: string; host: string }> {
  const resolvedHost = normalizeHost(host);
  const existing = await getIndexNowConfig(db, shop);
  if (existing) {
    const updated = await db.seoIndexNowConfig.update({
      where: { shop },
      data: hostVerified
        ? {
            enabled: true,
            host: resolvedHost,
            keyLocation: keyLocationFor(resolvedHost),
            hostCheckedAt: new Date(),
          }
        : { enabled: true },
    });
    return { key: updated.key, keyLocation: updated.keyLocation, host: updated.host };
  }
  const key = generateIndexNowKey();
  const keyLocation = keyLocationFor(resolvedHost);
  await db.seoIndexNowConfig.create({
    data: {
      shop,
      key,
      keyLocation,
      host: resolvedHost,
      hostCheckedAt: hostVerified ? new Date() : null,
    },
  });
  return { key, keyLocation, host: resolvedHost };
}

/**
 * Turn IndexNow off without destroying the key.
 *
 * Deleting the config (what "disable" used to do) meant re-enabling minted a
 * NEW key, i.e. the shop silently changed its IndexNow identity on every
 * toggle, and the `enabled` column that every gate reads was dead weight. The
 * pending queue IS dropped on disable: those URLs describe changes that will be
 * stale by the time someone re-enables, and re-enabling should not fire off a
 * burst of ancient notifications.
 */
export async function setIndexNowEnabled(
  db: PrismaClient,
  shop: string,
  enabled: boolean,
): Promise<void> {
  await db.seoIndexNowConfig.updateMany({ where: { shop }, data: { enabled } });
  if (!enabled) await db.seoIndexNowQueue.deleteMany({ where: { shop } });
}

/**
 * Keep `host`/`keyLocation` in sync with the shop's current primary domain.
 * Called from the section's loader and from the background sweep, so a domain
 * change is picked up without the merchant doing anything — key untouched.
 *
 * `host` must be a domain that was actually RESOLVED. Never pass a fallback:
 * persisting the myshopify host on a transient Admin API failure would undo a
 * correct primary domain (that is why `resolvePrimaryDomain` returns null).
 *
 * Queued URLs are absolute and were built on the OLD host, so a host change
 * drops them: submitting them under the new declared host is a 422 for the
 * whole chunk, and because a failed chunk is kept for retry that one stale row
 * would wedge the queue permanently — taking every correct URL in its chunk
 * with it. The resources themselves are re-enqueued on their next change, and
 * "submit all URLs" covers the catalog immediately.
 */
export async function syncIndexNowHost(
  db: PrismaClient,
  shop: string,
  host: string,
  now: Date = new Date(),
): Promise<IndexNowConfig> {
  const resolvedHost = normalizeHost(host);
  const config = await getIndexNowConfig(db, shop);
  if (!config) return null;

  if (config.host === resolvedHost && config.keyLocation === keyLocationFor(resolvedHost)) {
    // Same host — only record that we verified it, so the sweep can back off.
    // Throttled: the loader calls this on every visit to the section, and a
    // write per page view for a timestamp nobody reads at that resolution is
    // pure noise.
    const age = config.hostCheckedAt ? now.getTime() - config.hostCheckedAt.getTime() : Infinity;
    if (age >= HOST_STAMP_MIN_AGE_MS) {
      return db.seoIndexNowConfig.update({ where: { shop }, data: { hostCheckedAt: now } });
    }
    return config;
  }

  logger.info(`[IndexNow] Host changed for ${shop}: ${config.host} → ${resolvedHost}`);
  const [updated, dropped] = await Promise.all([
    db.seoIndexNowConfig.update({
      where: { shop },
      data: {
        host: resolvedHost,
        keyLocation: keyLocationFor(resolvedHost),
        hostCheckedAt: now,
      },
    }),
    db.seoIndexNowQueue.deleteMany({ where: { shop } }),
  ]);
  if (dropped.count > 0) {
    logger.info(`[IndexNow] Dropped ${dropped.count} queued URL(s) on the previous host for ${shop}`);
  }
  return updated;
}

// ── Submit ───────────────────────────────────────────────────────────────────

export interface SubmitChunkResult {
  count: number;
  ok: boolean;
  /** null = the request never produced a response (network error / timeout). */
  status: number | null;
  kind: SubmitStatusKind;
}

export interface SubmitResult {
  submitted: number;
  chunks: number;
  failed: number;
  /** One entry per chunk, in submit order — drainQueue zips these back onto its rows. */
  results: SubmitChunkResult[];
}

/** The first non-ok chunk kind, for a single-reason UI message. */
export function firstFailureKind(result: SubmitResult): SubmitStatusKind | null {
  return result.results.find((r) => !r.ok)?.kind ?? null;
}

async function submitChunk(
  host: string,
  key: string,
  keyLocation: string,
  urls: string[],
): Promise<SubmitChunkResult> {
  try {
    const res = await fetch(INDEXNOW_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(buildSubmitBody(host, key, keyLocation, urls)),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    // IndexNow: 200 OK / 202 Accepted both mean success.
    return { count: urls.length, ok: res.ok, status: res.status, kind: describeSubmitStatus(res.status) };
  } catch {
    return { count: urls.length, ok: false, status: null, kind: "networkError" };
  }
}

export async function submitUrls(
  host: string,
  key: string,
  keyLocation: string,
  urls: string[],
): Promise<SubmitResult> {
  const chunks = chunkUrls(urls).filter((c) => c.length > 0);
  const results: SubmitChunkResult[] = [];
  let submitted = 0;
  let failed = 0;
  for (const chunk of chunks) {
    const result = await submitChunk(host, key, keyLocation, chunk);
    results.push(result);
    if (result.ok) submitted += result.count;
    else failed += result.count;
  }
  if (failed > 0) {
    logger.warn(`[IndexNow] ${failed}/${submitted + failed} URL(s) rejected for ${host}`, {
      statuses: results.filter((r) => !r.ok).map((r) => ({ status: r.status, kind: r.kind })),
    });
  }
  return { submitted, chunks: chunks.length, failed, results };
}

// ── Incremental queue (fed by webhooks, drained by the sweep / on demand) ─────

async function upsertQueueUrl(db: PrismaClient, shop: string, url: string): Promise<void> {
  const hash = urlHash(url);
  await db.seoIndexNowQueue.upsert({
    where: { shop_urlHash: { shop, urlHash: hash } },
    create: { shop, url, urlHash: hash },
    update: {},
  });
}

/** Enqueue a changed URL — no-op unless IndexNow is configured + enabled. */
export async function enqueueIndexNowUrl(db: PrismaClient, shop: string, url: string): Promise<void> {
  const config = await getEnabledConfig(db, shop);
  if (!config) return;
  await upsertQueueUrl(db, shop, url);
}

/**
 * Convenience used by webhooks: build the URL from the config's host and
 * enqueue it (best-effort).
 *
 * `config` is optional: pass the row already loaded via `getEnabledConfig` to
 * skip a redundant lookup (the common webhook path). When omitted, the config
 * is loaded here. Either way the URL is built on the config's `host` — the
 * primary domain — never on the shop's myshopify domain.
 */
export async function enqueueResource(
  db: PrismaClient,
  shop: string,
  type: Exclude<IndexNowResourceType, "article">,
  handle: string,
  config?: IndexNowConfig | null,
): Promise<void> {
  if (!handle) return;
  const row = config === undefined ? await getEnabledConfig(db, shop) : config;
  if (!row) return;
  await upsertQueueUrl(db, shop, storefrontUrl(row.host, type, handle));
}

export async function getQueueCount(db: PrismaClient, shop: string): Promise<number> {
  return db.seoIndexNowQueue.count({ where: { shop } });
}

export type DrainOutcome =
  | { status: "submitted"; result: SubmitResult }
  | { status: "disabled" }
  | { status: "empty" };

/**
 * Submit everything in the queue, then clear the rows whose chunk succeeded.
 *
 * Per-CHUNK bookkeeping, not all-or-nothing: a partially failed drain used to
 * keep every row, so the URLs that DID reach IndexNow were submitted again on
 * the next run. Rows of a failed chunk survive and are retried.
 */
export async function drainQueue(
  db: PrismaClient,
  shop: string,
  now: Date = new Date(),
): Promise<DrainOutcome> {
  const config = await getEnabledConfig(db, shop);
  if (!config) return { status: "disabled" };

  // A URL that could not be submitted for QUEUE_TTL_MS describes a change
  // nobody is waiting for any more. Without this, a shop whose key is rejected
  // (403) accumulates every change forever AND resubmits the whole pile on
  // every sweep. The cause is what the IndexNow probe in Settings surfaces;
  // this only bounds the damage while it goes unfixed.
  const expired = await db.seoIndexNowQueue.deleteMany({
    where: { shop, createdAt: { lt: new Date(now.getTime() - QUEUE_TTL_MS) } },
  });
  if (expired.count > 0) {
    logger.warn(`[IndexNow] Dropped ${expired.count} queued URL(s) older than the retry window for ${shop}`);
  }

  const rows = await db.seoIndexNowQueue.findMany({
    where: { shop },
    select: { id: true, url: true },
    orderBy: { createdAt: "asc" }, // oldest first, so a capped drain makes progress
    take: MAX_URLS_PER_DRAIN,
  });
  if (rows.length === 0) return { status: "empty" };

  const rowChunks = chunkUrls(rows);
  const results: SubmitChunkResult[] = [];
  const submittedIds: string[] = [];
  let submitted = 0;
  let failed = 0;

  for (const chunk of rowChunks) {
    const result = await submitChunk(config.host, config.key, config.keyLocation, chunk.map((r) => r.url));
    results.push(result);
    if (result.ok) {
      submitted += result.count;
      submittedIds.push(...chunk.map((r) => r.id));
    } else {
      failed += result.count;
    }
  }

  if (submittedIds.length > 0) {
    await db.seoIndexNowQueue.deleteMany({ where: { id: { in: submittedIds } } });
    await db.seoIndexNowConfig.updateMany({ where: { shop }, data: { lastSubmittedAt: new Date() } });
  }
  if (failed > 0) {
    logger.warn(`[IndexNow] Drain for ${shop}: ${submitted} submitted, ${failed} kept for retry`, {
      statuses: results.filter((r) => !r.ok).map((r) => ({ status: r.status, kind: r.kind })),
    });
  }
  return { status: "submitted", result: { submitted, chunks: rowChunks.length, failed, results } };
}

// ── Bulk: submit the whole catalog ───────────────────────────────────────────

export interface CollectOptions {
  /**
   * Blog GID → blog handle. Blogs have NO DB cache (only `Article.blogId` /
   * `blogTitle`), and an article URL needs the blog's real handle — slugifying
   * the title would guess. Articles are skipped entirely when the caller could
   * not resolve the map, rather than submitting URLs that might 404.
   */
  blogHandles?: Map<string, string>;
  /**
   * Page GIDs that are NOT published to the online store, resolved live by the
   * caller (the DB cache has no publish flag). Those URLs are 404s — the same
   * reason products are filtered to ACTIVE.
   */
  unpublishedPageIds?: Set<string>;
}

/** Collect storefront URLs from the DB cache (homepage, products/collections/pages/articles). */
export async function collectStoreUrls(
  db: PrismaClient,
  shop: string,
  host: string,
  options: CollectOptions = {},
): Promise<string[]> {
  const [products, collections, pages, articles] = await Promise.all([
    // ACTIVE only, and this one must stay that way: IndexNow actively ASKS a
    // search engine to crawl each URL. Unlisted product pages are served
    // `noindex,nofollow` and are absent from sitemap.xml (measured — see
    // sitemap.service.ts's header), so submitting them would push URLs the
    // merchant chose to keep unlisted and that the engine is being told not to
    // index — pointless at best, quota-wasting and spam-shaped at worst.
    db.product.findMany({
      where: { shop, status: "ACTIVE" },
      select: { handle: true },
      take: URL_COLLECT_CAP,
    }),
    // Collections carry no publish state in the cache and Shopify has no
    // unambiguous "published to the online store" field we can read without
    // guessing a publication id — so they go out unfiltered. A collection that
    // is not published 404s; that costs one wasted URL, whereas a wrong
    // publication filter would DROP valid ones. Deliberate asymmetry with
    // pages, where `isPublished` is unambiguous.
    db.collection.findMany({ where: { shop }, select: { handle: true }, take: URL_COLLECT_CAP }),
    db.page.findMany({ where: { shop }, select: { id: true, handle: true }, take: URL_COLLECT_CAP }),
    options.blogHandles?.size
      ? db.article.findMany({
          where: { shop },
          select: { handle: true, blogId: true },
          take: URL_COLLECT_CAP,
        })
      : Promise.resolve([] as Array<{ handle: string; blogId: string }>),
  ]);

  const urls: string[] = [homepageUrl(host)];
  for (const p of products) if (p.handle) urls.push(storefrontUrl(host, "product", p.handle));
  for (const c of collections) if (c.handle) urls.push(storefrontUrl(host, "collection", c.handle));
  for (const pg of pages) {
    if (!pg.handle) continue;
    if (options.unpublishedPageIds?.has(pg.id)) continue;
    urls.push(storefrontUrl(host, "page", pg.handle));
  }
  for (const a of articles) {
    const blogHandle = options.blogHandles?.get(a.blogId);
    if (a.handle && blogHandle) urls.push(articleUrl(host, blogHandle, a.handle));
  }
  return urls;
}

/**
 * No "empty" case: the homepage is always part of the list, so a full submit
 * always has something to send even on a brand-new shop.
 */
export type SubmitAllOutcome =
  | { status: "submitted"; result: SubmitResult }
  | { status: "disabled" }
  | { status: "cooldown"; retryAfterMs: number };

/**
 * Cheap pre-check with the same rules `submitAll` enforces. The route calls it
 * BEFORE the paginated blog/page lookups so a cooldown-blocked click doesn't
 * pay for up to 40 GraphQL round-trips whose result is then thrown away.
 */
export async function canSubmitAll(
  db: PrismaClient,
  shop: string,
  now: Date = new Date(),
): Promise<{ status: "ok" } | { status: "disabled" } | { status: "cooldown"; retryAfterMs: number }> {
  const config = await getEnabledConfig(db, shop);
  if (!config) return { status: "disabled" };
  if (config.lastFullSubmitAt && SUBMIT_ALL_COOLDOWN_MS > 0) {
    const elapsed = now.getTime() - config.lastFullSubmitAt.getTime();
    if (elapsed < SUBMIT_ALL_COOLDOWN_MS) {
      return { status: "cooldown", retryAfterMs: SUBMIT_ALL_COOLDOWN_MS - elapsed };
    }
  }
  return { status: "ok" };
}

export async function submitAll(
  db: PrismaClient,
  shop: string,
  options: CollectOptions & { now?: Date } = {},
): Promise<SubmitAllOutcome> {
  const now = options.now ?? new Date();
  const allowed = await canSubmitAll(db, shop, now);
  if (allowed.status !== "ok") return allowed;

  // Re-read: canSubmitAll already proved it exists and is enabled.
  const config = (await getEnabledConfig(db, shop))!;
  const urls = await collectStoreUrls(db, shop, config.host, options);
  const result = await submitUrls(config.host, config.key, config.keyLocation, urls);

  if (result.submitted > 0) {
    // `lastFullSubmitAt` drives the cooldown, so it may only be stamped when the
    // catalog ACTUALLY went out in full. Stamping it after a partial failure
    // would lock the merchant out for an hour from the retry they need.
    const data: { lastSubmittedAt: Date; lastFullSubmitAt?: Date } = { lastSubmittedAt: now };
    if (result.failed === 0) data.lastFullSubmitAt = now;
    await db.seoIndexNowConfig.updateMany({ where: { shop }, data });
  }
  return { status: "submitted", result };
}
