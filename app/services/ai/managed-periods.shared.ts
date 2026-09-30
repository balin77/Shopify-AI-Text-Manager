/**
 * Which ledger period keys a managed budget counts — IMPORT-FREE on purpose.
 *
 * The budget, the per-shop failover ceiling and the Settings usage card must
 * all sum the SAME rows, and the failover module is loaded in contexts that
 * mock the meter wholesale; a pure leaf is the one place all three can import
 * without dragging the meter (and its database) along.
 */

/** The calendar key the meter writes while no period end is mirrored. Same
 *  format as `currentAiUsagePeriod` in usage-meter.server.ts, which delegates
 *  here so the two cannot drift. */
export function calendarPeriodKey(date: Date = new Date()): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `m:${y}-${m}`;
}

/**
 * Which ledger keys count as USED against the budget being checked.
 *
 * The taster is one key, forever. A PERIOD budget is not just the current
 * key, and the difference is a repeatable loop: the key is derived from the
 * subscription's `currentPeriodEnd`, and a plan switch (`APPLY_IMMEDIATELY`)
 * or a cancel + re-subscribe REPLACES the subscription with one that has its
 * own billing cycle — a new end date, a new key, and a used figure of zero.
 * Max+AI → Basic+AI → Max+AI inside one week would mint three budgets for the
 * price of a few prorated days. So every period key whose end is still in the
 * FUTURE counts too: a replaced subscription's spend keeps weighing on the new
 * one until the day the old period would have ended, and a natural renewal
 * (whose old key ends today or earlier) drops out by itself. The current
 * calendar key is included for the same reason — it is where a managed call
 * is written while the period end is not mirrored yet, and a spend there
 * must not vanish the moment the mirror lands.
 *
 * Conservative in one stated direction: a downgrade right after heavy spend
 * can find the smaller budget already used until the old period ends. That is
 * the intended answer — the alternative is the loop above.
 */
export function usedPeriodsFilter(
  period: string,
  kind: "period" | "taster",
  now: Date = new Date(),
): { period: string } | { OR: Array<Record<string, unknown>> } {
  if (kind === "taster") return { period };
  const today = now.toISOString().slice(0, 10);
  return {
    OR: [
      { period },
      { period: calendarPeriodKey(now) },
      // ISO dates compare as strings; `gt` keeps a key ending TODAY out.
      { period: { startsWith: "b:", gt: `b:${today}` } },
    ],
  };
}
