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
   * Absent means "the same".
   */
  billedMicros?: number;
  /**
   * Price the MERCHANT's side at this model instead of the one that ran —
   * §3a rule 1. Set only on a failover: the merchant is billed at the default
   * model's price whatever answered, because an outage they did not cause and
   * cannot see must not make their volume evaporate at 14x speed.
   *
   * Computed here rather than by the caller so the two prices come from one
   * table and one rounding rule; a caller doing its own arithmetic is how the
   * ledger's two columns would come to disagree about the same call.
   */
  billedModel?: string;
  /** The default credential's PROVIDER, when the failover crossed providers. */
  billedProvider?: AIProvider;
  /** When present, the same call is added to this task's per-run totals. */
  taskId?: string;
  /** Defaults to the current period. */
  period?: string;
  /**
   * Which GLOBAL pool a managed call draws from (§9.3). Ignored for BYO, which
   * costs the operator nothing and is bounded by nobody's pool.
   */
  pool?: "paid" | "taster";
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
 * The BILLING period a managed call is counted in — §7 rule 3.
 *
 * Plans bill `EVERY_30_DAYS` with `APPLY_IMMEDIATELY` proration on switches,
 * so a calendar month is the wrong unit and the difference is money, not
 * tidiness. Keeping the calendar key produces: a sign-up on the 31st that gets
 * two full budgets inside one billing period (on Max, 10.00 against 34.00 net
 * = a 29.4 % cost share, 1.47x the guard this pricing rests on); an
 * upgrade-spend-cancel loop worth about EUR 3.87 per shop per period,
 * repeatable; and a downgrade-after-spend at a 44 % cost share.
 *
 * The key is derived from the period END that Shopify reports, counted
 * backwards in 30-day steps — a period is identified by the day it ENDS,
 * which is the one date the subscription actually carries. A mid-period
 * upgrade therefore does NOT mint a second budget: the used figure carries
 * over inside the same key while the LIMIT is read from the current plan at
 * check time.
 *
 * `null` (never mirrored, an unparseable value, a shop with no managed
 * subscription) falls back to the calendar month. That is a stated
 * approximation rather than a guessed boundary — and it is only ever reached
 * by a shop whose managed entitlement we could not read, which is a shop with
 * no budget to spend.
 */
export function managedBudgetPeriod(
  periodEnd: Date | null | undefined,
  now: Date = new Date(),
): string {
  if (!periodEnd) return currentAiUsagePeriod(now);
  const end = new Date(periodEnd);
  if (Number.isNaN(end.getTime())) return currentAiUsagePeriod(now);

  // A stale mirror (the webhook has not landed yet, or a sync is overdue) can
  // leave `periodEnd` in the past. Walk it forward in whole periods rather
  // than keying on an expired one, or the shop would keep spending against a
  // budget that has already reset — the wrong direction.
  const PERIOD_MS = 30 * 24 * 60 * 60 * 1000;
  let boundary = end.getTime();
  while (boundary < now.getTime()) boundary += PERIOD_MS;

  return `b:${new Date(boundary).toISOString().slice(0, 10)}`;
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

    if (input.billedMicros !== undefined) {
      billedMicros = clampMicros(input.billedMicros);
    } else if (input.billedModel && input.billedModel !== input.model) {
      // A failover: what we PAID is the model that ran, what the MERCHANT is
      // charged is the default model's price for the same tokens. Same table,
      // same rounding — the two columns describe one call and must not be
      // computed two different ways.
      billedMicros = priceCall(
        input.billedProvider ?? input.provider,
        input.billedModel,
        inputTokens,
        outputTokens,
      ).costMicros;
    } else {
      billedMicros = costMicros;
    }

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

    // The GLOBAL pool (§9.3) — recorded for a MANAGED call only, and beside
    // the ledger rather than derived from it: the pool is read on every
    // managed call, and summing a shop-keyed table over every shop to answer
    // it would be a table scan per AI request.
    //
    // Its own try for the same reason the Task write has one: losing the
    // global figure must not take the durable per-shop row with it.
    if (input.source === "managed") {
      try {
        const { addGlobalPoolSpend } = await import("./managed-global-pool.server");
        // NOT `period`. The pool has its own calendar-month key, computed
        // inside that module so the reader and the writer cannot be handed
        // different ones — which is what happened when both took the shop's
        // key: the "global" counter sharded into one row per billing-period
        // end and each row got the full limit.
        await addGlobalPoolSpend(
          input.pool ?? "paid",
          costMicros,
          // What WE absorb on a failover: the gap between what the provider
          // charged and what the merchant was billed.
          Math.max(0, costMicros - billedMicros),
        );
      } catch (error) {
        logger.error(
          `[AI-METER] Global pool write failed for ${input.shop}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
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
