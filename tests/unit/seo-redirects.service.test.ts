import { describe, it, expect, vi } from "vitest";
import {
  validateRedirect,
  normalize404Path,
  record404Hit,
  analyze404,
  allow404Hit,
  MAX_404_HITS_PER_SHOP,
} from "~/services/seo/redirects.service";

/**
 * Phase 3 pure/DB logic: redirect validation, 404 path normalization, the
 * upsert-increment + FIFO-prune of record404Hit, and the analyze404 summary.
 * GraphQL wrappers are integration-only and not covered here.
 */

describe("validateRedirect", () => {
  it("rejects an empty or root-only source path", () => {
    expect(validateRedirect({ path: "", target: "/x" })).toBe("pathRequired");
    expect(validateRedirect({ path: "/", target: "/x" })).toBe("pathRequired");
  });
  it("requires a leading slash on the source", () => {
    expect(validateRedirect({ path: "old", target: "/x" })).toBe("pathLeadingSlash");
  });
  it("requires a target", () => {
    expect(validateRedirect({ path: "/old", target: "" })).toBe("targetRequired");
  });
  it("rejects a self-loop", () => {
    expect(validateRedirect({ path: "/old", target: "/old" })).toBe("loop");
  });
  it("accepts a valid pair and trims whitespace", () => {
    expect(validateRedirect({ path: "/old", target: "/new" })).toBeNull();
    expect(validateRedirect({ path: "  /old  ", target: "  /new  " })).toBeNull();
  });
});

describe("normalize404Path", () => {
  it("strips an absolute URL's query string entirely (path-only dedup)", () => {
    expect(normalize404Path("https://shop.com/foo/bar?x=1")).toBe("/foo/bar");
  });
  it("strips a query string on a bare relative path too (utm_*/fbclid/gclid etc.)", () => {
    expect(normalize404Path("/foo/bar?utm_source=x&fbclid=abc")).toBe("/foo/bar");
    expect(normalize404Path("foo?x=1")).toBe("/foo");
  });
  it("adds a leading slash and trims trailing slashes", () => {
    expect(normalize404Path("foo")).toBe("/foo");
    expect(normalize404Path("/foo/")).toBe("/foo");
    expect(normalize404Path("/foo///")).toBe("/foo");
  });
  it("keeps root and handles empty", () => {
    expect(normalize404Path("/")).toBe("/");
    expect(normalize404Path("")).toBe("");
  });
});

function makeDb(total: number, stale: Array<{ id: string }> = [], upsertResult: { count: number } = { count: 1 }) {
  const calls = {
    upsert: vi.fn(async (_args: any) => upsertResult),
    count: vi.fn(async (_args: any) => total),
    findMany: vi.fn(async (_args: any) => stale),
    deleteMany: vi.fn(async (_args: any) => ({ count: stale.length })),
  };
  const db = { seo404Hit: calls } as any;
  return { db, calls };
}

describe("record404Hit", () => {
  it("ignores an empty path", async () => {
    const { db, calls } = makeDb(0);
    expect(await record404Hit(db, "s.myshopify.com", { path: "" })).toBe(false);
    expect(calls.upsert).not.toHaveBeenCalled();
  });

  it("upserts the normalized path under a (shop, pathHash) key", async () => {
    const { db, calls } = makeDb(1);
    const ok = await record404Hit(db, "s.myshopify.com", { path: "/missing/", referrer: "http://ref" });
    expect(ok).toBe(true);
    const arg = calls.upsert.mock.calls[0][0];
    expect(arg.where.shop_pathHash.shop).toBe("s.myshopify.com");
    expect(typeof arg.where.shop_pathHash.pathHash).toBe("string");
    expect(arg.create.path).toBe("/missing"); // trailing slash trimmed
    expect(arg.update.count).toEqual({ increment: 1 });
    expect(arg.update.referrer).toBe("http://ref");
  });

  it("does not overwrite a known referrer with a null one on a follow-up hit", async () => {
    const { db, calls } = makeDb(1);
    await record404Hit(db, "s.myshopify.com", { path: "/x" }); // no referrer this time
    const arg = calls.upsert.mock.calls[0][0];
    expect(arg.create.referrer).toBeNull(); // still fine on first-ever creation
    expect(arg.update).not.toHaveProperty("referrer"); // must NOT clobber an existing one
  });

  it("evicts by lowest count first, then oldest lastSeenAt, once over the cap", async () => {
    const stale = [{ id: "a" }, { id: "b" }];
    // Only new rows (upsert count === 1) trigger the prune check.
    const { db, calls } = makeDb(MAX_404_HITS_PER_SHOP + 2, stale, { count: 1 });
    await record404Hit(db, "s.myshopify.com", { path: "/x" });
    expect(calls.findMany).toHaveBeenCalled();
    const pruneArgs = calls.findMany.mock.calls[0][0];
    expect(pruneArgs.orderBy).toEqual([{ count: "asc" }, { lastSeenAt: "asc" }]);
    expect(pruneArgs.take).toBe(2);
    expect(calls.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["a", "b"] } } });
  });

  it("does not prune when under the cap", async () => {
    const { db, calls } = makeDb(5, [], { count: 1 });
    await record404Hit(db, "s.myshopify.com", { path: "/x" });
    expect(calls.deleteMany).not.toHaveBeenCalled();
  });

  it("skips the prune check entirely for a repeat hit (count > 1) — only new rows probe the total", async () => {
    // Total is deliberately over the cap; if the (expensive) prune check ran
    // on every hit it would still show up as a `count` call.
    const { db, calls } = makeDb(MAX_404_HITS_PER_SHOP + 5, [], { count: 5 });
    await record404Hit(db, "s.myshopify.com", { path: "/x" });
    expect(calls.count).not.toHaveBeenCalled();
    expect(calls.findMany).not.toHaveBeenCalled();
    expect(calls.deleteMany).not.toHaveBeenCalled();
  });
});

describe("allow404Hit — per-shop token bucket for the 404 beacon", () => {
  // Buckets live in a module-level Map with no reset export, so each test
  // uses its own shop id to stay isolated from other tests in this file.
  const T0 = Date.parse("2026-07-01T00:00:00Z");

  it("allows a burst up to capacity (30) and blocks the next hit", () => {
    const shop = "burst.myshopify.com";
    for (let i = 0; i < 30; i++) {
      expect(allow404Hit(shop, T0)).toBe(true);
    }
    expect(allow404Hit(shop, T0)).toBe(false);
  });

  it("stays blocked while drained and no time has passed", () => {
    const shop = "drained.myshopify.com";
    for (let i = 0; i < 30; i++) allow404Hit(shop, T0);
    expect(allow404Hit(shop, T0)).toBe(false);
    expect(allow404Hit(shop, T0)).toBe(false);
  });

  it("refills over time at 10 tokens/min (fake clock, no real sleeps)", () => {
    const shop = "refill.myshopify.com";
    for (let i = 0; i < 30; i++) allow404Hit(shop, T0);
    expect(allow404Hit(shop, T0)).toBe(false); // drained

    // 30s later => 5 tokens refilled (10/min * 0.5min).
    const t1 = T0 + 30_000;
    expect(allow404Hit(shop, t1)).toBe(true);
    expect(allow404Hit(shop, t1)).toBe(true);
    expect(allow404Hit(shop, t1)).toBe(true);
    expect(allow404Hit(shop, t1)).toBe(true);
    expect(allow404Hit(shop, t1)).toBe(true);
    expect(allow404Hit(shop, t1)).toBe(false); // only 5 available, 6th denied

    // A full minute after THAT (tokens were fully drained again at t1) =>
    // 10 more tokens refill (10/min * 1min).
    const t2 = t1 + 60_000;
    for (let i = 0; i < 10; i++) {
      expect(allow404Hit(shop, t2)).toBe(true);
    }
    expect(allow404Hit(shop, t2)).toBe(false);

    // A long idle period afterward refills back up to the capacity cap (30),
    // never beyond it.
    const t3 = t2 + 10 * 60_000; // 10 min later => 100 tokens worth, capped at 30
    for (let i = 0; i < 30; i++) {
      expect(allow404Hit(shop, t3)).toBe(true);
    }
    expect(allow404Hit(shop, t3)).toBe(false);
  });

  it("isolates buckets per shop — draining one shop does not affect another", () => {
    const shopA = "isolation-a.myshopify.com";
    const shopB = "isolation-b.myshopify.com";
    for (let i = 0; i < 30; i++) allow404Hit(shopA, T0);
    expect(allow404Hit(shopA, T0)).toBe(false);
    // shopB's bucket is untouched and full.
    expect(allow404Hit(shopB, T0)).toBe(true);
  });

  it("cleans up stale (idle > 1h) buckets without disrupting a still-active shop", () => {
    const idleShop = "idle.myshopify.com";
    const activeShop = "active.myshopify.com";

    // idleShop hits once, then goes quiet.
    expect(allow404Hit(idleShop, T0)).toBe(true);

    // activeShop stays active across the same window, refilling normally.
    const tLater = T0 + 90 * 60 * 1000; // 90 min later — idleShop is now stale (>1h)
    expect(allow404Hit(activeShop, tLater)).toBe(true);

    // idleShop's stale bucket gets purged on the next access; it comes back
    // with a fresh full bucket rather than an error or a leftover state.
    for (let i = 0; i < 30; i++) {
      expect(allow404Hit(idleShop, tLater)).toBe(true);
    }
    expect(allow404Hit(idleShop, tLater)).toBe(false);

    // activeShop's own budget was never disturbed by idleShop's cleanup.
    expect(allow404Hit(activeShop, tLater)).toBe(true);
  });
});

describe("analyze404", () => {
  it("returns the new-hit count and top paths", async () => {
    const db = {
      seo404Hit: {
        count: vi.fn(async () => 3),
        findMany: vi.fn(async () => [
          { path: "/a", count: 9 },
          { path: "/b", count: 4 },
        ]),
      },
    } as any;
    const result = await analyze404(db, "s.myshopify.com");
    expect(result.newCount).toBe(3);
    expect(result.topPaths).toEqual([
      { path: "/a", count: 9 },
      { path: "/b", count: 4 },
    ]);
  });
});
