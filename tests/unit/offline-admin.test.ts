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
const h = vi.hoisted(() => ({ migrations: [] as Array<Record<string, any>>, install: [] as Array<Record<string, any>> }));
vi.mock("~/db.server", async () => {
  const { fakeDelegate, migrationDefaults } = await import("../helpers/fake-prisma-tables");
  const db = {
    offlineTokenMigration: fakeDelegate(h.migrations, migrationDefaults),
    shopInstallState: fakeDelegate(h.install),
  };
  return { db, default: db };
});

import { logger } from "~/utils/logger.server";
import * as store from "~/utils/offline-token-migration-store.server";
import { decryptToken, encryptToken, isEncrypted } from "~/utils/encryption.server";
import {
  __resetOfflineAdminForTests,
  backgroundAdmin,
  configureOfflineAdmin,
  createRefreshingAdmin,
  forgetOfflineTokenMigration,
  isNonExpiringTokenRejectedError,
  isMigrationConfigError,
  isPermanentMigrationError,
  MIGRATION_RETRY_DELAYS_MS,
  REFRESH_FAILED_TTL_MS,
  releaseStaleMigrationBlock,
  reportNonExpiringTokenRejection,
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
  h.install.length = 0;
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

    // Nothing needs a "migrated" row, so the record (and its credential) is gone.
    expect(h.migrations).toHaveLength(0);
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
    expect(h.migrations).toHaveLength(0);
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
    expect(h.migrations).toHaveLength(0);
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
    it.each(["invalid_subject_token"])(
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
      // about OUR request, not the shop: a separate, global class
      expect(isPermanentMigrationError(exchangeError(400, "invalid_requested_token_type"))).toBe(false);
      expect(isMigrationConfigError(exchangeError(400, "invalid_requested_token_type"))).toBe(true);
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
  // Remembered only for an EXPIRING session with the switch on (see refreshWasReallyRefused).
  const expiringStored = () => vi.fn(async () => session("x", new Date(Date.now() - 1000), "refresh"));
  beforeEach(() => {
    process.env.SHOPIFY_EXPIRING_OFFLINE_TOKENS = "true";
  });
  const failingDeps = () =>
    deps({
      loadOfflineSession: expiringStored(),
      unauthenticatedAdmin: vi.fn(async () => Promise.reject(new Response(undefined, { status: 500 }))),
    });

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
      loadOfflineSession: expiringStored(),
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
      loadOfflineSession: expiringStored(),
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

  it("does NOT change behaviour with the switch OFF (a pool/db error twice does not fail callers fast)", async () => {
    vi.useFakeTimers();
    delete process.env.SHOPIFY_EXPIRING_OFFLINE_TOKENS;
    const d = failingDeps();
    configureOfflineAdmin(d);
    const first = getOfflineAdmin(SHOP).catch((e) => e);
    await vi.advanceTimersByTimeAsync(5_000);
    await first;
    const second = getOfflineAdmin(SHOP).catch((e) => e);
    await vi.advanceTimersByTimeAsync(5_000);
    await second;
    expect(d.unauthenticatedAdmin).toHaveBeenCalledTimes(4); // asked again, no negative cache
  });

  it("does NOT remember a failure of a session that has no expiry / refresh token", async () => {
    vi.useFakeTimers();
    const d = deps({
      loadOfflineSession: vi.fn(async () => session("legacy")),
      unauthenticatedAdmin: vi.fn(async () => Promise.reject(new Error("pool exhausted"))),
    });
    configureOfflineAdmin(d);
    const first = getOfflineAdmin(SHOP).catch((e) => e);
    await vi.advanceTimersByTimeAsync(5_000);
    await first;
    const second = getOfflineAdmin(SHOP).catch((e) => e);
    await vi.advanceTimersByTimeAsync(5_000);
    await second;
    expect(d.unauthenticatedAdmin).toHaveBeenCalledTimes(4);
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

// ---------------------------------------------------------------------------
// Hardening round 1: races, config error, backoff, hygiene
// ---------------------------------------------------------------------------

describe("migration races (switches on)", () => {
  beforeEach(() => {
    process.env.SHOPIFY_EXPIRING_OFFLINE_TOKENS = "true";
    process.env.SHOPIFY_MIGRATE_TO_EXPIRING_TOKENS = "true";
    vi.useFakeTimers();
  });
  const seedRecovery = () =>
    h.migrations.push({
      shop: SHOP,
      encryptedOldToken: encryptToken("legacy-token"),
      status: "pending",
      attempts: 1,
      lastError: null,
      startedAt: new Date(Date.now() - 3600_000),
      updatedAt: new Date(),
      completedAt: null,
    });

  it("(A) a recovery replay does not overwrite the pair a token exchange stored meanwhile", async () => {
    seedRecovery();
    let stored: Session = session("");
    const d = deps({
      loadOfflineSession: vi.fn(async () => stored),
      migrateToExpiringToken: vi.fn().mockRejectedValueOnce(exchangeError(503)).mockResolvedValue(NEW_PAIR()),
    });
    configureOfflineAdmin(d);
    const run = maybeMigrateToExpiringToken(SHOP);
    await vi.advanceTimersByTimeAsync(500);
    // the merchant opens the app during the retry pause: library stores P2, afterAuth forgets the record
    stored = session("P2", new Date(Date.now() + 3600_000), "r2");
    await forgetOfflineTokenMigration(SHOP);
    await vi.advanceTimersByTimeAsync(10_000);
    // the re-issue (afterAuth -> forget) changed the epoch: the run stops, stores nothing
    expect(await run).toBe("no_session");
    expect(d.storeSession).not.toHaveBeenCalled();
    expect(h.migrations).toHaveLength(0); // and no record re-created
  });

  it("(A2) a token-less session that got ANOTHER token meanwhile aborts the run too", async () => {
    seedRecovery();
    let stored: Session = session("");
    const d = deps({
      loadOfflineSession: vi.fn(async () => stored),
      migrateToExpiringToken: vi.fn().mockRejectedValueOnce(exchangeError(503)).mockResolvedValue(NEW_PAIR()),
    });
    configureOfflineAdmin(d);
    const run = maybeMigrateToExpiringToken(SHOP);
    await vi.advanceTimersByTimeAsync(500);
    stored = session("someone-elses-token");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await run).toBe("backoff");
    expect(d.storeSession).not.toHaveBeenCalled();
  });

  it("(B) app/uninstalled between reading the record and persisting: no record, no session re-created", async () => {
    // 1st read: still installed; every later read (after the upsert): gone.
    const load = vi.fn().mockResolvedValueOnce(session("legacy-token")).mockResolvedValue(undefined);
    const d = deps({ loadOfflineSession: load });
    configureOfflineAdmin(d);
    expect(await maybeMigrateToExpiringToken(SHOP)).toBe("no_session");
    expect(d.migrateToExpiringToken).not.toHaveBeenCalled();
    expect(d.storeSession).not.toHaveBeenCalled();
    expect(h.migrations).toHaveLength(0); // the upsert's record was taken back out
  });

  it("(B2) the shop is uninstalled while the exchange is out: the returned pair is not stored", async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce(session("legacy-token")) // runMigration
      .mockResolvedValueOnce(session("legacy-token")) // after persist
      .mockResolvedValue(undefined); // before storeSession
    const d = deps({ loadOfflineSession: load });
    configureOfflineAdmin(d);
    expect(await maybeMigrateToExpiringToken(SHOP)).toBe("no_session");
    expect(d.migrateToExpiringToken).toHaveBeenCalledTimes(1);
    expect(d.storeSession).not.toHaveBeenCalled();
    expect(h.migrations).toHaveLength(0);
  });

  it("the store's mark functions never re-create a deleted row", async () => {
    await store.markMigrationNeedsReauth(SHOP, "x", 1);
    await store.markMigrationFailed(SHOP, "x", 1);
    expect(h.migrations).toHaveLength(0);
  });
});

describe("needs_reauth healing and the global config error", () => {
  beforeEach(() => {
    process.env.SHOPIFY_EXPIRING_OFFLINE_TOKENS = "true";
    process.env.SHOPIFY_MIGRATE_TO_EXPIRING_TOKENS = "true";
    vi.useFakeTimers();
  });

  it("invalid_subject_token also blanks the dead token in the session store (next visit token-exchanges directly)", async () => {
    const d = deps({ migrateToExpiringToken: vi.fn(async () => Promise.reject(exchangeError(400, "invalid_subject_token"))) });
    configureOfflineAdmin(d);
    expect(await maybeMigrateToExpiringToken(SHOP)).toBe("needs_reauth");
    expect(d.storeSession).toHaveBeenCalledTimes(1);
    const cleared = vi.mocked(d.storeSession).mock.calls[0][0];
    expect(cleared.shop).toBe(SHOP);
    expect(cleared.accessToken).toBeUndefined();
    expect(h.migrations[0]).toMatchObject({ status: "needs_reauth", encryptedOldToken: null });
  });

  it("invalid_requested_token_type is a GLOBAL config error: no needs_reauth, token kept, every shop paused", async () => {
    const d = deps({ migrateToExpiringToken: vi.fn(async () => Promise.reject(exchangeError(400, "invalid_requested_token_type"))) });
    configureOfflineAdmin(d);
    expect(await maybeMigrateToExpiringToken(SHOP)).toBe("failed");
    expect(d.migrateToExpiringToken).toHaveBeenCalledTimes(1); // no prompt retries
    expect(d.storeSession).not.toHaveBeenCalled(); // session untouched
    // nothing counted, no persisted backoff: the record is as persist left it
    expect(h.migrations[0]).toMatchObject({ status: "pending", attempts: 0 });
    expect(decryptToken(h.migrations[0].encryptedOldToken)).toBe("legacy-token"); // not erased
    const errors = JSON.stringify(vi.mocked(logger.error).mock.calls);
    expect(errors).toContain("CONFIG ERROR");
    expect(errors).not.toContain("NEEDS_REAUTH");

    // another shop is held as well, for hours
    expect(migrationMayBeNeeded("other.myshopify.com")).toBe(false);
    expect(await maybeMigrateToExpiringToken("other.myshopify.com")).toBe("backoff");
    await vi.advanceTimersByTimeAsync(5 * 3600_000);
    expect(migrationMayBeNeeded("other.myshopify.com")).toBe(false);
    await vi.advanceTimersByTimeAsync(2 * 3600_000);
    expect(migrationMayBeNeeded("other.myshopify.com")).toBe(true);
  });
});

describe("persisted backoff and the attempt cap", () => {
  beforeEach(() => {
    process.env.SHOPIFY_EXPIRING_OFFLINE_TOKENS = "true";
    process.env.SHOPIFY_MIGRATE_TO_EXPIRING_TOKENS = "true";
    vi.useFakeTimers();
  });
  const seedFailed = (attempts: number, updatedAgoMs: number) =>
    h.migrations.push({
      shop: SHOP,
      encryptedOldToken: encryptToken("legacy-token"),
      status: "failed",
      attempts,
      lastError: "x",
      startedAt: new Date(Date.now() - 3600_000),
      updatedAt: new Date(Date.now() - updatedAgoMs),
      completedAt: null,
    });

  it("a failed record waits its (doubling) persisted backoff, also after a restart", async () => {
    seedFailed(8, 5 * 60_000); // 2 failed runs -> 20 min, 5 min ago
    const d = deps();
    configureOfflineAdmin(d);
    expect(await maybeMigrateToExpiringToken(SHOP)).toBe("backoff");
    expect(d.migrateToExpiringToken).not.toHaveBeenCalled();
    expect(migrationMayBeNeeded(SHOP)).toBe(false);
    await vi.advanceTimersByTimeAsync(16 * 60_000);
    expect(await maybeMigrateToExpiringToken(SHOP)).toBe("migrated");
  });

  it("gives up at the cap: logged once, then skipped for good", async () => {
    seedFailed(36, 25 * 3600_000); // 36 + 4 = 40 = MIGRATION_MAX_ATTEMPTS
    const d = deps({ migrateToExpiringToken: vi.fn(async () => Promise.reject(exchangeError(400, "invalid_request"))) });
    configureOfflineAdmin(d);
    const run = maybeMigrateToExpiringToken(SHOP);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await run).toBe("failed");
    expect(h.migrations[0].attempts).toBe(store.MIGRATION_MAX_ATTEMPTS);
    const gaveUp = vi.mocked(logger.error).mock.calls.filter(([m]) => String(m).includes("MIGRATION_GAVE_UP"));
    expect(gaveUp).toHaveLength(1);
    vi.mocked(d.migrateToExpiringToken).mockClear();
    __resetOfflineAdminForTests();
    configureOfflineAdmin(d);
    expect(await maybeMigrateToExpiringToken(SHOP)).toBe("backoff");
    await vi.advanceTimersByTimeAsync(30 * 24 * 3600_000);
    expect(await maybeMigrateToExpiringToken(SHOP)).toBe("backoff");
    expect(d.migrateToExpiringToken).not.toHaveBeenCalled();
    expect((await store.listBlockingRecords(Date.now(), 4)).map((r) => r.shop)).toEqual([SHOP]);
    // the ciphertext of a given-up record is erased, the fingerprint stays
    expect(h.migrations[0].encryptedOldToken).toBeNull();
    expect(h.migrations[0].tokenFingerprint).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("hygiene", () => {
  beforeEach(() => {
    process.env.SHOPIFY_EXPIRING_OFFLINE_TOKENS = "true";
    process.env.SHOPIFY_MIGRATE_TO_EXPIRING_TOKENS = "true";
  });

  it("forgetOfflineTokenMigration({ force }) deletes even with the switches off (uninstall after a rollback)", async () => {
    delete process.env.SHOPIFY_EXPIRING_OFFLINE_TOKENS;
    h.migrations.push({ shop: SHOP, encryptedOldToken: encryptToken("legacy-token"), status: "pending", attempts: 0, lastError: null, startedAt: new Date(), updatedAt: new Date(), completedAt: null });
    await forgetOfflineTokenMigration(SHOP);
    expect(h.migrations).toHaveLength(1);
    await forgetOfflineTokenMigration(SHOP, { force: true });
    expect(h.migrations).toHaveLength(0);
  });

  it("a database error while persisting is never logged with its message (it can echo the ciphertext)", async () => {
    const d = deps();
    configureOfflineAdmin(d);
    const { db } = await import("~/db.server");
    const spy = vi
      .spyOn(db.offlineTokenMigration, "upsert")
      .mockRejectedValueOnce(Object.assign(new Error('Invalid upsert() invocation: encryptedOldToken: "SECRET-CIPHERTEXT"'), { name: "PrismaClientKnownRequestError", code: "P2002" }));
    expect(await maybeMigrateToExpiringToken(SHOP)).toBe("failed");
    const logged = JSON.stringify([vi.mocked(logger.error).mock.calls, vi.mocked(logger.warn).mock.calls]);
    expect(logged).not.toContain("SECRET-CIPHERTEXT");
    expect(logged).toContain("P2002");
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Hardening round 2: stale records, healing after the deadline, hygiene
// ---------------------------------------------------------------------------

const row = (over: Record<string, any>) => ({
  shop: SHOP,
  encryptedOldToken: null,
  tokenFingerprint: store.fingerprintToken("old-token"),
  status: "needs_reauth",
  attempts: 1,
  lastError: "x",
  startedAt: new Date(),
  updatedAt: new Date(),
  completedAt: null,
  ...over,
});

describe("stale records (fingerprint)", () => {
  beforeEach(() => {
    process.env.SHOPIFY_EXPIRING_OFFLINE_TOKENS = "true";
    process.env.SHOPIFY_MIGRATE_TO_EXPIRING_TOKENS = "true";
    vi.useFakeTimers();
  });

  it("persists a fingerprint (16 hex chars), never the token, and keeps it through needs_reauth", async () => {
    let during: Record<string, any> | undefined;
    const d = deps({
      migrateToExpiringToken: vi.fn(async () => {
        during = { ...h.migrations[0] };
        throw exchangeError(400, "invalid_subject_token");
      }),
    });
    configureOfflineAdmin(d);
    await maybeMigrateToExpiringToken(SHOP);
    expect(during?.tokenFingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(h.migrations)).not.toContain("legacy-token");
    expect(h.migrations[0]).toMatchObject({ status: "needs_reauth", encryptedOldToken: null, tokenFingerprint: during?.tokenFingerprint });
  });

  it.each([
    ["needs_reauth", {}],
    ["given up", { status: "failed", attempts: 40, encryptedOldToken: encryptToken("old-token") }],
    ["in backoff", { status: "failed", attempts: 4, encryptedOldToken: encryptToken("old-token") }],
  ])("a %s record of ANOTHER token is discarded and the shop migrates normally", async (_n, over) => {
    h.migrations.push(row(over));
    const d = deps({ loadOfflineSession: vi.fn(async () => session("brand-new-nonexpiring")) });
    configureOfflineAdmin(d);
    expect(await maybeMigrateToExpiringToken(SHOP)).toBe("migrated");
    expect(d.migrateToExpiringToken).toHaveBeenCalledWith({ shop: SHOP, nonExpiringOfflineAccessToken: "brand-new-nonexpiring" });
    expect(h.migrations).toHaveLength(0);
  });

  it("a needs_reauth record of the SAME token still blocks", async () => {
    h.migrations.push(row({ tokenFingerprint: store.fingerprintToken("legacy-token") }));
    const d = deps();
    configureOfflineAdmin(d);
    expect(await maybeMigrateToExpiringToken(SHOP)).toBe("needs_reauth");
    expect(d.migrateToExpiringToken).not.toHaveBeenCalled();
    expect(h.migrations).toHaveLength(1);
  });

  it("a legacy row without fingerprint behaves as before", async () => {
    h.migrations.push(row({ tokenFingerprint: null }));
    configureOfflineAdmin(deps());
    expect(await maybeMigrateToExpiringToken(SHOP)).toBe("needs_reauth");
  });

  it("(m7) a different token appearing mid-run deletes the persisted ciphertext", async () => {
    const load = vi.fn().mockResolvedValueOnce(session("legacy-token")).mockResolvedValue(session("someone-else"));
    configureOfflineAdmin(deps({ loadOfflineSession: load }));
    expect(await maybeMigrateToExpiringToken(SHOP)).toBe("backoff");
    expect(h.migrations).toHaveLength(0);
  });

  it("(m6) releaseStaleMigrationBlock honours a database reset: in-process backoff/needs_reauth are dropped", async () => {
    const d = deps({ migrateToExpiringToken: vi.fn(async () => Promise.reject(exchangeError(400, "invalid_subject_token"))) });
    configureOfflineAdmin(d);
    expect(await maybeMigrateToExpiringToken(SHOP)).toBe("needs_reauth");
    expect(migrationMayBeNeeded(SHOP)).toBe(false);
    h.migrations.length = 0; // operator: DELETE FROM "OfflineTokenMigration" ...
    releaseStaleMigrationBlock(SHOP);
    expect(migrationMayBeNeeded(SHOP)).toBe(true);
  });
});

describe("healing after the deadline when no migration can run", () => {
  beforeEach(() => {
    process.env.SHOPIFY_EXPIRING_OFFLINE_TOKENS = "true";
    process.env.SHOPIFY_MIGRATE_TO_EXPIRING_TOKENS = "true";
  });
  const run = async (d: OfflineAdminDeps) => {
    configureOfflineAdmin(d);
    const boom = forbidden({ errors: DEADLINE_MESSAGE });
    const admin = adminFor("legacy-token", vi.fn(async () => Promise.reject(boom)));
    vi.mocked(d.unauthenticatedAdmin).mockResolvedValue(admin);
    await expect(createRefreshingAdmin(SHOP).graphql("q" as never)).rejects.toBe(boom);
  };
  const blanked = (d: OfflineAdminDeps) =>
    vi.mocked(d.storeSession).mock.calls.some(([s]) => s.accessToken === undefined);

  it("needs_reauth that was NOT blanked: the refused token is blanked, once, logged", async () => {
    h.migrations.push(row({ tokenFingerprint: store.fingerprintToken("legacy-token") }));
    const d = deps();
    await run(d);
    await vi.waitFor(() => expect(blanked(d)).toBe(true));
    expect(d.migrateToExpiringToken).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).toContain("Blanked the refused non-expiring token");
    expect(h.migrations).toHaveLength(1); // record stays the ops-visible fact
  });

  it("a given-up record: ONE run is re-armed first; when it fails the dead token IS blanked (else the library never token-exchanges)", async () => {
    vi.useFakeTimers();
    h.migrations.push(row({ status: "failed", attempts: 40, tokenFingerprint: store.fingerprintToken("legacy-token"), encryptedOldToken: null }));
    const d = deps({ migrateToExpiringToken: vi.fn(async () => Promise.reject(exchangeError(503))) });
    configureOfflineAdmin(d);
    reportNonExpiringTokenRejection(SHOP, "legacy-token");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(d.migrateToExpiringToken).toHaveBeenCalledTimes(4); // exactly one run, with the session's token
    expect(vi.mocked(d.migrateToExpiringToken).mock.calls[0][0].nonExpiringOfflineAccessToken).toBe("legacy-token");
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).toContain("ONE more migration run");
    expect(h.migrations[0].attempts).toBe(store.MIGRATION_MAX_ATTEMPTS + 3);
    expect(blanked(d)).toBe(true); // terminal again -> the session no longer keeps the dead token
    const blanks = () => vi.mocked(d.storeSession).mock.calls.filter(([x]) => x.accessToken === undefined).length;
    expect(blanks()).toBe(1);
    // the NEXT throttled 403 (key already re-armed) falls through to the blanking again, no second run
    await vi.advanceTimersByTimeAsync(61_000);
    reportNonExpiringTokenRejection(SHOP, "legacy-token");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(d.migrateToExpiringToken).toHaveBeenCalledTimes(4);
    expect(blanks()).toBe(2);
  });

  it("a re-armed run that succeeds migrates the shop", async () => {
    h.migrations.push(row({ status: "failed", attempts: 40, tokenFingerprint: store.fingerprintToken("legacy-token"), encryptedOldToken: null }));
    const d = deps();
    await run(d);
    await vi.waitFor(() => expect(d.storeSession).toHaveBeenCalledTimes(1));
    expect(vi.mocked(d.storeSession).mock.calls[0][0].accessToken).toBe("expiring-token");
    expect(h.migrations).toHaveLength(0);
  });

  it("NOT blanked while a migration can still succeed (transient backoff inside the 7-day window)", async () => {
    h.migrations.push(row({ status: "failed", attempts: 4, tokenFingerprint: store.fingerprintToken("legacy-token"), encryptedOldToken: encryptToken("legacy-token") }));
    const d = deps();
    await run(d);
    await new Promise((r) => setTimeout(r, 50));
    expect(blanked(d)).toBe(false);
  });

  it("NOT blanked when the failed record is past the 7-day window but the session still HOLDS the token (the next exchange decides)", async () => {
    h.migrations.push(row({ status: "failed", attempts: 4, startedAt: new Date(Date.now() - 8 * 24 * 3600_000), tokenFingerprint: store.fingerprintToken("legacy-token"), encryptedOldToken: encryptToken("legacy-token") }));
    const d = deps();
    await run(d);
    await new Promise((r) => setTimeout(r, 50));
    expect(blanked(d)).toBe(false);
  });

  it("NOT blanked when the stored token is no longer the refused one", async () => {
    h.migrations.push(row({ tokenFingerprint: store.fingerprintToken("legacy-token") }));
    const d = deps({ loadOfflineSession: vi.fn(async () => session("already-someone-elses")) });
    await run(d);
    await new Promise((r) => setTimeout(r, 50));
    expect(blanked(d)).toBe(false);
  });
});

describe("log accuracy and error hygiene", () => {
  beforeEach(() => {
    process.env.SHOPIFY_EXPIRING_OFFLINE_TOKENS = "true";
    process.env.SHOPIFY_MIGRATE_TO_EXPIRING_TOKENS = "true";
    vi.useFakeTimers();
  });
  const refused = () => vi.fn(async () => Promise.reject(exchangeError(400, "invalid_subject_token")));
  const needsReauthLog = () =>
    vi.mocked(logger.error).mock.calls.map(([m]) => String(m)).filter((m) => m.includes("NEEDS_REAUTH"));

  it("(m3) says the token was blanked when it was", async () => {
    configureOfflineAdmin(deps({ migrateToExpiringToken: refused() }));
    await maybeMigrateToExpiringToken(SHOP);
    expect(needsReauthLog()).toHaveLength(1);
    expect(needsReauthLog()[0]).toContain("was blanked");
    expect(needsReauthLog()[0]).toContain("Shopify refused the stored token");
  });

  it("(m3) says it could NOT be blanked when the write failed", async () => {
    configureOfflineAdmin(deps({ migrateToExpiringToken: refused(), storeSession: vi.fn(async () => false) }));
    await maybeMigrateToExpiringToken(SHOP);
    expect(needsReauthLog()[0]).toContain("could NOT be blanked");
  });

  it("(m3) the recovery-window path names its own cause", async () => {
    h.migrations.push(row({ status: "pending", startedAt: new Date(Date.now() - 8 * 24 * 3600_000), tokenFingerprint: null, encryptedOldToken: encryptToken("old-token") }));
    configureOfflineAdmin(deps({ loadOfflineSession: vi.fn(async () => session("")) }));
    expect(await maybeMigrateToExpiringToken(SHOP)).toBe("needs_reauth");
    expect(needsReauthLog()[0]).toContain("7-day recovery window is over");
  });

  it("(m1) a storeSession error never reaches lastError or the logs with its message", async () => {
    const leaky = Object.assign(new Error('Invalid create() invocation: accessToken: "SECRET-SESSION-TOKEN"'), { name: "PrismaClientValidationError" });
    const d = deps({ storeSession: vi.fn(async () => Promise.reject(leaky)) });
    configureOfflineAdmin(d);
    const p = maybeMigrateToExpiringToken(SHOP);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await p).toBe("failed");
    const everything = JSON.stringify([h.migrations, vi.mocked(logger.error).mock.calls, vi.mocked(logger.warn).mock.calls]);
    expect(everything).not.toContain("SECRET-SESSION-TOKEN");
    expect(everything).toContain("PrismaClientValidationError");
  });
});

// ---------------------------------------------------------------------------
// Hardening round 3
// ---------------------------------------------------------------------------

describe("C1: the global config hold never erases a token", () => {
  beforeEach(() => {
    process.env.SHOPIFY_EXPIRING_OFFLINE_TOKENS = "true";
    process.env.SHOPIFY_MIGRATE_TO_EXPIRING_TOKENS = "true";
  });
  const hold = async (d: OfflineAdminDeps) => {
    // another shop's migration hits invalid_requested_token_type -> global hold
    vi.mocked(d.migrateToExpiringToken).mockRejectedValueOnce(exchangeError(400, "invalid_requested_token_type"));
    expect(await maybeMigrateToExpiringToken("held.myshopify.com")).toBe("failed");
  };
  const fire = async (d: OfflineAdminDeps) => {
    const boom = forbidden({ errors: DEADLINE_MESSAGE });
    vi.mocked(d.unauthenticatedAdmin).mockResolvedValue(adminFor("legacy-token", vi.fn(async () => Promise.reject(boom))));
    await expect(createRefreshingAdmin(SHOP).graphql("q" as never)).rejects.toBe(boom);
    await new Promise((r) => setTimeout(r, 50));
  };
  const blanked = (d: OfflineAdminDeps) => vi.mocked(d.storeSession).mock.calls.some(([x]) => x.accessToken === undefined);

  it("hold active, shop WITHOUT a record, deadline 403: token kept", async () => {
    const d = deps();
    configureOfflineAdmin(d);
    await hold(d);
    await fire(d);
    expect(blanked(d)).toBe(false);
  });

  it("hold active, shop with a pending record, deadline 403: token kept", async () => {
    const d = deps();
    configureOfflineAdmin(d);
    h.migrations.push(row({ status: "pending", encryptedOldToken: encryptToken("legacy-token"), tokenFingerprint: store.fingerprintToken("legacy-token") }));
    await hold(d);
    await fire(d);
    expect(blanked(d)).toBe(false);
  });

  it("a deadline 403 for a shop without any record never blanks (no durable verdict)", async () => {
    const d = deps();
    configureOfflineAdmin(d);
    await fire(d);
    expect(blanked(d)).toBe(false);
  });
});

describe("M1: a session blanked by our own exchange is still ours", () => {
  beforeEach(() => {
    process.env.SHOPIFY_EXPIRING_OFFLINE_TOKENS = "true";
    process.env.SHOPIFY_MIGRATE_TO_EXPIRING_TOKENS = "true";
    vi.useFakeTimers();
  });

  it("T at start, '' before the store: the pair is stored and the record handled as on success", async () => {
    const load = vi.fn().mockResolvedValueOnce(session("legacy-token")).mockResolvedValueOnce(session("legacy-token")).mockResolvedValue(session(""));
    const d = deps({ loadOfflineSession: load });
    configureOfflineAdmin(d);
    expect(await maybeMigrateToExpiringToken(SHOP)).toBe("migrated");
    expect(d.storeSession).toHaveBeenCalledTimes(1);
    expect(vi.mocked(d.storeSession).mock.calls[0][0].accessToken).toBe("expiring-token");
    expect(h.migrations).toHaveLength(0);
  });

  it("T at start, '' already at the persist checkpoint: the record is KEPT (not deleted as 'different token')", async () => {
    const load = vi.fn().mockResolvedValueOnce(session("legacy-token")).mockResolvedValue(session(""));
    const d = deps({ loadOfflineSession: load, migrateToExpiringToken: vi.fn(async () => Promise.reject(exchangeError(503))) });
    configureOfflineAdmin(d);
    const run = maybeMigrateToExpiringToken(SHOP);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await run).toBe("failed");
    expect(h.migrations).toHaveLength(1);
    expect(decryptToken(h.migrations[0].encryptedOldToken)).toBe("legacy-token");
  });

  it("only a DIFFERENT non-empty token deletes the record", async () => {
    const load = vi.fn().mockResolvedValueOnce(session("legacy-token")).mockResolvedValue(session("other-nonempty"));
    configureOfflineAdmin(deps({ loadOfflineSession: load }));
    expect(await maybeMigrateToExpiringToken(SHOP)).toBe("backoff");
    expect(h.migrations).toHaveLength(0);
  });
});

describe("heal throttle", () => {
  it("a loop of deadline 403s costs one heal read per window, not one per call", async () => {
    process.env.SHOPIFY_EXPIRING_OFFLINE_TOKENS = "true";
    process.env.SHOPIFY_MIGRATE_TO_EXPIRING_TOKENS = "true";
    h.migrations.push(row({ tokenFingerprint: store.fingerprintToken("legacy-token") }));
    const d = deps();
    configureOfflineAdmin(d);
    const { db } = await import("~/db.server");
    const spy = vi.spyOn(db.offlineTokenMigration, "findUnique");
    const boom = forbidden({ errors: DEADLINE_MESSAGE });
    vi.mocked(d.unauthenticatedAdmin).mockResolvedValue(adminFor("legacy-token", vi.fn(async () => Promise.reject(boom))));
    const admin = createRefreshingAdmin(SHOP);
    for (let i = 0; i < 3; i++) {
      await expect(admin.graphql("q" as never)).rejects.toBe(boom);
      await new Promise((r) => setTimeout(r, 30));
    }
    // 1st call: runMigration reads the record + the heal reads it; later calls: in-process needs_reauth, heal throttled
    expect(spy.mock.calls.length).toBe(2);
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Hardening round 4
// ---------------------------------------------------------------------------

describe("invalid_client is a global config error too", () => {
  beforeEach(() => {
    process.env.SHOPIFY_EXPIRING_OFFLINE_TOKENS = "true";
    process.env.SHOPIFY_MIGRATE_TO_EXPIRING_TOKENS = "true";
    vi.useFakeTimers();
  });

  it("401 and 400 invalid_client: hold, no per-shop attempts, loud log", async () => {
    expect(isMigrationConfigError(exchangeError(401, "invalid_client"))).toBe(true);
    expect(isMigrationConfigError(exchangeError(400, "invalid_client"))).toBe(true);
    expect(isMigrationConfigError(exchangeError(400, "invalid_request"))).toBe(false);
    const d = deps({ migrateToExpiringToken: vi.fn(async () => Promise.reject(exchangeError(401, "invalid_client"))) });
    configureOfflineAdmin(d);
    expect(await maybeMigrateToExpiringToken(SHOP)).toBe("failed");
    expect(d.migrateToExpiringToken).toHaveBeenCalledTimes(1);
    expect(h.migrations[0]).toMatchObject({ status: "pending", attempts: 0 });
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).toContain("invalid_client");
    expect(await maybeMigrateToExpiringToken("other.myshopify.com")).toBe("backoff");
  });

  it("other 4xx stay transient and per-shop", async () => {
    const d = deps({ migrateToExpiringToken: vi.fn(async () => Promise.reject(exchangeError(401, "invalid_request"))) });
    configureOfflineAdmin(d);
    const run = maybeMigrateToExpiringToken(SHOP);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await run).toBe("failed");
    expect(d.migrateToExpiringToken).toHaveBeenCalledTimes(4);
    expect(migrationMayBeNeeded("other.myshopify.com")).toBe(true); // no global hold
  });
});

describe("m-1: late-401 blanks after a re-issue or an uninstall", () => {
  beforeEach(() => {
    process.env.SHOPIFY_EXPIRING_OFFLINE_TOKENS = "true";
    process.env.SHOPIFY_MIGRATE_TO_EXPIRING_TOKENS = "true";
  });

  it("(a) merchant token exchange + afterAuth during the exchange, then a late 401 re-blanks: nothing is stored", async () => {
    const load = vi.fn().mockResolvedValueOnce(session("legacy-token")).mockResolvedValueOnce(session("legacy-token")).mockResolvedValue(session(""));
    const d = deps({
      loadOfflineSession: load,
      migrateToExpiringToken: vi.fn(async () => {
        await forgetOfflineTokenMigration(SHOP); // afterAuth of the merchant's own exchange
        return NEW_PAIR();
      }),
    });
    configureOfflineAdmin(d);
    expect(await maybeMigrateToExpiringToken(SHOP)).toBe("no_session");
    expect(d.storeSession).not.toHaveBeenCalled();
    expect(h.migrations).toHaveLength(0);
  });

  it("(b) uninstalled meanwhile (marker set), then a late 401 re-created a blank row: nothing is stored", async () => {
    const load = vi.fn().mockResolvedValueOnce(session("legacy-token")).mockResolvedValueOnce(session("legacy-token")).mockResolvedValue(session(""));
    const d = deps({
      loadOfflineSession: load,
      migrateToExpiringToken: vi.fn(async () => {
        h.install.push({ shop: SHOP, uninstalledAt: new Date() }); // webhook stamped the marker...
        await forgetOfflineTokenMigration(SHOP, { force: true }); // ...and called forget (epoch bump)
        return NEW_PAIR();
      }),
    });
    configureOfflineAdmin(d);
    expect(await maybeMigrateToExpiringToken(SHOP)).toBe("no_session");
    expect(d.storeSession).not.toHaveBeenCalled();
    expect(h.migrations).toHaveLength(0);
  });

  it("an installed shop (marker cleared) is not affected", async () => {
    h.install.push({ shop: SHOP, uninstalledAt: null });
    configureOfflineAdmin(deps());
    expect(await maybeMigrateToExpiringToken(SHOP)).toBe("migrated");
  });
});

describe("m-2: a run that THROWS counts as a failed run", () => {
  it("attempts grow by a full run, status failed, label only", async () => {
    process.env.SHOPIFY_EXPIRING_OFFLINE_TOKENS = "true";
    process.env.SHOPIFY_MIGRATE_TO_EXPIRING_TOKENS = "true";
    // first read ok (record is persisted), the re-read after the persist throws
    const load = vi.fn().mockResolvedValueOnce(session("legacy-token")).mockRejectedValue(new Error("db pool exhausted: encryptedOldToken SECRET-X"));
    configureOfflineAdmin(deps({ loadOfflineSession: load }));
    expect(await maybeMigrateToExpiringToken(SHOP)).toBe("failed");
    expect(h.migrations[0]).toMatchObject({ status: "failed", attempts: 4 });
    expect(h.migrations[0].lastError).not.toContain("SECRET-X");
  });
});

// ---------------------------------------------------------------------------
// Hardening round 5
// ---------------------------------------------------------------------------

describe("m-A: aborts back off; a stale uninstall marker does not destroy the record", () => {
  beforeEach(() => {
    process.env.SHOPIFY_EXPIRING_OFFLINE_TOKENS = "true";
    process.env.SHOPIFY_MIGRATE_TO_EXPIRING_TOKENS = "true";
  });

  it("only the marker says uninstalled, a session row exists: record KEPT, outcome backoff, no hot loop, nothing stored", async () => {
    h.install.push({ shop: SHOP, uninstalledAt: new Date(Date.now() - 1000) }); // stale: afterAuth's upsert failed
    const d = deps();
    configureOfflineAdmin(d);
    expect(await maybeMigrateToExpiringToken(SHOP)).toBe("backoff");
    expect(d.migrateToExpiringToken).not.toHaveBeenCalled();
    expect(d.storeSession).not.toHaveBeenCalled();
    expect(h.migrations).toHaveLength(1); // the recovery record survives
    expect(migrationMayBeNeeded(SHOP)).toBe(false); // in-process backoff
    expect(await maybeMigrateToExpiringToken(SHOP)).toBe("backoff");
    expect(d.loadOfflineSession).toHaveBeenCalledTimes(2); // 2nd call did not run again (only the first run's reads)
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).toContain("STALE_UNINSTALL_MARKER");
  });

  it("an epoch abort (real re-issue/uninstall) also backs off in-process and deletes the record", async () => {
    const d = deps({
      migrateToExpiringToken: vi.fn(async () => {
        await forgetOfflineTokenMigration(SHOP);
        return NEW_PAIR();
      }),
    });
    configureOfflineAdmin(d);
    expect(await maybeMigrateToExpiringToken(SHOP)).toBe("no_session");
    expect(h.migrations).toHaveLength(0);
    expect(migrationMayBeNeeded(SHOP)).toBe(false);
  });

  it("the deadline-403 trigger itself is throttled: a loop of 403s starts ONE migration call per window", async () => {
    vi.useFakeTimers();
    const d = deps({ migrateToExpiringToken: vi.fn(async () => Promise.reject(exchangeError(503))) });
    configureOfflineAdmin(d);
    for (let i = 0; i < 5; i++) reportNonExpiringTokenRejection(SHOP, "legacy-token");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(d.migrateToExpiringToken).toHaveBeenCalledTimes(4); // one run, not five
  });
});

describe("m-B / m-C: failure bookkeeping", () => {
  beforeEach(() => {
    process.env.SHOPIFY_EXPIRING_OFFLINE_TOKENS = "true";
    process.env.SHOPIFY_MIGRATE_TO_EXPIRING_TOKENS = "true";
  });

  it("m-B: a transient failure never overwrites a needs_reauth record", async () => {
    h.migrations.push(row({ status: "needs_reauth" }));
    await store.markMigrationFailed(SHOP, "late transient", 4);
    expect(h.migrations[0]).toMatchObject({ status: "needs_reauth", attempts: 1, lastError: "x" });
    h.migrations[0].status = "pending";
    await store.markMigrationFailed(SHOP, "ok", 4);
    expect(h.migrations[0]).toMatchObject({ status: "failed", attempts: 5 });
  });

  it("m-C: a THROWN run that reaches the cap gives up like a normal one: ciphertext erased, GAVE_UP logged", async () => {
    h.migrations.push(
      row({
        status: "failed",
        attempts: 38,
        tokenFingerprint: store.fingerprintToken("legacy-token"),
        encryptedOldToken: encryptToken("legacy-token"),
        updatedAt: new Date(Date.now() - 48 * 3600_000),
      }),
    );
    const load = vi.fn().mockResolvedValueOnce(session("legacy-token")).mockRejectedValue(new Error("db pool exhausted"));
    configureOfflineAdmin(deps({ loadOfflineSession: load }));
    expect(await maybeMigrateToExpiringToken(SHOP)).toBe("failed");
    expect(h.migrations[0].attempts).toBe(42);
    expect(h.migrations[0].encryptedOldToken).toBeNull();
    expect(h.migrations[0].tokenFingerprint).toMatch(/^[0-9a-f]{16}$/);
    const gaveUp = vi.mocked(logger.error).mock.calls.filter(([m]) => String(m).includes("MIGRATION_GAVE_UP"));
    expect(gaveUp).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Hardening round 6
// ---------------------------------------------------------------------------

describe("final minors", () => {
  beforeEach(() => {
    process.env.SHOPIFY_EXPIRING_OFFLINE_TOKENS = "true";
    process.env.SHOPIFY_MIGRATE_TO_EXPIRING_TOKENS = "true";
    vi.useFakeTimers();
  });
  const terminalRow = (over: Record<string, any> = {}) =>
    row({ status: "failed", attempts: 40, tokenFingerprint: store.fingerprintToken("legacy-token"), encryptedOldToken: null, ...over });
  const blanked = (d: OfflineAdminDeps) => vi.mocked(d.storeSession).mock.calls.some(([x]) => x.accessToken === undefined);

  it("m1: when rearmTerminal throws the token is NOT blanked and the next 403 tries the re-arm again", async () => {
    h.migrations.push(terminalRow());
    const d = deps();
    configureOfflineAdmin(d);
    const { db } = await import("~/db.server");
    const spy = vi.spyOn(db.offlineTokenMigration, "updateMany").mockRejectedValueOnce(new Error("db blip"));
    reportNonExpiringTokenRejection(SHOP, "legacy-token");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(blanked(d)).toBe(false);
    expect(d.migrateToExpiringToken).not.toHaveBeenCalled();
    spy.mockRestore();
    await vi.advanceTimersByTimeAsync(61_000);
    reportNonExpiringTokenRejection(SHOP, "legacy-token");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(d.migrateToExpiringToken).toHaveBeenCalledTimes(1); // the re-armed run happened now
    expect(h.migrations).toHaveLength(0); // and migrated the shop
  });

  it("m2: a failing record read after the re-armed run is not 'no record' — no blank", async () => {
    h.migrations.push(terminalRow());
    const d = deps({ migrateToExpiringToken: vi.fn(async () => Promise.reject(exchangeError(503))) });
    configureOfflineAdmin(d);
    const { db } = await import("~/db.server");
    const orig = db.offlineTokenMigration.findUnique.bind(db.offlineTokenMigration);
    let n = 0;
    const spy = vi.spyOn(db.offlineTokenMigration, "findUnique").mockImplementation((async (a: any) => {
      n++;
      if (n >= 6) throw new Error("read failed"); // 1 trigger run, 2 heal, 3 re-armed run, 4-5 settle, 6 the heal re-read
      return orig(a);
    }) as never);
    reportNonExpiringTokenRejection(SHOP, "legacy-token");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(d.migrateToExpiringToken).toHaveBeenCalledTimes(4);
    expect(blanked(d)).toBe(false);
    spy.mockRestore();
  });

  it("m3: an early throw on an already-terminal record neither counts nor logs GAVE_UP again", async () => {
    h.migrations.push(terminalRow({ encryptedOldToken: null }));
    configureOfflineAdmin(deps({ loadOfflineSession: vi.fn(async () => Promise.reject(new Error("db blip"))) }));
    expect(await maybeMigrateToExpiringToken(SHOP)).toBe("failed");
    expect(h.migrations[0].attempts).toBe(40);
    const gaveUp = vi.mocked(logger.error).mock.calls.filter(([m]) => String(m).includes("MIGRATION_GAVE_UP"));
    expect(gaveUp).toHaveLength(0);
    expect(migrationMayBeNeeded(SHOP)).toBe(false); // still parked
  });

  it("m5: a stale uninstall marker is logged at ERROR once per shop and process", async () => {
    h.install.push({ shop: SHOP, uninstalledAt: new Date(Date.now() - 1000) });
    configureOfflineAdmin(deps());
    expect(await maybeMigrateToExpiringToken(SHOP)).toBe("backoff");
    releaseStaleMigrationBlock(SHOP);
    expect(await maybeMigrateToExpiringToken(SHOP)).toBe("backoff");
    const logs = vi.mocked(logger.error).mock.calls.filter(([m]) => String(m).includes("STALE_UNINSTALL_MARKER"));
    expect(logs).toHaveLength(1);
  });
});
