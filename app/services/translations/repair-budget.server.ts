/**
 * A per-TASK budget of detached re-translation runs ("repair groups").
 *
 * The SEO "Fix with AI" bulk fix walks up to 2500 items and writes each through
 * the editor's own save path, and every one of those saves may hand a detached,
 * unattended AI run to `reconcileAfterPrimarySave` — on the merchant's own key.
 * The bulk editor caps exactly that (`MAX_REPAIR_GROUPS`, and `repairGroupBudget`
 * for a CSV import that spans batches); this is the same cap for a task that
 * reaches the editor paths one item at a time, so the number is the CALLER's to
 * pass (the bulk editor's constant), never invented here.
 *
 * Past the budget a save does not repair: it follows the merchant's stored
 * deletion answer, which is what the same save did before auto-translate reached
 * it — and the overflow is counted so the task can REPORT it instead of
 * dropping it silently. The module imports nothing on purpose: the editor save
 * paths take the budget as a plain parameter and must not pull the bulk editor
 * into their graph.
 */

export interface RepairBudget {
  /**
   * Ask for one repair group. `kind` + `ownerId` (+ `variant`) identify the group: asking
   * twice for the same group costs nothing (it is one run), so a retry or a
   * second call for the same surface of the same row never burns a slot.
   * Returns false when the budget is spent — the caller must then fall back to
   * its stored deletion answer and NOT start a run.
   */
  take(kind: string, ownerId: string, variant?: string): boolean;
  /** Rows (owner ids) whose group the budget refused. */
  readonly overflowOwners: ReadonlySet<string>;
  readonly maxGroups: number;
}

export function createRepairBudget(maxGroups: number): RepairBudget {
  const max = Math.max(0, Math.floor(maxGroups));
  const granted = new Set<string>();
  const refused = new Set<string>();
  const overflowOwners = new Set<string>();
  return {
    maxGroups: max,
    overflowOwners,
    take(kind: string, ownerId: string, variant = ""): boolean {
      const key = `${kind}|${ownerId}|${variant}`;
      if (granted.has(key)) return true;
      if (refused.has(key)) return false;
      if (granted.size >= max) {
        refused.add(key);
        overflowOwners.add(ownerId);
        return false;
      }
      granted.add(key);
      return true;
    },
  };
}
