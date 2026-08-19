/**
 * The orphan rule (orphan-run-recovery.js): a detached run whose process is
 * gone must be closed on BOTH rows it owns.
 *
 * The bug these cover: a Railway redeploy of a new app version kills the web
 * process mid-crawl. The `seoCrawl` Task row and the `SeoCrawlSnapshot` row
 * both stay "running", so single-flight refuses every new crawl, the crawl page
 * shows a scan that never finishes, and the empty snapshot hides the last
 * complete report. The 45-minute stuck-task threshold was the only way out, and
 * it never touched the snapshot at all.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  failOrphanedRuns,
  reconcileOrphanCrawlSnapshots,
  recoverOrphanedRuns,
  HEARTBEAT_TASK_TYPES,
  HEARTBEAT_STALL_MS,
  INTERRUPTED_TASK_ERROR,
  INTERRUPTED_SNAPSHOT_ERROR,
} from "../../orphan-run-recovery.js";

const taskFindMany = vi.fn<(args: any) => Promise<any[]>>();
const taskUpdateMany = vi.fn<(args: any) => Promise<any>>();
const snapshotFindMany = vi.fn<(args: any) => Promise<any[]>>();
const snapshotUpdateMany = vi.fn<(args: any) => Promise<any>>();

const prisma: any = {
  task: { findMany: (a: any) => taskFindMany(a), updateMany: (a: any) => taskUpdateMany(a) },
  seoCrawlSnapshot: {
    findMany: (a: any) => snapshotFindMany(a),
    updateMany: (a: any) => snapshotUpdateMany(a),
  },
};

beforeEach(() => {
  taskFindMany.mockReset();
  taskUpdateMany.mockReset();
  snapshotFindMany.mockReset();
  snapshotUpdateMany.mockReset();
  taskFindMany.mockResolvedValue([]);
  snapshotFindMany.mockResolvedValue([]);
  taskUpdateMany.mockResolvedValue({ count: 0 });
  snapshotUpdateMany.mockResolvedValue({ count: 0 });
});

describe("failOrphanedRuns", () => {
  it("fails heartbeat-type runs with the interrupted code, guarding on a still-non-terminal status", async () => {
    taskFindMany.mockResolvedValue([{ id: "t1", shop: "a.myshopify.com", type: "seoCrawl" }]);
    taskUpdateMany.mockResolvedValue({ count: 1 });

    const res = await failOrphanedRuns(prisma, { olderThan: null });

    expect(res).toEqual({ count: 1, shops: ["a.myshopify.com"] });
    const select = taskFindMany.mock.calls[0][0].where;
    expect(select.type).toEqual({ in: HEARTBEAT_TASK_TYPES });
    // pending/queued belong to the queue and are RESET, never failed here.
    expect(select.status).toBe("running");
    // No age filter: at boot the runner cannot be alive.
    expect(select.updatedAt).toBeUndefined();

    const update = taskUpdateMany.mock.calls[0][0];
    expect(update.where.status).toEqual({ in: ["running", "pending", "queued"] });
    expect(update.data.status).toBe("failed");
    expect(update.data.error).toBe(INTERRUPTED_TASK_ERROR);
    expect(update.data.completedAt).toBeInstanceOf(Date);
  });

  it("filters by heartbeat silence when an age is given (the periodic reaper)", async () => {
    const cutoff = new Date(Date.now() - HEARTBEAT_STALL_MS);
    await failOrphanedRuns(prisma, { olderThan: cutoff });
    expect(taskFindMany.mock.calls[0][0].where.updatedAt).toEqual({ lt: cutoff });
  });

  it("scopes to the given shops — an unscoped sweep from a request would fail another merchant's live crawl", async () => {
    await failOrphanedRuns(prisma, { olderThan: null, shops: ["a.myshopify.com"] });
    expect(taskFindMany.mock.calls[0][0].where.shop).toEqual({ in: ["a.myshopify.com"] });
  });

  it("treats an EMPTY shop list as no shops, never as every shop", async () => {
    // A caller that computed its scope and came up empty must sweep nothing:
    // reading `[]` as unscoped is how a multi-tenant guard fails open.
    const res = await failOrphanedRuns(prisma, { olderThan: null, shops: [] });
    expect(res).toEqual({ count: 0, shops: [] });
    expect(taskFindMany).not.toHaveBeenCalled();
    await expect(reconcileOrphanCrawlSnapshots(prisma, [])).resolves.toBe(0);
    expect(snapshotFindMany).not.toHaveBeenCalled();
    await recoverOrphanedRuns(prisma, { olderThan: null, shops: [] });
    expect(taskFindMany).not.toHaveBeenCalled();
    expect(snapshotFindMany).not.toHaveBeenCalled();
  });

  it("writes nothing when there is no orphan", async () => {
    const res = await failOrphanedRuns(prisma, { olderThan: null });
    expect(res).toEqual({ count: 0, shops: [] });
    expect(taskUpdateMany).not.toHaveBeenCalled();
  });
});

describe("reconcileOrphanCrawlSnapshots", () => {
  it("closes an open snapshot whose shop has no running crawl task", async () => {
    snapshotFindMany.mockResolvedValue([{ id: "s1", shop: "a.myshopify.com" }]);
    taskFindMany.mockResolvedValue([]);
    snapshotUpdateMany.mockResolvedValue({ count: 1 });

    await expect(reconcileOrphanCrawlSnapshots(prisma)).resolves.toBe(1);

    const update = snapshotUpdateMany.mock.calls[0][0];
    expect(update.where).toEqual({ id: { in: ["s1"] }, status: "running" });
    expect(update.data.status).toBe("failed");
    expect(update.data.error).toBe(INTERRUPTED_SNAPSHOT_ERROR);
    expect(update.data.finishedAt).toBeInstanceOf(Date);
  });

  it("leaves the snapshot of a LIVE crawl alone", async () => {
    snapshotFindMany.mockResolvedValue([
      { id: "live", shop: "a.myshopify.com" },
      { id: "orphan", shop: "b.myshopify.com" },
    ]);
    taskFindMany.mockResolvedValue([{ shop: "a.myshopify.com" }]);
    snapshotUpdateMany.mockResolvedValue({ count: 1 });

    await reconcileOrphanCrawlSnapshots(prisma);

    expect(snapshotUpdateMany.mock.calls[0][0].where.id).toEqual({ in: ["orphan"] });
  });

  it("does not touch the table when every open snapshot has its crawl", async () => {
    snapshotFindMany.mockResolvedValue([{ id: "live", shop: "a.myshopify.com" }]);
    taskFindMany.mockResolvedValue([{ shop: "a.myshopify.com" }]);
    await expect(reconcileOrphanCrawlSnapshots(prisma)).resolves.toBe(0);
    expect(snapshotUpdateMany).not.toHaveBeenCalled();
  });
});

describe("recoverOrphanedRuns", () => {
  it("fails the task BEFORE reading snapshots — the snapshot rule asks whether a crawl is running", async () => {
    const order: string[] = [];
    taskFindMany.mockImplementation(async (args: any) => {
      order.push(args.select?.id ? "selectTasks" : "liveTaskLookup");
      return [];
    });
    snapshotFindMany.mockImplementation(async () => {
      order.push("selectSnapshots");
      return [];
    });

    await recoverOrphanedRuns(prisma, { olderThan: null });

    expect(order).toEqual(["selectTasks", "selectSnapshots"]);
  });

  it("sweeps snapshots shop-wide when scoped, and table-wide at boot", async () => {
    snapshotFindMany.mockResolvedValue([]);
    await recoverOrphanedRuns(prisma, { olderThan: null, shops: ["a.myshopify.com"] });
    expect(snapshotFindMany.mock.calls[0][0].where.shop).toEqual({ in: ["a.myshopify.com"] });

    snapshotFindMany.mockClear();
    await recoverOrphanedRuns(prisma, { olderThan: null });
    // Unscoped on purpose: a snapshot can outlive a task the 45-minute reaper
    // already failed without ever closing the snapshot.
    expect(snapshotFindMany.mock.calls[0][0].where.shop).toBeUndefined();
  });
});
