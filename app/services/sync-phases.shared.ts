/**
 * Initial-sync phase vocabulary — ONE list, in run order.
 *
 * Client-safe (no imports): `runInitialFullSync` types its `emit()` against it
 * and the nav banner maps a phase to its position. Both used to carry their own
 * copy, and the UI's went stale: the phases added after it was written
 * (`system`, `delivery`, `onlineStoreExtras`, `cookieBanner`, `sellingPlans`)
 * were not in the list, so `indexOf` returned -1 and the banner's TOTAL bar
 * fell back to the phase's own percent — a merchant watching an upgrade re-sync
 * saw the total drop from ~85% back to 0% and sit there, which reads as a hung
 * sync. The service side is now a compile error instead of a silent -1.
 *
 * `done` / `error` are terminal markers, not phases, and stay out of the list.
 */
export const SYNC_PHASE_ORDER = [
  "products",
  "collections",
  "articles",
  "pages",
  "policies",
  "themes",
  "system",
  "delivery",
  "onlineStoreExtras",
  "cookieBanner",
  "sellingPlans",
  "metaobjects",
  "menus",
] as const;

export type SyncPhase = (typeof SYNC_PHASE_ORDER)[number];

/** Terminal markers emitted after the last phase. */
export type SyncPhaseMarker = "done" | "error";

/**
 * Relative weight of each phase in the TOTAL bar — a rough estimate of how long
 * it takes on a typical shop, not a count of anything. Equal weights are the
 * easy answer and a dishonest one: `products` (the whole catalogue plus every
 * translation, the phase merchants actually wait through) would move the total
 * by 1/13 while phases the plan skips complete in milliseconds and leap it
 * forward. Estimates are allowed to be wrong by a bit; they are not allowed to
 * make the longest phase the one that looks stuck.
 *
 * A phase the plan skips still consumes its weight instantly — the honest
 * meaning of "that work is done". Making the denominator plan-aware would need
 * the gating logic in the banner as well, a second copy of exactly the kind
 * that produced the stale phase list this module replaced.
 */
const PHASE_WEIGHT: Record<SyncPhase, number> = {
  products: 30,
  collections: 8,
  articles: 6,
  pages: 3,
  policies: 2,
  themes: 12,
  system: 3,
  delivery: 2,
  onlineStoreExtras: 6,
  cookieBanner: 2,
  sellingPlans: 2,
  metaobjects: 6,
  menus: 3,
};

const TOTAL_WEIGHT = SYNC_PHASE_ORDER.reduce((sum, phase) => sum + PHASE_WEIGHT[phase], 0);

const clampPercent = (n: number): number =>
  Math.max(0, Math.min(100, Math.round(Number.isFinite(n) ? n : 0)));

/**
 * Overall progress across the whole run, from the phase and its own percent.
 *
 * An unknown phase (a progress row written by a different deploy) has no
 * position and can only report its own percent — the stale-list case this
 * module exists to prevent, which is why the emitting side is typed against
 * `SyncPhase` rather than plain `string`.
 */
export function overallSyncPercent(phase: string | null, phasePercent: number): number {
  const percent = clampPercent(phasePercent);
  if (phase === "done") return 100;
  const idx = phase ? (SYNC_PHASE_ORDER as readonly string[]).indexOf(phase) : -1;
  if (idx < 0) return percent;
  let done = 0;
  for (let i = 0; i < idx; i++) done += PHASE_WEIGHT[SYNC_PHASE_ORDER[i]];
  const own = PHASE_WEIGHT[SYNC_PHASE_ORDER[idx]];
  return clampPercent(((done + (own * percent) / 100) / TOTAL_WEIGHT) * 100);
}
