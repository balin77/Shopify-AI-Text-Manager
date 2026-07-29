/**
 * Internal Linking Suggestions — "Vorschläge generieren" action (Phase 2 of
 * PLAN_SEO_SUITE_COMPLETION.md §4.3).
 *
 * Same shape as seo-crawl.handler.ts / keyword-distribution.handler.ts: a
 * parent Task row is created up front (single-flight guarded, Pro-gated —
 * /api/ai has no route-level plan gate, so it must live here per the same
 * pattern as handleDistributeKeywords), then a detached runner
 * (runInternalLinkSuggestions, internal-links.service.ts) does the actual
 * work and persists SeoInternalLinkSuggestion rows the
 * app.seo.internal-links.tsx route reads back.
 *
 * Unlike seoCrawl/seoJsonLdAudit this DOES call AI (synonym batches — one
 * request per SYNONYM_BATCH_SIZE target items, capped; see
 * internal-links.service.ts's header) via AIService, which auto-wires
 * AIQueueService.enqueue() when constructed with a taskId (contract §8
 * pattern 4) — so it is NOT in api.ai.tsx's NON_AI_ACTIONS and goes through
 * the normal "shop must have an AI key" gate before this handler is even
 * reached.
 */

import { json } from "@remix-run/node";
import type { AIActionContext } from "./shared";
import { errorMessage, createAIService } from "./shared";
import { getTaskExpirationDate } from "~/config/constants";
import { logger } from "~/utils/logger.server";
import { meetsPlan } from "~/utils/planUtils";
import type { Plan } from "~/config/plans";
import { runInternalLinkSuggestions, HEARTBEAT_EVERY_SOURCES } from "~/services/seo/internal-links.service";
import type { InternalLinksSummary } from "~/services/seo/internal-links.service";
import type { PrismaClient, AISettings } from "@prisma/client";

export async function handleSeoInternalLinks(ctx: AIActionContext): Promise<Response> {
  const { session, db, settings } = ctx;

  // Pro-gate (plan §4.3) — same gate style as distributeKeywords.
  const plan = (settings?.subscriptionPlan || "free") as Plan;
  if (!meetsPlan(plan, "pro")) {
    return json({ success: false, error: "This feature requires the Pro plan or higher." }, { status: 403 });
  }

  // Single-flight: only one seoInternalLinks run per shop at a time.
  const runningTask = await db.task.findFirst({
    where: { shop: session.shop, type: "seoInternalLinks", status: "running" },
    select: { id: true },
  });
  if (runningTask) {
    return json(
      {
        success: false,
        code: "ALREADY_RUNNING",
        error: "Internal-link suggestions are already being generated for this store. Check the Tasks tab for progress.",
        taskId: runningTask.id,
      },
      { status: 409 },
    );
  }

  const task = await db.task.create({
    data: {
      shop: session.shop,
      type: "seoInternalLinks",
      status: "running",
      resourceType: "seo",
      total: 1,
      processed: 0,
      progress: 0,
      expiresAt: getTaskExpirationDate(),
    },
  });

  // Fire-and-forget: survives navigation, same pattern as runSeoCrawlTask.
  void runSeoInternalLinksTask(task.id, { db, shop: session.shop, settings }).catch((err: unknown) => {
    logger.error("[API-AI] Internal-link suggestions crashed", {
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
  settings: AISettings | null;
}

async function runSeoInternalLinksTask(taskId: string, args: RunArgs): Promise<void> {
  const { db, shop, settings } = args;

  try {
    const aiService = createAIService(settings, shop, taskId);

    const summary: InternalLinksSummary = await runInternalLinkSuggestions(shop, {
      db,
      // Wired through AIService (queued via AIQueueService.enqueue — contract
      // §8 pattern 4) rather than calling the queue directly; the DB-cache-
      // first service module itself stays AI-provider-agnostic. BATCHED: one
      // request per SYNONYM_BATCH_SIZE targets, with the anchors the merchant
      // already rejected for each target passed along so they aren't proposed
      // again.
      synonymProvider: (terms, locale, avoid) => aiService.generateSynonymsBatch(terms, locale, { avoid }),
      heartbeatEvery: HEARTBEAT_EVERY_SOURCES,
      onProgress: async (processed, total) => {
        await db.task
          .update({
            where: { id: taskId },
            data: {
              processed,
              total: Math.max(total, 1),
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
        processed: summary.sourcesScanned,
        total: Math.max(summary.sourcesScanned, 1),
        completedAt: new Date(),
        result: JSON.stringify(summary),
      },
    });
  } catch (err: unknown) {
    const message = errorMessage(err);
    logger.error("[API-AI] Internal-link suggestions: run failed", { context: "AI", taskId, error: message });
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
        logger.error("[API-AI] Internal-link suggestions: failed to persist failure state", {
          context: "AI",
          taskId,
          error: errorMessage(updateErr),
        });
      });
  }
}
