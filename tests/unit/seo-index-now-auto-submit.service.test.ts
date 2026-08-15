/**
 * Unit tests for app/services/seo/index-now-auto-submit.service.ts
 *
 * The sweep is what makes IndexNow actually instant — before it existed the
 * webhook-fed queue only drained when a merchant clicked. Verified here:
 *   - a tick with an empty queue touches nothing (no config query, no drain)
 *   - only shops that HAVE pending URLs and whose config is enabled + due are
 *     drained
 *   - shops below "pro" are skipped WITHOUT a drain, but still stamped
 *   - a failing drain still stamps (backoff), so one broken shop cannot win the
 *     due query on every tick forever
 *
 * db + drainQueue are mocked; no real database/network needed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDrainQueue } = vi.hoisted(() => ({ mockDrainQueue: vi.fn() }));

vi.mock("~/services/seo/index-now.service", () => ({
  drainQueue: mockDrainQueue,
  firstFailureKind: () => null,
}));

vi.mock("~/utils/logger.server", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

interface ConfigRow {
  shop: string;
  enabled: boolean;
  lastAutoRunAt: Date | null;
}

let pendingShops: string[] = [];
let configs: ConfigRow[] = [];
const plans = new Map<string, string>();
const stamped: string[] = [];

vi.mock("~/db.server", () => ({
  db: {
    seoIndexNowQueue: {
      groupBy: vi.fn(async () => pendingShops.map((shop) => ({ shop, _count: { _all: 1 } }))),
    },
    seoIndexNowConfig: {
      findMany: vi.fn(async ({ where, take }: any) => {
        const inList: string[] = where.shop.in;
        const cutoff = where.OR?.[1]?.lastAutoRunAt?.lt as Date | undefined;
        return configs
          .filter((c) => inList.includes(c.shop))
          .filter((c) => c.enabled === where.enabled)
          .filter((c) => c.lastAutoRunAt === null || (cutoff ? c.lastAutoRunAt < cutoff : true))
          .sort((a, b) => (a.lastAutoRunAt?.getTime() ?? -1) - (b.lastAutoRunAt?.getTime() ?? -1))
          .slice(0, take)
          .map((c) => ({ shop: c.shop }));
      }),
      updateMany: vi.fn(async ({ where }: any) => {
        stamped.push(where.shop);
        return { count: 1 };
      }),
    },
    aISettings: {
      findMany: vi.fn(async ({ where }: any) =>
        (where.shop.in as string[])
          .filter((s) => plans.has(s))
          .map((s) => ({ shop: s, subscriptionPlan: plans.get(s) })),
      ),
    },
  },
}));

const { IndexNowAutoSubmitService } = await import("~/services/seo/index-now-auto-submit.service");

const NOW = new Date("2026-08-15T12:00:00Z");
const OLD = new Date("2026-08-15T00:00:00Z");

beforeEach(() => {
  pendingShops = [];
  configs = [];
  plans.clear();
  stamped.length = 0;
  mockDrainQueue.mockReset();
  mockDrainQueue.mockResolvedValue({
    status: "submitted",
    result: { submitted: 1, chunks: 1, failed: 0, results: [] },
  });
});

describe("IndexNowAutoSubmitService.tick", () => {
  it("does nothing when no shop has pending URLs", async () => {
    const stats = await IndexNowAutoSubmitService.getInstance().tick(NOW);
    expect(stats.candidates).toBe(0);
    expect(mockDrainQueue).not.toHaveBeenCalled();
    expect(stamped).toHaveLength(0);
  });

  it("drains a due, enabled, Pro shop that has pending URLs", async () => {
    pendingShops = ["a.myshopify.com"];
    configs = [{ shop: "a.myshopify.com", enabled: true, lastAutoRunAt: null }];
    plans.set("a.myshopify.com", "pro");

    const stats = await IndexNowAutoSubmitService.getInstance().tick(NOW);
    expect(stats.drained).toBe(1);
    expect(stats.submitted).toBe(1);
    expect(mockDrainQueue).toHaveBeenCalledTimes(1);
    expect(stamped).toEqual(["a.myshopify.com"]);
  });

  it("ignores shops whose config is disabled or was just swept", async () => {
    pendingShops = ["disabled.myshopify.com", "fresh.myshopify.com"];
    configs = [
      { shop: "disabled.myshopify.com", enabled: false, lastAutoRunAt: null },
      // Swept a minute ago — not due again yet.
      { shop: "fresh.myshopify.com", enabled: true, lastAutoRunAt: new Date(NOW.getTime() - 60_000) },
    ];
    plans.set("disabled.myshopify.com", "pro");
    plans.set("fresh.myshopify.com", "pro");

    const stats = await IndexNowAutoSubmitService.getInstance().tick(NOW);
    expect(stats.candidates).toBe(0);
    expect(mockDrainQueue).not.toHaveBeenCalled();
  });

  it("skips shops below the Pro plan WITHOUT draining, but still stamps them", async () => {
    pendingShops = ["free.myshopify.com"];
    configs = [{ shop: "free.myshopify.com", enabled: true, lastAutoRunAt: OLD }];
    plans.set("free.myshopify.com", "basic");

    const stats = await IndexNowAutoSubmitService.getInstance().tick(NOW);
    expect(stats.skippedPlan).toBe(1);
    expect(mockDrainQueue).not.toHaveBeenCalled();
    // Without the stamp this shop would win the due query on every single tick.
    expect(stamped).toEqual(["free.myshopify.com"]);
  });

  it("treats a shop with no settings row as free", async () => {
    pendingShops = ["ghost.myshopify.com"];
    configs = [{ shop: "ghost.myshopify.com", enabled: true, lastAutoRunAt: OLD }];

    const stats = await IndexNowAutoSubmitService.getInstance().tick(NOW);
    expect(stats.skippedPlan).toBe(1);
    expect(stamped).toEqual(["ghost.myshopify.com"]);
  });

  it("stamps after a failing drain so a broken shop backs off", async () => {
    pendingShops = ["boom.myshopify.com"];
    configs = [{ shop: "boom.myshopify.com", enabled: true, lastAutoRunAt: OLD }];
    plans.set("boom.myshopify.com", "max");
    mockDrainQueue.mockRejectedValue(new Error("network down"));

    const stats = await IndexNowAutoSubmitService.getInstance().tick(NOW);
    expect(stats.errored).toBe(1);
    expect(stamped).toEqual(["boom.myshopify.com"]);
  });
});
