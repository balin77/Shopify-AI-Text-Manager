/**
 * Expiring offline access tokens: the background client (offline-admin.server.ts),
 * its env switches, and the lazy migration.
 *
 * The library is injected through `configureOfflineAdmin`, so nothing here loads
 * shopify.server — the same seam the scheduler and the task runners rely on to
 * stay importable in unit tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Session } from "@shopify/shopify-api";

vi.mock("~/utils/logger.server", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  __resetOfflineAdminForTests,
  backgroundAdmin,
  configureOfflineAdmin,
  createRefreshingAdmin,
  getOfflineAccessToken,
  getOfflineAdmin,
  invalidateOfflineAdmin,
  isUnauthorizedError,
  markSelfRefreshingAdminClient,
  maybeMigrateToExpiringToken,
  migrationMayBeNeeded,
  OfflineAdminUnavailableError,
  registerShopAccessTokenHook,
  type OfflineAdminDeps,
} from "~/utils/offline-admin.server";
import {
  expiringOfflineTokensEnabled,
  migrateToExpiringTokensEnabled,
} from "~/utils/offline-token-flags.server";

const SHOP = "test-shop.myshopify.com";

function session(token: string, expires?: Date, refreshToken?: string) {
  return new Session({
    id: `offline_${SHOP}`,
    shop: SHOP,
    state: "",
    isOnline: false,
    accessToken: token,
    expires,
    refreshToken,
  });
}

function adminFor(token: string, graphql = vi.fn(async () => new Response(JSON.stringify({ token })))) {
  return { session: session(token), admin: { graphql } as never };
}

function deps(overrides: Partial<OfflineAdminDeps> = {}): OfflineAdminDeps {
  return {
    unauthenticatedAdmin: vi.fn(async () => adminFor("tok-1")),
    loadOfflineSession: vi.fn(async () => session("legacy-token")),
    storeSession: vi.fn(async () => true),
    migrateToExpiringToken: vi.fn(async () => ({
      session: session("expiring-token", new Date(Date.now() + 3600_000), "refresh-1"),
    })),
    ...overrides,
  };
}

const ENV_KEYS = ["SHOPIFY_EXPIRING_OFFLINE_TOKENS", "SHOPIFY_MIGRATE_TO_EXPIRING_TOKENS"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  __resetOfflineAdminForTests();
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.useRealTimers();
});

describe("env switches", () => {
  it("are OFF unless exactly 'true'", () => {
    expect(expiringOfflineTokensEnabled({})).toBe(false);
    expect(expiringOfflineTokensEnabled({ SHOPIFY_EXPIRING_OFFLINE_TOKENS: "1" })).toBe(false);
    expect(expiringOfflineTokensEnabled({ SHOPIFY_EXPIRING_OFFLINE_TOKENS: "TRUE" })).toBe(false);
    expect(expiringOfflineTokensEnabled({ SHOPIFY_EXPIRING_OFFLINE_TOKENS: " true " })).toBe(true);
  });

  it("honours the migration switch only while expiring tokens are on", () => {
    expect(migrateToExpiringTokensEnabled({ SHOPIFY_MIGRATE_TO_EXPIRING_TOKENS: "true" })).toBe(false);
    expect(
      migrateToExpiringTokensEnabled({
        SHOPIFY_EXPIRING_OFFLINE_TOKENS: "true",
        SHOPIFY_MIGRATE_TO_EXPIRING_TOKENS: "true",
      }),
    ).toBe(true);
    expect(migrateToExpiringTokensEnabled({ SHOPIFY_EXPIRING_OFFLINE_TOKENS: "true" })).toBe(false);
  });
});

describe("getOfflineAdmin", () => {
  it("caches a valid context and shares one acquisition between concurrent callers", async () => {
    const d = deps();
    configureOfflineAdmin(d);
    const [a, b, c] = await Promise.all([getOfflineAdmin(SHOP), getOfflineAdmin(SHOP), getOfflineAdmin(SHOP)]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    await getOfflineAdmin(SHOP);
    expect(d.unauthenticatedAdmin).toHaveBeenCalledTimes(1);
  });

  it("goes back through the library (which refreshes) when the cached token is close to expiry", async () => {
    const nearExpiry = { session: session("old", new Date(Date.now() + 60_000)), admin: {} as never };
    const d = deps({
      unauthenticatedAdmin: vi
        .fn()
        .mockResolvedValueOnce(nearExpiry)
        .mockResolvedValueOnce(adminFor("refreshed")),
    });
    configureOfflineAdmin(d);
    expect((await getOfflineAdmin(SHOP)).session.accessToken).toBe("old");
    expect((await getOfflineAdmin(SHOP)).session.accessToken).toBe("refreshed");
    expect(d.unauthenticatedAdmin).toHaveBeenCalledTimes(2);
  });

  it("reports a missing session as no_session", async () => {
    const err = Object.assign(new Error("Could not find a session for shop x"), { name: "SessionNotFoundError" });
    configureOfflineAdmin(deps({ unauthenticatedAdmin: vi.fn(async () => Promise.reject(err)) }));
    await expect(getOfflineAdmin(SHOP)).rejects.toMatchObject({ reason: "no_session" });
  });

  it("re-reads storage once after a failed refresh (another instance may have rotated the token)", async () => {
    const d = deps({
      unauthenticatedAdmin: vi
        .fn()
        .mockRejectedValueOnce(new Response(undefined, { status: 500 }))
        .mockResolvedValueOnce(adminFor("rotated-elsewhere")),
    });
    configureOfflineAdmin(d);
    expect(await getOfflineAccessToken(SHOP)).toBe("rotated-elsewhere");
    expect(d.unauthenticatedAdmin).toHaveBeenCalledTimes(2);
  });

  it("gives up with refresh_failed when the second read fails too, and caches nothing", async () => {
    const d = deps({
      unauthenticatedAdmin: vi.fn(async () => Promise.reject(new Response(undefined, { status: 500 }))),
    });
    configureOfflineAdmin(d);
    const error = await getOfflineAdmin(SHOP).catch((e) => e);
    expect(error).toBeInstanceOf(OfflineAdminUnavailableError);
    expect(error.reason).toBe("refresh_failed");
    expect(d.unauthenticatedAdmin).toHaveBeenCalledTimes(2);
  });
});

describe("forced reload and invalidation", () => {
  it("a forced reload does not hand back an acquisition that was already in flight", async () => {
    let releaseFirst!: (v: unknown) => void;
    const first = new Promise((r) => (releaseFirst = r)).then(() => adminFor("pre-401"));
    const d = deps({
      unauthenticatedAdmin: vi
        .fn()
        .mockReturnValueOnce(first)
        .mockResolvedValueOnce(adminFor("post-401")),
    });
    configureOfflineAdmin(d);
    const plain = getOfflineAdmin(SHOP);
    const forcedA = getOfflineAdmin(SHOP, { forceReload: true });
    const forcedB = getOfflineAdmin(SHOP, { forceReload: true });
    releaseFirst(undefined);
    expect((await plain).session.accessToken).toBe("pre-401");
    const [a, b] = await Promise.all([forcedA, forcedB]);
    expect(a.session.accessToken).toBe("post-401");
    // Still single-flight: both forced callers share ONE fresh acquisition.
    expect(b).toBe(a);
    expect(d.unauthenticatedAdmin).toHaveBeenCalledTimes(2);
  });

  it("a second wave of 401s joins a running acquisition that returns a DIFFERENT token than the refused one", async () => {
    let release!: (v: unknown) => void;
    const running = new Promise((r) => (release = r)).then(() => adminFor("fresh"));
    const d = deps({
      unauthenticatedAdmin: vi.fn().mockReturnValueOnce(running).mockResolvedValueOnce(adminFor("extra")),
    });
    configureOfflineAdmin(d);
    // First wave's fresh acquisition is out...
    const firstWave = getOfflineAdmin(SHOP);
    // ...when a second caller's 401 on the OLD token arrives.
    const secondWave = getOfflineAdmin(SHOP, { forceReload: true, refusedToken: "old" });
    release(undefined);
    expect((await firstWave).session.accessToken).toBe("fresh");
    expect((await secondWave).session.accessToken).toBe("fresh");
    expect(d.unauthenticatedAdmin).toHaveBeenCalledTimes(1);
  });

  it("a running acquisition that returns the REFUSED token is not reused", async () => {
    let release!: (v: unknown) => void;
    const running = new Promise((r) => (release = r)).then(() => adminFor("old"));
    const d = deps({
      unauthenticatedAdmin: vi.fn().mockReturnValueOnce(running).mockResolvedValueOnce(adminFor("new")),
    });
    configureOfflineAdmin(d);
    void getOfflineAdmin(SHOP);
    const forced = getOfflineAdmin(SHOP, { forceReload: true, refusedToken: "old" });
    release(undefined);
    expect((await forced).session.accessToken).toBe("new");
    expect(d.unauthenticatedAdmin).toHaveBeenCalledTimes(2);
  });

  it("invalidation drops the cache, and an acquisition that was out does not refill it", async () => {
    let release!: (v: unknown) => void;
    const slow = new Promise((r) => (release = r)).then(() => adminFor("before-reinstall"));
    const d = deps({
      unauthenticatedAdmin: vi
        .fn()
        .mockReturnValueOnce(slow)
        .mockResolvedValueOnce(adminFor("after-reinstall")),
    });
    configureOfflineAdmin(d);
    const pending = getOfflineAdmin(SHOP);
    invalidateOfflineAdmin(SHOP);
    release(undefined);
    expect((await pending).session.accessToken).toBe("before-reinstall");
    expect(await getOfflineAccessToken(SHOP)).toBe("after-reinstall");
    expect(d.unauthenticatedAdmin).toHaveBeenCalledTimes(2);
  });

  it("invalidation makes the next caller read storage again", async () => {
    const d = deps({
      unauthenticatedAdmin: vi.fn().mockResolvedValueOnce(adminFor("old")).mockResolvedValueOnce(adminFor("new")),
    });
    configureOfflineAdmin(d);
    expect(await getOfflineAccessToken(SHOP)).toBe("old");
    invalidateOfflineAdmin(SHOP);
    expect(await getOfflineAccessToken(SHOP)).toBe("new");
  });
});

describe("expired without a refresh token", () => {
  it("is reported, never handed out as a token", async () => {
    const expired = { session: session("dead", new Date(Date.now() - 1000)), admin: {} as never };
    configureOfflineAdmin(deps({ unauthenticatedAdmin: vi.fn(async () => expired) }));
    await expect(getOfflineAccessToken(SHOP)).rejects.toMatchObject({ reason: "refresh_failed" });
  });
});

describe("createRefreshingAdmin", () => {
  it("retries ONCE on a 401 with a forced reload", async () => {
    const unauthorized = Object.assign(new Error("Unauthorized"), { response: { code: 401 } });
    const staleGraphql = vi.fn(async () => Promise.reject(unauthorized));
    const freshGraphql = vi.fn(async () => new Response("{}"));
    const d = deps({
      unauthenticatedAdmin: vi
        .fn()
        .mockResolvedValueOnce(adminFor("stale", staleGraphql))
        .mockResolvedValueOnce(adminFor("fresh", freshGraphql)),
    });
    configureOfflineAdmin(d);
    const admin = createRefreshingAdmin(SHOP);
    await admin.graphql("query { shop { id } }" as never);
    expect(staleGraphql).toHaveBeenCalledTimes(1);
    expect(freshGraphql).toHaveBeenCalledTimes(1);
    expect(d.unauthenticatedAdmin).toHaveBeenCalledTimes(2);
  });

  it("does not retry other errors", async () => {
    const boom = new Error("GraphQL error");
    const graphql = vi.fn(async () => Promise.reject(boom));
    const d = deps({ unauthenticatedAdmin: vi.fn(async () => adminFor("t", graphql)) });
    configureOfflineAdmin(d);
    await expect(createRefreshingAdmin(SHOP).graphql("q" as never)).rejects.toBe(boom);
    expect(graphql).toHaveBeenCalledTimes(1);
  });

  it("recognises a 401 by shape", () => {
    expect(isUnauthorizedError({ response: { code: 401 } })).toBe(true);
    expect(isUnauthorizedError(new Response(null, { status: 401 }))).toBe(true);
    expect(isUnauthorizedError({ response: { code: 403 } })).toBe(false);
    expect(isUnauthorizedError(null)).toBe(false);
  });
});

describe("backgroundAdmin", () => {
  it("keeps the captured client with the flag OFF (unchanged behaviour)", () => {
    const captured = { graphql: vi.fn() };
    expect(backgroundAdmin(SHOP, captured)).toBe(captured);
  });

  it("hands out a refreshing client with the flag ON", async () => {
    process.env.SHOPIFY_EXPIRING_OFFLINE_TOKENS = "true";
    const d = deps();
    configureOfflineAdmin(d);
    const captured = { graphql: vi.fn() };
    const admin = backgroundAdmin(SHOP, captured);
    expect(admin).not.toBe(captured);
    await admin.graphql("q" as never);
    expect(captured.graphql).not.toHaveBeenCalled();
    expect(d.unauthenticatedAdmin).toHaveBeenCalledTimes(1);
  });
});

describe("backgroundAdmin with a self-refreshing raw client", () => {
  it("returns a marked raw client unchanged even with the flag ON", () => {
    process.env.SHOPIFY_EXPIRING_OFFLINE_TOKENS = "true";
    configureOfflineAdmin(deps());
    const raw = markSelfRefreshingAdminClient({ graphql: vi.fn() });
    expect(backgroundAdmin(SHOP, raw)).toBe(raw);
  });
});

describe("root-JS worker hook", () => {
  it("exposes the refreshed offline token process-wide", async () => {
    configureOfflineAdmin(deps());
    registerShopAccessTokenHook();
    expect(await globalThis.__getShopAccessToken!(SHOP)).toBe("tok-1");
  });
});

describe("maybeMigrateToExpiringToken", () => {
  it("does nothing by default", async () => {
    const d = deps();
    configureOfflineAdmin(d);
    expect(await maybeMigrateToExpiringToken(SHOP)).toBe("disabled");
    process.env.SHOPIFY_MIGRATE_TO_EXPIRING_TOKENS = "true"; // without the first switch
    expect(await maybeMigrateToExpiringToken(SHOP)).toBe("disabled");
    expect(d.loadOfflineSession).not.toHaveBeenCalled();
    expect(d.migrateToExpiringToken).not.toHaveBeenCalled();
    expect(migrationMayBeNeeded(SHOP)).toBe(false);
  });

  describe("with both switches on", () => {
    beforeEach(() => {
      process.env.SHOPIFY_EXPIRING_OFFLINE_TOKENS = "true";
      process.env.SHOPIFY_MIGRATE_TO_EXPIRING_TOKENS = "true";
    });

    it("migrates a non-expiring token once and stores the result (single-flight)", async () => {
      const d = deps();
      configureOfflineAdmin(d);
      const [a, b] = await Promise.all([maybeMigrateToExpiringToken(SHOP), maybeMigrateToExpiringToken(SHOP)]);
      expect(a).toBe("migrated");
      expect(b).toBe("migrated");
      expect(d.migrateToExpiringToken).toHaveBeenCalledTimes(1);
      expect(d.migrateToExpiringToken).toHaveBeenCalledWith({ shop: SHOP, nonExpiringOfflineAccessToken: "legacy-token" });
      expect(d.storeSession).toHaveBeenCalledTimes(1);
      expect(await maybeMigrateToExpiringToken(SHOP)).toBe("not_needed");
      expect(d.loadOfflineSession).toHaveBeenCalledTimes(1);
    });

    it("leaves an already expiring session alone", async () => {
      const d = deps({ loadOfflineSession: vi.fn(async () => session("x", new Date(Date.now() + 3600_000), "r")) });
      configureOfflineAdmin(d);
      expect(await maybeMigrateToExpiringToken(SHOP)).toBe("not_needed");
      expect(d.migrateToExpiringToken).not.toHaveBeenCalled();
    });

    it("never throws, and backs off after a failure", async () => {
      const d = deps({ migrateToExpiringToken: vi.fn(async () => Promise.reject(new Error("nope"))) });
      configureOfflineAdmin(d);
      expect(await maybeMigrateToExpiringToken(SHOP)).toBe("failed");
      expect(await maybeMigrateToExpiringToken(SHOP)).toBe("backoff");
      expect(d.migrateToExpiringToken).toHaveBeenCalledTimes(1);
      expect(d.storeSession).not.toHaveBeenCalled();
    });

    it("migrationMayBeNeeded answers false once settled, while running and in backoff", async () => {
      const d = deps();
      configureOfflineAdmin(d);
      expect(migrationMayBeNeeded(SHOP)).toBe(true);
      const p = maybeMigrateToExpiringToken(SHOP);
      expect(migrationMayBeNeeded(SHOP)).toBe(false); // in flight
      expect(await p).toBe("migrated");
      expect(migrationMayBeNeeded(SHOP)).toBe(false); // settled

      __resetOfflineAdminForTests();
      configureOfflineAdmin(deps({ migrateToExpiringToken: vi.fn(async () => Promise.reject(new Error("nope"))) }));
      expect(await maybeMigrateToExpiringToken(SHOP)).toBe("failed");
      expect(migrationMayBeNeeded(SHOP)).toBe(false); // backoff
    });

    it("does not store an exchange that came back without an expiry", async () => {
      const d = deps({ migrateToExpiringToken: vi.fn(async () => ({ session: session("odd") })) });
      configureOfflineAdmin(d);
      expect(await maybeMigrateToExpiringToken(SHOP)).toBe("failed");
      expect(d.storeSession).not.toHaveBeenCalled();
    });
  });
});
