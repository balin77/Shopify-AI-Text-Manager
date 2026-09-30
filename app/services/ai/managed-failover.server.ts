/**
 * The failover's stateful half — the breaker and the per-shop ceiling.
 * PLAN_MANAGED_AI_KEY §3a rules 2, 5 and 6.
 *
 * **The breaker is a RATE over a window, not "N consecutive failures".**
 * Dispatch is fire-and-forget at concurrency 4 and calls settle out of order,
 * so a 50%-failing primary produces "consecutive" only by luck. It is a
 * PROCESS-LOCAL state and sound only because production runs a single instance
 * (RAILWAY-SETUP.md §0) — the fifth such state, and the day the app is scaled
 * horizontally every instance probes the dead provider on its own.
 *
 * **A re-trip lengthens the window.** A primary failing 30% of the time would
 * otherwise open, probe, close and re-open forever, and every cycle is billed
 * at 1x while costing us 14x.
 *
 * **The per-shop ceiling is not optional.** Rule 1 says the merchant is billed
 * at the DEFAULT model's price whatever ran — which, without a ceiling, is an
 * exploit: the triggers include timeouts and post-retry 429s, both of which a
 * shop can produce on purpose by queueing enough work, and the breaker is
 * GLOBAL. One shop could flip everybody onto the 14x model, keep paying nano
 * prices, and drain the shared pool until managed mode 503s for every paying
 * merchant.
 */

import { logger } from "../../utils/logger.server";

/** Failures and successes inside the rolling window. */
interface BreakerWindow {
  events: { at: number; ok: boolean }[];
  /** When the breaker opened, or null while it is closed. */
  openedAt: number | null;
  /** How many times it has re-tripped — each one lengthens the window. */
  trips: number;
  /** A probe is out: exactly one real call is allowed through. */
  probing: boolean;
}

const WINDOW_MS = 60_000;
const MIN_SAMPLES = 5;
const FAILURE_RATE = 0.5;
const BASE_OPEN_MS = 60_000;
const MAX_OPEN_MS = 30 * 60_000;

const breakers = new Map<string, BreakerWindow>();

function windowFor(provider: string): BreakerWindow {
  let w = breakers.get(provider);
  if (!w) {
    w = { events: [], openedAt: null, trips: 0, probing: false };
    breakers.set(provider, w);
  }
  return w;
}

function openDuration(trips: number): number {
  return Math.min(MAX_OPEN_MS, BASE_OPEN_MS * 2 ** Math.max(0, trips - 1));
}

/**
 * May a call use the DEFAULT provider right now?
 *
 * `probe: true` means this call IS the half-open probe: it goes to the primary
 * while everyone else holds the fallback, and its outcome decides whether the
 * breaker closes. The probe is a REAL managed call rather than a synthetic
 * one, because §6's own rule — an AIService with no shop cannot be metered, so
 * it cannot be managed — rules a synthetic one out.
 */
export function breakerAllows(provider: string, now = Date.now()): { allow: boolean; probe: boolean } {
  const w = windowFor(provider);
  if (w.openedAt === null) return { allow: true, probe: false };

  if (now - w.openedAt < openDuration(w.trips)) return { allow: false, probe: false };

  // Half-open: the NEXT real call probes, and only one at a time.
  if (w.probing) return { allow: false, probe: false };
  w.probing = true;
  return { allow: true, probe: true };
}

/** Record how a managed call to `provider` went. */
export function recordBreakerOutcome(provider: string, ok: boolean, now = Date.now()): void {
  const w = windowFor(provider);
  w.events = w.events.filter((e) => now - e.at < WINDOW_MS);
  w.events.push({ at: now, ok });

  if (w.probing) {
    w.probing = false;
    if (ok) {
      logger.info(`[ManagedAI] Circuit closed for ${provider} — probe succeeded`);
      w.openedAt = null;
      w.events = [];
    } else {
      w.openedAt = now;
      w.trips += 1;
      logger.error(
        `[ManagedAI] Circuit re-opened for ${provider} (trip ${w.trips}); holding for ${Math.round(
          openDuration(w.trips) / 1000,
        )}s. A PERMANENTLY failing primary — a retired model id, a revoked key — burns the failover pool and then 503s every paying merchant, so a rising trip count is a page, not a metric.`,
      );
    }
    return;
  }

  if (w.openedAt !== null) return;
  if (w.events.length < MIN_SAMPLES) return;

  const failures = w.events.filter((e) => !e.ok).length;
  if (failures / w.events.length >= FAILURE_RATE) {
    w.openedAt = now;
    w.trips += 1;
    logger.error(
      `[ManagedAI] Circuit opened for ${provider}: ${failures}/${w.events.length} failed in the last minute`,
    );
  }
}

/** Test seam — the breaker is process-local state with no natural reset. */
export function resetBreakers(): void {
  breakers.clear();
}

export function breakerState(provider: string): { open: boolean; trips: number } {
  const w = breakers.get(provider);
  return { open: w?.openedAt !== null && w?.openedAt !== undefined, trips: w?.trips ?? 0 };
}

/**
 * How many failover-served calls ONE shop may have in a period — rule 2.
 *
 * A number rather than a share of the budget, because the budget is debited at
 * the DEFAULT price: a shop's spend figure cannot show how much of it ran at
 * 14x, which is exactly what makes the exploit invisible without this.
 */
export function shopFailoverCeiling(): number {
  const raw = process.env.MANAGED_AI_SHOP_FAILOVER_CEILING;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 200;
}

/**
 * Has this shop used up its failover allowance?
 *
 * Reads `failoverCalls` from the meter, which is the only place that knows
 * which calls the fallback actually served. Never throws; a failed read
 * REFUSES the failover (not the call — the caller then fails normally),
 * because the expensive direction here is 14x on unread evidence.
 */
export async function shopFailoverExhausted(shop: string, period: string): Promise<boolean> {
  try {
    const { db } = await import("../../db.server");
    const agg = await db.aiUsageCounter.aggregate({
      where: { shop, period, source: "managed" },
      _sum: { failoverCalls: true },
    });
    return (agg._sum.failoverCalls ?? 0) >= shopFailoverCeiling();
  } catch (error) {
    logger.error(
      `[ManagedAI] Failover ceiling read failed for ${shop}: ${
        error instanceof Error ? error.message : String(error)
      } — refusing the failover`,
    );
    return true;
  }
}
