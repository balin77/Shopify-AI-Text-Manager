/**
 * "Add missing translations" writes in BLOCKS while it runs (PLAN §3.3/§11
 * step 1a-write): a restart loses at most the block in flight, every block
 * goes through applyBulkDiff in FILL-ONLY mode in pieces that fit a grid
 * save's caps, the plan's digests ride on the entries, the skipped counters
 * are reported, and the local re-check drops what was filled meanwhile.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const translateShortFieldsBatch = vi.fn();
vi.mock("~/routes/api-ai-handlers/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/routes/api-ai-handlers/shared")>();
  return { ...actual, createAIService: () => ({ translateShortFieldsBatch }) };
});
const applyBulkDiff = vi.fn();
vi.mock("~/services/bulk-editor/apply.server", () => ({ applyBulkDiff: (...a: unknown[]) => applyBulkDiff(...a) }));
const planTranslateRead = vi.fn();
vi.mock("~/services/bulk-editor/translate-plan-read.server", () => ({
  planCellKey: (rowId: string, columnId: string) => `${rowId}|${columnId}`,
  planTranslateRead: (...a: unknown[]) => planTranslateRead(...a),
}));
const recheckMissing = vi.fn();
vi.mock("~/services/bulk-editor/missing-translations.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/services/bulk-editor/missing-translations.server")>();
  return { ...actual, recheckMissing: (...a: unknown[]) => recheckMissing(...a) };
});
vi.mock("~/utils/logger.server", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import {
  runBulkEditorTranslate,
  BULK_TRANSLATE_BLOCK_CELLS,
  BULK_TRANSLATE_BLOCK_MS,
  type TranslateJob,
} from "~/routes/api-ai-handlers/bulk-editor-translate.handler";
import { BULK_COLUMNS_BY_TYPE } from "~/services/bulk-editor/columns.shared";

const titleColumn = BULK_COLUMNS_BY_TYPE.product.find((c) => c.id === "field.title")!;
const LOCALES = ["fr", "es", "it"];

const job = (n: number, locales = LOCALES): TranslateJob => ({
  rowId: `gid://shopify/Product/${n}`,
  cells: [{ column: titleColumn, fieldKey: "title", source: `src ${n}`, locales }],
  primaryHandle: "",
});
const jobs = (count: number) => Array.from({ length: count }, (_, i) => job(i + 1));

function makeDb() {
  return {
    task: {
      update: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 1 })),
      findUnique: vi.fn(async () => ({ status: "running" })),
    },
    groupedFieldTranslation: {},
  } as any;
}

const run = (db: any, list: TranslateJob[], extra: Record<string, unknown> = {}) =>
  runBulkEditorTranslate("task-1", {
    db,
    shop: "s.myshopify.com",
    admin: {} as any,
    settings: null as any,
    jobs: list,
    units: list.reduce((n, j) => n + j.cells.reduce((m, c) => m + c.locales.length, 0), 0),
    rowType: "product",
    primaryLocale: "de",
    columnsByType: { product: BULK_COLUMNS_BY_TYPE.product } as any,
    aiInstructions: null,
    seoLimits: null as any,
    translationMode: undefined as any,
    ...extra,
  });

const finalResult = (db: any) => {
  const call = db.task.updateMany.mock.calls.map((c: any[]) => c[0]).find((c: any) => c.data.completedAt);
  return { data: call.data, result: call.data.result ? JSON.parse(call.data.result) : null };
};

beforeEach(() => {
  translateShortFieldsBatch.mockReset();
  applyBulkDiff.mockReset();
  planTranslateRead.mockReset();
  recheckMissing.mockReset();
  translateShortFieldsBatch.mockImplementation(async (payload: Record<string, string>, _p: string, locales: string[]) =>
    Object.fromEntries(locales.map((l) => [l, { title: `${l}:${payload.title}` }])),
  );
  // Identity plan: nothing dropped, nothing expected.
  planTranslateRead.mockImplementation(async (_deps: unknown, list: unknown[]) => ({
    jobs: list,
    expected: new Map(),
    skippedChanged: 0,
    failures: [],
  }));
  applyBulkDiff.mockImplementation(async (_ctx: unknown, piece: unknown[]) => ({
    saved: piece.length,
    failures: [],
    skippedChanged: 0,
    skippedFilled: 0,
  }));
});

afterEach(() => vi.useRealTimers());

describe("bulk translate: block writing", () => {
  it("flushes a block as soon as 250 cells are buffered, and the tail at the end — all in fill-only mode", async () => {
    const db = makeDb();
    await run(db, jobs(90)); // 90 rows x 3 languages = 270 cells
    expect(applyBulkDiff).toHaveBeenCalledTimes(2);
    for (const call of applyBulkDiff.mock.calls) expect(call[0]).toMatchObject({ fillOnly: true });
    // 84 rows x 3 = 252 >= 250 triggers the first block; the 6 left go in the tail.
    expect(applyBulkDiff.mock.calls[0][1]).toHaveLength(252);
    expect(applyBulkDiff.mock.calls[1][1]).toHaveLength(18);
    const { data, result } = finalResult(db);
    expect(result).toMatchObject({ saved: 270, failed: 0, skippedChanged: 0, skippedFilled: 0, mode: "sync", blocks: 2 });
    expect(data.status).toBe("completed");
    expect(BULK_TRANSLATE_BLOCK_CELLS).toBe(250);
  });

  it("a block never splits a row's cells and every piece stays inside the grid-save caps", async () => {
    const db = makeDb();
    // 700 buffered cells in one go would exceed the 500-cell grid cap: use a long run.
    await run(db, jobs(240)); // 720 cells -> blocks of >=250 flushed as they fill
    for (const call of applyBulkDiff.mock.calls) {
      const piece = call[1] as { rowId: string; locale: string }[];
      expect(piece.length).toBeLessThanOrEqual(500);
      // rows are whole: every row present has all 3 languages
      const perRow = new Map<string, number>();
      for (const e of piece) perRow.set(e.rowId, (perRow.get(e.rowId) ?? 0) + 1);
      for (const n of perRow.values()) expect(n).toBe(3);
    }
    const total = applyBulkDiff.mock.calls.reduce((n, c) => n + (c[1] as unknown[]).length, 0);
    expect(total).toBe(720);
  });

  it("flushes by TIME too: a slow AI phase still saves what it has after 60 s", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    let calls = 0;
    translateShortFieldsBatch.mockImplementation(async (payload: Record<string, string>, _p: string, locales: string[]) => {
      calls++;
      // the second row's AI call takes 61 s
      if (calls === 2) vi.setSystemTime(new Date(Date.now() + BULK_TRANSLATE_BLOCK_MS + 1000));
      return Object.fromEntries(locales.map((l) => [l, { title: `${l}:${payload.title}` }]));
    });
    const db = makeDb();
    await run(db, jobs(3));
    // after row 2 (6 cells, >60 s since start) the first block goes; row 3 is the tail
    expect(applyBulkDiff).toHaveBeenCalledTimes(2);
    expect(applyBulkDiff.mock.calls[0][1]).toHaveLength(6);
    expect(applyBulkDiff.mock.calls[1][1]).toHaveLength(3);
  });

  it("a block that THROWS loses its own cells only; earlier blocks stay written and later ones still run", async () => {
    applyBulkDiff
      .mockImplementationOnce(async (_c: unknown, piece: unknown[]) => ({ saved: piece.length, failures: [], skippedChanged: 0, skippedFilled: 0 }))
      .mockImplementationOnce(async () => {
        throw new Error("db exploded");
      });
    const db = makeDb();
    await run(db, jobs(90));
    const { result } = finalResult(db);
    expect(result.saved).toBe(252);
    expect(result.failed).toBe(18);
    expect(result.failures).toHaveLength(18);
    expect(result.failures[0].message).toBe("db exploded");
  });

  it("reports the skipped counters and counts a skipped cell as neither saved nor failed", async () => {
    applyBulkDiff.mockImplementation(async () => ({ saved: 1, failures: [], skippedChanged: 2, skippedFilled: 1 }));
    const db = makeDb();
    await run(db, jobs(2)); // 6 cells
    const { result } = finalResult(db);
    expect(result).toMatchObject({ saved: 3, skippedChanged: 2, skippedFilled: 1, failed: 0 });
  });

  it("failed cells of a block are attributed per cell (saved excludes them)", async () => {
    applyBulkDiff.mockImplementation(async () => ({
      saved: 0,
      failures: [{ rowId: "gid://shopify/Product/1", rowType: "product", columnId: "field.title", locale: "fr", message: "no digest" }],
      skippedChanged: 0,
      skippedFilled: 0,
    }));
    const db = makeDb();
    await run(db, jobs(1));
    const { result } = finalResult(db);
    expect(result.saved).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.failures).toEqual([expect.objectContaining({ locale: "fr", message: "no digest" })]);
  });

  it("the plan's digests ride on every entry of the cell; plan skips and failures are counted in units", async () => {
    const expected = new Map([["gid://shopify/Product/1|field.title", { "gid://shopify/Product/1": "dig-1" }]]);
    planTranslateRead.mockImplementation(async (_d: unknown, list: TranslateJob[]) => ({
      jobs: [list[0]],
      expected,
      skippedChanged: 3,
      failures: [{ rowId: "gid://shopify/Product/3", columnId: "field.title", message: "unreadable", units: 3 }],
    }));
    const db = makeDb();
    await run(db, jobs(3)); // units = 9
    const piece = applyBulkDiff.mock.calls[0][1] as { expected?: unknown }[];
    expect(piece).toHaveLength(3);
    for (const e of piece) expect(e.expected).toEqual({ "gid://shopify/Product/1": "dig-1" });
    // only the planned job went to the AI
    expect(translateShortFieldsBatch).toHaveBeenCalledTimes(1);
    const { result } = finalResult(db);
    expect(result).toMatchObject({ saved: 3, skippedChanged: 3, failed: 3 });
    expect(result.failures).toEqual([expect.objectContaining({ columnId: "field.title", message: "unreadable" })]);
  });

  it("the local re-check drops cells that were filled since the scan (skippedFilled) before the block is written", async () => {
    recheckMissing.mockImplementation(async () =>
      // only French is still missing for row 1
      new Set(["gid://shopify/Product/1|field.title|fr"]),
    );
    const db = makeDb();
    await run(db, jobs(1), { recheck: { columns: [titleColumn], moType: "", locales: LOCALES } });
    expect(applyBulkDiff).toHaveBeenCalledTimes(1);
    expect(applyBulkDiff.mock.calls[0][1]).toEqual([expect.objectContaining({ locale: "fr" })]);
    const { result } = finalResult(db);
    expect(result).toMatchObject({ saved: 1, skippedFilled: 2, failed: 0 });
    expect(recheckMissing.mock.calls[0][2]).toMatchObject({ type: "product", locales: LOCALES });
  });

  it("a failing re-check falls back to the live check instead of blocking the write", async () => {
    recheckMissing.mockRejectedValue(new Error("db blink"));
    const db = makeDb();
    await run(db, jobs(1), { recheck: { columns: [titleColumn], moType: "", locales: LOCALES } });
    expect(applyBulkDiff.mock.calls[0][1]).toHaveLength(3);
  });

  it("a run killed by a rejected key after blocks were written keeps their result on the failed task", async () => {
    const keyError = Object.assign(new Error("401 invalid x-api-key"), { status: 401, code: "INVALID_AI_KEY" });
    let calls = 0;
    translateShortFieldsBatch.mockImplementation(async (payload: Record<string, string>, _p: string, locales: string[]) => {
      calls++;
      if (calls === 90) throw keyError;
      return Object.fromEntries(locales.map((l) => [l, { title: `${l}:${payload.title}` }]));
    });
    const db = makeDb();
    await run(db, jobs(90));
    const { data, result } = finalResult(db);
    expect(data.status).toBe("failed");
    // 84 rows had been written as the first block before row 90 blew up
    expect(result.saved).toBe(252);
  });
});
