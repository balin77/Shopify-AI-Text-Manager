/**
 * A LANGUAGE or MARKET switch discards only what belongs to the view it leaves.
 *
 * The leave dialog a switch opens (`confirmNavigation` → App Bridge's
 * `saveBar.leaveConfirmation()`) offers "Discard", and whether App Bridge then
 * ALSO fires the save bar's own discard handler is not measured. If it does,
 * the bar's `onDiscard` would throw away far more than the switch costs: the
 * pending GALLERY changes, the per-language replacement-media drafts of every
 * language and the stock edits — all documented to survive a language or
 * market switch. So the switch is MARKED while its dialog is answered, and a
 * discard arriving inside that mark runs only the view-scoped half.
 *
 * The mark has to survive two unknowns, which is why it is not a plain boolean:
 *  - the ORDER: the dialog's discard may resolve the promise before or after it
 *    fires the bar's handler. A handler arriving within `GRACE_MS` after the
 *    switch resolved is still the switch's.
 *  - a CANCELLED dialog ("stay") never resolves, so the mark would otherwise
 *    outlive it, and a later, genuine Discard click on the bar would keep the
 *    gallery. A discard while the switch is still unresolved therefore runs the
 *    view half at once and the shared half `GRACE_MS` later — unless the switch
 *    resolved in between (then it was the dialog's discard, and the shared half
 *    is dropped). The cost of the cancelled case is a delay, never a loss.
 *
 * A plain Discard click with no switch in flight discards everything, as before.
 */
import { confirmNavigation } from "./useSaveBar";
import { debugLog } from "../utils/debug";

export const VIEW_SWITCH_GRACE_MS = 1500;

interface ViewSwitchState {
  /** A switch is waiting for its leave dialog. */
  pending: boolean;
  /** When the latest switch's dialog resolved (ms), or null. */
  resolvedAt: number | null;
  /** Bumped per switch, so a deferred shared discard knows which one it waited on. */
  generation: number;
}

const state: ViewSwitchState = { pending: false, resolvedAt: null, generation: 0 };

type Clock = () => number;
type Timer = (fn: () => void, ms: number) => unknown;
let now: Clock = () => Date.now();
let schedule: Timer = (fn, ms) => setTimeout(fn, ms);

/** Test seam: inject a clock and a timer; call with no args to restore. */
export function __setViewSwitchClockForTests(clock?: Clock, timer?: Timer): void {
  now = clock ?? (() => Date.now());
  schedule = timer ?? ((fn, ms) => setTimeout(fn, ms));
  state.pending = false;
  state.resolvedAt = null;
  state.generation = 0;
}

export function beginViewSwitch(): number {
  state.pending = true;
  state.resolvedAt = null;
  state.generation += 1;
  return state.generation;
}

export function markViewSwitchResolved(generation: number): void {
  if (generation !== state.generation) return;
  state.pending = false;
  state.resolvedAt = now();
}

/** `confirmNavigation` for a language / market switch: marks the switch. */
export async function confirmViewSwitch(): Promise<void> {
  const generation = beginViewSwitch();
  await confirmNavigation();
  markViewSwitchResolved(generation);
}

/**
 * The save bar's Discard. `view` = the drafts of the view on screen (editor
 * fields, alt texts, per-view sub-resource edits); `shared` = what is the same
 * in every language and market (gallery, replacement-media drafts, stock).
 */
export function routeSaveBarDiscard(parts: { view: () => void; shared: () => void }): void {
  const resolvedRecently = state.resolvedAt !== null && now() - state.resolvedAt < VIEW_SWITCH_GRACE_MS;
  if (resolvedRecently) {
    debugLog.saveBar("onDiscard during a view switch (after it resolved) — view drafts only");
    parts.view();
    return;
  }
  if (state.pending) {
    debugLog.saveBar("onDiscard while a view switch is waiting for its dialog — view drafts now, shared ones only if the switch does not go through");
    parts.view();
    const generation = state.generation;
    schedule(() => {
      // The switch went through (its dialog's discard fired this), or another
      // switch began meanwhile (cannot tell — keep: a kept draft stays visible
      // on the bar and can be discarded again, a dropped gallery cannot come
      // back): keep the shared drafts. Still unresolved: this was a genuine
      // Discard after a cancelled dialog — finish it.
      if (state.generation !== generation || !state.pending) return;
      state.pending = false;
      debugLog.saveBar("deferred shared discard: no view switch completed — discarding shared drafts too");
      parts.shared();
    }, VIEW_SWITCH_GRACE_MS);
    return;
  }
  debugLog.saveBar("onDiscard (no view switch) — discarding everything");
  parts.view();
  parts.shared();
}
