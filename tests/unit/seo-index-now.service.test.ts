import { describe, it, expect, vi, afterEach } from "vitest";
import {
  generateIndexNowKey,
  keyLocationFor,
  storefrontUrl,
  buildSubmitBody,
  chunkUrls,
  submitUrls,
  collectStoreUrls,
  drainQueue,
  enqueueIndexNowUrl,
  enqueueResource,
  getEnabledConfig,
  provisionIndexNow,
  INDEXNOW_MAX_URLS_PER_REQUEST,
} from "~/services/seo/index-now.service";

/** Phase 8 IndexNow pure helpers + the submit/collect logic (fetch mocked). */

describe("generateIndexNowKey", () => {
  it("is 32 hex chars and reasonably unique", () => {
    const a = generateIndexNowKey();
    const b = generateIndexNowKey();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });
});

describe("URL builders", () => {
  it("keyLocationFor uses the app-proxy path on the shop host", () => {
    expect(keyLocationFor("s.myshopify.com")).toBe("https://s.myshopify.com/apps/contentpilot/indexnow-key");
  });
  it("storefrontUrl builds per-type paths", () => {
    expect(storefrontUrl("s.myshopify.com", "product", "blue-shoe")).toBe("https://s.myshopify.com/products/blue-shoe");
    expect(storefrontUrl("s.myshopify.com", "collection", "footwear")).toBe("https://s.myshopify.com/collections/footwear");
    expect(storefrontUrl("s.myshopify.com", "page", "about")).toBe("https://s.myshopify.com/pages/about");
  });
});

describe("buildSubmitBody", () => {
  it("matches the IndexNow payload shape", () => {
    expect(buildSubmitBody("s.myshopify.com", "KEY", "https://s.myshopify.com/k", ["https://s.myshopify.com/products/a"])).toEqual({
      host: "s.myshopify.com",
      key: "KEY",
      keyLocation: "https://s.myshopify.com/k",
      urlList: ["https://s.myshopify.com/products/a"],
    });
  });
});

describe("chunkUrls", () => {
  it("splits into <=10k chunks", () => {
    const urls = Array.from({ length: 25 }, (_, i) => `u${i}`);
    expect(chunkUrls(urls, 10).map((c) => c.length)).toEqual([10, 10, 5]);
  });
  it("a full catalog under the cap is a single chunk", () => {
    const urls = Array.from({ length: 3500 }, (_, i) => `u${i}`);
    expect(chunkUrls(urls).length).toBe(1);
    expect(INDEXNOW_MAX_URLS_PER_REQUEST).toBe(10000);
  });
});

describe("submitUrls", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("counts a 200 response as submitted", async () => {
    const fetchMock = vi.fn(async (_url: any, _init: any) => ({ ok: true, status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await submitUrls("s.myshopify.com", "KEY", "https://s/k", ["https://s/products/a", "https://s/products/b"]);
    expect(r).toEqual({ submitted: 2, chunks: 1, failed: 2 - 2 });
    // body is valid JSON with the IndexNow shape
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.urlList).toHaveLength(2);
    expect(body.key).toBe("KEY");
  });

  it("counts a non-ok response as failed (and never throws)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 403 })));
    const r = await submitUrls("s", "KEY", "https://s/k", ["https://s/products/a"]);
    expect(r.failed).toBe(1);
    expect(r.submitted).toBe(0);
  });
});

describe("drainQueue — partial-failure safety", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("does NOT delete rows or bump lastSubmittedAt when any chunk fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500 })));
    const deleteMany = vi.fn(async () => ({ count: 0 }));
    const updateMany = vi.fn(async () => ({ count: 0 }));
    const db = {
      seoIndexNowConfig: {
        findUnique: async () => ({ shop: "s", key: "K", keyLocation: "https://s/k", enabled: true }),
        updateMany,
      },
      seoIndexNowQueue: {
        findMany: async () => [{ id: "q1", url: "https://s/products/a" }],
        deleteMany,
      },
    } as any;
    const r = await drainQueue(db, "s", "s");
    expect(r.failed).toBeGreaterThan(0);
    expect(deleteMany).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("clears the queue and stamps lastSubmittedAt on full success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200 })));
    const deleteMany = vi.fn(async () => ({ count: 1 }));
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const db = {
      seoIndexNowConfig: {
        findUnique: async () => ({ shop: "s", key: "K", keyLocation: "https://s/k", enabled: true }),
        updateMany,
      },
      seoIndexNowQueue: {
        findMany: async () => [{ id: "q1", url: "https://s/products/a" }],
        deleteMany,
      },
    } as any;
    const r = await drainQueue(db, "s", "s");
    expect(r.failed).toBe(0);
    expect(deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["q1"] } } });
    expect(updateMany).toHaveBeenCalled();
  });
});

describe("enqueueIndexNowUrl — no-op unless enabled", () => {
  it("does nothing when there is no config", async () => {
    const upsert = vi.fn();
    const db = { seoIndexNowConfig: { findUnique: async () => null }, seoIndexNowQueue: { upsert } } as any;
    await enqueueIndexNowUrl(db, "s", "https://s/products/a");
    expect(upsert).not.toHaveBeenCalled();
  });
  it("does nothing when config is disabled", async () => {
    const upsert = vi.fn();
    const db = {
      seoIndexNowConfig: { findUnique: async () => ({ enabled: false }) },
      seoIndexNowQueue: { upsert },
    } as any;
    await enqueueIndexNowUrl(db, "s", "https://s/products/a");
    expect(upsert).not.toHaveBeenCalled();
  });
});

describe("provisionIndexNow — idempotent", () => {
  it("returns the existing key without creating a new one", async () => {
    const create = vi.fn();
    const db = {
      seoIndexNowConfig: {
        findUnique: async () => ({ key: "EXISTING", keyLocation: "https://s/k" }),
        create,
      },
    } as any;
    const r = await provisionIndexNow(db, "s");
    expect(r).toEqual({ key: "EXISTING", keyLocation: "https://s/k" });
    expect(create).not.toHaveBeenCalled();
  });
});

describe("submitUrls — fetch timeout", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("passes an AbortSignal (10s timeout) to fetch", async () => {
    const fetchMock = vi.fn(async (_url: any, init: any) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return { ok: true, status: 200 };
    });
    vi.stubGlobal("fetch", fetchMock);
    await submitUrls("s", "KEY", "https://s/k", ["https://s/products/a"]);
    expect(fetchMock).toHaveBeenCalled();
  });
});

describe("getEnabledConfig — single-query gate for webhooks", () => {
  it("returns null when there is no config row", async () => {
    const findUnique = vi.fn(async () => null);
    const db = { seoIndexNowConfig: { findUnique } } as any;
    expect(await getEnabledConfig(db, "s")).toBeNull();
    expect(findUnique).toHaveBeenCalledTimes(1);
  });

  it("returns null when the config exists but is disabled", async () => {
    const db = {
      seoIndexNowConfig: { findUnique: async () => ({ shop: "s", key: "K", keyLocation: "https://s/k", enabled: false }) },
    } as any;
    expect(await getEnabledConfig(db, "s")).toBeNull();
  });

  it("returns the config row when enabled, in a single query", async () => {
    const findUnique = vi.fn(async () => ({ shop: "s", key: "K", keyLocation: "https://s/k", enabled: true }));
    const db = { seoIndexNowConfig: { findUnique } } as any;
    const config = await getEnabledConfig(db, "s");
    expect(config).toEqual({ shop: "s", key: "K", keyLocation: "https://s/k", enabled: true });
    expect(findUnique).toHaveBeenCalledTimes(1);
  });
});

describe("enqueueResource — preloaded config avoids a second config query", () => {
  it("upserts the queue row directly (no config re-fetch) when a config is passed", async () => {
    const configFindUnique = vi.fn();
    const upsert = vi.fn(async (_args: any) => ({}));
    const db = {
      seoIndexNowConfig: { findUnique: configFindUnique },
      seoIndexNowQueue: { upsert },
    } as any;
    const preloaded = { shop: "s", key: "K", keyLocation: "https://s/k", enabled: true } as any;
    await enqueueResource(db, "s", "s.myshopify.com", "product", "blue-shoe", preloaded);
    expect(configFindUnique).not.toHaveBeenCalled();
    expect(upsert).toHaveBeenCalledTimes(1);
    const args = upsert.mock.calls[0][0];
    expect(args.create.url).toBe("https://s.myshopify.com/products/blue-shoe");
  });

  it("is a no-op when the passed-in config is null (disabled/missing)", async () => {
    const upsert = vi.fn();
    const db = { seoIndexNowConfig: { findUnique: vi.fn() }, seoIndexNowQueue: { upsert } } as any;
    await enqueueResource(db, "s", "s.myshopify.com", "product", "blue-shoe", null);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("falls back to loading the config itself when none is passed (back-compat)", async () => {
    const upsert = vi.fn(async () => ({}));
    const db = {
      seoIndexNowConfig: { findUnique: async () => ({ shop: "s", key: "K", keyLocation: "https://s/k", enabled: true }) },
      seoIndexNowQueue: { upsert },
    } as any;
    await enqueueResource(db, "s", "s.myshopify.com", "product", "blue-shoe");
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when the handle is empty, regardless of config", async () => {
    const upsert = vi.fn();
    const db = { seoIndexNowConfig: { findUnique: vi.fn() }, seoIndexNowQueue: { upsert } } as any;
    await enqueueResource(db, "s", "s.myshopify.com", "product", "", { shop: "s", key: "K", keyLocation: "k", enabled: true } as any);
    expect(upsert).not.toHaveBeenCalled();
  });
});

describe("collectStoreUrls", () => {
  it("gathers ACTIVE products + collections + pages, skipping empty handles", async () => {
    const db = {
      product: { findMany: async () => [{ handle: "p1" }, { handle: "" }] },
      collection: { findMany: async () => [{ handle: "c1" }] },
      page: { findMany: async () => [{ handle: "about" }] },
    } as any;
    const urls = await collectStoreUrls(db, "s.myshopify.com", "s.myshopify.com");
    expect(urls).toEqual([
      "https://s.myshopify.com/products/p1",
      "https://s.myshopify.com/collections/c1",
      "https://s.myshopify.com/pages/about",
    ]);
  });
});
