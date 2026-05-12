/**
 * Stale Image Cleanup Service (Standalone)
 *
 * Removes orphan ProductImage rows whose mediaId no longer exists on Shopify.
 * Sources of orphans:
 *   - Legacy WebP worker bug that persisted staged-upload URLs
 *   - Server crashes between Shopify delete-media and DB update
 *   - Manual deletions on Shopify outside ContentPilot
 *
 * Two-phase cleanup:
 *   1. Fast pass: delete rows with the known-bad staged-upload URL prefix
 *      (URL itself is dead — no Shopify call needed).
 *   2. Reconcile pass: for products that had a WebP conversion in the last
 *      30 days (highest-risk pool), fetch the live media list from Shopify
 *      and delete rows whose mediaId is not in the response. Rate-limited
 *      to one Shopify call every ~500ms per shop.
 *
 * Runs once at server startup and then every 24 hours.
 */

import { PrismaClient } from "@prisma/client";
import crypto from "crypto";

const prisma = globalThis.__db ?? new PrismaClient();
if (!globalThis.__db) globalThis.__db = prisma;

const STAGED_URL_PREFIX = "https://shopify-staged-uploads.storage.googleapis.com/";
const SHOPIFY_FETCH_TIMEOUT_MS = 30000;
const RECONCILE_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const PER_PRODUCT_DELAY_MS = 500;
const PERIODIC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function isEncryptedToken(data) {
  if (!data) return false;
  const parts = data.split(":");
  if (parts.length !== 3) return false;
  const base64Regex = /^[A-Za-z0-9+/]+=*$/;
  return parts.every(part => base64Regex.test(part));
}

function decryptToken(encryptedToken) {
  if (!encryptedToken) return null;
  if (!isEncryptedToken(encryptedToken)) return encryptedToken;

  const envKey = process.env.ENCRYPTION_KEY;
  if (!envKey) throw new Error("ENCRYPTION_KEY not set");
  const key = Buffer.from(envKey.trim(), "hex");

  const [ivBase64, encBase64, tagBase64] = encryptedToken.split(":");
  const iv = Buffer.from(ivBase64, "base64");
  const encrypted = Buffer.from(encBase64, "base64");
  const authTag = Buffer.from(tagBase64, "base64");

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SHOPIFY_FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchProductMediaIds(shop, accessToken, productGid) {
  const res = await fetchWithTimeout(`https://${shop}/admin/api/2025-04/graphql.json`, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": accessToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: `query($id: ID!) {
        product(id: $id) {
          media(first: 250) { edges { node { ... on MediaImage { id } } } }
        }
      }`,
      variables: { id: productGid },
    }),
  });
  if (!res.ok) throw new Error(`Shopify HTTP ${res.status}`);
  const data = await res.json();
  if (data.errors) throw new Error(`Shopify errors: ${JSON.stringify(data.errors)}`);
  const product = data.data?.product;
  if (!product) return null; // product no longer exists on Shopify
  return (product.media?.edges ?? [])
    .map(e => e.node?.id)
    .filter(Boolean);
}

export class StaleImageCleanupService {
  static instance = null;
  intervalId = null;
  isRunning = false;

  static getInstance() {
    if (!StaleImageCleanupService.instance) {
      StaleImageCleanupService.instance = new StaleImageCleanupService();
    }
    return StaleImageCleanupService.instance;
  }

  start() {
    if (this.isRunning) {
      console.log("[StaleImageCleanup] Service already running");
      return;
    }
    this.isRunning = true;
    console.log("[StaleImageCleanup] Service started — running initial sweep, then every 24h");

    // Run immediately on start (don't await — keep server boot fast)
    this.runOnce().catch(err => console.error("[StaleImageCleanup] Initial sweep failed:", err));

    this.intervalId = setInterval(() => {
      this.runOnce().catch(err => console.error("[StaleImageCleanup] Periodic sweep failed:", err));
    }, PERIODIC_INTERVAL_MS);
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.isRunning = false;
    console.log("[StaleImageCleanup] Service stopped");
  }

  /**
   * Run one full cleanup pass. Safe to call manually.
   */
  async runOnce() {
    const startedAt = Date.now();

    // Phase 1: blanket-delete known-bad staged-upload-URL rows. URL is dead either way.
    const stagedResult = await prisma.productImage.deleteMany({
      where: { url: { startsWith: STAGED_URL_PREFIX } },
    });
    if (stagedResult.count > 0) {
      console.log(`[StaleImageCleanup] Phase 1: removed ${stagedResult.count} staged-upload orphan row(s)`);
    }

    // Phase 2: per-product reconciliation for products that had a WebP conversion
    // in the last 30 days (highest-risk window for orphans).
    const lookbackDate = new Date(Date.now() - RECONCILE_LOOKBACK_MS);
    const recentConversions = await prisma.task.findMany({
      where: {
        type: "imageWebpConversion",
        status: { in: ["completed", "failed"] },
        completedAt: { gt: lookbackDate },
      },
      distinct: ["resourceId", "shop"],
      select: { shop: true, resourceId: true },
    });

    let reconciled = 0;
    let removed = 0;
    let skipped = 0;

    // Group by shop to look up the session once per shop.
    const byShop = new Map();
    for (const { shop, resourceId } of recentConversions) {
      if (!resourceId) continue;
      if (!byShop.has(shop)) byShop.set(shop, []);
      byShop.get(shop).push(resourceId);
    }

    for (const [shop, productIds] of byShop) {
      const session = await prisma.session.findFirst({
        where: { shop, isOnline: false },
        orderBy: { lastActivityAt: "desc" },
      });
      if (!session?.accessToken) {
        console.warn(`[StaleImageCleanup] No session for shop ${shop} — skipping ${productIds.length} product(s)`);
        skipped += productIds.length;
        continue;
      }

      let accessToken;
      try {
        accessToken = decryptToken(session.accessToken);
      } catch (err) {
        console.warn(`[StaleImageCleanup] Token decrypt failed for ${shop} — skipping:`, err.message);
        skipped += productIds.length;
        continue;
      }
      if (!accessToken) {
        skipped += productIds.length;
        continue;
      }

      for (const productId of productIds) {
        try {
          const shopifyMediaIds = await fetchProductMediaIds(shop, accessToken, productId);
          if (shopifyMediaIds === null) {
            // Product deleted on Shopify — drop all our rows for it.
            const del = await prisma.productImage.deleteMany({ where: { productId } });
            removed += del.count;
            reconciled++;
          } else {
            const del = await prisma.productImage.deleteMany({
              where: {
                productId,
                mediaId: { notIn: shopifyMediaIds.length > 0 ? shopifyMediaIds : ["__none__"] },
              },
            });
            removed += del.count;
            reconciled++;
          }
        } catch (err) {
          console.warn(`[StaleImageCleanup] Reconcile failed for ${productId}:`, err.message);
          skipped++;
        }
        await sleep(PER_PRODUCT_DELAY_MS);
      }
    }

    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(`[StaleImageCleanup] Pass complete in ${elapsed}s: ${stagedResult.count} staged removed, ${reconciled} products reconciled (${removed} rows removed), ${skipped} skipped`);

    return { stagedRemoved: stagedResult.count, reconciled, removed, skipped };
  }
}
