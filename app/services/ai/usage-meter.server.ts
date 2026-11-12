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

import { calendarPeriodKey } from "./managed-periods.shared";
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
  /** The SUM of all input tokens, cache read and write parts included. */
  inputTokens: number;
  outputTokens: number;
  /** Part of `inputTokens` read from a prompt cache. Absent = 0. */
  cacheReadTokens?: number;
  /** Part of `inputTokens` written to a prompt cache. Absent = 0. */
  cacheWriteTokens?: number;
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
  return calendarPeriodKey(date);
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

    // The cache parts live INSIDE inputTokens (never beside it), so the totals
    // stay "all input tokens"; they are clamped to it so a bad report cannot
    // make the parts exceed the whole.
    const cacheReadTokens = Math.min(safeTokens(input.cacheReadTokens ?? 0), inputTokens);
    const cacheWriteTokens = Math.min(
      safeTokens(input.cacheWriteTokens ?? 0),
      inputTokens - cacheReadTokens,
    );
    const cacheOpts = { cacheReadTokens, cacheWriteTokens };

    const priced = priceCall(
      input.provider,
      input.model,
      inputTokens,
      outputTokens,
      cacheOpts,
    );
    costMicros = priced.costMicros;

    if (input.billedMicros !== undefined) {
      billedMicros = clampMicros(input.billedMicros);
    } else if (input.billedModel && input.billedModel !== input.model) {
      // A failover: what we PAID is the model that ran, what the MERCHANT is
      // charged is the default model's price for the same tokens. Same table,
      // same rounding — the two columns describe one call and must not be
      // computed two different ways.
      // Cache READS are left out of the billed price: they belong to the model
      // that RAN, and pricing the billed model with them could hand the
      // merchant a discount the billed model never gave (full input price is
      // never less). Cache WRITES are passed: they only ever raise a price (a
      // Claude write carries its 1.25x surcharge), so a Claude -> Claude
      // failover with writes is not billed below the default model's own write
      // price. A billed provider without a write factor prices them at 1.0.
      billedMicros = priceCall(
        input.billedProvider ?? input.provider,
        input.billedModel,
        inputTokens,
        outputTokens,
        { cacheWriteTokens },
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
          cacheReadTokens: BigInt(cacheReadTokens),
          cacheWriteTokens: BigInt(cacheWriteTokens),
          costMicros: BigInt(costMicros),
          billedMicros: BigInt(billedMicros),
        },
        update: {
          calls: { increment: 1 },
          failoverCalls: { increment: input.failover ? 1 : 0 },
          inputTokens: { increment: BigInt(inputTokens) },
          outputTokens: { increment: BigInt(outputTokens) },
          cacheReadTokens: { increment: BigInt(cacheReadTokens) },
          cacheWriteTokens: { increment: BigInt(cacheWriteTokens) },
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
  /**
   * A RESERVATION of a waiting batch (`<feature>:reserved`): money held against
   * the budget, not spent. Carries billedMicros only. Callers that total cost
   * must skip it; callers that show budget use may count it.
   */
  reserved: boolean;
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
      reserved: isReservedFeature(row.feature),
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

// ─── Batch reservations (PLAN_BULK_TRANSLATE_BATCHING 19.5) ─────────────────
//
// A provider batch is submitted in one go and settled up to 24 hours later, so
// the per-call budget gate cannot see what it is about to cost. The budget side
// is protected by a RESERVATION written at submit and turned into a charge (or
// removed) when the batch settles. Two counters hold it, because three readers
// look at two different tables:
//
//  1. `AiUsageCounter`, feature `<feature>:reserved`, `billedMicros` ONLY --
//     `managedBudgetStatus` sums billedMicros of every managed row of the open
//     period, so the hold counts against the shop's remaining budget. NEVER
//     `costMicros` (shop-overview and the margin reports sum cost; a hold is not
//     an expense) and never `calls` (the settings card's estimated share is
//     computed over calls).
//  2. `ManagedAiGlobalCounter` of the pool + calendar month PINNED AT SUBMIT --
//     `globalPoolStatus` reads `costMicros` there, so the hold counts against
//     the global cap too.
//
// Both writes live in THIS module (the one writer of AiUsageCounter), run in
// ONE transaction with the state flip on the batch row, and are idempotent per
// batch: `reservationState` moves none -> held -> converted | released through
// conditional updates, so a second reserve / convert / release of the same row
// finds nothing to do. Decrements clamp at zero IN the statement (GREATEST), so
// a counter can never go negative however the rows came to disagree.
//
// Nothing here throws: a failure is a value (`applied: false`). The submit path
// must refuse to submit on a failed reserve; the settle paths log and the
// sweep (`releaseSettledReservations`) retries what a crash left behind.

/** The feature the reservation row is filed under: the real feature plus this suffix. */
export const RESERVED_FEATURE_SUFFIX = ':reserved';
/** The feature a batch run is metered under (Task.type of the bulk translate run). */
export const BATCH_RESERVATION_FEATURE = 'bulkEditorTranslate';

export const reservedFeature = (feature: string): string => `${feature}${RESERVED_FEATURE_SUFFIX}`;
export const isReservedFeature = (feature: string): boolean => feature.endsWith(RESERVED_FEATURE_SUFFIX);

export type ReservationOutcome =
  | { applied: true; micros: number }
  | {
      applied: false;
      reason:
        | 'noBatch' // the batch row does not exist
        | 'byo' // an own-key run has no budget to reserve against
        | 'zero' // nothing to reserve
        | 'already' // reserve: the row is not in state "none"
        | 'unpinned' // reserve: period / poolPeriod / pool are not pinned on the row (pool must be paid or taster)
        | 'notHeld' // convert / release: nothing is held (never reserved, or already settled)
        | 'failed'; // the transaction failed; nothing was written
    };

/** Identifies the counter rows of one batch -- all pinned at submit. */
function reservationKeys(row: {
  shop: string;
  provider: string;
  model: string;
  period: string;
  pool: string;
  poolPeriod: string;
}) {
  return {
    shop: row.shop,
    period: row.period,
    source: 'managed' as const,
    provider: row.provider,
    model: row.model,
    pool: (row.pool === 'taster' ? 'taster' : 'paid') as 'paid' | 'taster',
    poolPeriod: row.poolPeriod,
  };
}

function clampReservation(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.min(Math.floor(n), MAX_MICROS)) : 0;
}

/**
 * Hold `billedMicros` against the shop's budget (and `poolMicros`, default the
 * same, against the global pool) for a batch that has just been recorded.
 * Idempotent: a batch already holding a reservation is left as it is.
 */
export async function reserveBudget(
  batchId: string,
  amounts: { billedMicros: number; poolMicros?: number },
): Promise<ReservationOutcome> {
  try {
    const { db } = await import('../../db.server');
    const row = await db.bulkTranslateBatch.findUnique({ where: { id: batchId } });
    if (!row) return { applied: false, reason: 'noBatch' };
    if (row.source !== 'managed') return { applied: false, reason: 'byo' };
    if (row.reservationState !== 'none') return { applied: false, reason: 'already' };
    // A reservation is written under the keys PINNED at submit. A row without
    // them would be held under the empty period (or default to the paid pool),
    // a place no budget or pool reader looks: the hold would exist and protect
    // nothing, and its release would miss too. Refuse instead.
    if (!row.period || !row.poolPeriod || (row.pool !== 'paid' && row.pool !== 'taster')) {
      return { applied: false, reason: 'unpinned' };
    }
    const billed = clampReservation(amounts.billedMicros);
    const poolAmount = clampReservation(amounts.poolMicros ?? amounts.billedMicros);
    if (billed <= 0) return { applied: false, reason: 'zero' };
    const k = reservationKeys(row);

    const done = await db.$transaction(async (tx) => {
      const flipped = await tx.bulkTranslateBatch.updateMany({
        where: { id: batchId, reservationState: 'none' },
        data: { reservationState: 'held', reservedMicros: billed, reservedPoolMicros: poolAmount },
      });
      if (flipped.count !== 1) return false;
      await tx.aiUsageCounter.upsert({
        where: {
          shop_period_source_provider_model_feature_estimated: {
            shop: k.shop,
            period: k.period,
            source: k.source,
            provider: k.provider,
            model: k.model,
            feature: reservedFeature(BATCH_RESERVATION_FEATURE),
            estimated: true,
          },
        },
        create: {
          shop: k.shop,
          period: k.period,
          source: k.source,
          provider: k.provider,
          model: k.model,
          feature: reservedFeature(BATCH_RESERVATION_FEATURE),
          estimated: true,
          // calls / costMicros stay 0: a hold is neither a call nor an expense.
          billedMicros: BigInt(billed),
        },
        update: { billedMicros: { increment: BigInt(billed) } },
      });
      if (poolAmount > 0) {
        await tx.managedAiGlobalCounter.upsert({
          where: { period_pool: { period: k.poolPeriod, pool: k.pool } },
          create: { period: k.poolPeriod, pool: k.pool, costMicros: BigInt(poolAmount), failoverMicros: BigInt(0) },
          update: { costMicros: { increment: BigInt(poolAmount) } },
        });
      }
      return true;
    });
    return done ? { applied: true, micros: billed } : { applied: false, reason: 'already' };
  } catch (error) {
    logger.error(
      `[AI-METER] Reserving budget for batch ${batchId} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { applied: false, reason: 'failed' };
  }
}

/** Remove a held reservation from both counters, clamped at zero in the statement. */
async function dropReservation(
  tx: { $executeRaw: (q: TemplateStringsArray, ...v: unknown[]) => Promise<number> },
  k: ReturnType<typeof reservationKeys>,
  billed: number,
  poolAmount: number,
): Promise<void> {
  if (billed > 0) {
    await tx.$executeRaw`UPDATE "AiUsageCounter" SET "billedMicros" = GREATEST("billedMicros" - ${BigInt(billed)}::bigint, 0), "updatedAt" = NOW() WHERE "shop" = ${k.shop} AND "period" = ${k.period} AND "source" = ${k.source} AND "provider" = ${k.provider} AND "model" = ${k.model} AND "feature" = ${reservedFeature(BATCH_RESERVATION_FEATURE)} AND "estimated" = true`;
  }
  if (poolAmount > 0) {
    await tx.$executeRaw`UPDATE "ManagedAiGlobalCounter" SET "costMicros" = GREATEST("costMicros" - ${BigInt(poolAmount)}::bigint, 0), "updatedAt" = NOW() WHERE "period" = ${k.poolPeriod} AND "pool" = ${k.pool}`;
  }
}

/**
 * The batch settled without a charge (cancelled before it ran, expired,
 * unreachable, failed at submit): give the reservation back to both counters.
 */
export async function releaseBudget(batchId: string): Promise<ReservationOutcome> {
  return settleReservation(batchId, 'released');
}

/**
 * Book the reservation AS the charge -- the consent-withdrawal path (PLAN 16):
 * nothing was fetched, so the reserved upper bound is what the shop pays. The
 * hold moves from the `:reserved` row into the real feature row (billedMicros
 * and costMicros, estimated); the pool counter already carries the amount as
 * cost and is left alone.
 *
 * `costMicros` is set equal to `billedMicros` ON PURPOSE (owner decision,
 * PLAN 16: batch discount passed on, billed = cost, and a conversion has no
 * measured provider cost -- the upper bound IS the amount the shop is charged
 * and the amount recorded as spent). Do not "correct" it to zero.
 */
export async function convertReservation(
  batchId: string,
  opts: { bookMicros?: number } = {},
): Promise<ReservationOutcome> {
  return settleReservation(batchId, 'converted', opts.bookMicros);
}

/**
 * `bookMicros` (convert only): book THAT much of the hold as the charge and give
 * the rest back -- the pro rata booking from the provider's request counts
 * (PLAN 16, coordinator decision). Never more than the hold; 0 is a release.
 * Omitted = the whole hold (the upper bound).
 */
async function settleReservation(
  batchId: string,
  to: 'released' | 'converted',
  bookMicros?: number,
): Promise<ReservationOutcome> {
  try {
    const { db } = await import('../../db.server');
    const row = await db.bulkTranslateBatch.findUnique({ where: { id: batchId } });
    if (!row) return { applied: false, reason: 'noBatch' };
    if (row.reservationState !== 'held') return { applied: false, reason: 'notHeld' };
    const billed = clampReservation(row.reservedMicros);
    const poolAmount = clampReservation(row.reservedPoolMicros);
    const k = reservationKeys(row);
    // What of the hold becomes the charge. A partial booking of 0 is a release.
    const booked = to === 'converted' ? (bookMicros === undefined ? billed : Math.min(billed, clampReservation(bookMicros))) : 0;
    if (to === 'converted' && bookMicros !== undefined && booked === 0) to = 'released';
    // The pool counter carries the hold as cost; the booked share stays, the rest goes back.
    const bookedPool = booked >= billed || billed === 0 ? poolAmount : Math.min(poolAmount, Math.ceil((poolAmount * booked) / billed));

    const done = await db.$transaction(async (tx) => {
      // The winner of this conditional flip is the only one who touches the counters.
      const flipped = await tx.bulkTranslateBatch.updateMany({
        where: { id: batchId, reservationState: 'held' },
        data: { reservationState: to },
      });
      if (flipped.count !== 1) return false;
      if (to === 'converted' && booked > 0) {
        await tx.aiUsageCounter.upsert({
          where: {
            shop_period_source_provider_model_feature_estimated: {
              shop: k.shop,
              period: k.period,
              source: k.source,
              provider: k.provider,
              model: k.model,
              feature: BATCH_RESERVATION_FEATURE,
              estimated: true,
            },
          },
          create: {
            shop: k.shop,
            period: k.period,
            source: k.source,
            provider: k.provider,
            model: k.model,
            feature: BATCH_RESERVATION_FEATURE,
            estimated: true,
            billedMicros: BigInt(booked),
            costMicros: BigInt(booked),
          },
          update: { billedMicros: { increment: BigInt(booked) }, costMicros: { increment: BigInt(booked) } },
        });
        // The reserved row loses the whole hold; the pool keeps the booked share (it is now the charge).
        await dropReservation(tx as never, k, billed, poolAmount - bookedPool);
      } else if (to === 'released') {
        await dropReservation(tx as never, k, billed, poolAmount);
      }
      return true;
    });
    return done ? { applied: true, micros: to === 'converted' ? booked : billed } : { applied: false, reason: 'notHeld' };
  } catch (error) {
    logger.error(
      `[AI-METER] Settling the reservation of batch ${batchId} (${to}) failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return { applied: false, reason: 'failed' };
  }
}

/**
 * Sweep: settle the reservation of every batch row that is SETTLED ("done") but
 * still holds one -- a crash between settling and releasing, a submit that
 * died, a recovery that closed the row. Covers BOTH counters, and not only
 * `waiting` rows: a settled row is exactly where a hold gets lost.
 *
 * The rule is the guiding rule of PLAN 16 and NOT "release": a row that never
 * got a provider batch id has nothing at the provider (the create was refused or
 * never sent), so its hold goes back; a row that NAMES a batch may have run and
 * cost money, and this sweep cannot read the provider, so the hold becomes the
 * charge (the reserved upper bound -- never below the cost). Idempotent; the
 * poller calls it each tick.
 */
export async function releaseSettledReservations(
  limit = 50,
): Promise<{ released: number; converted: number; failed: number }> {
  let released = 0;
  let converted = 0;
  let failed = 0;
  try {
    const { db } = await import('../../db.server');
    const rows = await db.bulkTranslateBatch.findMany({
      where: { state: 'done', reservationState: 'held' },
      select: { id: true, batchIds: true },
      take: limit,
    });
    for (const { id, batchIds } of rows) {
      const named = Array.isArray(batchIds) && batchIds.some((b) => typeof b === 'string' && b.length > 0);
      const outcome = await (named ? convertReservation(id) : releaseBudget(id));
      if (outcome.applied) {
        if (named) converted += 1;
        else released += 1;
      } else if (outcome.reason === 'failed') failed += 1;
    }
  } catch (error) {
    logger.error(
      `[AI-METER] Reservation sweep failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    failed += 1;
  }
  return { released, converted, failed };
}

// ─── Booking what a settled batch really consumed (PLAN 5.5 / 6.4) ───────────

/** One result line's usage, as the provider reported it (or an estimate). */
export interface BatchUsageItem {
  provider: AIProvider;
  model: string;
  /** The SUM of all input tokens, cache parts included (same meaning as RecordAiUsageInput). */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** True when the provider reported no usage and the figures are our estimate. */
  estimated: boolean;
  /**
   * The price tier the result was served at. The batch discount applies only
   * where the provider SAYS the request ran in the batch tier
   * (`usage.service_tier === 'batch'`); anything else is priced standard.
   * Omitted = batch (callers that know better always set it).
   */
  tier?: 'batch' | 'standard';
}

export type BatchBookingOutcome =
  | { applied: true; costMicros: number; billedMicros: number; calls: number }
  | {
      applied: false;
      reason:
        | 'noBatch'
        | 'alreadySettled' // the reservation was already converted / released / booked: nothing to do
        | 'leaseLost' // the lease token on the row is not the caller's any more
        | 'failed';
    };

class LeaseLostError extends Error {}

/**
 * Book the ACTUAL usage of a collected batch and settle its reservation in ONE
 * transaction (idempotent per batch row). Called BEFORE the translations are
 * written, so a crash after it re-collects and re-writes without ever booking
 * twice, and a crash before it books nothing.
 *
 * The idempotency marker is `reservationState`, the same flag the reserve /
 * convert / release path flips: a MANAGED row must be `held` (it flips to
 * `released` = settled), an own-key row has no reservation and is `none`
 * (flips to `released` too, so a second collect finds it settled). Anything
 * else -- `converted` (consent withdrawn: the upper bound was booked already),
 * `released` -- is `alreadySettled` and nothing is written.
 *
 * With a `leaseToken` the row is locked `FOR UPDATE` and the token compared
 * inside the transaction: a collector that lost its lease rolls back instead of
 * booking on behalf of the new holder.
 *
 * Pricing is the BATCH tier (`priceCall` tier 'batch': the model's published
 * batch factor on the non-cache components, 1.0 where none is known = over-
 * count). `billedMicros = costMicros`: the batch discount is passed on to the
 * merchant (owner decision, PLAN 16). Booked under the period / pool PINNED at
 * submit, on the same keys the reservation was written under.
 */
export async function settleBatchUsage(
  batchId: string,
  items: BatchUsageItem[],
  opts: { leaseToken?: string | null; feature?: string } = {},
): Promise<BatchBookingOutcome> {
  try {
    const { db } = await import('../../db.server');
    const feature = opts.feature ?? BATCH_RESERVATION_FEATURE;
    const outcome = await db.$transaction(async (tx) => {
      const rawTx = tx as unknown as { $queryRaw?: (q: TemplateStringsArray, ...v: unknown[]) => Promise<unknown> };
      if (typeof rawTx.$queryRaw === 'function') {
        await rawTx.$queryRaw`SELECT "id" FROM "BulkTranslateBatch" WHERE "id" = ${batchId} FOR UPDATE`;
      }
      const row = await tx.bulkTranslateBatch.findUnique({ where: { id: batchId } });
      if (!row) return { applied: false, reason: 'noBatch' } as const;
      if (opts.leaseToken !== undefined && row.leaseToken !== opts.leaseToken) throw new LeaseLostError();
      const managed = row.source === 'managed';
      if (row.reservationState !== (managed ? 'held' : 'none')) {
        return { applied: false, reason: 'alreadySettled' } as const;
      }
      const flipped = await tx.bulkTranslateBatch.updateMany({
        where: { id: batchId, reservationState: row.reservationState },
        data: { reservationState: 'released' },
      });
      if (flipped.count !== 1) return { applied: false, reason: 'alreadySettled' } as const;

      const period = row.period || currentAiUsagePeriod();
      const source: AiCredentialSource = managed ? 'managed' : 'byo';
      // One ledger row per (provider, model, measured/estimated), priced once on the sums.
      const groups = new Map<
        string,
        { provider: AIProvider; model: string; estimated: boolean; tier: 'batch' | 'standard'; input: number; output: number; read: number; write: number; calls: number }
      >();
      for (const item of items) {
        const tier = item.tier ?? 'batch';
        const key = `${item.provider}|${item.model}|${item.estimated}|${tier}`;
        const g = groups.get(key) ?? {
          provider: item.provider, model: item.model, estimated: item.estimated, tier, input: 0, output: 0, read: 0, write: 0, calls: 0,
        };
        g.input += safeTokens(item.inputTokens);
        g.output += safeTokens(item.outputTokens);
        g.read += safeTokens(item.cacheReadTokens ?? 0);
        g.write += safeTokens(item.cacheWriteTokens ?? 0);
        g.calls += 1;
        groups.set(key, g);
      }
      let totalCost = 0;
      let totalCalls = 0;
      for (const g of groups.values()) {
        const read = Math.min(g.read, g.input);
        const write = Math.min(g.write, g.input - read);
        const priced = priceCall(g.provider, g.model, g.input, g.output, {
          cacheReadTokens: read,
          cacheWriteTokens: write,
          tier: g.tier,
        });
        if (priced.pricedAtCeiling) warnUnknownModelOnce(g.provider, g.model);
        const cost = clampMicros(priced.costMicros);
        totalCost += cost;
        totalCalls += g.calls;
        await tx.aiUsageCounter.upsert({
          where: {
            shop_period_source_provider_model_feature_estimated: {
              shop: row.shop, period, source, provider: g.provider, model: g.model, feature, estimated: g.estimated,
            },
          },
          create: {
            shop: row.shop, period, source, provider: g.provider, model: g.model, feature, estimated: g.estimated,
            calls: g.calls,
            inputTokens: BigInt(g.input),
            outputTokens: BigInt(g.output),
            cacheReadTokens: BigInt(read),
            cacheWriteTokens: BigInt(write),
            costMicros: BigInt(cost),
            // billed = cost: the batch discount is passed on (PLAN 16).
            billedMicros: BigInt(cost),
          },
          update: {
            calls: { increment: g.calls },
            inputTokens: { increment: BigInt(g.input) },
            outputTokens: { increment: BigInt(g.output) },
            cacheReadTokens: { increment: BigInt(read) },
            cacheWriteTokens: { increment: BigInt(write) },
            costMicros: { increment: BigInt(cost) },
            billedMicros: { increment: BigInt(cost) },
          },
        });
      }
      if (managed) {
        const k = reservationKeys(row);
        // The pool counter carries the HOLD as cost until now: add what was
        // spent, then take the hold off (clamped at zero in the statement).
        if (totalCost > 0) {
          await tx.managedAiGlobalCounter.upsert({
            where: { period_pool: { period: k.poolPeriod, pool: k.pool } },
            create: { period: k.poolPeriod, pool: k.pool, costMicros: BigInt(totalCost), failoverMicros: BigInt(0) },
            update: { costMicros: { increment: BigInt(totalCost) } },
          });
        }
        await dropReservation(tx as never, k, clampReservation(row.reservedMicros), clampReservation(row.reservedPoolMicros));
      }
      return { applied: true, costMicros: totalCost, billedMicros: totalCost, calls: totalCalls } as const;
    });

    if (outcome.applied) {
      // The Task's per-run totals are a convenience record (Int32 columns); a
      // failure here must not undo the booking, so it is outside the transaction.
      try {
        const row = await db.bulkTranslateBatch.findUnique({ where: { id: batchId }, select: { taskId: true } });
        if (row) {
          await db.task.updateMany({
            where: { id: row.taskId },
            data: {
              inputTokens: { increment: Math.min(items.reduce((n, i) => n + safeTokens(i.inputTokens), 0), MAX_MICROS) },
              outputTokens: { increment: Math.min(items.reduce((n, i) => n + safeTokens(i.outputTokens), 0), MAX_MICROS) },
              costMicros: { increment: Math.min(outcome.costMicros, MAX_MICROS) },
            },
          });
        }
      } catch (error) {
        logger.warn(
          `[AI-METER] Task totals of batch ${batchId} not written: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return outcome;
  } catch (error) {
    if (error instanceof LeaseLostError) return { applied: false, reason: 'leaseLost' };
    logger.error(
      `[AI-METER] Booking the usage of batch ${batchId} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { applied: false, reason: 'failed' };
  }
}
