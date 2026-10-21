/**
 * app/uninstalled drops the in-process offline-token cache, so no background
 * caller keeps serving the revoked token after the sessions are deleted.
 */

import { describe, it, expect, vi } from "vitest";

const h = vi.hoisted(() => ({
  invalidate: vi.fn(),
  order: [] as string[],
}));

vi.mock("~/shopify.server", () => ({
  authenticate: { webhook: vi.fn(async () => ({ shop: "gone.myshopify.com" })) },
}));
vi.mock("~/db.server", () => ({
  db: {
    session: {
      deleteMany: vi.fn(async () => {
        h.order.push("deleteSessions");
        return { count: 1 };
      }),
    },
    shopInstallState: { upsert: vi.fn(async () => ({})) },
    aISettings: { updateMany: vi.fn(async () => ({ count: 0 })) },
  },
}));
vi.mock("~/services/sync-scheduler.service", () => ({
  syncScheduler: { isShopActive: () => false, stopSyncForShop: vi.fn() },
}));
vi.mock("~/utils/logger.server", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("~/utils/offline-admin.server", () => ({
  invalidateOfflineAdmin: (shop: string) => {
    h.order.push("invalidate");
    h.invalidate(shop);
  },
}));

import { action } from "~/routes/webhooks.app-uninstalled";

describe("app/uninstalled webhook", () => {
  it("invalidates the offline-admin cache after deleting the sessions", async () => {
    const res = await action({ request: new Request("https://x/webhooks", { method: "POST" }) } as never);
    expect(res.status).toBe(200);
    expect(h.invalidate).toHaveBeenCalledWith("gone.myshopify.com");
    expect(h.order).toEqual(["deleteSessions", "invalidate"]);
  });
});
