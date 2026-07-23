import { describe, it, expect } from "vitest";
import {
  CSV_BOM,
  CSV_ID_HEADER,
  buildCsv,
  decodeCsvCell,
  delimiterForAppLanguage,
  detectCsvDelimiter,
  editsFromCsvRecords,
  encodeCsvCell,
  mapCsvHeader,
  parseCsv,
  resolveCsvRowId,
  stripBom,
} from "~/services/bulk-editor/csv.shared";
import { buildExportColumns } from "~/services/bulk-editor/csv-export.server";
import {
  computeDiff,
  makeEditKey,
  BULK_COLUMNS_BY_TYPE,
  type BulkRow,
} from "~/services/bulk-editor/columns.shared";

/**
 * Locks the CSV contract of Plan §8.1/§8.2 (tests listed in §12): RFC-4180
 * escaping + formula-injection prefix, delimiter/BOM detection, header →
 * ColumnDescriptor.id mapping with REPORTED unknown columns, ambiguous-handle
 * errors, and — the load-bearing one — "import diff = grid diff": the import
 * pipeline produces the exact computeDiff output that typing the same values
 * would.
 */

const productColumns = BULK_COLUMNS_BY_TYPE.product;

const productRow: BulkRow = {
  id: "gid://shopify/Product/1",
  type: "product",
  title: "Blue Shoes",
  seoTitle: "Blue Shoes | Shop",
  seoDescription: "Comfortable running shoes.",
  handle: "blue-shoes",
  productType: "Shoes",
  status: "ACTIVE",
  descriptionHtml: "<p>Nice</p>",
};

describe("delimiterForAppLanguage", () => {
  it("picks ; for de/es and , for en (§8.1)", () => {
    expect(delimiterForAppLanguage("de")).toBe(";");
    expect(delimiterForAppLanguage("es")).toBe(";");
    expect(delimiterForAppLanguage("de-DE")).toBe(";");
    expect(delimiterForAppLanguage("en")).toBe(",");
    expect(delimiterForAppLanguage("fr")).toBe(",");
  });
});

describe("encodeCsvCell / decodeCsvCell", () => {
  it("quotes values containing the delimiter, quotes or line breaks (RFC 4180)", () => {
    expect(encodeCsvCell("plain", ";")).toBe("plain");
    expect(encodeCsvCell("a;b", ";")).toBe('"a;b"');
    expect(encodeCsvCell("a,b", ";")).toBe("a,b"); // comma is data under ;
    expect(encodeCsvCell('say "hi"', ",")).toBe('"say ""hi"""');
    expect(encodeCsvCell("line1\nline2", ",")).toBe('"line1\nline2"');
  });

  it("prefixes formula starters with an apostrophe (=, +, -, @)", () => {
    expect(encodeCsvCell("=SUM(A1)", ",")).toBe("'=SUM(A1)");
    expect(encodeCsvCell("+49 123", ",")).toBe("'+49 123");
    expect(encodeCsvCell("-5", ",")).toBe("'-5");
    expect(encodeCsvCell("@user", ",")).toBe("'@user");
    expect(encodeCsvCell("normal", ",")).toBe("normal");
  });

  it("quotes AND prefixes when both apply", () => {
    expect(encodeCsvCell("=a;b", ";")).toBe('"\'=a;b"');
  });

  it("decode strips exactly the export prefix and nothing else", () => {
    expect(decodeCsvCell("'=SUM(A1)")).toBe("=SUM(A1)");
    expect(decodeCsvCell("'-5")).toBe("-5");
    expect(decodeCsvCell("'@user")).toBe("@user");
    // A real apostrophe not followed by a formula starter stays.
    expect(decodeCsvCell("'quoted")).toBe("'quoted");
    expect(decodeCsvCell("'")).toBe("'");
    expect(decodeCsvCell("plain")).toBe("plain");
  });

  it("encode → parse → decode round-trips every hostile value", () => {
    const values = ['=1+1', 'a;b\nc"d"', "-5", "  spaced  ", "ümläut€", "'already"];
    const csv = buildCsv(["field.title"], values.map((v) => [v]), ";");
    const parsed = parseCsv(csv);
    expect(parsed[0]).toEqual(["field.title"]);
    parsed.slice(1).forEach((record, i) => {
      expect(decodeCsvCell(record[0])).toBe(values[i]);
    });
  });
});

describe("buildCsv", () => {
  it("starts with the BOM and uses CRLF line endings (§8.1)", () => {
    const csv = buildCsv(["id", "field.title"], [["gid://x/1", "A"]], ",");
    expect(csv.startsWith(CSV_BOM)).toBe(true);
    expect(csv).toBe(`${CSV_BOM}id,field.title\r\ngid://x/1,A\r\n`);
  });
});

describe("stripBom / detectCsvDelimiter", () => {
  it("strips the BOM once", () => {
    expect(stripBom(`${CSV_BOM}abc`)).toBe("abc");
    expect(stripBom("abc")).toBe("abc");
  });

  it("detects ; , and tab, ignoring delimiters inside quotes", () => {
    expect(detectCsvDelimiter("id;field.title\r\n")).toBe(";");
    expect(detectCsvDelimiter("id,field.title\n")).toBe(",");
    expect(detectCsvDelimiter("id\tfield.title\n")).toBe("\t");
    // Comma-heavy quoted content must not flip a ;-separated file.
    expect(detectCsvDelimiter('"a,b,c,d";"x,y,z"\n')).toBe(";");
    // BOM before the header does not break detection.
    expect(detectCsvDelimiter(`${CSV_BOM}id;handle\n`)).toBe(";");
  });
});

describe("parseCsv", () => {
  it("parses quoted cells with embedded delimiters, quotes and line breaks", () => {
    const csv = 'a;"b;c";"say ""hi""";"line1\nline2"\r\nnext;1;2;3\r\n';
    expect(parseCsv(csv)).toEqual([
      ["a", "b;c", 'say "hi"', "line1\nline2"],
      ["next", "1", "2", "3"],
    ]);
  });

  it("handles \\n and \\r\\n endings and no trailing newline", () => {
    expect(parseCsv("a,b\nc,d")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
    expect(parseCsv("a,b\r\nc,d\r\n")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("produces no phantom record for a trailing newline", () => {
    expect(parseCsv("a;b\r\n").length).toBe(1);
  });

  it("auto-detects the delimiter when none is passed", () => {
    expect(parseCsv("a\tb\nc\td")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });
});

describe("mapCsvHeader", () => {
  it("maps known column ids and finds the id column", () => {
    const mapping = mapCsvHeader(
      [CSV_ID_HEADER, "field.handle", "field.title"],
      productColumns,
      { foreign: false },
    );
    expect(mapping.idIndex).toBe(0);
    expect(mapping.columns.map((m) => m.column.id)).toEqual(["field.handle", "field.title"]);
    expect(mapping.unknown).toEqual([]);
    expect(mapping.ignored).toEqual([]);
  });

  it("REPORTS unknown columns instead of silently dropping them (§8.2)", () => {
    const mapping = mapCsvHeader(
      [CSV_ID_HEADER, "field.title", "totally.bogus", "vendor"],
      productColumns,
      { foreign: false },
    );
    expect(mapping.unknown).toEqual(["totally.bogus", "vendor"]);
    expect(mapping.columns.map((m) => m.column.id)).toEqual(["field.title"]);
  });

  it("reports read-only columns as ignored, and non-translatable columns in a foreign view", () => {
    const primary = mapCsvHeader([CSV_ID_HEADER, "image", "field.status"], productColumns, {
      foreign: false,
    });
    expect(primary.ignored).toEqual(["image"]);
    expect(primary.columns.map((m) => m.column.id)).toEqual(["field.status"]);

    const foreign = mapCsvHeader([CSV_ID_HEADER, "field.status", "field.title"], productColumns, {
      foreign: true,
    });
    // status is translatable:false ⇒ ignored in a foreign locale (§8.2).
    expect(foreign.ignored).toEqual(["field.status"]);
    expect(foreign.columns.map((m) => m.column.id)).toEqual(["field.title"]);
  });

  it("skips empty header cells (Excel trailing-column artifacts)", () => {
    const mapping = mapCsvHeader([CSV_ID_HEADER, "field.title", "", "  "], productColumns, {
      foreign: false,
    });
    expect(mapping.unknown).toEqual([]);
    expect(mapping.columns).toHaveLength(1);
  });
});

describe("resolveCsvRowId", () => {
  const knownIds = new Set(["gid://shopify/Product/1", "gid://shopify/Product/2"]);
  const idsByHandle = new Map<string, string[]>([
    ["blue-shoes", ["gid://shopify/Product/1"]],
    ["dupe", ["gid://shopify/Product/1", "gid://shopify/Product/2"]],
  ]);

  it("resolves by id first", () => {
    const result = resolveCsvRowId(
      { id: "gid://shopify/Product/2", handle: "blue-shoes", line: 2 },
      knownIds,
      idsByHandle,
    );
    expect(result).toEqual({ ok: true, rowId: "gid://shopify/Product/2" });
  });

  it("errors on an unknown id (no handle guessing once an id is given)", () => {
    const result = resolveCsvRowId(
      { id: "gid://shopify/Product/999", handle: "blue-shoes", line: 3 },
      knownIds,
      idsByHandle,
    );
    expect(result).toEqual({
      ok: false,
      error: { line: 3, kind: "unknownId", value: "gid://shopify/Product/999" },
    });
  });

  it("falls back to a unique handle", () => {
    const result = resolveCsvRowId({ id: "", handle: "blue-shoes", line: 4 }, knownIds, idsByHandle);
    expect(result).toEqual({ ok: true, rowId: "gid://shopify/Product/1" });
  });

  it("an ambiguous handle is an ERROR, never a guess (§8.2)", () => {
    const result = resolveCsvRowId({ id: "", handle: "dupe", line: 5 }, knownIds, idsByHandle);
    expect(result).toEqual({
      ok: false,
      error: { line: 5, kind: "ambiguousHandle", value: "dupe" },
    });
  });

  it("errors on unknown handle and on a row with neither id nor handle", () => {
    expect(resolveCsvRowId({ id: "", handle: "nope", line: 6 }, knownIds, idsByHandle)).toEqual({
      ok: false,
      error: { line: 6, kind: "unknownHandle", value: "nope" },
    });
    expect(resolveCsvRowId({ id: "", handle: "", line: 7 }, knownIds, idsByHandle)).toEqual({
      ok: false,
      error: { line: 7, kind: "missingId", value: "" },
    });
  });
});

describe("import diff = grid diff (§12)", () => {
  it("editsFromCsvRecords + computeDiff equals manually typed edits + computeDiff", () => {
    const header = [CSV_ID_HEADER, "field.handle", "field.title", "field.seoTitle"];
    const mapping = mapCsvHeader(header, productColumns, { foreign: false });
    // The CSV changes the title, retypes the identical seoTitle (⇒ no diff)
    // and clears nothing.
    const records = [
      {
        rowId: productRow.id,
        cells: [productRow.id, "blue-shoes", "Red Shoes", "Blue Shoes | Shop"],
      },
    ];
    const importEdits = editsFromCsvRecords(records, mapping, "", "");

    const gridEdits: Record<string, string> = {
      [makeEditKey(productRow.id, "", "", "field.handle")]: "blue-shoes",
      [makeEditKey(productRow.id, "", "", "field.title")]: "Red Shoes",
      [makeEditKey(productRow.id, "", "", "field.seoTitle")]: "Blue Shoes | Shop",
    };
    expect(importEdits).toEqual(gridEdits);

    const importDiff = computeDiff([productRow], productColumns, importEdits);
    const gridDiff = computeDiff([productRow], productColumns, gridEdits);
    expect(importDiff).toEqual(gridDiff);
    expect(importDiff).toEqual([
      {
        rowId: productRow.id,
        rowType: "product",
        locale: "",
        marketId: "",
        columnId: "field.title",
        value: "Red Shoes",
      },
    ]);
  });

  it("an empty CSV cell over existing content is a deliberate clear — same as the grid", () => {
    const mapping = mapCsvHeader([CSV_ID_HEADER, "field.seoTitle"], productColumns, {
      foreign: false,
    });
    const edits = editsFromCsvRecords(
      [{ rowId: productRow.id, cells: [productRow.id, ""] }],
      mapping,
      "",
      "",
    );
    const diff = computeDiff([productRow], productColumns, edits);
    expect(diff).toEqual([
      {
        rowId: productRow.id,
        rowType: "product",
        locale: "",
        marketId: "",
        columnId: "field.seoTitle",
        value: "",
      },
    ]);
  });

  it("foreign-locale imports diff against the loaded translation baseline", () => {
    const row: BulkRow = {
      ...productRow,
      foreignValues: { "fr||field.title": "Chaussures bleues" },
    };
    const mapping = mapCsvHeader([CSV_ID_HEADER, "field.title"], productColumns, { foreign: true });
    // Retyping the existing translation is NOT a diff; a new value is.
    const same = editsFromCsvRecords(
      [{ rowId: row.id, cells: [row.id, "Chaussures bleues"] }],
      mapping,
      "fr",
      "",
    );
    expect(computeDiff([row], productColumns, same)).toEqual([]);

    const changed = editsFromCsvRecords(
      [{ rowId: row.id, cells: [row.id, "Chaussures rouges"] }],
      mapping,
      "fr",
      "",
    );
    expect(computeDiff([row], productColumns, changed)).toEqual([
      {
        rowId: row.id,
        rowType: "product",
        locale: "fr",
        marketId: "",
        columnId: "field.title",
        value: "Chaussures rouges",
      },
    ]);
  });

  it("short records (fewer cells than headers) simply produce no edit for the missing cells", () => {
    const mapping = mapCsvHeader(
      [CSV_ID_HEADER, "field.title", "field.seoTitle"],
      productColumns,
      { foreign: false },
    );
    const edits = editsFromCsvRecords(
      [{ rowId: productRow.id, cells: [productRow.id, "New Title"] }],
      mapping,
      "",
      "",
    );
    expect(Object.keys(edits)).toEqual([makeEditKey(productRow.id, "", "", "field.title")]);
  });
});

describe("buildExportColumns (§8.1 layout)", () => {
  it("content types lead with the handle column, dedupe it from the visible set and drop the image column", () => {
    const columns = buildExportColumns(
      "product",
      ["image", "field.title", "field.handle", "field.seoTitle"],
      productColumns,
    );
    expect(columns.map((c) => c.id)).toEqual(["field.handle", "field.title", "field.seoTitle"]);
  });

  it("variant rows lead with product/variant title + SKU (id-only re-import, documented)", () => {
    const columns = buildExportColumns(
      "variant",
      ["image", "var.price", "var.sku"],
      BULK_COLUMNS_BY_TYPE.variant,
    );
    expect(columns.map((c) => c.id)).toEqual(["productTitle", "variantTitle", "var.sku", "var.price"]);
  });

  it("drops visible column ids that are not in the server universe", () => {
    const columns = buildExportColumns("product", ["field.title", "mf.fake.column"], productColumns);
    expect(columns.map((c) => c.id)).toEqual(["field.handle", "field.title"]);
  });
});
