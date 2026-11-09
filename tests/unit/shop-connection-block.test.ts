import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The REAL state module runs on top of a tiny in-memory ShopInstallState/Session.
type Row = Record<string, any>;
const { store, sessions, logs, shopInstallState, session } = vi.hoisted(() => {
  const store = new Map<string, Record<string, any>>();
  const sessions: Array<{ id: string; shop: string; isOnline: boolean }> = [];
  const logs = { warn: [] as string[], info: [] as string[], error: [] as string[], debug: [] as string[] };
  const cmp = (v: any, cond: any): boolean => {
    if (cond === null) return v === null || v === undefined;
    if (cond instanceof Date) return v instanceof Date && v.getTime() === cond.getTime();
    if (typeof cond !== "object") return v === cond;
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
        Object.assign(row, data);
        count++;
      }
      return { count };
    }),
    // Prisma applies the schema defaults: everything nullable stays null.
    createMany: vi.fn(async ({ data, skipDuplicates }: any) => {
      let count = 0;
      for (const d of data) {
        if (store.has(d.shop)) {
          if (skipDuplicates) continue;
          throw new Error("unique");
        }
        store.set(d.shop, {
          connectionState: null, connectionStateSince: null, connectionStateReason: null,
          connectionClearedAt: null, uninstalledAt: null, initialSyncCompletedAt: null, droppedWebhookCount: 0, ...d,
        });
        count++;
      }
      return { count };
    }),
  };
  const session = {
    findFirst: vi.fn(async ({ where }: any) => sessions.find((s) => s.shop === where.shop && s.isOnline === where.isOnline) ?? null),
  };
  return { store, sessions, logs, shopInstallState, session };
});
vi.mock("../../app/db.server", () => ({ db: { shopInstallState, session } }));
vi.mock("../../app/utils/logger.server", () => ({
  logger: {
    warn: (m: string) => logs.warn.push(m),
    info: (m: string) => logs.info.push(m),
    error: (m: string) => logs.error.push(m),
    debug: (m: string) => logs.debug.push(m),
  },
}));

import {
  MASS_401_SUPPRESS_MS,
  MASS_401_WINDOW_MS,
  __resetConnectionBlockForTests,
  blockShopConnection,
  noteUnauthorized,
} from "../../app/utils/shop-connection-block.server";
import { clearConnectionBlock, invalidateConnectionCache } from "../../app/utils/shop-connection-state.server";

const SHOP = "a.myshopify.com";
const row = (over: Row = {}): Row => ({
  shop: SHOP, connectionState: null, connectionStateSince: null, connectionStateReason: null,
  connectionClearedAt: null, uninstalledAt: null, initialSyncCompletedAt: null, droppedWebhookCount: 0, ...over,
});

beforeEach(() => {
  store.clear();
  store.set(SHOP, row());
  sessions.length = 0;
  for (const k of Object.keys(logs) as Array<keyof typeof logs>) logs[k].length = 0;
  invalidateConnectionCache();
  __resetConnectionBlockForTests();
  vi.clearAllMocks();
});
afterEach(() => vi.useRealTimers());

describe("blockShopConnection", () => {
  it("blocks as needs_reauth with the reason, answers true, and logs one BLOCKED line", async () => {
    expect(await blockShopConnection(SHOP, "admin_api_401", { observedAt: new Date() })).toBe(true);
    expect(store.get(SHOP)).toMatchObject({ connectionState: "needs_reauth", connectionStateReason: "admin_api_401" });
    expect(await blockShopConnection(SHOP, "admin_api_401", { observedAt: new Date() })).toBe(true);
    expect(logs.warn.filter((l) => l.includes("BLOCKED"))).toHaveLength(1);
  });

  it("an existing block of ANY kind is left alone (a final kind is not turned back into needs_reauth)", async () => {
    store.set(SHOP, row({ connectionState: "access_denied", connectionStateReason: "token_endpoint_403" }));
    expect(await blockShopConnection(SHOP, "no_token", { observedAt: new Date() })).toBe(true);
    expect(store.get(SHOP)!.connectionState).toBe("access_denied");
  });

  it("the fence: a failure that began before the last re-authorisation does not block", async () => {
    const started = new Date(Date.now() - 5_000);
    await clearConnectionBlock(SHOP, "reauth");
    expect(await blockShopConnection(SHOP, "admin_api_401", { observedAt: started })).toBe(false);
    expect(store.get(SHOP)!.connectionState).toBeNull();
    expect(logs.warn.filter((l) => l.includes("BLOCKED"))).toHaveLength(0);
  });
});

describe("mass-401 guard", () => {
  it("three distinct shops with a 401 inside 10 minutes: one MASS_401 line, no new 401 block for an hour", async () => {
    noteUnauthorized("x1.myshopify.com");
    noteUnauthorized("x2.myshopify.com");
    expect(logs.error).toHaveLength(0);
    noteUnauthorized("x3.myshopify.com");
    noteUnauthorized("x4.myshopify.com"); // already tripped: no second line
    expect(logs.error.filter((l) => l.includes("MASS_401"))).toHaveLength(1);

    expect(await blockShopConnection(SHOP, "admin_api_401", { observedAt: new Date() })).toBe(false);
    expect(store.get(SHOP)!.connectionState).toBeNull();
    // terminal evidence about THIS shop is not held back
    expect(await blockShopConnection(SHOP, "no_token", { observedAt: new Date() })).toBe(true);
  });

  it("lifts after an hour", async () => {
    vi.useFakeTimers();
    ["x1", "x2", "x3"].forEach((s) => noteUnauthorized(`${s}.myshopify.com`));
    vi.advanceTimersByTime(MASS_401_SUPPRESS_MS + 1_000);
    expect(await blockShopConnection(SHOP, "admin_api_401", { observedAt: new Date() })).toBe(true);
  });

  it("does not trip on the same shop repeating, nor on 401s spread beyond the window", async () => {
    vi.useFakeTimers();
    for (let i = 0; i < 10; i++) noteUnauthorized("x1.myshopify.com");
    noteUnauthorized("x2.myshopify.com");
    vi.advanceTimersByTime(MASS_401_WINDOW_MS + 1_000);
    noteUnauthorized("x3.myshopify.com");
    expect(logs.error).toHaveLength(0);
    expect(await blockShopConnection(SHOP, "admin_api_401", { observedAt: new Date() })).toBe(true);
  });
});

describe("a shop without a ShopInstallState row", () => {
  const GONE = "gone.myshopify.com";

  it("without an offline session: nothing is created, nothing blocked, logged once", async () => {
    expect(await blockShopConnection(GONE, "no_token", { observedAt: new Date() })).toBe(false);
    expect(await blockShopConnection(GONE, "no_token", { observedAt: new Date() })).toBe(false);
    expect(store.has(GONE)).toBe(false);
    expect(shopInstallState.createMany).not.toHaveBeenCalled();
    expect(logs.warn.filter((l) => l.includes("no ShopInstallState row"))).toHaveLength(1);
  });

  it("an ONLINE session alone is not proof either", async () => {
    sessions.push({ id: "online_1", shop: GONE, isOnline: true });
    expect(await blockShopConnection(GONE, "no_token", { observedAt: new Date() })).toBe(false);
    expect(store.has(GONE)).toBe(false);
  });

  it("with an offline session: a MINIMAL row is created (a fresh row, nothing else) and the shop is blocked", async () => {
    sessions.push({ id: `offline_${GONE}`, shop: GONE, isOnline: false });
    expect(await blockShopConnection(GONE, "no_token", { observedAt: new Date() })).toBe(true);
    expect(shopInstallState.createMany).toHaveBeenCalledWith({ data: [{ shop: GONE }], skipDuplicates: true });
    const created = store.get(GONE)!;
    expect(created).toMatchObject({ connectionState: "needs_reauth", connectionStateReason: "no_token" });
    // exactly what a missing row already meant to every reader: not a fresh install, not uninstalled
    expect(created.initialSyncCompletedAt).toBeNull();
    expect(created.uninstalledAt).toBeNull();
  });

  it("never throws when the session lookup fails", async () => {
    session.findFirst.mockRejectedValueOnce(new Error("db down"));
    await expect(blockShopConnection(GONE, "no_token", { observedAt: new Date() })).resolves.toBe(false);
    expect(store.has(GONE)).toBe(false);
  });
});
