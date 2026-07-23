import { describe, it, expect } from "vitest";
import {
  isRectClipboard,
  parseClipboardRect,
  distributeRect,
  pushSnapshot,
  popSnapshot,
  UNDO_STACK_LIMIT,
  type EditMapSnapshot,
} from "~/services/bulk-editor/grid-interactions.shared";

/**
 * Locks the Excel-paste rectangle distribution (Plan §8.3: skip + count
 * read-only cells, clamp at the grid edges, strictly positional mapping) and
 * the undo stack (Plan §8.4: snapshot history with per-cell-burst coalescing
 * and a hard depth cap).
 */

describe("isRectClipboard (§8.3 trigger rule)", () => {
  it("requires BOTH a tab and a line break", () => {
    expect(isRectClipboard("a\tb\nc\td")).toBe(true);
    expect(isRectClipboard("a\tb\r\nc\td")).toBe(true);
    expect(isRectClipboard("a\tb")).toBe(false); // one row with tabs → normal paste
    expect(isRectClipboard("line1\nline2")).toBe(false); // multi-line, no tabs
    expect(isRectClipboard("plain")).toBe(false);
  });
});

describe("parseClipboardRect", () => {
  it("splits rows by newline and cells by tab", () => {
    expect(parseClipboardRect("a\tb\nc\td")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("handles CRLF and drops the single trailing empty row Excel appends", () => {
    expect(parseClipboardRect("a\tb\r\nc\td\r\n")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("keeps genuinely empty cells inside the rectangle", () => {
    expect(parseClipboardRect("a\t\tc\n\tb\t")).toEqual([
      ["a", "", "c"],
      ["", "b", ""],
    ]);
  });
});

describe("distributeRect (§8.3)", () => {
  const allEditable = (rows: number, cols: number): boolean[][] =>
    Array.from({ length: rows }, () => Array.from({ length: cols }, () => true));

  it("fills the rectangle from the target cell", () => {
    const rect = [
      ["a", "b"],
      ["c", "d"],
    ];
    const result = distributeRect(rect, allEditable(4, 4), 1, 2);
    expect(result.cells).toEqual([
      { row: 1, col: 2, value: "a" },
      { row: 1, col: 3, value: "b" },
      { row: 2, col: 2, value: "c" },
      { row: 2, col: 3, value: "d" },
    ]);
    expect(result.rows).toBe(2);
    expect(result.cols).toBe(2);
    expect(result.skippedReadOnly).toBe(0);
  });

  it("clamps at the bottom and right grid edges", () => {
    const rect = [
      ["a", "b", "c"],
      ["d", "e", "f"],
      ["g", "h", "i"],
    ];
    // 2×2 grid, paste starting at (1,1): only (1,1) fits.
    const result = distributeRect(rect, allEditable(2, 2), 1, 1);
    expect(result.cells).toEqual([{ row: 1, col: 1, value: "a" }]);
    expect(result.rows).toBe(1);
    expect(result.cols).toBe(1);
  });

  it("skips read-only cells, counts them and does NOT shift values sideways", () => {
    const editable = [
      [true, false, true],
      [true, true, false],
    ];
    const rect = [
      ["a", "b", "c"],
      ["d", "e", "f"],
    ];
    const result = distributeRect(rect, editable, 0, 0);
    // "b" (0,1) and "f" (1,2) fall on read-only cells → dropped, positional
    // alignment preserved for "c".
    expect(result.cells).toEqual([
      { row: 0, col: 0, value: "a" },
      { row: 0, col: 2, value: "c" },
      { row: 1, col: 0, value: "d" },
      { row: 1, col: 1, value: "e" },
    ]);
    expect(result.skippedReadOnly).toBe(2);
    expect(result.rows).toBe(2);
    expect(result.cols).toBe(3);
  });

  it("a rectangle aimed entirely outside the grid applies nothing", () => {
    const result = distributeRect([["a"]], allEditable(2, 2), 5, 0);
    expect(result.cells).toEqual([]);
    expect(result.rows).toBe(0);
  });
});

describe("undo stack (§8.4)", () => {
  const snap = (tag: string, marker: string): EditMapSnapshot => ({
    edits: { marker },
    tag,
  });

  it("pushes and pops LIFO", () => {
    let stack: EditMapSnapshot[] = [];
    stack = pushSnapshot(stack, snap("a", "1"));
    stack = pushSnapshot(stack, snap("b", "2"));
    const first = popSnapshot(stack);
    expect(first?.snapshot.edits.marker).toBe("2");
    const second = popSnapshot(first!.stack);
    expect(second?.snapshot.edits.marker).toBe("1");
    expect(popSnapshot(second!.stack)).toBeNull();
  });

  it("coalesces consecutive pushes with the same tag (one typing burst = one undo step)", () => {
    let stack: EditMapSnapshot[] = [];
    stack = pushSnapshot(stack, snap("cellA", "before-burst"));
    stack = pushSnapshot(stack, snap("cellA", "mid-burst")); // dropped
    stack = pushSnapshot(stack, snap("cellA", "late-burst")); // dropped
    expect(stack).toHaveLength(1);
    expect(popSnapshot(stack)?.snapshot.edits.marker).toBe("before-burst");
  });

  it("does NOT coalesce when another cell was edited in between", () => {
    let stack: EditMapSnapshot[] = [];
    stack = pushSnapshot(stack, snap("cellA", "1"));
    stack = pushSnapshot(stack, snap("cellB", "2"));
    stack = pushSnapshot(stack, snap("cellA", "3"));
    expect(stack).toHaveLength(3);
  });

  it("caps the depth and evicts the OLDEST snapshot", () => {
    let stack: EditMapSnapshot[] = [];
    for (let i = 0; i < 5; i++) stack = pushSnapshot(stack, snap(`t${i}`, String(i)), 3);
    expect(stack).toHaveLength(3);
    expect(stack[0].edits.marker).toBe("2"); // 0 and 1 evicted
    expect(stack[2].edits.marker).toBe("4");
  });

  it("default limit is 100", () => {
    let stack: EditMapSnapshot[] = [];
    for (let i = 0; i < UNDO_STACK_LIMIT + 20; i++) {
      stack = pushSnapshot(stack, snap(`t${i}`, String(i)));
    }
    expect(stack).toHaveLength(UNDO_STACK_LIMIT);
  });
});
