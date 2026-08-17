import { describe, it, expect } from "vitest";
import {
  parseMoney,
  formatMoneyForDisplay,
  applyPriceAction,
  computeDiff,
  estimateCalls,
  resolveCellValue,
  isValidBulkDiffEntry,
  makeEditKey,
  getColumnForType,
  BULK_COLUMNS_BY_TYPE,
  BULK_ROW_TYPES,
  VAR_SKU_COLUMN_ID,
  VAR_PRICE_COLUMN_ID,
  VAR_COMPARE_AT_COLUMN_ID,
  VAR_BARCODE_COLUMN_ID,
  type BulkRow,
  type BulkDiffEntry,
} from "~/services/bulk-editor/columns.shared";

/** Variant-row shared-module tests (Phase 3 — Plan §5.3/§5.5/§5.6/§12). */

const VARIANT_COLUMNS = BULK_COLUMNS_BY_TYPE.variant;

function variantRow(overrides: Partial<BulkRow> = {}): BulkRow {
  return {
    id: "gid://shopify/ProductVariant/11",
    type: "variant",
    title: "S / Red",
    seoTitle: "",
    seoDescription: "",
    handle: "",
    productId: "gid://shopify/Product/1",
    productTitle: "Shirt",
    sku: "SH-S-RED",
    price: "1299.90",
    compareAtPrice: "",
    barcode: "",
    position: 1,
    ...overrides,
  };
}

describe("parseMoney (Plan §5.5/§12)", () => {
  it("parses German thousands+comma decimals: 1.299,90 → 1299.90", () => {
    expect(parseMoney("1.299,90")).toEqual({ ok: true, value: "1299.90" });
  });

  it("parses English thousands+dot decimals: 1,299.90 → 1299.90", () => {
    expect(parseMoney("1,299.90")).toEqual({ ok: true, value: "1299.90" });
  });

  it("parses a plain integer: 1299 → 1299.00", () => {
    expect(parseMoney("1299")).toEqual({ ok: true, value: "1299.00" });
  });

  it("rejects negative amounts", () => {
    expect(parseMoney("-5")).toEqual({ ok: false, error: "negative" });
  });

  it("returns value:null for empty input — the caller decides the semantics", () => {
    expect(parseMoney("")).toEqual({ ok: true, value: null });
    expect(parseMoney("   ")).toEqual({ ok: true, value: null });
  });

  it("rejects non-numeric input", () => {
    expect(parseMoney("abc")).toEqual({ ok: false, error: "invalid" });
  });

  it("rejects ambiguous multi-separator input: 1.2.3", () => {
    expect(parseMoney("1.2.3")).toEqual({ ok: false, error: "invalid" });
    expect(parseMoney("1,2,3")).toEqual({ ok: false, error: "invalid" });
  });

  it("strips whitespace and currency symbols/codes", () => {
    expect(parseMoney("€ 1.299,90")).toEqual({ ok: true, value: "1299.90" });
    expect(parseMoney("$1,299.90")).toEqual({ ok: true, value: "1299.90" });
    expect(parseMoney(" 12,5 EUR ")).toEqual({ ok: true, value: "12.50" });
  });

  it("treats a single comma with 1-2 digits after as the decimal separator", () => {
    expect(parseMoney("12,5")).toEqual({ ok: true, value: "12.50" });
    // …but a comma with 3 digits after is a thousands separator.
    expect(parseMoney("1,299")).toEqual({ ok: true, value: "1299.00" });
  });

  it("rejects a bare single dot with EXACTLY three digits as ambiguous (Finding 3)", () => {
    // "1.299" could be 1299 (de/es thousands) or 1.299 (en decimal) — never
    // guess; the merchant disambiguates via 1299 or 1.299,00.
    expect(parseMoney("1.299")).toEqual({ ok: false, error: "ambiguous" });
    expect(parseMoney("12.995")).toEqual({ ok: false, error: "ambiguous" });
    expect(parseMoney("€ 1.299")).toEqual({ ok: false, error: "ambiguous" });
  });

  it("keeps the unambiguous neighbours of the ambiguous case parsing", () => {
    expect(parseMoney("1.299,00")).toEqual({ ok: true, value: "1299.00" });
    expect(parseMoney("1.29")).toEqual({ ok: true, value: "1.29" });
    expect(parseMoney("1.2999")).toEqual({ ok: true, value: "1.30" });
    expect(parseMoney("1,299.00")).toEqual({ ok: true, value: "1299.00" });
  });
});

describe("formatMoneyForDisplay", () => {
  it("formats the normalized value in the app language", () => {
    expect(formatMoneyForDisplay("1299.90", "de")).toBe("1.299,90");
    expect(formatMoneyForDisplay("1299.90", "en")).toBe("1,299.90");
  });

  it("passes empty and unparseable values through verbatim", () => {
    expect(formatMoneyForDisplay("", "de")).toBe("");
    expect(formatMoneyForDisplay("abc", "de")).toBe("abc");
  });
});

describe("applyPriceAction (Plan §5.6/§12 — pure calculations)", () => {
  it("percent: +10 % and -50 %", () => {
    expect(applyPriceAction("100.00", { id: "percent", amount: 10 })).toBe("110.00");
    expect(applyPriceAction("99.90", { id: "percent", amount: -50 })).toBe("49.95");
  });

  it("absolute: ± X, clamped at 0.00", () => {
    expect(applyPriceAction("10.00", { id: "absolute", amount: 5 })).toBe("15.00");
    expect(applyPriceAction("10.00", { id: "absolute", amount: -15 })).toBe("0.00");
  });

  it("set: fixed value, works on an EMPTY current price", () => {
    expect(applyPriceAction("", { id: "set", amount: 19.9 })).toBe("19.90");
    expect(applyPriceAction("10.00", { id: "set", amount: -1 })).toBeNull();
  });

  it("rounding to ,00 / ,90 / ,95 snaps to the NEAREST ending", () => {
    expect(applyPriceAction("10.49", { id: "round00" })).toBe("10.00");
    expect(applyPriceAction("10.50", { id: "round00" })).toBe("11.00");
    expect(applyPriceAction("10.20", { id: "round90" })).toBe("9.90");
    expect(applyPriceAction("10.49", { id: "round90" })).toBe("10.90");
    expect(applyPriceAction("10.44", { id: "round95" })).toBe("9.95");
    expect(applyPriceAction("10.46", { id: "round95" })).toBe("10.95");
  });

  it("returns null for empty/unparseable current price on non-set actions", () => {
    expect(applyPriceAction("", { id: "percent", amount: 10 })).toBeNull();
    expect(applyPriceAction("abc", { id: "round90" })).toBeNull();
    expect(applyPriceAction("10.00", { id: "compareAtFromPrice" })).toBeNull(); // caller copies row-wise
  });
});

describe("computeDiff — money normalization (Plan §5.5)", () => {
  const row = variantRow();

  it("re-typing the same amount in another locale format is NOT dirty", () => {
    const edits = { [makeEditKey(row.id, "", "", VAR_PRICE_COLUMN_ID)]: "1.299,90" };
    expect(computeDiff([row], VARIANT_COLUMNS, edits)).toEqual([]);
    const editsEn = { [makeEditKey(row.id, "", "", VAR_PRICE_COLUMN_ID)]: "1,299.90" };
    expect(computeDiff([row], VARIANT_COLUMNS, editsEn)).toEqual([]);
  });

  it("a changed amount diffs with the NORMALIZED dot value", () => {
    const edits = { [makeEditKey(row.id, "", "", VAR_PRICE_COLUMN_ID)]: "1.299,95" };
    const diff = computeDiff([row], VARIANT_COLUMNS, edits);
    expect(diff).toHaveLength(1);
    expect(diff[0]).toMatchObject({ rowId: row.id, rowType: "variant", columnId: VAR_PRICE_COLUMN_ID, value: "1299.95" });
  });

  it("clearing carries an empty value (price → cell error later, compareAt → null later)", () => {
    const edits = {
      [makeEditKey(row.id, "", "", VAR_PRICE_COLUMN_ID)]: "",
      [makeEditKey(row.id, "", "", VAR_COMPARE_AT_COLUMN_ID)]: "",
    };
    const diff = computeDiff([row], VARIANT_COLUMNS, edits);
    // compareAtPrice baseline is already "" — clearing it is NOT a change;
    // price "" over "1299.90" IS.
    expect(diff).toHaveLength(1);
    expect(diff[0].columnId).toBe(VAR_PRICE_COLUMN_ID);
    expect(diff[0].value).toBe("");
  });

  it("unparseable input passes through verbatim so the server can fail the CELL", () => {
    const edits = { [makeEditKey(row.id, "", "", VAR_PRICE_COLUMN_ID)]: "abc" };
    const diff = computeDiff([row], VARIANT_COLUMNS, edits);
    expect(diff).toHaveLength(1);
    expect(diff[0].value).toBe("abc");
  });
});

describe("variant columns (Plan §5.3)", () => {
  it("SKU/price/compareAtPrice/barcode are editable; context and position are not", () => {
    const row = variantRow();
    for (const id of [VAR_SKU_COLUMN_ID, VAR_PRICE_COLUMN_ID, VAR_COMPARE_AT_COLUMN_ID, VAR_BARCODE_COLUMN_ID]) {
      const column = getColumnForType("variant", id);
      expect(column?.editable).toBe(true);
      expect(column?.translatable).toBe(false);
      expect(resolveCellValue(row, column!).editable).toBe(true);
    }
    for (const id of ["productTitle", "variantTitle", "position", "image"]) {
      const column = getColumnForType("variant", id);
      expect(column?.editable).toBe(false);
    }
  });

  it("resolves the read-only context columns from the row", () => {
    const row = variantRow();
    expect(resolveCellValue(row, getColumnForType("variant", "productTitle")!).value).toBe("Shirt");
    expect(resolveCellValue(row, getColumnForType("variant", "variantTitle")!).value).toBe("S / Red");
    expect(resolveCellValue(row, getColumnForType("variant", "position")!).value).toBe("1");
  });

  it("ALL variant columns are translatable:false", () => {
    expect(VARIANT_COLUMNS.every((c) => !c.translatable)).toBe(true);
  });

  it("rejects a foreign-locale edit on a variant column (server-side validation)", () => {
    const columnsByType = Object.fromEntries(
      BULK_ROW_TYPES.map((t) => [t, BULK_COLUMNS_BY_TYPE[t]]),
    ) as Record<(typeof BULK_ROW_TYPES)[number], typeof VARIANT_COLUMNS>;
    const base = {
      rowId: "gid://shopify/ProductVariant/11",
      rowType: "variant",
      locale: "",
      marketId: "",
      columnId: VAR_PRICE_COLUMN_ID,
      value: "10.00",
    };
    expect(isValidBulkDiffEntry(base, BULK_ROW_TYPES, columnsByType)).toBe(true);
    expect(isValidBulkDiffEntry({ ...base, locale: "fr" }, BULK_ROW_TYPES, columnsByType)).toBe(false);
  });
});

describe("estimateCalls — variant grouping (Plan §5.4/§10.1)", () => {
  function priceEntry(variantNum: number): BulkDiffEntry {
    return {
      rowId: `gid://shopify/ProductVariant/${variantNum}`,
      rowType: "variant",
      locale: "",
      marketId: "",
      columnId: VAR_PRICE_COLUMN_ID,
      value: "10.00",
    };
  }

  it("counts ONE call per PRODUCT with the row→product mapping", () => {
    const diff = [priceEntry(1), priceEntry(2), priceEntry(3)];
    const map = {
      "gid://shopify/ProductVariant/1": "gid://shopify/Product/A",
      "gid://shopify/ProductVariant/2": "gid://shopify/Product/A",
      "gid://shopify/ProductVariant/3": "gid://shopify/Product/B",
    };
    expect(estimateCalls(diff, VARIANT_COLUMNS, { variantProductIdByRowId: map })).toBe(2);
  });

  it("over-estimates (one call per row) without the mapping — never under", () => {
    const diff = [priceEntry(1), priceEntry(2), priceEntry(3)];
    expect(estimateCalls(diff, VARIANT_COLUMNS)).toBe(3);
  });

  it("several dirty cells of the same variant still count once", () => {
    const diff: BulkDiffEntry[] = [
      priceEntry(1),
      { ...priceEntry(1), columnId: VAR_SKU_COLUMN_ID, value: "NEW-SKU" },
    ];
    const map = { "gid://shopify/ProductVariant/1": "gid://shopify/Product/A" };
    expect(estimateCalls(diff, VARIANT_COLUMNS, { variantProductIdByRowId: map })).toBe(1);
  });
});
