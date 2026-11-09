/**
 * markShopUninstalled (PLAN_ADMIN_SHOP_OVERVIEW 2.4): the shared body of the
 * app/uninstalled webhook. It records the source, lifts the connection block and
 * owes a catch-up (resyncRequiredSince, earliest moment kept).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  upsert: vi.fn(async (..._a: unknown[]) => ({})),
  updateMany: vi.fn(async (..._a: unknown[]) => ({ count: 1 })),
  clear: vi.fn(async (..._a: unknown[]) => undefined),
  order: [] as string[],
}));
vi.mock("~/db.server", () => ({
  db: {
    session: { deleteMany: vi.fn(async () => ({ count: 1 })) },
    shopInstallState: { upsert: (...a: unknown[]) => h.upsert(...a), updateMany: (...a: unknown[]) => h.updateMany(...a) },
    aISettings: { updateMany: vi.fn(async () => ({ count: 0 })) },
  },
}));
vi.mock("~/services/sync-scheduler.service", () => ({
  syncScheduler: { isShopActive: () => true, stopSyncForShop: vi.fn() },
}));
vi.mock("~/utils/logger.server", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("~/utils/offline-admin.server", () => ({
  invalidateOfflineAdmin: vi.fn(),
  forgetOfflineTokenMigration: vi.fn(async () => undefined),
}));
vi.mock("~/utils/shop-connection-state.server", () => ({
  clearConnectionBlock: (...a: unknown[]) => {
    h.order.push("clear");
    return h.clear(...a);
  },
}));

import { markShopUninstalled } from "~/services/shop-uninstall.server";

beforeEach(() => {
  vi.clearAllMocks();
  h.order.length = 0;
  h.upsert.mockImplementation(async () => {
    h.order.push("upsert");
    return {};
  });
});

describe("markShopUninstalled", () => {
  it("stamps uninstalledAt with the source and owes a catch-up (earliest moment kept)", async () => {
    await markShopUninstalled("x.myshopify.com", { source: "operator" });
    const arg = h.upsert.mock.calls[0][0] as any;
    expect(arg.create).toMatchObject({ shop: "x.myshopify.com", uninstallSource: "operator" });
    expect(arg.create.resyncRequiredSince).toBeInstanceOf(Date);
    expect(arg.update.uninstallSource).toBe("operator");
    // an existing row gets the flag ONLY where it is still empty
    expect(h.updateMany).toHaveBeenCalledWith({
      where: { shop: "x.myshopify.com", resyncRequiredSince: null },
      data: { resyncRequiredSince: expect.any(Date) },
    });
    expect(arg.update.resyncRequiredSince).toBeUndefined();
  });

  it("lifts the connection block AFTER the marker is written", async () => {
    await markShopUninstalled("x.myshopify.com", { source: "webhook" });
    expect(h.clear).toHaveBeenCalledWith("x.myshopify.com", "uninstalled");
    expect(h.order).toEqual(["upsert", "clear"]);
  });

  it("still lifts the block and never throws when the marker write fails", async () => {
    h.upsert.mockRejectedValue(new Error("db"));
    await expect(markShopUninstalled("x.myshopify.com", { source: "webhook" })).resolves.toBeUndefined();
    expect(h.clear).toHaveBeenCalled();
  });
});
