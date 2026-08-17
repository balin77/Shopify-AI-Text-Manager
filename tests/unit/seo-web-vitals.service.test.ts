import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  allowWebVitalSample,
  recordWebVitalSample,
  getWebVitalsSummary,
} from "~/services/seo/web-vitals.service";

/**
 * Real-user web-vitals (RUM) collector — SEO tab Performance section, Phase
 * 2. Pure/offline: recordWebVitalSample/getWebVitalsSummary are exercised
 * against a hand-rolled mock `db` object (no real Prisma/Postgres), mirroring
 * seo-pagespeed.service.test.ts's approach for pagespeed.service.ts.
 */

function makeMockDb(overrides: Partial<{ create: any; findMany: any; deleteMany: any }> = {}) {
  return {
    seoWebVitalSample: {
      create: overrides.create ?? vi.fn().mockResolvedValue({ id: "sample-1" }),
      findMany: overrides.findMany ?? vi.fn().mockResolvedValue([]),
      deleteMany: overrides.deleteMany ?? vi.fn().mockResolvedValue({ count: 0 }),
    },
  };
}

describe("recordWebVitalSample", () => {
  it("persists a valid payload with normalized/clamped values", async () => {
    const db = makeMockDb();
    const ok = await recordWebVitalSample({
      db,
      shop: "shop-a.myshopify.com",
      payload: {
        path: "/products/red-shoe?variant=1#reviews",
        template: "product",
        device: "desktop",
        metrics: { lcpMs: 2345.6, cls: 0.12345, inpMs: 180, fcpMs: 900, ttfbMs: 210 },
        elements: { lcp: "img.hero", cls: "div.banner", inp: "button.add-to-cart" },
      },
    });

    expect(ok).toBe(true);
    expect(db.seoWebVitalSample.create).toHaveBeenCalledOnce();
    const { data } = db.seoWebVitalSample.create.mock.calls[0][0];
    expect(data.shop).toBe("shop-a.myshopify.com");
    // query + hash stripped
    expect(data.path).toBe("/products/red-shoe");
    expect(data.template).toBe("product");
    expect(data.device).toBe("desktop");
    expect(data.lcpMs).toBe(2346); // rounded to integer
    expect(data.cls).toBe(0.1235); // rounded to 4 decimals
    expect(data.inpMs).toBe(180);
    expect(data.fcpMs).toBe(900);
    expect(data.ttfbMs).toBe(210);
    expect(data.lcpElement).toBe("img.hero");
    expect(data.clsElement).toBe("div.banner");
    expect(data.inpElement).toBe("button.add-to-cart");
  });

  it("defaults device to mobile for anything other than the exact string 'desktop'", async () => {
    const db = makeMockDb();
    await recordWebVitalSample({
      db,
      shop: "shop-a.myshopify.com",
      payload: { path: "/", template: "index", device: "Desktop", metrics: { lcpMs: 100 } },
    });
    expect(db.seoWebVitalSample.create.mock.calls[0][0].data.device).toBe("mobile");

    const db2 = makeMockDb();
    await recordWebVitalSample({
      db: db2,
      shop: "shop-a.myshopify.com",
      payload: { path: "/", template: "index", metrics: { lcpMs: 100 } },
    });
    expect(db2.seoWebVitalSample.create.mock.calls[0][0].data.device).toBe("mobile");
  });

  it("rejects a non-object payload", async () => {
    const db = makeMockDb();
    expect(await recordWebVitalSample({ db, shop: "s", payload: null })).toBe(false);
    expect(await recordWebVitalSample({ db, shop: "s", payload: "nope" })).toBe(false);
    expect(await recordWebVitalSample({ db, shop: "s", payload: 42 })).toBe(false);
    expect(await recordWebVitalSample({ db, shop: "s", payload: undefined })).toBe(false);
    expect(db.seoWebVitalSample.create).not.toHaveBeenCalled();
  });

  it("rejects a payload missing path", async () => {
    const db = makeMockDb();
    const ok = await recordWebVitalSample({
      db,
      shop: "s",
      payload: { template: "product", metrics: { lcpMs: 100 } },
    });
    expect(ok).toBe(false);
    expect(db.seoWebVitalSample.create).not.toHaveBeenCalled();
  });

  it("rejects a payload whose path lacks a leading slash", async () => {
    const db = makeMockDb();
    const ok = await recordWebVitalSample({
      db,
      shop: "s",
      payload: { path: "products/foo", template: "product", metrics: { lcpMs: 100 } },
    });
    expect(ok).toBe(false);
    expect(db.seoWebVitalSample.create).not.toHaveBeenCalled();
  });

  it("rejects a payload missing/empty template", async () => {
    const db = makeMockDb();
    expect(
      await recordWebVitalSample({ db, shop: "s", payload: { path: "/", metrics: { lcpMs: 100 } } }),
    ).toBe(false);
    expect(
      await recordWebVitalSample({
        db,
        shop: "s",
        payload: { path: "/", template: "", metrics: { lcpMs: 100 } },
      }),
    ).toBe(false);
    expect(db.seoWebVitalSample.create).not.toHaveBeenCalled();
  });

  it("rejects a payload where no metric survives validation", async () => {
    const db = makeMockDb();
    const ok = await recordWebVitalSample({
      db,
      shop: "s",
      payload: {
        path: "/",
        template: "index",
        metrics: { lcpMs: -1, cls: "not a number", inpMs: NaN, fcpMs: Infinity },
      },
    });
    expect(ok).toBe(false);
    expect(db.seoWebVitalSample.create).not.toHaveBeenCalled();
  });

  it("accepts a payload with only a single surviving metric", async () => {
    const db = makeMockDb();
    const ok = await recordWebVitalSample({
      db,
      shop: "s",
      payload: { path: "/", template: "index", metrics: { cls: 0.01 } },
    });
    expect(ok).toBe(true);
    const { data } = db.seoWebVitalSample.create.mock.calls[0][0];
    expect(data.cls).toBe(0.01);
    expect(data.lcpMs).toBeNull();
    expect(data.inpMs).toBeNull();
    expect(data.fcpMs).toBeNull();
    expect(data.ttfbMs).toBeNull();
  });

  it("drops a negative metric value (stored null) but keeps other surviving metrics", async () => {
    const db = makeMockDb();
    const ok = await recordWebVitalSample({
      db,
      shop: "s",
      payload: { path: "/", template: "index", metrics: { lcpMs: -50, inpMs: 100 } },
    });
    expect(ok).toBe(true);
    const { data } = db.seoWebVitalSample.create.mock.calls[0][0];
    expect(data.lcpMs).toBeNull();
    expect(data.inpMs).toBe(100);
  });

  it("clamps an oversized ms metric to the 120000ms ceiling", async () => {
    const db = makeMockDb();
    await recordWebVitalSample({
      db,
      shop: "s",
      payload: { path: "/", template: "index", metrics: { lcpMs: 999_999 } },
    });
    expect(db.seoWebVitalSample.create.mock.calls[0][0].data.lcpMs).toBe(120_000);
  });

  it("clamps an oversized cls value to the 10 ceiling", async () => {
    const db = makeMockDb();
    await recordWebVitalSample({
      db,
      shop: "s",
      payload: { path: "/", template: "index", metrics: { cls: 999 } },
    });
    expect(db.seoWebVitalSample.create.mock.calls[0][0].data.cls).toBe(10);
  });

  it("truncates path to 512 chars, template to 64 chars, and element labels to 120 chars", async () => {
    const db = makeMockDb();
    const longPath = "/" + "a".repeat(1000);
    const longTemplate = "t".repeat(200);
    const longElement = "e".repeat(300);
    await recordWebVitalSample({
      db,
      shop: "s",
      payload: {
        path: longPath,
        template: longTemplate,
        metrics: { lcpMs: 100 },
        elements: { lcp: longElement },
      },
    });
    const { data } = db.seoWebVitalSample.create.mock.calls[0][0];
    expect(data.path.length).toBe(512);
    expect(data.template.length).toBe(64);
    expect(data.lcpElement.length).toBe(120);
  });

  it("stores null for a missing/non-string element label", async () => {
    const db = makeMockDb();
    await recordWebVitalSample({
      db,
      shop: "s",
      payload: { path: "/", template: "index", metrics: { lcpMs: 100 }, elements: { lcp: 42 } },
    });
    expect(db.seoWebVitalSample.create.mock.calls[0][0].data.lcpElement).toBeNull();
  });

  it("returns false (no unhandled rejection) when the DB create throws", async () => {
    const db = makeMockDb({ create: vi.fn().mockRejectedValue(new Error("db down")) });
    await expect(
      recordWebVitalSample({
        db,
        shop: "s",
        payload: { path: "/", template: "index", metrics: { lcpMs: 100 } },
      }),
    ).resolves.toBe(false);
  });

  it("still returns true when the create succeeds but the retention prune throws", async () => {
    const db = makeMockDb({ deleteMany: vi.fn().mockRejectedValue(new Error("prune failed")) });
    const ok = await recordWebVitalSample({
      db,
      shop: "prune-fail-shop",
      payload: { path: "/", template: "index", metrics: { lcpMs: 100 } },
    });
    expect(ok).toBe(true);
  });

  it("prunes retention on the first write for a shop, and every 50th write thereafter", async () => {
    const db = makeMockDb();
    const shop = `prune-shop-${Math.random()}`;
    const payload = { path: "/", template: "index", metrics: { lcpMs: 100 } };

    await recordWebVitalSample({ db, shop, payload });
    expect(db.seoWebVitalSample.deleteMany).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 48; i++) {
      await recordWebVitalSample({ db, shop, payload });
    }
    // Writes 2..49 (48 more) should not have pruned again.
    expect(db.seoWebVitalSample.deleteMany).toHaveBeenCalledTimes(1);

    // 50th write triggers the next prune.
    await recordWebVitalSample({ db, shop, payload });
    expect(db.seoWebVitalSample.deleteMany).toHaveBeenCalledTimes(2);

    const [args] = db.seoWebVitalSample.deleteMany.mock.calls[1];
    expect(args.where.shop).toBe(shop);
    expect(args.where.createdAt.lt).toBeInstanceOf(Date);
  });
});

describe("allowWebVitalSample", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-21T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows a burst up to capacity (120) and blocks the next sample", () => {
    const shop = `burst-${Math.random()}.myshopify.com`;
    for (let i = 0; i < 120; i++) {
      expect(allowWebVitalSample(shop)).toBe(true);
    }
    expect(allowWebVitalSample(shop)).toBe(false);
  });

  it("refills over time at 120/min", () => {
    const shop = `refill-${Math.random()}.myshopify.com`;
    for (let i = 0; i < 120; i++) allowWebVitalSample(shop);
    expect(allowWebVitalSample(shop)).toBe(false); // drained

    // 30s later => 60 tokens refilled (120/min * 0.5min).
    vi.setSystemTime(new Date(Date.now() + 30_000));
    for (let i = 0; i < 60; i++) {
      expect(allowWebVitalSample(shop)).toBe(true);
    }
    expect(allowWebVitalSample(shop)).toBe(false);
  });

  it("isolates buckets per shop — draining one shop does not affect another", () => {
    const shopA = `isolation-a-${Math.random()}.myshopify.com`;
    const shopB = `isolation-b-${Math.random()}.myshopify.com`;
    for (let i = 0; i < 120; i++) allowWebVitalSample(shopA);
    expect(allowWebVitalSample(shopA)).toBe(false);
    expect(allowWebVitalSample(shopB)).toBe(true);
  });
});

describe("getWebVitalsSummary", () => {
  it("computes exact p75 over a known dataset and echoes totalSamples/windowDays", async () => {
    // 8 samples of the same (template, device) bucket -> p75 index = ceil(0.75*8)-1 = 5
    // (0-indexed 6th smallest value).
    const lcpValues = [100, 200, 300, 400, 500, 600, 700, 800];
    const rows = lcpValues.map((lcpMs, i) => ({
      path: `/p${i}`,
      template: "product",
      device: "mobile",
      lcpMs,
      cls: null,
      inpMs: null,
      lcpElement: null,
      clsElement: null,
      inpElement: null,
    }));
    const db = makeMockDb({ findMany: vi.fn().mockResolvedValue(rows) });

    const summary = await getWebVitalsSummary({ db, shop: "s" });
    expect(summary.totalSamples).toBe(8);
    expect(summary.windowDays).toBe(28);
    expect(summary.rows).toHaveLength(1);
    // sorted ascending: [100..800], index ceil(6)-1=5 -> value 600
    expect(summary.rows[0].lcpP75Ms).toBe(600);
    expect(summary.rows[0].samples).toBe(8);
  });

  it("groups rows into (template, device) buckets and sorts by sample count desc", async () => {
    const rows = [
      { path: "/a", template: "product", device: "mobile", lcpMs: 100, cls: null, inpMs: null, lcpElement: null, clsElement: null, inpElement: null },
      { path: "/b", template: "product", device: "mobile", lcpMs: 200, cls: null, inpMs: null, lcpElement: null, clsElement: null, inpElement: null },
      { path: "/c", template: "product", device: "desktop", lcpMs: 300, cls: null, inpMs: null, lcpElement: null, clsElement: null, inpElement: null },
      { path: "/d", template: "collection", device: "mobile", lcpMs: 400, cls: null, inpMs: null, lcpElement: null, clsElement: null, inpElement: null },
      { path: "/e", template: "collection", device: "mobile", lcpMs: 500, cls: null, inpMs: null, lcpElement: null, clsElement: null, inpElement: null },
      { path: "/f", template: "collection", device: "mobile", lcpMs: 600, cls: null, inpMs: null, lcpElement: null, clsElement: null, inpElement: null },
    ];
    const db = makeMockDb({ findMany: vi.fn().mockResolvedValue(rows) });
    const summary = await getWebVitalsSummary({ db, shop: "s" });

    expect(summary.rows).toHaveLength(3);
    // collection/mobile has 3 samples -> first.
    expect(summary.rows[0]).toMatchObject({ template: "collection", device: "mobile", samples: 3 });
    // product/mobile and product/desktop both have fewer samples.
    const productMobile = summary.rows.find((r) => r.template === "product" && r.device === "mobile");
    const productDesktop = summary.rows.find((r) => r.template === "product" && r.device === "desktop");
    expect(productMobile?.samples).toBe(2);
    expect(productDesktop?.samples).toBe(1);
  });

  it("only surfaces slow paths with >=5 samples carrying lcpMs, worst-first, capped at 10", async () => {
    const rows: any[] = [];
    // path /busy gets 6 samples with increasing lcp (p75 will be high).
    for (let i = 0; i < 6; i++) {
      rows.push({ path: "/busy", template: "product", device: "mobile", lcpMs: 1000 + i * 100, cls: null, inpMs: null, lcpElement: null, clsElement: null, inpElement: null });
    }
    // path /rare gets only 4 samples -> excluded even though lcp is huge.
    for (let i = 0; i < 4; i++) {
      rows.push({ path: "/rare", template: "product", device: "mobile", lcpMs: 5000, cls: null, inpMs: null, lcpElement: null, clsElement: null, inpElement: null });
    }
    // path /medium gets 5 samples, lower lcp than /busy.
    for (let i = 0; i < 5; i++) {
      rows.push({ path: "/medium", template: "product", device: "mobile", lcpMs: 500, cls: null, inpMs: null, lcpElement: null, clsElement: null, inpElement: null });
    }
    const db = makeMockDb({ findMany: vi.fn().mockResolvedValue(rows) });
    const summary = await getWebVitalsSummary({ db, shop: "s" });

    expect(summary.slowPaths.map((p) => p.path)).toEqual(["/busy", "/medium"]);
    expect(summary.slowPaths[0].samples).toBe(6);
    // sorted worst-first (desc lcpP75Ms)
    expect(summary.slowPaths[0].lcpP75Ms).toBeGreaterThan(summary.slowPaths[1].lcpP75Ms);
  });

  it("counts element occurrences per kind, top 10 across all kinds sorted desc", async () => {
    const rows = [
      { path: "/a", template: "product", device: "mobile", lcpMs: null, cls: null, inpMs: null, lcpElement: "img.hero", clsElement: null, inpElement: null },
      { path: "/b", template: "product", device: "mobile", lcpMs: null, cls: null, inpMs: null, lcpElement: "img.hero", clsElement: null, inpElement: null },
      { path: "/c", template: "product", device: "mobile", lcpMs: null, cls: null, inpMs: null, lcpElement: "img.hero", clsElement: null, inpElement: null },
      { path: "/d", template: "product", device: "mobile", lcpMs: null, cls: null, inpMs: null, lcpElement: null, clsElement: "div.banner", inpElement: null },
      { path: "/e", template: "product", device: "mobile", lcpMs: null, cls: null, inpMs: null, lcpElement: null, clsElement: "div.banner", inpElement: null },
      { path: "/f", template: "product", device: "mobile", lcpMs: null, cls: null, inpMs: null, lcpElement: null, clsElement: null, inpElement: "button.cta" },
    ];
    const db = makeMockDb({ findMany: vi.fn().mockResolvedValue(rows) });
    const summary = await getWebVitalsSummary({ db, shop: "s" });

    expect(summary.elements[0]).toEqual({ kind: "lcp", label: "img.hero", occurrences: 3 });
    expect(summary.elements[1]).toEqual({ kind: "cls", label: "div.banner", occurrences: 2 });
    expect(summary.elements[2]).toEqual({ kind: "inp", label: "button.cta", occurrences: 1 });
    expect(summary.elements.length).toBeLessThanOrEqual(10);
  });

  it("returns null p75 for a metric no sample in the bucket carried", async () => {
    const rows = [
      { path: "/a", template: "product", device: "mobile", lcpMs: 100, cls: null, inpMs: null, lcpElement: null, clsElement: null, inpElement: null },
    ];
    const db = makeMockDb({ findMany: vi.fn().mockResolvedValue(rows) });
    const summary = await getWebVitalsSummary({ db, shop: "s" });
    expect(summary.rows[0].clsP75).toBeNull();
    expect(summary.rows[0].inpP75Ms).toBeNull();
    expect(summary.rows[0].lcpP75Ms).toBe(100);
  });

  it("passes shop/window/cap through to the findMany query", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const db = makeMockDb({ findMany });
    await getWebVitalsSummary({ db, shop: "shop-x", days: 7 });
    const [args] = findMany.mock.calls[0];
    expect(args.where.shop).toBe("shop-x");
    expect(args.take).toBe(20_000);
    expect(args.where.createdAt.gte).toBeInstanceOf(Date);
  });
});
