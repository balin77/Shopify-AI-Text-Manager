/**
 * The Grundpreis's two measured facts, held in one place.
 *
 * Both were learned from a live shop and both fail SILENTLY when guessed: the
 * unit enum is not `WeightUnit`, and `unitPriceMeasurement: null` does not
 * clear anything. What is tested here is the decision that sits between the
 * four boxes a merchant types into and the one object Shopify stores.
 */

import { describe, it, expect } from "vitest";
import {
  EMPTY_MEASUREMENT_INPUT,
  UNIT_PRICE_UNITS,
  decideUnitPrice,
  formatUnitPrice,
  isEmptyMeasurement,
  isUnitPriceUnit,
  parseUnitQuantity,
  unitPriceColumns,
} from "~/services/unit-price.shared";

const fields = (
  quantityValue: string,
  quantityUnit: string,
  referenceValue: string,
  referenceUnit: string,
) => ({ quantityValue, quantityUnit, referenceValue, referenceUnit });

describe("the unit vocabulary", () => {
  it("is the SHORT enum, not WeightUnit", () => {
    // The first live probe run sent GRAMS and was refused at the schema level,
    // which never reaches userErrors — the save would have read as a success.
    expect(isUnitPriceUnit("G")).toBe(true);
    expect(isUnitPriceUnit("KG")).toBe(true);
    expect(isUnitPriceUnit("GRAMS")).toBe(false);
    expect(isUnitPriceUnit("KILOGRAMS")).toBe(false);
  });

  it("covers every unit Shopify named in its own error", () => {
    // Copied from the refusal itself, so a unit dropped from the module shows
    // up here rather than as a merchant unable to pick litres.
    for (const unit of "ML CL L M3 FLOZ PT QT GAL MG G KG OZ LB MM CM M IN FT YD M2 FT2 ITEM UNKNOWN".split(" ")) {
      expect(UNIT_PRICE_UNITS).toContain(unit);
    }
  });
});

describe("parseUnitQuantity", () => {
  it("folds the comma a German merchant types", () => {
    expect(parseUnitQuantity("0,5")).toBe(0.5);
    expect(parseUnitQuantity("500")).toBe(500);
  });

  it("refuses zero, negatives and anything that is not a number", () => {
    // A bad scalar fails at the SCHEMA level, where userErrors never sees it.
    expect(parseUnitQuantity("0")).toBeNull();
    expect(parseUnitQuantity("-1")).toBeNull();
    expect(parseUnitQuantity("viel")).toBeNull();
    expect(parseUnitQuantity("")).toBeNull();
  });
});

describe("isEmptyMeasurement", () => {
  it("counts the ZEROED struct as empty", () => {
    // Shopify never answers `null` for this object. Read as a value it puts a
    // Grundpreis of nothing per nothing on every variant of every shop.
    expect(isEmptyMeasurement({ quantityUnit: null, referenceUnit: null })).toBe(true);
    expect(isEmptyMeasurement(null)).toBe(true);
    expect(isEmptyMeasurement({ quantityUnit: "G", referenceUnit: "KG" })).toBe(false);
  });

  it("counts a HALF measurement as empty", () => {
    // Not a value anybody typed: this app only ever writes all four together,
    // so one unit alone is a state to ignore, not one to render.
    expect(isEmptyMeasurement({ quantityUnit: "G", referenceUnit: null })).toBe(true);
  });
});

describe("decideUnitPrice", () => {
  it("SETS when all four are filled", () => {
    expect(decideUnitPrice(fields("500", "G", "1", "KG"))).toEqual({
      kind: "set",
      measurement: { quantityValue: 500, quantityUnit: "G", referenceValue: 1, referenceUnit: "KG" },
    });
  });

  it("CLEARS when all four are empty", () => {
    expect(decideUnitPrice(fields("", "", "", ""))).toEqual({ kind: "clear" });
  });

  it("refuses HALF a measurement rather than writing it", () => {
    // Half a measurement is not a smaller measurement. Sent as-is it is either
    // refused at the schema level (silently) or stored as something the
    // merchant did not describe.
    expect(decideUnitPrice(fields("500", "G", "", "")).kind).toBe("invalid");
    expect(decideUnitPrice(fields("500", "", "1", "KG"))).toEqual({
      kind: "invalid",
      reason: "incomplete",
    });
  });

  it("refuses a unit outside the enum", () => {
    expect(decideUnitPrice(fields("500", "GRAMS", "1", "KILOGRAMS"))).toEqual({
      kind: "invalid",
      reason: "unit",
    });
  });

  it("refuses a quantity of zero", () => {
    expect(decideUnitPrice(fields("0", "G", "1", "KG"))).toEqual({
      kind: "invalid",
      reason: "value",
    });
  });
});

describe("the clearing input", () => {
  it("is the empty STATE, never null", () => {
    // Measured: `unitPriceMeasurement: null` is accepted, reports no errors
    // and leaves the measurement exactly where it was.
    expect(EMPTY_MEASUREMENT_INPUT).toEqual({
      quantityValue: 0,
      quantityUnit: null,
      referenceValue: 0,
      referenceUnit: null,
    });
  });

  it("reads back as empty by this module's own predicate", () => {
    // The write and the read have to agree about what "cleared" means, or a
    // successful removal comes back looking like a failed one.
    expect(isEmptyMeasurement(EMPTY_MEASUREMENT_INPUT)).toBe(true);
  });
});

describe("formatUnitPrice", () => {
  it("summarises a complete measurement", () => {
    expect(formatUnitPrice(fields("500", "G", "1", "KG"))).toBe("500 g / 1 kg");
  });

  it("summarises NOTHING for a half-filled one", () => {
    // The folded disclosure's label. Built from the same parser as the save,
    // so the button cannot advertise a value the save refuses.
    expect(formatUnitPrice(fields("500", "G", "", ""))).toBeNull();
    expect(formatUnitPrice(fields("", "", "", ""))).toBeNull();
  });
});

describe("unitPriceColumns", () => {
  const NONE = {
    unitQuantityValue: null,
    unitQuantityUnit: null,
    unitReferenceValue: null,
    unitReferenceUnit: null,
  };

  it("reports the ZEROED struct as absent, not as zeros", () => {
    // Passed through verbatim it is four fields reading "0" and "" in the
    // editor — a Grundpreis of nothing per nothing on every variant of every
    // shop.
    expect(
      unitPriceColumns({ quantityValue: 0, quantityUnit: null, referenceValue: 0, referenceUnit: null }),
    ).toEqual(NONE);
    expect(unitPriceColumns(null)).toEqual(NONE);
  });

  it("flattens a real measurement into four strings", () => {
    expect(
      unitPriceColumns({ quantityValue: 500, quantityUnit: "G", referenceValue: 1, referenceUnit: "KG" }),
    ).toEqual({
      unitQuantityValue: "500",
      unitQuantityUnit: "G",
      unitReferenceValue: "1",
      unitReferenceUnit: "KG",
    });
  });

  it("drops a unit the picker does not have rather than showing the wrong one", () => {
    // A Select has no entry for it, so it would fall back to its FIRST option
    // — and the next save would rewrite a measurement the merchant never
    // touched.
    expect(
      unitPriceColumns({ quantityValue: 1, quantityUnit: "PARSEC", referenceValue: 1, referenceUnit: "KG" }),
    ).toEqual(NONE);
  });
});
