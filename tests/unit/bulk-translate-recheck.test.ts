/**
 * recheckMissing — the cheap local re-check before each write block of the
 * "add missing translations" run (PLAN §19.6 M-4): shares the scan's two
 * translation lookups, reads ONLY the named rows, and reports what is still
 * missing now.
 */
import { describe, it, expect, vi } from "vitest";

const loadBulkRows = vi.fn();
vi.mock("~/services/bulk-editor/load.server", () => ({
  loadBulkRows: (...a: unknown[]) => loadBulkRows(...a),
}));

import { recheckMissing } from "~/services/bulk-editor/missing-translations.server";
import { buildColumnsForType, type BulkRow, type ProductColumnCaps } from "~/services/bulk-editor/columns.shared";

const caps: ProductColumnCaps = { metafields: true, options: true, imageAlt: false };
const cols = buildColumnsForType("product", [{ namespace: "custom", key: "care", type: "single_line_text_field" }], caps);
const col = (id: string) => cols.find((c) => c.id === id)!;
const SHOP = "s.myshopify.com";

const row = (id: string, extra: Partial<BulkRow> = {}) =>
  ({ id, type: "product", title: `t ${id}`, handle: `h-${id}`, seoTitle: "", seoDescription: "", ...extra }) as unknown as BulkRow;

describe("recheckMissing", () => {
  it("reports exactly the cells that are still missing; a cell filled since the scan drops out", async () => {
    loadBulkRows.mockResolvedValue({ rows: [row("p1"), row("p2")], total: 2 });
    const db = {
      contentTranslation: {
        findMany: vi.fn(async () => [
          // p1 got its French title meanwhile (a webhook sync mirrored it)
          { resourceId: "p1", key: "title", locale: "fr", value: "Titre" },
          // an EMPTY translation is not a translation
          { resourceId: "p2", key: "title", locale: "fr", value: "  " },
        ]),
      },
    };
    const missing = await recheckMissing(db as never, SHOP, {
      type: "product",
      rowIds: ["p1", "p2"],
      columns: [col("field.title")],
      locales: ["fr", "es"],
    });
    expect([...missing].sort()).toEqual(["p1|field.title|es", "p2|field.title|es", "p2|field.title|fr"]);
    // ONE row query naming exactly these ids, no scan window.
    expect(loadBulkRows).toHaveBeenCalledTimes(1);
    expect(loadBulkRows.mock.calls[0][2]).toMatchObject({ ids: ["p1", "p2"], skip: 0, take: 2, locale: "" });
  });

  it("a row whose source is empty now, or that no longer loads, contributes nothing", async () => {
    loadBulkRows.mockResolvedValue({ rows: [row("p1", { title: "  " })], total: 1 });
    const db = { contentTranslation: { findMany: vi.fn(async () => []) } };
    const missing = await recheckMissing(db as never, SHOP, {
      type: "product",
      rowIds: ["p1", "gone"],
      columns: [col("field.title")],
      locales: ["fr"],
    });
    expect(missing.size).toBe(0);
  });

  it("uses the sub-resource lookup for a metafield cell (per Metafield resource)", async () => {
    const MF = "gid://shopify/Metafield/1";
    loadBulkRows.mockResolvedValue({
      rows: [row("p1", { metafields: { "mf.custom.care": { id: MF, value: "Wash cold", type: "single_line_text_field" } } as never })],
      total: 1,
    });
    const db = {
      contentTranslation: {
        findMany: vi.fn(async (args: { where: { key?: { in: string[] } } }) =>
          args.where.key?.in.includes("value") ? [{ resourceId: MF, locale: "fr", value: "Laver" }] : [],
        ),
      },
    };
    const missing = await recheckMissing(db as never, SHOP, {
      type: "product",
      rowIds: ["p1"],
      columns: [col("mf.custom.care")],
      locales: ["fr", "es"],
    });
    expect([...missing]).toEqual(["p1|mf.custom.care|es"]);
  });

  it("makes no query at all for nothing to check", async () => {
    loadBulkRows.mockClear();
    const missing = await recheckMissing({} as never, SHOP, { type: "product", rowIds: [], columns: [col("field.title")], locales: ["fr"] });
    expect(missing.size).toBe(0);
    expect(loadBulkRows).not.toHaveBeenCalled();
  });
});
