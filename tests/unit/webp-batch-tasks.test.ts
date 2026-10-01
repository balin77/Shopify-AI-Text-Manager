/**
 * A WebP conversion run is ONE merchant-facing task over N work items.
 *
 * `api.convert-webp` used to create one `imageWebpConversion` row PER IMAGE, so
 * a 20-image upload filled a page of the Tasks list and fired 20 completion
 * notifications for one merchant action. The row per image could not simply be
 * collapsed — three consumers treat it as the unit of work (the boot recovery
 * reads its `progress` as a per-image step boundary, the reaper refunds exactly
 * one image operation per row, the image manager derives its per-image spinner
 * from the set of running rows) — so the item was renamed to
 * `imageWebpConversionItem` and an aggregate row was added above it.
 *
 * What is pinned here is everything that can silently undo that:
 *
 *  1. Telling an aggregate row from a WORK ITEM, including the pre-split rows
 *     an older build wrote under the aggregate's own type. Reading an aggregate
 *     as work would run it as an image, fail it on "Missing sourceUrl" and
 *     refund an operation nobody spent; reading a legacy row as an aggregate
 *     would strand a merchant's half-finished conversion.
 *  2. The refund arithmetic — one per image, never one per run and never one
 *     per run PLUS one per image.
 *  3. The aggregate's terminal status: a run where every image failed is
 *     `failed`, not a green "completed with errors".
 */

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import {
  WEBP_ITEM_TASK_TYPE,
  WEBP_PARENT_TASK_TYPE,
  isWebpParentRow,
  isWebpWorkRow,
  webpBatchStatus,
  webpParentTaskId,
  webpWorkRowWhere,
} from "../../app/config/webp-tasks.js";

const jobInput = (parentTaskId?: string) =>
  JSON.stringify({
    sourceUrl: "https://cdn.shopify.com/s/files/1/0001/kumiko.jpg",
    mediaId: "gid://shopify/MediaImage/1",
    productImageId: "img_1",
    productId: "gid://shopify/Product/9",
    altText: null,
    position: 0,
    ...(parentTaskId ? { parentTaskId } : {}),
  });

describe("telling a work item from the aggregate row", () => {
  it("an item row is work whatever else it carries", () => {
    expect(isWebpWorkRow({ type: WEBP_ITEM_TASK_TYPE })).toBe(true);
    expect(isWebpWorkRow({ type: WEBP_ITEM_TASK_TYPE, result: jobInput("p1") })).toBe(true);
    expect(isWebpParentRow({ type: WEBP_ITEM_TASK_TYPE })).toBe(false);
  });

  it("an aggregate row is recognised by its `total`, which no webp row ever had before", () => {
    const parent = { type: WEBP_PARENT_TASK_TYPE, total: 20, result: JSON.stringify({ total: 20 }) };
    expect(isWebpWorkRow(parent)).toBe(false);
    expect(isWebpParentRow(parent)).toBe(true);
  });

  it("a LEGACY pre-split row is still work — by its column and by its blob", () => {
    // The row a merchant has in flight across the deploy: the aggregate's type,
    // no total, the job input in `result`. Both signals must agree, because the
    // two consumers that ask do not select the same columns.
    expect(isWebpWorkRow({ type: WEBP_PARENT_TASK_TYPE, total: null })).toBe(true);
    expect(isWebpWorkRow({ type: WEBP_PARENT_TASK_TYPE, result: jobInput() })).toBe(true);
    expect(isWebpParentRow({ type: WEBP_PARENT_TASK_TYPE, result: jobInput() })).toBe(false);
  });

  it("a row that selected neither column nor blob is read as legacy work, never as an aggregate", () => {
    // The conservative direction: an aggregate run as work fails one image and
    // refunds it; a legacy item read as an aggregate is a conversion that stops
    // dead with the merchant's original already deleted from Shopify.
    expect(isWebpWorkRow({ type: WEBP_PARENT_TASK_TYPE })).toBe(true);
  });

  it("the aggregate's own result is not mistaken for a job spec", () => {
    const finished = {
      type: WEBP_PARENT_TASK_TYPE,
      result: JSON.stringify({ total: 2, converted: 1, failed: 1, failures: [] }),
    };
    expect(isWebpWorkRow(finished)).toBe(false);
  });

  it("nothing else in the task table is a webp row", () => {
    for (const type of ["seoCrawl", "translation", "pageSpeed", "", null, undefined]) {
      expect(isWebpWorkRow({ type })).toBe(false);
      expect(isWebpParentRow({ type })).toBe(false);
    }
    expect(isWebpWorkRow(null)).toBe(false);
    expect(isWebpWorkRow(undefined)).toBe(false);
  });

  it("an unparseable result on the aggregate type reads as work, not as a finished batch", () => {
    // `ai-queue.service.ts` truncates a recovered result to 500 characters, and
    // a half-written blob must not turn an unfinished image into a run that
    // reports itself done.
    expect(isWebpWorkRow({ type: WEBP_PARENT_TASK_TYPE, result: '{"sourceUrl":"https://…' })).toBe(
      true,
    );
  });
});

describe("the SQL selector", () => {
  it("matches item rows and legacy rows, and no aggregate", () => {
    expect(webpWorkRowWhere({ status: "running" })).toEqual({
      status: "running",
      OR: [{ type: WEBP_ITEM_TASK_TYPE }, { type: WEBP_PARENT_TASK_TYPE, total: null }],
    });
  });

  it("every row it claims to select really is a work row", () => {
    const rows = [
      { type: WEBP_ITEM_TASK_TYPE, total: null },
      { type: WEBP_PARENT_TASK_TYPE, total: null },
    ];
    for (const row of rows) expect(isWebpWorkRow(row)).toBe(true);
    expect(isWebpWorkRow({ type: WEBP_PARENT_TASK_TYPE, total: 3 })).toBe(false);
  });
});

describe("the parent id a work item carries", () => {
  it("is read out of the job blob, and survives the completion write", () => {
    expect(webpParentTaskId(jobInput("ckparent"))).toBe("ckparent");
    // Step 10 of the processor spreads the job data and adds `webpUrl`.
    const completed = JSON.stringify({
      ...JSON.parse(jobInput("ckparent")),
      webpUrl: "https://cdn.shopify.com/s/files/1/0001/kumiko.webp",
    });
    expect(webpParentTaskId(completed)).toBe("ckparent");
  });

  it("is null for a legacy row, a malformed blob and a non-string", () => {
    expect(webpParentTaskId(jobInput())).toBeNull();
    expect(webpParentTaskId("{oops")).toBeNull();
    expect(webpParentTaskId(null)).toBeNull();
    expect(webpParentTaskId(JSON.stringify({ parentTaskId: 7 }))).toBeNull();
  });
});

describe("the terminal status of a run", () => {
  it("is completed only when nothing failed", () => {
    expect(webpBatchStatus(3, 0)).toBe("completed");
  });

  it("is partial when some images landed", () => {
    expect(webpBatchStatus(2, 1)).toBe("completed_with_errors");
  });

  it("is failed when none did", () => {
    // Twenty images all still PNG is not a run that "completed with errors".
    expect(webpBatchStatus(0, 20)).toBe("failed");
  });
});

// ── the processor's settlement ──────────────────────────────────────────────

const taskFindUnique = vi.fn<(args: any) => Promise<any>>();
const taskFindMany = vi.fn<(args: any) => Promise<any[]>>();
const taskUpdateMany = vi.fn<(args: any) => Promise<any>>();
const taskUpdate = vi.fn<(args: any) => Promise<any>>();

// Every image operation given back goes through ONE statement in
// image-op-refund.js (`UPDATE … GREATEST("count" - ${n}, 0) … ${shop} … ${period}`),
// so the tagged-template values ARE the refund ledger — no module mock needed,
// and a refund paid through any other path would simply not be counted here.
const refunds: Array<{ n: number; shop: string }> = [];

const prisma: any = {
  task: {
    findUnique: (a: any) => taskFindUnique(a),
    findMany: (a: any) => taskFindMany(a),
    updateMany: (a: any) => taskUpdateMany(a),
    update: (a: any) => taskUpdate(a),
  },
  $executeRaw: (_sql: TemplateStringsArray, ...values: any[]) => {
    refunds.push({ n: values[0], shop: values[1] });
    return Promise.resolve(1);
  },
};

// The service reads the shared client off `globalThis` at import time, so this
// has to be in place before the dynamic import below.
(globalThis as any).__db = prisma;
const { WebPProcessorService } = await import("../../webp-processor.service.js");
const { TaskRecoveryService } = await import("../../task-recovery.service.js");
// `static instance = null` makes TS infer the singleton as possibly null.
const processor: any = WebPProcessorService.getInstance();
const recovery: any = TaskRecoveryService.getInstance();

/**
 * A task table that HONOURS the status guards, because the guards are what is
 * on trial: `updateMany({ where: { id, status: { in: … } } })` writing to
 * nobody is the whole mechanism by which the first terminal verdict on a row
 * keeps it. A mock that always answers `{ count: 1 }` cannot fail these tests.
 */
type Row = Record<string, any>;
let store: Row[] = [];

const matches = (row: Row, where: any): boolean => {
  for (const [key, cond] of Object.entries(where ?? {})) {
    if (key === "OR") {
      if (!(cond as any[]).some((c) => matches(row, c))) return false;
      continue;
    }
    if (key === "NOT") {
      if (matches(row, cond)) return false;
      continue;
    }
    const value = row[key];
    if (cond !== null && typeof cond === "object" && !(cond instanceof Date)) {
      const c = cond as any;
      if ("in" in c && !c.in.includes(value)) return false;
      if ("notIn" in c && c.notIn.includes(value)) return false;
      if ("not" in c && (c.not === null ? value == null : value === c.not)) return false;
      if ("lt" in c && !(new Date(value).getTime() < new Date(c.lt).getTime())) return false;
      if ("gte" in c && !(new Date(value).getTime() >= new Date(c.gte).getTime())) return false;
      if ("contains" in c && !String(value ?? "").includes(c.contains)) return false;
      continue;
    }
    if (cond === null ? value != null : value !== cond) return false;
  }
  return true;
};

/** Point the mocks at a real table. Returns it, so a test can read the rows back. */
const useTable = (rows: Row[]): Row[] => {
  store = rows.map((r) => ({ ...r }));
  taskFindUnique.mockImplementation(async ({ where }: any) => {
    const hit = store.find((r) => matches(r, where));
    return hit ? { ...hit } : null;
  });
  taskFindMany.mockImplementation(async ({ where, take }: any) => {
    const hits = store.filter((r) => matches(r, where)).map((r) => ({ ...r }));
    return take ? hits.slice(0, take) : hits;
  });
  taskUpdateMany.mockImplementation(async ({ where, data }: any) => {
    const hits = store.filter((r) => matches(r, where));
    for (const row of hits) Object.assign(row, data);
    return { count: hits.length };
  });
  taskUpdate.mockImplementation(async ({ where, data }: any) => {
    const hit = store.find((r) => matches(r, where));
    if (hit) Object.assign(hit, data);
    return hit ?? null;
  });
  return store;
};

const row = (id: string) => store.find((r) => r.id === id)!;

/**
 * What step 10 really writes: the job blob it was given, plus the URL. The
 * `parentTaskId` in it is how the batch finds its items at all, which is why
 * the completion write spreads the job data instead of replacing it.
 */
const convertedResult = () => ({
  ...JSON.parse(jobInput("p1")),
  webpUrl: "https://cdn.shopify.com/s/files/1/0001/kumiko.webp",
});

const workItem = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  shop: "kumiko.myshopify.com",
  type: WEBP_ITEM_TASK_TYPE,
  status: "running",
  progress: 30,
  total: null,
  result: jobInput("p1"),
  error: null,
  updatedAt: new Date(Date.now() - 60 * 60_000),
  ...over,
});

const item = (status: string, over: Record<string, unknown> = {}) => ({
  id: `i${Math.random()}`,
  status,
  result: jobInput("p1"),
  error: null,
  ...over,
});

const parentRow = (over: Record<string, unknown> = {}) => ({
  id: "p1",
  status: "running",
  total: 3,
  createdAt: new Date(Date.now() - 60_000),
  ...over,
});

const lastUpdate = () => taskUpdateMany.mock.calls.at(-1)?.[0];

beforeEach(() => {
  taskFindUnique.mockReset();
  taskFindMany.mockReset();
  taskUpdateMany.mockReset();
  taskUpdate.mockReset();
  taskUpdateMany.mockResolvedValue({ count: 1 });
  store = [];
  refunds.length = 0;
});

describe("settleParent", () => {
  it("reports progress and leaves the run open while an item is still working", async () => {
    taskFindUnique.mockResolvedValue(parentRow());
    taskFindMany.mockResolvedValue([item("completed"), item("failed"), item("running")]);

    await processor.settleParent("p1");

    const update = lastUpdate();
    expect(update.data.status).toBeUndefined();
    expect(update.data.processed).toBe(2);
    // Percent of the batch — NOT the per-image step boundary the boot recovery
    // reads, which is why that recovery never looks at an aggregate row.
    expect(update.data.progress).toBe(67);
    expect(JSON.parse(update.data.result)).toMatchObject({ total: 3, converted: 1, failed: 1 });
  });

  it("closes the run when the last item lands, with the per-image failures", async () => {
    taskFindUnique.mockResolvedValue(parentRow());
    taskFindMany.mockResolvedValue([
      item("completed"),
      item("completed"),
      item("failed", { error: "Failed to download image: 404", result: jobInput("p1") }),
    ]);

    await processor.settleParent("p1");

    const update = lastUpdate();
    expect(update.data.status).toBe("completed_with_errors");
    expect(update.data.progress).toBe(100);
    // A machine code — this runs outside any request and has no merchant
    // locale; app/utils/task-error-text.ts translates it at render time.
    expect(update.data.error).toBe("images_failed:1:3");
    const result = JSON.parse(update.data.result);
    expect(result).toMatchObject({ total: 3, converted: 2, failed: 1 });
    expect(result.failures[0].message).toBe("Failed to download image: 404");
    expect(result.failures[0].position).toBe(0);
  });

  it("clears the error and reports completed when every image landed", async () => {
    taskFindUnique.mockResolvedValue(parentRow({ total: 2 }));
    taskFindMany.mockResolvedValue([item("completed"), item("completed")]);

    await processor.settleParent("p1");

    expect(lastUpdate().data.status).toBe("completed");
    expect(lastUpdate().data.error).toBeNull();
  });

  it("never resurrects a run somebody already closed", async () => {
    // The reaper may have failed it, or the merchant cancelled it. Every write
    // is guarded on a still-open status — the monotonic-finalizer shape the
    // R4-DI9 note asks for wherever a reaper's decision has to hold.
    taskFindUnique.mockResolvedValue(parentRow());
    taskFindMany.mockResolvedValue([item("completed"), item("completed"), item("completed")]);

    await processor.settleParent("p1");

    expect(lastUpdate().where).toEqual({
      id: "p1",
      status: { in: ["pending", "queued", "running"] },
    });
  });

  it("does not even look at the items of a run that is already terminal", async () => {
    taskFindUnique.mockResolvedValue(parentRow({ status: "failed" }));

    await processor.settleParent("p1");

    expect(taskFindMany).not.toHaveBeenCalled();
    expect(taskUpdateMany).not.toHaveBeenCalled();
  });

  it("ignores a row that merely mentions the id but names another parent", async () => {
    // `result: { contains: id }` is a prefilter; the blob decides.
    taskFindUnique.mockResolvedValue(parentRow({ total: 1 }));
    taskFindMany.mockResolvedValue([
      item("completed"),
      item("running", { result: jobInput("p1-suffix") }),
    ]);

    await processor.settleParent("p1");

    expect(lastUpdate().data.status).toBe("completed");
  });

  it("keeps a freshly created run alive while its items are still being written", async () => {
    taskFindUnique.mockResolvedValue(parentRow({ createdAt: new Date() }));
    taskFindMany.mockResolvedValue([]);

    await processor.settleParent("p1");

    // A heartbeat, not a verdict: the route creates the aggregate row first and
    // its items milliseconds later.
    expect(lastUpdate().data).toEqual({ updatedAt: expect.any(Date) });
  });

  it("fails an old run that never got a single item", async () => {
    taskFindUnique.mockResolvedValue(parentRow({ createdAt: new Date(Date.now() - 10 * 60_000) }));
    taskFindMany.mockResolvedValue([]);

    await processor.settleParent("p1");

    expect(lastUpdate().data.status).toBe("failed");
    expect(lastUpdate().data.error).toBe("webp_batch_not_started");
  });

  it("does nothing at all without an id, or for a run that no longer exists", async () => {
    await processor.settleParent(null);
    expect(taskFindUnique).not.toHaveBeenCalled();

    taskFindUnique.mockResolvedValue(null);
    await processor.settleParent("gone");
    expect(taskUpdateMany).not.toHaveBeenCalled();
  });
});

describe("settleOpenParents", () => {
  it("looks only at aggregate rows that are still open, and survives one that throws", async () => {
    taskFindMany.mockResolvedValueOnce([{ id: "p1" }, { id: "p2" }]);
    taskFindUnique.mockRejectedValueOnce(new Error("db blinked"));
    taskFindUnique.mockResolvedValueOnce(parentRow({ id: "p2", total: 1 }));
    taskFindMany.mockResolvedValueOnce([item("completed", { result: jobInput("p2") })]);

    await processor.settleOpenParents();

    expect(taskFindMany.mock.calls[0][0].where).toEqual({
      type: WEBP_PARENT_TASK_TYPE,
      total: { not: null },
      status: { in: ["pending", "queued", "running"] },
    });
    // The second batch is still settled after the first one blew up.
    expect(lastUpdate().where.id).toBe("p2");
    expect(lastUpdate().data.status).toBe("completed");
  });
});

// ── one writer per verdict ──────────────────────────────────────────────────
//
// A work item's terminal status is also its refund — an image operation is owed
// back for exactly those items recorded `failed` — and it is what the batch
// above settles on, once, irreversibly. Two writers on that row is therefore
// not a cosmetic race: the 4-minute timeout used to fail the item and refund
// it, its background steps then wrote `completed` over the top, and if that was
// the last open item the batch had already closed as failed and is guarded
// against being recounted. The merchant was told images failed that in fact
// converted, and was given a month's quota back for them.

describe("failing one work item", () => {
  it("refunds exactly once, and only for the call that really closed the row", async () => {
    const table = useTable([workItem("i1")]);

    await processor.failTask({ id: "i1", shop: "kumiko.myshopify.com" }, "Failed to download image: 404");
    expect(table[0].status).toBe("failed");
    expect(refunds).toEqual([{ n: 1, shop: "kumiko.myshopify.com" }]);

    // The sweep, a retry, a second exit path — the row is already closed, so
    // there is nothing to pay for a second time.
    await processor.failTask({ id: "i1", shop: "kumiko.myshopify.com" }, "again");
    expect(refunds).toHaveLength(1);
  });

  it("never turns a finished conversion, or a cancelled one, into a failure", async () => {
    const table = useTable([workItem("i1", { status: "completed" }), workItem("i2", { status: "cancelled" })]);

    await processor.failTask({ id: "i1", shop: "kumiko.myshopify.com" }, "late verdict");
    await processor.failTask({ id: "i2", shop: "kumiko.myshopify.com" }, "late verdict");

    expect(table.map((r) => r.status)).toEqual(["completed", "cancelled"]);
    // A refund for either would be a merchant paid back for an image that
    // converted, or for a run they stopped themselves and were never charged
    // twice for.
    expect(refunds).toEqual([]);
  });

  it("pays the refund when the statement that THREW is the one that closed the row", async () => {
    // A reset connection after the commit looks exactly like a write that
    // never happened. The row is terminal now, so the reaper's non-terminal
    // selector never revisits it and nobody else would ever pay this refund.
    const table = useTable([workItem("i1")]);
    const guarded = taskUpdateMany.getMockImplementation()!;
    taskUpdateMany.mockImplementationOnce(async (args: any) => {
      await guarded(args);
      throw new Error("connection reset after commit");
    });
    taskUpdateMany.mockImplementation(guarded);

    await processor.failTask({ id: "i1", shop: "kumiko.myshopify.com" }, "Failed to download image: 404");

    expect(table[0].status).toBe("failed");
    expect(refunds).toEqual([{ n: 1, shop: "kumiko.myshopify.com" }]);
  });

  it("pays nothing when the row was closed by somebody else's verdict", async () => {
    const table = useTable([workItem("i1")]);
    const guarded = taskUpdateMany.getMockImplementation()!;
    taskUpdateMany.mockImplementationOnce(async () => {
      // Our statement never lands; the reaper's did, moments earlier.
      table[0].status = "failed";
      table[0].error = "task_timed_out";
      throw new Error("db blinked");
    });
    taskUpdateMany.mockImplementation(guarded);

    await processor.failTask({ id: "i1", shop: "kumiko.myshopify.com" }, "Failed to download image: 404");

    // The reaper already refunded that image; a second one is money.
    expect(table[0].error).toBe("task_timed_out");
    expect(refunds).toEqual([]);
  });

  it("retries the guarded write rather than falling back to an unguarded one", async () => {
    const table = useTable([workItem("i1", { status: "completed" })]);
    const guarded = taskUpdateMany.getMockImplementation()!;
    taskUpdateMany.mockImplementationOnce(async () => {
      throw new Error("db blinked");
    });
    taskUpdateMany.mockImplementation(guarded);

    await processor.failTask({ id: "i1", shop: "kumiko.myshopify.com" }, "boom");

    // The old fallback wrote `failed` with no status precondition at all, so a
    // single transient DB error was enough to bury a completed conversion.
    expect(table[0].status).toBe("completed");
    expect(refunds).toEqual([]);
  });
});

describe("closing one work item as converted", () => {
  it("closes an open row and says that it did", async () => {
    const table = useTable([workItem("i1")]);

    await expect(processor.completeWorkItem("i1", convertedResult())).resolves.toBe(true);
    expect(table[0].status).toBe("completed");
    expect(table[0].progress).toBe(100);
  });

  it("leaves a verdict somebody already wrote standing, and reports the loss", async () => {
    const table = useTable([workItem("i1", { status: "failed", error: "task_timed_out" })]);

    await expect(processor.completeWorkItem("i1", convertedResult())).resolves.toBe(false);
    expect(table[0].status).toBe("failed");
    expect(table[0].error).toBe("task_timed_out");
  });
});

describe("the processor giving up on WAITING for an item", () => {
  const runSteps = "_runWebpSteps";
  let original: any;

  beforeEach(() => {
    original = processor[runSteps];
    vi.useFakeTimers();
  });

  afterEach(() => {
    processor[runSteps] = original;
    vi.useRealTimers();
  });

  it("writes no verdict and pays no refund — the steps that own the row are still running", async () => {
    const table = useTable([workItem("i1")]);
    processor[runSteps] = vi.fn(() => new Promise(() => {}));

    const inFlight = processor._processTaskItem({ id: "i1", shop: "kumiko.myshopify.com", result: jobInput("p1") });
    await vi.advanceTimersByTimeAsync(4 * 60 * 1000 + 10);
    await inFlight;

    // `running` is the TRUE statement: the conversion is in flight, the image
    // manager's spinner is right to keep spinning, and if the process dies here
    // the boot recovery still sees the progress it needs to classify the row.
    expect(table[0].status).toBe("running");
    expect(table[0].progress).toBe(30);
    expect(refunds).toEqual([]);
  });

  it("still fails the row for anything that is a real verdict", async () => {
    const table = useTable([workItem("i1")]);
    processor[runSteps] = vi.fn(async () => {
      throw new Error("sharp exploded");
    });

    await processor._processTaskItem({ id: "i1", shop: "kumiko.myshopify.com", result: jobInput("p1") });

    expect(table[0].status).toBe("failed");
    expect(refunds).toEqual([{ n: 1, shop: "kumiko.myshopify.com" }]);
  });
});

describe("the timeout and the item's own steps, in both orders", () => {
  const batch = (itemStatus: string) => [
    {
      id: "p1",
      shop: "kumiko.myshopify.com",
      type: WEBP_PARENT_TASK_TYPE,
      status: "running",
      total: 1,
      processed: 0,
      progress: 0,
      resourceId: "gid://shopify/Product/9",
      createdAt: new Date(Date.now() - 60_000),
      result: JSON.stringify({ total: 1 }),
      error: null,
    },
    workItem("i1", {
      status: itemStatus,
      resourceId: "gid://shopify/Product/9",
      createdAt: new Date(Date.now() - 59_000),
    }),
  ];

  it("timeout first: the item is left open, so the batch stays open and lands on the truth", async () => {
    const table = useTable(batch("running"));
    vi.useFakeTimers();
    const original = processor._runWebpSteps;
    processor._runWebpSteps = vi.fn(() => new Promise(() => {}));
    try {
      // processTask settles the parent on EVERY exit, including this one.
      const inFlight = processor.processTask({
        id: "i1",
        shop: "kumiko.myshopify.com",
        result: jobInput("p1"),
      });
      await vi.advanceTimersByTimeAsync(4 * 60 * 1000 + 10);
      await inFlight;
    } finally {
      processor._runWebpSteps = original;
      vi.useRealTimers();
    }

    // The batch is NOT settled — one image is still open, which is the fact
    // that used to be thrown away here and could never be recovered.
    expect(table[0].status).toBe("running");
    expect(table[0].completedAt).toBeUndefined();

    // The steps land minutes later and close the item themselves…
    await processor.completeWorkItem("i1", convertedResult());
    expect(row("i1").status).toBe("completed");

    // …and the poll's backstop closes the batch on what really happened.
    await processor.settleOpenParents();
    expect(row("p1").status).toBe("completed");
    expect(JSON.parse(row("p1").result)).toMatchObject({ total: 1, converted: 1, failed: 0 });
    expect(row("p1").error).toBeNull();

    // One image, one conversion, nothing owed back.
    expect(refunds).toEqual([]);
  });

  it("completion first: a late timeout cannot reopen the question or pay for it", async () => {
    const table = useTable(batch("running"));

    await processor.completeWorkItem("i1", convertedResult());
    // Whatever arrives afterwards — the old timeout's failTask, a duplicate
    // exit path, the reaper one tick too late — finds a closed row.
    await processor.failTask({ id: "i1", shop: "kumiko.myshopify.com" }, "WebP task timed out");

    expect(row("i1").status).toBe("completed");
    expect(refunds).toEqual([]);

    await processor.settleOpenParents();
    expect(table[0].status).toBe("completed");
    expect(JSON.parse(table[0].result)).toMatchObject({ converted: 1, failed: 0 });
  });

  it("reaper first: the presumption stands, and the refund matches what the merchant is told", async () => {
    useTable(batch("running"));

    // Ten minutes of silence: the reaper has no evidence the work is alive.
    await processor.failTask({ id: "i1", shop: "kumiko.myshopify.com" }, "task_timed_out");
    expect(refunds).toEqual([{ n: 1, shop: "kumiko.myshopify.com" }]);

    // The conversion turns out to have landed on Shopify after all. The row
    // keeps the verdict its refund was paid against: the remaining
    // disagreement is with Shopify, never between the row, the batch and the
    // quota — and it is NOT paid for twice.
    await expect(processor.completeWorkItem("i1", convertedResult())).resolves.toBe(false);
    expect(row("i1").status).toBe("failed");
    expect(refunds).toHaveLength(1);

    await processor.settleOpenParents();
    expect(row("p1").status).toBe("failed");
    expect(row("p1").error).toBe("images_failed:1:1");
  });
});

describe("the stuck-task reaper's refund arithmetic", () => {
  const stale = (id: string, over: Record<string, unknown> = {}) =>
    workItem(id, { updatedAt: new Date(Date.now() - 60 * 60_000), ...over });

  it("pays one refund per image it really failed", async () => {
    const table = useTable([stale("i1"), stale("i2")]);

    await recovery.markStuckTasksAsFailed();

    expect(table.map((r) => r.status)).toEqual(["failed", "failed"]);
    expect(refunds).toEqual([{ n: 2, shop: "kumiko.myshopify.com" }]);
  });

  it("pays nothing for an image that converted between the SELECT and the UPDATE", async () => {
    const table = useTable([stale("i1"), stale("i2")]);
    const read = taskFindMany.getMockImplementation()!;
    taskFindMany.mockImplementation(async (args: any) => {
      const rows = await read(args);
      // The window the guard exists for: i2's steps land while the reaper is
      // between its two statements. Counting the READ instead of the WRITE
      // would hand back quota for an image that is now WebP on Shopify.
      const late = store.find((r) => r.id === "i2");
      if (late && rows.some((r: any) => r.id === "i2")) late.status = "completed";
      return rows;
    });

    await recovery.markStuckTasksAsFailed();

    expect(table.map((r) => r.status)).toEqual(["failed", "completed"]);
    expect(refunds).toEqual([{ n: 1, shop: "kumiko.myshopify.com" }]);
  });

  it("refunds per shop, and nothing at all for a row that is not an image", async () => {
    const table = useTable([
      stale("i1"),
      stale("i2", { shop: "other.myshopify.com" }),
      stale("t1", { type: "translation", result: null }),
    ]);

    await recovery.markStuckTasksAsFailed();

    expect(table.map((r) => r.status)).toEqual(["failed", "failed", "failed"]);
    // The translation row spent no image operation, and the two conversions
    // belong to two different counters.
    expect(refunds).toEqual([
      { n: 1, shop: "kumiko.myshopify.com" },
      { n: 1, shop: "other.myshopify.com" },
    ]);
  });
});

describe("failTask needs the whole row", () => {
  it("refuses an id on its own rather than closing a row it cannot refund", async () => {
    const table = useTable([workItem("i1")]);

    // The shop is what the refund is paid to. Closing the row without it would
    // record a failure and pay nothing — the one direction the arithmetic may
    // not err in — so this writes nothing at all and says so.
    await processor.failTask("i1", "boom");
    await processor.failTask({ id: "i1" }, "boom");

    expect(table[0].status).toBe("running");
    expect(refunds).toEqual([]);
  });
});
