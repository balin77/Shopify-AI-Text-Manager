/** The usage rollup runs BEFORE the cleanup deletes the tasks it reads (plan 3.2). */
import { describe, it, expect, vi } from "vitest";

const h = vi.hoisted(() => ({ order: [] as string[] }));
vi.mock("~/db.server", () => ({
  db: {
    task: { deleteMany: vi.fn(async () => { h.order.push("deleteTasks"); return { count: 0 }; }) },
    webhookLog: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    aISettings: { findMany: vi.fn(async () => []) },
    productImage: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    $executeRaw: vi.fn(async () => 0),
  },
}));
vi.mock("~/services/shop-usage-rollup.server", () => ({
  rollupTaskUsage: vi.fn(async () => { h.order.push("rollup"); return 0; }),
  pruneShopUsage: vi.fn(async () => { h.order.push("prune"); return 0; }),
}));
vi.mock("~/utils/logger.server", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { syncScheduler } from "~/services/sync-scheduler.service";

describe("runDatabaseCleanup", () => {
  it("rolls the usage up before the tasks are deleted", async () => {
    await (syncScheduler as unknown as { runDatabaseCleanup: () => Promise<void> }).runDatabaseCleanup();
    expect(h.order.indexOf("rollup")).toBeGreaterThanOrEqual(0);
    expect(h.order.indexOf("rollup")).toBeLessThan(h.order.indexOf("deleteTasks"));
  });
});
