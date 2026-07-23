/**
 * Unit Tests for app/services/seo/gsc-auto-sync.service.ts
 *
 * Verifies the daily auto-sync sweep's selection/skip logic:
 *   - due connections (never synced or stale) are picked, fresh ones are not
 *   - the per-tick batch cap is respected
 *   - shops below "pro" are skipped WITHOUT calling GSC, but still stamped
 *   - shops with zero tracked SeoKeyword rows are skipped, but still stamped
 *   - a sync error still stamps lastKeywordSyncAt (backoff)
 *   - GscReconnectRequiredError is NOT stamped (row already deleted upstream)
 *
 * db + enrichKeywordsFromGsc are mocked; no real database/network needed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockEnrich, mockEnrichPageStats, GscReconnectRequiredError } = vi.hoisted(() => {
  class GscReconnectRequiredError extends Error {
    constructor(public reason: string) {
      super(`GSC reconnect required: ${reason}`);
      this.name = "GscReconnectRequiredError";
    }
  }
  return { mockEnrich: vi.fn(), mockEnrichPageStats: vi.fn(), GscReconnectRequiredError };
});

vi.mock("~/services/google-search-console.server", () => ({
  enrichKeywordsFromGsc: mockEnrich,
  // Phase 3 (PLAN_SEO_SUITE_COMPLETION.md §5.1 option b): the per-page
  // rollup call added alongside the existing keyword sync.
  enrichPageStatsFromGsc: mockEnrichPageStats,
  GscReconnectRequiredError,
}));

vi.mock("~/utils/logger.server", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// In-memory GoogleSearchConsoleConnection table + a Prisma-ish findMany that
// interprets exactly the `where`/`orderBy`/`take` shapes gsc-auto-sync.service
// uses, so the tests exercise the service's REAL query construction rather
// than a hand-picked mock return value.
interface ConnRow {
  shop: string;
  propertyUrl: string;
  lastKeywordSyncAt: Date | null;
}

let table: ConnRow[] = [];
const plans = new Map<string, string>();
const keywordCounts = new Map<string, number>();

function fakeFindMany(where: any, opts: any): Array<{ shop: string }> {
  let rows = table.filter((r) => {
    if (where.propertyUrl?.not !== undefined && r.propertyUrl === where.propertyUrl.not) return false;
    if ("lastKeywordSyncAt" in where) {
      const cond = where.lastKeywordSyncAt;
      if (cond === null) {
        if (r.lastKeywordSyncAt !== null) return false;
      } else if (cond && "lt" in cond) {
        if (!(r.lastKeywordSyncAt && r.lastKeywordSyncAt.getTime() < cond.lt.getTime())) return false;
      }
    }
    return true;
  });
  if (opts?.orderBy?.lastKeywordSyncAt === "asc") {
    rows = [...rows].sort(
      (a, b) => (a.lastKeywordSyncAt?.getTime() ?? 0) - (b.lastKeywordSyncAt?.getTime() ?? 0),
    );
  }
  if (typeof opts?.take === "number") rows = rows.slice(0, opts.take);
  return rows.map((r) => ({ shop: r.shop }));
}

const mockFindMany = vi.fn((args: any) => Promise.resolve(fakeFindMany(args.where, args)));
const mockUpdateMany = vi.fn((args: any) => {
  const row = table.find((r) => r.shop === args.where.shop);
  if (!row) return Promise.resolve({ count: 0 });
  row.lastKeywordSyncAt = args.data.lastKeywordSyncAt;
  return Promise.resolve({ count: 1 });
});
const mockAiFindUnique = vi.fn((args: any) => {
  const plan = plans.get(args.where.shop);
  return Promise.resolve(plan ? { subscriptionPlan: plan } : null);
});
const mockKeywordCount = vi.fn((args: any) => Promise.resolve(keywordCounts.get(args.where.shop) ?? 0));

vi.mock("~/db.server", () => ({
  db: {
    googleSearchConsoleConnection: {
      findMany: (args: any) => mockFindMany(args),
      updateMany: (args: any) => mockUpdateMany(args),
    },
    aISettings: { findUnique: (args: any) => mockAiFindUnique(args) },
    seoKeywordAssignment: { count: (args: any) => mockKeywordCount(args) },
  },
}));

import { GscAutoSyncService } from "~/services/seo/gsc-auto-sync.service";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function addConn(shop: string, opts: { propertyUrl?: string; lastKeywordSyncAt?: Date | null } = {}) {
  table.push({
    shop,
    propertyUrl: opts.propertyUrl ?? "sc-domain:example.com",
    lastKeywordSyncAt: opts.lastKeywordSyncAt ?? null,
  });
}

describe("GscAutoSyncService.tick()", () => {
  const service = GscAutoSyncService.getInstance();
  const now = new Date("2026-07-06T12:00:00Z");

  beforeEach(() => {
    table = [];
    plans.clear();
    keywordCounts.clear();
    vi.clearAllMocks();
    mockEnrich.mockReset();
    mockEnrich.mockResolvedValue(3);
    mockEnrichPageStats.mockReset();
    mockEnrichPageStats.mockResolvedValue(0);
  });

  it("picks a never-synced connection and skips a freshly-synced one", async () => {
    addConn("due-shop.myshopify.com", { lastKeywordSyncAt: null });
    addConn("fresh-shop.myshopify.com", { lastKeywordSyncAt: new Date(now.getTime() - 1 * HOUR) });
    plans.set("due-shop.myshopify.com", "pro");
    plans.set("fresh-shop.myshopify.com", "pro");
    keywordCounts.set("due-shop.myshopify.com", 5);
    keywordCounts.set("fresh-shop.myshopify.com", 5);

    const stats = await service.tick(now);

    expect(stats.candidates).toBe(1);
    expect(stats.synced).toBe(1);
    expect(mockEnrich).toHaveBeenCalledWith(expect.anything(), "due-shop.myshopify.com", now);
    expect(mockEnrich).not.toHaveBeenCalledWith(expect.anything(), "fresh-shop.myshopify.com", now);
  });

  it("treats a connection older than the 24h staleness window as due", async () => {
    addConn("stale-shop.myshopify.com", { lastKeywordSyncAt: new Date(now.getTime() - 25 * HOUR) });
    plans.set("stale-shop.myshopify.com", "pro");
    keywordCounts.set("stale-shop.myshopify.com", 2);

    const stats = await service.tick(now);

    expect(stats.candidates).toBe(1);
    expect(stats.synced).toBe(1);
  });

  it("caps the number of shops processed per tick at MAX_SHOPS_PER_TICK (default 5)", async () => {
    for (let i = 0; i < 8; i++) {
      addConn(`shop-${i}.myshopify.com`, { lastKeywordSyncAt: null });
      plans.set(`shop-${i}.myshopify.com`, "pro");
      keywordCounts.set(`shop-${i}.myshopify.com`, 1);
    }

    const stats = await service.tick(now);

    expect(stats.candidates).toBe(5);
    expect(mockEnrich).toHaveBeenCalledTimes(5);
  });

  it("skips a shop below the pro plan WITHOUT calling GSC, but stamps lastKeywordSyncAt", async () => {
    addConn("free-shop.myshopify.com", { lastKeywordSyncAt: null });
    plans.set("free-shop.myshopify.com", "free");
    keywordCounts.set("free-shop.myshopify.com", 5);

    const stats = await service.tick(now);

    expect(stats.skippedPlan).toBe(1);
    expect(stats.synced).toBe(0);
    expect(mockEnrich).not.toHaveBeenCalled();
    expect(table[0].lastKeywordSyncAt).toEqual(now);
  });

  it("skips a shop with zero tracked SeoKeyword rows, but stamps lastKeywordSyncAt", async () => {
    addConn("no-keywords-shop.myshopify.com", { lastKeywordSyncAt: null });
    plans.set("no-keywords-shop.myshopify.com", "pro");
    keywordCounts.set("no-keywords-shop.myshopify.com", 0);

    const stats = await service.tick(now);

    expect(stats.skippedNoKeywords).toBe(1);
    expect(mockEnrich).not.toHaveBeenCalled();
    expect(table[0].lastKeywordSyncAt).toEqual(now);
  });

  it("still stamps lastKeywordSyncAt when enrichKeywordsFromGsc throws a generic error (backoff)", async () => {
    addConn("broken-shop.myshopify.com", { lastKeywordSyncAt: null });
    plans.set("broken-shop.myshopify.com", "pro");
    keywordCounts.set("broken-shop.myshopify.com", 5);
    mockEnrich.mockRejectedValueOnce(new Error("Google outage"));

    const stats = await service.tick(now);

    expect(stats.errored).toBe(1);
    expect(stats.synced).toBe(0);
    expect(table[0].lastKeywordSyncAt).toEqual(now);
  });

  it("does NOT stamp when GscReconnectRequiredError is thrown (row already deleted upstream by getGscAccessToken)", async () => {
    addConn("revoked-shop.myshopify.com", { lastKeywordSyncAt: null });
    plans.set("revoked-shop.myshopify.com", "pro");
    keywordCounts.set("revoked-shop.myshopify.com", 5);
    mockEnrich.mockRejectedValueOnce(new GscReconnectRequiredError("invalid_grant"));

    const stats = await service.tick(now);

    expect(stats.reconnectRequired).toBe(1);
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it("calls enrichPageStatsFromGsc after a successful keyword sync (Phase 3 §5.1 option b)", async () => {
    addConn("due-shop.myshopify.com", { lastKeywordSyncAt: null });
    plans.set("due-shop.myshopify.com", "pro");
    keywordCounts.set("due-shop.myshopify.com", 5);

    await service.tick(now);

    expect(mockEnrichPageStats).toHaveBeenCalledWith(expect.anything(), "due-shop.myshopify.com", now);
  });

  it("a page-stat rollup failure does not undo the keyword sync or the stamp", async () => {
    addConn("due-shop.myshopify.com", { lastKeywordSyncAt: null });
    plans.set("due-shop.myshopify.com", "pro");
    keywordCounts.set("due-shop.myshopify.com", 5);
    mockEnrichPageStats.mockRejectedValueOnce(new Error("GSC quota exceeded"));

    const stats = await service.tick(now);

    expect(stats.synced).toBe(1);
    expect(stats.errored).toBe(0);
    expect(table[0].lastKeywordSyncAt).toEqual(now);
  });

  it("ignores a connection with an empty propertyUrl (never completed property selection)", async () => {
    addConn("no-property-shop.myshopify.com", { propertyUrl: "", lastKeywordSyncAt: null });
    plans.set("no-property-shop.myshopify.com", "pro");
    keywordCounts.set("no-property-shop.myshopify.com", 5);

    const stats = await service.tick(now);

    expect(stats.candidates).toBe(0);
    expect(mockEnrich).not.toHaveBeenCalled();
  });
});
