/**
 * Structured Data (JSON-LD) — "Batch-Prüfung" action (Phase 5 of
 * PLAN_SEO_SUITE_COMPLETION.md §7).
 *
 * Same shape as seo-audit.handler.ts: a parent Task row is created up front
 * (single-flight guarded), then a detached runner does the actual work
 * (runJsonLdAudit, json-ld-audit.service.ts — pure DB-cache reads + the
 * existing structured-data builders/validator) and persists the aggregate
 * report into Task.result so app.seo.structured-data.tsx's "Batch-Prüfung"
 * sub-section can read a cached result instead of re-scanning on every visit.
 *
 * Non-AI task: the scan only reads the DB content cache plus ONE small live
 * Admin GraphQL call for shop name/domain/currency (not a catalog sweep —
 * see fetchShopContext below). It must never go through AIQueueService, and
 * (see api.ai.tsx's NON_AI_ACTIONS) is exempt from the route's "shop must
 * have an AI key" gate, matching seoAudit.
 */

import { data as json } from "react-router";
import type { AIActionContext } from "./shared";
import { errorMessage } from "./shared";
import { getTaskExpirationDate } from "~/config/constants";
import { logger } from "~/utils/logger.server";
import { getShopCurrencyCode } from "~/services/bulk-editor/load.server";
import { runJsonLdAudit, type JsonLdAuditAggregate } from "~/services/seo/json-ld-audit.service";
import type { ShopInfo } from "~/services/structured-data.service";
import type { PrismaClient } from "@prisma/client";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import type { DataResponse } from "~/types/data-response";

const SHOP_CONTEXT_QUERY = `#graphql
  query seoJsonLdAuditShop {
    shop {
      name
      primaryDomain { host }
    }
  }
`;

/** Shop name + storefront domain — the same small single call the
 *  structured-data preview route makes (fetchShopInfo there), duplicated
 *  here rather than imported since it lives in a route module. */
async function fetchShopContext(admin: AdminApiContext, fallbackShop: string): Promise<ShopInfo> {
  try {
    const res = await admin.graphql(SHOP_CONTEXT_QUERY);
    const j: any = await res.json();
    const s = j?.data?.shop;
    return {
      name: s?.name || fallbackShop.replace(/\.myshopify\.com$/, ""),
      domain: s?.primaryDomain?.host || fallbackShop,
    };
  } catch {
    return {
      name: fallbackShop.replace(/\.myshopify\.com$/, ""),
      domain: fallbackShop,
    };
  }
}

export async function handleSeoJsonLdAudit(ctx: AIActionContext): Promise<DataResponse> {
  const { session, admin, db } = ctx;

  // Single-flight: only one seoJsonLdAudit run per shop at a time.
  const runningTask = await db.task.findFirst({
    where: { shop: session.shop, type: "seoJsonLdAudit", status: "running" },
    select: { id: true },
  });
  if (runningTask) {
    return json(
      {
        success: false,
        code: "ALREADY_RUNNING",
        error: "A JSON-LD batch check is already running for this store. Check the Tasks tab for progress.",
        taskId: runningTask.id,
      },
      { status: 409 },
    );
  }

  const task = await db.task.create({
    data: {
      shop: session.shop,
      type: "seoJsonLdAudit",
      status: "running",
      resourceType: "seo",
      total: 1,
      processed: 0,
      progress: 0,
      expiresAt: getTaskExpirationDate(),
    },
  });

  // Fire-and-forget: survives navigation, same pattern as runSeoAudit.
  void runSeoJsonLdAuditTask(task.id, { db, admin, shop: session.shop }).catch((err: unknown) => {
    logger.error("[API-AI] JSON-LD batch audit crashed", {
      context: "AI",
      taskId: task.id,
      error: errorMessage(err),
    });
  });

  return json({ success: true, taskId: task.id });
}

// ─── Runner ────────────────────────────────────────────────────────────────

interface RunArgs {
  db: PrismaClient;
  admin: AdminApiContext;
  shop: string;
}

async function runSeoJsonLdAuditTask(taskId: string, args: RunArgs): Promise<void> {
  const { db, admin, shop } = args;

  try {
    const [shopInfo, currencyCode] = await Promise.all([
      fetchShopContext(admin, shop),
      getShopCurrencyCode(admin, shop),
    ]);

    const aggregate: JsonLdAuditAggregate = await runJsonLdAudit(shop, {
      db,
      shopInfo,
      currencyCode,
      // Heartbeat every 100 items (§7.3) — the Task.progress write itself is
      // the heartbeat the stuck-task reaper watches (contract §8).
      onProgress: async (processed, total) => {
        await db.task
          .update({
            where: { id: taskId },
            data: {
              total: total || 1,
              processed,
              progress: total > 0 ? Math.round((processed / total) * 100) : 0,
            },
          })
          .catch(() => {});
      },
    });

    await db.task.update({
      where: { id: taskId },
      data: {
        status: "completed",
        progress: 100,
        processed: aggregate.totalScanned,
        total: aggregate.totalScanned || 1,
        completedAt: new Date(),
        result: JSON.stringify(aggregate),
      },
    });
  } catch (err: unknown) {
    const message = errorMessage(err);
    logger.error("[API-AI] JSON-LD batch audit: scan failed", { context: "AI", taskId, error: message });
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
        logger.error("[API-AI] JSON-LD batch audit: failed to persist failure state", {
          context: "AI",
          taskId,
          error: errorMessage(updateErr),
        });
      });
  }
}
