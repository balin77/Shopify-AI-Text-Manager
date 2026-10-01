/**
 * `startCrawlRun`'s single-flight must not outlive the runner.
 *
 * The crawl is a detached promise inside the web process, so a redeploy of a new
 * app version leaves a `running` Task row with no runner behind it. Refusing the
 * merchant's next crawl on that row's behalf was the hang: nothing could start
 * until the stuck-task reaper came round three quarters of an hour later.
 *
 * A crawl heartbeats at least every 10s through every phase, which is what makes
 * "silent for HEARTBEAT_STALL_MS" evidence rather than a guess.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { HEARTBEAT_STALL_MS, INTERRUPTED_TASK_ERROR } from "../../orphan-run-recovery.js";

const runCrawl = vi.fn<(...a: any[]) => Promise<any>>();
const pruneOldCrawlSnapshots = vi.fn<(...a: any[]) => Promise<any>>();

vi.mock("~/services/seo/crawl.service", () => ({
  runCrawl: (...a: any[]) => runCrawl(...a),
  pruneOldCrawlSnapshots: (...a: any[]) => pruneOldCrawlSnapshots(...a),
}));
vi.mock("~/utils/logger.server", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const SHOP = "a.myshopify.com";

function makeDb(runningTask: { id: string; updatedAt: Date } | null) {
  // Stateful on purpose: the snapshot half of the rule asks "does this shop
  // still have a running crawl task", so a fake that keeps answering yes after
  // the takeover would never exercise it.
  let live = runningTask;
  const taskUpdateMany = vi.fn(async () => {
    live = null;
    return { count: 1 };
  });
  const snapshotUpdateMany = vi.fn(async () => ({ count: 1 }));
  const db: any = {
    task: {
      findFirst: vi.fn(async ({ where }: any) =>
        where.type === "seoCrawl" && where.status === "running" ? live : null,
      ),
      // Serves both reads with `status: "running"`: the sweep's select
      // (id/shop/type) and the snapshot rule's live-crawl lookup (shop).
      findMany: vi.fn(async () => (live ? [{ id: live.id, shop: SHOP, type: "seoCrawl" }] : [])),
      updateMany: taskUpdateMany,
      create: vi.fn(async () => ({ id: "new-task" })),
      update: vi.fn(async () => ({})),
    },
    seoCrawlSnapshot: {
      findMany: vi.fn(async () => [{ id: "old-snapshot", shop: SHOP }]),
      updateMany: snapshotUpdateMany,
      create: vi.fn(async () => ({ id: "new-snapshot" })),
      update: vi.fn(async () => ({})),
    },
    aISettings: { findUnique: vi.fn(async () => ({ seoCrawlExternalLinks: true })) },
  };
  return { db, taskUpdateMany, snapshotUpdateMany };
}

const admin: any = { graphql: async () => ({ json: async () => ({ data: { shop: null } }) }) };

async function loadStart() {
  const mod = await import("~/services/seo/crawl-run.server");
  return mod.startCrawlRun;
}

beforeEach(() => {
  runCrawl.mockReset();
  pruneOldCrawlSnapshots.mockReset();
  pruneOldCrawlSnapshots.mockResolvedValue(undefined);
  runCrawl.mockResolvedValue({
    status: "completed",
    error: null,
    pagesCrawled: 1,
    totalDiscovered: 1,
    pagesOk: 1,
    pagesBroken: 0,
    orphanCount: 0,
    headDriftCount: 0,
  });
});

describe("startCrawlRun single-flight", () => {
  it("refuses a second crawl while the running one is still heartbeating", async () => {
    const { db } = makeDb({ id: "live", updatedAt: new Date() });
    const startCrawlRun = await loadStart();

    const res = await startCrawlRun({ db, admin, shop: SHOP });

    expect(res).toEqual({ started: false, reason: "alreadyRunning", taskId: "live" });
    expect(db.task.create).not.toHaveBeenCalled();
    expect(db.seoCrawlSnapshot.create).not.toHaveBeenCalled();
  });

  it("takes over a run that has been silent past the heartbeat threshold, closing BOTH of its rows", async () => {
    const { db, taskUpdateMany, snapshotUpdateMany } = makeDb({
      id: "orphan",
      updatedAt: new Date(Date.now() - HEARTBEAT_STALL_MS - 1_000),
    });
    const startCrawlRun = await loadStart();

    const res = await startCrawlRun({ db, admin, shop: SHOP });

    expect(res).toEqual({ started: true, taskId: "new-task", snapshotId: "new-snapshot" });
    expect(taskUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "failed", error: INTERRUPTED_TASK_ERROR }),
      }),
    );
    // The snapshot half is the one no reaper ever touched — without it the newest
    // crawl stays "running" and the report reads as zero pages for good.
    expect(snapshotUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "failed" }) }),
    );
    // Scoped to this shop: an unscoped sweep from a request would kill another
    // merchant's live crawl.
    expect(db.task.findMany.mock.calls[0][0].where.shop).toEqual({ in: [SHOP] });

    // And the old snapshot is closed BEFORE the new one exists — the orphan rule
    // asks "does this shop have a running crawl", so a new running snapshot
    // created first would look live and leave the old row open.
    const closedAt = snapshotUpdateMany.mock.invocationCallOrder[0];
    const createdAt = (db.seoCrawlSnapshot.create as any).mock.invocationCallOrder[0];
    expect(closedAt).toBeLessThan(createdAt);
  });
});
