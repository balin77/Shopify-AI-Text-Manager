/**
 * Manual bulk-meta editor — large-batch save action (SEO_TAB_IMPLEMENTATION_PLAN.md
 * Anhang C3). The route itself (app.seo.bulk-meta.tsx) applies a diff of
 * ≤MAX_SYNC_SAVE rows synchronously; anything bigger is routed here instead,
 * through the shared /api/ai action (same trick seoBulkFix/seoAudit use to
 * reuse that route's Task/detached-runner plumbing).
 *
 * IMPORTANT: this is a non-AI task — applyBulkMetaDiff only writes the fields
 * the merchant actually typed, no provider call is made. It must never go
 * through AIQueueService, and (see api.ai.tsx) it is exempt from the route's
 * "shop must have an AI key" gate, same as seoAudit.
 */

import { json } from "@remix-run/node";
import type { AIActionContext } from "./shared";
import { errorMessage } from "./shared";
import { getFormJSON } from "~/utils/form-data.utils";
import { getTaskExpirationDate } from "~/config/constants";
import { logger } from "~/utils/logger.server";
import { isValidShopifyGID } from "~/utils/validation";
import { meetsPlan } from "~/utils/planUtils";
import type { Plan } from "~/config/plans";
import {
  applyBulkMetaDiff,
  BULK_META_FIELDS,
  BULK_META_TYPES,
  MAX_BULK_META_TASK_ITEMS,
  type BulkMetaDiffEntry,
} from "~/services/seo/bulk-meta.service";
import type { PrismaClient } from "@prisma/client";
import type { AdminApiContext } from "@shopify/shopify-app-remix/server";

function isValidDiffEntry(e: unknown): e is BulkMetaDiffEntry {
  if (!e || typeof e !== "object") return false;
  const entry = e as Record<string, unknown>;
  return (
    typeof entry.id === "string" &&
    isValidShopifyGID(entry.id) &&
    typeof entry.type === "string" &&
    (BULK_META_TYPES as string[]).includes(entry.type) &&
    typeof entry.field === "string" &&
    (BULK_META_FIELDS as string[]).includes(entry.field) &&
    typeof entry.value === "string"
  );
}

export async function handleSeoBulkMeta(ctx: AIActionContext): Promise<Response> {
  const { session, admin, db, formData, settings } = ctx;

  // Plan gate (review W1): the bulk-meta route enforces "basic" in its own
  // loader/action, but this handler is reachable directly via /api/ai — which
  // has no route-level plan gate AND exempts seoBulkMeta from the AI-key gate.
  // Without this check a free-plan shop could drive the Basic feature by
  // POSTing the diff here.
  const plan = (settings?.subscriptionPlan || "free") as Plan;
  if (!meetsPlan(plan, "basic")) {
    return json({ success: false, error: "This feature requires the Basic plan or higher." }, { status: 403 });
  }

  const rawDiff = getFormJSON<unknown[]>(formData, "diff");
  if (!Array.isArray(rawDiff) || rawDiff.length === 0) {
    return json({ success: false, error: "No changes to save." }, { status: 400 });
  }
  if (!rawDiff.every(isValidDiffEntry)) {
    return json({ success: false, error: "Invalid diff payload." }, { status: 400 });
  }
  const diff = rawDiff as BulkMetaDiffEntry[];
  if (diff.length > MAX_BULK_META_TASK_ITEMS) {
    return json(
      { success: false, error: `A single save is limited to ${MAX_BULK_META_TASK_ITEMS} rows.` },
      { status: 400 },
    );
  }

  // Single-flight: only one seoBulkMeta run per shop at a time — a second
  // click while one is in flight would race the same DB/Shopify writes.
  const runningTask = await db.task.findFirst({
    where: { shop: session.shop, type: "seoBulkMeta", status: "running" },
    select: { id: true },
  });
  if (runningTask) {
    return json(
      {
        success: false,
        code: "ALREADY_RUNNING",
        error: "A bulk-meta save is already running for this store. Check the Tasks tab for progress.",
        taskId: runningTask.id,
      },
      { status: 409 },
    );
  }

  // Rows, not fields — matches groupDiffByRow so `total` lines up with the
  // heartbeat's `processed` count in the runner below.
  const rowCount = new Set(diff.map((e) => `${e.type}:${e.id}`)).size;

  const task = await db.task.create({
    data: {
      shop: session.shop,
      type: "seoBulkMeta",
      status: "running",
      resourceType: "seo",
      fieldType: "all",
      total: rowCount,
      processed: 0,
      progress: 0,
      expiresAt: getTaskExpirationDate(),
    },
  });

  // Fire-and-forget: survives navigation, same pattern as runSeoBulkFix /
  // runBulkAltTextGeneration. Progress/results persist to Task after every
  // row (heartbeat), so a crash only loses the in-flight row.
  void runSeoBulkMeta(task.id, { db, shop: session.shop, admin, diff }).catch((err: unknown) => {
    logger.error("[API-AI] SEO bulk-meta crashed", {
      context: "AI",
      taskId: task.id,
      error: errorMessage(err),
    });
  });

  return json({ success: true, taskId: task.id, total: rowCount });
}

// ─── Runner ────────────────────────────────────────────────────────────────

interface RunArgs {
  db: PrismaClient;
  shop: string;
  admin: AdminApiContext;
  diff: BulkMetaDiffEntry[];
}

async function runSeoBulkMeta(taskId: string, args: RunArgs): Promise<void> {
  const { db, shop, admin, diff } = args;

  try {
    const result = await applyBulkMetaDiff({ db, shop, admin }, diff, async (processed, total) => {
      const progressPercent = Math.round((processed / total) * 100);
      await db.task
        .update({ where: { id: taskId }, data: { progress: progressPercent, processed } })
        .catch((err: unknown) => {
          logger.error("[API-AI] SEO bulk-meta: failed to persist progress", {
            context: "AI",
            taskId,
            error: errorMessage(err),
          });
        });
    });

    const finalStatus = result.saved === 0 && result.failures.length > 0 ? "failed" : "completed";
    const failureSummary =
      result.failures.length > 0
        ? `${result.failures.length} of ${result.saved + result.failures.length} row(s) failed`
        : null;

    await db.task.update({
      where: { id: taskId },
      data: {
        status: finalStatus,
        progress: 100,
        completedAt: new Date(),
        result: JSON.stringify(result),
        error: failureSummary ? failureSummary.substring(0, 1000) : null,
      },
    });
  } catch (err: unknown) {
    const message = errorMessage(err);
    logger.error("[API-AI] SEO bulk-meta: run failed", { context: "AI", taskId, error: message });
    await db.task
      .update({
        where: { id: taskId },
        data: { status: "failed", progress: 100, completedAt: new Date(), error: message.substring(0, 1000) },
      })
      .catch((updateErr: unknown) => {
        logger.error("[API-AI] SEO bulk-meta: failed to persist failure state", {
          context: "AI",
          taskId,
          error: errorMessage(updateErr),
        });
      });
  }
}
