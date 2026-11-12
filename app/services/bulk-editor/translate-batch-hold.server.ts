/**
 * What becomes of a batch's HOLD when the run ends without a normal booking
 * (PLAN_BULK_TRANSLATE_BATCHING 16, "Koordinator-Entscheid, vom Owner zu
 * bestaetigen").
 *
 * THE GUIDING RULE. Once a batch MAY exist at the provider -- the create was
 * sent and not definitively refused, or a batch id is stored -- a hold is never
 * simply released. It is
 *   (a) BOOKED from evidence: the actual usage of the results (the poller's
 *       normal booking), or pro rata from the provider's `request_counts`
 *       (succeeded x the reserved upper bound of those requests; reading the
 *       counts fetches no content, so it is allowed on the consent and GDPR
 *       paths), or
 *   (b) CONVERTED to the reserved upper bound when nothing can be read
 *       (provider down, key gone, kill switch, a batch still running at the
 *       absolute end).
 * It is RELEASED only when the provider's own status PROVES that nothing was
 * processed (ended / canceled with `succeeded === 0`) or the create was
 * definitively refused (the callers' business: a refused create has no batch id).
 *
 * Why: releasing a hold the batch then spends gives the shop back budget for
 * money the provider collects anyway -- the hold IS the protection against that.
 * Every terminal path of the run (absolute end, unreachable provider, orphan,
 * uninstall / redaction, a submit that lost its Task) goes through `settleHold`,
 * so the rule exists in ONE place.
 *
 * Never throws. A failed settlement is `pending` (the row stays open and the
 * next tick tries again); only the `final` callers, which have no next tick,
 * fall back to the upper bound.
 */

import { priceCall } from "~/config/ai-pricing";
import { stringList, type SettlementTransport } from "../ai/batch-settlement.shared";
import { logger } from "~/utils/logger.server";
import { parseManifest } from "./translate-batch.shared";

/** One provider call may take this long before it counts as unreadable. */
const READ_DEADLINE_MS = 30_000;

export type HoldOutcome =
  /** Nothing is held (an own-key run, or already settled): nothing to do. */
  | { kind: "none" }
  /** The provider proved nothing was processed; the hold went back. */
  | { kind: "released" }
  /** Booked pro rata from the request counts (`micros` of the hold became the charge, the rest went back). */
  | { kind: "booked"; micros: number }
  /** Booked at the reserved upper bound: nothing could be read (`reason` says why). */
  | { kind: "converted"; micros: number; reason: string }
  /** Not settled yet (the batch still runs, or the counts could not be read and a later tick may): keep the row open. */
  | { kind: "pending"; reason: string };

/** The structural subset of a batch row the settlement needs. */
export interface HoldRow {
  id: string;
  provider: string;
  model: string;
  source: string;
  reservationState: string;
  batchIds: unknown;
  manifest: string;
}

async function withDeadline<T>(call: () => Promise<T>, ms = READ_DEADLINE_MS): Promise<T> {
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

/** The reserved upper bound of every request of the manifest (batch tier, `max_tokens` as SENT), largest first. */
export function requestBoundsMicros(row: Pick<HoldRow, "provider" | "model" | "manifest">): number[] | null {
  const manifest = parseManifest(row.manifest);
  if (!manifest || manifest.requests.length === 0) return null;
  return manifest.requests
    .map((r) => priceCall(row.provider as never, row.model, r.inputEstimate, r.maxTokens, { tier: "batch" }).costMicros)
    .sort((a, b) => b - a);
}

/**
 * What `chargeable` requests can cost AT MOST: the sum of the largest bounds.
 * Which requests succeeded is not in the counts, so the bound assumes the
 * dearest ones did -- it can never fall below the real cost.
 */
export function boundForRequests(boundsDesc: number[], chargeable: number): number {
  return boundsDesc.slice(0, Math.max(0, chargeable)).reduce((n, v) => n + v, 0);
}

/**
 * Settle the hold of `row` per the guiding rule.
 *
 * `final`: this is the LAST look (absolute end, uninstall, redaction): anything
 * that cannot be read or has not ended becomes the upper bound instead of
 * `pending`.
 */
export async function settleHold(
  row: HoldRow,
  transport: SettlementTransport | null,
  opts: { final: boolean },
): Promise<HoldOutcome> {
  if (row.source !== "managed" || row.reservationState !== "held") return { kind: "none" };
  const { convertReservation, releaseBudget } = await import("../ai/usage-meter.server");

  const finish = async (
    run: () => Promise<{ applied: boolean; micros?: number; reason?: string }>,
    kind: "released" | "booked" | "converted",
    reason: string,
  ): Promise<HoldOutcome> => {
    const outcome = await run();
    if (outcome.applied) {
      const micros = outcome.micros ?? 0;
      if (kind === "released") return { kind: "released" };
      if (kind === "booked") return { kind: "booked", micros };
      return { kind: "converted", micros, reason };
    }
    if (outcome.reason === "failed") return { kind: "pending", reason: "settleFailed" };
    return { kind: "none" }; // already settled by somebody else
  };
  const upperBound = (reason: string) => finish(() => convertReservation(row.id), "converted", reason);
  const unresolved = (reason: string) => (opts.final ? upperBound(reason) : Promise.resolve<HoldOutcome>({ kind: "pending", reason }));

  const batchIds = stringList(row.batchIds);
  // No batch id: the create was never sent, was refused, or its answer is lost. The callers that KNOW it
  // was refused release the hold themselves; here an id-less row only ever reaches the upper bound.
  if (batchIds.length === 0) return unresolved("noBatchId");
  if (!transport) return unresolved("noAccess");

  let ended = true;
  let counted = true;
  let succeeded = 0;
  try {
    for (const id of batchIds) {
      const status = await withDeadline(() => transport.retrieve(id));
      if (!status.ended) ended = false;
      const counts = status.requestCounts;
      if (!counts || typeof counts.succeeded !== "number") counted = false;
      else succeeded += counts.succeeded;
    }
  } catch (error) {
    logger.warn("[BatchHold] Could not read the batch counts", {
      context: "AI",
      batchRowId: row.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return unresolved("unreadable");
  }
  // A batch still running (or being cancelled) may yet cost: nothing is proven.
  if (!ended) return unresolved("notEnded");
  if (!counted) return unresolved("noCounts");

  if (succeeded === 0) return finish(() => releaseBudget(row.id), "released", "provedNothing");

  const bounds = requestBoundsMicros(row);
  if (!bounds) return upperBound("noManifest");
  const bound = boundForRequests(bounds, succeeded);
  return finish(() => convertReservation(row.id, { bookMicros: bound }), "booked", "counts");
}
