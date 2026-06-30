/**
 * IndexNow / instant indexing (SEO_TAB_IMPLEMENTATION_PLAN.md Phase 8 / Anhang D2).
 *
 * Pings IndexNow (Bing + partner AI crawlers) with changed/all storefront URLs
 * so they re-crawl fast. The IndexNow `key` is a PUBLIC token by design — it is
 * served at `keyLocation` for verification — so it is stored in plaintext.
 *
 * Key file hosting: Shopify blocks arbitrary root files, so instead of the
 * Files+redirect dance we serve the key via an **app proxy** on the shop host
 * (`/apps/contentpilot/indexnow-key`) — Shopify HMAC-signs the forwarded request,
 * so the unauthenticated IndexNow fetch reaches our route and returns the key.
 *
 * Bulk submit is synchronous (one POST per ≤10k-URL chunk): the app's own plan
 * caps keep a store's total URL count well under 10k, so no background task is
 * needed. If catalogs ever exceed that, move drainQueue/submitAll into a Task.
 *
 * Host: everything (submit host, urlList, keyLocation) uses the myshopify host
 * so they share a host as IndexNow requires. Caveat: for a store on a custom
 * primary domain the submitted myshopify URLs 301 to the canonical domain —
 * Bing/IndexNow follow the redirect, so this works, but a future enhancement
 * could resolve the primary domain and submit canonical URLs instead.
 *
 * Pure helpers (key gen, submit body, chunking, URL building) are unit-tested.
 */

import { createHash, randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";
/** App-proxy path that serves the key file (see proxy.indexnow-key.tsx). */
export const KEY_PROXY_PATH = "/apps/contentpilot/indexnow-key";
/** IndexNow accepts at most 10,000 URLs per request. */
export const INDEXNOW_MAX_URLS_PER_REQUEST = 10000;
/** Cap on how many storefront URLs a single bulk submit gathers per type. */
export const URL_COLLECT_CAP = 5000;

export type IndexNowResourceType = "product" | "collection" | "page";

export function generateIndexNowKey(): string {
  // 32 hex chars — within IndexNow's 8–128 hex-char requirement.
  return randomBytes(16).toString("hex");
}

export function keyLocationFor(shop: string): string {
  return `https://${shop}${KEY_PROXY_PATH}`;
}

export function storefrontUrl(host: string, type: IndexNowResourceType, handle: string): string {
  const base = `https://${host.replace(/\/+$/, "")}`;
  switch (type) {
    case "product":
      return `${base}/products/${handle}`;
    case "collection":
      return `${base}/collections/${handle}`;
    case "page":
      return `${base}/pages/${handle}`;
  }
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
  return { host, key, keyLocation, urlList: urls };
}

export function chunkUrls(urls: string[], size = INDEXNOW_MAX_URLS_PER_REQUEST): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < urls.length; i += size) out.push(urls.slice(i, i + size));
  return out;
}

function urlHash(url: string): string {
  return createHash("sha256").update(url).digest("hex");
}

// ── Config ───────────────────────────────────────────────────────────────────

export async function getIndexNowConfig(db: PrismaClient, shop: string) {
  return db.seoIndexNowConfig.findUnique({ where: { shop } });
}

/**
 * Cheap PK-indexed check used by webhooks to short-circuit BEFORE the (otherwise
 * wasted) handle lookup for the vast majority of shops that never enabled
 * IndexNow. Selects a single column on the shop-PK row.
 */
export async function isIndexNowEnabled(db: PrismaClient, shop: string): Promise<boolean> {
  const config = await db.seoIndexNowConfig.findUnique({
    where: { shop },
    select: { enabled: true },
  });
  return !!config?.enabled;
}

export async function provisionIndexNow(
  db: PrismaClient,
  shop: string,
): Promise<{ key: string; keyLocation: string }> {
  const existing = await getIndexNowConfig(db, shop);
  if (existing) return { key: existing.key, keyLocation: existing.keyLocation };
  const key = generateIndexNowKey();
  const keyLocation = keyLocationFor(shop);
  await db.seoIndexNowConfig.create({ data: { shop, key, keyLocation } });
  return { key, keyLocation };
}

export async function deprovisionIndexNow(db: PrismaClient, shop: string): Promise<void> {
  await db.seoIndexNowConfig.deleteMany({ where: { shop } });
  await db.seoIndexNowQueue.deleteMany({ where: { shop } });
}

// ── Submit ───────────────────────────────────────────────────────────────────

export interface SubmitResult {
  submitted: number;
  chunks: number;
  failed: number;
}

export async function submitUrls(
  host: string,
  key: string,
  keyLocation: string,
  urls: string[],
): Promise<SubmitResult> {
  const chunks = chunkUrls(urls);
  let submitted = 0;
  let failed = 0;
  for (const chunk of chunks) {
    if (chunk.length === 0) continue;
    try {
      const res = await fetch(INDEXNOW_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify(buildSubmitBody(host, key, keyLocation, chunk)),
      });
      // IndexNow: 200 OK / 202 Accepted both mean success.
      if (res.ok) submitted += chunk.length;
      else failed += chunk.length;
    } catch {
      failed += chunk.length;
    }
  }
  return { submitted, chunks: chunks.length, failed };
}

// ── Incremental queue (fed by webhooks, drained on demand) ───────────────────

/** Enqueue a changed URL — no-op unless IndexNow is configured + enabled. */
export async function enqueueIndexNowUrl(db: PrismaClient, shop: string, url: string): Promise<void> {
  const config = await getIndexNowConfig(db, shop);
  if (!config || !config.enabled) return;
  await db.seoIndexNowQueue.upsert({
    where: { shop_urlHash: { shop, urlHash: urlHash(url) } },
    create: { shop, url, urlHash: urlHash(url) },
    update: {},
  });
}

/** Convenience used by webhooks: build the URL and enqueue it (best-effort). */
export async function enqueueResource(
  db: PrismaClient,
  shop: string,
  host: string,
  type: IndexNowResourceType,
  handle: string,
): Promise<void> {
  if (!handle) return;
  await enqueueIndexNowUrl(db, shop, storefrontUrl(host, type, handle));
}

export async function getQueueCount(db: PrismaClient, shop: string): Promise<number> {
  return db.seoIndexNowQueue.count({ where: { shop } });
}

/** Submit everything in the queue, then clear the submitted rows. */
export async function drainQueue(db: PrismaClient, shop: string, host: string): Promise<SubmitResult> {
  const config = await getIndexNowConfig(db, shop);
  if (!config) return { submitted: 0, chunks: 0, failed: 0 };
  const rows = await db.seoIndexNowQueue.findMany({ where: { shop }, select: { id: true, url: true } });
  if (rows.length === 0) return { submitted: 0, chunks: 0, failed: 0 };
  const result = await submitUrls(host, config.key, config.keyLocation, rows.map((r) => r.url));
  if (result.failed === 0) {
    await db.seoIndexNowQueue.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
    await db.seoIndexNowConfig.updateMany({ where: { shop }, data: { lastSubmittedAt: new Date() } });
  }
  return result;
}

// ── Bulk: submit the whole catalog ───────────────────────────────────────────

/** Collect storefront URLs from the DB cache (products/collections/pages). */
export async function collectStoreUrls(db: PrismaClient, shop: string, host: string): Promise<string[]> {
  const [products, collections, pages] = await Promise.all([
    db.product.findMany({
      where: { shop, status: "ACTIVE" },
      select: { handle: true },
      take: URL_COLLECT_CAP,
    }),
    db.collection.findMany({ where: { shop }, select: { handle: true }, take: URL_COLLECT_CAP }),
    db.page.findMany({ where: { shop }, select: { handle: true }, take: URL_COLLECT_CAP }),
  ]);
  const urls: string[] = [];
  for (const p of products) if (p.handle) urls.push(storefrontUrl(host, "product", p.handle));
  for (const c of collections) if (c.handle) urls.push(storefrontUrl(host, "collection", c.handle));
  for (const pg of pages) if (pg.handle) urls.push(storefrontUrl(host, "page", pg.handle));
  return urls;
}

export async function submitAll(db: PrismaClient, shop: string, host: string): Promise<SubmitResult> {
  const config = await getIndexNowConfig(db, shop);
  if (!config) return { submitted: 0, chunks: 0, failed: 0 };
  const urls = await collectStoreUrls(db, shop, host);
  if (urls.length === 0) return { submitted: 0, chunks: 0, failed: 0 };
  const result = await submitUrls(host, config.key, config.keyLocation, urls);
  if (result.failed === 0) {
    await db.seoIndexNowConfig.updateMany({ where: { shop }, data: { lastSubmittedAt: new Date() } });
  }
  return result;
}
