import { describe, it, expect } from "vitest";
import {
  computeDiff,
  groupDiffByRow,
  makeEditKey,
  parseEditKey,
  parseSortParam,
  serializeSortParam,
  isValidBulkDiffEntry,
  BULK_COLUMNS_BY_TYPE,
  BULK_ROW_TYPES,
  type BulkRow,
} from "~/services/bulk-editor/columns.shared";

/**
 * Locks the diff-only save-all contract (docs/plans/PLAN_BULK_EDITOR.md
 * §1.2/§3.2), migrated from tests/unit/seo-bulk-meta.service.test.ts: only
 * cells whose value actually changed are ever submitted, a deliberate clear
 * (typing nothing) still counts as a real change, and whitespace-only edits
 * don't. New with Phase 1: the four-segment `|` edit key carrying
 * locale/marketId, and the translatable gate for foreign-locale edits.
 */

const rows: BulkRow[] = [
  {
    id: "gid://shopify/Product/1",
    type: "product",
    title: "Blue Shoes",
    seoTitle: "Blue Shoes | Shop",
    seoDescription: "Comfortable running shoes.",
    handle: "blue-shoes",
    status: "ACTIVE",
  },
  {
    id: "gid://shopify/Collection/2",
    type: "collection",
    title: "Summer Sale",
    seoTitle: "",
    seoDescription: "",
    handle: "summer-sale",
  },
];

// All columns of the row's type — what the route passes (visible AND hidden
// columns, so edits in a since-hidden column still save).
const productColumns = BULK_COLUMNS_BY_TYPE.product;
const allColumns = [...new Set(BULK_ROW_TYPES.flatMap((t) => BULK_COLUMNS_BY_TYPE[t]))];

/** Primary-locale edit key (locale "", marketId "") — the Phase-1 shape. */
const key = (id: string, columnId: string) => makeEditKey(id, "", "", columnId);

describe("computeDiff", () => {
  it("returns nothing when there are no edits", () => {
    expect(computeDiff(rows, allColumns, {})).toEqual([]);
  });

  it("ignores an edit that matches the original value exactly", () => {
    const edits = { [key("gid://shopify/Product/1", "field.title")]: "Blue Shoes" };
    expect(computeDiff(rows, allColumns, edits)).toEqual([]);
  });

  it("ignores a whitespace-only change (trims both sides before comparing)", () => {
    const edits = { [key("gid://shopify/Product/1", "field.title")]: "  Blue Shoes  " };
    expect(computeDiff(rows, allColumns, edits)).toEqual([]);
  });

  it("reports a real single-cell change", () => {
    const edits = { [key("gid://shopify/Product/1", "field.seoTitle")]: "New SEO Title" };
    expect(computeDiff(rows, allColumns, edits)).toEqual([
      {
        rowId: "gid://shopify/Product/1",
        rowType: "product",
        locale: "",
        marketId: "",
        columnId: "field.seoTitle",
        value: "New SEO Title",
      },
    ]);
  });

  it("treats a deliberate clear (empty string) as a real, save-worthy change", () => {
    const edits = { [key("gid://shopify/Product/1", "field.seoDescription")]: "" };
    expect(computeDiff(rows, allColumns, edits)).toEqual([
      {
        rowId: "gid://shopify/Product/1",
        rowType: "product",
        locale: "",
        marketId: "",
        columnId: "field.seoDescription",
        value: "",
      },
    ]);
  });

  it("does not flag a cell that was already empty and stays empty", () => {
    const edits = { [key("gid://shopify/Collection/2", "field.seoTitle")]: "   " };
    expect(computeDiff(rows, allColumns, edits)).toEqual([]);
  });

  it("handles multiple dirty cells across multiple rows, in edit-map order", () => {
    const edits = {
      [key("gid://shopify/Product/1", "field.title")]: "Blue Sneakers",
      [key("gid://shopify/Product/1", "field.handle")]: "blue-shoes", // unchanged, filtered out
      [key("gid://shopify/Collection/2", "field.handle")]: "summer-clearance",
    };
    expect(computeDiff(rows, allColumns, edits)).toEqual([
      {
        rowId: "gid://shopify/Product/1",
        rowType: "product",
        locale: "",
        marketId: "",
        columnId: "field.title",
        value: "Blue Sneakers",
      },
      {
        rowId: "gid://shopify/Collection/2",
        rowType: "collection",
        locale: "",
        marketId: "",
        columnId: "field.handle",
        value: "summer-clearance",
      },
    ]);
  });

  it("ignores edits for an id no longer present in the loaded rows (stale page)", () => {
    const edits = { [key("gid://shopify/Product/999", "field.title")]: "Ghost" };
    expect(computeDiff(rows, allColumns, edits)).toEqual([]);
  });

  it("ignores a malformed key without four segments", () => {
    const edits = {
      malformedkey: "value",
      "gid://shopify/Product/1|field.title": "three segments missing", // 2 segments
      "gid://shopify/Product/1||field.title": "still only three", // 3 segments
      "gid://shopify/Product/1|||field.title|extra": "five segments", // 5 segments
    };
    expect(computeDiff(rows, allColumns, edits)).toEqual([]);
  });

  it("parses the four-segment | key exactly — the GID's own colons never break parsing", () => {
    const edits = { "gid://shopify/Product/1|||field.handle": "new-handle" };
    expect(computeDiff(rows, allColumns, edits)).toEqual([
      {
        rowId: "gid://shopify/Product/1",
        rowType: "product",
        locale: "",
        marketId: "",
        columnId: "field.handle",
        value: "new-handle",
      },
    ]);
  });

  it("ignores a column that is not editable for the row's type (per-type allowlist)", () => {
    // productType is a product column — not valid on a collection row.
    const edits = { [key("gid://shopify/Collection/2", "field.productType")]: "Apparel" };
    expect(computeDiff(rows, allColumns, edits)).toEqual([]);
  });

  it("ignores read-only columns even when an edit sneaks into the map", () => {
    const edits = { [key("gid://shopify/Product/1", "image")]: "nope" };
    expect(computeDiff(rows, allColumns, edits)).toEqual([]);
  });

  // ── New: locale/market segments (Phase 4 carries the values; the pipeline
  //    supports them from Phase 1 on) ──────────────────────────────────────

  it("carries locale and marketId segments into the diff entry", () => {
    const withTranslations: BulkRow[] = [
      {
        ...rows[0],
        foreignValues: { "fr||field.seoTitle": "Ancien titre" },
      },
    ];
    const edits = {
      [makeEditKey("gid://shopify/Product/1", "fr", "", "field.seoTitle")]: "Nouveau titre",
    };
    expect(computeDiff(withTranslations, productColumns, edits)).toEqual([
      {
        rowId: "gid://shopify/Product/1",
        rowType: "product",
        locale: "fr",
        marketId: "",
        columnId: "field.seoTitle",
        value: "Nouveau titre",
      },
    ]);
  });

  it("compares a foreign-locale edit against the loaded translation, not the primary value", () => {
    const withTranslations: BulkRow[] = [
      {
        ...rows[0],
        foreignValues: { "fr||field.seoTitle": "Titre existant" },
      },
    ];
    const unchanged = {
      [makeEditKey("gid://shopify/Product/1", "fr", "", "field.seoTitle")]: "  Titre existant  ",
    };
    expect(computeDiff(withTranslations, productColumns, unchanged)).toEqual([]);
    // Typing the PRIMARY value into an untranslated foreign cell IS a diff —
    // the translation doesn't exist yet.
    const primaryEcho = {
      [makeEditKey("gid://shopify/Product/1", "fr", "", "field.title")]: "Blue Shoes",
    };
    expect(computeDiff(withTranslations, productColumns, primaryEcho)).toHaveLength(1);
  });

  it("keeps global and market-specific segments apart", () => {
    const market = "gid://shopify/Market/7";
    const withTranslations: BulkRow[] = [
      {
        ...rows[0],
        foreignValues: { [`fr|${market}|field.seoTitle`]: "Titre marché" },
      },
    ];
    const edits = {
      [makeEditKey("gid://shopify/Product/1", "fr", market, "field.seoTitle")]: "Titre marché", // unchanged
      [makeEditKey("gid://shopify/Product/1", "fr", "", "field.seoTitle")]: "Titre global", // global row empty → diff
    };
    expect(computeDiff(withTranslations, productColumns, edits)).toEqual([
      {
        rowId: "gid://shopify/Product/1",
        rowType: "product",
        locale: "fr",
        marketId: "",
        columnId: "field.seoTitle",
        value: "Titre global",
      },
    ]);
  });

  it("drops a foreign-locale edit on a non-translatable column", () => {
    // status is editable in the primary language but never translatable.
    const edits = {
      [makeEditKey("gid://shopify/Product/1", "fr", "", "field.status")]: "DRAFT",
    };
    expect(computeDiff(rows, productColumns, edits)).toEqual([]);
    // The same edit in the primary locale IS a diff.
    const primary = { [key("gid://shopify/Product/1", "field.status")]: "DRAFT" };
    expect(computeDiff(rows, productColumns, primary)).toHaveLength(1);
  });
});

describe("groupDiffByRow", () => {
  it("groups multiple dirty cells on the same row into one patch", () => {
    const diff = computeDiff(rows, allColumns, {
      [key("gid://shopify/Product/1", "field.title")]: "Blue Sneakers",
      [key("gid://shopify/Product/1", "field.handle")]: "blue-sneakers",
    });
    const groups = groupDiffByRow(diff);
    expect(groups).toEqual([
      {
        rowType: "product",
        rowId: "gid://shopify/Product/1",
        locale: "",
        marketId: "",
        cells: { "field.title": "Blue Sneakers", "field.handle": "blue-sneakers" },
      },
    ]);
  });

  it("keeps different rows in separate groups", () => {
    const diff = computeDiff(rows, allColumns, {
      [key("gid://shopify/Product/1", "field.title")]: "Blue Sneakers",
      [key("gid://shopify/Collection/2", "field.handle")]: "summer-clearance",
    });
    expect(groupDiffByRow(diff)).toHaveLength(2);
  });

  it("keeps primary and foreign-locale edits of the same row in separate groups", () => {
    const diff = computeDiff(rows, productColumns, {
      [key("gid://shopify/Product/1", "field.seoTitle")]: "New primary",
      [makeEditKey("gid://shopify/Product/1", "fr", "", "field.seoTitle")]: "Nouveau",
    });
    const groups = groupDiffByRow(diff);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.locale).sort()).toEqual(["", "fr"]);
  });
});

describe("edit keys", () => {
  it("round-trips through makeEditKey/parseEditKey", () => {
    const k = makeEditKey("gid://shopify/Product/1", "pt-BR", "gid://shopify/Market/3", "field.title");
    expect(parseEditKey(k)).toEqual({
      rowId: "gid://shopify/Product/1",
      locale: "pt-BR",
      marketId: "gid://shopify/Market/3",
      columnId: "field.title",
    });
  });

  it("rejects keys without exactly four segments", () => {
    expect(parseEditKey("a|b|c")).toBeNull();
    expect(parseEditKey("a|b|c|d|e")).toBeNull();
    expect(parseEditKey("no-separators")).toBeNull();
    expect(parseEditKey("|loc|mkt|col")).toBeNull(); // empty rowId
    expect(parseEditKey("row|loc|mkt|")).toBeNull(); // empty columnId
  });
});

describe("isValidBulkDiffEntry", () => {
  const allowed = BULK_ROW_TYPES;
  const base = {
    rowId: "gid://shopify/Product/1",
    rowType: "product",
    locale: "",
    marketId: "",
    columnId: "field.title",
    value: "x",
  };

  it("accepts a well-formed primary-locale entry", () => {
    expect(isValidBulkDiffEntry(base, allowed)).toBe(true);
  });

  it("rejects malformed GIDs, unknown types and disallowed columns", () => {
    expect(isValidBulkDiffEntry({ ...base, rowId: "not-a-gid" }, allowed)).toBe(false);
    expect(isValidBulkDiffEntry({ ...base, rowType: "variant" }, allowed)).toBe(false);
    expect(isValidBulkDiffEntry({ ...base, columnId: "field.productType", rowType: "page" }, allowed)).toBe(false);
    expect(isValidBulkDiffEntry({ ...base, columnId: "image" }, allowed)).toBe(false);
  });

  it("rejects row types outside the plan's allowlist (§3.4 gate)", () => {
    const basicTypes = allowed.filter((t) => t !== "article");
    expect(isValidBulkDiffEntry({ ...base, rowType: "article", columnId: "field.title" }, basicTypes)).toBe(false);
  });

  it("rejects foreign-locale/market entries until the translation write path exists (Phase 4)", () => {
    expect(isValidBulkDiffEntry({ ...base, locale: "fr" }, allowed)).toBe(false);
    expect(isValidBulkDiffEntry({ ...base, marketId: "gid://shopify/Market/3" }, allowed)).toBe(false);
  });
});

describe("parseSortParam", () => {
  it("parses a sortable column with direction (column ids contain their own dots)", () => {
    expect(parseSortParam("product", "field.title.asc")).toEqual({
      columnId: "field.title",
      direction: "asc",
    });
    expect(parseSortParam("product", "field.productType.desc")).toEqual({
      columnId: "field.productType",
      direction: "desc",
    });
  });

  it("rejects unsortable columns, unknown columns and bad directions", () => {
    expect(parseSortParam("product", "field.seoTitle.asc")).toBeNull(); // no sortKey
    expect(parseSortParam("page", "field.status.asc")).toBeNull(); // not a page column
    expect(parseSortParam("product", "field.title.sideways")).toBeNull();
    expect(parseSortParam("product", null)).toBeNull();
    expect(parseSortParam("product", "")).toBeNull();
  });

  it("round-trips through serializeSortParam", () => {
    const sort = parseSortParam("product", "field.handle.desc")!;
    expect(parseSortParam("product", serializeSortParam(sort))).toEqual(sort);
  });
});
