/**
 * Three CSS rules in BulkGrid keep the sticky columns behaving like sticky
 * columns. None of them is cosmetic and none can be tested by rendering:
 * jsdom has no layout, so this is a source-level alarm in the style of
 * field-clear-threshold.test.ts.
 *
 * All three failures were MEASURED in Chromium (2026-09, a 12-column grid in a
 * Polaris Card at a 1400px viewport):
 *
 * 1. Without `isolation: isolate` on the cells, the status column's Polaris
 *    `Select` paints OVER the pinned image and title columns. `.Polaris-Select`
 *    is `position: relative` with no z-index of its own (checked against
 *    @shopify/polaris 13.9.5), so its Backdrop (10), Content (20) and Input
 *    (30) land in the GRID's stacking context, far above the sticky columns at
 *    2. Hit-testing the middle of the pinned title cell returned
 *    `Polaris-Select__Content`; with the isolation it returns the cell.
 *
 * 2. Without `min-width: min-content` the sticky columns come UNPINNED at the
 *    right-hand end of the scroll: a sticky box may not leave its containing
 *    block, which for a grid item is the grid container, and `width: 100%`
 *    makes that box only as wide as the scrollport. At full right scroll the
 *    image column measured -32px and the title column -204px.
 *
 * 3. The z-index ladder has to stay ordered: sticky cells below the header,
 *    the header below the corner (a header that is sticky on both axes), and
 *    the proxy scrollbar above all of them.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(resolve(process.cwd(), "app/components/bulk-editor/BulkGrid.tsx"), "utf8");

/** Only the inline stylesheet, never the whole module: the TS comments above
 *  it quote rules verbatim (braces included), and a search over the file
 *  answers with the prose instead of the CSS. */
const css = (() => {
  const open = source.indexOf("<style>{`");
  const close = source.indexOf("`}</style>");
  expect(open, "the inline stylesheet is gone").toBeGreaterThan(-1);
  expect(close).toBeGreaterThan(open);
  return source.slice(open, close);
})();

/** The declarations of one rule, by its selector, out of the component's
 *  inline stylesheet. The selector is matched literally and must be followed
 *  by its brace, so `.cp-bulk-scroll` does not answer with the
 *  `.cp-bulk-scroll-wrap` rule and `.cp-bulk-th` not with `.cp-bulk-th,`. */
function rule(selector: string): string {
  const literal = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const found = css.match(new RegExp(`${literal}\\s*\\{([^}]*)\\}`));
  expect(found, `the ${selector} rule is gone or was reworded`).not.toBeNull();
  return found![1];
}

function zIndex(selector: string): number {
  const found = rule(selector).match(/z-index:\s*(\d+)/);
  expect(found, `${selector} declares no z-index`).not.toBeNull();
  return Number(found![1]);
}

describe("the bulk grid's sticky columns", () => {
  it("isolate every cell, so a Polaris control cannot paint over them", () => {
    // On the shared .cp-bulk-th/.cp-bulk-cell rule: a cell that is not its own
    // stacking context lets anything inside it escape into the grid's.
    const shared = css.match(/\.cp-bulk-th,\s*\.cp-bulk-cell\s*\{([^}]*)\}/);
    expect(shared, "the shared cell rule is gone or was reworded").not.toBeNull();
    expect(shared![1]).toMatch(/isolation:\s*isolate/);
  });

  it("give the grid a box as wide as its tracks", () => {
    const grid = rule(".cp-bulk-grid");
    expect(grid).toMatch(/min-width:\s*min-content/);
    // max-content is the trap the width:100% comment documents: it resolves
    // the 1fr tracks against the widest unwrapped cell (244px → 882px in the
    // same measurement), which is what width:100% exists to prevent.
    expect(grid).not.toMatch(/min-width:\s*max-content/);
    expect(grid).toMatch(/width:\s*100%/);
  });

  it("keep the paint order: sticky column < header < corner < scrollbar", () => {
    expect(zIndex(".cp-bulk-sticky")).toBeLessThan(zIndex(".cp-bulk-th"));
    expect(zIndex(".cp-bulk-th")).toBeLessThan(zIndex(".cp-bulk-th.cp-bulk-sticky"));
    expect(zIndex(".cp-bulk-th.cp-bulk-sticky")).toBeLessThan(zIndex(".cp-bulk-hscroll"));
  });
});

describe("the sticky horizontal scrollbar", () => {
  it("hides the real scroller's own bar, so only one bar shows one axis", () => {
    const scroller = rule(".cp-bulk-scroll");
    expect(scroller).toMatch(/overflow-x:\s*auto/);
    expect(scroller).toMatch(/scrollbar-width:\s*none/);
    expect(css).toMatch(/\.cp-bulk-scroll::-webkit-scrollbar\s*\{\s*display:\s*none;?\s*\}/);
  });

  it("pins to the bottom with a fixed height, and draws its own thumb", () => {
    const bar = rule(".cp-bulk-hscroll");
    expect(bar).toMatch(/position:\s*sticky/);
    expect(bar).toMatch(/bottom:\s*0/);
    // Not a native scroller any more: a platform overlay scrollbar could
    // collapse it or hide it until dragged, and a second scroller has to be
    // kept in step with the grid (the touchpad judder).
    expect(bar).toMatch(/height:\s*\d+px/);
    expect(bar).not.toMatch(/overflow/);
    expect(rule(".cp-bulk-hscroll-thumb")).toMatch(/position:\s*absolute/);
  });
});
