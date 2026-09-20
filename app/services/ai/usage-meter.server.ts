/**
 * The AI meter — what one call really consumed, written down.
 *
 * PLAN_MANAGED_AI_KEY Phase 0. This is the ONE writer of `AiUsageCounter` and
 * of `Task`'s three cost columns; `AIService.executeAIRequest` is the one
 * caller, because that is the single chokepoint every provider call passes
 * through (`replayRequest`, the task-recovery path, goes past `askAI` and past
 * the queue — metering in `askAI` would miss it silently).
 *
 * Four rules, and each one is a direction of error rather than a preference:
 *
 * - **The meter may never fail a save.** Every write here is wrapped and
 *   swallowed: the merchant's generation has already succeeded by the time
 *   this runs, and answering a bookkeeping problem with a failed save invites
 *   a retry that pays for the same tokens twice. A lost measurement is the
 *   cheap error; a lost generation is not.
 * - **An unreported usage object is an ESTIMATE, never a zero.** The caller
 *   decides which (`source`), and the share of estimated calls is stored, so
 *   "the meter says EUR 2 and the invoice says EUR 3" is diagnosable.
 * - **The counter is INCREMENTED, never read-modify-written.** One AIService
 *   instance can have several calls in flight and one shop can have several
 *   instances; a `findUnique` + `update` pair would lose whichever landed in
 *   between, which is the bug `refundImageOperations` carries a comment about.
 * - **`billedMicros` is a separate number from `costMicros`** from the first
 *   row, although they are equal today. They diverge on a failover (§3a rules
 *   1-2), where the merchant is billed at the default model's price and we
 *   carry the rest; a single column would make that difference unrecoverable.
 */

import type { AIProvider } from "../../utils/api-key-validation";
import {
  type AiCredentialSource,
  isAiCredentialSource,
} from "./credential-source.shared";
import { priceCall, clampMicros, MAX_MICROS } from "../../config/ai-pricing";
import { logger } from "../../utils/logger.server";

export type { AiCredentialSource };

export interface RecordAiUsageInput {
  shop: string;
  provider: AIProvider;
  /** The model id the call actually ran on. */
  model: string;
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
  /** False when nothing was written (see the swallow rule above). */
  recorded: boolean;
}

/**
 * The period a call is counted in.
 *
 * A UTC calendar month today, the same key `currentImageOpPeriod` uses, and
 * deliberately its own function rather than an import of that one: §7 rule 3
 * replaces this with the SUBSCRIPTION's billing period the moment a budget is
 * enforced against it, and the image quota must not move with it. Until then
 * this is measurement only, where the two keys agree.
 */
export function currentAiUsagePeriod(date: Date = new Date()): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/**
 * Non-negative integer, or 0 — token counts arrive from provider JSON and a
 * garbage value must not poison a column. The ceiling is MAX_MICROS because
 * that constant IS the Int32 maximum these columns share; it is not a price
 * here.
 */
function safeTokens(n: number): number {
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(Math.floor(n), MAX_MICROS);
}

/**
 * Write one call into the ledger (and, when it belongs to a task, into that
 * task's running totals). Never throws.
 */
export async function recordAiUsage(
  input: RecordAiUsageInput,
): Promise<RecordedAiUsage> {
  const period = input.period ?? currentAiUsagePeriod();
  const inputTokens = safeTokens(input.inputTokens);
  const outputTokens = safeTokens(input.outputTokens);

  const priced = priceCall(input.provider, input.model, inputTokens, outputTokens);
  const costMicros = priced.costMicros;
  const billedMicros =
    input.billedMicros === undefined ? costMicros : clampMicros(input.billedMicros);

  if (priced.pricedAtCeiling) {
    // An unknown model id is usually a NEW one, and pricing it at zero is the
    // direction that hides a cost explosion. It is priced at the provider's
    // most expensive known entry and said so, so the table gets updated
    // instead of the number being quietly wrong.
    logger.warn(
      `[AI-METER] Unknown model "${input.model}" on ${input.provider} — priced at that provider's ceiling. Add it to app/config/ai-pricing.ts.`,
    );
  }

  try {
    const { db } = await import("../../db.server");

    await db.aiUsageCounter.upsert({
      where: { shop_period_source: { shop: input.shop, period, source: input.source } },
      create: {
        shop: input.shop,
        period,
        source: input.source,
        calls: 1,
        estimatedCalls: input.estimated ? 1 : 0,
        failoverCalls: input.failover ? 1 : 0,
        inputTokens,
        outputTokens,
        costMicros,
        billedMicros,
      },
      update: {
        calls: { increment: 1 },
        estimatedCalls: { increment: input.estimated ? 1 : 0 },
        failoverCalls: { increment: input.failover ? 1 : 0 },
        inputTokens: { increment: inputTokens },
        outputTokens: { increment: outputTokens },
        costMicros: { increment: costMicros },
        billedMicros: { increment: billedMicros },
      },
    });

    if (input.taskId) {
      // `updateMany` rather than `update`: a task row can be gone (expired,
      // cancelled, deleted by the reaper) while its run is still finishing,
      // and a missing row must not turn into a thrown P2025 here.
      await db.task.updateMany({
        where: { id: input.taskId },
        data: {
          inputTokens: { increment: inputTokens },
          outputTokens: { increment: outputTokens },
          costMicros: { increment: costMicros },
        },
      });
    }

    return { period, costMicros, billedMicros, recorded: true };
  } catch (error) {
    // Includes the one arithmetic failure this design can produce: a counter
    // that exceeds Int32 makes Postgres raise rather than wrap. Per-call
    // values are clamped, so reaching it means ~EUR 2,147 of spend in one
    // period on one shop — worth a loud line, never worth a failed save.
    logger.error(
      `[AI-METER] Failed to record usage for ${input.shop} (${input.provider}/${input.model}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return { period, costMicros, billedMicros, recorded: false };
  }
}

/** Read-only usage for one shop and period, across both key sources. */
export async function getAiUsage(
  shop: string,
  period: string = currentAiUsagePeriod(),
): Promise<
  Record<
    AiCredentialSource,
    { calls: number; estimatedCalls: number; costMicros: number; billedMicros: number }
  >
> {
  const { db } = await import("../../db.server");
  const rows = await db.aiUsageCounter.findMany({
    where: { shop, period },
    select: {
      source: true,
      calls: true,
      estimatedCalls: true,
      costMicros: true,
      billedMicros: true,
    },
  });
  const empty = { calls: 0, estimatedCalls: 0, costMicros: 0, billedMicros: 0 };
  const out: Record<AiCredentialSource, typeof empty> = {
    managed: { ...empty },
    byo: { ...empty },
  };
  for (const row of rows) {
    if (isAiCredentialSource(row.source)) {
      out[row.source] = {
        calls: row.calls,
        estimatedCalls: row.estimatedCalls,
        costMicros: row.costMicros,
        billedMicros: row.billedMicros,
      };
    }
  }
  return out;
}
