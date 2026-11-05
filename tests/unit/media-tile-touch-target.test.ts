/**
 * A media tile carries role="button" only for select/drag semantics (and dnd-kit's
 * useSortable adds role="button" to the tile root too). The phone / coarse-pointer
 * touch-target rules pad and enlarge every [role="button"]; on a tile that pushes
 * the absolutely positioned ALT / WebP badges outside the picture and makes each
 * tile so wide that one fits per row. Tiles opt out with `.app-media-tile`; real
 * buttons keep the rule.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const css = readFileSync(resolve(root, "app/styles/responsive.css"), "utf8");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

/** Every selector list whose rule body touches the touch-target size or padding. */
function touchRoleButtonSelectors(): string[] {
  const out: string[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) {
    const [, sel, body] = m;
    if (!/\[role="button"\]/.test(sel)) continue;
    if (/min-(width|height):\s*var\(--touch-target-min\)/.test(body) || /transform:\s*scale\(0\.97\)/.test(body)) {
      out.push(...sel.split(",").map((s) => s.trim()).filter((s) => s.includes('[role="button"]')));
    }
  }
  return out;
}

describe("media tiles are exempt from the touch-target role=button rule", () => {
  it("finds the touch rules (guards the parser itself)", () => {
    expect(touchRoleButtonSelectors().length).toBeGreaterThanOrEqual(3);
  });

  it("every [role=button] touch/padding/active selector excludes .app-media-tile", () => {
    for (const sel of touchRoleButtonSelectors()) {
      expect(sel, sel).toContain(":not(.app-media-tile)");
    }
  });

  it("real buttons still get the rule", () => {
    expect(css).toMatch(/button:not\(\.help-tooltip-trigger\),\s*\.Polaris-Button,/);
  });

  it.each([
    "app/components/image-manager/SortableImageGrid.tsx",
    "app/components/image-manager/FilePickerModal.tsx",
    "app/components/localized-images/ReplacedMediaBadge.tsx",
  ])("%s marks its role=button tile with the class", (file) => {
    expect(read(file)).toContain('className="app-media-tile"');
  });

  it("both the sortable root and the inner select tile carry the class", () => {
    const n = read("app/components/image-manager/SortableImageGrid.tsx").split('className="app-media-tile"').length - 1;
    expect(n).toBeGreaterThanOrEqual(2);
  });
});
