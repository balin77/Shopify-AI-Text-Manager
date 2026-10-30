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

// The durable migration record lives in an in-memory fake of the Prisma table;
// the REAL store module (incl. the real AES helper) runs on top of it.
const h = vi.hoisted(() => ({ migrations: [] as Array<Record<string, any>> }));
vi.mock("~/db.server", async () => {
  const { fakeDelegate, migrationDefaults } = await import("../helpers/fake-prisma-tables");
  const db = { offlineTokenMigration: fakeDelegate(h.migrations, migrationDefaults) };
  return { db, default: db };
});

import { logger } from "~/utils/logger.server";
import { decryptToken, encryptToken, isEncrypted } from "~/utils/encryption.server";
import {
  __resetOfflineAdminForTests,
  backgroundAdmin,
  configureOfflineAdmin,
  createRefreshingAdmin,
  forgetOfflineTokenMigration,
  isNonExpiringTokenRejectedError,
  isPermanentMigrationError,
  MIGRATION_RETRY_DELAYS_MS,
  REFRESH_FAILED_TTL_MS,
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
  h.migrations.length = 0;
  vi.mocked(logger.error).mockClear();
  vi.mocked(logger.warn).mockClear();
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

    it("never throws, retries promptly, then backs off after a failure", async () => {
      vi.useFakeTimers();
      const d = deps({ migrateToExpiringToken: vi.fn(async () => Promise.reject(new Error("nope"))) });
      configureOfflineAdmin(d);
      const run = maybeMigrateToExpiringToken(SHOP);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await run).toBe("failed");
      expect(await maybeMigrateToExpiringToken(SHOP)).toBe("backoff");
      expect(d.migrateToExpiringToken).toHaveBeenCalledTimes(MIGRATION_RETRY_DELAYS_MS.length + 1);
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
      vi.useFakeTimers();
      configureOfflineAdmin(deps({ migrateToExpiringToken: vi.fn(async () => Promise.reject(new Error("nope"))) }));
      const run = maybeMigrateToExpiringToken(SHOP);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await run).toBe("failed");
      expect(migrationMayBeNeeded(SHOP)).toBe(false); // backoff
    });

    it("does not store an exchange that came back without an expiry", async () => {
      vi.useFakeTimers();
      const d = deps({ migrateToExpiringToken: vi.fn(async () => ({ session: session("odd") })) });
      configureOfflineAdmin(d);
      const run = maybeMigrateToExpiringToken(SHOP);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await run).toBe("failed");
      expect(d.storeSession).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// Durable, recoverable migration
// ---------------------------------------------------------------------------

/** What the library's HttpResponseError looks like for a failed token request. */
function exchangeError(code: number, error?: string) {
  return Object.assign(new Error(`Received an error response (${code}) from Shopify`), {
    response: { code, body: error ? { error } : {} },
  });
}

const NEW_PAIR = () => ({ session: session("expiring-token", new Date(Date.now() + 3600_000), "refresh-1") });

describe("durable migration (both switches on)", () => {
  beforeEach(() => {
    process.env.SHOPIFY_EXPIRING_OFFLINE_TOKENS = "true";
    process.env.SHOPIFY_MIGRATE_TO_EXPIRING_TOKENS = "true";
    vi.useFakeTimers();
  });

  async function settle<T>(p: Promise<T>): Promise<T> {
    await vi.advanceTimersByTimeAsync(60_000);
    return p;
  }

  it("persists the old token ENCRYPTED before the exchange, and erases it after the pair is stored", async () => {
    let seenDuringExchange: Record<string, any> | undefined;
    const d = deps({
      migrateToExpiringToken: vi.fn(async () => {
        seenDuringExchange = { ...h.migrations[0] };
        return NEW_PAIR();
      }),
    });
    configureOfflineAdmin(d);
    expect(await maybeMigrateToExpiringToken(SHOP)).toBe("migrated");

    expect(seenDuringExchange?.status).toBe("pending");
    expect(seenDuringExchange?.encryptedOldToken).not.toBe("legacy-token");
    expect(isEncrypted(seenDuringExchange?.encryptedOldToken)).toBe(true);
    expect(decryptToken(seenDuringExchange?.encryptedOldToken)).toBe("legacy-token");

    expect(h.migrations).toHaveLength(1);
    expect(h.migrations[0]).toMatchObject({ shop: SHOP, status: "migrated", encryptedOldToken: null, attempts: 1 });
    expect(h.migrations[0].completedAt).toBeInstanceOf(Date);
  });

  it("transient failure (network error, then 503) -> prompt retry -> success, within seconds", async () => {
    const migrate = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockRejectedValueOnce(exchangeError(503))
      .mockResolvedValueOnce(NEW_PAIR());
    const d = deps({ migrateToExpiringToken: migrate });
    configureOfflineAdmin(d);
    const run = maybeMigrateToExpiringToken(SHOP);
    await vi.advanceTimersByTimeAsync(MIGRATION_RETRY_DELAYS_MS[0] + MIGRATION_RETRY_DELAYS_MS[1] + 10);
    expect(await run).toBe("migrated");
    expect(migrate).toHaveBeenCalledTimes(3);
    // Every attempt presented the SAME old token (Shopify returns the same pair for it).
    for (const call of migrate.mock.calls) expect(call[0].nonExpiringOfflineAccessToken).toBe("legacy-token");
    expect(d.storeSession).toHaveBeenCalledTimes(1);
    expect(h.migrations[0]).toMatchObject({ status: "migrated", encryptedOldToken: null, attempts: 3 });
    // A retry is not an hour away: the shop is settled, not in backoff.
    expect(await maybeMigrateToExpiringToken(SHOP)).toBe("not_needed");
  });

  it("an exchange without a usable body is a transient failure too", async () => {
    const migrate = vi
      .fn()
      .mockResolvedValueOnce({ session: undefined })
      .mockResolvedValueOnce(NEW_PAIR());
    configureOfflineAdmin(deps({ migrateToExpiringToken: migrate }));
    expect(await settle(maybeMigrateToExpiringToken(SHOP))).toBe("migrated");
    expect(migrate).toHaveBeenCalledTimes(2);
  });

  it("storeSession() === false -> the exchange is repeated with the persisted old token", async () => {
    const d = deps({
      storeSession: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true),
    });
    configureOfflineAdmin(d);
    expect(await settle(maybeMigrateToExpiringToken(SHOP))).toBe("migrated");
    expect(d.migrateToExpiringToken).toHaveBeenCalledTimes(2);
    expect(d.storeSession).toHaveBeenCalledTimes(2);
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      expect.stringContaining("migrated on Shopify but NOT stored"),
      expect.anything(),
    );
  });

  it("storeSession throwing is handled like false", async () => {
    const d = deps({
      storeSession: vi.fn().mockRejectedValueOnce(new Error("db down")).mockResolvedValueOnce(true),
    });
    configureOfflineAdmin(d);
    expect(await settle(maybeMigrateToExpiringToken(SHOP))).toBe("migrated");
    expect(d.storeSession).toHaveBeenCalledTimes(2);
  });

  it("when the prompt retries run out the old token is KEPT, status failed, short backoff", async () => {
    const d = deps({ migrateToExpiringToken: vi.fn(async () => Promise.reject(exchangeError(502))) });
    configureOfflineAdmin(d);
    expect(await settle(maybeMigrateToExpiringToken(SHOP))).toBe("failed");
    expect(h.migrations[0]).toMatchObject({ status: "failed", attempts: MIGRATION_RETRY_DELAYS_MS.length + 1 });
    expect(decryptToken(h.migrations[0].encryptedOldToken)).toBe("legacy-token");
    expect(h.migrations[0].lastError).not.toContain("legacy-token");
    expect(await maybeMigrateToExpiringToken(SHOP)).toBe("backoff");
    // ...but not for an hour.
    await vi.advanceTimersByTimeAsync(11 * 60 * 1000);
    expect(migrationMayBeNeeded(SHOP)).toBe(true);
  });

  it("recovers when the stored session LOST its token: re-runs the exchange with the persisted old token", async () => {
    // Left behind by an earlier run: exchange succeeded on Shopify, the library
    // then overwrote the stored session with accessToken undefined.
    h.migrations.push({
      shop: SHOP,
      encryptedOldToken: encryptToken("legacy-token"),
      status: "pending",
      attempts: 1,
      lastError: null,
      startedAt: new Date(Date.now() - 3 * 24 * 3600_000),
      completedAt: null,
    });
    const d = deps({ loadOfflineSession: vi.fn(async () => session("")) });
    configureOfflineAdmin(d);
    expect(await maybeMigrateToExpiringToken(SHOP)).toBe("migrated");
    expect(d.migrateToExpiringToken).toHaveBeenCalledWith({ shop: SHOP, nonExpiringOfflineAccessToken: "legacy-token" });
    expect(d.storeSession).toHaveBeenCalledTimes(1);
    expect(h.migrations[0]).toMatchObject({ status: "migrated", encryptedOldToken: null });
    // The 7-day window is anchored at the FIRST attempt, not reset by the recovery.
    expect(Date.now() - h.migrations[0].startedAt.getTime()).toBeGreaterThan(2.9 * 24 * 3600_000);
  });

  it("does not recover after the 7-day window: needs_reauth, no exchange", async () => {
    h.migrations.push({
      shop: SHOP,
      encryptedOldToken: encryptToken("legacy-token"),
      status: "pending",
      attempts: 1,
      lastError: null,
      startedAt: new Date(Date.now() - 8 * 24 * 3600_000),
      completedAt: null,
    });
    const d = deps({ loadOfflineSession: vi.fn(async () => session("")) });
    configureOfflineAdmin(d);
    expect(await maybeMigrateToExpiringToken(SHOP)).toBe("needs_reauth");
    expect(d.migrateToExpiringToken).not.toHaveBeenCalled();
    expect(h.migrations[0]).toMatchObject({ status: "needs_reauth", encryptedOldToken: null });
  });

  it("a token-less session without any record is simply no_session", async () => {
    const d = deps({ loadOfflineSession: vi.fn(async () => session("")) });
    configureOfflineAdmin(d);
    expect(await maybeMigrateToExpiringToken(SHOP)).toBe("no_session");
    expect(d.migrateToExpiringToken).not.toHaveBeenCalled();
  });

  it("a record never revives an uninstalled shop (no session row)", async () => {
    h.migrations.push({
      shop: SHOP,
      encryptedOldToken: encryptToken("legacy-token"),
      status: "pending",
      attempts: 0,
      lastError: null,
      startedAt: new Date(),
      completedAt: null,
    });
    const d = deps({ loadOfflineSession: vi.fn(async () => undefined) });
    configureOfflineAdmin(d);
    expect(await maybeMigrateToExpiringToken(SHOP)).toBe("no_session");
    expect(d.migrateToExpiringToken).not.toHaveBeenCalled();
  });

  it("does not start an exchange it could not make recoverable (persisting fails)", async () => {
    const d = deps();
    configureOfflineAdmin(d);
    const { db } = await import("~/db.server");
    const spy = vi.spyOn(db.offlineTokenMigration, "upsert").mockRejectedValueOnce(new Error("db down"));
    expect(await maybeMigrateToExpiringToken(SHOP)).toBe("failed");
    expect(d.migrateToExpiringToken).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  describe("permanent errors", () => {
    it.each(["invalid_subject_token", "invalid_requested_token_type"])(
      "400 %s -> needs_reauth, logged once, never retried",
      async (code) => {
        const d = deps({ migrateToExpiringToken: vi.fn(async () => Promise.reject(exchangeError(400, code))) });
        configureOfflineAdmin(d);
        expect(await maybeMigrateToExpiringToken(SHOP)).toBe("needs_reauth");
        expect(d.migrateToExpiringToken).toHaveBeenCalledTimes(1); // no prompt retry either
        expect(h.migrations[0]).toMatchObject({ status: "needs_reauth", encryptedOldToken: null, attempts: 1 });
        expect(h.migrations[0].lastError).toContain(code);

        const needsReauthLogs = vi.mocked(logger.error).mock.calls.filter(([m]) => String(m).includes("NEEDS_REAUTH"));
        expect(needsReauthLogs).toHaveLength(1);
        expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain("legacy-token");

        // Later calls: no exchange, no further error log; scheduler and sweep see it.
        expect(await maybeMigrateToExpiringToken(SHOP)).toBe("needs_reauth");
        expect(migrationMayBeNeeded(SHOP)).toBe(false);
        expect(d.migrateToExpiringToken).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(24 * 3600_000);
        expect(await maybeMigrateToExpiringToken(SHOP)).toBe("needs_reauth");
      },
    );

    it("a needs_reauth record survives a restart: the first call reads it and does not exchange", async () => {
      h.migrations.push({ shop: SHOP, encryptedOldToken: null, status: "needs_reauth", attempts: 1, lastError: "x", startedAt: new Date(), completedAt: null });
      const d = deps();
      configureOfflineAdmin(d);
      expect(migrationMayBeNeeded(SHOP)).toBe(true); // not known in this process yet
      expect(await maybeMigrateToExpiringToken(SHOP)).toBe("needs_reauth");
      expect(migrationMayBeNeeded(SHOP)).toBe(false);
      expect(d.migrateToExpiringToken).not.toHaveBeenCalled();
    });

    it("a later token exchange (session now has expires) makes the shop not_needed and cleans the record up", async () => {
      h.migrations.push({ shop: SHOP, encryptedOldToken: null, status: "needs_reauth", attempts: 1, lastError: "x", startedAt: new Date(), completedAt: null });
      const d = deps({ loadOfflineSession: vi.fn(async () => session("x", new Date(Date.now() + 3600_000), "r")) });
      configureOfflineAdmin(d);
      expect(await maybeMigrateToExpiringToken(SHOP)).toBe("not_needed");
      expect(h.migrations).toHaveLength(0);
      expect(d.migrateToExpiringToken).not.toHaveBeenCalled();
    });

    it("afterAuth (forgetOfflineTokenMigration) lifts a needs_reauth shop and deletes the record", async () => {
      const d = deps({ migrateToExpiringToken: vi.fn(async () => Promise.reject(exchangeError(400, "invalid_subject_token"))) });
      configureOfflineAdmin(d);
      expect(await maybeMigrateToExpiringToken(SHOP)).toBe("needs_reauth");
      await forgetOfflineTokenMigration(SHOP);
      expect(h.migrations).toHaveLength(0);
      expect(migrationMayBeNeeded(SHOP)).toBe(true);
    });

    it("other 400s (e.g. invalid_client) and 401/5xx are NOT permanent", () => {
      expect(isPermanentMigrationError(exchangeError(400, "invalid_subject_token"))).toBe(true);
      expect(isPermanentMigrationError(exchangeError(400, "invalid_client"))).toBe(false);
      expect(isPermanentMigrationError(exchangeError(401, "invalid_subject_token"))).toBe(false);
      expect(isPermanentMigrationError(exchangeError(503))).toBe(false);
      expect(isPermanentMigrationError(new Error("boom"))).toBe(false);
      expect(isPermanentMigrationError(undefined)).toBe(false);
    });
  });

  it("forgetOfflineTokenMigration is a no-op (no database access) with the switch off", async () => {
    h.migrations.push({ shop: SHOP, encryptedOldToken: encryptToken("legacy-token"), status: "pending", attempts: 0, lastError: null, startedAt: new Date(), completedAt: null });
    delete process.env.SHOPIFY_EXPIRING_OFFLINE_TOKENS;
    await forgetOfflineTokenMigration(SHOP);
    expect(h.migrations).toHaveLength(1);
  });
});

describe("migration switches off: nothing is persisted or exchanged", () => {
  it("leaves the database alone", async () => {
    const d = deps();
    configureOfflineAdmin(d);
    expect(await maybeMigrateToExpiringToken(SHOP)).toBe("disabled");
    expect(h.migrations).toHaveLength(0);
    expect(d.loadOfflineSession).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 403 after the 2027-01-01 deadline
// ---------------------------------------------------------------------------

const DEADLINE_MESSAGE = "Non-expiring access tokens are no longer accepted for the Admin API.";

function forbidden(body: unknown, message = "Received an error response (403 Forbidden) from Shopify") {
  return Object.assign(new Error(message), { response: { code: 403, body } });
}

describe("403 'non-expiring access tokens are no longer accepted'", () => {
  it("is recognised by shape AND message (library error, parsed body, thrown Response)", async () => {
    expect(await isNonExpiringTokenRejectedError(forbidden({ errors: DEADLINE_MESSAGE }))).toBe(true);
    expect(await isNonExpiringTokenRejectedError(forbidden({}, `...403...:\n"${DEADLINE_MESSAGE}"`))).toBe(true);
    expect(
      await isNonExpiringTokenRejectedError(
        new Response(JSON.stringify({ errors: [{ message: DEADLINE_MESSAGE }] }), { status: 403 }),
      ),
    ).toBe(true);
  });

  it("does not treat other 403s (missing scope) or other statuses that way", async () => {
    expect(
      await isNonExpiringTokenRejectedError(
        forbidden({ errors: "Access denied for products field. Required access: `read_products` access scope." }),
      ),
    ).toBe(false);
    expect(await isNonExpiringTokenRejectedError(new Response("{}", { status: 403 }))).toBe(false);
    expect(await isNonExpiringTokenRejectedError(Object.assign(new Error(DEADLINE_MESSAGE), { response: { code: 401 } }))).toBe(false);
    expect(await isNonExpiringTokenRejectedError(new Error(DEADLINE_MESSAGE))).toBe(false); // no 403 shape
    expect(await isNonExpiringTokenRejectedError(null)).toBe(false);
  });

  it("createRefreshingAdmin: warns, starts the migration (switches on), rethrows the ORIGINAL error, no blind retry", async () => {
    process.env.SHOPIFY_EXPIRING_OFFLINE_TOKENS = "true";
    process.env.SHOPIFY_MIGRATE_TO_EXPIRING_TOKENS = "true";
    const boom = forbidden({ errors: DEADLINE_MESSAGE });
    const graphql = vi.fn(async () => Promise.reject(boom));
    const d = deps({ unauthenticatedAdmin: vi.fn(async () => adminFor("legacy-token", graphql)) });
    configureOfflineAdmin(d);
    await expect(createRefreshingAdmin(SHOP).graphql("q" as never)).rejects.toBe(boom);
    expect(graphql).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(expect.stringContaining("NON-expiring offline token"), { shop: SHOP });
    await vi.waitFor(() => expect(d.migrateToExpiringToken).toHaveBeenCalledTimes(1));
  });

  it("createRefreshingAdmin: with the switches OFF it warns but migrates nothing", async () => {
    const boom = forbidden({ errors: DEADLINE_MESSAGE });
    const d = deps({ unauthenticatedAdmin: vi.fn(async () => adminFor("t", vi.fn(async () => Promise.reject(boom)))) });
    configureOfflineAdmin(d);
    await expect(createRefreshingAdmin(SHOP).graphql("q" as never)).rejects.toBe(boom);
    expect(d.loadOfflineSession).not.toHaveBeenCalled();
    expect(d.migrateToExpiringToken).not.toHaveBeenCalled();
  });

  it("createRefreshingAdmin: a scope 403 is rethrown without any migration", async () => {
    process.env.SHOPIFY_EXPIRING_OFFLINE_TOKENS = "true";
    process.env.SHOPIFY_MIGRATE_TO_EXPIRING_TOKENS = "true";
    const scope = forbidden({ errors: "Required access: read_products" });
    const d = deps({ unauthenticatedAdmin: vi.fn(async () => adminFor("t", vi.fn(async () => Promise.reject(scope)))) });
    configureOfflineAdmin(d);
    await expect(createRefreshingAdmin(SHOP).graphql("q" as never)).rejects.toBe(scope);
    await Promise.resolve();
    expect(d.loadOfflineSession).not.toHaveBeenCalled();
    expect(vi.mocked(logger.warn)).not.toHaveBeenCalledWith(expect.stringContaining("NON-expiring"), expect.anything());
  });
});

// ---------------------------------------------------------------------------
// Negative cache after a failed refresh
// ---------------------------------------------------------------------------

describe("refresh_failed negative cache", () => {
  const failingDeps = () =>
    deps({ unauthenticatedAdmin: vi.fn(async () => Promise.reject(new Response(undefined, { status: 500 }))) });

  it("a loop of callers fails fast after the final refresh_failed instead of refreshing every time", async () => {
    vi.useFakeTimers();
    const d = failingDeps();
    configureOfflineAdmin(d);
    const first = getOfflineAdmin(SHOP).catch((e) => e);
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await first).reason).toBe("refresh_failed");
    expect(d.unauthenticatedAdmin).toHaveBeenCalledTimes(2); // try + the one re-read

    for (let i = 0; i < 20; i++) {
      await expect(getOfflineAdmin(SHOP)).rejects.toMatchObject({ reason: "refresh_failed" });
      await expect(getOfflineAdmin(SHOP, { forceReload: true })).rejects.toMatchObject({ reason: "refresh_failed" });
    }
    expect(d.unauthenticatedAdmin).toHaveBeenCalledTimes(2);
  });

  it("is cleared by invalidateOfflineAdmin", async () => {
    vi.useFakeTimers();
    const d = deps({
      unauthenticatedAdmin: vi
        .fn()
        .mockRejectedValueOnce(new Response(undefined, { status: 500 }))
        .mockRejectedValueOnce(new Response(undefined, { status: 500 }))
        .mockResolvedValue(adminFor("re-authenticated")),
    });
    configureOfflineAdmin(d);
    const first = getOfflineAdmin(SHOP).catch((e) => e);
    await vi.advanceTimersByTimeAsync(5_000);
    await first;
    await expect(getOfflineAdmin(SHOP)).rejects.toMatchObject({ reason: "refresh_failed" });
    invalidateOfflineAdmin(SHOP); // afterAuth stored a new session
    expect(await getOfflineAccessToken(SHOP)).toBe("re-authenticated");
  });

  it("expires by itself after REFRESH_FAILED_TTL_MS", async () => {
    vi.useFakeTimers();
    const d = deps({
      unauthenticatedAdmin: vi
        .fn()
        .mockRejectedValueOnce(new Response(undefined, { status: 500 }))
        .mockRejectedValueOnce(new Response(undefined, { status: 500 }))
        .mockResolvedValue(adminFor("back")),
    });
    configureOfflineAdmin(d);
    const first = getOfflineAdmin(SHOP).catch((e) => e);
    await vi.advanceTimersByTimeAsync(5_000);
    await first;
    await vi.advanceTimersByTimeAsync(REFRESH_FAILED_TTL_MS + 1);
    expect(await getOfflineAccessToken(SHOP)).toBe("back");
  });

  it("does not remember no_session (a shop that is simply not installed)", async () => {
    const err = Object.assign(new Error("Could not find a session"), { name: "SessionNotFoundError" });
    const d = deps({
      unauthenticatedAdmin: vi.fn().mockRejectedValueOnce(err).mockResolvedValue(adminFor("installed-now")),
    });
    configureOfflineAdmin(d);
    await expect(getOfflineAdmin(SHOP)).rejects.toMatchObject({ reason: "no_session" });
    expect(await getOfflineAccessToken(SHOP)).toBe("installed-now");
  });
});
