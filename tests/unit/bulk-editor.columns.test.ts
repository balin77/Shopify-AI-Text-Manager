import { describe, it, expect } from "vitest";
import {
  computeDiff,
  groupDiffByRow,
  makeEditKey,
  parseEditKey,
  parseSortParam,
  serializeSortParam,
  isValidBulkDiffEntry,
  buildColumnsForType,
  resolveCellValue,
  formatListMetafieldValue,
  parseListMetafieldInput,
  listValueContainsSeparator,
  filterSetForType,
  FILTER_IDS_BY_SET,
  metafieldColumnId,
  optionColumnId,
  richTextPreview,
  BULK_COLUMNS_BY_TYPE,
  BULK_ROW_TYPES,
  IMG_ALT_COLUMN_ID,
  type BulkRow,
  type BulkRowType,
  type ColumnDescriptor,
  type ProductColumnCaps,
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
  // Static column universe — what a shop without enabled metafields gets.
  const staticColumns = BULK_COLUMNS_BY_TYPE;
  const base = {
    rowId: "gid://shopify/Product/1",
    rowType: "product",
    locale: "",
    marketId: "",
    columnId: "field.title",
    value: "x",
  };

  it("accepts a well-formed primary-locale entry", () => {
    expect(isValidBulkDiffEntry(base, allowed, staticColumns)).toBe(true);
  });

  it("rejects malformed GIDs, unknown types and disallowed columns", () => {
    expect(isValidBulkDiffEntry({ ...base, rowId: "not-a-gid" }, allowed, staticColumns)).toBe(false);
    expect(isValidBulkDiffEntry({ ...base, rowType: "variant" }, allowed, staticColumns)).toBe(false);
    expect(
      isValidBulkDiffEntry({ ...base, columnId: "field.productType", rowType: "page" }, allowed, staticColumns),
    ).toBe(false);
    expect(isValidBulkDiffEntry({ ...base, columnId: "image" }, allowed, staticColumns)).toBe(false);
  });

  it("rejects row types outside the plan's allowlist (§3.4 gate)", () => {
    const basicTypes = allowed.filter((t) => t !== "article");
    expect(
      isValidBulkDiffEntry({ ...base, rowType: "article", columnId: "field.title" }, basicTypes, staticColumns),
    ).toBe(false);
  });

  // ── Phase 4: foreign-locale/market segments are writable now ─────────────

  it("accepts a foreign-locale entry on a translatable column", () => {
    expect(isValidBulkDiffEntry({ ...base, locale: "fr" }, allowed, staticColumns)).toBe(true);
    expect(
      isValidBulkDiffEntry(
        { ...base, locale: "fr", marketId: "gid://shopify/Market/3" },
        allowed,
        staticColumns,
      ),
    ).toBe(true);
  });

  it("rejects a foreign-locale entry on a non-translatable column", () => {
    expect(
      isValidBulkDiffEntry({ ...base, locale: "fr", columnId: "field.status" }, allowed, staticColumns),
    ).toBe(false);
  });

  it("rejects a market override without a foreign locale — primary content is always global", () => {
    expect(isValidBulkDiffEntry({ ...base, marketId: "gid://shopify/Market/3" }, allowed, staticColumns)).toBe(false);
  });

  it("rejects malformed locale and market segments", () => {
    expect(isValidBulkDiffEntry({ ...base, locale: "not a locale" }, allowed, staticColumns)).toBe(false);
    expect(
      isValidBulkDiffEntry({ ...base, locale: "fr", marketId: "not-a-gid" }, allowed, staticColumns),
    ).toBe(false);
  });

  // ── Phase 2: the mf.-column allowlist is the SERVER-built universe ───────

  const fullCaps: ProductColumnCaps = { metafields: true, options: true, imageAlt: true };
  const enabledColumns: Record<BulkRowType, ColumnDescriptor[]> = {
    product: buildColumnsForType(
      "product",
      [{ namespace: "custom", key: "material", type: "single_line_text_field" }],
      fullCaps,
    ),
    variant: buildColumnsForType("variant", [], fullCaps),
    collection: buildColumnsForType("collection", [], fullCaps),
    article: buildColumnsForType("article", [], fullCaps),
    page: buildColumnsForType("page", [], fullCaps),
    blog: buildColumnsForType("blog", [], fullCaps),
    policy: buildColumnsForType("policy", [], fullCaps),
    metaobject: buildColumnsForType("metaobject", [], fullCaps),
    image: BULK_COLUMNS_BY_TYPE.image,
  };

  it("accepts an ENABLED metafield column and rejects a non-enabled one", () => {
    expect(
      isValidBulkDiffEntry({ ...base, columnId: metafieldColumnId("custom", "material") }, allowed, enabledColumns),
    ).toBe(true);
    // Not in the server-built universe — a client claiming an arbitrary
    // mf. column is rejected, not trusted.
    expect(
      isValidBulkDiffEntry({ ...base, columnId: metafieldColumnId("custom", "secret") }, allowed, enabledColumns),
    ).toBe(false);
    // Same enabled column but the plan/caps offer no metafield columns.
    expect(
      isValidBulkDiffEntry({ ...base, columnId: metafieldColumnId("custom", "material") }, allowed, staticColumns),
    ).toBe(false);
  });

  it("rejects a rich_text metafield column (never editable)", () => {
    const withRichText: Record<BulkRowType, ColumnDescriptor[]> = {
      ...enabledColumns,
      product: buildColumnsForType(
        "product",
        [{ namespace: "custom", key: "story", type: "rich_text_field" }],
        fullCaps,
      ),
    };
    expect(
      isValidBulkDiffEntry({ ...base, columnId: metafieldColumnId("custom", "story") }, allowed, withRichText),
    ).toBe(false);
  });

  it("accepts option and img.alt columns on product rows only", () => {
    expect(isValidBulkDiffEntry({ ...base, columnId: optionColumnId(1, "name") }, allowed, enabledColumns)).toBe(true);
    expect(isValidBulkDiffEntry({ ...base, columnId: IMG_ALT_COLUMN_ID }, allowed, enabledColumns)).toBe(true);
    expect(
      isValidBulkDiffEntry(
        { ...base, rowId: "gid://shopify/Page/1", rowType: "page", columnId: optionColumnId(1, "name") },
        allowed,
        enabledColumns,
      ),
    ).toBe(false);
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

// ─── Phase 2 (Plan §4/§12): dynamic product columns ────────────────────────

const fullCaps: ProductColumnCaps = { metafields: true, options: true, imageAlt: true };
const phase2Columns = buildColumnsForType(
  "product",
  [
    { namespace: "custom", key: "material", type: "single_line_text_field" },
    { namespace: "custom", key: "care", type: "multi_line_text_field" },
    { namespace: "custom", key: "tags", type: "list.single_line_text_field" },
    { namespace: "custom", key: "story", type: "rich_text_field" },
  ],
  fullCaps,
);
const columnById = new Map(phase2Columns.map((c) => [c.id, c] as const));
const col = (id: string): ColumnDescriptor => {
  const found = columnById.get(id);
  if (!found) throw new Error(`missing column ${id}`);
  return found;
};

const productRow: BulkRow = {
  id: "gid://shopify/Product/10",
  type: "product",
  title: "Linen Shirt",
  seoTitle: "",
  seoDescription: "",
  handle: "linen-shirt",
  status: "ACTIVE",
  metafields: {
    [metafieldColumnId("custom", "material")]: {
      id: "gid://shopify/Metafield/1",
      value: "Linen",
      type: "single_line_text_field",
    },
    [metafieldColumnId("custom", "tags")]: {
      id: "gid://shopify/Metafield/2",
      value: JSON.stringify(["Red", "Blue", "Green"]),
      type: "list.single_line_text_field",
    },
    [metafieldColumnId("custom", "story")]: {
      id: "gid://shopify/Metafield/3",
      value: JSON.stringify({
        type: "root",
        children: [{ type: "paragraph", children: [{ type: "text", value: "Once upon a time" }] }],
      }),
      type: "rich_text_field",
    },
  },
  options: [
    {
      id: "gid://shopify/ProductOption/1",
      position: 1,
      name: "Size",
      values: [
        { id: "gid://shopify/ProductOptionValue/1", name: "S" },
        { id: "gid://shopify/ProductOptionValue/2", name: "M" },
      ],
      hasValueIds: true,
      linked: false,
    },
    {
      id: "gid://shopify/ProductOption/2",
      position: 2,
      name: "Color",
      values: [{ id: "", name: "Red" }],
      hasValueIds: false,
      linked: true,
    },
  ],
  mainImage: { mediaId: "gid://shopify/MediaImage/5", alt: "A linen shirt" },
};

describe("resolveCellValue (Plan §12 column resolution)", () => {
  it("resolves a metafield column WITHOUT a ProductMetafield row to an empty, editable cell", () => {
    const resolved = resolveCellValue(productRow, col(metafieldColumnId("custom", "care")));
    expect(resolved).toEqual({ value: "", editable: true });
  });

  it("resolves a single-line metafield to its raw value", () => {
    const resolved = resolveCellValue(productRow, col(metafieldColumnId("custom", "material")));
    expect(resolved).toEqual({ value: "Linen", editable: true });
  });

  it("renders a list metafield |-separated", () => {
    const resolved = resolveCellValue(productRow, col(metafieldColumnId("custom", "tags")));
    expect(resolved).toEqual({ value: "Red | Blue | Green", editable: true });
  });

  it("makes a list metafield READ-ONLY when an entry contains '|' (Finding 11)", () => {
    const conflictRow: BulkRow = {
      ...productRow,
      metafields: {
        ...productRow.metafields,
        [metafieldColumnId("custom", "tags")]: {
          id: "gid://shopify/Metafield/2",
          value: JSON.stringify(["Red", "Black|White"]),
          type: "list.single_line_text_field",
        },
      },
    };
    const resolved = resolveCellValue(conflictRow, col(metafieldColumnId("custom", "tags")));
    expect(resolved.editable).toBe(false);
    expect(resolved.readOnlyReason).toBe("listSeparatorInValue");
    // computeDiff drops an edit that sneaks into the read-only cell — saving
    // it would re-split "Black|White" into two entries.
    const edits = {
      [makeEditKey(conflictRow.id, "", "", metafieldColumnId("custom", "tags"))]: "Red | Black | White | X",
    };
    expect(computeDiff([conflictRow], phase2Columns, edits)).toEqual([]);
  });

  it("makes rich_text metafields read-only with a plain-text preview", () => {
    const resolved = resolveCellValue(productRow, col(metafieldColumnId("custom", "story")));
    expect(resolved.editable).toBe(false);
    expect(resolved.readOnlyReason).toBe("richText");
    expect(resolved.value).toBe("Once upon a time");
  });

  it("makes a LINKED option fully read-only — the name too (Plan §14 no. 5)", () => {
    const name = resolveCellValue(productRow, col(optionColumnId(2, "name")));
    expect(name.editable).toBe(false);
    expect(name.readOnlyReason).toBe("linkedOption");
    expect(name.value).toBe("Color");
    const values = resolveCellValue(productRow, col(optionColumnId(2, "values")));
    expect(values.editable).toBe(false);
    expect(values.readOnlyReason).toBe("linkedOption");
  });

  it("resolves an unlinked option to editable name and |-joined values", () => {
    expect(resolveCellValue(productRow, col(optionColumnId(1, "name")))).toEqual({
      value: "Size",
      editable: true,
    });
    expect(resolveCellValue(productRow, col(optionColumnId(1, "values")))).toEqual({
      value: "S | M",
      editable: true,
    });
  });

  it("marks a missing option position read-only", () => {
    const resolved = resolveCellValue(productRow, col(optionColumnId(3, "name")));
    expect(resolved.editable).toBe(false);
    expect(resolved.readOnlyReason).toBe("missingOption");
  });

  it("marks legacy option values (no GIDs) read-only, name stays editable", () => {
    const legacyRow: BulkRow = {
      ...productRow,
      options: [
        {
          id: "gid://shopify/ProductOption/9",
          position: 1,
          name: "Material",
          values: [{ id: "", name: "Wool" }],
          hasValueIds: false,
          linked: false,
        },
      ],
    };
    expect(resolveCellValue(legacyRow, col(optionColumnId(1, "name"))).editable).toBe(true);
    const values = resolveCellValue(legacyRow, col(optionColumnId(1, "values")));
    expect(values.editable).toBe(false);
    expect(values.readOnlyReason).toBe("legacyOptionValues");
  });

  it("resolves img.alt: editable with mediaId, read-only without, read-only without image", () => {
    expect(resolveCellValue(productRow, col(IMG_ALT_COLUMN_ID))).toEqual({
      value: "A linen shirt",
      editable: true,
    });
    const noMedia = resolveCellValue(
      { ...productRow, mainImage: { mediaId: null, alt: "x" } },
      col(IMG_ALT_COLUMN_ID),
    );
    expect(noMedia.editable).toBe(false);
    expect(noMedia.readOnlyReason).toBe("missingMediaId");
    const noImage = resolveCellValue({ ...productRow, mainImage: undefined }, col(IMG_ALT_COLUMN_ID));
    expect(noImage.editable).toBe(false);
    expect(noImage.readOnlyReason).toBe("missingImage");
  });
});

describe("list-metafield parsing (Plan §12 round-trip)", () => {
  it("round-trips JSON array → display → JSON array", () => {
    const stored = JSON.stringify(["Red", "Blue", "Green"]);
    const display = formatListMetafieldValue(stored);
    expect(display).toBe("Red | Blue | Green");
    const parsed = parseListMetafieldInput(display);
    expect(parsed).toEqual({ ok: true, values: ["Red", "Blue", "Green"] });
    if (parsed.ok) expect(JSON.stringify(parsed.values)).toBe(stored);
  });

  it("trims around the separators", () => {
    expect(parseListMetafieldInput("Red|Blue |  Green")).toEqual({
      ok: true,
      values: ["Red", "Blue", "Green"],
    });
  });

  it("rejects empty values ('no value may be empty', §4.1)", () => {
    expect(parseListMetafieldInput("Red | | Green")).toEqual({ ok: false, error: "emptyValue" });
    expect(parseListMetafieldInput("Red |")).toEqual({ ok: false, error: "emptyValue" });
  });

  it("shows non-JSON cache values verbatim instead of crashing", () => {
    expect(formatListMetafieldValue("not-json")).toBe("not-json");
    expect(formatListMetafieldValue("")).toBe("");
  });

  it("detects '|' inside a list entry (Finding 11) — non-JSON never flags", () => {
    expect(listValueContainsSeparator(JSON.stringify(["a", "b|c"]))).toBe(true);
    expect(listValueContainsSeparator(JSON.stringify(["a", "b"]))).toBe(false);
    expect(listValueContainsSeparator("")).toBe(false);
    expect(listValueContainsSeparator("plain|text-not-json")).toBe(false);
  });
});

describe("filter sets per row type (Finding 13)", () => {
  it("maps every row type to its filter vocabulary", () => {
    expect(filterSetForType("product")).toBe("content");
    expect(filterSetForType("collection")).toBe("content");
    expect(filterSetForType("article")).toBe("content");
    expect(filterSetForType("page")).toBe("content");
    expect(filterSetForType("blog")).toBe("content");
    expect(filterSetForType("variant")).toBe("variant");
    expect(filterSetForType("policy")).toBe("translationOnly");
    expect(filterSetForType("metaobject")).toBe("translationOnly");
  });

  it("prunes foreign filter ids on a type switch (the route's handleTypeChange contract)", () => {
    const carried = ["missingSku", "missingTranslation", "missingSeoTitle"];
    const productValid = FILTER_IDS_BY_SET[filterSetForType("product")];
    expect(carried.filter((f) => (productValid as string[]).includes(f))).toEqual([
      "missingTranslation",
      "missingSeoTitle",
    ]);
    const variantValid = FILTER_IDS_BY_SET[filterSetForType("variant")];
    expect(carried.filter((f) => (variantValid as string[]).includes(f))).toEqual(["missingSku"]);
  });
});

describe("richTextPreview", () => {
  it("extracts nested text values", () => {
    const doc = JSON.stringify({
      type: "root",
      children: [
        { type: "paragraph", children: [{ type: "text", value: "Hello" }, { type: "text", value: "world" }] },
      ],
    });
    expect(richTextPreview(doc)).toBe("Hello world");
  });

  it("falls back to the raw string for non-JSON", () => {
    expect(richTextPreview("<p>legacy</p>")).toBe("<p>legacy</p>");
  });
});

describe("computeDiff with dynamic product columns", () => {
  const key10 = (columnId: string) => makeEditKey(productRow.id, "", "", columnId);

  it("typing into an EMPTY metafield cell is a diff (create-on-save, §4.1)", () => {
    const edits = { [key10(metafieldColumnId("custom", "care"))]: "Cold wash" };
    expect(computeDiff([productRow], phase2Columns, edits)).toEqual([
      {
        rowId: productRow.id,
        rowType: "product",
        locale: "",
        marketId: "",
        columnId: metafieldColumnId("custom", "care"),
        value: "Cold wash",
      },
    ]);
  });

  it("compares a list metafield against its DISPLAY form", () => {
    const unchanged = { [key10(metafieldColumnId("custom", "tags"))]: "Red | Blue | Green" };
    expect(computeDiff([productRow], phase2Columns, unchanged)).toEqual([]);
    const changed = { [key10(metafieldColumnId("custom", "tags"))]: "Red | Blue" };
    expect(computeDiff([productRow], phase2Columns, changed)).toHaveLength(1);
  });

  it("drops edits on per-row read-only cells (linked option, rich text)", () => {
    const edits = {
      [key10(optionColumnId(2, "name"))]: "New name",
      [key10(metafieldColumnId("custom", "story"))]: "plain text",
    };
    expect(computeDiff([productRow], phase2Columns, edits)).toEqual([]);
  });

  it("diffs option and img.alt cells against their resolved baselines", () => {
    const edits = {
      [key10(optionColumnId(1, "values"))]: "S | M", // unchanged
      [key10(optionColumnId(1, "name"))]: "Größe",
      [key10(IMG_ALT_COLUMN_ID)]: "A crisp linen shirt",
    };
    const diff = computeDiff([productRow], phase2Columns, edits);
    expect(diff.map((d) => d.columnId).sort()).toEqual([IMG_ALT_COLUMN_ID, optionColumnId(1, "name")]);
  });
});
