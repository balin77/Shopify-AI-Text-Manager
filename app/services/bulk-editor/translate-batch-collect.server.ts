/**
 * COLLECT half of the Batch-API mode (PLAN_BULK_TRANSLATE_BATCHING 5.4 / 5.5).
 *
 * The poller has fetched the results of an ENDED provider batch (or the partial
 * results of a cancelled one) and booked what they cost. What is left is to turn
 * paid answers into verified, written translations -- and that is deliberately
 * NOT a second implementation: it is the live run again, with the model's
 * answers coming from the batch instead of from requests.
 *
 *   manifest + results  ->  per-item answers keyed by (kind, source text)
 *   rows re-read from the cache  ->  jobs (the cells that are still missing AND
 *                                    whose source text is the one that was asked)
 *   runBulkEditorTranslate(batch mode): plan-time read, the package ladder's
 *   per-entry verification, handle rules, block re-check, FILL-ONLY write.
 *
 * What that buys, and what it rules out:
 *  - a text that moved while the batch waited has no matching answer AND is
 *    dropped by its source hash (`skippedChanged`); a value that appeared in
 *    the meantime is dropped by the re-scan and the live fill-only check
 *    (`skippedFilled`). Nothing is ever overwritten.
 *  - an answer that fails a verification rung (garbled, wrong numbers, damaged
 *    HTML) is retried LIVE in small packages, but only within a small budget
 *    (min(20, 10 % of the requests)) and only while the normal gate still lets
 *    the shop spend; past it the cell is reported, not silently dropped.
 *  - collecting twice is harmless: the write is fill-only, the booking is
 *    idempotent per batch row.
 */

import type { PrismaClient, AISettings } from "@prisma/client";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { AIService, isManagedRefusal, type AiPackageRequest } from "../../../src/services/ai.service";
import { isRunAbortingAIError } from "~/routes/api-ai-handlers/shared";
import {
  runBulkEditorTranslate,
  type TranslateJob,
} from "~/routes/api-ai-handlers/bulk-editor-translate.handler";
import { aiFieldKey, type BulkRowType, type ColumnDescriptor } from "./columns.shared";
import { buildServerColumnsByType } from "./columns.server";
import { scanMissingTranslations, translateCandidateColumns } from "./missing-translations.server";
import type { PackagePhaseAI } from "./translate-package-phase.server";
import { planCellKey } from "./translate-plan-read.server";
import {
  itemSignature,
  retryBudgetFor,
  sourceHash,
  type BatchManifest,
  type BatchOutcomeCounts,
} from "./translate-batch.shared";
import type { BatchUsageItem } from "../ai/usage-meter.server";
import type { SettlementResultItem } from "../ai/batch-settlement.shared";
import type { Plan } from "~/config/plans";
import { logger } from "~/utils/logger.server";

// ─── results -> answers (pure) ───────────────────────────────────────────────

export interface BatchAnswers {
  /** item signature -> the model's `{ locale: text }` object, as written (UNVERIFIED). */
  answers: Map<string, Record<string, unknown>>;
  /** Signatures the batch was asked about but did not deliver (errored / expired / canceled / cut off / garbled / absent). */
  undelivered: Set<string>;
  counts: BatchOutcomeCounts;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function buildBatchAnswers(
  manifest: Pick<BatchManifest, "requests">,
  results: ReadonlyMap<string, SettlementResultItem>,
): BatchAnswers {
  const answers = new Map<string, Record<string, unknown>>();
  const undelivered = new Set<string>();
  const counts: BatchOutcomeCounts = {
    requests: manifest.requests.length,
    succeeded: 0,
    errored: 0,
    expired: 0,
    canceled: 0,
    missing: 0,
    invalid: 0,
  };
  for (const request of manifest.requests) {
    const result = results.get(request.customId);
    const failAll = () => request.items.forEach((sig) => undelivered.add(sig));
    if (!result) {
      counts.missing += 1;
      failAll();
      continue;
    }
    if (result.outcome !== "succeeded") {
      counts[result.outcome] += 1;
      failAll();
      continue;
    }
    counts.succeeded += 1;
    // A cut-off answer may still parse as JSON up to the cut: rejected as a whole, like the live path.
    if (result.truncated) {
      counts.invalid += 1;
      failAll();
      continue;
    }
    const parsed = AIService.parsePackageAnswer(result.text ?? "", false);
    if (parsed.invalid || !isPlainObject(parsed.parsed)) {
      counts.invalid += 1;
      failAll();
      continue;
    }
    request.items.forEach((sig, index) => {
      const entry = (parsed.parsed as Record<string, unknown>)[`k${index + 1}`];
      if (isPlainObject(entry)) {
        if (!answers.has(sig)) answers.set(sig, entry);
      } else {
        undelivered.add(sig);
      }
    });
  }
  // One text can ride in several requests: delivered once is delivered.
  for (const sig of answers.keys()) undelivered.delete(sig);
  return { answers, undelivered, counts };
}

/** What the collected requests consumed, for the booking. Measured where the provider reported it, an estimate where not. Failed requests cost nothing. */
export function usageItemsFromResults(
  manifest: Pick<BatchManifest, "requests">,
  results: ReadonlyMap<string, SettlementResultItem>,
  provider: BatchUsageItem["provider"],
  model: string,
): BatchUsageItem[] {
  const items: BatchUsageItem[] = [];
  for (const request of manifest.requests) {
    const result = results.get(request.customId);
    if (!result || result.outcome !== "succeeded") continue;
    if (result.usage && result.usage.inputTokens > 0) {
      items.push({
        provider,
        model,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        ...(result.usage.cacheReadTokens ? { cacheReadTokens: result.usage.cacheReadTokens } : {}),
        ...(result.usage.cacheWriteTokens ? { cacheWriteTokens: result.usage.cacheWriteTokens } : {}),
        estimated: false,
        // The batch discount is claimed only where the provider SAYS the request ran in the batch tier.
        tier: result.usage.serviceTier === "batch" ? "batch" : "standard",
      });
    } else {
      // A usage object reporting zero input tokens is not a measurement (same rule as the live path).
      items.push({
        provider,
        model,
        inputTokens: request.inputEstimate,
        outputTokens: Math.ceil((result.text ?? "").length / 3),
        estimated: true,
        // An estimate has no tier to prove: priced standard (the direction that cannot undercount).
        tier: "standard",
      });
    }
  }
  return items;
}

// ─── the answer source the package ladder asks ───────────────────────────────

/**
 * The `ai` the package phase talks to in a collect: answers from the batch,
 * and -- inside a small budget -- LIVE retries for entries the batch did not
 * deliver or the verification rejected. It never throws: a managed refusal or a
 * rejected key only switches the live retries off (the paid results are still
 * verified and written; a budget that ran out is not a reason to drop them).
 */
export class BatchAnswerAI implements PackagePhaseAI {
  private live: AIService | null;
  private budget: number;
  /** Signatures already re-asked live: never twice. */
  private readonly liveTried = new Set<string>();
  retries = 0;

  constructor(
    private readonly data: BatchAnswers,
    live: AIService | null,
    retryBudget: number,
    private readonly limits: { maxOutputTokens: number },
  ) {
    this.live = live;
    this.budget = live ? retryBudget : 0;
  }

  packageLimits() {
    return { maxOutputTokens: this.limits.maxOutputTokens, bucketTpm: null };
  }

  private async spend<T>(call: (live: AIService) => Promise<T>): Promise<T | null> {
    if (!this.live || this.budget <= 0) return null;
    this.budget -= 1;
    this.retries += 1;
    try {
      return await call(this.live);
    } catch (error) {
      // Live retries are a bonus on paid results. A refusal / rejected key ends them; anything else is just this entry.
      if (isManagedRefusal(error) || isRunAbortingAIError(error)) this.live = null;
      logger.warn("[BulkTranslateBatch] Live retry failed", {
        context: "AI",
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async translatePackage(req: AiPackageRequest): ReturnType<PackagePhaseAI["translatePackage"]> {
    const parsed: Record<string, unknown> = {};
    const reask: AiPackageRequest["items"] = [];
    for (const item of req.items) {
      const sig = itemSignature({ kind: req.kind, source: item.text });
      const answer = this.data.answers.get(sig);
      if (answer) parsed[item.id] = answer;
      else if (this.data.undelivered.has(sig) && !this.liveTried.has(sig)) reask.push(item);
    }
    if (reask.length > 0) {
      for (const item of reask) this.liveTried.add(itemSignature({ kind: req.kind, source: item.text }));
      const result = await this.spend((live) => live.translatePackage({ ...req, items: reask }));
      if (result && !result.invalid && isPlainObject(result.parsed)) Object.assign(parsed, result.parsed);
    }
    return { parsed };
  }

  async translateShortFieldsBatch(...args: Parameters<PackagePhaseAI["translateShortFieldsBatch"]>) {
    const result = await this.spend((live) => live.translateShortFieldsBatch(...args));
    if (!result) throw new Error("batch_retry_unavailable");
    return result;
  }

  async translateBatchValuesToLocales(...args: Parameters<PackagePhaseAI["translateBatchValuesToLocales"]>) {
    const result = await this.spend((live) => live.translateBatchValuesToLocales(...args));
    if (!result) throw new Error("batch_retry_unavailable");
    return result;
  }

  async translateFieldsToLocalesChunked(...args: Parameters<PackagePhaseAI["translateFieldsToLocalesChunked"]>) {
    const result = await this.spend((live) => live.translateFieldsToLocalesChunked(...args));
    if (!result) throw new Error("batch_retry_unavailable");
    return result;
  }
}

// ─── manifest + current rows -> jobs ─────────────────────────────────────────

export interface RebuiltJobs {
  jobs: TranslateJob[];
  /** Units dropped because the source text is not the one the model was asked about. */
  skippedChanged: number;
  /** Units dropped because the language got a value (or the row is gone) since the submit. */
  skippedFilled: number;
}

/**
 * Re-read the rows of the manifest and keep exactly the cells that are STILL
 * missing and whose source is UNCHANGED. A cell the manifest names that the scan
 * no longer finds is filled or gone: nothing to write, nothing failed.
 */
export function rebuildJobsFromScan(
  manifest: Pick<BatchManifest, "cells">,
  items: {
    rowId: string;
    primaryHandle?: string;
    columns: { columnId: string; locales: string[]; source?: string; existingListValuesByLocale?: Record<string, string[]> }[];
  }[],
  columnById: Map<string, ColumnDescriptor>,
): RebuiltJobs {
  const found = new Map<string, { item: (typeof items)[number]; entry: (typeof items)[number]["columns"][number] }>();
  for (const item of items) {
    for (const entry of item.columns) found.set(planCellKey(item.rowId, entry.columnId), { item, entry });
  }
  const out: RebuiltJobs = { jobs: [], skippedChanged: 0, skippedFilled: 0 };
  const byRow = new Map<string, TranslateJob>();
  for (const cell of manifest.cells) {
    const column = columnById.get(cell.c);
    const hit = found.get(planCellKey(cell.r, cell.c));
    if (!column || !hit) {
      out.skippedFilled += cell.l.length;
      continue;
    }
    const stillMissing = hit.entry.locales.filter((l) => cell.l.includes(l));
    const filledSince = cell.l.length - stillMissing.length;
    const source = hit.entry.source ?? "";
    if (sourceHash(source) !== cell.h) {
      // The text the model was asked about is not the text there now.
      out.skippedChanged += stillMissing.length;
      out.skippedFilled += filledSince;
      continue;
    }
    out.skippedFilled += filledSince;
    if (stillMissing.length === 0) continue;
    let job = byRow.get(cell.r);
    if (!job) {
      job = { rowId: cell.r, cells: [], primaryHandle: hit.item.primaryHandle ?? "" };
      byRow.set(cell.r, job);
      out.jobs.push(job);
    }
    job.cells.push({
      column,
      fieldKey: aiFieldKey(column),
      source,
      locales: stillMissing,
      ...(hit.entry.existingListValuesByLocale ? { existingListValuesByLocale: hit.entry.existingListValuesByLocale } : {}),
    });
  }
  return out;
}

// ─── the collect run ─────────────────────────────────────────────────────────

export interface CollectRunInput {
  db: PrismaClient;
  shop: string;
  admin: AdminApiContext;
  settings: AISettings | null;
  taskId: string;
  manifest: BatchManifest;
  answers: BatchAnswers;
  /** A live service for the bounded retries, or null (no key / refused / retries off). */
  live: AIService | null;
  aiInstructions: { translateInstructions?: string | null } | null;
  seoLimits: Parameters<typeof runBulkEditorTranslate>[1]["seoLimits"];
  translationMode: Parameters<typeof runBulkEditorTranslate>[1]["translationMode"];
  /** Provider-side figures for the Task result. */
  summary: Record<string, unknown>;
  maxOutputTokens: number;
}

/**
 * Write what the batch delivered, through the live run's own machinery. Returns
 * once the run has ended (it settles the Task itself, conditionally on the
 * statuses a collecting run owns). Never throws: a failure ends the Task as
 * failed through the runner's own catch.
 */
export async function runBatchCollect(input: CollectRunInput): Promise<{ retries: number }> {
  const { db, shop, manifest } = input;
  const rowType = manifest.rowType as BulkRowType;
  const plan = (input.settings?.subscriptionPlan || "free") as Plan;
  const columnsByType = await buildServerColumnsByType(db, shop, plan);
  const columns = translateCandidateColumns(columnsByType[rowType], rowType, manifest.moType);
  const columnById = new Map(columns.map((c) => [c.id, c] as const));

  const rowIds = [...new Set(manifest.cells.map((c) => c.r))];
  const scan = await scanMissingTranslations(db, shop, {
    type: rowType,
    search: "",
    filters: [],
    moType: manifest.moType,
    foreignLocales: manifest.locales,
    columns,
    admin: input.admin as never,
    withSources: true,
    rowIds,
  });
  const rebuilt = rebuildJobsFromScan(manifest, scan.items, columnById);

  const wrapper = new BatchAnswerAI(input.answers, input.live, retryBudgetFor(manifest.requests.length), {
    maxOutputTokens: input.maxOutputTokens,
  });
  const summary = input.summary;
  const expected = new Map(
    manifest.cells.filter((c) => c.e).map((c) => [planCellKey(c.r, c.c), c.e as Record<string, string>] as const),
  );
  const planUnits = manifest.plan.failures.reduce((n, f) => n + f.units, 0);

  try {
    await runBulkEditorTranslate(input.taskId, {
      db,
      shop,
      admin: input.admin,
      settings: input.settings,
      jobs: rebuilt.jobs,
      units: manifest.units,
      rowType,
      primaryLocale: manifest.primaryLocale,
      columnsByType,
      aiInstructions: input.aiInstructions,
      seoLimits: input.seoLimits,
      translationMode: input.translationMode,
      recheck: { columns, moType: manifest.moType, locales: manifest.locales },
      packages: true,
      batch: {
        ai: wrapper,
        ownStatuses: ["waiting_batch", "cancel_requested"],
        expected,
        preAccounted: {
          skippedChanged: manifest.plan.skippedChanged + rebuilt.skippedChanged,
          skippedFilled: rebuilt.skippedFilled,
          mismatchesByKey: manifest.plan.mismatchesByKey,
          failures: manifest.plan.failures.map((f) => ({ rowId: f.rowId, columnId: f.columnId, message: f.message })),
          settledUnits: manifest.plan.skippedChanged + rebuilt.skippedChanged + rebuilt.skippedFilled + planUnits,
          notStarted: manifest.plan.notStarted,
        },
        summary: () => ({ ...summary, retries: wrapper.retries }),
      },
    });
  } catch (error) {
    logger.error("[BulkTranslateBatch] Collect run crashed", {
      context: "AI",
      taskId: input.taskId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return { retries: wrapper.retries };
}
