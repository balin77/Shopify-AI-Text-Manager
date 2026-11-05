/**
 * Image manager, phone layout (owner, 2026-11): no frame around a gallery on phones, a header whose
 * title and filter share ONE no-wrap line, and a variant header that is ONE left-aligned line with
 * the SKU giving way first. Source-level guards: the real geometry was measured in a Chromium
 * harness (real editor + image manager markup, Polaris and app CSS; figures in the hand-back of the
 * change, not in the commit message); these keep the structure and the CSS contract from drifting.
 * The filter's behaviour is covered by image-manager-filter.test.tsx.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
const css = read("app/styles/responsive.css");
const manager = read("app/components/image-manager/VariantImageManager.tsx");
const section = read("app/components/image-manager/VariantGallerySection.tsx");
const grid = read("app/components/image-manager/SortableImageGrid.tsx");

/** Body of the first rule with exactly this selector (outside or inside a media block). */
function rule(selector: string, from = 0): string {
  const i = css.indexOf(selector + " {", from);
  if (i < 0) throw new Error("rule not found: " + selector);
  return css.slice(i, css.indexOf("}", i));
}
const phoneBlock = (() => {
  const i = css.indexOf("/* Image manager, phones: tighter gallery spacing");
  const j = css.indexOf("@media (max-width: 768px) {", i);
  return css.slice(j, css.indexOf("/* Image manager: the selection bar", j));
})();

describe("galleries: a centred grid with no frame, on every width", () => {
  const containerStyle = grid.slice(grid.indexOf("const containerStyle"), grid.indexOf("const inner = ("));
  it("the grid is a centred auto-fill grid of tile-wide columns with no border and no padding", () => {
    expect(containerStyle).toMatch(/display:\s*"grid"/);
    expect(containerStyle).toMatch(/gridTemplateColumns:\s*`repeat\(auto-fill, \$\{thumbSize\}px\)`/);
    expect(containerStyle).toMatch(/justifyContent:\s*"center"/);
    expect(containerStyle).not.toMatch(/\bborder:|\bpadding:|flexWrap|isDropTarget/);
  });
  it("the drop feedback is an ::after ring above the tiles (global, not phone-only), no outline", () => {
    const ring = css.match(/\.im-grid-frame\[data-drop-target="true"\]::after\s*\{([^}]*)\}/)![1];
    expect(ring).toMatch(/position:\s*absolute/);
    expect(ring).toMatch(/inset:\s*0/);
    expect(ring).toMatch(/pointer-events:\s*none/);
    expect(ring).toMatch(/box-shadow:\s*inset 0 0 0 2px/);
    expect(ring).toMatch(/z-index:\s*1;/);
    expect(css).toMatch(/\.im-grid-frame\s*\{\s*position:\s*relative/);
    expect(phoneBlock).not.toMatch(/outline(-offset)?:|data-drop-target/);
  });
  it("the phone frame keeps only gap, radius and the 4px bleed", () => {
    const frame = phoneBlock.match(/\.im-grid-frame\s*\{([^}]*)\}/)![1];
    expect(frame).not.toMatch(/border:|padding:/);
    expect(frame).toMatch(/gap:\s*4px/);
  });
  it("the grid marks its frame while something can be dropped on it", () => {
    expect(grid.match(/data-drop-target=\{isDropTarget \? "true" : undefined\}/g)?.length).toBe(2);
  });
  it("the empty-gallery text spans every column", () => {
    expect(grid).toMatch(/gridColumn:\s*"1 \/ -1"/);
  });
  it("the page gutter is halved only while the full view is open", () => {
    expect(phoneBlock).toMatch(/\.unified-content-editor-layout:has\(\.unified-editor-container\.im-full\)\s*\{[^}]*padding-inline:\s*8px/);
  });
});

describe("closed preview: exactly one row", () => {
  const preview = manager.slice(manager.indexOf("// Preview: exactly ONE row"), manager.indexOf("onClick={fullView ? undefined : openFullView}"));
  it("is clipped to one tile plus the 2px ring room above and below, border-box", () => {
    expect(preview).toMatch(/maxHeight:\s*thumbSize \+ 4/);
    expect(preview).toMatch(/padding:\s*2/);
    expect(preview).toMatch(/boxSizing:\s*"border-box"/);
    expect(preview).toMatch(/overflow:\s*"hidden"/);
  });
  it("the smallest row gap is larger than the ring room, so a second row never shows", () => {
    // clip = tile + 2 + 2; the next row starts 2 (padding) + tile + gap below the top
    const gaps = [...css.matchAll(/\.im-grid-frame\s*\{[^}]*gap:\s*(\d+)px/g)].map((m) => Number(m[1]));
    expect(Math.min(...gaps, 8)).toBeGreaterThanOrEqual(4);
    expect(grid).toMatch(/gap:\s*8/);
  });
});

describe("product gallery header: title and filter are one stable line", () => {
  const head = manager.slice(manager.indexOf('className="im-head"'), manager.indexOf("<Collapsible open={productGalleryShown}"));
  const left = head.slice(head.indexOf('className="im-head-left"'), head.indexOf('className="im-head-right"'));
  it("toggle (title, count, chevron) and filter sit in the same left group", () => {
    expect(left).toContain("data-im-product-toggle");
    expect(left).toContain("data-im-filter");
  });
  it("the slider and the WebP button are in the right group, not the left", () => {
    const right = head.slice(head.indexOf('className="im-head-right"'));
    expect(right).toContain('type="range"');
    expect(left).not.toContain('type="range"');
  });
  it("the left group never wraps; on phones the right group takes its own row", () => {
    expect(rule(".im-head-left")).toMatch(/flex-wrap:\s*nowrap/);
    expect(phoneBlock).toMatch(/\.im-head-right\s*\{[^}]*flex:\s*1 1 100%/);
  });
});

describe("filter buttons keep their touch target and still truncate", () => {
  it("the base rule lets the label truncate (min-width 0) without !important, the phone block adds no min-width", () => {
    const base = rule(".im-filter-btn");
    expect(base).toMatch(/min-width:\s*0;/);
    expect(base).not.toMatch(/min-width:[^;]*!important/);
    const phoneBtn = phoneBlock.match(/\.im-filter-btn\s*\{([^}]*)\}/)![1];
    expect(phoneBtn).not.toMatch(/min-width/);
    expect(phoneBtn).not.toMatch(/min-width[^;]*!important/);
  });
  it("the touch rule that gives buttons 44px is more specific than .im-filter-btn", () => {
    expect(css).toMatch(/button:not\(\.help-tooltip-trigger\),[^{]*\{[^}]*min-width:\s*var\(--touch-target-min\)/);
  });
  it("the buttons carry no redundant title (the text is visible)", () => {
    const btn = manager.slice(manager.indexOf('className="im-filter-btn"'), manager.indexOf('className="im-filter-label"'));
    expect(btn).not.toMatch(/\btitle=/);
  });
  it("the active underline is drawn on the label, not on the 44px button", () => {
    const btn = manager.slice(manager.indexOf('className="im-filter-btn"'), manager.indexOf('className="im-filter-label"'));
    expect(btn).not.toMatch(/borderBottom/);
    expect(manager).toMatch(/className="im-filter-label" style=\{\{ borderBottom: active/);
  });
  it("the bleed and the card padding are cross-referenced", () => {
    expect(manager).toMatch(/im-grid-bleed[\s\S]{0,80}Card padding|bleeds the galleries into exactly this padding/);
  });
});

describe("variant gallery header: one left-aligned line", () => {
  const head = section.slice(section.indexOf('className="im-vhead-left"'), section.indexOf("<Collapsible open={isOpen}"));
  const left = head.slice(0, head.indexOf("im-vhead-chevron"));
  it("checkbox, title, SKU and count are in one group, the chevron outside it", () => {
    for (const c of ['type="checkbox"', "im-vhead-title", "im-vhead-sku", "im-vhead-count"]) expect(left).toContain(c);
    expect(head).toContain("im-vhead-chevron");
  });
  it("the SKU carries its full text in a title and is not centred", () => {
    expect(section).toMatch(/className="im-vhead-sku" title=\{`SKU: \$\{variant\.sku\}`\}/);
    expect(section).not.toMatch(/align="center" blockAlign="center">\s*<input/);
  });
  it("the SKU shrinks first (far larger shrink weight, own floor); count and chevron never shrink", () => {
    const shrink = (sel: string) => Number(rule(sel).match(/flex:\s*0\s+(\d+)\s+auto/)![1]);
    expect(shrink(".im-vhead-sku")).toBeGreaterThan(shrink(".im-vhead-title") * 1000);
    expect(rule(".im-vhead-sku")).toMatch(/min-width:\s*\d+ch/);
    expect(rule(".im-vhead-sku")).toMatch(/text-overflow:\s*ellipsis/);
    expect(rule(".im-vhead-left")).toMatch(/flex-wrap:\s*nowrap/);
    expect(css).toMatch(/\.im-vhead-count,\s*\.im-vhead-chevron\s*\{[^}]*flex:\s*0 0 auto/);
  });
  it("the chevron keeps the 44px touch target on phones", () => {
    expect(css).toMatch(/\.im-vhead-chevron\s*\{[^}]*display:\s*inline-flex[^}]*min-width:\s*var\(--touch-target-min\)/);
  });
});
