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
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  failOrphanedRuns,
  reconcileOrphanCrawlSnapshots,
  recoverOrphanedRuns,
  HEARTBEAT_TASK_TYPES,
  BOOT_ORPHAN_TASK_TYPES,
  BOOT_RECOVERY_TASK_TYPES,
  BOOT_SILENCE_MS,
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

describe("boot-only orphan types (bulkEditorTranslate)", () => {
  it("lists the bulk translate run for boot recovery but NOT as a heartbeat type", () => {
    expect(BOOT_ORPHAN_TASK_TYPES).toContain("bulkEditorTranslate");
    // The periodic reaper keeps its 45-minute rule for it: a bulk AI job may be
    // silent for minutes between two provider calls.
    expect(HEARTBEAT_TASK_TYPES).not.toContain("bulkEditorTranslate");
    expect(BOOT_RECOVERY_TASK_TYPES).toEqual(
      expect.arrayContaining([...HEARTBEAT_TASK_TYPES, ...BOOT_ORPHAN_TASK_TYPES]),
    );
  });

  it("boot recovery fails a running bulkEditorTranslate row of any age with the interrupted code", async () => {
    taskFindMany.mockResolvedValue([{ id: "t9", shop: "a.myshopify.com", type: "bulkEditorTranslate" }]);
    taskUpdateMany.mockResolvedValue({ count: 1 });

    const g = globalThis as any;
    const prevDb = g.__db;
    g.__db = prisma;
    try {
      const { TaskRecoveryService } = await import("../../task-recovery.service.js");
      const svc = new TaskRecoveryService();
      const res = await svc.recoverOrphanedDetachedRuns();
      expect(res.tasks).toBe(1);
    } finally {
      g.__db = prevDb;
    }

    const where = taskFindMany.mock.calls[0][0].where;
    expect(JSON.stringify(where)).toContain("bulkEditorTranslate");
    // the bulk type is failed only once silent (it heartbeats), never by age at boot
    expect(where.OR.find((c: any) => c.type.in.includes("bulkEditorTranslate")).updatedAt.lt).toBeInstanceOf(Date);
    expect(where.status).toBe("running");
    expect(taskUpdateMany.mock.calls[0][0].data.error).toBe(INTERRUPTED_TASK_ERROR);
  });

  it("boot recovery only takes rows created BEFORE this process started (a live run of this process is no orphan)", async () => {
    const g = globalThis as any;
    const prevDb = g.__db;
    g.__db = prisma;
    try {
      const { TaskRecoveryService } = await import("../../task-recovery.service.js");
      const before = Date.now();
      await new TaskRecoveryService().recoverOrphanedDetachedRuns();
      const where = taskFindMany.mock.calls[0][0].where;
      expect(where.createdAt.lt).toBeInstanceOf(Date);
      expect(where.createdAt.lt.getTime()).toBeLessThanOrEqual(before);
    } finally {
      g.__db = prevDb;
    }
  });

  it("a heartbeating boot type is failed only after it went SILENT (a deploy overlap's live run keeps beating); a crawl is failed regardless", async () => {
    const t0 = Date.now();
    await failOrphanedRuns(prisma, {
      olderThan: null,
      types: BOOT_RECOVERY_TASK_TYPES,
      silentTypes: { types: BOOT_ORPHAN_TASK_TYPES, silentMs: BOOT_SILENCE_MS },
    });
    const where = taskFindMany.mock.calls[0][0].where;
    expect(where.type).toBeUndefined();
    const crawl = where.OR.find((c: any) => c.type.in.includes("seoCrawl"));
    expect(crawl.updatedAt).toBeUndefined();
    const bulk = where.OR.find((c: any) => c.type.in.includes("bulkEditorTranslate"));
    expect(bulk.updatedAt.lt.getTime()).toBeLessThanOrEqual(t0 - BOOT_SILENCE_MS + 1000);
    expect(bulk.updatedAt.lt.getTime()).toBeGreaterThan(t0 - BOOT_SILENCE_MS - 5000);
  });
});

describe("the periodic reaper fails a stalled heartbeat run as INTERRUPTED, not as timed out", () => {
  it("pass 0 (heartbeat + boot types) writes task_interrupted; the other passes keep task_timed_out", async () => {
    const g = globalThis as any;
    const prevDb = g.__db;
    g.__db = prisma;
    taskFindMany.mockImplementation(async (args: any) => {
      const types = args.where?.type?.in ?? [];
      if (types.includes("bulkEditorTranslate") && types.includes("seoCrawl")) {
        return taskFindMany.mock.calls.filter((c) => c[0].where?.type?.in?.includes("bulkEditorTranslate")).length === 1
          ? [{ id: "t1", shop: "a.myshopify.com", type: "bulkEditorTranslate", total: 1 }]
          : [];
      }
      if (types.includes("seoBulkFix")) {
        return taskFindMany.mock.calls.filter((c) => c[0].where?.type?.in?.includes("seoBulkFix")).length === 1
          ? [{ id: "t2", shop: "a.myshopify.com", type: "seoBulkFix", total: 1 }]
          : [];
      }
      return [];
    });
    taskUpdateMany.mockResolvedValue({ count: 1 });
    try {
      const { TaskRecoveryService } = await import("../../task-recovery.service.js");
      await new TaskRecoveryService().markStuckTasksAsFailed();
    } finally {
      g.__db = prevDb;
    }
    const byIds = (id: string) => taskUpdateMany.mock.calls.find((c) => c[0].where?.id?.in?.includes(id))?.[0].data;
    expect(byIds("t1").error).toBe(INTERRUPTED_TASK_ERROR);
    expect(byIds("t2").error).toBe("task_timed_out");
  });
});

describe("server.js stamps the process start before listen()", () => {
  it("sets globalThis.__processStartedAt after the adapter import and before app.listen", () => {
    const src = readFileSync(resolve(__dirname, "../../server.js"), "utf8");
    const adapter = src.indexOf('import { webApiAdapterInitialized } from "@shopify/shopify-api/adapters/web-api"');
    const stamp = src.indexOf("globalThis.__processStartedAt = new Date()");
    const listen = src.indexOf("app.listen(");
    expect(adapter).toBeGreaterThan(-1);
    expect(stamp).toBeGreaterThan(adapter);
    expect(listen).toBeGreaterThan(stamp);
    expect(src.indexOf("sentryNode.init(")).toBeGreaterThan(adapter);
  });
});
