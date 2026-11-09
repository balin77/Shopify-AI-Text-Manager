/**
 * PLAN_ADMIN_SHOP_OVERVIEW 2.2: WHERE a connection block is set (and where it is
 * not). The block module itself is replaced by spies here; its own rules (fence,
 * mass-401 guard, no_row) are tested in shop-connection-block.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Session } from "@shopify/shopify-api";

const h = vi.hoisted(() => ({
  migrations: [] as Array<Record<string, any>>,
  install: [] as Array<Record<string, any>>,
  block: vi.fn(async (..._a: any[]) => true),
  noteUnauthorized: vi.fn(),
  clear: vi.fn(async (..._a: any[]) => ({ cleared: false, droppedWebhookCount: 0, resyncRequiredSince: null })),
  getBlock: vi.fn<(shop: string) => Promise<any>>(async () => null),
}));

vi.mock("~/utils/logger.server", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("~/db.server", async () => {
  const { fakeDelegate, migrationDefaults } = await import("../helpers/fake-prisma-tables");
  const db = {
    offlineTokenMigration: fakeDelegate(h.migrations, migrationDefaults),
    shopInstallState: fakeDelegate(h.install),
  };
  return { db, default: db };
});
vi.mock("~/shopify.server", () => ({ apiVersion: "2026-07", sessionStorage: { findSessionsByShop: vi.fn(async () => []) } }));
vi.mock("~/utils/shop-connection-block.server", () => ({
  blockShopConnection: (...a: any[]) => h.block(...a),
  noteUnauthorized: (...a: any[]) => h.noteUnauthorized(...a),
}));
vi.mock("~/utils/shop-connection-state.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/utils/shop-connection-state.server")>();
  return { ...actual, clearConnectionBlock: (...a: any[]) => h.clear(...a), getConnectionBlock: (s: string) => h.getBlock(s) };
});

import { logger } from "~/utils/logger.server";
import { encryptToken } from "~/utils/encryption.server";
import {
  __resetOfflineAdminForTests,
  configureOfflineAdmin,
  createRefreshingAdmin,
  forgetOfflineTokenMigration,
  getOfflineAdmin,
  invalidateOfflineAdmin,
  maybeMigrateToExpiringToken,
  type OfflineAdminDeps,
} from "~/utils/offline-admin.server";
import { createAdminClientFromShop } from "~/utils/admin-client.server";
import { isShopConnectionBlockedError } from "~/utils/shop-connection-state.server";

const SHOP = "test-shop.myshopify.com";
const fetchMock = vi.fn();

function session(token: string, expires?: Date, refreshToken?: string) {
  return new Session({ id: `offline_${SHOP}`, shop: SHOP, state: "", isOnline: false, accessToken: token, expires, refreshToken });
}
function deps(overrides: Partial<OfflineAdminDeps> = {}): OfflineAdminDeps {
  return {
    unauthenticatedAdmin: vi.fn(async () => ({ session: session("tok-1"), admin: { graphql: vi.fn() } as never })),
    loadOfflineSession: vi.fn(async () => session("legacy-token")),
    storeSession: vi.fn(async () => true),
    migrateToExpiringToken: vi.fn(async () => ({ session: session("expiring", new Date(Date.now() + 3600_000), "r1") })),
    ...overrides,
  };
}
const unauthorized = () => Object.assign(new Error("Unauthorized"), { response: { code: 401 } });
const forbidden = (msg = "Forbidden") => Object.assign(new Error(msg), { response: { code: 403 } });
const exchangeError = (code: number, error?: string) =>
  Object.assign(new Error(`Received an error response (${code}) from Shopify`), { response: { code, body: error ? { error } : {} } });

beforeEach(() => {
  __resetOfflineAdminForTests();
  h.migrations.length = 0;
  h.install.length = 0;
  h.block.mockReset().mockResolvedValue(true);
  h.noteUnauthorized.mockReset();
  h.clear.mockReset().mockResolvedValue({ cleared: false, droppedWebhookCount: 0, resyncRequiredSince: null });
  h.getBlock.mockReset().mockResolvedValue(null);
  vi.mocked(logger.error).mockClear();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  delete process.env.SHOPIFY_EXPIRING_OFFLINE_TOKENS;
  delete process.env.SHOPIFY_MIGRATE_TO_EXPIRING_TOKENS;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("library client (createRefreshingAdmin): a SECOND 401 with the same stored token blocks", () => {
  it("blocks with admin_api_401, fenced by the START of the failing call, and throws the quiet error", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-09T10:00:00Z"));
    const graphql = vi.fn(async () => {
      vi.setSystemTime(new Date("2026-11-09T10:00:05Z")); // the call takes a while
      throw unauthorized();
    });
    configureOfflineAdmin(deps({ unauthenticatedAdmin: vi.fn(async () => ({ session: session("tok-1"), admin: { graphql } as never })) }));
    const admin = createRefreshingAdmin(SHOP);
    const err = await (admin.graphql as any)("q").catch((e: unknown) => e);
    expect(isShopConnectionBlockedError(err)).toBe(true);
    expect(graphql).toHaveBeenCalledTimes(2);
    expect(h.noteUnauthorized).toHaveBeenCalledWith(SHOP);
    expect(h.block).toHaveBeenCalledTimes(1);
    expect(h.block.mock.calls[0][0]).toBe(SHOP);
    expect(h.block.mock.calls[0][1]).toBe("admin_api_401");
    expect((h.block.mock.calls[0][2] as { observedAt: Date }).observedAt.toISOString()).toBe("2026-11-09T10:00:00.000Z");
  });

  it("the first 401 alone does not block (the retry succeeds)", async () => {
    const graphql = vi.fn().mockRejectedValueOnce(unauthorized()).mockResolvedValue("ok");
    configureOfflineAdmin(deps({ unauthenticatedAdmin: vi.fn(async () => ({ session: session("tok-1"), admin: { graphql } as never })) }));
    await expect((createRefreshingAdmin(SHOP).graphql as any)("q")).resolves.toBe("ok");
    expect(h.block).not.toHaveBeenCalled();
  });

  it("a second 401 with a DIFFERENT (freshly stored) token does not block", async () => {
    const graphql = vi.fn(async () => {
      throw unauthorized();
    });
    let n = 0;
    configureOfflineAdmin(
      deps({ unauthenticatedAdmin: vi.fn(async () => ({ session: session(`tok-${++n}`), admin: { graphql } as never })) }),
    );
    const err = await (createRefreshingAdmin(SHOP).graphql as any)("q").catch((e: unknown) => e);
    expect(isShopConnectionBlockedError(err)).toBe(false);
    expect(h.block).not.toHaveBeenCalled();
  });

  it("falls back to the original error when the block is held back (mass-401 guard) or cannot be written", async () => {
    h.block.mockResolvedValue(false);
    const graphql = vi.fn(async () => {
      throw unauthorized();
    });
    configureOfflineAdmin(deps({ unauthenticatedAdmin: vi.fn(async () => ({ session: session("tok-1"), admin: { graphql } as never })) }));
    const err = await (createRefreshingAdmin(SHOP).graphql as any)("q").catch((e: unknown) => e);
    expect(isShopConnectionBlockedError(err)).toBe(false);
    expect(err.response.code).toBe(401);
  });

  it.each([
    ["a plain 403", forbidden()],
    ["a 403 that names the IP allowlist", forbidden("Access denied: IP address is not on the allowlist")],
    ["a 403 for a missing scope", forbidden("Access denied for productUpdate field. Required access: write_products")],
    ["a 500", Object.assign(new Error("boom"), { response: { code: 500 } })],
  ])("%s never blocks", async (_n, failure) => {
    const graphql = vi.fn(async () => {
      throw failure;
    });
    configureOfflineAdmin(deps({ unauthenticatedAdmin: vi.fn(async () => ({ session: session("tok-1"), admin: { graphql } as never })) }));
    await expect((createRefreshingAdmin(SHOP).graphql as any)("q")).rejects.toBe(failure);
    expect(graphql).toHaveBeenCalledTimes(1);
    expect(h.block).not.toHaveBeenCalled();
    expect(h.noteUnauthorized).not.toHaveBeenCalled();
  });
});

describe("raw client (createAdminClientFromShop)", () => {
  const ok = () => new Response("{}", { status: 200 });
  const r401 = () => new Response("{}", { status: 401 });

  it("a second 401 with the same stored token blocks, replaces the error log, and throws the quiet error", async () => {
    configureOfflineAdmin(deps());
    fetchMock.mockImplementation(async () => r401());
    const client = await createAdminClientFromShop(SHOP);
    const err = await client.graphql("q").catch((e) => e);
    expect(isShopConnectionBlockedError(err)).toBe(true);
    expect(err.message).toContain("401");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(h.block).toHaveBeenCalledWith(SHOP, "admin_api_401", { observedAt: expect.any(Date) });
    expect(logger.error).not.toHaveBeenCalled(); // the BLOCKED line replaces it
  });

  it("the fence: observedAt is the START of the call, and a block that does not take falls back to the old error", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-09T10:00:00Z"));
    configureOfflineAdmin(deps());
    h.block.mockResolvedValue(false); // fenced / held back
    fetchMock.mockImplementation(async () => {
      vi.setSystemTime(new Date("2026-11-09T10:00:09Z"));
      return r401();
    });
    const client = await createAdminClientFromShop(SHOP);
    const err = await client.graphql("q").catch((e) => e);
    expect(isShopConnectionBlockedError(err)).toBe(false);
    expect(err.message).toContain("401");
    expect((h.block.mock.calls[0][2] as { observedAt: Date }).observedAt.toISOString()).toBe("2026-11-09T10:00:00.000Z");
    expect(logger.error).toHaveBeenCalled(); // old behaviour when nothing was blocked
  });

  it("a first 401 followed by success does not block", async () => {
    configureOfflineAdmin(deps());
    fetchMock.mockResolvedValueOnce(r401()).mockResolvedValue(ok());
    const client = await createAdminClientFromShop(SHOP);
    await expect(client.graphql("q")).resolves.toBeInstanceOf(Response);
    expect(h.block).not.toHaveBeenCalled();
  });

  it("a second 401 with a different token does not block", async () => {
    let n = 0;
    configureOfflineAdmin(deps({ unauthenticatedAdmin: vi.fn(async () => ({ session: session(`tok-${++n}`), admin: {} as never })) }));
    fetchMock.mockImplementation(async () => r401());
    const client = await createAdminClientFromShop(SHOP);
    await expect(client.graphql("q")).rejects.toThrow(/401/);
    expect(h.block).not.toHaveBeenCalled();
  });

  it.each([
    ["any 403", new Response(JSON.stringify({ errors: "Forbidden" }), { status: 403 })],
    ["a 403 naming the IP allowlist", new Response(JSON.stringify({ errors: "IP is not in the app's allowlist" }), { status: 403 })],
    ["a 500", new Response("{}", { status: 500 })],
  ])("%s never blocks", async (_n, response) => {
    configureOfflineAdmin(deps());
    fetchMock.mockResolvedValue(response);
    const client = await createAdminClientFromShop(SHOP);
    await expect(client.graphql("q")).rejects.toBeTruthy();
    expect(h.block).not.toHaveBeenCalled();
  });

  it("a blocked shop: createAdminClientFromShop throws at once, with no Shopify call and no session read", async () => {
    h.getBlock.mockResolvedValue({ state: "needs_reauth", since: new Date(), reason: "admin_api_401" });
    const d = deps();
    configureOfflineAdmin(d);
    const err = await createAdminClientFromShop(SHOP).catch((e) => e);
    expect(isShopConnectionBlockedError(err)).toBe(true);
    expect(err).toMatchObject({ shop: SHOP, state: "needs_reauth", reason: "admin_api_401" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(d.unauthenticatedAdmin).not.toHaveBeenCalled();
  });

  it("a client created before the block stops at its next call, again without a Shopify call", async () => {
    configureOfflineAdmin(deps());
    fetchMock.mockResolvedValue(ok());
    const client = await createAdminClientFromShop(SHOP);
    await client.graphql("q1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    h.getBlock.mockResolvedValue({ state: "needs_reauth", since: new Date(), reason: "no_token" });
    await expect(client.graphql("q2")).rejects.toMatchObject({ code: "SHOP_CONNECTION_BLOCKED" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a read failure of the block state fails open (the shop is not treated as blocked)", async () => {
    h.getBlock.mockResolvedValue(null); // getConnectionBlock itself answers null on a read error
    configureOfflineAdmin(deps());
    fetchMock.mockResolvedValue(ok());
    const client = await createAdminClientFromShop(SHOP);
    await expect(client.graphql("q")).resolves.toBeInstanceOf(Response);
  });
});

describe("acquisition (getOfflineAdmin): only terminal evidence blocks", () => {
  // Resolves with the REJECTION of getOfflineAdmin after the re-read pause (the
  // handler is attached before the timers run, so nothing is left unhandled).
  const failure = async (): Promise<any> => {
    const p = getOfflineAdmin(SHOP).catch((e) => e);
    await vi.advanceTimersByTimeAsync(5_000);
    return p;
  };

  it("an empty stored token (no_token) blocks, fenced by the acquisition start", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-09T10:00:00Z"));
    configureOfflineAdmin(deps({ unauthenticatedAdmin: vi.fn(async () => ({ session: session(""), admin: {} as never })) }));
    await expect(getOfflineAdmin(SHOP)).rejects.toMatchObject({ reason: "no_token" });
    expect(h.block).toHaveBeenCalledTimes(1);
    expect(h.block.mock.calls[0][1]).toBe("no_token");
    expect((h.block.mock.calls[0][2] as { observedAt: Date }).observedAt.toISOString()).toBe("2026-11-09T10:00:00.000Z");
    expect(logger.error).not.toHaveBeenCalled(); // BLOCKED replaces it
  });

  it("no_session (no offline session at all) does not block", async () => {
    configureOfflineAdmin(
      deps({ unauthenticatedAdmin: vi.fn(async () => Promise.reject(Object.assign(new Error("Could not find a session"), { name: "SessionNotFoundError" }))) }),
    );
    await expect(getOfflineAdmin(SHOP)).rejects.toMatchObject({ reason: "no_session" });
    expect(h.block).not.toHaveBeenCalled();
  });

  it("a refresh failing with an unwrapped invalid_subject_token blocks, with that reason", async () => {
    vi.useFakeTimers();
    const invalid = Object.assign(new Error("bad"), { response: { code: 400, body: { error: "invalid_subject_token" } } });
    configureOfflineAdmin(deps({ unauthenticatedAdmin: vi.fn(async () => Promise.reject(invalid)) }));
    expect(await failure()).toMatchObject({ reason: "refresh_failed", permanent: true });
    expect(h.block).toHaveBeenCalledTimes(1);
    expect(h.block.mock.calls[0][1]).toBe("invalid_subject_token");
  });

  it("a stored refresh token past its own expiry blocks (refresh_token_expired)", async () => {
    vi.useFakeTimers();
    const stored = session("x", new Date(Date.now() - 1000), "refresh");
    (stored as any).refreshTokenExpires = new Date(Date.now() - 500);
    configureOfflineAdmin(
      deps({
        loadOfflineSession: vi.fn(async () => stored),
        unauthenticatedAdmin: vi.fn(async () => Promise.reject(new Response(undefined, { status: 500 }))),
      }),
    );
    expect(await failure()).toMatchObject({ permanent: true });
    expect(h.block.mock.calls[0][1]).toBe("refresh_token_expired");
  });

  it("an expired token with no refresh token blocks (refresh_token_expired)", async () => {
    vi.useFakeTimers();
    configureOfflineAdmin(
      deps({ unauthenticatedAdmin: vi.fn(async () => ({ session: session("x", new Date(Date.now() - 1000)), admin: {} as never })) }),
    );
    expect(await failure()).toMatchObject({ permanent: true });
    expect(h.block.mock.calls[0][1]).toBe("refresh_token_expired");
  });

  it("a WRAPPED 500 refresh failure (an outage, or the IP allowlist behind it) never blocks and keeps the error log", async () => {
    vi.useFakeTimers();
    configureOfflineAdmin(
      deps({ unauthenticatedAdmin: vi.fn(async () => Promise.reject(new Response(undefined, { status: 500 }))), loadOfflineSession: vi.fn(async () => session("x")) }),
    );
    expect(await failure()).toMatchObject({ reason: "refresh_failed", permanent: false });
    expect(h.block).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
  });

  it("a 403 from the library while acquiring is a wrapped refresh failure: never blocks", async () => {
    vi.useFakeTimers();
    configureOfflineAdmin(deps({ unauthenticatedAdmin: vi.fn(async () => Promise.reject(forbidden("IP allowlist"))) }));
    expect(await failure()).toMatchObject({ permanent: false });
    expect(h.block).not.toHaveBeenCalled();
  });

  it("an invalidation (re-auth, uninstall) that lands while the acquisition is out cancels the block", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    configureOfflineAdmin(
      deps({
        unauthenticatedAdmin: vi.fn(async () => {
          await gate;
          return { session: session(""), admin: {} as never };
        }),
      }),
    );
    const p = getOfflineAdmin(SHOP).catch((e) => e);
    await Promise.resolve();
    invalidateOfflineAdmin(SHOP);
    release();
    expect((await p).reason).toBe("no_token");
    expect(h.block).not.toHaveBeenCalled();
  });

  it("while the shop's own migration runs, an empty token is its doing and does not block", async () => {
    process.env.SHOPIFY_EXPIRING_OFFLINE_TOKENS = "true";
    process.env.SHOPIFY_MIGRATE_TO_EXPIRING_TOKENS = "true";
    let acquisitionError: any;
    const d = deps({
      migrateToExpiringToken: vi.fn(async () => {
        // our own exchange revoked the old token: the library stored a blank session
        configureOfflineAdmin({ ...d, unauthenticatedAdmin: vi.fn(async () => ({ session: session(""), admin: {} as never })) });
        acquisitionError = await getOfflineAdmin(SHOP).catch((e) => e);
        return { session: session("expiring", new Date(Date.now() + 3600_000), "r1") };
      }),
    });
    configureOfflineAdmin(d);
    expect(await maybeMigrateToExpiringToken(SHOP)).toBe("migrated");
    expect(acquisitionError.reason).toBe("no_token");
    expect(h.block).not.toHaveBeenCalled();
    // ... and the migrated pair lifts whatever block may exist, fencing late failures
    expect(h.clear).toHaveBeenCalledWith(SHOP, "reauth");
  });
});

describe("migration needs_reauth", () => {
  beforeEach(() => {
    process.env.SHOPIFY_EXPIRING_OFFLINE_TOKENS = "true";
    process.env.SHOPIFY_MIGRATE_TO_EXPIRING_TOKENS = "true";
    vi.useFakeTimers();
  });

  it("a permanent refusal that emptied the stored token blocks (invalid_subject_token), fenced by the run start", async () => {
    vi.setSystemTime(new Date("2026-11-09T10:00:00Z"));
    configureOfflineAdmin(deps({ migrateToExpiringToken: vi.fn(async () => Promise.reject(exchangeError(400, "invalid_subject_token"))) }));
    expect(await maybeMigrateToExpiringToken(SHOP)).toBe("needs_reauth");
    expect(h.block).toHaveBeenCalledTimes(1);
    expect(h.block.mock.calls[0][1]).toBe("invalid_subject_token");
    expect((h.block.mock.calls[0][2] as { observedAt: Date }).observedAt.toISOString()).toBe("2026-11-09T10:00:00.000Z");
  });

  it("a permanent refusal during which the shop was re-authenticated (token NOT emptied) does not block", async () => {
    const d = deps({
      migrateToExpiringToken: vi.fn(async () => {
        await forgetOfflineTokenMigration(SHOP, { force: true }); // afterAuth: a newer authentication
        return Promise.reject(exchangeError(400, "invalid_subject_token"));
      }),
    });
    configureOfflineAdmin(d);
    expect(await maybeMigrateToExpiringToken(SHOP)).toBe("needs_reauth");
    expect(d.storeSession).not.toHaveBeenCalled(); // not blanked: the epoch moved
    expect(h.block).not.toHaveBeenCalled();
  });

  it("a session that lost its token past the 7-day recovery window blocks (no_token)", async () => {
    h.migrations.push({
      shop: SHOP, encryptedOldToken: encryptToken("legacy-token"), status: "pending", attempts: 1, lastError: null,
      startedAt: new Date(Date.now() - 8 * 24 * 3600_000), completedAt: null,
    });
    configureOfflineAdmin(deps({ loadOfflineSession: vi.fn(async () => session("")) }));
    expect(await maybeMigrateToExpiringToken(SHOP)).toBe("needs_reauth");
    expect(h.block).toHaveBeenCalledTimes(1);
    expect(h.block.mock.calls[0][1]).toBe("no_token");
  });

  it("a transient migration failure and the global config error never block", async () => {
    configureOfflineAdmin(deps({ migrateToExpiringToken: vi.fn(async () => Promise.reject(exchangeError(500))) }));
    const p = maybeMigrateToExpiringToken(SHOP);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await p).toBe("failed");
    expect(h.block).not.toHaveBeenCalled();
  });

  it("a 403 from the token endpoint is not evidence either", async () => {
    configureOfflineAdmin(deps({ migrateToExpiringToken: vi.fn(async () => Promise.reject(exchangeError(403))) }));
    const p = maybeMigrateToExpiringToken(SHOP);
    await vi.advanceTimersByTimeAsync(60_000);
    await p;
    expect(h.block).not.toHaveBeenCalled();
  });
});
