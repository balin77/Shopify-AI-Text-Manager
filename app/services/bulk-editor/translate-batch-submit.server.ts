/**
 * SUBMIT half of the Batch-API mode of "add missing translations"
 * (PLAN_BULK_TRANSLATE_BATCHING 5.3 / 6.3), Anthropic.
 *
 * A detached run, started by the handler right after it claimed the Task. It
 * does what the live run does up to the point where the live run would start
 * asking the model, and then hands the whole job to the provider instead:
 *
 *   plan-time read (live text + Shopify digests)  ->  packages (the SAME planner
 *   the live package phase uses, with the batch output cap)  ->  the gate
 *   (consent, kill switch, budget, pool -- once)  ->  INTENT record  ->
 *   reservation of the worst case  ->  provider create  ->  batch id stored
 *   unconditionally  ->  Task `waiting_batch`.
 *
 * Rules that carry it, each a direction of error:
 *  - The order is fixed so a crash at any point leaves something the sweeps
 *    understand: the intent row exists BEFORE the provider call (a `submitting`
 *    row with no batch id is failed `task_interrupted` and its hold released),
 *    the reservation exists before money can be spent, and the batch id is
 *    written WITHOUT a status condition so a Task somebody changed meanwhile
 *    cannot lose it.
 *  - If the Task is no longer ours when the id comes back (cancelled, deleted,
 *    failed by recovery) the batch is cancelled at the provider AT ONCE, through
 *    the settlement transport, and the hold settled.
 *  - The worst case is reserved at the BATCH tier: sum of (estimated input +
 *    the max_tokens actually SENT) priced with the model's published batch
 *    factor. A managed shop whose remaining budget or the global pool cannot
 *    cover it is refused (`budgetExceeded` / `managedUnavailable`) before
 *    anything is created; a taster shop gets no batch at all.
 *  - NOTHING here writes a translation. Verification and writing happen at
 *    collect time, through the same fill-only write path as the live run.
 *
 * Never throws: every outcome ends in a Task status and a batch-row state.
 */

import type { PrismaClient, AISettings } from "@prisma/client";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { AIService, isManagedRefusal, type AiBatchRequest } from "../../../src/services/ai.service";
import { aiServiceFor } from "../ai/ai-credentials.server";
import { priceCall } from "~/config/ai-pricing";
import {
  TASK_STATUS_SUBMITTING,
  TASK_STATUS_WAITING_BATCH,
} from "~/config/task-statuses.js";
import { logger } from "~/utils/logger.server";
import { errorMessage } from "~/routes/api-ai-handlers/shared";
import { ShopifyApiGateway } from "../shopify-api-gateway.service";
import { planCellKey, planTranslateRead } from "./translate-plan-read.server";
import {
  buildPackagePlan,
  packageCellKey,
  type PackagePlanDeps,
} from "./translate-package-phase.server";
import {
  PACKAGE_OUTPUT_CAP_BATCH,
  packageBudgetFor,
  packagePlannedOutputTokens,
  packageTimeoutMs,
} from "./translate-packages.shared";
import {
  BATCH_MAX_PROMPT_BYTES,
  BATCH_MAX_REQUESTS,
  batchCustomId,
  batchIdPrefix,
  itemSignature,
  serializeManifest,
  sourceHash,
  type BatchManifest,
  type BatchManifestCell,
  type BatchManifestRequest,
} from "./translate-batch.shared";
import type { BulkRowType } from "./columns.shared";
import type { TranslateJob } from "~/routes/api-ai-handlers/bulk-editor-translate.handler";

/** A Task whose batch row is older than this on its own heartbeat is reaped like any run. */
export const SUBMIT_HEARTBEAT_MS = 15_000;

export interface SubmitArgs {
  db: PrismaClient;
  shop: string;
  admin: AdminApiContext;
  settings: AISettings | null;
  jobs: TranslateJob[];
  units: number;
  rowType: BulkRowType;
  moType: string;
  primaryLocale: string;
  contentType: string;
  targetLocales: string[];
  instructionsFor: (fieldKeys: string[]) => string | undefined;
  classifiers: Omit<PackagePlanDeps, "jobs" | "instructionsFor">;
  /** TEST SEAMS. */
  service?: AIService;
}

export type SubmitOutcome =
  | { ok: true; batchRowId: string; batchId: string; requests: number; carriedUnits: number; notStarted: number }
  | { ok: false; code: string };

/** Machine code -> Task.error. A provider's own words ride after the first colon (bounded, scrubbed of newlines). */
function refusedCode(message: string): string {
  const clean = message.replace(/\s+/g, " ").trim().slice(0, 200);
  return clean ? `batch_submit_refused:${clean}` : "batch_submit_refused";
}

export async function submitBulkTranslateBatch(taskId: string, args: SubmitArgs): Promise<SubmitOutcome> {
  const { db, shop } = args;
  let batchRowId: string | null = null;

  const beat = setInterval(() => {
    void db.task
      .updateMany({
        where: { id: taskId, status: { in: ["running", TASK_STATUS_SUBMITTING] } },
        data: { updatedAt: new Date() },
      })
      .catch(() => undefined);
  }, SUBMIT_HEARTBEAT_MS);

  /** End the run as failed: Task + batch row + the hold. Never throws. */
  const fail = async (code: string, detail?: string): Promise<SubmitOutcome> => {
    logger.warn("[BulkTranslateBatch] Submit ended without a batch", { context: "AI", taskId, code, detail });
    try {
      await db.task.updateMany({
        where: { id: taskId, status: { in: ["running", TASK_STATUS_SUBMITTING] } },
        data: { status: "failed", progress: 100, completedAt: new Date(), error: code.substring(0, 1000) },
      });
      if (batchRowId) {
        await db.bulkTranslateBatch.updateMany({
          where: { id: batchRowId, state: "submitting" },
          data: { state: "done", lastError: (detail ?? code).substring(0, 500) },
        });
        const { releaseBudget } = await import("../ai/usage-meter.server");
        await releaseBudget(batchRowId);
      }
    } catch (error) {
      logger.error("[BulkTranslateBatch] Could not record a failed submit", { context: "AI", taskId, error: errorMessage(error) });
    }
    return { ok: false, code };
  };

  try {
    // 0. The claim made the Task `running`; from here it is `submitting`, the
    //    state that holds the single-flight AND is recovered (not failed) when
    //    the process dies after the provider accepted the batch.
    const entered = await db.task.updateMany({
      where: { id: taskId, status: "running" },
      data: { status: TASK_STATUS_SUBMITTING },
    });
    if (entered.count === 0) return { ok: false, code: "task_not_ours" };

    // 1. Plan-time read: what is the primary text NOW, and which digests the
    //    write will be held to. Drops cells whose text moved.
    const plan = await planTranslateRead(
      { db, shop, gateway: new ShopifyApiGateway(args.admin, shop), rowType: args.rowType },
      args.jobs,
    );
    const planFailedUnits = plan.failures.reduce((n, f) => n + f.units, 0);

    // 2. The service (the normal resolver: managed gate or the merchant's key).
    const service = args.service ?? aiServiceFor(args.settings, shop, taskId).service;
    const limits = service.packageLimits();
    if (!AIService.batchSupportedFor(limits.provider)) return await fail("batch_not_available", "provider");

    // 3. Packages: the live planner, the batch output cap, no per-minute rail
    //    (a batch is admitted by the provider, not by our queue).
    const budget = packageBudgetFor({
      modelMaxOutput: limits.maxOutputTokens,
      bucketTpm: null,
      outputCap: PACKAGE_OUTPUT_CAP_BATCH,
    });
    const planned = buildPackagePlan({ jobs: plan.jobs, instructionsFor: args.instructionsFor, ...args.classifiers }, budget);

    const idPrefix = batchIdPrefix(taskId);
    const requests: AiBatchRequest[] = [];
    const manifestRequests: BatchManifestRequest[] = [];
    const includedOwners = new Set<string>();
    let promptBytes = 0;
    for (const pkg of planned.plan.packages) {
      if (requests.length >= BATCH_MAX_REQUESTS) break;
      const built = await service.buildBatchRequest(batchCustomId(idPrefix, requests.length), {
        kind: pkg.kind,
        fromLang: args.primaryLocale,
        locales: pkg.items[0]?.locales ?? pkg.locales,
        items: pkg.items.map((item, i) => ({
          id: `k${i + 1}`,
          text: item.source,
          ...(item.context ? { context: item.context } : {}),
        })),
        contentType: args.contentType,
        instructions: pkg.instructions,
        plannedOutputTokens: packagePlannedOutputTokens(pkg),
        timeoutMs: packageTimeoutMs(packagePlannedOutputTokens(pkg)),
      });
      promptBytes += Buffer.byteLength(built.prompt, "utf8");
      if (promptBytes > BATCH_MAX_PROMPT_BYTES) break;
      requests.push(built);
      manifestRequests.push({
        customId: built.customId,
        kind: pkg.kind,
        items: pkg.items.map((item) => itemSignature({ kind: item.kind, source: item.source })),
        maxTokens: built.maxTokens,
        inputEstimate: built.inputEstimateTokens,
      });
      for (const item of pkg.items) for (const owner of item.owners) includedOwners.add(owner);
    }

    // A cell is carried only when EVERY part of it rides in an included package.
    const cells: BatchManifestCell[] = [];
    let carriedUnits = 0;
    let notStarted = 0;
    for (const job of plan.jobs) {
      for (const cell of job.cells) {
        const key = packageCellKey(job, cell);
        const owners = planned.built.partsOf.get(key);
        const carried = !!owners && !planned.excluded.has(key) && owners.every((o) => includedOwners.has(o));
        if (!carried) {
          notStarted += cell.locales.length;
          continue;
        }
        carriedUnits += cell.locales.length;
        const expected = plan.expected.get(planCellKey(job.rowId, cell.column.id));
        cells.push({
          r: job.rowId,
          c: cell.column.id,
          l: cell.locales,
          h: sourceHash(cell.source),
          ...(expected ? { e: expected } : {}),
        });
      }
    }
    if (requests.length === 0 || cells.length === 0) {
      // Nothing the provider can do for this selection (everything dropped at the plan, or only
      // cells that fit no package): not a failure of the merchant's shop -- "Sofort" can still try.
      return await fail("batch_nothing_to_submit");
    }

    // 4. The gate, ONCE, before anything is reserved or sent: consent, kill switch, shop budget, pool.
    let gate: Awaited<ReturnType<AIService["batchGate"]>>;
    try {
      gate = await service.batchGate();
    } catch (error) {
      if (isManagedRefusal(error)) return await fail(error.message);
      return await fail(refusedCode(errorMessage(error)), errorMessage(error));
    }
    const managed = gate.source === "managed";
    if (managed && gate.pool === "taster") return await fail("batch_not_available", "taster");

    // 5. The worst case: sum of (input estimate + the max_tokens SENT), at the batch tier.
    const sumIn = requests.reduce((n, r) => n + r.inputEstimateTokens, 0);
    const sumMax = requests.reduce((n, r) => n + r.maxTokens, 0);
    const reserveMicros = priceCall(gate.provider, gate.model, sumIn, sumMax, { tier: "batch" }).costMicros;

    const { currentAiUsagePeriod, reserveBudget } = await import("../ai/usage-meter.server");
    const { globalPoolPeriod, globalPoolStatus } = await import("../ai/managed-global-pool.server");
    if (managed) {
      // Remaining budget and pool must COVER the worst case (a single call only needs `remaining > 0`;
      // a batch starts thousands at once, so the whole amount is checked up front).
      const { managedBudgetStatus } = await import("../ai/managed-budget.server");
      const status = await managedBudgetStatus(
        shop,
        args.settings,
        (args.settings?.subscriptionPlan ?? "free") as never,
      );
      if (status.kind === "taster") return await fail("batch_not_available", "taster");
      if (status.readFailed || status.unavailable) return await fail("managed_ai_refused:managedUnavailable");
      if (!status.allowed || status.remainingMicros < reserveMicros) return await fail("managed_ai_refused:budgetExceeded");
      const pool = await globalPoolStatus(gate.pool ?? "paid", globalPoolPeriod());
      if (!pool.allowed || (pool.limitMicros !== null && pool.limitMicros - pool.spentMicros < reserveMicros)) {
        return await fail("managed_ai_refused:managedUnavailable");
      }
    }

    // 6. INTENT record, before the provider call: the row a crash leaves behind is what the recovery
    //    and the orphan sweep understand. The manifest rides along (the collect step needs it).
    const manifest: BatchManifest = {
      v: 1,
      rowType: args.rowType,
      moType: args.moType,
      locales: args.targetLocales,
      primaryLocale: args.primaryLocale,
      units: args.units,
      cells,
      requests: manifestRequests,
      plan: {
        skippedChanged: plan.skippedChanged,
        failures: plan.failures.map((f) => ({ rowId: f.rowId, columnId: f.columnId, message: f.message, units: f.units })),
        mismatchesByKey: plan.mismatchesByKey ?? {},
        notStarted,
      },
      submittedAt: new Date().toISOString(),
    };
    const row = await db.bulkTranslateBatch.create({
      data: {
        taskId,
        shop,
        state: "submitting",
        provider: gate.provider,
        model: gate.model,
        source: gate.source,
        role: gate.role,
        period: gate.period ?? (managed ? "" : currentAiUsagePeriod()),
        pool: managed ? (gate.pool ?? "") : "",
        poolPeriod: managed ? globalPoolPeriod() : "",
        idPrefix,
        intentAt: new Date(),
        manifest: serializeManifest(manifest),
      },
    });
    batchRowId = row.id;
    await db.task.updateMany({
      where: { id: taskId, status: TASK_STATUS_SUBMITTING },
      data: {
        provider: gate.provider,
        aiModel: gate.model,
        processed: plan.skippedChanged + planFailedUnits,
        total: args.units,
      },
    });

    // 7. RESERVE (managed only), before money can be spent. A reservation that cannot be written
    //    refuses the submit: an unprotected batch is exactly what the reservation exists to prevent.
    if (managed) {
      const reserved = await reserveBudget(row.id, { billedMicros: reserveMicros });
      if (!reserved.applied) return await fail(refusedCode(`reservation:${reserved.reason}`), `reservation:${reserved.reason}`);
    }

    // 8. The provider create. Never retried (a create that failed AFTER the provider accepted it
    //    would make a second batch).
    let created: { batchId: string; expiresAt: string | null };
    try {
      created = await service.createBatch(requests);
    } catch (error) {
      if (isManagedRefusal(error)) return await fail(error.message);
      return await fail(refusedCode(errorMessage(error)), errorMessage(error));
    }

    // 9. The batch id is written UNCONDITIONALLY (no status in the where): the Task row may have
    //    been touched meanwhile, and the id is the only handle on a paid batch.
    let idStored = false;
    for (let attempt = 0; attempt < 3 && !idStored; attempt++) {
      try {
        await db.bulkTranslateBatch.update({ where: { id: row.id }, data: { batchIds: [created.batchId] } });
        idStored = true;
      } catch (error) {
        logger.error("[BulkTranslateBatch] Could not store the batch id", { context: "AI", taskId, attempt, error: errorMessage(error) });
      }
    }
    const expiresAtMs = created.expiresAt ? Date.parse(created.expiresAt) : NaN;
    const taskExpires = new Date((Number.isFinite(expiresAtMs) ? expiresAtMs : Date.now() + 24 * 3600 * 1000) + 3 * 24 * 3600 * 1000);
    const flipped = idStored
      ? await db.task.updateMany({
          where: { id: taskId, status: TASK_STATUS_SUBMITTING },
          data: { status: TASK_STATUS_WAITING_BATCH, expiresAt: taskExpires },
        })
      : { count: 0 };

    if (!idStored || flipped.count === 0) {
      // The Task is no longer ours (cancelled, deleted, failed by recovery) -- or the id could not be
      // kept: the batch must not run unattended. Cancel it NOW through the settlement transport.
      const confirmed = await cancelAtOnce(shop, row.id, created.batchId);
      await db.bulkTranslateBatch.updateMany({
        where: { id: row.id, state: "submitting" },
        data: { state: "done", lastError: idStored ? "task_not_ours" : "batch_id_not_stored" },
      });
      const { releaseBudget, convertReservation } = await import("../ai/usage-meter.server");
      // Unconfirmed cancel: the batch may still bill -> the hold becomes the charge.
      await (confirmed ? releaseBudget : convertReservation)(row.id);
      return { ok: false, code: "task_not_ours" };
    }

    await db.bulkTranslateBatch.updateMany({ where: { id: row.id, state: "submitting" }, data: { state: "waiting" } });
    logger.info("[BulkTranslateBatch] Batch submitted", {
      context: "AI",
      taskId,
      requests: requests.length,
      cells: cells.length,
      reservedMicros: managed ? reserveMicros : 0,
    });
    return { ok: true, batchRowId: row.id, batchId: created.batchId, requests: requests.length, carriedUnits, notStarted };
  } catch (error) {
    return await fail(refusedCode(errorMessage(error)), errorMessage(error));
  } finally {
    clearInterval(beat);
  }
}

/** Cancel one provider batch through the settlement transport; true when the provider confirmed. Never throws. */
async function cancelAtOnce(shop: string, batchRowId: string, batchId: string): Promise<boolean> {
  try {
    const { settlementCredentialsFor } = await import("../ai/ai-credentials.server");
    // The row exists, but its `batchIds` may not (the id could not be stored): the allowlist is built from the
    // row, so make sure it names this batch before asking.
    const { db } = await import("~/db.server");
    await db.bulkTranslateBatch.updateMany({ where: { id: batchRowId }, data: { batchIds: [batchId] } }).catch(() => undefined);
    const decision = await settlementCredentialsFor(shop, batchRowId);
    if (!decision.ok) return false;
    await decision.transport.cancel(batchId);
    return true;
  } catch (error) {
    logger.warn("[BulkTranslateBatch] Immediate cancel failed", { context: "AI", batchRowId, error: errorMessage(error) });
    return false;
  }
}
