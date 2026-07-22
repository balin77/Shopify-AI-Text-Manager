/**
 * Bulk editor — large-batch save action (docs/plans/PLAN_BULK_EDITOR.md §3).
 * The route itself (app.bulk.tsx) applies a diff of ≤MAX_SYNC_SAVE cells
 * synchronously; anything bigger is routed here instead, through the shared
 * /api/ai action (same trick seoBulkFix/seoAudit use to reuse that route's
 * Task/detached-runner plumbing).
 *
 * Handler file and task type keep their historical "seoBulkMeta" name even
 * though the editor moved to /app/bulk — renaming the task type would break
 * running tasks and LONG_RUNNING_TASK_TYPES (task-recovery.service.js); only
 * the i18n label under t.tasks.taskType.seoBulkMeta was updated (Plan §1.1).
 *
 * IMPORTANT: this is a non-AI task — applyBulkDiff only writes the cells
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
import { meetsPlan } from "~/utils/planUtils";
import { PLAN_CONFIG, type Plan } from "~/config/plans";
import {
  isValidBulkDiffEntry,
  BULK_ROW_TYPES,
  BULK_ROW_TYPE_TO_CONTENT_TYPE,
  MAX_BULK_TASK_ITEMS,
  type BulkDiffEntry,
  type BulkRowType,
  type ColumnDescriptor,
} from "~/services/bulk-editor/columns.shared";
import { buildServerColumnsByType } from "~/services/bulk-editor/columns.server";
import { applyBulkDiff } from "~/services/bulk-editor/apply.server";
import type { PrismaClient } from "@prisma/client";
import type { AdminApiContext } from "@shopify/shopify-app-remix/server";

export async function handleSeoBulkMeta(ctx: AIActionContext): Promise<Response> {
  const { session, admin, db, formData, settings } = ctx;

  // Plan gate (review W1): the bulk route enforces "basic" in its own
  // loader/action, but this handler is reachable directly via /api/ai — which
  // has no route-level plan gate AND exempts seoBulkMeta from the AI-key gate.
  // Without this check a free-plan shop could drive the Basic feature by
  // POSTing the diff here.
  const plan = (settings?.subscriptionPlan || "free") as Plan;
  if (!meetsPlan(plan, "basic")) {
    return json({ success: false, error: "This feature requires the Basic plan or higher." }, { status: 403 });
  }

  // Row types are additionally intersected with the plan's contentTypes
  // (Plan §3.4) — a Basic shop must not push article diffs through here.
  const planContentTypes = PLAN_CONFIG[plan].contentTypes as string[];
  const allowedTypes: BulkRowType[] = BULK_ROW_TYPES.filter((t) =>
    planContentTypes.includes(BULK_ROW_TYPE_TO_CONTENT_TYPE[t]),
  );

  const rawDiff = getFormJSON<unknown[]>(formData, "diff");
  if (!Array.isArray(rawDiff) || rawDiff.length === 0) {
    return json({ success: false, error: "No changes to save." }, { status: 400 });
  }
  // Server-built column universe (Plan §4.1): the mf.-column allowlist is
  // checked against the shop's ENABLED metafield definitions here — never
  // against whatever column ids the client claims exist.
  const columnsByType = await buildServerColumnsByType(db, session.shop, plan);
  if (!rawDiff.every((e) => isValidBulkDiffEntry(e, allowedTypes, columnsByType))) {
    return json({ success: false, error: "Invalid diff payload." }, { status: 400 });
  }
  const diff = rawDiff as BulkDiffEntry[];
  if (diff.length > MAX_BULK_TASK_ITEMS) {
    return json(
      { success: false, error: `A single save is limited to ${MAX_BULK_TASK_ITEMS} rows.` },
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
        error: "A bulk save is already running for this store. Check the Tasks tab for progress.",
        taskId: runningTask.id,
      },
      { status: 409 },
    );
  }

  // Rows, not cells — matches groupDiffByRow so `total` lines up with the
  // heartbeat's `processed` count in the runner below.
  const rowCount = new Set(diff.map((e) => `${e.rowType}|${e.rowId}|${e.locale}|${e.marketId}`)).size;

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
  void runSeoBulkMeta(task.id, { db, shop: session.shop, admin, diff, columnsByType }).catch((err: unknown) => {
    logger.error("[API-AI] Bulk-editor save crashed", {
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
  diff: BulkDiffEntry[];
  columnsByType: Record<BulkRowType, ColumnDescriptor[]>;
}

async function runSeoBulkMeta(taskId: string, args: RunArgs): Promise<void> {
  const { db, shop, admin, diff, columnsByType } = args;

  try {
    const result = await applyBulkDiff({ db, shop, admin, columnsByType }, diff, async (processed, total) => {
      const progressPercent = Math.round((processed / total) * 100);
      await db.task
        .update({ where: { id: taskId }, data: { progress: progressPercent, processed } })
        .catch((err: unknown) => {
          logger.error("[API-AI] Bulk-editor save: failed to persist progress", {
            context: "AI",
            taskId,
            error: errorMessage(err),
          });
        });
    });

    // Failures are per CELL since Phase 2 (Plan §4.4) — summarize per ROW so
    // the count lines up with `total`/`processed`.
    const failedRowCount = new Set(result.failures.map((f) => f.rowId)).size;
    const finalStatus = result.saved === 0 && failedRowCount > 0 ? "failed" : "completed";
    const failureSummary =
      failedRowCount > 0
        ? `${failedRowCount} of ${result.saved + failedRowCount} row(s) failed`
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
    logger.error("[API-AI] Bulk-editor save: run failed", { context: "AI", taskId, error: message });
    await db.task
      .update({
        where: { id: taskId },
        data: { status: "failed", progress: 100, completedAt: new Date(), error: message.substring(0, 1000) },
      })
      .catch((updateErr: unknown) => {
        logger.error("[API-AI] Bulk-editor save: failed to persist failure state", {
          context: "AI",
          taskId,
          error: errorMessage(updateErr),
        });
      });
  }
}
