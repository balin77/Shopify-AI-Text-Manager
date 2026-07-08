/**
 * SEO Audit Dashboard — "Rescan" action.
 *
 * Runs the store-wide audit (analyzeStore, audit.service.ts) as a detached
 * Task, same shape as seo-bulk-fix.handler.ts / alt-text.handler.ts: a parent
 * Task row is created up front (single-flight guarded), then a detached
 * runner does the actual work and persists a SeoScoreSnapshot so the
 * dashboard loader can read a cached result instead of re-scanning on every
 * visit.
 *
 * IMPORTANT: this is a non-AI task — analyzeStore only reads the DB content
 * cache, no provider call is made. It must never go through AIQueueService,
 * and (see api.ai.tsx) it is exempt from the route's "shop must have an AI
 * key" gate, since a merchant with no AI key configured yet must still be
 * able to see/refresh their SEO score.
 */

import { json } from "@remix-run/node";
import type { AIActionContext } from "./shared";
import { errorMessage } from "./shared";
import { getTaskExpirationDate } from "~/config/constants";
import { logger } from "~/utils/logger.server";
import { analyzeStore } from "~/services/seo/audit.service";
import { saveAuditSnapshot } from "~/services/seo/audit.service";
import { seoTitleEffectiveLimit } from "~/utils/seo-score";
import type { Plan } from "~/config/plans";
import type { PrismaClient } from "@prisma/client";

export async function handleSeoAudit(ctx: AIActionContext): Promise<Response> {
  const { session, db, settings } = ctx;

  // Single-flight: only one seoAudit run per shop at a time — a second click
  // while one is in flight would just duplicate the scan and race the
  // snapshot write below.
  const runningTask = await db.task.findFirst({
    where: { shop: session.shop, type: "seoAudit", status: "running" },
    select: { id: true },
  });
  if (runningTask) {
    return json(
      {
        success: false,
        code: "ALREADY_RUNNING",
        error: "An SEO scan is already running for this store. Check the Tasks tab for progress.",
        taskId: runningTask.id,
      },
      { status: 409 },
    );
  }

  // Same settings resolution as the dashboard loader (app.seo._index.tsx) —
  // ctx.settings is already the full AISettings row (api.ai.tsx loads it
  // before dispatch), so no extra query is needed here.
  const plan = (settings?.subscriptionPlan || "free") as Plan;
  const suffix =
    settings?.seoTitleSuffixEnabled && settings.seoTitleSuffix ? settings.seoTitleSuffix : "";
  const effectiveLimit = seoTitleEffectiveLimit(suffix);

  const task = await db.task.create({
    data: {
      shop: session.shop,
      type: "seoAudit",
      status: "running",
      resourceType: "seo",
      total: 1,
      processed: 0,
      progress: 0,
      expiresAt: getTaskExpirationDate(),
    },
  });

  // Fire-and-forget: survives navigation, same pattern as runSeoBulkFix /
  // runBulkAltTextGeneration. This is one long unit of work (the scan itself),
  // not a per-item loop, so progress just heartbeats 50 -> 100 around it
  // rather than per-item increments.
  void runSeoAudit(task.id, {
    db,
    shop: session.shop,
    plan,
    seoTitleEffectiveLimit: effectiveLimit,
  }).catch((err: unknown) => {
    logger.error("[API-AI] SEO audit crashed", {
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
  shop: string;
  plan: Plan;
  seoTitleEffectiveLimit: number;
}

async function runSeoAudit(taskId: string, args: RunArgs): Promise<void> {
  const { db, shop, plan, seoTitleEffectiveLimit: effectiveLimit } = args;

  try {
    // Heartbeat before the scan starts — TaskRecoveryService's stuck-task
    // reaper keys off `updatedAt`, so this also proves the runner picked up
    // the task even if the scan itself takes a while on a large shop.
    await db.task.update({ where: { id: taskId }, data: { progress: 50 } });

    const audit = await analyzeStore(shop, { db, seoTitleEffectiveLimit: effectiveLimit, plan });
    await saveAuditSnapshot(db, shop, audit);

    await db.task.update({
      where: { id: taskId },
      data: {
        status: "completed",
        progress: 100,
        processed: 1,
        completedAt: new Date(),
        result: JSON.stringify({
          averageScore: audit.averageScore,
          totalScanned: audit.totalScanned,
          totalAvailable: audit.totalAvailable,
          capped: audit.capped,
        }),
      },
    });
  } catch (err: unknown) {
    const message = errorMessage(err);
    logger.error("[API-AI] SEO audit: scan failed", { context: "AI", taskId, error: message });
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
        logger.error("[API-AI] SEO audit: failed to persist failure state", {
          context: "AI",
          taskId,
          error: errorMessage(updateErr),
        });
      });
  }
}
