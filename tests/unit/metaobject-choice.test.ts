/**
 * The colour a metaobject entry stands for.
 *
 * Same rule as the option swatches: a chip of a colour the entry does not
 * actually hold is worse than a name with no chip, because it is what the
 * merchant looks at instead of the name.
 */

import { describe, it, expect } from "vitest";
import { metaobjectSwatchColor } from "~/services/metaobject-choice.shared";

describe("metaobjectSwatchColor", () => {
  it("takes a field DECLARED as a colour", () => {
    expect(
      metaobjectSwatchColor([
        { key: "label", value: "Ocean", type: "single_line_text_field" },
        { key: "shade", value: "#0A5C8A", type: "color" },
      ]),
    ).toBe("#0A5C8A");
  });

  it("falls back to a field NAMED like one", () => {
    // A merchant's own definition may not declare the type.
    expect(metaobjectSwatchColor([{ key: "farbe", value: "#B71C1C" }])).toBe("#B71C1C");
    expect(metaobjectSwatchColor([{ key: "color", value: "#B71C1C" }])).toBe("#B71C1C");
  });

  it("prefers the declared field over the merely named one", () => {
    expect(
      metaobjectSwatchColor([
        { key: "color_hint", value: "#111111" },
        { key: "swatch", value: "#222222", type: "color" },
      ]),
    ).toBe("#222222");
  });

  it("ignores a colour field that does not hold a colour", () => {
    // "warm brown" is a description, not something to paint.
    expect(metaobjectSwatchColor([{ key: "color_description", value: "warm brown" }])).toBeUndefined();
    expect(metaobjectSwatchColor([{ key: "shade", value: "rebeccapurple", type: "color" }])).toBeUndefined();
    expect(metaobjectSwatchColor([{ key: "shade", value: "url(x)", type: "color" }])).toBeUndefined();
  });

  it("survives anything that is not a field list", () => {
    expect(metaobjectSwatchColor(null)).toBeUndefined();
    expect(metaobjectSwatchColor({})).toBeUndefined();
    expect(metaobjectSwatchColor("[]")).toBeUndefined();
    expect(metaobjectSwatchColor([null, 3, "x"])).toBeUndefined();
    expect(metaobjectSwatchColor([])).toBeUndefined();
  });
});
