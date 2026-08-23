/**
 * The clear control's container-query threshold has to be re-derived by hand.
 *
 * A container query condition cannot read a custom property — there is no
 * `var()` in `@container` — so the 320px in responsive.css is a literal that
 * silently stops agreeing with the grid tokens beside it the moment one of them
 * moves. This test is the alarm.
 *
 * The failure it pins is not hypothetical: the first cut used 360px, which sits
 * 20px ABOVE `--app-entry-field-min-width`. An `auto-fit` track opens just
 * under its own minimum and then grows past it, so the metaobject entry card
 * showed the word at a 900px grid, the bin at 1080px and the word again at
 * 1250px. A shape that flickers as the window widens is worse than either
 * shape on its own.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const css = readFileSync(resolve(process.cwd(), "app/styles/responsive.css"), "utf8");

function pxToken(name: string): number {
  const found = css.match(new RegExp(`--${name}:\\s*(\\d+)px`));
  expect(found, `--${name} is not declared as a px literal`).not.toBeNull();
  return Number(found![1]);
}

const threshold = (() => {
  const found = css.match(/@container appfield \(min-width:\s*(\d+)px\)/);
  expect(found, "the appfield container query is gone or reworded").not.toBeNull();
  return Number(found![1]);
})();

describe("the clear control's word/bin threshold", () => {
  it("sits BELOW the entry grid's column minimum, so that grid never straddles it", () => {
    // `minmax(min(100%, 340px), 1fr)`: while more than one column fits, a track
    // is never narrower than this. Below the threshold the whole population
    // answers "word" at every width instead of alternating.
    expect(threshold).toBeLessThan(pxToken("app-entry-field-min-width"));
  });

  it("sits ABOVE every Details column that shares a row, so those answer 'bin'", () => {
    // `repeat(auto-fit, minmax(195px, 1fr))` with the grid's own gap: an
    // auto-fit track tops out just below the width at which one more column
    // fits, i.e. min + (min + gap)/n − gap/n = min + (min + 2*gap)/n … the
    // widest case that still SHARES a row is n = 2.
    const min = pxToken("app-details-field-min-width");
    const gap = 16; // --app-details-grid-gap: 1rem
    const widestSharedTrack = min + (min + gap + gap) / 2;
    expect(threshold).toBeGreaterThan(widestSharedTrack);
  });

  it("is the only place the number is stated", () => {
    const occurrences = css.match(/@container appfield \(min-width:/g) ?? [];
    expect(occurrences).toHaveLength(1);
  });
});
