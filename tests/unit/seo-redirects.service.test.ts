import { describe, it, expect, vi } from "vitest";
import {
  validateRedirect,
  normalize404Path,
  record404Hit,
  analyze404,
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
  it("strips an absolute URL to path+query", () => {
    expect(normalize404Path("https://shop.com/foo/bar?x=1")).toBe("/foo/bar?x=1");
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

function makeDb(total: number, stale: Array<{ id: string }> = []) {
  const calls = {
    upsert: vi.fn(async (_args: any) => ({})),
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
  });

  it("FIFO-prunes the oldest rows once over the cap", async () => {
    const stale = [{ id: "a" }, { id: "b" }];
    const { db, calls } = makeDb(MAX_404_HITS_PER_SHOP + 2, stale);
    await record404Hit(db, "s.myshopify.com", { path: "/x" });
    expect(calls.findMany).toHaveBeenCalled();
    const pruneArgs = calls.findMany.mock.calls[0][0];
    expect(pruneArgs.orderBy).toEqual({ lastSeenAt: "asc" });
    expect(pruneArgs.take).toBe(2);
    expect(calls.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["a", "b"] } } });
  });

  it("does not prune when under the cap", async () => {
    const { db, calls } = makeDb(5);
    await record404Hit(db, "s.myshopify.com", { path: "/x" });
    expect(calls.deleteMany).not.toHaveBeenCalled();
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
