/**
 * Starting a storefront crawl — the ONE entry point.
 *
 * Two callers reach a crawl: the merchant pressing "Jetzt scannen"
 * (api-ai-handlers/seo-crawl.handler.ts) and the weekly sweep on Max
 * (crawl-auto-run.service.ts). Everything that has to happen around `runCrawl`
 * — single-flight per shop, the parent Task row, snapshot retention, the
 * snapshot row itself, the external-link opt-out, the detached runner and the
 * failure bookkeeping — lives here rather than in the route, so the unattended
 * run cannot drift from the one a merchant watches.
 *
 * Non-AI: the crawl is a live storefront fetch, never a provider call.
 */

import { getTaskExpirationDate } from "~/config/constants";
import { logger } from "~/utils/logger.server";
import { runCrawl, pruneOldCrawlSnapshots } from "./crawl.service";
import type { PrismaClient } from "@prisma/client";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

const SHOP_CONTEXT_QUERY = `#graphql
  query seoCrawlShop {
    shop {
      name
      primaryDomain { host }
    }
  }
`;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function fetchCrawlShopContext(
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

export interface StartCrawlArgs {
  db: PrismaClient;
  admin: AdminApiContext;
  shop: string;
}

export type StartCrawlResult =
  | { started: true; taskId: string; snapshotId: string }
  | { started: false; reason: "alreadyRunning"; taskId: string };

/**
 * Start a crawl for one shop, unless one is already running.
 *
 * Single-flight is a hard rule for both callers: a second live crawl doubles
 * the request load on the merchant's own storefront, and the sweep must never
 * be the thing that starts it while a merchant is watching one run.
 */
export async function startCrawlRun(args: StartCrawlArgs): Promise<StartCrawlResult> {
  const { db, admin, shop } = args;

  const runningTask = await db.task.findFirst({
    where: { shop, type: "seoCrawl", status: "running" },
    select: { id: true },
  });
  if (runningTask) return { started: false, reason: "alreadyRunning", taskId: runningTask.id };

  const task = await db.task.create({
    data: {
      shop,
      type: "seoCrawl",
      status: "running",
      resourceType: "seo",
      total: 1,
      processed: 0,
      progress: 0,
      expiresAt: getTaskExpirationDate(),
    },
  });

  // Retention (§2): keep only the newest 5 snapshots per shop, BEFORE creating
  // the new one — cascade removes the pruned snapshots' pages/brokenLinks.
  await pruneOldCrawlSnapshots(db, shop).catch((err: unknown) => {
    logger.warn("[SeoCrawl] Failed to prune old snapshots (continuing)", {
      error: errorMessage(err),
    });
  });

  const snapshot = await db.seoCrawlSnapshot.create({ data: { shop, status: "running" } });

  // Fire-and-forget: survives navigation, same pattern as runSeoAudit.
  void runSeoCrawlTask(task.id, snapshot.id, { db, admin, shop }).catch((err: unknown) => {
    logger.error("[SeoCrawl] Crawl crashed", { taskId: task.id, error: errorMessage(err) });
  });

  return { started: true, taskId: task.id, snapshotId: snapshot.id };
}

export async function runSeoCrawlTask(
  taskId: string,
  snapshotId: string,
  args: StartCrawlArgs,
): Promise<void> {
  const { db, admin, shop } = args;

  try {
    const { name: shopName, primaryDomain } = await fetchCrawlShopContext(admin, shop);
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
      // Heartbeat (§3.5) — the Task.progress write itself is the heartbeat the
      // stuck-task reaper watches (contract §8).
      //
      // `percent` comes from `runCrawl` and is written verbatim. Deriving it
      // here from the page counts is what this used to do, against
      // `totalDiscovered` — a denominator that keeps growing with every link
      // seen, including the ones past the page cap that will never be
      // fetched. A capped crawl therefore reached a fixed percentage, stopped
      // moving, and stayed there through persistence and the external-link
      // pass: minutes of a bar that reads as a hung run rather than a
      // throttled one. `totalToCrawl` is the pages actually queued, so the
      // "X / Y" the tasks page shows now converges too.
      onProgress: async (pagesCrawled, totalToCrawl, percent) => {
        await db.task
          .update({
            where: { id: taskId },
            data: {
              processed: pagesCrawled,
              total: Math.max(totalToCrawl, pagesCrawled, 1),
              progress: Math.max(0, Math.min(100, Math.round(percent))),
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
    logger.error("[SeoCrawl] Run failed", { taskId, snapshotId, error: message });
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
        logger.error("[SeoCrawl] Failed to persist failure state", {
          taskId,
          error: errorMessage(updateErr),
        });
      });
  }
}
