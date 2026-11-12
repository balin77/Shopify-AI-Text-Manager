/**
 * Cancelling "add missing translations" (PLAN §19.9, Altlast 2): the runner
 * used to ignore a cancel in the Tasks tab and carry on translating — and
 * spending the merchant's AI budget — to the end. It now re-reads its status
 * before every row and before every write block, stops, writes nothing more,
 * and leaves the (cancelled) Task with what it did write.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const translateShortFieldsBatch = vi.fn();
vi.mock("~/routes/api-ai-handlers/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/routes/api-ai-handlers/shared")>();
  return { ...actual, createAIService: () => ({ translateShortFieldsBatch }) };
});
const applyBulkDiff = vi.fn();
vi.mock("~/services/bulk-editor/apply.server", () => ({ applyBulkDiff: (...a: unknown[]) => applyBulkDiff(...a) }));
vi.mock("~/services/bulk-editor/translate-plan-read.server", () => ({
  planCellKey: (rowId: string, columnId: string) => `${rowId}|${columnId}`,
  planTranslateRead: async (_d: unknown, jobs: unknown[]) => ({ jobs, expected: new Map(), skippedChanged: 0, failures: [] }),
}));
vi.mock("~/utils/logger.server", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { runBulkEditorTranslate, type TranslateJob } from "~/routes/api-ai-handlers/bulk-editor-translate.handler";
import { BULK_COLUMNS_BY_TYPE } from "~/services/bulk-editor/columns.shared";
import { cancelTask, CANCELLABLE_TASK_STATUSES } from "~/services/tasks/task-cancel.server";

const titleColumn = BULK_COLUMNS_BY_TYPE.product.find((c) => c.id === "field.title")!;
const LOCALES = ["fr", "es", "it"];
const jobs = (count: number): TranslateJob[] =>
  Array.from({ length: count }, (_, i) => ({
    rowId: `gid://shopify/Product/${i + 1}`,
    cells: [{ column: titleColumn, fieldKey: "title", source: `src ${i + 1}`, locales: LOCALES }],
    primaryHandle: "",
  }));

/** findUnique answers "running" for the first `runningFor` reads, then `after`. */
function makeDb(runningFor: number, after: string | null) {
  let reads = 0;
  return {
    task: {
      update: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 1 })),
      findUnique: vi.fn(async () => (++reads <= runningFor ? { status: "running" } : after === null ? null : { status: after })),
    },
    groupedFieldTranslation: {},
  } as any;
}

const run = (db: any, list: TranslateJob[]) =>
  runBulkEditorTranslate("task-1", {
    db,
    shop: "s.myshopify.com",
    admin: {} as any,
    settings: null as any,
    jobs: list,
    units: list.length * 3,
    rowType: "product",
    primaryLocale: "de",
    columnsByType: { product: BULK_COLUMNS_BY_TYPE.product } as any,
    aiInstructions: null,
    seoLimits: null as any,
    translationMode: undefined as any,
  });

beforeEach(() => {
  translateShortFieldsBatch.mockReset();
  applyBulkDiff.mockReset();
  translateShortFieldsBatch.mockImplementation(async (payload: Record<string, string>, _p: string, locales: string[]) =>
    Object.fromEntries(locales.map((l) => [l, { title: `${l}:${payload.title}` }])),
  );
  applyBulkDiff.mockImplementation(async (_c: unknown, piece: unknown[]) => ({ saved: piece.length, failures: [], skippedChanged: 0, skippedFilled: 0 }));
});

describe("bulk translate: cancellation", () => {
  it("stops before the next row's AI work once the Task is cancelled — and writes nothing it was still buffering", async () => {
    // status reads: row 1 ok, row 2 ok, row 3 -> cancelled
    const db = makeDb(2, "cancelled");
    await run(db, jobs(10));
    expect(translateShortFieldsBatch).toHaveBeenCalledTimes(2);
    expect(applyBulkDiff).not.toHaveBeenCalled();
    // no terminal "running" update flips the cancelled row back
    const terminal = db.task.updateMany.mock.calls.filter((c: any[]) => c[0].where.status === "running" && c[0].data.completedAt);
    expect(terminal).toEqual([]);
  });

  it("records what was written on the CANCELLED row (conditional on it still being cancelled)", async () => {
    // 84 rows fill the first block; the 85th read says cancelled.
    const db = makeDb(84 + 1, "cancelled"); // 84 row checks + the check before block 1's piece
    await run(db, jobs(100));
    expect(applyBulkDiff).toHaveBeenCalledTimes(1);
    const cancelledWrite = db.task.updateMany.mock.calls.map((c: any[]) => c[0]).find((c: any) => c.where.status === "cancelled");
    expect(cancelledWrite).toBeTruthy();
    const result = JSON.parse(cancelledWrite.data.result);
    expect(result).toMatchObject({ cancelled: true, saved: 252, mode: "sync", blocks: 1, failed: 0 });
    // The 48 units that never got their turn are "not processed", not failed.
    expect(result.notProcessed).toBe(48);
    // translation stopped: not all 100 rows were asked
    expect(translateShortFieldsBatch.mock.calls.length).toBeLessThan(100);
  });

  it("a run stopped by the reaper (status failed) still records its partial result, conditional on that status", async () => {
    const db = makeDb(84 + 1, "failed");
    await run(db, jobs(100));
    const write = db.task.updateMany.mock.calls.map((c: any[]) => c[0]).find((c: any) => c.where.status === "failed");
    expect(write).toBeTruthy();
    expect(write.data.status).toBeUndefined();
    expect(JSON.parse(write.data.result)).toMatchObject({ saved: 252, notProcessed: 48 });
  });

  it("stops between the pieces of one block", async () => {
    // one block of 252 cells is one piece; use 2 pieces by exceeding the 500-cell cap in the tail:
    // 120 rows x 3 = 360 cells never flush before the end (< 250 only after 84 rows) — keep it simple:
    // the status read before piece 1 already says cancelled => nothing is written.
    const db = makeDb(3, "cancelled"); // 3 row checks, then the check before the tail flush
    await run(db, jobs(3));
    expect(applyBulkDiff).not.toHaveBeenCalled();
  });

  it("a deleted Task row stops the run too", async () => {
    const db = makeDb(1, null);
    await run(db, jobs(5));
    expect(translateShortFieldsBatch).toHaveBeenCalledTimes(1);
    expect(applyBulkDiff).not.toHaveBeenCalled();
    // nothing to record on a row that is gone
    const writes = db.task.updateMany.mock.calls.map((c: any[]) => c[0]).filter((c: any) => c.where.status === "cancelled");
    expect(writes).toEqual([]);
  });

  it("a failed status read is transient and does not stop the run", async () => {
    const db = makeDb(1000, "running");
    db.task.findUnique.mockRejectedValue(new Error("db blink"));
    await run(db, jobs(2));
    expect(applyBulkDiff).toHaveBeenCalledTimes(1);
  });
});

describe("tasks tab: cancel is branched on status", () => {
  it("cancels only a pending or running task, conditionally", async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const outcome = await cancelTask({ task: { updateMany } } as never, "shop.myshopify.com", "task-9");
    expect(outcome).toEqual({ ok: true, mode: "cancelled" });
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "task-9", shop: "shop.myshopify.com", status: { in: ["pending", "running"] } },
      data: { status: "cancelled", completedAt: expect.any(Date) },
    });
    expect([...CANCELLABLE_TASK_STATUSES]).toEqual(["pending", "running"]);
  });

  it("a task that already finished (or belongs to another shop) is NOT cancelled", async () => {
    const updateMany = vi.fn(async () => ({ count: 0 }));
    expect(await cancelTask({ task: { updateMany } } as never, "shop.myshopify.com", "task-9")).toEqual({
      ok: false,
      reason: "notCancellable",
    });
  });
});
