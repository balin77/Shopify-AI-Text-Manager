import { describe, it, expect, vi, beforeEach } from "vitest";

// ── a tiny in-memory ShopInstallState with the where/data shapes the module uses ──
type Row = Record<string, any>;
const { store, logs, shopInstallState } = vi.hoisted(() => {
  const store = new Map<string, Record<string, any>>();
  const logs = { warn: [] as string[], info: [] as string[], error: [] as string[], debug: [] as string[] };
  const cmp = (v: any, cond: any): boolean => {
    if (cond === null) return v === null || v === undefined;
    if (cond instanceof Date) return v instanceof Date && v.getTime() === cond.getTime();
    if (typeof cond !== "object") return v === cond;
    // SQL semantics: `not` never matches NULL
    if ("not" in cond) return cond.not === null ? v != null : v != null && v !== cond.not;
    if ("lt" in cond) return v != null && v.getTime() < cond.lt.getTime();
    if ("lte" in cond) return v != null && v.getTime() <= cond.lte.getTime();
    return false;
  };
  const matches = (row: Record<string, any>, where: any): boolean =>
    Object.entries(where).every(([k, cond]) => {
      if (k === "OR") return (cond as any[]).some((w) => matches(row, w));
      if (k === "AND") return (cond as any[]).every((w) => matches(row, w));
      return cmp(row[k], cond);
    });
  const shopInstallState = {
    findUnique: vi.fn(async ({ where }: any) => (store.has(where.shop) ? { ...store.get(where.shop) } : null)),
    updateMany: vi.fn(async ({ where, data }: any) => {
      let count = 0;
      for (const row of store.values()) {
        if (!matches(row, where)) continue;
        for (const [k, v] of Object.entries(data)) {
          row[k] = v && typeof v === "object" && "increment" in (v as any) ? (row[k] ?? 0) + (v as any).increment : v;
        }
        count++;
      }
      return { count };
    }),
  };
  return { store, logs, shopInstallState };
});
vi.mock("../../app/db.server", () => ({
  db: { shopInstallState, $queryRaw: vi.fn(), offlineTokenMigration: { findUnique: vi.fn() } },
}));
vi.mock("../../app/utils/logger.server", () => ({
  logger: {
    warn: (m: string) => logs.warn.push(m),
    info: (m: string) => logs.info.push(m),
    error: (m: string) => logs.error.push(m),
    debug: (m: string) => logs.debug.push(m),
  },
}));

import {
  ShopConnectionBlockedError,
  clearConnectionBlock,
  getConnectionBlock,
  invalidateConnectionCache,
  isShopConnectionBlockedError,
  markConnectionBlocked,
  noteDroppedWebhook,
  recordWebhookSeen,
  loadConnectionStatus,
} from "../../app/utils/shop-connection-state.server";
import { db } from "../../app/db.server";

const SHOP = "a.myshopify.com";
const fresh = (over: Row = {}): Row => ({
  shop: SHOP, connectionState: null, connectionStateSince: null, connectionStateReason: null,
  connectionClearedAt: null, connectionClearedCause: null, resyncRequiredSince: null,
  droppedWebhookCount: 0, lastWebhookAt: null, ...over,
});

beforeEach(() => {
  store.clear();
  store.set(SHOP, fresh());
  for (const k of Object.keys(logs) as Array<keyof typeof logs>) logs[k].length = 0;
  invalidateConnectionCache();
  vi.clearAllMocks();
});

describe("markConnectionBlocked / clearConnectionBlock", () => {
  it("blocks once and logs exactly one BLOCKED line, however often it is repeated", async () => {
    expect(await markConnectionBlocked(SHOP, "needs_reauth", "admin_api_401", { observedAt: new Date() })).toEqual({ changed: true });
    for (let i = 0; i < 20; i++) {
      expect(await markConnectionBlocked(SHOP, "needs_reauth", "admin_api_401", { observedAt: new Date() })).toEqual({ changed: false, why: "unchanged" });
    }
    expect(logs.warn.filter((l) => l.includes("BLOCKED"))).toHaveLength(1);
    expect(store.get(SHOP)).toMatchObject({ connectionState: "needs_reauth", connectionStateReason: "admin_api_401" });
    expect(store.get(SHOP)!.connectionStateSince).toBeInstanceOf(Date);
  });

  it("changes the kind of an existing block (and logs that change once)", async () => {
    await markConnectionBlocked(SHOP, "needs_reauth", "no_token", { observedAt: new Date() });
    expect(await markConnectionBlocked(SHOP, "shop_not_found", "token_endpoint_404", { observedAt: new Date() })).toEqual({ changed: true });
    expect(store.get(SHOP)!.connectionState).toBe("shop_not_found");
    expect(logs.warn).toHaveLength(2);
  });

  it("stores a code, never a sentence or token-like text", async () => {
    await markConnectionBlocked(SHOP, "needs_reauth", "Token shpat_ABC123 rejected!", { observedAt: new Date() });
    expect(store.get(SHOP)!.connectionStateReason).toMatch(/^[a-z0-9_]+$/);
  });

  it("the fence: a failure observed before the last clear cannot block again", async () => {
    const started = new Date(Date.now() - 5_000);
    await markConnectionBlocked(SHOP, "needs_reauth", "admin_api_401", { observedAt: new Date() });
    await clearConnectionBlock(SHOP, "reauth");
    expect(await markConnectionBlocked(SHOP, "needs_reauth", "admin_api_401", { observedAt: started })).toEqual({ changed: false, why: "fenced" });
    expect(store.get(SHOP)!.connectionState).toBeNull();
    // a call that began after the clear may block
    expect(await markConnectionBlocked(SHOP, "needs_reauth", "admin_api_401", { observedAt: new Date(Date.now() + 1_000) })).toEqual({ changed: true });
  });

  it("the fence also holds when the shop was not blocked at the time of the clear", async () => {
    const started = new Date(Date.now() - 5_000);
    await clearConnectionBlock(SHOP, "reauth");
    expect((await markConnectionBlocked(SHOP, "needs_reauth", "x", { observedAt: started })).changed).toBe(false);
  });

  it("clear lifts the block, keeps the resync debt, and logs one UNBLOCKED line with the count", async () => {
    await markConnectionBlocked(SHOP, "needs_reauth", "admin_api_401", { observedAt: new Date() });
    await noteDroppedWebhook(SHOP);
    await noteDroppedWebhook(SHOP);
    const res = await clearConnectionBlock(SHOP, "reinstall");
    expect(res.cleared).toBe(true);
    expect(res.droppedWebhookCount).toBe(2);
    expect(res.resyncRequiredSince).toBeInstanceOf(Date);
    expect(store.get(SHOP)).toMatchObject({ connectionState: null, connectionStateReason: null, connectionClearedCause: "reinstall", droppedWebhookCount: 2 });
    expect(store.get(SHOP)!.resyncRequiredSince).toBeInstanceOf(Date);
    expect(logs.info.filter((l) => l.includes("UNBLOCKED"))).toHaveLength(1);
    expect(logs.info[0]).toContain("droppedWebhooks=2");
    // clearing again logs nothing
    expect((await clearConnectionBlock(SHOP, "reauth")).cleared).toBe(false);
    expect(logs.info.filter((l) => l.includes("UNBLOCKED"))).toHaveLength(1);
  });

  it("never creates a row for an unknown shop", async () => {
    expect(await markConnectionBlocked("nobody.myshopify.com", "needs_reauth", "x", { observedAt: new Date() })).toEqual({ changed: false, why: "no_row" });
    await noteDroppedWebhook("nobody.myshopify.com");
    await recordWebhookSeen("nobody.myshopify.com");
    await clearConnectionBlock("nobody.myshopify.com", "reauth");
    expect(store.has("nobody.myshopify.com")).toBe(false);
  });

  it("writers never throw on a database error", async () => {
    shopInstallState.updateMany.mockRejectedValueOnce(new Error("db down"));
    expect(await markConnectionBlocked(SHOP, "needs_reauth", "x", { observedAt: new Date() })).toEqual({ changed: false, why: "error" });
    shopInstallState.updateMany.mockRejectedValueOnce(new Error("db down"));
    await expect(noteDroppedWebhook(SHOP)).resolves.toBeUndefined();
    shopInstallState.findUnique.mockRejectedValueOnce(new Error("db down"));
    await expect(clearConnectionBlock(SHOP, "reauth")).resolves.toMatchObject({ cleared: false });
  });
});

describe("getConnectionBlock cache", () => {
  it("answers from memory for 30 s and follows block, clear and invalidation", async () => {
    expect(await getConnectionBlock(SHOP)).toBeNull();
    expect(await getConnectionBlock(SHOP)).toBeNull();
    expect(shopInstallState.findUnique).toHaveBeenCalledTimes(1);

    await markConnectionBlocked(SHOP, "access_denied", "token_endpoint_403", { observedAt: new Date() });
    shopInstallState.findUnique.mockClear();
    expect(await getConnectionBlock(SHOP)).toMatchObject({ state: "access_denied", reason: "token_endpoint_403" });
    expect(shopInstallState.findUnique).not.toHaveBeenCalled();

    await clearConnectionBlock(SHOP, "probe_ok");
    expect(await getConnectionBlock(SHOP)).toBeNull();

    // a change made behind the cache is seen after invalidation (redact, other writer)
    store.get(SHOP)!.connectionState = "needs_reauth";
    expect(await getConnectionBlock(SHOP)).toBeNull();
    invalidateConnectionCache(SHOP);
    expect(await getConnectionBlock(SHOP)).toMatchObject({ state: "needs_reauth" });
  });

  it("expires after the TTL", async () => {
    vi.useFakeTimers();
    try {
      await getConnectionBlock(SHOP);
      store.get(SHOP)!.connectionState = "needs_reauth";
      vi.advanceTimersByTime(29_000);
      expect(await getConnectionBlock(SHOP)).toBeNull();
      vi.advanceTimersByTime(2_000);
      expect(await getConnectionBlock(SHOP)).toMatchObject({ state: "needs_reauth" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails open on a read error and does not cache the failure", async () => {
    shopInstallState.findUnique.mockRejectedValueOnce(new Error("db down"));
    expect(await getConnectionBlock(SHOP)).toBeNull();
    store.get(SHOP)!.connectionState = "needs_reauth";
    expect(await getConnectionBlock(SHOP)).toMatchObject({ state: "needs_reauth" });
  });
});

describe("getConnectionBlock generation guard", () => {
  it("a slow read that overlapped a write does not cache the older answer", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    shopInstallState.findUnique.mockImplementationOnce(async () => {
      const stale = { ...store.get(SHOP) }; // state as of the read's query
      await gate;
      return stale;
    });
    const slow = getConnectionBlock(SHOP);
    await vi.waitFor(() => expect(shopInstallState.findUnique).toHaveBeenCalled());
    await markConnectionBlocked(SHOP, "needs_reauth", "admin_api_401", { observedAt: new Date() });
    release();
    expect(await slow).toBeNull(); // the slow reader returns what it saw ...
    // ... but did not cache it over the newer write
    shopInstallState.findUnique.mockClear();
    expect(await getConnectionBlock(SHOP)).toMatchObject({ state: "needs_reauth" });
  });
});

describe("write ordering and global invalidation", () => {
  it("a block write whose database call replies after a clear does not cache 'blocked'", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const realUpdateMany = shopInstallState.updateMany.getMockImplementation()!;
    // the block's UPDATE commits at once, but its reply is delayed
    shopInstallState.updateMany.mockImplementationOnce(async (args: any) => {
      const res = await realUpdateMany(args);
      await gate;
      return res;
    });
    const block = markConnectionBlocked(SHOP, "needs_reauth", "admin_api_401", { observedAt: new Date() });
    await vi.waitFor(() => expect(shopInstallState.updateMany).toHaveBeenCalled());
    await clearConnectionBlock(SHOP, "reauth"); // the clear commits and caches "not blocked" meanwhile
    release();
    await block;
    // whatever the database holds is what the next read must see, not the older reply
    store.get(SHOP)!.connectionState = null;
    shopInstallState.findUnique.mockClear();
    expect(await getConnectionBlock(SHOP)).toBeNull();
    expect(shopInstallState.findUnique).toHaveBeenCalledTimes(1); // answered from the database, not the cache
  });

  it("two overlapping clears do not cache over each other either", async () => {
    await markConnectionBlocked(SHOP, "needs_reauth", "x", { observedAt: new Date() });
    await Promise.all([clearConnectionBlock(SHOP, "reauth"), clearConnectionBlock(SHOP, "reinstall")]);
    shopInstallState.findUnique.mockClear();
    await getConnectionBlock(SHOP);
    expect(shopInstallState.findUnique).toHaveBeenCalledTimes(1);
  });

  it("invalidateConnectionCache() without a shop stops an in-flight read for a never-written shop from caching", async () => {
    const OTHER = "never-written.myshopify.com";
    store.set(OTHER, fresh({ shop: OTHER }));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    shopInstallState.findUnique.mockImplementationOnce(async () => {
      const stale = { ...store.get(OTHER) };
      await gate;
      return stale;
    });
    const slow = getConnectionBlock(OTHER);
    await vi.waitFor(() => expect(shopInstallState.findUnique).toHaveBeenCalled());
    invalidateConnectionCache(); // e.g. a test reset or a redact sweep
    store.get(OTHER)!.connectionState = "needs_reauth";
    release();
    expect(await slow).toBeNull();
    expect(await getConnectionBlock(OTHER)).toMatchObject({ state: "needs_reauth" });
  });

  it("an uncontended write still caches its result", async () => {
    await markConnectionBlocked(SHOP, "needs_reauth", "x", { observedAt: new Date() });
    shopInstallState.findUnique.mockClear();
    expect(await getConnectionBlock(SHOP)).toMatchObject({ state: "needs_reauth" });
    expect(shopInstallState.findUnique).not.toHaveBeenCalled();
  });
});

describe("noteDroppedWebhook", () => {
  it("counts every webhook and sets resyncRequiredSince once, at the first", async () => {
    await noteDroppedWebhook(SHOP);
    const first = store.get(SHOP)!.resyncRequiredSince as Date;
    expect(first).toBeInstanceOf(Date);
    for (let i = 0; i < 49; i++) await noteDroppedWebhook(SHOP);
    expect(store.get(SHOP)!.droppedWebhookCount).toBe(50);
    expect(store.get(SHOP)!.resyncRequiredSince).toBe(first);
    expect(logs.warn).toHaveLength(0);
    expect(logs.error).toHaveLength(0);
  });
});

describe("recordWebhookSeen", () => {
  it("writes at most every 10 minutes per shop and never backwards", async () => {
    const t1 = new Date(Date.now() - 60_000);
    await recordWebhookSeen(SHOP, t1);
    await recordWebhookSeen(SHOP, new Date(Date.now() - 30_000));
    expect(shopInstallState.updateMany).toHaveBeenCalledTimes(1);
    expect(store.get(SHOP)!.lastWebhookAt).toEqual(t1);

    // an OLDER trigger time than the stored one does not move it back
    invalidateConnectionCache();
    await recordWebhookSeen(SHOP, new Date(t1.getTime() - 3_600_000));
    expect(store.get(SHOP)!.lastWebhookAt).toEqual(t1);
  });

  it("clamps a header from the future and survives garbage", async () => {
    await recordWebhookSeen(SHOP, new Date(Date.now() + 86_400_000));
    expect((store.get(SHOP)!.lastWebhookAt as Date).getTime()).toBeLessThanOrEqual(Date.now());
    invalidateConnectionCache();
    store.get(SHOP)!.lastWebhookAt = null;
    await expect(recordWebhookSeen(SHOP, "not a date")).resolves.toBeUndefined();
    expect(store.get(SHOP)!.lastWebhookAt).toBeInstanceOf(Date);
  });
});

describe("ShopConnectionBlockedError", () => {
  it("carries the code, mentions 401, and is recognised by shape", () => {
    const e = new ShopConnectionBlockedError(SHOP, { state: "needs_reauth", since: null, reason: "admin_api_401" });
    expect(e.code).toBe("SHOP_CONNECTION_BLOCKED");
    expect(e.message).toContain("401");
    expect(isShopConnectionBlockedError(e)).toBe(true);
    expect(isShopConnectionBlockedError(Object.assign(new Error("x"), { code: "SHOP_CONNECTION_BLOCKED" }))).toBe(true);
    expect(isShopConnectionBlockedError(new Error("401"))).toBe(false);
  });
});

describe("loadConnectionStatus", () => {
  it("derives from the three sources and never selects the token or the encrypted migration columns", async () => {
    store.set(SHOP, fresh({ connectionState: "needs_reauth", connectionStateReason: "no_token", connectionStateSince: new Date() }));
    (db.$queryRaw as any).mockResolvedValue([{ expires: null, refreshTokenExpires: null, tokenEmpty: true, hasRefreshToken: false }]);
    (db.offlineTokenMigration.findUnique as any).mockResolvedValue(null);
    const r = await loadConnectionStatus(SHOP);
    expect(r.status).toBe("needs_reauth");
    expect(r.webhooksPaused).toBe(true);

    const sql = ((db.$queryRaw as any).mock.calls[0][0] as string[]).join("?");
    expect(sql).not.toMatch(/"accessToken"\s*(,|FROM)/);
    expect(sql).not.toContain('"refreshToken",');
    const select = (db.offlineTokenMigration.findUnique as any).mock.calls[0][0].select;
    expect(Object.keys(select)).not.toContain("encryptedOldToken");
    expect(Object.keys(select)).not.toContain("tokenFingerprint");
    expect(Object.keys(select)).not.toContain("lastError");
  });
});
