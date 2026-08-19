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
  SCHEMA_UNITS,
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

  it("matches Shopify's own error EXACTLY, in both directions", () => {
    // Copied from the refusal itself. Containment alone would pass a unit this
    // app offers that Shopify does not accept — and that is the failure the
    // module header calls silent: a schema-level error never reaches
    // userErrors, so the whole save reads as a success.
    expect([...SCHEMA_UNITS].sort()).toEqual(
      "ML CL L M3 FLOZ PT QT GAL MG G KG OZ LB MM CM M IN FT YD M2 FT2 ITEM UNKNOWN".split(" ").sort(),
    );
    // Everything offered is something the schema takes.
    for (const unit of UNIT_PRICE_UNITS) expect(SCHEMA_UNITS).toContain(unit);
  });

  it("does not accept UNKNOWN, on either side", () => {
    // It is what Shopify answers for a measurement it cannot classify, not
    // something a merchant means — and the picker is built from the groups, so
    // a value that got past the validator would show an empty Select over a
    // variant that HAS a unit, and the next edit would send UNKNOWN back.
    expect(isUnitPriceUnit("UNKNOWN")).toBe(false);
    expect(UNIT_PRICE_UNITS).not.toContain("UNKNOWN");
    expect(SCHEMA_UNITS).toContain("UNKNOWN");
  });
});

describe("parseUnitQuantity", () => {
  it("folds the comma a German merchant types", () => {
    expect(parseUnitQuantity("0,5")).toBe(0.5);
    expect(parseUnitQuantity("500")).toBe(500);
  });

  it("refuses the AMBIGUOUS thousands separator instead of guessing", () => {
    // "1.000" is 1000 to a German and 1.000 to an American. Guessing turns a
    // 1000 ml bottle into 1 ml, the echo matches, the save succeeds, and the
    // storefront prints a Grundpreis a thousand times too high.
    expect(parseUnitQuantity("1.000")).toBe("ambiguous");
    // Written unmistakably, both readings work.
    expect(parseUnitQuantity("1000")).toBe(1000);
    expect(parseUnitQuantity("1.000,00")).toBe(1000);
    expect(parseUnitQuantity("1,000.00")).toBe(1000);
  });

  it("keeps a quantity's own precision, unlike the money parser", () => {
    // parseMoney rounds to two fraction digits, which is right for francs and
    // wrong for a quantity.
    expect(parseUnitQuantity("0.1255")).toBe(0.1255);
    // Three decimals is the ONE precision it cannot express: "1.500" is 1500
    // to a German and 1.5 to an American, so the separator rule claims it.
    // Deliberate — the merchant writes 1500 g rather than 1.5 kg.
    expect(parseUnitQuantity("1.500")).toBe("ambiguous");
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
    expect(
      isEmptyMeasurement({ quantityValue: 500, quantityUnit: "G", referenceValue: 1, referenceUnit: "KG" }),
    ).toBe(false);
  });

  it("counts a HALF measurement as empty", () => {
    // Not a value anybody typed: this app only ever writes all four together,
    // so one unit alone is a state to ignore, not one to render.
    expect(isEmptyMeasurement({ quantityUnit: "G", referenceUnit: null })).toBe(true);
  });

  it("counts a unit with a ZERO beside it as empty", () => {
    // Rendered as a value it would sit in the boxes refusing every save
    // INCLUDING the one meant to correct it, because parseUnitQuantity refuses
    // 0. Read as empty, the merchant types a real one over it.
    expect(
      isEmptyMeasurement({ quantityValue: 0, quantityUnit: "G", referenceValue: 0, referenceUnit: "KG" }),
    ).toBe(true);
    expect(
      isEmptyMeasurement({ quantityValue: 500, quantityUnit: "G", referenceValue: 1, referenceUnit: "KG" }),
    ).toBe(false);
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

  it("refuses grams per litre", () => {
    // Two different questions, not one measurement. What Shopify does with a
    // mismatched pair is unmeasured, so this refuses rather than finding out
    // on a merchant's storefront.
    expect(decideUnitPrice(fields("500", "G", "1", "L"))).toEqual({
      kind: "invalid",
      reason: "dimension",
    });
  });

  it("reports an ambiguous quantity as ITSELF, not as a bad number", () => {
    // "not a number" sends the merchant looking for a typo instead of a
    // separator.
    expect(decideUnitPrice(fields("1.000", "ML", "1", "L"))).toEqual({
      kind: "invalid",
      reason: "ambiguous",
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

  it("drops UNKNOWN, which the picker also does not have", () => {
    expect(
      unitPriceColumns({ quantityValue: 1, quantityUnit: "UNKNOWN", referenceValue: 1, referenceUnit: "KG" }),
    ).toEqual(NONE);
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
