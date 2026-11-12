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
 *  - CONSENT WITHDRAWN (owner decision, PLAN 16): cancel at once, fetch NO
 *    CONTENT, write NOTHING. The hold is booked pro rata from the provider's
 *    request counts (a status read, no content) where they can be read, else at
 *    the reserved upper bound -- never released while the batch may have run. A
 *    consent NOTICE VERSION bump is not a withdrawal: the row is held (nothing
 *    fetched, nothing written, nothing cancelled) until the merchant answers the
 *    new notice or the absolute end.
 *  - EVERY terminal path settles the hold by the guiding rule of
 *    translate-batch-hold.server.ts (booked from evidence, converted to the upper
 *    bound, released only on proof) and does so BEFORE the row is marked done,
 *    so the reservation sweep can never release what should be converted.
 *  - Our own configuration refusals (kill switch, dev build, no credential,
 *    provider changed) are not the provider failing: they do not count as failed
 *    ticks, the row waits, and the absolute end converts the hold.
 *  - A shop that is no longer allowed to write (the resolver refuses: managed
 *    entitlement gone, no key left) still has its results collected and BOOKED;
 *    they are not written (`managed_ai_refused:<reason>`). An exhausted budget
 *    stops neither the fetch nor the write.
 *  - Booking happens BEFORE writing and is idempotent per row, so a crash after
 *    it re-collects and re-writes (fill-only) without double booking, and a
 *    crash before it books nothing.
 *  - A provider that stops answering for N ticks in a row ends the run as
 *    `batch_unreachable` (the hold settled by the guiding rule: unreadable =
 *    upper bound); failures back off, so N ticks is hours, not minutes.
 *  - Open rows whose Task is terminal or gone (a recovery failed it, the
 *    merchant deleted it, a restart raced a cancel) are ORPHANS: cancelled at
 *    the provider and their hold settled. Provider batches this database does
 *    not know are never touched.
 *  - A row whose create answer never arrived (`create_unknown`) searches the
 *    provider for the batch by its own id prefix and adopts it; at the absolute
 *    end the hold is converted (translate-batch-expiry.server.ts).
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
import { aiProcessingConsentState } from "../ai/managed-ai.shared";
import { maxOutputTokensFor } from "~/config/ai-model-limits";
import { logger } from "~/utils/logger.server";
import { parseManifest } from "./translate-batch.shared";
import { buildBatchAnswers, runBatchCollect, usageItemsFromResults } from "./translate-batch-collect.server";
import { expireStaleBatches, BATCH_UNREACHABLE_ERROR, BATCH_SUBMIT_UNCONFIRMED_ERROR } from "./translate-batch-expiry.server";
import { settleHold } from "./translate-batch-hold.server";

/** Terminal code of a collect that stayed open for MAX_FAILED_TICKS ticks (results booked, some may be written). */
export const BATCH_COLLECT_FAILED_ERROR = "batch_collect_failed";

/** A lease holds for this long; the holder renews it while it works. */
export const LEASE_MS = 2 * 60 * 1000;
const LEASE_RENEW_MS = 30 * 1000;
/** How often a running collect re-reads its lease token (the write path asks before every row and block). */
const LEASE_CHECK_MS = 5 * 1000;
/** Consecutive failed ticks after which a batch that never answers is given up on. */
export const MAX_FAILED_TICKS = 12;
/** Rows handled per tick (each may start a collect run that writes for minutes). */
export const MAX_ROWS_PER_TICK = 10;
/** Provider calls of one tick must not hang it. */
export const PROVIDER_CALL_DEADLINE_MS = 60_000;

const OPEN_ROW_STATES = ["create_unknown", "waiting", "cancel_requested", "collecting"] as const;

/** Our own configuration said no (not the provider failing): the row waits, nothing counts against it. */
const CONFIG_REFUSALS = ["managedDisabled", "devBuild", "noCredential", "providerChanged"];

/** Delay before a row that failed `failedTicks` times in a row is looked at again: 5, 10, 20, then 30 minutes. */
export function failedTickBackoffMs(failedTicks: number): number {
  if (failedTicks <= 0) return 0;
  return Math.min(30 * 60_000, 5 * 60_000 * 2 ** (failedTicks - 1));
}

export type RowOutcome =
  | "busy" // somebody else holds the lease
  | "leaseLost" // our lease was taken over mid-tick
  | "backoff"
  | "skippedShop" // blocked / uninstalled
  | "waiting" // provider still working
  | "collected"
  | "consentWithdrawn"
  | "consentOutdated" // a new notice version is unanswered: held, nothing cancelled, fetched or written
  | "configBlocked" // our own configuration refuses settlement access: waits for the absolute end
  | "adopted" // a create of unknown outcome was found at the provider
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

/** True only when the provider shows EVERY batch ended (a failed or missing read is "not known to have ended"). */
async function batchesEnded(transport: SettlementTransport | null, batchIds: string[]): Promise<boolean> {
  if (!transport || batchIds.length === 0) return false;
  try {
    for (const id of batchIds) {
      const status = await withDeadline(() => transport.retrieve(id));
      if (!status.ended) return false;
    }
    return true;
  } catch {
    return false;
  }
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

const CONSENT_GIVE_UP_CODE = "managed_ai_refused:consentMissing";

function isCollectMarked(lastError: string | null | undefined): boolean {
  return (lastError ?? "").startsWith(BATCH_COLLECT_FAILED_ERROR);
}

/** What the Task and the code say when a run is given up on after MAX_FAILED_TICKS. */
function giveUpOutcome(row: Pick<BulkTranslateBatch, "batchIds">, errorCode?: string) {
  if (errorCode) return { status: "failed", error: errorCode };
  return stringList(row.batchIds).length === 0
    ? { status: "failed", error: BATCH_SUBMIT_UNCONFIRMED_ERROR }
    : { status: TASK_STATUS_BATCH_UNREACHABLE, error: BATCH_UNREACHABLE_ERROR };
}

/**
 * A provider answer failed: count it; after MAX_FAILED_TICKS the run is given up on. The hold is settled FIRST
 * (the guiding rule: a last look at the counts, the upper bound where they cannot be read) and the row closed after.
 */
async function noteFailedTick(
  deps: RowDeps,
  row: BulkTranslateBatch,
  token: string,
  error: unknown,
  transport: SettlementTransport | null = null,
  giveUpCode?: string,
  cancelWanted = false,
): Promise<RowOutcome> {
  const { db } = deps;
  // Read the row FRESH: the in-memory copy is from the start of the tick, and step 8 rewrites the counter and the
  // state in the database. The counter and the "a collect was reached" evidence are the DATABASE's.
  const fresh = await db.bulkTranslateBatch
    .findUnique({ where: { id: row.id }, select: { failedTicks: true, lastError: true, reservationState: true, source: true, leaseToken: true, cancelRequestedAt: true } })
    .catch(() => null);
  // Another tick took the lease over (ours expired): no give-up, no close, no settle from this tick.
  if (fresh && fresh.leaseToken !== token) return "leaseLost";
  const storedTicks = fresh?.failedTicks ?? row.failedTicks;
  const failedTicks = storedTicks + 1;
  // A failure inside the collect (results fetch, booking, write) is marked in `lastError`. The mark outlives later
  // ticks that fail EARLIER (a status read): by then the cost may be booked and writes may exist, so the give-up
  // must say "collect failed", never "nothing was written". A booking that left `held` is the same evidence.
  const collectPhase = row.state === "collecting";
  const priorCollect = isCollectMarked(fresh?.lastError);
  const bookedAlready =
    fresh?.source === "managed" && ["converted", "released"].includes(fresh.reservationState ?? "");
  const collectReached = collectPhase || priorCollect || bookedAlready;
  const errorText = messageOf(error);
  const marked = (collectPhase || priorCollect) && !isCollectMarked(errorText) ? `${BATCH_COLLECT_FAILED_ERROR}:${errorText}` : errorText;
  const lastError = marked.substring(0, 500);
  logger.warn("[BatchPoll] Tick failed for a batch", { context: "AI", batchRowId: row.id, failedTicks, error: errorText });
  // A wanted cancel that the provider has not CONFIRMED means a paid batch may still run unattended: the row is
  // not given up on while the batch has not ended (counting and backoff go on; the 48 h expiry is the hard end).
  const cancelUnconfirmed =
    (cancelWanted || row.state === "cancel_requested" || !!row.consentWithdrawnAt) &&
    !(fresh ? fresh.cancelRequestedAt : row.cancelRequestedAt) &&
    stringList(row.batchIds).length > 0;
  if (failedTicks >= MAX_FAILED_TICKS && cancelUnconfirmed && !(await batchesEnded(transport, stringList(row.batchIds)))) {
    logger.warn("[BatchPoll] Give-up deferred: a wanted provider cancel is not confirmed and the batch has not ended", { context: "AI", batchRowId: row.id, failedTicks });
  } else if (failedTicks >= MAX_FAILED_TICKS) {
    const outcome = await settleHold(row, transport, { final: true });
    if (outcome.kind !== "pending") {
      await closeRun(db, row, token, giveUpOutcome(row, giveUpCode ?? (collectReached ? BATCH_COLLECT_FAILED_ERROR : undefined)));
      return "unreachable";
    }
  }
  await db.bulkTranslateBatch.updateMany({
    where: { id: row.id, leaseToken: token },
    data: { failedTicks, lastError, state: row.state === "collecting" ? "waiting" : row.state },
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

type Access = { ok: true; transport: SettlementTransport } | { ok: false; reason: string };

/** An orphan row: nobody waits for its result. Cancel at the provider, settle the hold by the guiding rule, close. */
async function handleOrphan(
  deps: RowDeps,
  row: BulkTranslateBatch,
  token: string,
  task: { status: string } | null,
  transport: SettlementTransport | null,
): Promise<RowOutcome> {
  const { db } = deps;
  const batchIds = stringList(row.batchIds);
  let cancelConfirmed = batchIds.length === 0 || !!row.cancelRequestedAt;
  if (!cancelConfirmed && transport) {
    if (await cancelAllAtProvider(transport, batchIds)) {
      cancelConfirmed = true;
      await db.bulkTranslateBatch.updateMany({ where: { id: row.id, leaseToken: token }, data: { cancelRequestedAt: new Date() } });
    }
  }
  // Closed only when the cancel is CONFIRMED (now or earlier) or the provider shows the batch ENDED.
  if (!cancelConfirmed && !(await batchesEnded(transport, batchIds))) {
    logger.info("[BatchPoll] Orphan batch row: provider cancel not confirmed yet; retrying next tick", { context: "AI", batchRowId: row.id });
    return "orphan";
  }
  // A confirmed cancel proves nothing (it takes effect asynchronously, and a batch that had ended ran): the
  // counts decide -- released only when nothing succeeded, booked pro rata otherwise, converted when unreadable at the end.
  const outcome = await settleHold(row, transport, { final: false });
  if (outcome.kind === "pending") {
    logger.info("[BatchPoll] Orphan batch row not settled yet", { context: "AI", batchRowId: row.id, reason: outcome.reason });
    return "orphan";
  }
  await db.bulkTranslateBatch.updateMany({
    where: { id: row.id, leaseToken: token },
    data: { state: "done", lastError: task ? `task_${task.status}` : "task_gone" },
  });
  logger.warn("[BatchPoll] Orphan batch row settled", { context: "AI", batchRowId: row.id, hold: outcome.kind });
  return "orphan";
}

/**
 * CONSENT WITHDRAWN (owner decision, PLAN 16): cancel at once, fetch no content, write nothing. The hold is
 * settled by the counts (pro rata, a status read) or the upper bound. The row stays open (and withdrawn: a later
 * re-consent does not revive it, the cancel is irreversible) until the batch has ended and the hold is settled.
 */
async function handleWithdrawal(deps: RowDeps, row: BulkTranslateBatch, token: string, access: Access): Promise<RowOutcome> {
  const { db } = deps;
  const batchIds = stringList(row.batchIds);
  if (!row.consentWithdrawnAt) {
    await db.bulkTranslateBatch.updateMany({
      where: { id: row.id, leaseToken: token },
      data: { consentWithdrawnAt: new Date(), state: "cancel_requested" },
    });
  }
  if (!access.ok) {
    // Cannot cancel or read: our own configuration (wait for the absolute end, which converts) or a lookup failure.
    return CONFIG_REFUSALS.includes(access.reason)
      ? "configBlocked"
      : await noteFailedTick(deps, row, token, new Error(`settlement_${access.reason}`), null, CONSENT_GIVE_UP_CODE, true);
  }
  let cancelConfirmed = batchIds.length === 0 || !!row.cancelRequestedAt;
  if (!cancelConfirmed) {
    if (await cancelAllAtProvider(access.transport, batchIds)) {
      cancelConfirmed = true;
      await db.bulkTranslateBatch.updateMany({ where: { id: row.id, leaseToken: token }, data: { cancelRequestedAt: new Date() } });
    }
  }
  // No content is fetched; ended-ness is a status read. The row closes only after a confirmed cancel or an ended batch.
  if (!cancelConfirmed && !(await batchesEnded(access.transport, batchIds))) return "consentWithdrawn";
  const outcome = await settleHold(row, access.transport, { final: false });
  if (outcome.kind === "pending") return "consentWithdrawn";
  await closeRun(db, row, token, { status: "failed", error: CONSENT_GIVE_UP_CODE });
  return "consentWithdrawn";
}

/** A create whose answer never arrived: search the provider for the batch it may have made. */
async function reconcileUnknownCreate(
  deps: RowDeps,
  row: BulkTranslateBatch,
  token: string,
  access: Access,
  cancelWanted: boolean,
): Promise<RowOutcome> {
  const { db } = deps;
  if (!access.ok) {
    return CONFIG_REFUSALS.includes(access.reason)
      ? "configBlocked"
      : await noteFailedTick(deps, row, token, new Error(`settlement_${access.reason}`));
  }
  const manifest = parseManifest(row.manifest);
  const requestCount = manifest?.requests.length ?? 0;
  if (!row.idPrefix || !row.intentAt || requestCount === 0) return "waiting"; // cannot search: the absolute end converts
  let search;
  try {
    search = await withDeadline(() =>
      access.transport.findIntentBatch({ idPrefix: row.idPrefix, since: row.intentAt!.toISOString(), requestCount }),
    );
  } catch (error) {
    return await noteFailedTick(deps, row, token, error, access.transport);
  }
  if (!search.found) return "waiting"; // nothing yet (or a running candidate that cannot be told from a stranger's)
  const adopted = await db.bulkTranslateBatch.updateMany({
    where: { id: row.id, leaseToken: token },
    data: { batchIds: [search.batchId], state: cancelWanted ? "cancel_requested" : "waiting", failedTicks: 0, lastError: null },
  });
  if (adopted.count === 0) {
    // The row changed under us (lease lost, closed, adopted by the submit): re-read and leave it for the next tick.
    return "waiting";
  }
  const expiresAtMs = search.expiresAt ? Date.parse(search.expiresAt) : NaN;
  await db.task.updateMany({
    where: { id: row.taskId, status: { in: [...OPEN_BATCH_TASK_STATUSES] } },
    data: { expiresAt: new Date((Number.isFinite(expiresAtMs) ? expiresAtMs : Date.now()) + 3 * 24 * 3600 * 1000) },
  });
  logger.info("[BatchPoll] Adopted a batch whose create answer was lost", { context: "AI", batchRowId: row.id });
  return "adopted";
}

/** Step 3b: one provider cancel attempt for a row that wants one and has none CONFIRMED yet. */
async function attemptWantedCancel(
  deps: RowDeps,
  row: BulkTranslateBatch,
  token: string,
  decision: Access,
  cancelRequested: boolean,
  batchIds: string[],
): Promise<{ outcome: RowOutcome } | { cancelFailed: boolean; row: BulkTranslateBatch }> {
  const { db } = deps;
  if (!(cancelRequested && batchIds.length > 0 && !row.cancelRequestedAt)) return { cancelFailed: false, row };
  if (!decision.ok) {
    // Own key gone / our configuration refuses: cannot cancel. The row is NOT closed; the absolute end converts.
    logger.warn("[BatchPoll] Cancel wanted but no settlement access; the row waits for the absolute end", {
      context: "AI",
      batchRowId: row.id,
      reason: decision.reason,
    });
    if (decision.reason === "ai_key_missing") return { outcome: "keyMissing" };
    if (CONFIG_REFUSALS.includes(decision.reason)) return { outcome: "configBlocked" };
    return {
      outcome: await noteFailedTick(deps, row, token, new Error(`settlement_${decision.reason}`), null, undefined, true),
    };
  }
  if (await cancelAllAtProvider(decision.transport, batchIds)) {
    const at = new Date();
    await db.bulkTranslateBatch.updateMany({ where: { id: row.id, leaseToken: token }, data: { cancelRequestedAt: at } });
    return { cancelFailed: false, row: { ...row, cancelRequestedAt: at } };
  }
  return { cancelFailed: true, row };
}

async function handleRow(deps: RowDeps, row: BulkTranslateBatch, token: string): Promise<RowOutcome> {
  const { db } = deps;
  const shop = row.shop;
  const { settlementCredentialsFor, resolveAiCredentials, aiServiceFor } = await import("../ai/ai-credentials.server");
  const { settleBatchUsage } = await import("../ai/usage-meter.server");
  const batchIds = stringList(row.batchIds);

  // 1. The Task. Gone or already terminal = an ORPHAN row: nothing waits for its result any more.
  const task = await db.task.findUnique({
    where: { id: row.taskId },
    select: { id: true, status: true, shop: true },
  });
  const decision = await settlementCredentialsFor(shop, row.id);
  const orphan = !task || !(OPEN_BATCH_TASK_STATUSES as string[]).includes(task.status);
  // Neither the orphan logic nor the consent gate needs Shopify: both come BEFORE the admin lookup, so a shop
  // whose connection is blocked can still have its orphans cancelled and a withdrawal honoured.
  if (orphan) {
    // No batch id: a create of unknown outcome may still have made one -- look for it, so the next tick can cancel it.
    if (batchIds.length === 0) {
      // The search READS result content of candidate batches: without a standing consent it does not happen
      // (withdrawn or an unanswered new notice). The row is left to the absolute end, which converts the hold.
      if (row.source === "managed") {
        const orphanSettings = await db.aISettings.findUnique({ where: { shop } });
        if (row.consentWithdrawnAt || aiProcessingConsentState(orphanSettings) !== "current") return "orphan";
      }
      return await reconcileUnknownCreate(deps, row, token, decision, true);
    }
    return await handleOrphan(deps, row, token, task, decision.ok ? decision.transport : null);
  }

  const settings = await db.aISettings.findUnique({ where: { shop } });

  // 2. CONSENT (managed rows). WITHDRAWN is checked before anything else about access (the kill switch included).
  if (row.source === "managed") {
    const consent = aiProcessingConsentState(settings);
    if (row.consentWithdrawnAt || consent === "withdrawn") return await handleWithdrawal(deps, row, token, decision);
    // A bumped notice version is an unanswered NEW question, not a request to stop: hold the row.
    if (consent === "outdated") {
      // A cancel reads and writes no content, so a wanted one is still attempted while the notice is unanswered.
      const wanted = row.state === "cancel_requested" || task!.status === TASK_STATUS_CANCEL_REQUESTED;
      if (wanted && batchIds.length > 0 && !row.cancelRequestedAt) {
        const attempt = await attemptWantedCancel(deps, row, token, decision, true, batchIds);
        if ("outcome" in attempt) return attempt.outcome;
      }
      return "consentOutdated";
    }
  }

  const cancelRequested = row.state === "cancel_requested" || task!.status === TASK_STATUS_CANCEL_REQUESTED;

  // 3. A create of unknown outcome: find its batch (or wait for the absolute end).
  if (row.state === "create_unknown" && batchIds.length > 0) {
    // The row already names its batch (the submit got the answer after a recovery parked it): go to that id,
    // no provider search.
    const nextState = cancelRequested ? "cancel_requested" : "waiting";
    await db.bulkTranslateBatch.updateMany({
      where: { id: row.id, leaseToken: token, state: "create_unknown" },
      data: { state: nextState, failedTicks: 0, lastError: null },
    });
    row = { ...row, state: nextState, failedTicks: 0, lastError: null };
  } else if (row.state === "create_unknown" || batchIds.length === 0) {
    return await reconcileUnknownCreate(deps, row, token, decision, cancelRequested);
  }

  // 3b. A row that wants a cancel gets a provider attempt on EVERY tick until it is CONFIRMED (cancelRequestedAt):
  //     it needs only the settlement credentials, never the shop's admin client, so an uninstalled shop's row
  //     is retried too. No content is fetched and nothing is written here.
  const cancelAttempt = await attemptWantedCancel(deps, row, token, decision, cancelRequested, batchIds);
  if ("outcome" in cancelAttempt) return cancelAttempt.outcome;
  const cancelFailed = cancelAttempt.cancelFailed;
  row = cancelAttempt.row;

  // 4. Shops we cannot talk to are skipped, not failed (uninstall cancels its own batches).
  let admin: unknown;
  try {
    admin = await (deps.adminFor ?? (async (s: string) => (await import("~/utils/admin-client.server")).createAdminClientFromShop(s)))(shop);
  } catch (error) {
    logger.debug(`[BatchPoll] ${shop} skipped: ${messageOf(error)}`);
    return "skippedShop";
  }

  // 5. Access to the provider. A BYO shop whose key is gone cannot be settled: the batch runs out at the provider.
  if (!decision.ok) {
    if (decision.reason === "ai_key_missing") {
      // An own-key run holds nothing of ours; the merchant's provider account is billed for whatever ran.
      await closeRun(db, row, token, { status: "failed", error: "ai_key_missing" });
      return "keyMissing";
    }
    // Our own configuration refuses (kill switch, dev build, no credential, provider changed): not the provider failing.
    if (CONFIG_REFUSALS.includes(decision.reason)) {
      logger.warn("[BatchPoll] Settlement access refused by configuration; the row waits", { context: "AI", batchRowId: row.id, reason: decision.reason });
      return "configBlocked";
    }
    return await noteFailedTick(deps, row, token, new Error(`settlement_${decision.reason}`), null, undefined, cancelRequested);
  }
  const transport = decision.transport;

  // 6. (the provider cancel was attempted in 3b; a confirmed one is never repeated)

  // 7. Where is the provider?
  let ended = batchIds.length > 0;
  let expiresAtIso: string | null = null;
  // What the provider says succeeded: the result stream must account for every one of them (L2).
  let succeededExpected: number | null = 0;
  try {
    for (const id of batchIds) {
      const status = await withDeadline(() => transport.retrieve(id));
      if (!status.ended) ended = false;
      if (status.expiresAt) expiresAtIso = status.expiresAt;
      const counted = status.requestCounts?.succeeded;
      succeededExpected = typeof counted === "number" && succeededExpected !== null ? succeededExpected + counted : null;
    }
  } catch (error) {
    return await noteFailedTick(deps, row, token, error, transport, undefined, cancelRequested);
  }
  if (!ended && cancelFailed) {
    // The cancel was not confirmed and the batch still runs: a failed tick (counted, backed off, retried).
    return await noteFailedTick(deps, row, token, new Error("provider_cancel_failed"), transport, undefined, true);
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

  // 8. ENDED: fetch the results (the paid-for part of a cancelled batch included).
  await db.bulkTranslateBatch.updateMany({ where: { id: row.id, leaseToken: token }, data: { state: "collecting", ...(isCollectMarked(row.lastError) ? {} : { failedTicks: 0 }) } });
  // The counter is NOT reset when an earlier tick already failed inside the collect: those failures must add up
  // to the give-up, or a collect that fails every time would restart its count on every tick and never end.
  const results = new Map<string, SettlementResultItem>();
  try {
    for (const id of batchIds) {
      for await (const item of transport.results(id)) results.set(item.customId, item);
    }
  } catch (error) {
    return await noteFailedTick(deps, { ...row, state: "collecting" }, token, error, transport);
  }
  // A result stream that stopped early looks exactly like requests that were never answered: a SHORTFALL against
  // the provider's own count is a failed tick (retried), never "missing" -- booking and writing on a partial
  // stream would under-book what the provider charged and re-translate what it already delivered.
  const succeededSeen = [...results.values()].filter((r) => r.outcome === "succeeded").length;
  if (succeededExpected !== null && succeededSeen < succeededExpected) {
    return await noteFailedTick(
      deps,
      { ...row, state: "collecting" },
      token,
      new Error(`results_incomplete:${succeededSeen}/${succeededExpected}`),
      transport,
    );
  }
  const manifest = parseManifest(row.manifest);
  if (!manifest) {
    // Unreadable manifest: the results cannot be matched, but the batch ran -- the hold is settled by the counts.
    const outcome = await settleHold(row, transport, { final: true });
    if (outcome.kind !== "pending") await closeRun(db, row, token, { status: "failed", error: "batch_failed" });
    return "noResult";
  }
  const answers = buildBatchAnswers(manifest, results);
  const usage = usageItemsFromResults(manifest, results, row.provider as never, row.model);

  // 9. BOOK before writing (one transaction, idempotent per row, lease-checked).
  const booked = await settleBatchUsage(row.id, usage, { leaseToken: token });
  if (!booked.applied && booked.reason === "leaseLost") return "leaseLost";
  if (!booked.applied && booked.reason === "failed") {
    return await noteFailedTick(deps, { ...row, state: "collecting" }, token, new Error("booking_failed"), transport);
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

  // 10. May anything be WRITTEN? The normal gate decides (an exhausted budget is not in it).
  const writeGate = resolveAiCredentials({ shop, settings });
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

  // 11. WRITE, through the live run's own machinery (verification, handle rules, fill-only write). Guarded as a
  //     whole: an exception here (the instructions lookup, the SEO context, the run itself) is a FAILED TICK with
  //     back-off, like any other provider-side failure -- not an uncounted error that retries at full speed.
  try {
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
    // The write runs for minutes: it keeps asking whether this tick still holds the lease and stops writing when not.
    let lastLeaseCheck = 0;
    let leaseOk = true;
    const leaseHeld = async (): Promise<boolean> => {
      if (!leaseOk) return false;
      if (Date.now() - lastLeaseCheck < LEASE_CHECK_MS) return true;
      lastLeaseCheck = Date.now();
      // A throwing read is NOT "held": stop cleanly (booking is idempotent, the next tick re-collects).
      try {
        const current = await db.bulkTranslateBatch.findUnique({ where: { id: row.id }, select: { leaseToken: true } });
        leaseOk = !!current && current.leaseToken === token;
      } catch {
        leaseOk = false;
      }
      return leaseOk;
    };
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
      leaseHeld,
    });
  } catch (error) {
    return await noteFailedTick(deps, { ...row, state: "collecting" }, token, error, transport);
  }

  // 12. The run settles the Task itself. A task still open afterwards means it stopped early: look again next tick.
  const after = await db.task.findUnique({ where: { id: row.taskId }, select: { status: true } });
  if (after && (OPEN_BATCH_TASK_STATUSES as string[]).includes(after.status)) {
    // Counted like every failed tick, and given up on after MAX_FAILED_TICKS (hold settled first): a collect that
    // never finishes must not loop for ever.
    return await noteFailedTick(
      deps,
      { ...row, state: "collecting" },
      token,
      new Error("batch_collect_failed"),
      transport,
      BATCH_COLLECT_FAILED_ERROR,
    );
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

    // Oldest first. A row inside its failure back-off is filtered OUT IN THE QUERY: taking the oldest N and
    // skipping the backed-off ones afterwards let ten failing rows (which, being old, sort first) starve every
    // healthy row behind them for as long as they failed. The back-off is measured on `updatedAt` as the SELECT
    // sees it -- taking the lease bumps it, so a check made after the lease would always see "just now".
    const backedOff = [1, 2, 3].map((n) => ({
      failedTicks: n,
      updatedAt: { lt: new Date(now.getTime() - failedTickBackoffMs(n)) },
    }));
    const rows = await db.bulkTranslateBatch.findMany({
      where: {
        state: { in: [...OPEN_ROW_STATES] },
        AND: [
          { OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] },
          {
            OR: [
              { failedTicks: 0 },
              ...backedOff,
              // 4 and more share the 30 minute ceiling
              { failedTicks: { gte: 4 }, updatedAt: { lt: new Date(now.getTime() - failedTickBackoffMs(4)) } },
            ],
          },
        ],
      },
      orderBy: { updatedAt: "asc" },
      take: MAX_ROWS_PER_TICK,
      select: { id: true },
    });
    stats.rows = rows.length;
    for (const { id } of rows) {
      const outcome = await processBatchRow(id, deps);
      stats.outcomes[outcome] = (stats.outcomes[outcome] ?? 0) + 1;
    }
  } catch (error) {
    logger.error("[BatchPoll] Tick failed", { context: "AI", error: messageOf(error) });
  }
  return stats;
}
