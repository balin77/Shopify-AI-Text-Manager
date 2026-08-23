/**
 * WebP Conversion Task Processor
 *
 * Polls the database for pending WebP conversion WORK ITEMS and processes them,
 * one image per row. Uses sharp for server-side image conversion. Runs as a
 * background service started from server.js.
 *
 * A run is TWO kinds of row (app/config/webp-tasks.js): N
 * `imageWebpConversionItem` rows — the unit of work, of retry, of the per-image
 * step boundary the boot recovery reads and of the image operation the reaper
 * refunds — under ONE `imageWebpConversion` row, which is the only one the
 * merchant sees. This service owns both halves: it runs the items and it
 * settles the aggregate above them (`settleParent`), because nothing else knows
 * when the last image of a run has landed.
 *
 * ONE WRITER PER VERDICT. A work item's terminal status is also its refund —
 * an image operation is owed back for exactly those items recorded `failed` —
 * and it is what the batch above settles on, once, irreversibly. So every
 * terminal write on an item row is guarded on a still-open status and pays its
 * refund only if that guard let it through (`failTask`, step 10), and nothing
 * writes a verdict it does not have evidence for: giving up on WAITING for an
 * item is not a failure of the item, so it writes nothing at all and leaves the
 * row to the steps that are still running it. What that costs is stated at
 * WEBP_TASK_TIMEOUT_MS; what it buys is that the row, the batch and the
 * merchant's quota cannot disagree.
 */

import { PrismaClient } from "@prisma/client";
import sharp from "sharp";
import crypto from "crypto";
import { PLAN_WEBP_CONCURRENCY, DEFAULT_WEBP_CONCURRENCY } from "./app/config/webp-concurrency.js";
import { refundImageOperations } from "./image-op-refund.js";
import {
  WEBP_FAILURE_LIST_MAX,
  WEBP_FAILURE_MESSAGE_MAX,
  WEBP_ITEM_TASK_TYPE,
  WEBP_NON_TERMINAL_STATUS,
  WEBP_PARENT_ORPHAN_GRACE_MS,
  WEBP_PARENT_TASK_TYPE,
  parseTaskResult,
  webpBatchStatus,
  webpParentTaskId,
  webpWorkRowWhere,
} from "./app/config/webp-tasks.js";

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
// How long ONE work item may hold the poll's `await` before the processor
// stops waiting for it (download + convert + several Shopify calls; each fetch
// already has its own 30s timeout).
//
// It stops the WAITING, it does not stop the WORK — a JS promise cannot be
// killed, and killing this one mid-sequence is the one thing that must not
// happen: between step 6 and step 9 the new media exists and the merchant's
// original is being deleted, which is exactly what the <70/>=70 progress
// boundary in task-recovery.service.js is there to classify. So the item row
// is left `running` and its own steps write its one terminal state whenever
// they land. Writing `failed` here (what this used to do) put a SECOND writer
// on the row: the steps then finished and overwrote the verdict, the refund
// that verdict had already paid out stayed paid, and if that item was the last
// open one the batch above it had already settled as failed and is guarded
// against ever being recounted. A merchant was told images failed that in fact
// converted, and got a month's quota back for them.
//
// A work item that really is wedged is still caught, by the stuck-task reaper
// (10 min without a write) and, if the process dies with it, by the boot
// recovery — both of which read the row this leaves behind rather than racing
// the steps that own it.
const WEBP_TASK_TIMEOUT_MS = 4 * 60 * 1000;

/**
 * The processor gave up WAITING for an item; the item itself is still running.
 * Its own class so the catch below can tell it from a real failure — everything
 * else that comes out of the steps is a verdict and still fails the row.
 */
class WebPItemAbandoned extends Error {}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// R3-M9: String(err) on a thrown object yields "[object Object]" and drops
// the message + stack, so the task `error` column (the only post-mortem we
// have for a failed conversion) became useless. Preserve message + stack for
// real Errors; JSON-stringify anything else. Bounded so a pathological error
// can't bloat the row.
function describeError(err) {
  if (err instanceof Error) {
    return `${err.message}${err.stack ? `\n${err.stack}` : ""}`.slice(0, 2000);
  }
  if (typeof err === "string") return err.slice(0, 2000);
  try {
    return JSON.stringify(err).slice(0, 2000);
  } catch {
    return String(err).slice(0, 2000);
  }
}

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
    // Settle the aggregate rows FIRST, and outside the early return below: a
    // run whose last images are `running` has no waiting task at all, so a
    // sweep placed after that return would never finish the very batch that is
    // one image from done. It also heartbeats the parents it leaves open.
    await this.settleOpenParents();

    // Heartbeat: bump updatedAt on all waiting WebP tasks so task-recovery's
    // 10-min stuck-task detector doesn't kill them while they wait in the queue.
    // If the worker dies, no heartbeat fires and waiting tasks correctly become
    // stuck after the threshold — that's the intended crash signal.
    // We accept both "pending" (newly created) and "queued" (reset by
    // TaskRecoveryService.resetPendingTasks after a server restart) so restart
    // doesn't silently orphan tasks.
    //
    // The selector is `webpWorkRowWhere` everywhere in this service: it matches
    // the item rows this build creates AND the rows an older build wrote under
    // the parent type, and it never matches an aggregate row. A parent picked
    // up as work would fail on "Missing sourceUrl or productId" and refund an
    // image operation nobody spent.
    await db.task.updateMany({
      where: webpWorkRowWhere({ status: { in: ["pending", "queued"] } }),
      data: { updatedAt: new Date() },
    });

    // Find which shops have waiting tasks (oldest waiting task per shop wins ordering).
    const shopsWithPending = await db.task.groupBy({
      by: ["shop"],
      where: webpWorkRowWhere({ status: { in: ["pending", "queued"] } }),
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
        where: webpWorkRowWhere({ shop, status: "running" }),
      });
      const freeSlots = Math.max(0, planLimit - running);
      if (freeSlots === 0) continue;

      const remaining = GLOBAL_MAX_CONCURRENT - tasksToProcess.length;
      const tasks = await db.task.findMany({
        where: webpWorkRowWhere({ shop, status: { in: ["pending", "queued"] } }),
        take: Math.min(freeSlots, remaining),
        orderBy: { createdAt: "asc" },
      });
      tasksToProcess.push(...tasks);
    }

    if (tasksToProcess.length === 0) return;

    await Promise.all(tasksToProcess.map(task => this.processTask(task)));
  }

  /**
   * Every open aggregate row, settled once per poll.
   *
   * This is the BACKSTOP, not the primary path: an item settles its own parent
   * the moment it finishes (see `processTask`). But an item can also reach a
   * terminal state through paths that know nothing about a parent — the
   * stuck-task reaper, the boot recovery's "partial Shopify state" branch, a
   * merchant deleting the row — and a parent nobody ever closes is a task that
   * runs forever in the merchant's list.
   */
  async settleOpenParents() {
    let parents;
    try {
      parents = await db.task.findMany({
        where: {
          type: WEBP_PARENT_TASK_TYPE,
          total: { not: null },
          status: { in: WEBP_NON_TERMINAL_STATUS },
        },
        select: { id: true },
      });
    } catch (err) {
      console.error("[WebPProcessor] Failed to list open conversion batches:", err);
      return;
    }
    for (const parent of parents) {
      try {
        await this.settleParent(parent.id);
      } catch (err) {
        console.error(`[WebPProcessor] Failed to settle conversion batch ${parent.id}:`, err);
      }
    }
  }

  /**
   * Recount one aggregate row from its items and write what is true now.
   *
   * A RECOUNT, never an increment: the same item can reach `settleParent` twice
   * (its own completion plus the sweep, or a timed-out step finishing after the
   * race gave up), and a counter bumped per event drifts. Reading the items is
   * the only source that cannot.
   *
   * The terminal write is an `updateMany` guarded on a non-terminal status, so
   * a parent the merchant cancelled or the reaper already failed is never
   * resurrected — the monotonic-finalizer shape the R4-DI9 note in
   * task-recovery.service.js asks for wherever a reaper's decision has to hold.
   */
  async settleParent(parentTaskId) {
    if (!parentTaskId) return;

    const parent = await db.task.findUnique({
      where: { id: parentTaskId },
      select: {
        id: true,
        shop: true,
        status: true,
        total: true,
        createdAt: true,
        resourceId: true,
      },
    });
    if (!parent || !WEBP_NON_TERMINAL_STATUS.includes(parent.status)) return;

    // `result: { contains: id }` is a prefilter — a cuid is unique enough to
    // make it selective, and `webpParentTaskId` then confirms the row really
    // names this parent rather than merely mentioning the string. Scoped to the
    // parent's own shop like every other query in this app, even though a cuid
    // could not collide across two of them.
    //
    // `createdAt` is what keeps this off the whole task history: `result` is an
    // unindexed TEXT column, so the `contains` is a `LIKE '%…%'` scan, and a
    // WebP row is created with no `expiresAt` and is therefore never swept by
    // the task cleanup — the item rows of a busy shop accumulate for good. The
    // route creates the aggregate row BEFORE its items, so every item of this
    // batch was written at or after `parent.createdAt`, and `[shop, createdAt]`
    // is an index. `resourceId` narrows further (a batch is one product) for
    // nothing but a cheaper comparison.
    const rows = await db.task.findMany({
      where: {
        shop: parent.shop,
        type: WEBP_ITEM_TASK_TYPE,
        createdAt: { gte: parent.createdAt },
        ...(parent.resourceId ? { resourceId: parent.resourceId } : {}),
        result: { contains: parentTaskId },
      },
      select: { id: true, status: true, result: true, error: true },
    });
    const items = rows.filter((row) => webpParentTaskId(row.result) === parentTaskId);

    if (items.length === 0) {
      // Created milliseconds ago, its items not committed yet — the run is
      // starting, not broken. Only an old parent with no items at all is a
      // batch that never started.
      if (Date.now() - new Date(parent.createdAt).getTime() < WEBP_PARENT_ORPHAN_GRACE_MS) {
        await this.touchParent(parentTaskId);
        return;
      }
      await db.task.updateMany({
        where: { id: parentTaskId, status: { in: WEBP_NON_TERMINAL_STATUS } },
        data: {
          status: "failed",
          progress: 100,
          completedAt: new Date(),
          error: "webp_batch_not_started",
        },
      });
      return;
    }

    const open = items.filter((item) => WEBP_NON_TERMINAL_STATUS.includes(item.status));
    const converted = items.filter((item) => item.status === "completed").length;
    const failed = items.length - open.length - converted;
    const total = parent.total ?? items.length;

    const failures = [];
    for (const item of items) {
      if (item.status === "completed" || WEBP_NON_TERMINAL_STATUS.includes(item.status)) continue;
      if (failures.length >= WEBP_FAILURE_LIST_MAX) break;
      const job = parseTaskResult(item.result) ?? {};
      failures.push({
        mediaId: typeof job.mediaId === "string" ? job.mediaId : null,
        position: typeof job.position === "number" ? job.position : null,
        // The item's own error can be a full stack (describeError keeps 2000
        // characters); the aggregate carries a line, not a post-mortem — the
        // item row is still there and still holds the whole thing.
        message: typeof item.error === "string" ? item.error.slice(0, WEBP_FAILURE_MESSAGE_MAX) : "",
      });
    }

    const result = JSON.stringify({ total, converted, failed, failures });

    if (open.length > 0) {
      // Still running: report progress and keep the row alive. `progress` on a
      // parent is percent-of-batch — it is NOT the per-image step boundary the
      // recovery reads, which is why that recovery only ever looks at items.
      const done = items.length - open.length;
      await db.task.updateMany({
        where: { id: parentTaskId, status: { in: WEBP_NON_TERMINAL_STATUS } },
        data: {
          processed: done,
          progress: total > 0 ? Math.min(99, Math.round((done / total) * 100)) : 0,
          result,
          updatedAt: new Date(),
        },
      });
      return;
    }

    await db.task.updateMany({
      where: { id: parentTaskId, status: { in: WEBP_NON_TERMINAL_STATUS } },
      data: {
        status: webpBatchStatus(converted, failed),
        progress: 100,
        processed: items.length,
        completedAt: new Date(),
        result,
        // A machine code, translated at render time (app/utils/task-error-text.ts
        // `images_failed`) — this runs outside any request and has no merchant
        // locale. A clean run clears any error a previous pass wrote.
        error: failed > 0 ? `images_failed:${failed}:${total}` : null,
      },
    });

    console.log(
      `[WebPProcessor] Batch ${parentTaskId} settled: ${converted} converted, ${failed} failed of ${total}`,
    );
  }

  /**
   * Keep a work item that IS progressing out of the stuck-task reaper.
   *
   * The reaper reads staleness, and the steps report progress at boundaries
   * that carry meaning (the <70/>=70 split the boot recovery reads), so a
   * stretch with no boundary in it is silent however hard the item is working
   * — step 8 makes one Shopify call per affected variant, up to a hundred of
   * them at 30s each. Reaped there, the item is failed and REFUNDED while its
   * conversion goes on to succeed, and the guarded completion write then has
   * to leave that wrong verdict standing. This bumps `updatedAt` and nothing
   * else: the progress value keeps its step meaning.
   *
   * It has no lifetime cap of its own, deliberately. Its reach is bounded by
   * the loop it sits in — one beat per affected variant, and the variant cache
   * stops at 100 (`hasMoreVariants`) — so the worst case is a work item held
   * open for the length of the work it is actually doing, roughly an hour if
   * every one of those calls burns its full 30s ceiling. That costs one of the
   * shop's concurrency slots and delays its batch; capping it instead would
   * put the reaper back on a LIVE conversion, refund an image that is about to
   * succeed and report it failed. Slow is the cheaper of the two.
   */
  async touchWorkItem(taskId) {
    await db.task
      .updateMany({
        where: { id: taskId, status: { in: WEBP_NON_TERMINAL_STATUS } },
        data: { updatedAt: new Date() },
      })
      .catch(() => {});
  }

  /** Keep an open batch out of the stuck-task reaper while its items work. */
  async touchParent(parentTaskId) {
    await db.task
      .updateMany({
        where: { id: parentTaskId, status: { in: WEBP_NON_TERMINAL_STATUS } },
        data: { updatedAt: new Date() },
      })
      .catch(() => {});
  }

  /**
   * One image. The aggregate row above it is settled on EVERY exit — the
   * `finally` covers the early returns for unusable job data just as much as a
   * finished conversion, because a parent whose last item died on a malformed
   * blob would otherwise stay open until the reaper timed it out.
   *
   * "Exit" now includes giving up on the WAIT (WEBP_TASK_TIMEOUT_MS): that
   * item is still open, so this settle reports progress and keeps the batch
   * running, which is what it is. The item's own terminal write later has no
   * settle beside it and needs none — `settleOpenParents` closes the batch on
   * the next poll, which is precisely the backstop it was written to be.
   */
  async processTask(task) {
    const parentTaskId = webpParentTaskId(task.result);
    try {
      await this._processTaskItem(task);
    } finally {
      if (parentTaskId) {
        await this.settleParent(parentTaskId).catch((err) =>
          console.error(`[WebPProcessor] Failed to settle conversion batch ${parentTaskId}:`, err),
        );
      }
    }
  }

  async _processTaskItem(task) {
    let taskData;
    try {
      taskData = JSON.parse(task.result || "{}");
    } catch {
      await this.failTask(task, "Invalid task data");
      return;
    }

    const { sourceUrl, productId } = taskData;
    if (!sourceUrl || !productId) {
      await this.failTask(task, "Missing sourceUrl or productId");
      return;
    }

    let timeoutTimer;
    try {
      await Promise.race([
        this._runWebpSteps(task, taskData),
        new Promise((_, reject) => {
          timeoutTimer = setTimeout(
            () => reject(new WebPItemAbandoned(`WebP task still running after ${WEBP_TASK_TIMEOUT_MS}ms`)),
            WEBP_TASK_TIMEOUT_MS,
          );
        }),
      ]);
    } catch (err) {
      if (err instanceof WebPItemAbandoned) {
        // Deliberately NO status write and NO refund: at this moment we have no
        // evidence either way, and the steps that DO have it are still running
        // and will write it themselves. Leaving the row `running` is also the
        // true statement — the conversion is in flight, the image manager's
        // spinner is right to keep spinning, and if the process dies here the
        // boot recovery still sees the progress it needs to classify the row.
        console.warn(
          `[WebPProcessor] Task ${task.id} ${err.message} — no longer waiting for it; its own steps, the stuck-task reaper or the boot recovery will settle it`,
        );
        return;
      }
      console.error(`[WebPProcessor] Task ${task.id} failed:`, err);
      await this.failTask(task, describeError(err));
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
        await this.failTask(task, "No valid session found for shop");
        return;
      }

      const accessToken = decryptToken(session.accessToken);
      if (!accessToken) {
        await this.failTask(task, "Failed to decrypt session access token");
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
        await this.failTask(task, `Staged upload HTTP ${stagedRes.status}: ${body}`);
        return;
      }
      const stagedData = await stagedRes.json();
      const userErrors = stagedData.data?.stagedUploadsCreate?.userErrors ?? [];
      if (userErrors.length > 0) {
        await this.failTask(task, `Staged upload userErrors: ${JSON.stringify(userErrors)}`);
        return;
      }
      const target = stagedData.data?.stagedUploadsCreate?.stagedTargets?.[0];

      if (!target) {
        console.error("[WebPProcessor] Unexpected stagedUploadsCreate response:", JSON.stringify(stagedData));
        await this.failTask(task, "Staged upload creation failed: no target returned");
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
        await this.failTask(task, `Create media HTTP ${createMediaRes.status}: ${body}`);
        return;
      }
      const createMediaData = await createMediaRes.json();
      const mediaUserErrors = createMediaData.data?.productCreateMedia?.mediaUserErrors ?? [];
      if (mediaUserErrors.length > 0) {
        await this.failTask(task, `Create media userErrors: ${JSON.stringify(mediaUserErrors)}`);
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
          // One Shopify call per variant, each with its own 30s ceiling and no
          // progress boundary between them — say we are alive before spending
          // another one (see touchWorkItem).
          await this.touchWorkItem(task.id);
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
      const closed = await this.completeWorkItem(task.id, {
        ...taskData,
        webpUrl: resolvedUrl ?? target.resourceUrl,
      });

      if (!closed) {
        console.warn(
          `[WebPProcessor] Task ${task.id} converted ${sourceUrl}, but the row was already closed by the reaper or the boot recovery — leaving that verdict (and its refund) standing`,
        );
        return;
      }

      console.log(`[WebPProcessor] Task ${task.id} completed: ${sourceUrl} → ${resolvedUrl ?? "(URL pending)"}`);
    } catch (err) {
      console.error(`[WebPProcessor] Task ${task.id} failed:`, err);
      await this.failTask(task, describeError(err));
    }
  }

  /**
   * Close ONE work item as converted. Answers whether this call is what closed
   * it.
   *
   * The mirror of `failTask`, and guarded for the same reason: the steps are
   * not the only writer on the row. The stuck-task reaper can fail an item
   * that went quiet for ten minutes — and REFUND its image operation — while
   * this sequence is still working, and the boot recovery can flag one whose
   * process died past the destructive step. An unguarded write here (what this
   * used to be) flipped such a row back to `completed` with the refund already
   * paid out and the batch above it already settled, terminally, on the other
   * verdict.
   *
   * So the first terminal write wins and this one reports the loss instead of
   * papering over it. When it loses, the image really is converted on Shopify
   * and the row says otherwise: that is the reaper's presumption standing, the
   * refund matches what the merchant was told, and the disagreement is with
   * Shopify rather than between our own two records of it.
   */
  async completeWorkItem(taskId, resultData) {
    const res = await db.task.updateMany({
      where: { id: taskId, status: { in: WEBP_NON_TERMINAL_STATUS } },
      data: {
        status: "completed",
        progress: 100,
        completedAt: new Date(),
        result: JSON.stringify(resultData),
      },
    });
    return res.count > 0;
  }

  /**
   * Fail ONE work item and give its image operation back.
   *
   * The invariant this maintains, and the reason the refund is welded to the
   * status write rather than sitting beside it: an outstanding refund exists
   * for exactly those work items whose recorded status is `failed`. So a
   * refund is paid if and only if THIS call is what performed the transition
   * into `failed` — `updateMany`'s count says whether it did, and a second
   * call, a reaper that got there first or a row somebody cancelled all report
   * zero and pay nothing.
   *
   * Takes the ROW, not an id: the shop has to come from something this call
   * already holds. Reading it back after the write means a lookup that can
   * fail on its own, and a failed row whose refund was skipped because a
   * SELECT blinked is the one direction the arithmetic may not err in.
   */
  async failTask(task, error) {
    const { id: taskId, shop } = task ?? {};
    if (!taskId || !shop) {
      // Loudly, never quietly: an id with no shop beside it would close the row
      // and skip its refund, which is the one direction this may not err in.
      console.error("[WebPProcessor] failTask needs the row (id + shop), got:", task);
      return;
    }

    const write = () =>
      db.task.updateMany({
        // Non-terminal ONLY. The older guard was `notIn: ["failed",
        // "completed"]`, which still matched `cancelled` and would turn a run
        // the merchant stopped into a failure — and pay a refund for it.
        //
        // Stated because it is a choice and not an oversight: a work item the
        // merchant CANCELLED therefore keeps its image operation. Cancelling
        // does not stop the conversion (this sequence runs to the end either
        // way, which is what keeps Shopify consistent), so the operation
        // really was spent, and the alternative — letting a failure overwrite
        // `cancelled` to get at the refund — undoes the one thing the merchant
        // asked for. Only a pre-split row of the parent type is reachable this
        // way at all: `app.tasks.tsx` hides `imageWebpConversionItem`, and the
        // parent row a merchant can cancel spent nothing of its own.
        where: { id: taskId, status: { in: WEBP_NON_TERMINAL_STATUS } },
        data: { status: "failed", completedAt: new Date(), error },
      });

    let flipped = 0;
    try {
      flipped = (await write()).count;
    } catch (err) {
      // One guarded retry, never an unguarded one: the fallback this replaces
      // wrote `failed` with no status precondition at all, so a transient DB
      // error on the first statement was enough to turn an already-completed
      // conversion into a failure. If the retry fails too, the row stays open
      // and the reaper settles it — with its own refund.
      console.error(`[WebPProcessor] Failed to close task ${taskId}, retrying:`, err);
      flipped = await write().then((res) => res.count).catch((retryErr) => {
        console.error(`[WebPProcessor] Could not close task ${taskId}:`, retryErr);
        return 0;
      });

      if (flipped === 0) {
        // The case the retry cannot tell apart on its own: the FIRST statement
        // committed and the client threw on the way back (a reset connection,
        // a pool timeout on the response), which looks exactly like a write
        // that never happened. The row is terminal now, so the reaper's
        // non-terminal selector never revisits it and nobody would ever pay
        // this refund — a `failed` item with no refund behind it, which is the
        // one direction the invariant above may not err in.
        //
        // The row carrying OUR error is the evidence. Every other verdict
        // names itself (the reaper's `task_timed_out`, the boot recovery's
        // "Server restarted at progress …"), and a SECOND failTask for this
        // row cannot reach this branch at all: its first statement would have
        // answered zero without throwing.
        const after = await db.task
          .findUnique({ where: { id: taskId }, select: { status: true, error: true } })
          .catch(() => null);
        if (after?.status === "failed" && after.error === error) {
          console.warn(`[WebPProcessor] Task ${taskId} was closed by the statement that threw — refunding it`);
          flipped = 1;
        }
      }
    }

    // Each work item consumed exactly one image operation at batch-creation
    // time; a failed conversion produced no result, so give the op back (N-H4).
    if (flipped > 0) {
      await refundImageOperations(db, shop, 1);
    }
  }
}
