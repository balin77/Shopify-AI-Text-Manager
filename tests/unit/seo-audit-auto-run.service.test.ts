/**
 * Nightly SEO audit sweep — the Max differentiator (§Plan-Matrix).
 *
 * Two independent conditions must BOTH hold before a shop is scanned: the plan
 * grants `seo.scheduledAudit`, and the merchant left the switch on in
 * Settings → SEO. Both are filtered in the due-query, so this test asserts the
 * query itself rather than counting scans afterwards — an opted-out shop must
 * cost nothing per tick, not be fetched and then skipped.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const findMany = vi.fn();
const update = vi.fn(async () => ({}));
const analyzeStore = vi.fn();
const saveAuditSnapshot = vi.fn(async () => {});

vi.mock("~/db.server", () => ({
  db: {
    aISettings: {
      findMany: (...args: any[]) => findMany(...args),
      update: (...args: any[]) => update(...args),
    },
  },
}));
vi.mock("~/services/seo/audit.service", () => ({
  analyzeStore: (...args: any[]) => analyzeStore(...args),
  saveAuditSnapshot: (...args: any[]) => saveAuditSnapshot(...args),
}));

const AUDIT = { averageScore: 71, totalScanned: 12, totalAvailable: 12, capped: false };

async function loadService() {
  const mod = await import("~/services/seo/audit-auto-run.service");
  return mod.SeoAuditAutoRunService.getInstance();
}

describe("SeoAuditAutoRunService.tick", () => {
  beforeEach(() => {
    findMany.mockReset();
    update.mockReset();
    analyzeStore.mockReset();
    saveAuditSnapshot.mockReset();
    update.mockResolvedValue({});
    analyzeStore.mockResolvedValue(AUDIT);
    saveAuditSnapshot.mockResolvedValue(undefined);
  });

  it("selects only entitled shops that have NOT opted out", async () => {
    findMany.mockResolvedValue([]);
    const service = await loadService();

    await service.tick(new Date("2026-08-19T03:00:00Z"));

    const where = findMany.mock.calls[0][0].where;
    // Max is the only tier with scheduledAudit today; the list is derived from
    // PLAN_CONFIG, so this also fails if a tier silently gains the flag.
    expect(where.subscriptionPlan).toEqual({ in: ["max"] });
    expect(where.seoAutoAuditEnabled).toBe(true);
    // Due = never run, or older than the due window.
    expect(where.OR).toEqual([
      { lastAutoAuditAt: null },
      { lastAutoAuditAt: { lt: new Date("2026-08-18T03:00:00Z") } },
    ]);
  });

  it("asks for the longest-waiting shops first, nulls included", async () => {
    findMany.mockResolvedValue([]);
    const service = await loadService();

    await service.tick(new Date("2026-08-19T03:00:00Z"));

    const args = findMany.mock.calls[0][0];
    // Postgres sorts NULLS LAST by default, which would starve never-scanned
    // shops forever.
    expect(args.orderBy).toEqual({ lastAutoAuditAt: { sort: "asc", nulls: "first" } });
    expect(args.take).toBeGreaterThan(0);
  });

  it("writes one primary-locale snapshot per due shop", async () => {
    findMany.mockResolvedValue([
      {
        shop: "a.myshopify.com",
        subscriptionPlan: "max",
        seoTitleSuffixEnabled: false,
        seoTitleSuffix: null,
        seoLimits: null,
        lastAutoAuditAt: null,
      },
    ]);
    const service = await loadService();

    const stats = await service.tick(new Date("2026-08-19T03:00:00Z"));

    expect(stats).toMatchObject({ candidates: 1, scanned: 1, errored: 0 });
    expect(analyzeStore).toHaveBeenCalledTimes(1);
    expect(analyzeStore.mock.calls[0][0]).toBe("a.myshopify.com");
    // Primary locale only — the manual run fans out over every published
    // locale, the unattended one must not multiply the cost by locale count.
    expect(analyzeStore.mock.calls[0][1].locale).toBeUndefined();
    expect(saveAuditSnapshot).toHaveBeenCalledWith(
      expect.anything(),
      "a.myshopify.com",
      AUDIT,
      "",
    );
  });

  it("stamps the shop even when the scan throws, so it cannot win the due query forever", async () => {
    findMany.mockResolvedValue([
      {
        shop: "b.myshopify.com",
        subscriptionPlan: "max",
        seoTitleSuffixEnabled: false,
        seoTitleSuffix: null,
        seoLimits: null,
        lastAutoAuditAt: null,
      },
    ]);
    analyzeStore.mockRejectedValue(new Error("content cache exploded"));
    const service = await loadService();

    const now = new Date("2026-08-19T03:00:00Z");
    const stats = await service.tick(now);

    expect(stats).toMatchObject({ scanned: 0, errored: 1 });
    expect(update).toHaveBeenCalledWith({
      where: { shop: "b.myshopify.com" },
      data: { lastAutoAuditAt: now },
    });
  });

  it("does nothing when no shop is due", async () => {
    findMany.mockResolvedValue([]);
    const service = await loadService();

    const stats = await service.tick();

    expect(stats).toEqual({ candidates: 0, scanned: 0, errored: 0 });
    expect(analyzeStore).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});
