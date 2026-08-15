import { describe, it, expect, vi, afterEach } from "vitest";
import {
  generateIndexNowKey,
  keyLocationFor,
  homepageUrl,
  storefrontUrl,
  articleUrl,
  buildSubmitBody,
  chunkUrls,
  describeSubmitStatus,
  firstFailureKind,
  shouldEnqueueProductChange,
  submitUrls,
  collectStoreUrls,
  drainQueue,
  submitAll,
  enqueueIndexNowUrl,
  enqueueResource,
  getEnabledConfig,
  provisionIndexNow,
  setIndexNowEnabled,
  syncIndexNowHost,
  syncKeyLocation,
  INDEXNOW_MAX_URLS_PER_REQUEST,
  SUBMIT_ALL_COOLDOWN_MS,
} from "~/services/seo/index-now.service";

/** IndexNow pure helpers + the submit/collect/queue logic (fetch mocked). */

const CONFIG = {
  shop: "s.myshopify.com",
  key: "K",
  keyLocation: "https://shop.example/K.txt",
  host: "shop.example",
  enabled: true,
  lastSubmittedAt: null,
  lastFullSubmitAt: null,
  lastAutoRunAt: null,
} as any;

describe("generateIndexNowKey", () => {
  it("is 32 hex chars and reasonably unique", () => {
    const a = generateIndexNowKey();
    const b = generateIndexNowKey();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });
});

describe("URL builders", () => {
  it("keyLocationFor names the ROOT path — a sub-path key only verifies itself (measured 422)", () => {
    expect(keyLocationFor("shop.example", "abc123")).toBe("https://shop.example/abc123.txt");
  });
  it("normalizes a host that arrives with scheme or trailing slash", () => {
    expect(keyLocationFor("https://shop.example/", "abc123")).toBe("https://shop.example/abc123.txt");
    expect(storefrontUrl("https://shop.example/", "product", "p")).toBe("https://shop.example/products/p");
  });
  it("storefrontUrl builds per-type paths", () => {
    expect(storefrontUrl("shop.example", "product", "blue-shoe")).toBe("https://shop.example/products/blue-shoe");
    expect(storefrontUrl("shop.example", "collection", "footwear")).toBe("https://shop.example/collections/footwear");
    expect(storefrontUrl("shop.example", "page", "about")).toBe("https://shop.example/pages/about");
  });
  it("articleUrl nests the article under its blog handle", () => {
    expect(articleUrl("shop.example", "news", "hello")).toBe("https://shop.example/blogs/news/hello");
  });
  it("homepageUrl is the bare origin with a trailing slash", () => {
    expect(homepageUrl("shop.example")).toBe("https://shop.example/");
  });
});

describe("shouldEnqueueProductChange", () => {
  it("submits anything that is live now", () => {
    expect(shouldEnqueueProductChange("DRAFT", "ACTIVE")).toBe(true);
    expect(shouldEnqueueProductChange(null, "ACTIVE")).toBe(true);
  });

  it("reports an unpublish — the URL that was live just became a 404", () => {
    expect(shouldEnqueueProductChange("ACTIVE", "DRAFT")).toBe(true);
    expect(shouldEnqueueProductChange("ACTIVE", "ARCHIVED")).toBe(true);
    // Delete: there is no "after".
    expect(shouldEnqueueProductChange("ACTIVE", null)).toBe(true);
  });

  it("stays silent about a product that was never live", () => {
    // Created as a draft: an engine never knew this URL, so submitting the
    // 404 is pure noise.
    expect(shouldEnqueueProductChange(null, "DRAFT")).toBe(false);
    expect(shouldEnqueueProductChange("DRAFT", "ARCHIVED")).toBe(false);
    expect(shouldEnqueueProductChange("DRAFT", null)).toBe(false);
  });

  it("never submits UNLISTED — live, but deliberately kept out of search", () => {
    expect(shouldEnqueueProductChange("ACTIVE", "UNLISTED")).toBe(false);
    expect(shouldEnqueueProductChange(null, "UNLISTED")).toBe(false);
  });
});

describe("describeSubmitStatus", () => {
  it("names IndexNow's diagnostic status codes", () => {
    expect(describeSubmitStatus(200)).toBe("ok");
    expect(describeSubmitStatus(202)).toBe("ok");
    expect(describeSubmitStatus(400)).toBe("badRequest");
    expect(describeSubmitStatus(403)).toBe("keyInvalid");
    expect(describeSubmitStatus(422)).toBe("hostMismatch");
    expect(describeSubmitStatus(429)).toBe("rateLimited");
    expect(describeSubmitStatus(503)).toBe("serverError");
    expect(describeSubmitStatus(null)).toBe("networkError");
  });
});

describe("buildSubmitBody", () => {
  it("matches the IndexNow payload shape", () => {
    expect(buildSubmitBody("shop.example", "KEY", "https://shop.example/k", ["https://shop.example/products/a"])).toEqual({
      host: "shop.example",
      key: "KEY",
      keyLocation: "https://shop.example/k",
      urlList: ["https://shop.example/products/a"],
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
    const r = await submitUrls("shop.example", "KEY", "https://shop.example/k", [
      "https://shop.example/products/a",
      "https://shop.example/products/b",
    ]);
    expect(r.submitted).toBe(2);
    expect(r.failed).toBe(0);
    expect(r.chunks).toBe(1);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
    expect(body.urlList).toHaveLength(2);
    expect(body.key).toBe("KEY");
  });

  it("keeps the status code so the failure reason survives", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 403 })));
    const r = await submitUrls("shop.example", "KEY", "https://shop.example/k", ["https://shop.example/products/a"]);
    expect(r.failed).toBe(1);
    expect(r.submitted).toBe(0);
    expect(r.results[0].status).toBe(403);
    expect(firstFailureKind(r)).toBe("keyInvalid");
  });

  it("a network error is a failure with a null status, never a throw", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("boom"); }));
    const r = await submitUrls("shop.example", "KEY", "https://shop.example/k", ["https://shop.example/products/a"]);
    expect(r.failed).toBe(1);
    expect(firstFailureKind(r)).toBe("networkError");
  });

  it("passes an AbortSignal (timeout) to fetch", async () => {
    const fetchMock = vi.fn(async (_url: any, init: any) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return { ok: true, status: 200 };
    });
    vi.stubGlobal("fetch", fetchMock);
    await submitUrls("shop.example", "KEY", "https://shop.example/k", ["https://shop.example/products/a"]);
    expect(fetchMock).toHaveBeenCalled();
  });
});

describe("drainQueue", () => {
  afterEach(() => vi.unstubAllGlobals());

  // drainQueue issues TWO kinds of deleteMany: the TTL prune (where.createdAt)
  // and the "these rows were accepted" delete (where.id). Tests care about the
  // latter, so they are kept apart here.
  const makeDb = (rows: Array<{ id: string; url: string }>, extra: Record<string, any> = {}) => {
    const deleteMany = vi.fn(async (_args: any) => ({ count: 0 }));
    const updateMany = vi.fn(async (_args: any) => ({ count: 1 }));
    const rowDeletes = () => deleteMany.mock.calls.filter((c: any[]) => c[0]?.where?.id);
    const ttlPrunes = () => deleteMany.mock.calls.filter((c: any[]) => c[0]?.where?.createdAt);
    return {
      db: {
        seoIndexNowConfig: { findUnique: async () => ({ ...CONFIG, ...extra }), updateMany },
        seoIndexNowQueue: { findMany: async () => rows, deleteMany },
      } as any,
      deleteMany,
      updateMany,
      rowDeletes,
      ttlPrunes,
    };
  };

  it("keeps the rows and does not stamp when the chunk fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500 })));
    const { db, rowDeletes, ttlPrunes, updateMany } = makeDb([{ id: "q1", url: "https://shop.example/products/a" }]);
    const outcome = await drainQueue(db, "s.myshopify.com");
    expect(outcome.status).toBe("submitted");
    if (outcome.status !== "submitted") throw new Error("unreachable");
    expect(outcome.result.failed).toBe(1);
    expect(rowDeletes()).toHaveLength(0);
    expect(ttlPrunes()).toHaveLength(1);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("clears the queue and stamps lastSubmittedAt on success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200 })));
    const { db, rowDeletes, updateMany } = makeDb([{ id: "q1", url: "https://shop.example/products/a" }]);
    const outcome = await drainQueue(db, "s.myshopify.com");
    if (outcome.status !== "submitted") throw new Error("unreachable");
    expect(outcome.result.failed).toBe(0);
    expect(rowDeletes()[0][0]).toEqual({ where: { id: { in: ["q1"] } } });
    expect(updateMany).toHaveBeenCalled();
  });

  it("deletes the rows of the accepted chunk and keeps the rejected one for retry", async () => {
    // Just over the 10k limit → exactly two chunks. The first is accepted, the
    // second rejected: the successful 10k must NOT be resubmitted next time,
    // and the rejected row must NOT be lost.
    const responses = [
      { ok: true, status: 200 },
      { ok: false, status: 429 },
    ];
    vi.stubGlobal("fetch", vi.fn(async () => responses.shift()!));
    const rows = Array.from({ length: INDEXNOW_MAX_URLS_PER_REQUEST + 1 }, (_, i) => ({
      id: `q${i}`,
      url: `https://shop.example/products/p${i}`,
    }));
    const { db, rowDeletes } = makeDb(rows);

    const outcome = await drainQueue(db, "s.myshopify.com");
    if (outcome.status !== "submitted") throw new Error("unreachable");
    expect(outcome.result.chunks).toBe(2);
    expect(outcome.result.submitted).toBe(INDEXNOW_MAX_URLS_PER_REQUEST);
    expect(outcome.result.failed).toBe(1);

    const deletedIds: string[] = rowDeletes()[0][0].where.id.in;
    expect(deletedIds).toHaveLength(INDEXNOW_MAX_URLS_PER_REQUEST);
    expect(deletedIds).not.toContain(`q${INDEXNOW_MAX_URLS_PER_REQUEST}`);
  });

  it("is a no-op when IndexNow is disabled", async () => {
    const findMany = vi.fn();
    const db = {
      seoIndexNowConfig: { findUnique: async () => ({ ...CONFIG, enabled: false }) },
      seoIndexNowQueue: { findMany, deleteMany: vi.fn(async (_args: any) => ({ count: 0 })) },
    } as any;
    expect(await drainQueue(db, "s.myshopify.com")).toEqual({ status: "disabled" });
    expect(findMany).not.toHaveBeenCalled();
  });

  it("reports an empty queue instead of pretending to submit", async () => {
    const db = {
      seoIndexNowConfig: { findUnique: async () => CONFIG },
      seoIndexNowQueue: { findMany: async () => [], deleteMany: vi.fn(async (_args: any) => ({ count: 0 })) },
    } as any;
    expect(await drainQueue(db, "s.myshopify.com")).toEqual({ status: "empty" });
  });
});

describe("enqueueIndexNowUrl — no-op unless enabled", () => {
  it("does nothing when there is no config", async () => {
    const upsert = vi.fn();
    const db = { seoIndexNowConfig: { findUnique: async () => null }, seoIndexNowQueue: { upsert } } as any;
    await enqueueIndexNowUrl(db, "s", "https://shop.example/products/a");
    expect(upsert).not.toHaveBeenCalled();
  });
  it("does nothing when config is disabled", async () => {
    const upsert = vi.fn();
    const db = {
      seoIndexNowConfig: { findUnique: async () => ({ ...CONFIG, enabled: false }) },
      seoIndexNowQueue: { upsert },
    } as any;
    await enqueueIndexNowUrl(db, "s", "https://shop.example/products/a");
    expect(upsert).not.toHaveBeenCalled();
  });
});

describe("provisionIndexNow", () => {
  it("re-enables an existing config WITHOUT minting a new key", async () => {
    const existing = { ...CONFIG, key: "EXISTING", enabled: false };
    const create = vi.fn();
    const update = vi.fn(async ({ data }: any) => ({ ...existing, ...data }));
    const db = {
      seoIndexNowConfig: { findUnique: async () => existing, create, update },
    } as any;
    const r = await provisionIndexNow(db, "s.myshopify.com", "shop.example");
    expect(create).not.toHaveBeenCalled();
    expect(r.key).toBe("EXISTING");
    expect(update.mock.calls[0][0].data.enabled).toBe(true);
  });

  it("leaves an existing host alone when the domain lookup failed", async () => {
    const existing = { ...CONFIG, enabled: false };
    const update = vi.fn(async ({ data }: any) => ({ ...existing, ...data }));
    const db = { seoIndexNowConfig: { findUnique: async () => existing, create: vi.fn(), update } } as any;
    await provisionIndexNow(db, "s.myshopify.com", "s.myshopify.com", false);
    // Only the toggle — a fallback host must never overwrite a verified one.
    expect(update.mock.calls[0][0].data).toEqual({ enabled: true });
  });

  it("creates the config on the PRIMARY domain, not the myshopify host", async () => {
    const create = vi.fn(async ({ data }: any) => data);
    const db = { seoIndexNowConfig: { findUnique: async () => null, create } } as any;
    const r = await provisionIndexNow(db, "s.myshopify.com", "shop.example");
    expect(r.host).toBe("shop.example");
    expect(r.keyLocation).toMatch(/^https:\/\/shop\.example\/[0-9a-f]{32}\.txt$/);
    expect(create.mock.calls[0][0].data.host).toBe("shop.example");
  });
});

describe("setIndexNowEnabled", () => {
  it("disabling keeps the key row and drops the pending queue", async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const deleteMany = vi.fn(async () => ({ count: 3 }));
    const db = {
      seoIndexNowConfig: { updateMany },
      seoIndexNowQueue: { deleteMany },
    } as any;
    await setIndexNowEnabled(db, "s.myshopify.com", false);
    expect(updateMany).toHaveBeenCalledWith({ where: { shop: "s.myshopify.com" }, data: { enabled: false } });
    expect(deleteMany).toHaveBeenCalledWith({ where: { shop: "s.myshopify.com" } });
  });

  it("enabling does not touch the queue", async () => {
    const deleteMany = vi.fn();
    const db = {
      seoIndexNowConfig: { updateMany: vi.fn(async () => ({ count: 1 })) },
      seoIndexNowQueue: { deleteMany },
    } as any;
    await setIndexNowEnabled(db, "s.myshopify.com", true);
    expect(deleteMany).not.toHaveBeenCalled();
  });
});

describe("syncIndexNowHost", () => {
  const NOW = new Date("2026-08-15T12:00:00Z");

  it("rewrites host + keyLocation when the primary domain changed, keeping the key", async () => {
    const stale = {
      ...CONFIG,
      host: "s.myshopify.com",
      keyLocation: "https://s.myshopify.com/apps/contentpilot/indexnow-key",
    };
    const update = vi.fn(async ({ data }: any) => ({ ...stale, ...data }));
    const deleteMany = vi.fn(async (_args: any) => ({ count: 0 }));
    const db = {
      seoIndexNowConfig: { findUnique: async () => stale, update },
      seoIndexNowQueue: { deleteMany },
    } as any;
    const updated = await syncIndexNowHost(db, "s.myshopify.com", "shop.example", NOW);
    expect(update.mock.calls[0][0].data).toEqual({
      host: "shop.example",
      keyLocation: "https://shop.example/K.txt",
      hostCheckedAt: NOW,
    });
    expect(updated?.key).toBe("K");
  });

  it("drops URLs queued on the OLD host — they would 422 and wedge the queue", async () => {
    const stale = { ...CONFIG, host: "s.myshopify.com", keyLocation: "https://s.myshopify.com/k" };
    const deleteMany = vi.fn(async (_args: any) => ({ count: 4 }));
    const db = {
      seoIndexNowConfig: { findUnique: async () => stale, update: vi.fn(async ({ data }: any) => ({ ...stale, ...data })) },
      seoIndexNowQueue: { deleteMany },
    } as any;
    await syncIndexNowHost(db, "s.myshopify.com", "shop.example", NOW);
    expect(deleteMany).toHaveBeenCalledWith({ where: { shop: "s.myshopify.com" } });
  });

  it("only stamps the check timestamp when the host already matches", async () => {
    const update = vi.fn(async ({ data }: any) => ({ ...CONFIG, ...data }));
    const deleteMany = vi.fn();
    const db = {
      seoIndexNowConfig: { findUnique: async () => ({ ...CONFIG, hostCheckedAt: null }), update },
      seoIndexNowQueue: { deleteMany },
    } as any;
    await syncIndexNowHost(db, "s.myshopify.com", "shop.example", NOW);
    expect(update.mock.calls[0][0].data).toEqual({ hostCheckedAt: NOW });
    // An unchanged host must never cost the shop its pending URLs.
    expect(deleteMany).not.toHaveBeenCalled();
  });
});

describe("syncKeyLocation", () => {
  it("rewrites a keyLocation left on the old app-proxy path, without touching hostCheckedAt", async () => {
    const legacy = {
      ...CONFIG,
      keyLocation: "https://shop.example/apps/contentpilot/indexnow-key",
      hostCheckedAt: new Date("2026-08-15T11:00:00Z"),
    };
    const update = vi.fn(async ({ data }: any) => ({ ...legacy, ...data }));
    const db = { seoIndexNowConfig: { findUnique: async () => legacy, update } } as any;

    await syncKeyLocation(db, "s.myshopify.com");
    // Only the location — stamping hostCheckedAt here would suppress the real
    // domain re-check for another 24h.
    expect(update.mock.calls[0][0].data).toEqual({ keyLocation: "https://shop.example/K.txt" });
  });

  it("does not write when the key location is already correct", async () => {
    const update = vi.fn();
    const db = { seoIndexNowConfig: { findUnique: async () => CONFIG, update } } as any;
    await syncKeyLocation(db, "s.myshopify.com");
    expect(update).not.toHaveBeenCalled();
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
    const db = { seoIndexNowConfig: { findUnique: async () => ({ ...CONFIG, enabled: false }) } } as any;
    expect(await getEnabledConfig(db, "s")).toBeNull();
  });

  it("returns the config row when enabled, in a single query", async () => {
    const findUnique = vi.fn(async () => CONFIG);
    const db = { seoIndexNowConfig: { findUnique } } as any;
    expect(await getEnabledConfig(db, "s")).toEqual(CONFIG);
    expect(findUnique).toHaveBeenCalledTimes(1);
  });
});

describe("enqueueResource", () => {
  it("builds the URL on the config's primary-domain host, without a second config query", async () => {
    const configFindUnique = vi.fn();
    const upsert = vi.fn(async (_args: any) => ({}));
    const db = {
      seoIndexNowConfig: { findUnique: configFindUnique },
      seoIndexNowQueue: { upsert },
    } as any;
    await enqueueResource(db, "s.myshopify.com", "product", "blue-shoe", CONFIG);
    expect(configFindUnique).not.toHaveBeenCalled();
    expect(upsert.mock.calls[0][0].create.url).toBe("https://shop.example/products/blue-shoe");
  });

  it("is a no-op when the passed-in config is null (disabled/missing)", async () => {
    const upsert = vi.fn();
    const db = { seoIndexNowConfig: { findUnique: vi.fn() }, seoIndexNowQueue: { upsert } } as any;
    await enqueueResource(db, "s", "product", "blue-shoe", null);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("falls back to loading the config itself when none is passed", async () => {
    const upsert = vi.fn(async (_args: any) => ({}));
    const db = {
      seoIndexNowConfig: { findUnique: async () => CONFIG },
      seoIndexNowQueue: { upsert },
    } as any;
    await enqueueResource(db, "s", "collection", "footwear");
    expect(upsert.mock.calls[0][0].create.url).toBe("https://shop.example/collections/footwear");
  });

  it("is a no-op when the handle is empty, regardless of config", async () => {
    const upsert = vi.fn();
    const db = { seoIndexNowConfig: { findUnique: vi.fn() }, seoIndexNowQueue: { upsert } } as any;
    await enqueueResource(db, "s", "product", "", CONFIG);
    expect(upsert).not.toHaveBeenCalled();
  });
});

describe("collectStoreUrls", () => {
  const db = {
    product: { findMany: async () => [{ handle: "p1" }, { handle: "" }] },
    collection: { findMany: async () => [{ handle: "c1" }] },
    page: {
      findMany: async () => [
        { id: "gid://shopify/Page/1", handle: "about" },
        { id: "gid://shopify/Page/2", handle: "draft-page" },
      ],
    },
    article: { findMany: async () => [{ handle: "hello", blogId: "gid://shopify/Blog/1" }] },
  } as any;

  it("includes the homepage, ACTIVE products, collections and pages", async () => {
    const urls = await collectStoreUrls(db, "s.myshopify.com", "shop.example");
    expect(urls).toEqual([
      "https://shop.example/",
      "https://shop.example/products/p1",
      "https://shop.example/collections/c1",
      "https://shop.example/pages/about",
      "https://shop.example/pages/draft-page",
    ]);
  });

  it("adds articles once the blog handles are known", async () => {
    const urls = await collectStoreUrls(db, "s.myshopify.com", "shop.example", {
      blogHandles: new Map([["gid://shopify/Blog/1", "news"]]),
    });
    expect(urls).toContain("https://shop.example/blogs/news/hello");
  });

  it("skips articles whose blog handle could not be resolved (never guesses a URL)", async () => {
    const urls = await collectStoreUrls(db, "s.myshopify.com", "shop.example", {
      blogHandles: new Map([["gid://shopify/Blog/OTHER", "news"]]),
    });
    expect(urls.some((u) => u.includes("/blogs/"))).toBe(false);
  });

  it("drops pages that are not published to the online store", async () => {
    const urls = await collectStoreUrls(db, "s.myshopify.com", "shop.example", {
      unpublishedPageIds: new Set(["gid://shopify/Page/2"]),
    });
    expect(urls).toContain("https://shop.example/pages/about");
    expect(urls).not.toContain("https://shop.example/pages/draft-page");
  });
});

describe("submitAll", () => {
  afterEach(() => vi.unstubAllGlobals());

  const emptyCatalogDb = (config: any, updateMany = vi.fn(async (_args: any) => ({ count: 1 }))) => ({
    seoIndexNowConfig: { findUnique: async () => config, updateMany },
    product: { findMany: async () => [] },
    collection: { findMany: async () => [] },
    page: { findMany: async () => [] },
    article: { findMany: async () => [] },
  }) as any;

  it("refuses when IndexNow is disabled", async () => {
    const db = emptyCatalogDb({ ...CONFIG, enabled: false });
    expect(await submitAll(db, "s.myshopify.com")).toEqual({ status: "disabled" });
  });

  it("blocks a repeat full submit inside the cooldown", async () => {
    const now = new Date("2026-08-15T12:00:00Z");
    const db = emptyCatalogDb({ ...CONFIG, lastFullSubmitAt: new Date(now.getTime() - 60_000) });
    const outcome = await submitAll(db, "s.myshopify.com", { now });
    expect(outcome.status).toBe("cooldown");
    if (outcome.status !== "cooldown") throw new Error("unreachable");
    expect(outcome.retryAfterMs).toBeLessThanOrEqual(SUBMIT_ALL_COOLDOWN_MS);
    expect(outcome.retryAfterMs).toBeGreaterThan(0);
  });

  it("does not stamp the cooldown when the submit failed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 403 })));
    const updateMany = vi.fn(async (_args: any) => ({ count: 1 }));
    const db = emptyCatalogDb(CONFIG, updateMany);
    const outcome = await submitAll(db, "s.myshopify.com");
    expect(outcome.status).toBe("submitted");
    // Nothing went out, so nothing may block the retry.
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("submits again once the cooldown expired, stamping both timestamps", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200 })));
    const now = new Date("2026-08-15T12:00:00Z");
    const updateMany = vi.fn(async (_args: any) => ({ count: 1 }));
    const db = emptyCatalogDb(
      { ...CONFIG, lastFullSubmitAt: new Date(now.getTime() - SUBMIT_ALL_COOLDOWN_MS - 1000) },
      updateMany,
    );
    const outcome = await submitAll(db, "s.myshopify.com", { now });
    expect(outcome.status).toBe("submitted");
    // The homepage alone is still a submit, and it stamps both timestamps.
    expect(updateMany.mock.calls[0][0].data).toEqual({ lastSubmittedAt: now, lastFullSubmitAt: now });
  });
});
