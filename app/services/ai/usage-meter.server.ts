/**
 * The AI meter — what one call really consumed, written down.
 *
 * PLAN_MANAGED_AI_KEY Phase 0. This is the ONE writer of `AiUsageCounter` and
 * of `Task`'s three cost columns; `AIService` is the one caller, and it records
 * at the moment a PROVIDER ANSWERS rather than at the moment a call succeeds —
 * see the comment on `_executeAIRequestInner`'s `onUsage` for why those are
 * different events and why the difference was a systematic under-count.
 *
 * Six rules, each a direction of error rather than a preference:
 *
 * - **The meter may never fail a save.** Every write is wrapped and swallowed:
 *   the merchant's generation has already succeeded by the time this runs, and
 *   answering a bookkeeping problem with a failed save invites a retry that
 *   pays for the same tokens twice. A lost measurement is the cheap error.
 * - **The ledger write and the Task write report SEPARATELY.** They are two
 *   statements and can fail independently; one boolean over both said "nothing
 *   was written" about a ledger row that had been incremented, which is the
 *   shape that makes a Phase 1 "retry if not recorded" double-charge a shop.
 * - **An unreported usage object is an ESTIMATE, never a zero**, and estimated
 *   rows are KEYED apart from measured ones so the measured average can be
 *   computed without them.
 * - **The counter is INCREMENTED, never read-modify-written.** One shop can
 *   have several calls in flight; a read-then-write loses whichever landed in
 *   between — the bug `refundImageOperations` carries a comment about.
 * - **`billedMicros` is a separate number from `costMicros`** from the first
 *   row although they are equal today. They diverge on a failover (§3a rules
 *   1-2); a single column could not express that difference afterwards.
 * - **No BigInt leaves this module.** The volume columns are BIGINT because
 *   Int32 holds only ~2.1e9 tokens and Postgres RAISES rather than clamping on
 *   overflow — but `JSON.stringify` throws on a BigInt, so every value handed
 *   out is converted back to Number at the boundary.
 */

import type { AIProvider } from "../../utils/api-key-validation";
import {
  type AiCredentialSource,
  isAiCredentialSource,
} from "./usage-dimensions.shared";
import {
  priceCall,
  clampMicros,
  MAX_MICROS,
  PRICES_CHECKED_ON,
} from "../../config/ai-pricing";
import { logger } from "../../utils/logger.server";

export type { AiCredentialSource };

export interface RecordAiUsageInput {
  shop: string;
  provider: AIProvider;
  /** The model id the call actually ran on. */
  model: string;
  /** `Task.type`, or `ADHOC_FEATURE`. */
  feature: string;
  inputTokens: number;
  outputTokens: number;
  source: AiCredentialSource;
  /** True when the token counts were estimated because the SDK reported none. */
  estimated: boolean;
  /** True when this call was served by the fallback provider (§3a). */
  failover?: boolean;
  /**
   * What to charge the merchant's budget, when that differs from what we paid.
   * Absent means "the same" — which is every call until failover ships.
   */
  billedMicros?: number;
  /** When present, the same call is added to this task's per-run totals. */
  taskId?: string;
  /** Defaults to the current period. */
  period?: string;
}

export interface RecordedAiUsage {
  period: string;
  costMicros: number;
  billedMicros: number;
  /** The durable ledger row was incremented. */
  ledgerWritten: boolean;
  /**
   * The Task row was incremented. `null` when there was no task to write to,
   * which is not a failure. Separate from `ledgerWritten` because the two are
   * separate statements: reporting them through one flag said "nothing was
   * written" about a ledger row that had been.
   */
  taskWritten: boolean | null;
}

/**
 * The period a call is counted in.
 *
 * A UTC calendar month today, the same shape `currentImageOpPeriod` uses, and
 * deliberately its own function rather than an import of that one: §7 rule 3
 * replaces this with the SUBSCRIPTION's billing period the moment a budget is
 * enforced against it, and the image quota must not move with it.
 *
 * The `m:` prefix is what makes that replacement safe. A billing period key is
 * `b:<start>`, so a row can always say which scheme produced it — without the
 * prefix, a table holding both would be two meanings in one column with no
 * discriminator, which is the class of ambiguity this repo keeps paying for.
 */
export function currentAiUsagePeriod(date: Date = new Date()): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `m:${y}-${m}`;
}

/**
 * Non-negative integer, or 0 — token counts arrive from provider JSON and a
 * garbage value must not poison a column. The cap is a sanity bound on ONE
 * call (no single call is 2.1e9 tokens); the stored TOTAL is BIGINT precisely
 * so it needs no cap.
 */
function safeTokens(n: number): number {
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(Math.floor(n), MAX_MICROS);
}

/**
 * The unknown-model warning, once per process per (provider, model).
 *
 * It names a table that needs editing, which is a fact about the deployment,
 * not about the call — and a bulk run on such a model emitted hundreds of
 * byte-identical lines, which is exactly the log noise §Server error logging
 * exists to keep out.
 */
const warnedUnknownModels = new Set<string>();

function warnUnknownModelOnce(provider: AIProvider, model: string): void {
  const key = `${provider}/${model}`;
  if (warnedUnknownModels.has(key)) return;
  warnedUnknownModels.add(key);
  logger.warn(
    `[AI-METER] Unknown model "${model}" on ${provider} — priced at that provider's unknown-model ceiling. Add it to app/config/ai-pricing.ts (table last checked ${PRICES_CHECKED_ON}).`,
  );
}

/**
 * Write one call into the ledger (and, when it belongs to a task, into that
 * task's running totals). Never throws.
 */
export async function recordAiUsage(
  input: RecordAiUsageInput,
): Promise<RecordedAiUsage> {
  const period = input.period ?? currentAiUsagePeriod();
  let costMicros = 0;
  let billedMicros = 0;
  let ledgerWritten = false;
  let taskWritten: boolean | null = input.taskId ? false : null;

  try {
    const inputTokens = safeTokens(input.inputTokens);
    const outputTokens = safeTokens(input.outputTokens);

    const priced = priceCall(input.provider, input.model, inputTokens, outputTokens);
    costMicros = priced.costMicros;
    billedMicros =
      input.billedMicros === undefined ? costMicros : clampMicros(input.billedMicros);

    if (priced.pricedAtCeiling) warnUnknownModelOnce(input.provider, input.model);

    // Dynamic import for the same reason savePromptToTask uses one: it keeps
    // db.server out of this module's static graph.
    const { db } = await import("../../db.server");

    try {
      // A compound-unique `where`, no nested writes and no `select`: Prisma
      // compiles this to a native INSERT ... ON CONFLICT DO UPDATE, so two
      // concurrent first-calls for the same key cannot produce a P2002. That
      // is load-bearing rather than incidental — adding a `select` here would
      // put Prisma back on create-then-catch, where a lost race lands in the
      // catch below and the call's tokens are simply gone.
      await db.aiUsageCounter.upsert({
        where: {
          shop_period_source_provider_model_feature_estimated: {
            shop: input.shop,
            period,
            source: input.source,
            provider: input.provider,
            model: input.model,
            feature: input.feature,
            estimated: input.estimated,
          },
        },
        create: {
          shop: input.shop,
          period,
          source: input.source,
          provider: input.provider,
          model: input.model,
          feature: input.feature,
          estimated: input.estimated,
          calls: 1,
          failoverCalls: input.failover ? 1 : 0,
          inputTokens: BigInt(inputTokens),
          outputTokens: BigInt(outputTokens),
          costMicros: BigInt(costMicros),
          billedMicros: BigInt(billedMicros),
        },
        update: {
          calls: { increment: 1 },
          failoverCalls: { increment: input.failover ? 1 : 0 },
          inputTokens: { increment: BigInt(inputTokens) },
          outputTokens: { increment: BigInt(outputTokens) },
          costMicros: { increment: BigInt(costMicros) },
          billedMicros: { increment: BigInt(billedMicros) },
        },
      });
      ledgerWritten = true;
    } catch (error) {
      logger.error(
        `[AI-METER] Ledger write failed for ${input.shop} (${input.provider}/${input.model}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    if (input.taskId) {
      try {
        // `updateMany` rather than `update`: a task row can be gone (expired,
        // cancelled, reaped) while its run is still finishing, and a missing
        // row must not turn into a thrown P2025 here.
        //
        // Its own try: these columns are Int32 (the Task row is a 3-day
        // convenience record, and its values are JSON-serialised by the Tasks
        // routes, where a BigInt would throw), so a giant run can overflow
        // them — and Postgres raises rather than clamping. Losing the per-run
        // record is acceptable; taking the durable ledger write down with it
        // is not, and one shared try did exactly that.
        await db.task.updateMany({
          where: { id: input.taskId },
          data: {
            inputTokens: { increment: inputTokens },
            outputTokens: { increment: outputTokens },
            costMicros: { increment: costMicros },
          },
        });
        taskWritten = true;
      } catch (error) {
        logger.error(
          `[AI-METER] Task cost write failed for task ${input.taskId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  } catch (error) {
    // Anything outside the two inner blocks: the dynamic import, the pricing
    // call, the period helper. The contract is "never throws", and it holds
    // structurally rather than by luck.
    logger.error(
      `[AI-METER] Failed to record usage for ${input.shop} (${input.provider}/${input.model}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  return { period, costMicros, billedMicros, ledgerWritten, taskWritten };
}

export interface AiUsageRow {
  source: AiCredentialSource;
  provider: string;
  model: string;
  feature: string;
  estimated: boolean;
  calls: number;
  failoverCalls: number;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
  billedMicros: number;
}

/**
 * One shop's usage for a period, row by row.
 *
 * Deliberately NOT pre-aggregated: the whole point of the key is that the
 * caller chooses which dimensions to sum over, and a helper that summed them
 * here would hand back exactly the shop-wide blend the first cut stored.
 *
 * BigInt is converted to Number at this boundary and nowhere else. The values
 * are far inside `Number.MAX_SAFE_INTEGER` (2.1e9 tokens is four orders of
 * magnitude below it), so the conversion is exact.
 *
 * `scripts/ai-usage-report.mjs` deliberately does NOT call this — it runs on
 * plain Node and cannot import TypeScript. That is a stated duplication of one
 * query, not an oversight: this function is what §8's merchant-facing usage
 * card reads, and the script is the operator's answer until that exists.
 */
export async function getAiUsage(
  shop: string,
  period: string = currentAiUsagePeriod(),
): Promise<AiUsageRow[]> {
  const { db } = await import("../../db.server");
  const rows = await db.aiUsageCounter.findMany({
    where: { shop, period },
    orderBy: [{ feature: "asc" }, { model: "asc" }],
  });
  const unknown = rows.filter((row) => !isAiCredentialSource(row.source));
  if (unknown.length > 0) {
    // Not silently dropped: today this cannot happen, but Phase 1 adds the
    // resolver that writes this column, and a third source appearing here
    // would otherwise vanish from every usage view with no way to notice.
    logger.warn(
      `[AI-METER] ${unknown.length} usage row(s) for ${shop} carry an unknown source (${[
        ...new Set(unknown.map((r) => r.source)),
      ].join(", ")}) and are not reported.`,
    );
  }
  return rows
    .filter((row) => isAiCredentialSource(row.source))
    .map((row) => ({
      source: row.source as AiCredentialSource,
      provider: row.provider,
      model: row.model,
      feature: row.feature,
      estimated: row.estimated,
      calls: row.calls,
      failoverCalls: row.failoverCalls,
      inputTokens: Number(row.inputTokens),
      outputTokens: Number(row.outputTokens),
      costMicros: Number(row.costMicros),
      billedMicros: Number(row.billedMicros),
    }));
}
