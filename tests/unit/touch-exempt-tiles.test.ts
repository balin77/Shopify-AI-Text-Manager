/**
 * A media tile carries role="button" only for select/drag semantics (and dnd-kit's
 * useSortable adds role="button" to the tile root too). The phone / coarse-pointer
 * touch-target rules pad and enlarge every [role="button"]; on a tile that pushes
 * the absolutely positioned ALT / WebP badges outside the picture and makes each
 * tile so wide that one fits per row. Tiles opt out with `.app-touch-exempt`; real
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

  it("every [role=button] touch/padding/active selector excludes .app-touch-exempt", () => {
    for (const sel of touchRoleButtonSelectors()) {
      expect(sel, sel).toContain(":not(.app-touch-exempt)");
    }
  });

  it("the phone img max-width/height:auto rule skips images inside a tile (tiles stay square)", () => {
    const rule = css.match(/([^{}]*)\{[^{}]*height:\s*auto\s*!important[^{}]*\}/);
    expect(rule, "img height:auto !important rule not found").not.toBeNull();
    expect(rule![1]).toContain(":not(.app-touch-exempt-img)");
  });

  it.each([
    ["app/components/image-manager/SortableImageGrid.tsx", 3],
    ["app/components/image-manager/FilePickerModal.tsx", 1],
    ["app/components/unified/ImageGalleryField.tsx", 2],
    ["app/components/localized-images/LocalizedMediaReplaceButton.tsx", 1],
  ])("%s: its %i tile <img> elements carry app-touch-exempt-img", (file, n) => {
    expect(read(file).split("app-touch-exempt-img").length - 1).toBe(n);
  });

  it("the replaced-media badge keeps an invisible enlarged hit area", () => {
    expect(css).toMatch(/\.app-media-badge-hit::after\s*\{[^}]*inset:\s*-4px/);
    expect(read("app/components/localized-images/ReplacedMediaBadge.tsx")).toContain("app-media-badge-hit");
  });

  it("real buttons still get the rule", () => {
    expect(css).toMatch(/button:not\(\.help-tooltip-trigger\),\s*\.Polaris-Button,/);
  });

  it.each([
    "app/components/image-manager/SortableImageGrid.tsx",
    "app/components/image-manager/FilePickerModal.tsx",
    "app/components/localized-images/ReplacedMediaBadge.tsx",
  ])("%s marks its role=button tile with the class", (file) => {
    expect(read(file)).toMatch(/className="app-touch-exempt[ "]/);
  });

  it("both the sortable root and the inner select tile carry the class", () => {
    const n = read("app/components/image-manager/SortableImageGrid.tsx").split('className="app-touch-exempt"').length - 1;
    expect(n).toBeGreaterThanOrEqual(2);
  });
});
