/**
 * The Grundpreis (Stückpreis, unit price) — vocabulary and parsing.
 *
 * Shopify's own variant page carries a box declaring a pack's total quantity
 * (500 g) and a reference unit (1 kg); the storefront then prints
 * "CHF 22.90 · CHF 45.80 / kg" beside the price. It is a legal display rule —
 * the Preisangabenverordnung in Germany, the Preisbekanntgabeverordnung in
 * Switzerland, directive 98/6/EC behind both — for anything sold by weight or
 * volume.
 *
 * ── Two facts here were MEASURED, not read ──────────────────────────────────
 * Both on a live shop (2026-08-19, [api.unit-price-probe.tsx]), and both fail
 * SILENTLY when guessed, which is why they live in one module instead of at
 * the call sites.
 *
 *  1. The unit enum is NOT `WeightUnit`. Every other weight field in this app
 *     takes `GRAMS`/`KILOGRAMS`; this one takes `G`/`KG`, and a long spelling
 *     is refused at the SCHEMA level — a top-level `errors` array with
 *     `data: null` that never reaches `userErrors`, so the whole save reads as
 *     a success while nothing was written.
 *
 *  2. `unitPriceMeasurement: null` does NOT clear it. The mutation accepts it,
 *     reports no errors, and leaves the measurement exactly where it was.
 *     Writing the EMPTY STATE clears it: a variant without a Grundpreis reads
 *     back as `{quantityValue: 0, quantityUnit: null, …}` — not as `null` — so
 *     that shape is a VALUE, where `null` is an absence the mutation skips.
 *     A feature that can set a price per kilo and not unset it is a trap, and
 *     the wrong spelling of the removal is invisible until a merchant tries.
 *
 * Client-safe: imported by the variants panel as well as by the write path, so
 * nothing here may reach for Prisma, the admin client or `process`.
 */

/**
 * Shopify's `UnitPriceMeasurementMeasuredUnit`, grouped the way a merchant
 * picks one.
 *
 * The groups are the picker's structure, not decoration: 23 units in one flat
 * list is a scroll, and the merchant already knows whether they are selling by
 * volume or by weight.
 */
export const UNIT_PRICE_UNIT_GROUPS: Array<{ key: string; units: readonly string[] }> = [
  { key: "volume", units: ["ML", "CL", "L", "M3", "FLOZ", "PT", "QT", "GAL"] },
  { key: "weight", units: ["MG", "G", "KG", "OZ", "LB"] },
  { key: "length", units: ["MM", "CM", "M", "IN", "FT", "YD"] },
  { key: "area", units: ["M2", "FT2"] },
  { key: "count", units: ["ITEM"] },
];

/**
 * Every unit the schema accepts.
 *
 * `UNKNOWN` is deliberately NOT offered: it is what Shopify answers for a
 * measurement it cannot classify, not something a merchant means. It stays
 * accepted on the way IN so a value written elsewhere round-trips instead of
 * being refused by us.
 */
export const UNIT_PRICE_UNITS: readonly string[] = [
  ...UNIT_PRICE_UNIT_GROUPS.flatMap((group) => group.units),
  "UNKNOWN",
];

/** The symbol a label carries. Locale-independent for all but the last two,
 *  which the caller overrides from its own strings. */
export const UNIT_PRICE_SYMBOLS: Record<string, string> = {
  ML: "ml", CL: "cl", L: "l", M3: "m³", FLOZ: "fl oz", PT: "pt", QT: "qt", GAL: "gal",
  MG: "mg", G: "g", KG: "kg", OZ: "oz", LB: "lb",
  MM: "mm", CM: "cm", M: "m", IN: "in", FT: "ft", YD: "yd",
  M2: "m²", FT2: "ft²",
  ITEM: "item", UNKNOWN: "?",
};

export function isUnitPriceUnit(value: string): boolean {
  return UNIT_PRICE_UNITS.includes(value);
}

/**
 * How a Grundpreis is REMOVED. See fact 2 in the header — this is the one
 * spelling that works, and it is a constant so no call site can re-invent it.
 */
export const EMPTY_MEASUREMENT_INPUT = {
  quantityValue: 0,
  quantityUnit: null,
  referenceValue: 0,
  referenceUnit: null,
} as const;

/**
 * What "nothing is set" looks like coming BACK.
 *
 * MEASURED: not `null` but a zeroed struct. `=== null` as the emptiness test
 * reports a variant with no Grundpreis as having one, and a successful removal
 * as a failure.
 */
export function isEmptyMeasurement(
  measurement: { quantityUnit?: unknown; referenceUnit?: unknown } | null | undefined,
): boolean {
  return !measurement || !measurement.quantityUnit || !measurement.referenceUnit;
}

/**
 * A quantity: a positive number, comma or point.
 *
 * The comma is folded because a German merchant types one. Zero and negatives
 * are refused rather than passed on — "0 g per 1 kg" is not a Grundpreis, and
 * Shopify's rejection of it would arrive as a schema-level error that never
 * reaches `userErrors`.
 */
export function parseUnitQuantity(raw: string): number | null {
  const trimmed = raw.trim().replace(",", ".");
  if (!trimmed) return null;
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

export interface UnitPriceFieldValues {
  quantityValue: string;
  quantityUnit: string;
  referenceValue: string;
  referenceUnit: string;
}

export type UnitPriceDecision =
  | { kind: "clear" }
  | { kind: "set"; measurement: { quantityValue: number; quantityUnit: string; referenceValue: number; referenceUnit: string } }
  | { kind: "invalid"; reason: "incomplete" | "value" | "unit" };

/**
 * The four fields turned into ONE decision.
 *
 * A measurement is written as a whole — Shopify replaces the object rather
 * than merging into it — so there is no such thing as changing only the unit.
 * Three outcomes, and the middle one is why this is not an `if`:
 *
 *  - all four empty ⇒ CLEAR. The merchant emptied the box.
 *  - all four filled ⇒ SET.
 *  - some filled ⇒ INVALID, reported. Half a measurement is not a smaller
 *    measurement: sent as-is it would either be refused at the schema level
 *    (silent) or stored as something the merchant did not describe.
 */
export function decideUnitPrice(fields: UnitPriceFieldValues): UnitPriceDecision {
  const raw = [fields.quantityValue, fields.referenceValue].map((v) => v.trim());
  const units = [fields.quantityUnit, fields.referenceUnit].map((v) => v.trim());
  const filled = [...raw, ...units].filter((v) => v !== "").length;
  if (filled === 0) return { kind: "clear" };
  if (filled < 4) return { kind: "invalid", reason: "incomplete" };

  const quantityValue = parseUnitQuantity(raw[0]);
  const referenceValue = parseUnitQuantity(raw[1]);
  if (quantityValue === null || referenceValue === null) return { kind: "invalid", reason: "value" };
  if (!isUnitPriceUnit(units[0]) || !isUnitPriceUnit(units[1])) {
    return { kind: "invalid", reason: "unit" };
  }
  return {
    kind: "set",
    measurement: {
      quantityValue,
      quantityUnit: units[0],
      referenceValue,
      referenceUnit: units[1],
    },
  };
}

/** "500 g / 1 kg", for the folded disclosure's own label. A value nobody can
 *  see without unfolding is a value nobody checks. */
export function formatUnitPrice(
  fields: UnitPriceFieldValues,
  symbol: (unit: string) => string = (unit) => UNIT_PRICE_SYMBOLS[unit] ?? unit,
): string | null {
  const decision = decideUnitPrice(fields);
  if (decision.kind !== "set") return null;
  const { quantityValue, quantityUnit, referenceValue, referenceUnit } = decision.measurement;
  return `${quantityValue} ${symbol(quantityUnit)} / ${referenceValue} ${symbol(referenceUnit)}`;
}

/**
 * Shopify's nested measurement, flattened — and the empty one reported as
 * ABSENT rather than as zeros.
 *
 * A variant without a Grundpreis answers `{quantityValue: 0, quantityUnit:
 * null, …}`, not `null`. Passed through verbatim that is four fields reading
 * "0" and "" in the editor, which is a Grundpreis of nothing per nothing on
 * every variant of every shop. `isEmptyMeasurement` is the one predicate that
 * knows the difference, and it is shared with the write path so the two cannot
 * disagree about what "empty" means.
 */
export function unitPriceColumns(raw: unknown): {
  unitQuantityValue: string | null;
  unitQuantityUnit: string | null;
  unitReferenceValue: string | null;
  unitReferenceUnit: string | null;
} {
  const measurement = raw as {
    quantityValue?: number | null;
    quantityUnit?: string | null;
    referenceValue?: number | null;
    referenceUnit?: string | null;
  } | null;
  const empty = {
    unitQuantityValue: null,
    unitQuantityUnit: null,
    unitReferenceValue: null,
    unitReferenceUnit: null,
  };
  if (isEmptyMeasurement(measurement)) return empty;
  // A unit outside the enum can only come from a Shopify that has moved on.
  // Reported as absent rather than put into a Select that has no such option:
  // the Select would fall back to its FIRST entry, and saving would rewrite a
  // measurement the merchant never touched.
  if (!isUnitPriceUnit(measurement!.quantityUnit!) || !isUnitPriceUnit(measurement!.referenceUnit!)) {
    return empty;
  }
  return {
    unitQuantityValue: String(measurement!.quantityValue ?? ""),
    unitQuantityUnit: measurement!.quantityUnit ?? null,
    unitReferenceValue: String(measurement!.referenceValue ?? ""),
    unitReferenceUnit: measurement!.referenceUnit ?? null,
  };
}
