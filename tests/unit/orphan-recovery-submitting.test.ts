/**
 * `submitting` batch tasks and the orphan recovery (PLAN_BULK_TRANSLATE_BATCHING
 * 19.4): a submitting task whose runner is gone moves to `waiting_batch` when
 * the provider batch id was PERSISTED (nothing lost, the poller takes over) and
 * fails as interrupted when it was not. A waiting / cancel_requested batch is
 * never touched, and a caller that did not name the batch type (the crawl's
 * request-scoped sweep) never reaches the feature at all.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  BATCH_TASK_TYPES,
  BOOT_ORPHAN_TASK_TYPES,
  BOOT_RECOVERY_TASK_TYPES,
  BOOT_SILENCE_MS,
  INTERRUPTED_TASK_ERROR,
  failOrphanedRuns,
  recoverOrphanedRuns,
  recoverSubmittingBatchTasks,
} from "../../orphan-run-recovery.js";

const taskFindMany = vi.fn<(a: any) => Promise<any[]>>();
const taskUpdateMany = vi.fn<(a: any) => Promise<any>>();
const batchFindMany = vi.fn<(a: any) => Promise<any[]>>();
const batchUpdateMany = vi.fn<(a: any) => Promise<any>>();
const snapshotFindMany = vi.fn<(a: any) => Promise<any[]>>();

const prisma: any = {
  task: { findMany: (a: any) => taskFindMany(a), updateMany: (a: any) => taskUpdateMany(a) },
  bulkTranslateBatch: { findMany: (a: any) => batchFindMany(a), updateMany: (a: any) => batchUpdateMany(a) },
  seoCrawlSnapshot: { findMany: (a: any) => snapshotFindMany(a), updateMany: vi.fn(async () => ({ count: 0 })) },
};

beforeEach(() => {
  for (const m of [taskFindMany, taskUpdateMany, batchFindMany, batchUpdateMany, snapshotFindMany]) m.mockReset();
  taskFindMany.mockResolvedValue([]);
  batchFindMany.mockResolvedValue([]);
  snapshotFindMany.mockResolvedValue([]);
  taskUpdateMany.mockImplementation(async ({ where }: any) => ({ count: where.id.in.length }));
  batchUpdateMany.mockResolvedValue({ count: 1 });
});

describe("recoverSubmittingBatchTasks", () => {
  it("persisted batch id -> waiting_batch (task) and waiting (batch row); no id -> failed as interrupted, row settled", async () => {
    taskFindMany.mockResolvedValue([
      { id: "t-with", shop: "a.myshopify.com" },
      { id: "t-without", shop: "b.myshopify.com" },
      { id: "t-empty", shop: "b.myshopify.com" },
    ]);
    batchFindMany.mockResolvedValue([
      { taskId: "t-with", batchIds: ["msgbatch_1"] },
      { taskId: "t-empty", batchIds: [] },
      // t-without has no batch row at all
    ]);

    const res = await recoverSubmittingBatchTasks(prisma, {});

    expect(res).toEqual({ resumed: 1, failed: 2, shops: ["a.myshopify.com", "b.myshopify.com"] });
    expect(taskUpdateMany).toHaveBeenCalledWith({
      where: { id: { in: ["t-with"] }, status: "submitting" },
      data: { status: "waiting_batch" },
    });
    expect(taskUpdateMany).toHaveBeenCalledWith({
      where: { id: { in: ["t-without", "t-empty"] }, status: "submitting" },
      data: { status: "failed", error: INTERRUPTED_TASK_ERROR, completedAt: expect.any(Date) },
    });
    expect(batchUpdateMany).toHaveBeenCalledWith({
      where: { taskId: { in: ["t-with"] }, state: "submitting" },
      data: { state: "waiting" },
    });
    expect(batchUpdateMany).toHaveBeenCalledWith({
      where: { taskId: { in: ["t-without", "t-empty"] }, state: "submitting" },
      data: { state: "done", lastError: INTERRUPTED_TASK_ERROR },
    });
  });

  it("a managed run with a HOLD but no batch id (the create may have been sent) is PARKED as create_unknown, not failed with the hold released", async () => {
    taskFindMany.mockResolvedValue([
      { id: "t-held", shop: "a.myshopify.com" },
      { id: "t-byo", shop: "a.myshopify.com" },
      { id: "t-nohold", shop: "a.myshopify.com" },
    ]);
    batchFindMany.mockResolvedValue([
      { taskId: "t-held", batchIds: [], source: "managed", reservationState: "held" },
      { taskId: "t-byo", batchIds: [], source: "byo", reservationState: "none" },
      { taskId: "t-nohold", batchIds: [], source: "managed", reservationState: "none" }, // died before the reservation: nothing was sent
    ]);
    const res = await recoverSubmittingBatchTasks(prisma, {});
    expect(res).toMatchObject({ resumed: 1, failed: 2 });
    expect(taskUpdateMany).toHaveBeenCalledWith({
      where: { id: { in: ["t-held"] }, status: "submitting" },
      data: { status: "waiting_batch", expiresAt: expect.any(Date) },
    });
    expect(batchUpdateMany).toHaveBeenCalledWith({
      where: { taskId: { in: ["t-held"] }, state: "submitting" },
      data: { state: "create_unknown" },
    });
    expect(taskUpdateMany).toHaveBeenCalledWith({
      where: { id: { in: ["t-byo", "t-nohold"] }, status: "submitting" },
      data: { status: "failed", error: INTERRUPTED_TASK_ERROR, completedAt: expect.any(Date) },
    });
  });

  it("only ever selects `submitting` rows of the batch types -- never waiting_batch or cancel_requested", async () => {
    await recoverSubmittingBatchTasks(prisma, {});
    const where = taskFindMany.mock.calls[0][0].where;
    expect(where.status).toBe("submitting");
    expect(where.type).toEqual({ in: BATCH_TASK_TYPES });
  });

  it("the state change is conditional on the row still being submitting", async () => {
    taskFindMany.mockResolvedValue([{ id: "t1", shop: "a.myshopify.com" }]);
    batchFindMany.mockResolvedValue([{ taskId: "t1", batchIds: ["b"] }]);
    await recoverSubmittingBatchTasks(prisma, {});
    for (const call of taskUpdateMany.mock.calls) expect(call[0].where.status).toBe("submitting");
  });

  it("applies the silence / createdBefore / shop scope; an empty shop list sweeps nothing", async () => {
    const createdBefore = new Date(Date.now() - 1000);
    await recoverSubmittingBatchTasks(prisma, { createdBefore, silentMs: BOOT_SILENCE_MS, shops: ["a.myshopify.com"] });
    const where = taskFindMany.mock.calls[0][0].where;
    expect(where.createdAt).toEqual({ lt: createdBefore });
    expect(where.updatedAt.lt.getTime()).toBeLessThanOrEqual(Date.now() - BOOT_SILENCE_MS + 50);
    expect(where.shop).toEqual({ in: ["a.myshopify.com"] });

    taskFindMany.mockClear();
    expect(await recoverSubmittingBatchTasks(prisma, { shops: [] })).toEqual({ resumed: 0, failed: 0, shops: [] });
    expect(taskFindMany).not.toHaveBeenCalled();
  });
});

describe("recoverOrphanedRuns wiring", () => {
  it("boot recovery (batch type named) resolves submitting tasks with the boot silence rule", async () => {
    const createdBefore = new Date();
    await recoverOrphanedRuns(prisma, {
      olderThan: null,
      types: BOOT_RECOVERY_TASK_TYPES,
      createdBefore,
      silentTypes: { types: BOOT_ORPHAN_TASK_TYPES, silentMs: BOOT_SILENCE_MS },
    });
    const submittingCall = taskFindMany.mock.calls.find((c) => c[0].where.status === "submitting");
    expect(submittingCall).toBeDefined();
    expect(submittingCall![0].where.createdAt).toEqual({ lt: createdBefore });
    expect(submittingCall![0].where.updatedAt).toBeDefined();
  });

  it("a caller that names no batch type (the crawl's request-scoped sweep) never touches the feature", async () => {
    await recoverOrphanedRuns(prisma, { olderThan: null, shops: ["a.myshopify.com"] });
    expect(taskFindMany.mock.calls.some((c) => c[0].where.status === "submitting")).toBe(false);
    expect(batchFindMany).not.toHaveBeenCalled();
  });

  it("failOrphanedRuns itself only matches `running` -- a waiting batch is invisible to it", async () => {
    await failOrphanedRuns(prisma, { olderThan: null, types: BOOT_RECOVERY_TASK_TYPES });
    expect(taskFindMany.mock.calls[0][0].where.status).toBe("running");
  });

  it("a failing batch lookup does not abort the recovery", async () => {
    taskFindMany.mockImplementation(async (a: any) => (a.where.status === "submitting" ? [{ id: "t", shop: "a" }] : []));
    batchFindMany.mockRejectedValue(new Error("db down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(
      recoverOrphanedRuns(prisma, { olderThan: null, types: BOOT_RECOVERY_TASK_TYPES }),
    ).resolves.toMatchObject({ tasks: 0 });
    spy.mockRestore();
  });
});

describe("the task row and the batch row move in ONE transaction", () => {
  it("both updates run inside prisma.$transaction when the client has one, and roll together", async () => {
    taskFindMany.mockResolvedValue([{ id: "t-with", shop: "a.myshopify.com" }]);
    batchFindMany.mockResolvedValue([{ taskId: "t-with", batchIds: ["msgbatch_1"] }]);
    const inTx: string[] = [];
    const txClient = {
      task: { updateMany: async (a: any) => (inTx.push("task"), taskUpdateMany(a)) },
      bulkTranslateBatch: { updateMany: async (a: any) => (inTx.push("batch"), batchUpdateMany(a)) },
    };
    const transaction = vi.fn(async (fn: (tx: any) => Promise<unknown>) => fn(txClient));
    const withTx = { ...prisma, $transaction: transaction };

    const res = await recoverSubmittingBatchTasks(withTx, {});

    expect(res.resumed).toBe(1);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(inTx).toEqual(["task", "batch"]);
  });

  it("a failure of the second update surfaces (the transaction would roll the first back) instead of being half applied", async () => {
    taskFindMany.mockResolvedValue([{ id: "t-without", shop: "a.myshopify.com" }]);
    batchFindMany.mockResolvedValue([]);
    batchUpdateMany.mockRejectedValue(new Error("db down"));
    const transaction = vi.fn(async (fn: (tx: any) => Promise<unknown>) => fn(prisma));
    await expect(recoverSubmittingBatchTasks({ ...prisma, $transaction: transaction }, {})).rejects.toThrow("db down");
    expect(transaction).toHaveBeenCalledTimes(1);
  });
});

