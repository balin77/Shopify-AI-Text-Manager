import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

// The module builds its Prisma client at import time; hand it a mock first.
const productImage = { deleteMany: vi.fn() };
const task = { findMany: vi.fn() };
beforeAll(() => {
  (globalThis as any).__db = { productImage, task, session: { findMany: vi.fn(), findFirst: vi.fn() } };
});

vi.mock("../../app/utils/shop-access-token.js", () => ({
  resolveShopAccessToken: vi.fn(async () => ({ token: "tok" })),
}));

type Page = { ids: string[]; hasNextPage: boolean; endCursor?: string | null } | "gone" | "error";

function fetchFrom(pages: Page[]) {
  const calls: any[] = [];
  const impl = vi.fn(async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    calls.push(body.variables);
    const p = pages[calls.length - 1];
    if (p === "error") return { ok: false, status: 502, json: async () => ({}) } as any;
    if (p === "gone" || p === undefined) return { ok: true, json: async () => ({ data: { product: null } }) } as any;
    return {
      ok: true,
      json: async () => ({
        data: {
          product: {
            media: {
              edges: p.ids.map((id) => ({ node: { id } })),
              pageInfo: { hasNextPage: p.hasNextPage, endCursor: p.endCursor ?? null },
            },
          },
        },
      }),
    } as any;
  });
  return { impl, calls };
}

const ids = (n: number, from = 0) => Array.from({ length: n }, (_, i) => `gid://shopify/MediaImage/${from + i}`);

describe("fetchProductMediaIds pages to the end", () => {
  let mod: typeof import("../../stale-image-cleanup.service.js");
  beforeAll(async () => {
    mod = await import("../../stale-image-cleanup.service.js");
  });

  it("follows the cursor across pages and returns every id", async () => {
    const { impl, calls } = fetchFrom([
      { ids: ids(250), hasNextPage: true, endCursor: "c1" },
      { ids: ids(30, 250), hasNextPage: false },
    ]);
    const out = await mod.fetchProductMediaIds("s.myshopify.com", "t", "gid://shopify/Product/1", { fetchImpl: impl });
    expect(out).toHaveLength(280);
    expect(calls.map((c) => c.after)).toEqual([null, "c1"]);
  });

  it("answers null only when the FIRST page reports the product gone", async () => {
    const { impl } = fetchFrom(["gone"]);
    expect(await mod.fetchProductMediaIds("s", "t", "p", { fetchImpl: impl })).toBeNull();
  });

  it("throws when a later page fails, vanishes, lacks a cursor or the page budget runs out", async () => {
    for (const pages of [
      [{ ids: ids(250), hasNextPage: true, endCursor: "c1" }, "error"],
      [{ ids: ids(250), hasNextPage: true, endCursor: "c1" }, "gone"],
      [{ ids: ids(250), hasNextPage: true, endCursor: null }],
    ] as Page[][]) {
      const { impl } = fetchFrom(pages);
      await expect(mod.fetchProductMediaIds("s", "t", "p", { fetchImpl: impl })).rejects.toThrow();
    }
    const { impl } = fetchFrom([
      { ids: ids(1), hasNextPage: true, endCursor: "a" },
      { ids: ids(1, 1), hasNextPage: true, endCursor: "b" },
    ]);
    await expect(mod.fetchProductMediaIds("s", "t", "p", { fetchImpl: impl, maxPages: 2 })).rejects.toThrow(/truncated/);
  });

  it("throws on a response without pageInfo instead of trusting one page", async () => {
    const impl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: { product: { media: { edges: [{ node: { id: "x" } }] } } } }),
    })) as any;
    await expect(mod.fetchProductMediaIds("s", "t", "p", { fetchImpl: impl })).rejects.toThrow();
  });
});

describe("runOnce never deletes on an incomplete read", () => {
  beforeEach(() => {
    productImage.deleteMany.mockReset().mockResolvedValue({ count: 0 });
    task.findMany.mockReset().mockResolvedValue([{ shop: "s.myshopify.com", resourceId: "gid://shopify/Product/1" }]);
    vi.useFakeTimers({ toFake: ["setTimeout"] });
  });

  it("skips the product when the second media page fails", async () => {
    const mod = await import("../../stale-image-cleanup.service.js");
    const { impl } = fetchFrom([{ ids: ids(250), hasNextPage: true, endCursor: "c1" }, "error"]);
    const realFetch = globalThis.fetch;
    (globalThis as any).fetch = impl;
    try {
      const svc = new mod.StaleImageCleanupService();
      const run = svc.runOnce();
      await vi.runAllTimersAsync();
      const res = await run;
      expect(res.skipped).toBe(1);
      expect(res.reconciled).toBe(0);
      // Only the phase-1 staged-URL delete ran; no per-product delete.
      expect(productImage.deleteMany).toHaveBeenCalledTimes(1);
      expect(productImage.deleteMany.mock.calls[0][0].where.url).toBeDefined();
    } finally {
      (globalThis as any).fetch = realFetch;
      vi.useRealTimers();
    }
  });

  it("deletes against the FULL paged list", async () => {
    const mod = await import("../../stale-image-cleanup.service.js");
    const { impl } = fetchFrom([
      { ids: ids(250), hasNextPage: true, endCursor: "c1" },
      { ids: ids(5, 250), hasNextPage: false },
    ]);
    const realFetch = globalThis.fetch;
    (globalThis as any).fetch = impl;
    try {
      const svc = new mod.StaleImageCleanupService();
      const run = svc.runOnce();
      await vi.runAllTimersAsync();
      await run;
      const reconcile = productImage.deleteMany.mock.calls[1][0];
      expect(reconcile.where.mediaId.notIn).toHaveLength(255);
      expect(reconcile.where.mediaId.notIn).toContain("gid://shopify/MediaImage/254");
    } finally {
      (globalThis as any).fetch = realFetch;
      vi.useRealTimers();
    }
  });
});
