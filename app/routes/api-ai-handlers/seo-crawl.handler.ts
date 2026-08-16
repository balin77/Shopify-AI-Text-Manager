/**
 * Storefront crawler / site audit — "Jetzt scannen" action
 * (PLAN_SEO_SUITE_COMPLETION.md §3.5, Phase 1).
 *
 * Same shape as seo-audit.handler.ts / seo-json-ld-audit.handler.ts: a parent
 * Task row is created up front (single-flight guarded), then a detached
 * runner (runCrawl, crawl.service.ts) does the actual live crawl and
 * persists SeoCrawlPage/SeoCrawlBrokenLink rows + a SeoCrawlSnapshot the
 * app.seo.crawl.tsx route reads back.
 *
 * Non-AI task: the crawl is a live storefront fetch, never a provider call
 * — exempt from the route's "shop must have an AI key" gate (NON_AI_ACTIONS
 * in api.ai.tsx), matching seoAudit/seoJsonLdAudit.
 */

import { data as json } from "react-router";
import type { AIActionContext } from "./shared";
import { errorMessage } from "./shared";
import { getTaskExpirationDate } from "~/config/constants";
import { logger } from "~/utils/logger.server";
import { runCrawl, pruneOldCrawlSnapshots } from "~/services/seo/crawl.service";
import type { PrismaClient } from "@prisma/client";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import type { DataResponse } from "~/types/data-response";

const SHOP_CONTEXT_QUERY = `#graphql
  query seoCrawlShop {
    shop {
      name
      primaryDomain { host }
    }
  }
`;

async function fetchShopContext(
  admin: AdminApiContext,
  fallbackShop: string,
): Promise<{ name: string; primaryDomain: string }> {
  try {
    const res = await admin.graphql(SHOP_CONTEXT_QUERY);
    const j: any = await res.json();
    const s = j?.data?.shop;
    return {
      name: s?.name || fallbackShop.replace(/\.myshopify\.com$/, ""),
      primaryDomain: s?.primaryDomain?.host || fallbackShop,
    };
  } catch {
    return { name: fallbackShop.replace(/\.myshopify\.com$/, ""), primaryDomain: fallbackShop };
  }
}

export async function handleSeoCrawl(ctx: AIActionContext): Promise<DataResponse> {
  const { session, admin, db } = ctx;

  // Single-flight: only one seoCrawl run per shop at a time.
  const runningTask = await db.task.findFirst({
    where: { shop: session.shop, type: "seoCrawl", status: "running" },
    select: { id: true },
  });
  if (runningTask) {
    return json(
      {
        success: false,
        code: "ALREADY_RUNNING",
        error: "A site crawl is already running for this store. Check the Tasks tab for progress.",
        taskId: runningTask.id,
      },
      { status: 409 },
    );
  }

  const task = await db.task.create({
    data: {
      shop: session.shop,
      type: "seoCrawl",
      status: "running",
      resourceType: "seo",
      total: 1,
      processed: 0,
      progress: 0,
      expiresAt: getTaskExpirationDate(),
    },
  });

  // Retention (§2): keep only the newest 5 snapshots per shop, BEFORE
  // creating the new one — cascade removes the pruned snapshots' pages/
  // brokenLinks with them.
  await pruneOldCrawlSnapshots(db, session.shop).catch((err: unknown) => {
    logger.warn("[API-AI] SEO crawl: failed to prune old snapshots (continuing)", {
      context: "AI",
      error: errorMessage(err),
    });
  });

  const snapshot = await db.seoCrawlSnapshot.create({
    data: { shop: session.shop, status: "running" },
  });

  // Fire-and-forget: survives navigation, same pattern as runSeoAudit /
  // runSeoJsonLdAuditTask.
  void runSeoCrawlTask(task.id, snapshot.id, { db, admin, shop: session.shop }).catch((err: unknown) => {
    logger.error("[API-AI] SEO crawl crashed", {
      context: "AI",
      taskId: task.id,
      error: errorMessage(err),
    });
  });

  return json({ success: true, taskId: task.id, snapshotId: snapshot.id });
}

// ─── Runner ────────────────────────────────────────────────────────────────

interface RunArgs {
  db: PrismaClient;
  admin: AdminApiContext;
  shop: string;
}

async function runSeoCrawlTask(taskId: string, snapshotId: string, args: RunArgs): Promise<void> {
  const { db, admin, shop } = args;

  try {
    const { name: shopName, primaryDomain } = await fetchShopContext(admin, shop);
    const appUrl = (process.env.SHOPIFY_APP_URL || "https://localhost:3000").replace(/\/+$/, "");

    // §6.5 — opt-out for the external-link pass. Absent settings row = default
    // ON, matching the column default.
    const settings = await db.aISettings.findUnique({
      where: { shop },
      select: { seoCrawlExternalLinks: true },
    });
    const checkExternalLinks = settings?.seoCrawlExternalLinks ?? true;

    const summary = await runCrawl(snapshotId, {
      db,
      shop,
      primaryDomain,
      myshopifyDomain: shop,
      shopName,
      appUrl,
      checkExternalLinks,
      // Heartbeat every 25 pages (§3.5) — the Task.progress write itself is
      // the heartbeat the stuck-task reaper watches (contract §8). Total is
      // unknown up front (a live crawl, not a fixed catalog scan), so the
      // progress bar shows pages-crawled-so-far rather than a percentage.
      onProgress: async (pagesCrawled, totalDiscovered) => {
        await db.task
          .update({
            where: { id: taskId },
            data: {
              processed: pagesCrawled,
              total: Math.max(totalDiscovered, pagesCrawled, 1),
              progress:
                totalDiscovered > 0 ? Math.min(100, Math.round((pagesCrawled / totalDiscovered) * 100)) : 0,
            },
          })
          .catch(() => {});
      },
    });

    await db.seoCrawlSnapshot.update({
      where: { id: snapshotId },
      data: {
        status: summary.status,
        error: summary.error ?? null,
        finishedAt: new Date(),
        pagesCrawled: summary.pagesCrawled,
        totalDiscovered: summary.totalDiscovered,
        pagesOk: summary.pagesOk,
        pagesBroken: summary.pagesBroken,
        orphanCount: summary.orphanCount,
        headDriftCount: summary.headDriftCount,
      },
    });

    const taskFailed = summary.status === "failed";
    await db.task.update({
      where: { id: taskId },
      data: {
        status: taskFailed ? "failed" : "completed",
        progress: 100,
        processed: summary.pagesCrawled,
        completedAt: new Date(),
        error: taskFailed ? summary.error || "crawl_failed" : null,
        result: JSON.stringify(summary),
      },
    });
  } catch (err: unknown) {
    const message = errorMessage(err);
    logger.error("[API-AI] SEO crawl: run failed", { context: "AI", taskId, snapshotId, error: message });
    await db.seoCrawlSnapshot
      .update({
        where: { id: snapshotId },
        data: { status: "failed", error: message.substring(0, 500), finishedAt: new Date() },
      })
      .catch(() => {});
    await db.task
      .update({
        where: { id: taskId },
        data: {
          status: "failed",
          progress: 100,
          completedAt: new Date(),
          error: message.substring(0, 1000),
        },
      })
      .catch((updateErr: unknown) => {
        logger.error("[API-AI] SEO crawl: failed to persist failure state", {
          context: "AI",
          taskId,
          error: errorMessage(updateErr),
        });
      });
  }
}
