import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";

/**
 * The CSV round trip through a SPREADSHEET, not just through our own parser:
 * what Excel/LibreOffice/Sheets do to a file between export and re-import
 * (TRUE/FALSE, CRLF, Windows-1252, scientific notation, stripped zeros) and
 * the guards that keep the import from writing it — plus the language/market
 * marker that keeps a German export out of the primary fields.
 */

const loadBulkRowsMock = vi.fn();
vi.mock("~/services/bulk-editor/load.server", () => ({
  loadBulkRows: (...args: unknown[]) => loadBulkRowsMock(...args),
}));

import {
  buildCsv,
  csvIdHeaderFor,
  decodeCsvBytes,
  decodeCsvCell,
  encodeCsvCell,
  mapCsvHeader,
  parseCsvIdHeader,
} from "~/services/bulk-editor/csv.shared";
import { buildCsvImportPreview, spreadsheetDamage } from "~/services/bulk-editor/csv-import.server";
import { buildBulkCsvExport } from "~/services/bulk-editor/csv-export.server";
import {
  BULK_COLUMNS_BY_TYPE,
  computeDiff,
  makeEditKey,
  VAR_BARCODE_COLUMN_ID,
  VAR_TAXABLE_COLUMN_ID,
  type BulkRow,
} from "~/services/bulk-editor/columns.shared";

const db = {} as PrismaClient;
const productColumns = BULK_COLUMNS_BY_TYPE.product;
const variantColumns = BULK_COLUMNS_BY_TYPE.variant;

const productRow: BulkRow = {
  id: "gid://shopify/Product/1",
  type: "product",
  title: "Grüner Tee",
  seoTitle: "",
  seoDescription: "",
  handle: "gruener-tee",
  productType: "Tee",
  status: "ACTIVE",
  descriptionHtml: "<p>Zeile 1</p>\n<p>Zeile 2</p>",
  foreignValues: { "fr||field.title": "Thé vert" },
};

const variantRow: BulkRow = {
  id: "gid://shopify/ProductVariant/7",
  type: "variant",
  productId: "gid://shopify/Product/1",
  productTitle: "Grüner Tee",
  title: "100 g",
  seoTitle: "",
  seoDescription: "",
  handle: "",
  sku: "000123",
  barcode: "4006381333931",
  price: "12.50",
  taxable: "true",
  commerceKnown: true,
};

function rowsFor(rows: BulkRow[]) {
  loadBulkRowsMock.mockImplementation(async (...args: unknown[]) => {
    const opts = (args[2] ?? {}) as { ids?: string[] };
    const hit = rows.filter((r) => !opts.ids || opts.ids.includes(r.id));
    return { rows: hit, total: hit.length, translationFilterApproximate: false };
  });
}

beforeEach(() => loadBulkRowsMock.mockReset());

describe("language/market marker in the id header", () => {
  it("names every layer and parses back exactly", () => {
    expect(csvIdHeaderFor("", "")).toBe("id@primary");
    expect(csvIdHeaderFor("fr", "")).toBe("id@fr");
    expect(csvIdHeaderFor("fr", "gid://shopify/Market/5")).toBe("id@fr@gid://shopify/Market/5");
    expect(parseCsvIdHeader("id@primary")).toEqual({ locale: "", marketId: "" });
    expect(parseCsvIdHeader("id@fr@gid://shopify/Market/5")).toEqual({
      locale: "fr",
      marketId: "gid://shopify/Market/5",
    });
    expect(parseCsvIdHeader("id")).toBeNull(); // unmarked: accepted as-is
    expect(parseCsvIdHeader("field.title")).toBeUndefined();
    expect(parseCsvIdHeader("id@")).toBeUndefined();
  });

  it("maps a marked id header as the id column", () => {
    const mapping = mapCsvHeader(["id@fr", "field.title"], productColumns, { foreign: true });
    expect(mapping.idIndex).toBe(0);
    expect(mapping.fileScope).toEqual({ locale: "fr", marketId: "" });
    expect(mapping.unknown).toEqual([]);
  });

  it("the export writes the marker of the view it exported", async () => {
    rowsFor([productRow]);
    const result = await buildBulkCsvExport(db, "shop", {
      type: "product",
      locale: "fr",
      marketId: "",
      search: "",
      filters: [],
      sort: null,
      visibleColumnIds: ["field.title"],
      columns: productColumns,
      delimiter: ";",
    });
    const header = result.ok ? result.csv.split("\r\n")[0] : "";
    expect(header.startsWith("\uFEFFid@fr;field.handle;field.title;")).toBe(true);
    // Every column of the type, not just the visible one.
    expect(header.split(";")).toContain("field.descriptionHtml");
  });

  it("refuses a French file imported into the primary view", async () => {
    rowsFor([productRow]);
    const csv = buildCsv(["id@fr", "field.title"], [[productRow.id, "Thé vert bio"]], ";");
    const preview = await buildCsvImportPreview(db, "shop", {
      type: "product",
      locale: "",
      marketId: "",
      csvText: csv,
      columns: productColumns,
    });
    expect(preview).toEqual({ ok: false, error: "scopeMismatch", fileLocale: "fr", fileMarketId: "" });
  });

  it("refuses a file of another MARKET of the same language", async () => {
    rowsFor([productRow]);
    const csv = buildCsv(["id@fr@gid://shopify/Market/5", "field.title"], [[productRow.id, "x"]], ";");
    const preview = await buildCsvImportPreview(db, "shop", {
      type: "product",
      locale: "fr",
      marketId: "",
      csvText: csv,
      columns: productColumns,
    });
    expect(preview.ok).toBe(false);
  });
});

describe("an untouched file saved by a spreadsheet re-imports as NO change", () => {
  it("a non-canonical stored enum is not permanently dirty", () => {
    const row: BulkRow = { ...variantRow, taxable: "TRUE" };
    const edits = { [makeEditKey(row.id, "", "", VAR_TAXABLE_COLUMN_ID)]: "true" };
    expect(computeDiff([row], variantColumns, edits)).toEqual([]);
  });

  it("TRUE/FALSE compare equal to the canonical true/false", () => {
    const edits = { [makeEditKey(variantRow.id, "", "", VAR_TAXABLE_COLUMN_ID)]: "TRUE" };
    expect(computeDiff([variantRow], variantColumns, edits)).toEqual([]);
    const flipped = { [makeEditKey(variantRow.id, "", "", VAR_TAXABLE_COLUMN_ID)]: "FALSE" };
    expect(computeDiff([variantRow], variantColumns, flipped)).toEqual([
      expect.objectContaining({ value: "false" }),
    ]);
  });

  it("an unknown select value stays dirty (refused and reported at save time)", () => {
    const edits = { [makeEditKey(variantRow.id, "", "", VAR_TAXABLE_COLUMN_ID)]: "Ja" };
    expect(computeDiff([variantRow], variantColumns, edits)).toEqual([
      expect.objectContaining({ value: "Ja" }),
    ]);
  });

  it("CRLF inside a cell is not a change, and a real edit is sent with LF", () => {
    const key = makeEditKey(productRow.id, "", "", "field.descriptionHtml");
    expect(computeDiff([productRow], productColumns, { [key]: "<p>Zeile 1</p>\r\n<p>Zeile 2</p>" })).toEqual([]);
    const diff = computeDiff([productRow], productColumns, { [key]: "<p>Neu</p>\r\n<p>Zeile 2</p>" });
    expect(diff[0].value).toBe("<p>Neu</p>\n<p>Zeile 2</p>");
  });
});

describe("spreadsheet damage is taken out of the diff and reported", () => {
  it("recognises the three kinds and nothing else", () => {
    expect(spreadsheetDamage("4006381333931", "4.00638E+12")).toBe("scientificNotation");
    expect(spreadsheetDamage("4006381333931", "4,00638E+12")).toBe("scientificNotation");
    expect(spreadsheetDamage("000123", "123")).toBe("leadingZerosLost");
    expect(spreadsheetDamage("x".repeat(40_000), "x".repeat(32_767))).toBe("cellLimitTruncated");
    // Trimmed and CRLF→LF on the way: the cut no longer measures 32 767.
    const long = `${"x".repeat(78)}\r\n`.repeat(500);
    const cut = long.slice(0, 32_767).replace(/\r\n/g, "\n").trim();
    expect(spreadsheetDamage(long, cut)).toBe("cellLimitTruncated");
    expect(spreadsheetDamage("x".repeat(40_000), "x".repeat(100))).toBeNull(); // a real shortening
    expect(spreadsheetDamage("000123", "000124")).toBeNull();
    expect(spreadsheetDamage("4006381333931", "4006381333948")).toBeNull();
    expect(spreadsheetDamage("", "1E+5")).toBeNull(); // nothing to have damaged
  });

  it("an Excel-saved variant file writes nothing wrong", async () => {
    rowsFor([variantRow]);
    const csv = buildCsv(
      ["id@primary", "var.sku", VAR_BARCODE_COLUMN_ID, "var.price", VAR_TAXABLE_COLUMN_ID],
      [[variantRow.id, "123", "4.00638E+12", "12.5", "TRUE"]],
      ";",
    );
    const preview = await buildCsvImportPreview(db, "shop", {
      type: "variant",
      locale: "",
      marketId: "",
      csvText: csv,
      columns: variantColumns,
    });
    if (!preview.ok) throw new Error(preview.error);
    expect(preview.diff).toEqual([]);
    expect(preview.damagedCells.map((c) => [c.columnId, c.kind])).toEqual([
      ["var.sku", "leadingZerosLost"],
      [VAR_BARCODE_COLUMN_ID, "scientificNotation"],
    ]);
  });
});

describe("encoding", () => {
  it("decodes UTF-8 strictly and falls back to Windows-1252", () => {
    expect(decodeCsvBytes(new TextEncoder().encode("Grüner Tee"))).toEqual({
      text: "Grüner Tee",
      encoding: "utf8",
    });
    // "Grüner" as Windows-1252: ü = 0xFC, which is not valid UTF-8.
    const ansi = new Uint8Array([0x47, 0x72, 0xfc, 0x6e, 0x65, 0x72]);
    expect(decodeCsvBytes(ansi)).toEqual({ text: "Grüner", encoding: "windows1252" });
    const utf16 = new Uint8Array([0xff, 0xfe, 0x47, 0x00, 0xfc, 0x00]);
    expect(decodeCsvBytes(utf16)).toEqual({ text: "Gü", encoding: "utf16" });
    const utf16NoBom = new Uint8Array([0x69, 0x00, 0x64, 0x00]);
    expect(decodeCsvBytes(utf16NoBom)).toEqual({ text: "id", encoding: "utf16" });
  });

  it("a file that still carries U+FFFD is refused instead of written", async () => {
    rowsFor([productRow]);
    const csv = buildCsv(["id@primary", "field.title"], [[productRow.id, "Gr�ner Tee"]], ";");
    const preview = await buildCsvImportPreview(db, "shop", {
      type: "product",
      locale: "",
      marketId: "",
      csvText: csv,
      columns: productColumns,
    });
    expect(preview).toEqual({ ok: false, error: "badEncoding" });
  });
});

describe("duplicate lines for one row", () => {
  it("keeps the first and reports the repeat", async () => {
    rowsFor([productRow]);
    const csv = buildCsv(
      ["id@primary", "field.title"],
      [
        [productRow.id, "Erster"],
        [productRow.id, "Zweiter"],
      ],
      ";",
    );
    const preview = await buildCsvImportPreview(db, "shop", {
      type: "product",
      locale: "",
      marketId: "",
      csvText: csv,
      columns: productColumns,
    });
    if (!preview.ok) throw new Error(preview.error);
    expect(preview.diff.map((d) => d.value)).toEqual(["Erster"]);
    expect(preview.rowErrors).toEqual([{ line: 3, kind: "duplicateRow", value: productRow.id }]);
  });
});

describe("formula guard round trip", () => {
  it("is lossless for content that already starts with an apostrophe", () => {
    for (const value of ["'=abc", "''+1", "=SUM(A1)", "-5", "'plain", "it's"]) {
      const encoded = encodeCsvCell(value, ";");
      expect(decodeCsvCell(encoded)).toBe(value);
    }
  });
});
