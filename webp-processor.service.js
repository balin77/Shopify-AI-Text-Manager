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

async function downloadImageAsBuffer(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download image: ${response.status} ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

async function convertToWebP(sourceBuffer, quality = 85) {
  const buffer = await sharp(sourceBuffer).webp({ quality }).toBuffer();
  return { buffer, filename: `converted-${Date.now()}.webp` };
}

const db = new PrismaClient();

const POLL_INTERVAL_MS = 10000; // 10 seconds
const MAX_CONCURRENT = 2;

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
    const tasks = await db.task.findMany({
      where: {
        type: "imageWebpConversion",
        status: "pending",
      },
      take: MAX_CONCURRENT,
      orderBy: { createdAt: "asc" },
    });

    if (tasks.length === 0) return;

    await Promise.all(tasks.map(task => this.processTask(task)));
  }

  async processTask(task) {
    let taskData;
    try {
      taskData = JSON.parse(task.result || "{}");
    } catch {
      await this.failTask(task.id, "Invalid task data");
      return;
    }

    const { sourceUrl, mediaId, productImageId, productId } = taskData;
    if (!sourceUrl || !productId) {
      await this.failTask(task.id, "Missing sourceUrl or productId");
      return;
    }

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
      const { buffer, filename } = await convertToWebP(sourceBuffer);
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

      const shopifyApiUrl = `https://${task.shop}/admin/api/2025-04/graphql.json`;
      const headers = {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      };

      // 4. Create Shopify staged upload for WebP
      const stagedRes = await fetch(shopifyApiUrl, {
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
      });
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
      await fetch(target.url, {
        method: "PUT",
        headers: { "Content-Type": "image/webp", "Content-Length": String(buffer.byteLength) },
        body: buffer,
      });

      await db.task.update({ where: { id: task.id }, data: { progress: 75 } });

      // 6. Add new WebP as product media
      await fetch(shopifyApiUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          query: `
            mutation productUpdate($input: ProductInput!, $media: [CreateMediaInput!]) {
              productUpdate(input: $input, media: $media) {
                userErrors { field message }
              }
            }
          `,
          variables: {
            input: { id: productId },
            media: [{ originalSource: target.resourceUrl, mediaContentType: "IMAGE" }],
          },
        }),
      });

      await db.task.update({ where: { id: task.id }, data: { progress: 90 } });

      // 7. Delete old media from Shopify (if mediaId available)
      if (mediaId) {
        await fetch(shopifyApiUrl, {
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
        });
      }

      // 8. Update DB with new URL
      if (productImageId) {
        await db.productImage.update({
          where: { id: productImageId },
          data: { url: target.resourceUrl },
        }).catch(() => {}); // Ignore if record not found
      }

      // 9. Mark task as completed
      await db.task.update({
        where: { id: task.id },
        data: {
          status: "completed",
          progress: 100,
          completedAt: new Date(),
          result: JSON.stringify({
            ...taskData,
            webpUrl: target.resourceUrl,
          }),
        },
      });

      console.log(`[WebPProcessor] Task ${task.id} completed: ${sourceUrl} → ${target.resourceUrl}`);
    } catch (err) {
      console.error(`[WebPProcessor] Task ${task.id} failed:`, err);
      await this.failTask(task.id, String(err));
    }
  }

  async failTask(taskId, error) {
    await db.task.update({
      where: { id: taskId },
      data: { status: "failed", completedAt: new Date(), error },
    }).catch(() => {});
  }
}
