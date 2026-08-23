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

import { describe, it, expect, beforeEach, vi } from "vitest";
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

const prisma: any = {
  task: {
    findUnique: (a: any) => taskFindUnique(a),
    findMany: (a: any) => taskFindMany(a),
    updateMany: (a: any) => taskUpdateMany(a),
  },
};

// The service reads the shared client off `globalThis` at import time, so this
// has to be in place before the dynamic import below.
(globalThis as any).__db = prisma;
const { WebPProcessorService } = await import("../../webp-processor.service.js");
// `static instance = null` makes TS infer the singleton as possibly null.
const processor: any = WebPProcessorService.getInstance();

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
  taskUpdateMany.mockResolvedValue({ count: 1 });
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
