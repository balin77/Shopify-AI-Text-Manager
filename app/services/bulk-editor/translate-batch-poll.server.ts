/**
 * The tick of the Batch-API mode (PLAN_BULK_TRANSLATE_BATCHING 5.4 / 5.5 / 5.6 /
 * 6 / 19.4): what happens to a provider batch AFTER it was submitted.
 *
 * Nothing in the process "runs" a waiting batch: its whole state is one
 * BulkTranslateBatch row (manifest, lease, hold), so a restart costs nothing and
 * the next tick simply finds the row again. One tick does, per open row:
 *
 *   lease (token compare-and-swap, 2 min)  ->  gates  ->  provider status  ->
 *   [ended] fetch results  ->  BOOK what they cost (one transaction, before any
 *   write)  ->  write through the live run's own machinery (fill-only)  ->
 *   settle the Task and the row.
 *
 * The rules, each a direction of error:
 *  - Settling needs no consent, no budget, no entitlement: what the provider
 *    did is paid for, so retrieve / results / cancel always go through the
 *    settlement transport (credentials module, restricted to those operations).
 *    Whether anything is WRITTEN is decided afterwards by the normal gate.
 *  - CONSENT WITHDRAWN (owner decision, PLAN 16): cancel at once, fetch NOTHING,
 *    write NOTHING, and book the reserved upper bound instead of the actual
 *    cost (the reservation is converted, not released).
 *  - A shop that is no longer allowed to write (the resolver refuses: managed
 *    entitlement gone, no key left) still has its results collected and BOOKED;
 *    they are not written (`managed_ai_refused:<reason>`). An exhausted budget
 *    stops neither the fetch nor the write.
 *  - Booking happens BEFORE writing and is idempotent per row, so a crash after
 *    it re-collects and re-writes (fill-only) without double booking, and a
 *    crash before it books nothing.
 *  - A provider that stops answering for N ticks in a row ends the run as
 *    `batch_unreachable` with the hold released; failures back off, so N ticks
 *    is hours, not minutes.
 *  - Open rows whose Task is terminal or gone (a recovery failed it, the
 *    merchant deleted it, a restart raced a cancel) are ORPHANS: cancelled at
 *    the provider and their hold settled. Provider batches this database does
 *    not know are never touched.
 *  - Shops whose connection is blocked or that uninstalled are skipped (the
 *    uninstall path cancels their batches itself).
 *
 * Never throws out of a tick; every row is its own try/catch.
 */

import { randomUUID } from "node:crypto";
import type { PrismaClient, BulkTranslateBatch } from "@prisma/client";
import {
  OPEN_BATCH_TASK_STATUSES,
  TASK_STATUS_BATCH_UNREACHABLE,
  TASK_STATUS_CANCEL_REQUESTED,
} from "~/config/task-statuses.js";
import { stringList, type SettlementResultItem, type SettlementTransport } from "../ai/batch-settlement.shared";
import { maxOutputTokensFor } from "~/config/ai-model-limits";
import { logger } from "~/utils/logger.server";
import { parseManifest } from "./translate-batch.shared";
import { buildBatchAnswers, runBatchCollect, usageItemsFromResults } from "./translate-batch-collect.server";
import { expireStaleBatches, BATCH_UNREACHABLE_ERROR } from "./translate-batch-expiry.server";

/** A lease holds for this long; the holder renews it while it works. */
export const LEASE_MS = 2 * 60 * 1000;
const LEASE_RENEW_MS = 30 * 1000;
/** Consecutive failed ticks after which a batch that never answers is given up on. */
export const MAX_FAILED_TICKS = 12;
/** Rows handled per tick (each may start a collect run that writes for minutes). */
export const MAX_ROWS_PER_TICK = 10;
/** Provider calls of one tick must not hang it. */
export const PROVIDER_CALL_DEADLINE_MS = 60_000;

const OPEN_ROW_STATES = ["waiting", "cancel_requested", "collecting"] as const;

/** Delay before a row that failed `failedTicks` times in a row is looked at again: 5, 10, 20, then 30 minutes. */
export function failedTickBackoffMs(failedTicks: number): number {
  if (failedTicks <= 0) return 0;
  return Math.min(30 * 60_000, 5 * 60_000 * 2 ** (failedTicks - 1));
}

export type RowOutcome =
  | "busy" // somebody else holds the lease
  | "backoff"
  | "skippedShop" // blocked / uninstalled
  | "waiting" // provider still working
  | "collected"
  | "consentWithdrawn"
  | "refusedWrite" // gate says no: booked, not written
  | "noResult" // ended with nothing usable
  | "orphan"
  | "unreachable"
  | "keyMissing"
  | "failedTick"
  | "leaseLost";

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function withDeadline<T>(call: () => Promise<T>, ms = PROVIDER_CALL_DEADLINE_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      call(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`provider call exceeded ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ─── lease ──────────────────────────────────────────────────────────────────

/** Take the lease by compare-and-swap; the token, or null when somebody else holds a valid one. */
export async function acquireLease(db: PrismaClient, id: string, now: Date = new Date()): Promise<string | null> {
  const token = randomUUID();
  const taken = await db.bulkTranslateBatch.updateMany({
    where: {
      id,
      state: { in: [...OPEN_ROW_STATES] },
      OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
    },
    data: { leaseToken: token, leaseUntil: new Date(now.getTime() + LEASE_MS) },
  });
  return taken.count === 1 ? token : null;
}

async function renewLease(db: PrismaClient, id: string, token: string): Promise<boolean> {
  const res = await db.bulkTranslateBatch.updateMany({
    where: { id, leaseToken: token },
    data: { leaseUntil: new Date(Date.now() + LEASE_MS) },
  });
  return res.count === 1;
}

async function releaseLease(db: PrismaClient, id: string, token: string): Promise<void> {
  await db.bulkTranslateBatch
    .updateMany({ where: { id, leaseToken: token }, data: { leaseToken: null, leaseUntil: null } })
    .catch(() => undefined);
}

// ─── one row ────────────────────────────────────────────────────────────────

export interface RowDeps {
  db: PrismaClient;
  now?: Date;
  /** TEST SEAMS. */
  adminFor?: (shop: string) => Promise<unknown>;
  runCollect?: typeof runBatchCollect;
}

async function cancelAllAtProvider(transport: SettlementTransport, batchIds: string[]): Promise<boolean> {
  let confirmed = true;
  for (const id of batchIds) {
    try {
      await withDeadline(() => transport.cancel(id));
    } catch (error) {
      confirmed = false;
      logger.warn("[BatchPoll] Provider cancel failed", { context: "AI", error: messageOf(error) });
    }
  }
  return confirmed;
}

/** Settle the row and the task of a run that cannot go on. Conditional on the task still being open. */
async function closeRun(
  db: PrismaClient,
  row: Pick<BulkTranslateBatch, "id" | "taskId">,
  token: string | null,
  outcome: { status: string; error: string | null; result?: unknown },
): Promise<void> {
  await db.task.updateMany({
    where: { id: row.taskId, status: { in: [...OPEN_BATCH_TASK_STATUSES] } },
    data: {
      status: outcome.status,
      progress: 100,
      completedAt: new Date(),
      error: outcome.error ? outcome.error.substring(0, 1000) : null,
      ...(outcome.result !== undefined ? { result: JSON.stringify(outcome.result) } : {}),
    },
  });
  await db.bulkTranslateBatch.updateMany({
    where: { id: row.id, ...(token ? { leaseToken: token } : {}) },
    data: { state: "done", lastError: outcome.error ? outcome.error.substring(0, 500) : null },
  });
}

/** A provider answer failed: count it; after MAX_FAILED_TICKS the run is given up on, the hold released. */
async function noteFailedTick(deps: RowDeps, row: BulkTranslateBatch, token: string, error: unknown): Promise<RowOutcome> {
  const { db } = deps;
  const failedTicks = row.failedTicks + 1;
  logger.warn("[BatchPoll] Tick failed for a batch", { context: "AI", batchRowId: row.id, failedTicks, error: messageOf(error) });
  if (failedTicks >= MAX_FAILED_TICKS) {
    await closeRun(db, row, token, { status: TASK_STATUS_BATCH_UNREACHABLE, error: BATCH_UNREACHABLE_ERROR });
    const { releaseBudget } = await import("../ai/usage-meter.server");
    await releaseBudget(row.id);
    return "unreachable";
  }
  await db.bulkTranslateBatch.updateMany({
    where: { id: row.id, leaseToken: token },
    data: { failedTicks, lastError: messageOf(error).substring(0, 500), state: row.state === "collecting" ? "waiting" : row.state },
  });
  return "failedTick";
}

export async function processBatchRow(rowId: string, deps: RowDeps): Promise<RowOutcome> {
  const { db } = deps;
  const now = deps.now ?? new Date();
  const token = await acquireLease(db, rowId, now);
  if (!token) return "busy";
  const renew = setInterval(() => void renewLease(db, rowId, token).catch(() => undefined), LEASE_RENEW_MS);
  try {
    const row = await db.bulkTranslateBatch.findUnique({ where: { id: rowId } });
    if (!row) return "busy";
    return await handleRow(deps, row, token);
  } catch (error) {
    logger.error("[BatchPoll] Row failed", { context: "AI", batchRowId: rowId, error: messageOf(error) });
    return "failedTick";
  } finally {
    clearInterval(renew);
    await releaseLease(db, rowId, token);
  }
}

async function handleRow(deps: RowDeps, row: BulkTranslateBatch, token: string): Promise<RowOutcome> {
  const { db } = deps;
  const shop = row.shop;
  const { settlementCredentialsFor, resolveAiCredentials, aiServiceFor } = await import("../ai/ai-credentials.server");
  const { convertReservation, releaseBudget, settleBatchUsage } = await import("../ai/usage-meter.server");
  const batchIds = stringList(row.batchIds);

  // 1. The Task. Gone or already terminal = an ORPHAN row: nothing waits for its result any more.
  const task = await db.task.findUnique({
    where: { id: row.taskId },
    select: { id: true, status: true, shop: true },
  });
  const decision = await settlementCredentialsFor(shop, row.id);
  const orphan = !task || !(OPEN_BATCH_TASK_STATUSES as string[]).includes(task.status);
  if (orphan) {
    // Cancel at the provider (best effort), then settle the hold: a confirmed cancel is not a charge, an
    // unconfirmed one may still bill and is booked at the reserved upper bound.
    const confirmed = batchIds.length === 0 || (decision.ok && (await cancelAllAtProvider(decision.transport, batchIds)));
    await db.bulkTranslateBatch.updateMany({
      where: { id: row.id, leaseToken: token },
      data: { state: "done", lastError: task ? `task_${task.status}` : "task_gone" },
    });
    await (batchIds.length > 0 && !confirmed ? convertReservation : releaseBudget)(row.id);
    logger.warn("[BatchPoll] Orphan batch row settled", { context: "AI", batchRowId: row.id, cancelConfirmed: confirmed });
    return "orphan";
  }

  // 2. Shops we cannot talk to are skipped, not failed (uninstall cancels its own batches).
  let admin: unknown;
  try {
    admin = await (deps.adminFor ?? (async (s: string) => (await import("~/utils/admin-client.server")).createAdminClientFromShop(s)))(shop);
  } catch (error) {
    logger.debug(`[BatchPoll] ${shop} skipped: ${messageOf(error)}`);
    return "skippedShop";
  }
  const settings = await db.aISettings.findUnique({ where: { shop } });

  // 3. CONSENT WITHDRAWN (managed rows): cancel at once, fetch nothing, book the reserved upper bound.
  const writeGate = resolveAiCredentials({ shop, settings });
  if (row.source === "managed" && !writeGate.ok && writeGate.reason === "consentMissing") {
    await db.bulkTranslateBatch.updateMany({ where: { id: row.id, leaseToken: token }, data: { consentWithdrawnAt: new Date() } });
    if (decision.ok) await cancelAllAtProvider(decision.transport, batchIds);
    await convertReservation(row.id);
    await closeRun(db, row, token, { status: "failed", error: "managed_ai_refused:consentMissing" });
    return "consentWithdrawn";
  }

  // 4. Access to the provider. A BYO shop whose key is gone cannot be settled: the batch runs out at the provider.
  if (!decision.ok) {
    if (decision.reason === "ai_key_missing") {
      await closeRun(db, row, token, { status: "failed", error: "ai_key_missing" });
      // The batch may still run and bill the merchant's own provider account; nothing of ours is reserved.
      await releaseBudget(row.id);
      return "keyMissing";
    }
    return await noteFailedTick(deps, row, token, new Error(`settlement_${decision.reason}`));
  }
  const transport = decision.transport;

  // 5. The merchant asked to cancel: tell the provider, then collect what is already paid for.
  const cancelRequested = row.state === "cancel_requested" || task!.status === TASK_STATUS_CANCEL_REQUESTED;
  if (cancelRequested) {
    try {
      for (const id of batchIds) await withDeadline(() => transport.cancel(id));
    } catch (error) {
      return await noteFailedTick(deps, row, token, error);
    }
  }

  // 6. Where is the provider?
  let ended = batchIds.length > 0;
  let expiresAtIso: string | null = null;
  try {
    for (const id of batchIds) {
      const status = await withDeadline(() => transport.retrieve(id));
      if (!status.ended) ended = false;
      if (status.expiresAt) expiresAtIso = status.expiresAt;
    }
  } catch (error) {
    return await noteFailedTick(deps, row, token, error);
  }
  if (!ended) {
    // Still working: the task stays open and must not be cleaned up -- push its expiry past the provider's.
    const expiresAtMs = expiresAtIso ? Date.parse(expiresAtIso) : NaN;
    await db.task.updateMany({
      where: { id: row.taskId, status: { in: [...OPEN_BATCH_TASK_STATUSES] } },
      data: { expiresAt: new Date((Number.isFinite(expiresAtMs) ? expiresAtMs : Date.now()) + 3 * 24 * 3600 * 1000) },
    });
    await db.bulkTranslateBatch.updateMany({ where: { id: row.id, leaseToken: token }, data: { failedTicks: 0 } });
    return "waiting";
  }

  // 7. ENDED: fetch the results (the paid-for part of a cancelled batch included).
  await db.bulkTranslateBatch.updateMany({ where: { id: row.id, leaseToken: token }, data: { state: "collecting", failedTicks: 0 } });
  const results = new Map<string, SettlementResultItem>();
  try {
    for (const id of batchIds) {
      for await (const item of transport.results(id)) results.set(item.customId, item);
    }
  } catch (error) {
    return await noteFailedTick(deps, { ...row, state: "collecting" }, token, error);
  }
  const manifest = parseManifest(row.manifest);
  if (!manifest) {
    await closeRun(db, row, token, { status: "failed", error: "batch_failed" });
    await releaseBudget(row.id);
    return "noResult";
  }
  const answers = buildBatchAnswers(manifest, results);
  const usage = usageItemsFromResults(manifest, results, row.provider as never, row.model);

  // 8. BOOK before writing (one transaction, idempotent per row, lease-checked).
  const booked = await settleBatchUsage(row.id, usage, { leaseToken: token });
  if (!booked.applied && booked.reason === "leaseLost") return "leaseLost";
  if (!booked.applied && booked.reason === "failed") {
    return await noteFailedTick(deps, { ...row, state: "collecting" }, token, new Error("booking_failed"));
  }

  const summary = {
    ...answers.counts,
    undelivered: answers.undelivered.size,
    bookedMicros: booked.applied ? booked.billedMicros : null,
  };
  const finalResult = (error: string | null, status: string) => ({
    status,
    error,
    result: {
      saved: 0,
      failed: 0,
      skippedHandles: 0,
      skippedChanged: 0,
      skippedFilled: 0,
      skippedGone: 0,
      mode: "batch",
      blocks: 0,
      batch: summary,
      failures: [] as unknown[],
    },
  });

  // 9. May anything be WRITTEN? The normal gate decides (an exhausted budget is not in it).
  if (row.source === "managed" && !writeGate.ok) {
    await closeRun(db, row, token, finalResult(`managed_ai_refused:${writeGate.reason === "noKey" ? "managedUnavailable" : writeGate.reason}`, "failed"));
    return "refusedWrite";
  }
  // Nothing usable (everything expired / errored / was cancelled before it ran): a whole run without a result.
  if (answers.counts.succeeded === 0) {
    const cancelled = cancelRequested;
    await closeRun(
      db,
      row,
      token,
      finalResult(cancelled ? null : answers.counts.expired > 0 ? "batch_expired" : "batch_failed", cancelled ? "cancelled" : "failed"),
    );
    return "noResult";
  }

  // 10. WRITE, through the live run's own machinery (verification, handle rules, fill-only write).
  let live = null as ReturnType<typeof aiServiceFor>["service"] | null;
  try {
    const built = aiServiceFor(settings, shop, row.taskId);
    if (built.decision.ok && built.service.packageLimits().provider === row.provider) live = built.service;
  } catch {
    live = null; // live retries are a bonus; their absence changes nothing else
  }
  const aiInstructions = await db.aIInstructions.findUnique({ where: { shop } }).catch(() => null);
  const { resolveSeoContext } = await import("~/routes/api-ai-handlers/shared");
  const seo = resolveSeoContext(settings);
  await (deps.runCollect ?? runBatchCollect)({
    db,
    shop,
    admin: admin as never,
    settings,
    taskId: row.taskId,
    manifest,
    answers,
    live,
    aiInstructions,
    seoLimits: seo.seoLimits,
    translationMode: seo.translationMode,
    summary,
    maxOutputTokens: maxOutputTokensFor(row.provider as never, row.model),
  });

  // 11. The run settles the Task itself. A task still open afterwards means it stopped early: look again next tick.
  const after = await db.task.findUnique({ where: { id: row.taskId }, select: { status: true } });
  if (after && (OPEN_BATCH_TASK_STATUSES as string[]).includes(after.status)) {
    await db.bulkTranslateBatch.updateMany({ where: { id: row.id, leaseToken: token }, data: { state: "waiting", failedTicks: row.failedTicks + 1 } });
    return "failedTick";
  }
  await db.bulkTranslateBatch.updateMany({ where: { id: row.id, leaseToken: token }, data: { state: "done", lastError: null } });
  // Anthropic leaves no files; an OpenAI input / output / error file would be deleted here.
  for (const fileId of stringList(row.fileIds)) await transport.deleteFile(fileId).catch(() => undefined);
  return "collected";
}

// ─── the tick ───────────────────────────────────────────────────────────────

export interface PollStats {
  expired: number;
  rows: number;
  outcomes: Partial<Record<RowOutcome, number>>;
}

/** One pass over the open rows. Public so tests and the service drive it directly. */
export async function pollBatchesOnce(deps: RowDeps): Promise<PollStats> {
  const { db } = deps;
  const now = deps.now ?? new Date();
  const stats: PollStats = { expired: 0, rows: 0, outcomes: {} };
  try {
    // The absolute end and the reservation sweep first: they free what a dead run still holds.
    stats.expired = (await expireStaleBatches(now)).expired;
    const { releaseSettledReservations } = await import("../ai/usage-meter.server");
    await releaseSettledReservations();

    // Oldest first; a deliberate scan (the table is small: rows are pruned with their tasks).
    const rows = await db.bulkTranslateBatch.findMany({
      where: {
        state: { in: [...OPEN_ROW_STATES] },
        OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
      },
      orderBy: { updatedAt: "asc" },
      take: MAX_ROWS_PER_TICK,
      select: { id: true, failedTicks: true, updatedAt: true },
    });
    stats.rows = rows.length;
    for (const { id, failedTicks, updatedAt } of rows) {
      // Failures back off. Decided HERE, on the timestamps as the SELECT saw them: taking the lease bumps
      // `updatedAt` itself, so a check made after it would see "just now" and never let a failed row retry.
      if (failedTicks > 0 && now.getTime() - updatedAt.getTime() < failedTickBackoffMs(failedTicks)) {
        stats.outcomes.backoff = (stats.outcomes.backoff ?? 0) + 1;
        continue;
      }
      const outcome = await processBatchRow(id, deps);
      stats.outcomes[outcome] = (stats.outcomes[outcome] ?? 0) + 1;
    }
  } catch (error) {
    logger.error("[BatchPoll] Tick failed", { context: "AI", error: messageOf(error) });
  }
  return stats;
}
