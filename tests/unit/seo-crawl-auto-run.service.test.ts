/**
 * Weekly storefront-crawl sweep — the second unattended Max feature.
 *
 * Same two conditions as the nightly audit sweep must BOTH hold before a shop
 * is crawled: the plan grants `seo.scheduledCrawl`, and the merchant left the
 * switch on in Settings → SEO. Both are filtered in the due-query, so the test
 * asserts the query rather than counting crawls afterwards.
 *
 * The extra rule this sweep carries: it only STARTS crawls, and a shop whose
 * crawl is already running must be stamped and skipped — never crawled twice.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const findMany = vi.fn<(args: any) => Promise<any>>();
const update = vi.fn<(args: any) => Promise<any>>();
const startCrawlRun = vi.fn<(args: any) => Promise<any>>();

vi.mock("~/db.server", () => ({
  db: {
    aISettings: {
      findMany: (args: any) => findMany(args),
      update: (args: any) => update(args),
    },
  },
}));
vi.mock("~/utils/admin-client.server", () => ({
  createAdminClientFromShop: async () => ({ graphql: async () => ({ json: async () => ({}) }) }),
}));
vi.mock("~/services/seo/crawl-run.server", () => ({
  startCrawlRun: (args: any) => startCrawlRun(args),
}));

async function loadService() {
  const mod = await import("~/services/seo/crawl-auto-run.service");
  return mod.SeoCrawlAutoRunService.getInstance();
}

const DUE_SHOP = { shop: "a.myshopify.com", lastAutoCrawlAt: null };

describe("SeoCrawlAutoRunService.tick", () => {
  beforeEach(() => {
    findMany.mockReset();
    update.mockReset();
    startCrawlRun.mockReset();
    update.mockResolvedValue({});
    startCrawlRun.mockResolvedValue({ started: true, taskId: "t1", snapshotId: "s1" });
  });

  it("selects only entitled shops that have NOT opted out, due after a week", async () => {
    findMany.mockResolvedValue([]);
    const service = await loadService();

    await service.tick(new Date("2026-08-19T03:00:00Z"));

    const where = findMany.mock.calls[0][0].where;
    // Max is the only tier with scheduledCrawl today; the list is derived from
    // PLAN_CONFIG, so this also fails if a tier silently gains the flag.
    expect(where.subscriptionPlan).toEqual({ in: ["max"] });
    expect(where.seoAutoCrawlEnabled).toBe(true);
    expect(where.OR).toEqual([
      { lastAutoCrawlAt: null },
      { lastAutoCrawlAt: { lt: new Date("2026-08-12T03:00:00Z") } },
    ]);
  });

  it("asks for the longest-waiting shops first, nulls included", async () => {
    findMany.mockResolvedValue([]);
    const service = await loadService();

    await service.tick(new Date("2026-08-19T03:00:00Z"));

    const args = findMany.mock.calls[0][0];
    expect(args.orderBy).toEqual({ lastAutoCrawlAt: { sort: "asc", nulls: "first" } });
    expect(args.take).toBeGreaterThan(0);
  });

  it("starts one crawl per due shop and stamps it", async () => {
    findMany.mockResolvedValue([DUE_SHOP]);
    const service = await loadService();

    const now = new Date("2026-08-19T03:00:00Z");
    const stats = await service.tick(now);

    expect(stats).toMatchObject({ candidates: 1, started: 1, skipped: 0, errored: 0 });
    expect(startCrawlRun).toHaveBeenCalledTimes(1);
    expect(startCrawlRun.mock.calls[0][0].shop).toBe("a.myshopify.com");
    expect(update).toHaveBeenCalledWith({
      where: { shop: "a.myshopify.com" },
      data: { lastAutoCrawlAt: now },
    });
  });

  it("stamps and counts a shop whose crawl is already running instead of retrying it hourly", async () => {
    findMany.mockResolvedValue([DUE_SHOP]);
    startCrawlRun.mockResolvedValue({ started: false, reason: "alreadyRunning", taskId: "t9" });
    const service = await loadService();

    const now = new Date("2026-08-19T03:00:00Z");
    const stats = await service.tick(now);

    expect(stats).toMatchObject({ started: 0, skipped: 1, errored: 0 });
    expect(update).toHaveBeenCalledWith({
      where: { shop: "a.myshopify.com" },
      data: { lastAutoCrawlAt: now },
    });
  });

  it("stamps the shop even when starting throws, so it cannot win the due query forever", async () => {
    findMany.mockResolvedValue([DUE_SHOP]);
    startCrawlRun.mockRejectedValue(new Error("task table exploded"));
    const service = await loadService();

    const now = new Date("2026-08-19T03:00:00Z");
    const stats = await service.tick(now);

    expect(stats).toMatchObject({ started: 0, errored: 1 });
    expect(update).toHaveBeenCalledWith({
      where: { shop: "a.myshopify.com" },
      data: { lastAutoCrawlAt: now },
    });
  });

  it("does nothing when no shop is due", async () => {
    findMany.mockResolvedValue([]);
    const service = await loadService();

    const stats = await service.tick();

    expect(stats).toEqual({ candidates: 0, started: 0, skipped: 0, errored: 0 });
    expect(startCrawlRun).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});
