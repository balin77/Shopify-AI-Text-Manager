/**
 * WebP Conversion Task Processor
 *
 * Polls the database for pending imageWebpConversion tasks and processes them.
 * Uses sharp for server-side image conversion.
 * Runs as a background service started from server.js.
 */

import { PrismaClient } from "@prisma/client";
import sharp from "sharp";
import crypto from "crypto";
import { PLAN_WEBP_CONCURRENCY, DEFAULT_WEBP_CONCURRENCY } from "./app/config/webp-concurrency.js";

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

const DOWNLOAD_MAX_ATTEMPTS = 4;
const DOWNLOAD_BASE_DELAY_MS = 1000;
const DOWNLOAD_TIMEOUT_MS = 30000;
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const SHOPIFY_FETCH_TIMEOUT_MS = 30000;
// Hard cap for an entire task (download + convert + several Shopify calls).
// Each fetch already has its own 30s timeout, but a wedged sequence (or a
// hung sharp conversion) could otherwise keep a task "running" indefinitely
// and never trip the recovery threshold reliably.
const WEBP_TASK_TIMEOUT_MS = 4 * 60 * 1000;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Single-shot fetch with abort timeout — used for all Shopify GraphQL/CDN calls
// so a hanging request can't keep a running task alive past the stuck-task threshold.
async function fetchWithTimeout(url, options, label) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SHOPIFY_FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`${label} timed out after ${SHOPIFY_FETCH_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

// One-shot lookup of the CDN URL for a freshly created MediaImage. Returns null
// if Shopify is still PROCESSING (image.url not yet available) or on any error —
// caller should treat that as "URL unknown" and skip persisting it.
async function fetchNewMediaUrl(shopifyApiUrl, headers, mediaId) {
  try {
    const res = await fetchWithTimeout(shopifyApiUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        query: `query($id: ID!) {
          node(id: $id) {
            ... on MediaImage { image { url } }
          }
        }`,
        variables: { id: mediaId },
      }),
    }, "new media URL query");
    if (!res.ok) return null;
    const data = await res.json();
    return data.data?.node?.image?.url ?? null;
  } catch {
    return null;
  }
}

async function downloadImageAsBuffer(url) {
  for (let attempt = 1; attempt <= DOWNLOAD_MAX_ATTEMPTS; attempt++) {
    const isLastAttempt = attempt === DOWNLOAD_MAX_ATTEMPTS;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

    let retryReason;
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (response.ok) return Buffer.from(await response.arrayBuffer());

      if (RETRYABLE_STATUS.has(response.status) && !isLastAttempt) {
        retryReason = `HTTP ${response.status}`;
      } else {
        throw new Error(`Failed to download image: ${response.status} ${url}`);
      }
    } catch (err) {
      // Network error or timeout — retry until last attempt; HTTP errors above re-throw directly.
      if (isLastAttempt || err.message?.startsWith("Failed to download image:")) throw err;
      retryReason = err.name === "AbortError" ? `timeout after ${DOWNLOAD_TIMEOUT_MS}ms` : err.message;
    } finally {
      clearTimeout(timeout);
    }

    const delay = DOWNLOAD_BASE_DELAY_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
    console.warn(`[WebPProcessor] Download attempt ${attempt}/${DOWNLOAD_MAX_ATTEMPTS} failed (${retryReason}) for ${url} — retrying in ${delay}ms`);
    await sleep(delay);
  }
  // Unreachable: loop either returns or throws.
  throw new Error(`Failed to download image after ${DOWNLOAD_MAX_ATTEMPTS} attempts: ${url}`);
}

async function convertToWebP(sourceBuffer, originalUrl, quality = 85) {
  const buffer = await sharp(sourceBuffer).webp({ quality }).toBuffer();
  let filename = `converted-${Date.now()}.webp`;
  if (originalUrl) {
    try {
      const pathname = new URL(originalUrl).pathname;
      const base = pathname.split("/").pop().replace(/\.[^.]+$/, "");
      if (base) filename = `${base}.webp`;
    } catch {}
  }
  return { buffer, filename };
}

// Reuse the global PrismaClient shared with the Remix app (db.server.ts) and
// the other standalone services. Creating a separate client here leaked a
// connection pool on every restart (it was never $disconnect()-ed); the
// shared instance is closed exactly once by server.js gracefulShutdown.
const db = globalThis.__db ?? new PrismaClient();
if (!globalThis.__db) globalThis.__db = db;

const POLL_INTERVAL_MS = 10000; // 10 seconds
const GLOBAL_MAX_CONCURRENT = 8;
// Per-plan concurrency comes from app/config/webp-concurrency.js — the single
// source of truth shared with app/config/plans.ts (PlanLimits
// .maxConcurrentWebpConversions). No more hardcoded mirror to keep in sync.

export class WebPProcessorService {
  static instance = null;
  isRunning = false;

  static getInstance() {
    if (!WebPProcessorService.instance) {
      WebPProcessorService.instance = new WebPProcessorService();
    }
    return WebPProcessorService.instance;
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.poll();
    console.log("[WebPProcessor] Service started, polling every", POLL_INTERVAL_MS / 1000, "seconds");
  }

  stop() {
    this.isRunning = false;
  }

  async poll() {
    if (!this.isRunning) return;

    try {
      await this.processPendingTasks();
    } catch (err) {
      console.error("[WebPProcessor] Poll error:", err);
    }

    setTimeout(() => this.poll(), POLL_INTERVAL_MS);
  }

  async processPendingTasks() {
    // Heartbeat: bump updatedAt on all waiting WebP tasks so task-recovery's
    // 10-min stuck-task detector doesn't kill them while they wait in the queue.
    // If the worker dies, no heartbeat fires and waiting tasks correctly become
    // stuck after the threshold — that's the intended crash signal.
    // We accept both "pending" (newly created) and "queued" (reset by
    // TaskRecoveryService.resetPendingTasks after a server restart) so restart
    // doesn't silently orphan tasks.
    await db.task.updateMany({
      where: { type: "imageWebpConversion", status: { in: ["pending", "queued"] } },
      data: { updatedAt: new Date() },
    });

    // Find which shops have waiting tasks (oldest waiting task per shop wins ordering).
    const shopsWithPending = await db.task.groupBy({
      by: ["shop"],
      where: { type: "imageWebpConversion", status: { in: ["pending", "queued"] } },
      _min: { createdAt: true },
      orderBy: { _min: { createdAt: "asc" } },
    });

    if (shopsWithPending.length === 0) return;

    const tasksToProcess = [];
    for (const { shop } of shopsWithPending) {
      if (tasksToProcess.length >= GLOBAL_MAX_CONCURRENT) break;

      const settings = await db.aISettings.findUnique({
        where: { shop },
        select: { subscriptionPlan: true },
      });
      const plan = settings?.subscriptionPlan || "free";
      const planLimit = PLAN_WEBP_CONCURRENCY[plan] ?? DEFAULT_WEBP_CONCURRENCY;

      const running = await db.task.count({
        where: { shop, type: "imageWebpConversion", status: "running" },
      });
      const freeSlots = Math.max(0, planLimit - running);
      if (freeSlots === 0) continue;

      const remaining = GLOBAL_MAX_CONCURRENT - tasksToProcess.length;
      const tasks = await db.task.findMany({
        where: { shop, type: "imageWebpConversion", status: { in: ["pending", "queued"] } },
        take: Math.min(freeSlots, remaining),
        orderBy: { createdAt: "asc" },
      });
      tasksToProcess.push(...tasks);
    }

    if (tasksToProcess.length === 0) return;

    await Promise.all(tasksToProcess.map(task => this.processTask(task)));
  }

  async processTask(task) {
    let taskData;
    try {
      taskData = JSON.parse(task.result || "{}");
    } catch {
      await this.failTask(task.id, "Invalid task data");
      return;
    }

    const { sourceUrl, productId } = taskData;
    if (!sourceUrl || !productId) {
      await this.failTask(task.id, "Missing sourceUrl or productId");
      return;
    }

    let timeoutTimer;
    try {
      await Promise.race([
        this._runWebpSteps(task, taskData),
        new Promise((_, reject) => {
          timeoutTimer = setTimeout(
            () => reject(new Error(`WebP task timed out after ${WEBP_TASK_TIMEOUT_MS}ms`)),
            WEBP_TASK_TIMEOUT_MS,
          );
        }),
      ]);
    } catch (err) {
      console.error(`[WebPProcessor] Task ${task.id} timed out / failed:`, err);
      await this.failTask(task.id, String(err));
    } finally {
      clearTimeout(timeoutTimer);
    }
  }

  async _runWebpSteps(task, taskData) {
    const { sourceUrl, mediaId, productImageId, productId, altText: taskAltText } = taskData;
    try {
      // Mark as running
      await db.task.update({
        where: { id: task.id },
        data: { status: "running", progress: 10 },
      });

      // 1. Download original image
      const sourceBuffer = await downloadImageAsBuffer(sourceUrl);
      await db.task.update({ where: { id: task.id }, data: { progress: 30 } });

      // 2. Convert to WebP
      const { buffer, filename } = await convertToWebP(sourceBuffer, sourceUrl);
      await db.task.update({ where: { id: task.id }, data: { progress: 50 } });

      // 3. Get Shopify session for this shop
      const session = await db.session.findFirst({
        where: { shop: task.shop, isOnline: false },
        orderBy: { lastActivityAt: "desc" },
      });

      if (!session?.accessToken) {
        await this.failTask(task.id, "No valid session found for shop");
        return;
      }

      const accessToken = decryptToken(session.accessToken);
      if (!accessToken) {
        await this.failTask(task.id, "Failed to decrypt session access token");
        return;
      }

      // Use altText passed from the client; fall back to DB lookup if not present
      let originalAltText = taskAltText ?? null;
      if (!originalAltText && productImageId) {
        const productImage = await db.productImage.findUnique({
          where: { id: productImageId },
          select: { altText: true },
        });
        originalAltText = productImage?.altText || null;
      }

      const shopifyApiUrl = `https://${task.shop}/admin/api/2025-04/graphql.json`;
      const headers = {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      };

      // 4. Create Shopify staged upload for WebP
      const stagedRes = await fetchWithTimeout(shopifyApiUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          query: `
            mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
              stagedUploadsCreate(input: $input) {
                stagedTargets { url resourceUrl parameters { name value } }
                userErrors { field message }
              }
            }
          `,
          variables: {
            input: [{
              filename,
              mimeType: "image/webp",
              fileSize: String(buffer.byteLength),
              resource: "IMAGE",
              httpMethod: "PUT",
            }],
          },
        }),
      }, "stagedUploadsCreate");
      if (!stagedRes.ok) {
        const body = await stagedRes.text();
        await this.failTask(task.id, `Staged upload HTTP ${stagedRes.status}: ${body}`);
        return;
      }
      const stagedData = await stagedRes.json();
      const userErrors = stagedData.data?.stagedUploadsCreate?.userErrors ?? [];
      if (userErrors.length > 0) {
        await this.failTask(task.id, `Staged upload userErrors: ${JSON.stringify(userErrors)}`);
        return;
      }
      const target = stagedData.data?.stagedUploadsCreate?.stagedTargets?.[0];

      if (!target) {
        console.error("[WebPProcessor] Unexpected stagedUploadsCreate response:", JSON.stringify(stagedData));
        await this.failTask(task.id, "Staged upload creation failed: no target returned");
        return;
      }

      await db.task.update({ where: { id: task.id }, data: { progress: 60 } });

      // 5. Upload WebP to Shopify CDN
      await fetchWithTimeout(target.url, {
        method: "PUT",
        headers: { "Content-Type": "image/webp", "Content-Length": String(buffer.byteLength) },
        body: buffer,
      }, "CDN upload");

      await db.task.update({ where: { id: task.id }, data: { progress: 70 } });

      // 6. Add new WebP as product media (productCreateMedia returns the new GID)
      const createMediaRes = await fetchWithTimeout(shopifyApiUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          query: `
            mutation productCreateMedia($media: [CreateMediaInput!]!, $productId: ID!) {
              productCreateMedia(media: $media, productId: $productId) {
                media { id }
                mediaUserErrors { field message }
              }
            }
          `,
          variables: {
            productId,
            media: [{ originalSource: target.resourceUrl, mediaContentType: "IMAGE", ...(originalAltText ? { alt: originalAltText } : {}) }],
          },
        }),
      }, "productCreateMedia");
      if (!createMediaRes.ok) {
        const body = await createMediaRes.text();
        await this.failTask(task.id, `Create media HTTP ${createMediaRes.status}: ${body}`);
        return;
      }
      const createMediaData = await createMediaRes.json();
      const mediaUserErrors = createMediaData.data?.productCreateMedia?.mediaUserErrors ?? [];
      if (mediaUserErrors.length > 0) {
        await this.failTask(task.id, `Create media userErrors: ${JSON.stringify(mediaUserErrors)}`);
        return;
      }
      const newMediaId = createMediaData.data?.productCreateMedia?.media?.[0]?.id ?? null;

      await db.task.update({ where: { id: task.id }, data: { progress: 80 } });

      // 6.5. Find variants whose featured image is the old PNG — query before deletion
      // so the variant.image relationship is still visible in Shopify's API.
      // NOTE: variant.image.id returns a ProductImage GID (gid://shopify/ProductImage/...),
      // while mediaId in the task is a MediaImage GID (gid://shopify/MediaImage/...).
      // These are different GID types for the same image, so we must match by URL path instead.
      let variantIdsWithOldFeaturedImage = [];
      if (newMediaId) {
        try {
          const variantsQueryRes = await fetchWithTimeout(shopifyApiUrl, {
            method: "POST",
            headers,
            body: JSON.stringify({
              query: `query($id: ID!) { product(id: $id) { variants(first: 100) { edges { node { id image { url } } } } } }`,
              variables: { id: productId },
            }),
          }, "variants query");
          const variantsQueryData = await variantsQueryRes.json();
          const srcPath = (() => {
            try { return new URL(sourceUrl).pathname; } catch { return sourceUrl; }
          })();
          variantIdsWithOldFeaturedImage = (variantsQueryData.data?.product?.variants?.edges ?? [])
            .filter(({ node }) => {
              if (!node.image?.url) return false;
              try { return new URL(node.image.url).pathname === srcPath; } catch { return node.image.url === sourceUrl; }
            })
            .map(({ node }) => node.id);
        } catch (err) {
          console.error(`[WebPProcessor] Failed to query variants for featured image update:`, err);
        }
      }

      // 6.6. COMPENSATION ORDERING: point the DB row at the new MediaImage
      // BEFORE we destructively delete the old media from Shopify. If the
      // process crashes anywhere between the delete and the old step-9 DB
      // write, the DB would otherwise still reference a now-deleted mediaId
      // (broken image, not reliably caught by recovery). Worst case after
      // this reorder is a surviving duplicate old media — visible and
      // self-healing on the next sync, far preferable to a dangling pointer.
      if (mediaId && newMediaId) {
        await db.productImage.updateMany({
          where: { mediaId: mediaId },
          data: { mediaId: newMediaId },
        }).catch(() => {});
      }

      // 7. Delete old media from Shopify (if mediaId available)
      if (mediaId) {
        await fetchWithTimeout(shopifyApiUrl, {
          method: "POST",
          headers,
          body: JSON.stringify({
            query: `
              mutation productDeleteMedia($productId: ID!, $mediaIds: [ID!]!) {
                productDeleteMedia(productId: $productId, mediaIds: $mediaIds) {
                  userErrors { field message }
                }
              }
            `,
            variables: { productId, mediaIds: [mediaId] },
          }),
        }, "productDeleteMedia");
      }

      // 7b. Restore original position of the new WebP image
      const originalPosition = taskData.position;
      if (newMediaId && originalPosition != null && originalPosition >= 0) {
        try {
          await fetchWithTimeout(shopifyApiUrl, {
            method: "POST",
            headers,
            body: JSON.stringify({
              query: `
                mutation productReorderMedia($id: ID!, $moves: [MoveInput!]!) {
                  productReorderMedia(id: $id, moves: $moves) {
                    userErrors { field message }
                  }
                }
              `,
              variables: {
                id: productId,
                moves: [{ id: newMediaId, newPosition: String(originalPosition) }],
              },
            }),
          }, "productReorderMedia");
          console.log(`[WebPProcessor] Restored position ${originalPosition} for ${newMediaId}`);
        } catch (err) {
          console.error(`[WebPProcessor] Failed to restore position for task ${task.id}:`, err);
        }
      }

      // 7c. Re-assign variant featured images (mediaId) to the new WebP
      if (variantIdsWithOldFeaturedImage.length > 0 && newMediaId) {
        try {
          await fetchWithTimeout(shopifyApiUrl, {
            method: "POST",
            headers,
            body: JSON.stringify({
              query: `
                mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
                  productVariantsBulkUpdate(productId: $productId, variants: $variants) {
                    userErrors { field message }
                  }
                }
              `,
              variables: {
                productId,
                variants: variantIdsWithOldFeaturedImage.map(id => ({ id, mediaId: newMediaId })),
              },
            }),
          }, "variant featured image update");
          console.log(`[WebPProcessor] Updated featured image for ${variantIdsWithOldFeaturedImage.length} variant(s): ${mediaId} → ${newMediaId}`);
        } catch (err) {
          console.error(`[WebPProcessor] Failed to update variant featured images for task ${task.id}:`, err);
        }
      }

      // 8. Re-assign variant galleries: replace old media GID with new WebP GID
      if (mediaId && newMediaId) {
        const affectedVariants = await db.productVariant.findMany({
          where: { productId, galleryJson: { contains: mediaId } },
          select: { shopifyGid: true, galleryJson: true },
        });

        for (const variant of affectedVariants) {
          try {
            const gids = JSON.parse(variant.galleryJson || "[]");
            const updatedGids = gids.map(g => g === mediaId ? newMediaId : g);
            const updatedJson = JSON.stringify(updatedGids);

            await db.productVariant.updateMany({
              where: { shopifyGid: variant.shopifyGid },
              data: { galleryJson: updatedJson },
            });

            await fetchWithTimeout(shopifyApiUrl, {
              method: "POST",
              headers,
              body: JSON.stringify({
                query: `
                  mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
                    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
                      userErrors { field message }
                    }
                  }
                `,
                variables: {
                  productId,
                  variants: [{
                    id: variant.shopifyGid,
                    metafields: [{
                      namespace: "custom",
                      key: "variant_gallery",
                      value: updatedJson,
                      type: "list.file_reference",
                    }],
                  }],
                },
              }),
            }, "variant gallery update");
          } catch (err) {
            console.error(`[WebPProcessor] Failed to update variant gallery for ${variant.shopifyGid}:`, err);
          }
        }
        if (affectedVariants.length > 0) {
          console.log(`[WebPProcessor] Re-assigned ${affectedVariants.length} variant gallery(ies): ${mediaId} → ${newMediaId}`);
        }
      }

      await db.task.update({ where: { id: task.id }, data: { progress: 90 } });

      // 9. Reconcile the CDN URL. The mediaId pointer was already swapped in
      //    step 6.6, so here we only resolve and persist the real URL, keyed
      //    by the NEW mediaId. target.resourceUrl is the staged-upload storage
      //    URL and must NEVER be persisted. If Shopify is still PROCESSING the
      //    new MediaImage, url stays as-is (column is non-nullable) and a
      //    later /api/product-images upsert reconciles it.
      let resolvedUrl = null;
      if (mediaId && newMediaId) {
        resolvedUrl = await fetchNewMediaUrl(shopifyApiUrl, headers, newMediaId);
        if (resolvedUrl) {
          await db.productImage.updateMany({
            where: { mediaId: newMediaId },
            data: { url: resolvedUrl },
          }).catch(() => {});
        }
      }

      // 10. Mark task as completed
      await db.task.update({
        where: { id: task.id },
        data: {
          status: "completed",
          progress: 100,
          completedAt: new Date(),
          result: JSON.stringify({
            ...taskData,
            webpUrl: resolvedUrl ?? target.resourceUrl,
          }),
        },
      });

      console.log(`[WebPProcessor] Task ${task.id} completed: ${sourceUrl} → ${resolvedUrl ?? "(URL pending)"}`);
    } catch (err) {
      console.error(`[WebPProcessor] Task ${task.id} failed:`, err);
      await this.failTask(task.id, String(err));
    }
  }

  async failTask(taskId, error) {
    // Only the FIRST transition into "failed" should refund: updateMany with a
    // non-terminal status guard makes the refund idempotent even if failTask
    // runs twice for the same task.
    let shop = null;
    try {
      const before = await db.task.findUnique({
        where: { id: taskId },
        select: { shop: true, status: true },
      });
      const res = await db.task.updateMany({
        where: { id: taskId, status: { notIn: ["failed", "completed"] } },
        data: { status: "failed", completedAt: new Date(), error },
      });
      if (res.count > 0 && before?.shop) shop = before.shop;
    } catch {
      // Fall back to a best-effort status write without the guard.
      await db.task
        .update({ where: { id: taskId }, data: { status: "failed", completedAt: new Date(), error } })
        .catch(() => {});
    }

    // Each imageWebpConversion task consumed exactly one image operation at
    // batch-creation time; a failed conversion produced no result, so give the
    // op back (N-H4). Period key mirrors currentImageOpPeriod() (UTC YYYY-MM).
    if (shop) {
      try {
        const now = new Date();
        const period = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
        const row = await db.imageOperationCounter.findUnique({
          where: { shop_period: { shop, period } },
          select: { count: true },
        });
        if (row) {
          await db.imageOperationCounter.update({
            where: { shop_period: { shop, period } },
            data: { count: Math.max(0, row.count - 1) },
          });
          console.log(`[WebPProcessor] Refunded 1 image op for ${shop} (task ${taskId} failed)`);
        }
      } catch (err) {
        console.error(`[WebPProcessor] Image-op refund failed for ${shop}:`, err);
      }
    }
  }
}
