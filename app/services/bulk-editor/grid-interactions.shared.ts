/**
 * Bulk editor — Excel paste + undo stack, pure pieces (docs/plans/
 * PLAN_BULK_EDITOR.md §8.3/§8.4).
 *
 * MUST STAY CLIENT-SAFE (same contract as columns.shared.ts) — the route and
 * grid components use these in client code, the unit tests without a server.
 *
 * §8.3: pasting a clipboard text that contains BOTH a tab and a newline into
 * a cell distributes it as a rectangle from the target cell over the visible
 * editable columns and loaded rows; read-only cells are skipped and counted,
 * the rectangle clamps at the grid edges. Anything else pastes normally.
 *
 * §8.4: Ctrl/Cmd+Z walks an edit-map snapshot history (NOT the browser's
 * textarea undo — that only knows one cell). The stack is capped; snapshots
 * of the same cell's typing burst coalesce so one keystroke isn't one undo
 * step. Redo is deliberately NOT implemented (documented): the edit map is
 * the single source of dirty state, and a miss-undo is recoverable by simply
 * retyping — a redo stack would double the state-invalidations (save,
 * navigation, discard) for marginal benefit.
 */

// ─── Rectangle paste (§8.3) ────────────────────────────────────────────────

/** §8.3 trigger rule, verbatim: the clipboard text is a rectangle iff it
 * contains a tab AND a line break. (A single line with tabs, or a multi-line
 * text without tabs, pastes normally — merchants paste multi-line
 * descriptions into single cells all the time.) */
export function isRectClipboard(text: string): boolean {
  return text.includes("\t") && /[\r\n]/.test(text);
}

/** Splits clipboard text into the cell rectangle: rows by line break (one
 * trailing empty row from the terminal newline Excel appends is dropped),
 * cells by tab. */
export function parseClipboardRect(text: string): string[][] {
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines.map((line) => line.split("\t"));
}

export interface RectDistribution {
  /** Grid-coordinate updates to apply (row/col are indices into the VISIBLE
   * rows × VISIBLE editable-column matrix the caller passed). */
  cells: { row: number; col: number; value: string }[];
  /** Rectangle rows/cols that actually landed inside the grid (after
   * clamping) — the "12 × 3" of the toast. */
  rows: number;
  cols: number;
  /** Cells that fell on read-only targets — skipped, reported in the toast. */
  skippedReadOnly: number;
}

/**
 * Distributes a parsed rectangle over the grid starting at (startRow,
 * startCol). `editable` is the visible rows × visible columns editability
 * matrix — the caller builds it from resolveCellValue + the foreign-locale
 * rule, so this stays a pure position calculation. Mapping is strictly
 * positional: a value aimed at a read-only cell is DROPPED (skipped +
 * counted), never shifted into the next editable column — shifting would
 * silently misalign every following column of that row. Values beyond the
 * last row/column clamp off.
 */
export function distributeRect(
  rect: string[][],
  editable: boolean[][],
  startRow: number,
  startCol: number,
): RectDistribution {
  const result: RectDistribution = { cells: [], rows: 0, cols: 0, skippedReadOnly: 0 };
  for (let r = 0; r < rect.length; r++) {
    const targetRow = startRow + r;
    if (targetRow >= editable.length) break; // clamp at the bottom edge
    const rowEditable = editable[targetRow];
    let colsInRow = 0;
    for (let c = 0; c < rect[r].length; c++) {
      const targetCol = startCol + c;
      if (targetCol >= rowEditable.length) break; // clamp at the right edge
      colsInRow++;
      if (!rowEditable[targetCol]) {
        result.skippedReadOnly++;
        continue;
      }
      result.cells.push({ row: targetRow, col: targetCol, value: rect[r][c] });
    }
    if (colsInRow > 0) {
      result.rows++;
      result.cols = Math.max(result.cols, colsInRow);
    }
  }
  return result;
}

// ─── Undo stack (§8.4) ─────────────────────────────────────────────────────

/** Undo depth cap (§8.4 suggests ~100). */
export const UNDO_STACK_LIMIT = 100;

export interface EditMapSnapshot {
  /** The edit map BEFORE the change this snapshot guards. */
  edits: Record<string, string>;
  /** Coalescing tag: consecutive pushes with the SAME tag (one cell's typing
   * burst — the tag is the edit key) keep the FIRST snapshot, so undo jumps
   * back to before the burst instead of one keystroke. Batch operations
   * (paste, price actions) use a unique tag per invocation. */
  tag: string;
}

/**
 * Pushes a snapshot, returning a NEW stack array (React-friendly). Coalesces
 * on `tag` (see EditMapSnapshot.tag) and evicts the oldest entry beyond
 * `limit`.
 */
export function pushSnapshot(
  stack: EditMapSnapshot[],
  snapshot: EditMapSnapshot,
  limit: number = UNDO_STACK_LIMIT,
): EditMapSnapshot[] {
  const top = stack[stack.length - 1];
  if (top && top.tag === snapshot.tag) return stack;
  const next = [...stack, snapshot];
  return next.length > limit ? next.slice(next.length - limit) : next;
}

/** Pops the newest snapshot; null when there is nothing to undo. */
export function popSnapshot(
  stack: EditMapSnapshot[],
): { stack: EditMapSnapshot[]; snapshot: EditMapSnapshot } | null {
  if (stack.length === 0) return null;
  return { stack: stack.slice(0, -1), snapshot: stack[stack.length - 1] };
}
