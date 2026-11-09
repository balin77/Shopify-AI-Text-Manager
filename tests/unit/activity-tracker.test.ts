/** trackActivity (PLAN_ADMIN_SHOP_OVERVIEW 3.2): throttled, polling-free, once per request, path only, never throws. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  sessionUpdateMany: vi.fn(),
  sisUpdateMany: vi.fn(),
  usageUpsert: vi.fn(),
}));
vi.mock("../../app/db.server", () => ({
  db: {
    session: { updateMany: (...a: unknown[]) => h.sessionUpdateMany(...a) },
    shopInstallState: { updateMany: (...a: unknown[]) => h.sisUpdateMany(...a) },
    shopUsageDay: { upsert: (...a: unknown[]) => h.usageUpsert(...a) },
  },
}));
vi.mock("~/utils/logger.server", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { __resetActivityTrackerForTests, trackActivity } from "../../app/middleware/activity-tracker.middleware";

const SHOP = "a.myshopify.com";
const req = (path: string, method = "GET") => new Request(`https://app.example${path}`, { method });
const upsertsWith = (field: "activeSlots" | "actions") =>
  h.usageUpsert.mock.calls.filter((c) => (c[0] as any).update?.[field]);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-09T10:01:00Z"));
  __resetActivityTrackerForTests();
  h.sessionUpdateMany.mockReset().mockResolvedValue({ count: 1 });
  h.sisUpdateMany.mockReset().mockResolvedValue({ count: 1 });
  h.usageUpsert.mockReset().mockResolvedValue({});
});
afterEach(() => vi.useRealTimers());

describe("trackActivity", () => {
  it("writes lastActivityAt (and clears the approximation flag) at most once per 5 minutes", async () => {
    await trackActivity(SHOP, req("/app/products"));
    await trackActivity(SHOP, req("/app/pages"));
    const writes = () => h.sisUpdateMany.mock.calls.filter((c) => (c[0] as any).data.lastActivityAt);
    expect(writes()).toHaveLength(1);
    expect((writes()[0][0] as any).data).toMatchObject({ lastActivityApprox: false });
    vi.setSystemTime(new Date("2026-11-09T10:06:30Z"));
    await trackActivity(SHOP, req("/app/pages"));
    expect(writes()).toHaveLength(2);
  });

  it("counts one active window per 5-minute slot", async () => {
    await trackActivity(SHOP, req("/app/products"));
    await trackActivity(SHOP, req("/app/pages"));
    expect(upsertsWith("activeSlots")).toHaveLength(1);
    vi.setSystemTime(new Date("2026-11-09T10:06:00Z"));
    await trackActivity(SHOP, req("/app/pages"));
    expect(upsertsWith("activeSlots")).toHaveLength(2);
    const arg = upsertsWith("activeSlots")[0][0] as any;
    expect(arg.where).toEqual({ shop_day: { shop: SHOP, day: new Date("2026-11-09T00:00:00Z") } });
    expect(arg.update).toEqual({ activeSlots: { increment: 1 } });
  });

  it("polling counts neither as a window nor as last opened nor as an action", async () => {
    await trackActivity(SHOP, req("/api/running-tasks-count"));
    await trackActivity(SHOP, req("/api/task-status", "POST"));
    expect(h.usageUpsert).not.toHaveBeenCalled();
    expect(h.sisUpdateMany).not.toHaveBeenCalled();
    // the scheduler gate still sees it, as before
    expect(h.sessionUpdateMany).toHaveBeenCalledTimes(2);
  });

  it("a non-GET counts ONE action per request, even if authenticated twice", async () => {
    const r = req("/app/products?secret=1", "POST");
    await trackActivity(SHOP, r);
    await trackActivity(SHOP, r);
    expect(upsertsWith("actions")).toHaveLength(1);
    expect((upsertsWith("actions")[0][0] as any).update).toEqual({ actions: { increment: 1 } });
  });

  it("a GET is not an action", async () => {
    await trackActivity(SHOP, req("/app/products"));
    expect(upsertsWith("actions")).toHaveLength(0);
  });

  it("stores the path area only, never the query, and throttles the last-action write", async () => {
    await trackActivity(SHOP, req("/app/products?token=abc", "POST"));
    const call = h.sisUpdateMany.mock.calls.find((c) => (c[0] as any).data.lastActionArea)!;
    expect((call[0] as any).data.lastActionArea).toBe("app.products");
    expect(JSON.stringify(h.sisUpdateMany.mock.calls)).not.toContain("abc");
    await trackActivity(SHOP, req("/app/products", "POST"));
    expect(h.sisUpdateMany.mock.calls.filter((c) => (c[0] as any).data.lastActionArea)).toHaveLength(1);
    await trackActivity(SHOP, req("/app/pages", "POST"));
    expect(h.sisUpdateMany.mock.calls.filter((c) => (c[0] as any).data.lastActionArea)).toHaveLength(2);
  });

  it("never throws, whatever the database does, and a failed write is retried by the next request", async () => {
    h.sisUpdateMany.mockRejectedValue(new Error("db"));
    h.usageUpsert.mockRejectedValue(new Error("db"));
    h.sessionUpdateMany.mockRejectedValue(new Error("db"));
    await expect(trackActivity(SHOP, req("/app/products", "POST"))).resolves.toBeUndefined();
    h.sisUpdateMany.mockResolvedValue({ count: 1 });
    h.usageUpsert.mockResolvedValue({});
    h.sisUpdateMany.mockClear();
    await trackActivity(SHOP, req("/app/products"));
    expect(h.sisUpdateMany).toHaveBeenCalled();
  });

  it("without a request only the scheduler gate runs", async () => {
    await trackActivity(SHOP);
    expect(h.sessionUpdateMany).toHaveBeenCalledTimes(1);
    expect(h.sisUpdateMany).not.toHaveBeenCalled();
    expect(h.usageUpsert).not.toHaveBeenCalled();
  });

  it("never creates an install-state row (updateMany only)", async () => {
    await trackActivity(SHOP, req("/app/products", "POST"));
    expect(h.sisUpdateMany).toHaveBeenCalled();
  });
});
