import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";

/**
 * The LARGE CSV import: the diff is split into save-sized batches (a row never
 * spans two), each batch is one applyBulkDiff call, and the merged result has
 * the exact shape of a seoBulkMeta Task result — so the Tasks tab and the
 * grid's task watch read it like any other large save.
 */

const applyBulkDiffMock = vi.fn();
vi.mock("~/services/bulk-editor/apply.server", () => ({
  applyBulkDiff: (...args: unknown[]) => applyBulkDiffMock(...args),
}));
vi.mock("~/utils/shop-locales-cache.server", () => ({
  getCachedShopLocales: async () => [
    { locale: "de", primary: true, published: true },
    { locale: "fr", primary: false, published: true },
  ],
}));

import {
  chunkImportDiff,
  mergeApplyResults,
  runCsvImport,
} from "~/services/bulk-editor/csv-import-run.server";
import {
  BULK_COLUMNS_BY_TYPE,
  type BulkApplyResult,
  type BulkDiffEntry,
} from "~/services/bulk-editor/columns.shared";

const productColumns = BULK_COLUMNS_BY_TYPE.product;

function productDiff(rows: number, columnIds: string[]): BulkDiffEntry[] {
  const diff: BulkDiffEntry[] = [];
  for (let i = 1; i <= rows; i++) {
    for (const columnId of columnIds) {
      diff.push({
        rowId: `gid://shopify/Product/${i}`,
        rowType: "product",
        locale: "",
        marketId: "",
        columnId,
        value: `v${i}`,
      });
    }
  }
  return diff;
}

beforeEach(() => applyBulkDiffMock.mockReset());

describe("chunkImportDiff", () => {
  it("splits beyond the cell cap, never splits a row, keeps every cell once and in order", () => {
    const diff = productDiff(700, ["field.title", "field.seoTitle", "field.seoDescription"]);
    const batches = chunkImportDiff(diff, productColumns, { maxCells: 500 });
    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches) expect(batch.length).toBeLessThanOrEqual(500);
    expect(batches.flat()).toEqual(diff);
    const rowsSeen = new Map<string, number>();
    batches.forEach((batch, index) => {
      for (const e of batch) {
        const first = rowsSeen.get(e.rowId);
        if (first === undefined) rowsSeen.set(e.rowId, index);
        else expect(first).toBe(index);
      }
    });
  });

  it("respects the call budget as well as the cell cap", () => {
    const diff = productDiff(100, ["field.title"]);
    const batches = chunkImportDiff(diff, productColumns, { maxCells: 10_000, maxCalls: 10 });
    expect(batches.length).toBeGreaterThan(1);
  });

  it("a small diff is one batch", () => {
    expect(chunkImportDiff(productDiff(3, ["field.title"]), productColumns)).toHaveLength(1);
  });
});

describe("mergeApplyResults", () => {
  it("sums counts, concatenates failures and repair task ids", () => {
    const a: BulkApplyResult = {
      saved: 3,
      failures: [{ rowId: "gid://shopify/Product/1", rowType: "product", message: "x" }],
      retranslation: { started: 1, translations: 4, skipped: 0, capped: 0, taskIds: ["t1"] },
    };
    const b: BulkApplyResult = {
      saved: 2,
      failures: [],
      retranslation: { started: 2, translations: 6, skipped: 1, capped: 1, taskIds: ["t2", "t3"] },
    };
    expect(mergeApplyResults([a, b, { saved: 1, failures: [] }])).toEqual({
      saved: 6,
      failures: a.failures,
      retranslation: { started: 3, translations: 10, skipped: 1, capped: 1, taskIds: ["t1", "t2", "t3"] },
    });
  });
});

describe("runCsvImport", () => {
  function fakeDb() {
    const updates: Record<string, unknown>[] = [];
    const db = {
      task: {
        update: vi.fn(async (args: { data: Record<string, unknown> }) => {
          updates.push(args.data);
          return {};
        }),
      },
    } as unknown as PrismaClient;
    return { db, updates };
  }

  it("applies every batch in order and stores ONE merged seoBulkMeta result", async () => {
    const diff = productDiff(30, ["field.title"]);
    const batches = chunkImportDiff(diff, productColumns, { maxCells: 10 });
    expect(batches).toHaveLength(3);
    applyBulkDiffMock.mockImplementation(async (_ctx: unknown, batch?: BulkDiffEntry[]) => ({
      saved: batch?.length ?? 0,
      failures: [],
    }));
    const { db, updates } = fakeDb();
    await runCsvImport("task-1", {
      db,
      shop: "shop",
      admin: {} as never,
      columnsByType: BULK_COLUMNS_BY_TYPE,
      batches,
      rowTotal: 30,
    });
    const calls = applyBulkDiffMock.mock.calls.filter((c) => c.length > 0);
    expect(calls.map((c) => c[1])).toEqual(batches);
    // The source language and target set reach the write path.
    expect(calls[0][0]).toMatchObject({ foreignLocales: ["fr"], primaryLocale: "de" });
    const final = updates[updates.length - 1];
    expect(final.status).toBe("completed");
    expect(final.processed).toBe(30);
    expect(JSON.parse(final.result as string)).toMatchObject({ saved: 30, failures: [], batches: 3 });
  });

  it("a batch that throws fails the task but keeps what the earlier batches wrote", async () => {
    const batches = chunkImportDiff(productDiff(20, ["field.title"]), productColumns, { maxCells: 10 });
    applyBulkDiffMock
      .mockResolvedValueOnce({ saved: 10, failures: [] })
      .mockRejectedValueOnce(new Error("boom"));
    const { db, updates } = fakeDb();
    await runCsvImport("task-2", {
      db,
      shop: "shop",
      admin: {} as never,
      columnsByType: BULK_COLUMNS_BY_TYPE,
      batches,
      rowTotal: 20,
    });
    const final = updates[updates.length - 1];
    expect(final.status).toBe("failed");
    expect(JSON.parse(final.result as string)).toMatchObject({ saved: 10, batches: 2, batchesDone: 1 });
  });
});
