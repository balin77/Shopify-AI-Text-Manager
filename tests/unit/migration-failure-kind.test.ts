/**
 * PLAN_ADMIN_SHOP_OVERVIEW 2.5: the token migration and 404 / 403 answers.
 * One attempt per run for those, final after >= 24 h AND >= 3 runs of the same
 * kind (terminal evidence: GAVE_UP + a shop_not_found / access_denied block),
 * a 403 that looks like our address only pauses everything, and a 403 never
 * blocks or empties anything. The block module is a spy; the migration table is
 * an in-memory fake that interprets the store's real queries.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Session } from "@shopify/shopify-api";

const h = vi.hoisted(() => ({
  migrations: [] as Array<Record<string, any>>,
  install: [] as Array<Record<string, any>>,
  block: vi.fn(async (..._a: any[]): Promise<any> => ({ state: "shop_not_found", since: new Date(), reason: "x" })),
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
  noteUnauthorized: vi.fn(),
  noteSuccessfulCall: vi.fn(async () => undefined),
}));
vi.mock("~/utils/shop-connection-state.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/utils/shop-connection-state.server")>();
  return { ...actual, clearConnectionBlock: vi.fn(async () => ({ cleared: false })), getConnectionBlock: vi.fn(async () => null) };
});

import { logger } from "~/utils/logger.server";
import { encryptToken } from "~/utils/encryption.server";
import {
  __resetOfflineAdminForTests,
  configureOfflineAdmin,
  createRefreshingAdmin,
  maybeMigrateToExpiringToken,
  isMigrationConfigHeld,
  migrationMayBeNeeded,
  TOKEN_ENDPOINT_HOLD_MS,
  type OfflineAdminDeps,
} from "~/utils/offline-admin.server";
import { fingerprintToken, KIND_FINAL_AFTER_MS, KIND_RETRY_INTERVAL_MS, MIGRATION_MAX_ATTEMPTS } from "~/utils/offline-token-migration-store.server";
import { IP_ALLOWLIST_PAUSE_MS, __resetForbiddenForTests, isIpAllowlistPaused, noteApiSuccess } from "~/utils/shopify-forbidden.server";

const SHOP = "test-shop.myshopify.com";
const OTHER = "other-shop.myshopify.com";
const HOUR = 3600_000;

function session(token: string, expires?: Date) {
  return new Session({ id: `offline_${SHOP}`, shop: SHOP, state: "", isOnline: false, accessToken: token, expires });
}
function deps(exchange: () => Promise<never>, overrides: Partial<OfflineAdminDeps> = {}): OfflineAdminDeps {
  return {
    unauthenticatedAdmin: vi.fn(async () => ({ session: session("legacy-token"), admin: { graphql: vi.fn() } as never })),
    loadOfflineSession: vi.fn(async () => session("legacy-token")),
    storeSession: vi.fn(async () => true),
    migrateToExpiringToken: vi.fn(exchange as never),
    ...overrides,
  };
}
const exchangeError = (code: number, message = `Received an error response (${code}) from Shopify`) =>
  Object.assign(new Error(message), { response: { code, body: {} } });
const reject = (code: number, message?: string) => () => Promise.reject(exchangeError(code, message));
const record = (shop = SHOP) => h.migrations.find((r) => r.shop === shop)!;

/** One migration run `afterMs` after the previous one. */
async function run(afterMs: number): Promise<string> {
  await vi.advanceTimersByTimeAsync(afterMs);
  const p = maybeMigrateToExpiringToken(SHOP);
  await vi.advanceTimersByTimeAsync(60_000);
  return p;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-09T10:00:00Z"));
  __resetOfflineAdminForTests();
  __resetForbiddenForTests();
  h.migrations.length = 0;
  h.install.length = 0;
  h.block.mockClear();
  vi.mocked(logger.error).mockClear();
  process.env.SHOPIFY_EXPIRING_OFFLINE_TOKENS = "true";
  process.env.SHOPIFY_MIGRATE_TO_EXPIRING_TOKENS = "true";
});
afterEach(() => {
  vi.useRealTimers();
  delete process.env.SHOPIFY_EXPIRING_OFFLINE_TOKENS;
  delete process.env.SHOPIFY_MIGRATE_TO_EXPIRING_TOKENS;
});

describe.each([
  { code: 404, kind: "not_found", state: "shop_not_found", reason: "token_endpoint_404" },
  { code: 403, kind: "forbidden", state: "access_denied", reason: "token_endpoint_403" },
])("a token endpoint answering $code", ({ code, kind, state, reason }) => {
  it("gets ONE exchange attempt per run and records the kind", async () => {
    const d = deps(reject(code));
    configureOfflineAdmin(d);
    expect(await run(0)).toBe("failed");
    expect(d.migrateToExpiringToken).toHaveBeenCalledTimes(1); // not 4
    expect(record()).toMatchObject({ status: "failed", attempts: 1, failureKind: kind });
    expect(record().failureKindSince).toBeInstanceOf(Date);
    expect(h.block).not.toHaveBeenCalled();
  });

  it("is retried every ~4 h, not on the exponential 40-attempt schedule", async () => {
    configureOfflineAdmin(deps(reject(code)));
    await run(0);
    expect(await run(HOUR)).toBe("backoff"); // too early
    expect(record().attempts).toBe(1);
    expect(await run(KIND_RETRY_INTERVAL_MS)).toBe("failed");
    expect(record().attempts).toBe(2);
  });

  it("is NOT final before 24 h, however often it ran", async () => {
    configureOfflineAdmin(deps(reject(code)));
    await run(0);
    for (let i = 0; i < 4; i++) await run(KIND_RETRY_INTERVAL_MS + 1000); // ~16 h
    expect(record().attempts).toBe(5);
    expect(record().attempts).toBeLessThan(MIGRATION_MAX_ATTEMPTS);
    expect(h.block).not.toHaveBeenCalled();
    expect(vi.mocked(logger.error).mock.calls.some((c) => String(c[0]).includes("MIGRATION_GAVE_UP"))).toBe(false);
  });

  it("is NOT final after 24 h with fewer than 3 runs", async () => {
    configureOfflineAdmin(deps(reject(code)));
    await run(0);
    await run(KIND_FINAL_AFTER_MS + HOUR); // 2nd run, 25 h later
    expect(record().attempts).toBe(2);
    expect(record().attempts).toBeLessThan(MIGRATION_MAX_ATTEMPTS);
    expect(h.block).not.toHaveBeenCalled();
  });

  it("becomes final after >= 24 h and >= 3 runs: GAVE_UP, terminal record, token erased, shop blocked", async () => {
    h.migrations.push({
      shop: SHOP, encryptedOldToken: encryptToken("legacy-token"), tokenFingerprint: fingerprintToken("legacy-token"),
      status: "pending", attempts: 0, startedAt: new Date(), updatedAt: new Date(), completedAt: null, lastError: null,
    });
    configureOfflineAdmin(deps(reject(code)));
    await run(0);
    await run(KIND_RETRY_INTERVAL_MS + 1000);
    await run(KIND_RETRY_INTERVAL_MS + 1000);
    expect(record().attempts).toBe(3);
    expect(h.block).not.toHaveBeenCalled();
    await run(KIND_FINAL_AFTER_MS); // well past 24 h since the first run
    expect(record()).toMatchObject({ status: "failed", attempts: MIGRATION_MAX_ATTEMPTS, failureKind: kind, encryptedOldToken: null });
    expect(vi.mocked(logger.error).mock.calls.some((c) => String(c[0]).includes("MIGRATION_GAVE_UP"))).toBe(true);
    expect(h.block).toHaveBeenCalledTimes(1);
    expect(h.block.mock.calls[0][1]).toBe(reason);
    expect(h.block.mock.calls[0][2]).toMatchObject({ state });
    // fenced by the START of the run that decided it
    expect(h.block.mock.calls[0][2].observedAt).toBeInstanceOf(Date);
    // and nothing retries it any more
    const calls = vi.mocked(logger.error).mock.calls.length;
    expect(await run(KIND_FINAL_AFTER_MS)).toBe("backoff");
    expect(vi.mocked(logger.error).mock.calls.length).toBe(calls);
  });

  it("does not block when the merchant re-authorised while the deciding run was out", async () => {
    configureOfflineAdmin(deps(reject(code)));
    await run(0);
    await run(KIND_RETRY_INTERVAL_MS + 1000);
    await run(KIND_RETRY_INTERVAL_MS + 1000);
    await vi.advanceTimersByTimeAsync(KIND_FINAL_AFTER_MS);
    const { forgetOfflineTokenMigration } = await import("~/utils/offline-admin.server");
    // the exchange of the deciding run fails after afterAuth bumped the epoch
    configureOfflineAdmin(
      deps(async () => {
        await forgetOfflineTokenMigration(SHOP, { force: true });
        throw exchangeError(code);
      }),
    );
    // afterAuth also deleted the record: the run starts clean and is not final
    await maybeMigrateToExpiringToken(SHOP);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.block).not.toHaveBeenCalled();
  });

  it("a change of kind restarts the clocks (flip-flopping never reaches final)", async () => {
    configureOfflineAdmin(deps(reject(code)));
    await run(0);
    await run(KIND_RETRY_INTERVAL_MS + 1000);
    expect(record().attempts).toBe(2);
    const since = record().failureKindSince as Date;
    configureOfflineAdmin(deps(reject(500)));
    await run(KIND_RETRY_INTERVAL_MS + 1000);
    expect(record().failureKind).toBe("transient");
    expect(record().failureKindSince.getTime()).toBeGreaterThan(since.getTime());
    configureOfflineAdmin(deps(reject(code)));
    await run(HOUR * 24);
    expect(record().failureKind).toBe(kind);
    expect(record().attempts).toBe(1); // counted from scratch
    expect(h.block).not.toHaveBeenCalled();
  });
});

describe("a 5xx keeps the old 40-attempt path", () => {
  it("counts the prompt retries, records transient, never blocks", async () => {
    const d = deps(reject(500));
    configureOfflineAdmin(d);
    expect(await run(0)).toBe("failed");
    expect(d.migrateToExpiringToken).toHaveBeenCalledTimes(4);
    expect(record()).toMatchObject({ status: "failed", attempts: 4, failureKind: "transient" });
    expect(h.block).not.toHaveBeenCalled();
  });
});

describe("a 403 that looks like the IP allowlist", () => {
  it("with the allowlist in its text: pause for 30 min, NO attempt counted, nothing blocked", async () => {
    const d = deps(reject(403, "Forbidden: the IP address is not on the allowlist"));
    configureOfflineAdmin(d);
    expect(await run(0)).toBe("backoff");
    expect(d.migrateToExpiringToken).toHaveBeenCalledTimes(1);
    expect(record()).toMatchObject({ attempts: 0, status: "pending" });
    expect(record().failureKind ?? null).toBeNull();
    expect(h.block).not.toHaveBeenCalled();
    expect(isIpAllowlistPaused()).toBe(true);
    expect(migrationMayBeNeeded(SHOP)).toBe(false);
    expect(vi.mocked(logger.error).mock.calls.some((c) => String(c[0]).includes("IP_ALLOWLIST_403"))).toBe(true);
    // no migration for ANY shop while paused ...
    const calls = vi.mocked(d.migrateToExpiringToken).mock.calls.length;
    expect(await maybeMigrateToExpiringToken(SHOP)).toBe("backoff");
    expect(await maybeMigrateToExpiringToken(OTHER)).toBe("backoff");
    expect(vi.mocked(d.migrateToExpiringToken).mock.calls.length).toBe(calls);
    // ... and again afterwards
    await vi.advanceTimersByTimeAsync(IP_ALLOWLIST_PAUSE_MS + 1000);
    expect(isIpAllowlistPaused()).toBe(false);
    expect(migrationMayBeNeeded(SHOP)).toBe(true);
  });

  it("three shops with a plain 403 and no success: the third only pauses (suspected)", async () => {
    configureOfflineAdmin(deps(reject(403)));
    expect(await run(0)).toBe("failed"); // the first one looks shop-specific
    expect(record()).toMatchObject({ attempts: 1, failureKind: "forbidden" });
    for (const other of [OTHER, "third-shop.myshopify.com"]) {
      h.migrations.push({
        shop: other, encryptedOldToken: null, status: "pending", attempts: 0, startedAt: new Date(), updatedAt: new Date(), completedAt: null, lastError: null,
      });
    }
    const forShop = (shop: string) => ({
      ...deps(reject(403)),
      loadOfflineSession: vi.fn(async () => new Session({ id: `offline_${shop}`, shop, state: "", isOnline: false, accessToken: "legacy-2" })),
    });
    configureOfflineAdmin(forShop(OTHER));
    expect(await maybeMigrateToExpiringToken(OTHER)).toBe("failed"); // 2 shops: still shop-specific
    configureOfflineAdmin(forShop("third-shop.myshopify.com"));
    expect(await maybeMigrateToExpiringToken("third-shop.myshopify.com")).toBe("backoff");
    expect(record("third-shop.myshopify.com")).toMatchObject({ attempts: 0, status: "pending" });
    expect(isIpAllowlistPaused()).toBe(true);
    expect(h.block).not.toHaveBeenCalled();
  });
});

describe.each([
  { code: 404, kind: "not_found" },
  { code: 403, kind: "forbidden" },
])("a mass $code from the token endpoint (our deploy, not merchants)", ({ code, kind }) => {
  const shops = ["m1.myshopify.com", "m2.myshopify.com", "m3.myshopify.com"];
  const forShop = (shop: string, exchange = reject(code), over: Partial<OfflineAdminDeps> = {}) => ({
    ...deps(exchange),
    loadOfflineSession: vi.fn(async () => new Session({ id: `offline_${shop}`, shop, state: "", isOnline: false, accessToken: "legacy" })),
    ...over,
  });
  const runShop = async (shop: string, afterMs = 0) => {
    await vi.advanceTimersByTimeAsync(afterMs);
    configureOfflineAdmin(forShop(shop));
    const p = maybeMigrateToExpiringToken(shop);
    await vi.advanceTimersByTimeAsync(60_000);
    return p;
  };

  it("the third shop trips a global hold: no attempt counted for it, one loud line, an ops alert, migrations pause", async () => {
    noteApiSuccess("fine.myshopify.com"); // so a 403 stays shop-specific and the kind guard is what trips
    const alerts = vi.spyOn(await import("~/services/ops-alert.server"), "notifyOps").mockImplementation(() => undefined);
    for (const s of shops) h.migrations.push({ shop: s, status: "pending", attempts: 0, startedAt: new Date(), updatedAt: new Date(), encryptedOldToken: null });
    expect(await runShop(shops[0])).toBe("failed");
    expect(await runShop(shops[1])).toBe("failed");
    expect(await runShop(shops[2])).toBe("backoff");
    expect(h.migrations.find((m) => m.shop === shops[2])).toMatchObject({ attempts: 0, status: "pending" });
    expect(vi.mocked(logger.error).mock.calls.filter((c) => String(c[0]).includes("TOKEN_ENDPOINT_MASS"))).toHaveLength(1);
    expect(alerts).toHaveBeenCalledTimes(1);
    expect(isMigrationConfigHeld()).toBe(true);
    expect(migrationMayBeNeeded(shops[0])).toBe(false);
    expect(await runShop(shops[0])).toBe("backoff");
    alerts.mockRestore();
  });

  it("nothing becomes final by kind for 24 h after a mass event, however long the shop was counted", async () => {
    noteApiSuccess("fine.myshopify.com"); // so a 403 stays shop-specific and the kind guard is what trips
    h.migrations.push({
      shop: SHOP, status: "failed", attempts: 5, failureKind: kind, tokenFingerprint: fingerprintToken("legacy-token"),
      failureKindSince: new Date(Date.now() - 3 * KIND_FINAL_AFTER_MS), startedAt: new Date(), updatedAt: new Date(0), encryptedOldToken: encryptToken("legacy-token"),
    });
    for (const s of shops) await runShop(s); // the third trips the guard
    expect(isMigrationConfigHeld()).toBe(true);
    // after the hold the old record runs again; by its clocks it is final -- but a mass was seen
    await vi.advanceTimersByTimeAsync(TOKEN_ENDPOINT_HOLD_MS + 1000);
    noteApiSuccess("fine.myshopify.com");
    configureOfflineAdmin(deps(reject(code)));
    const p = maybeMigrateToExpiringToken(SHOP);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await p).toBe("failed");
    expect(record().attempts).toBeLessThan(MIGRATION_MAX_ATTEMPTS);
    expect(h.block).not.toHaveBeenCalled();
  });
});

describe("final by kind needs a failing direct probe too", () => {
  it("a shop that answers { shop { id } } with its stored token is NOT finalised nor blocked, and stays retriable", async () => {
    h.migrations.push({
      shop: SHOP, status: "failed", attempts: 5, failureKind: "not_found", tokenFingerprint: fingerprintToken("legacy-token"),
      failureKindSince: new Date(Date.now() - 3 * KIND_FINAL_AFTER_MS), startedAt: new Date(), updatedAt: new Date(0), encryptedOldToken: encryptToken("legacy-token"),
    });
    const graphql = vi.fn(async () => ({ json: async () => ({ data: { shop: { id: "gid://shopify/Shop/1" } } }) }));
    configureOfflineAdmin(
      deps(reject(404), { unauthenticatedAdmin: vi.fn(async () => ({ session: session("legacy-token"), admin: { graphql } as never })) }),
    );
    expect(await run(0)).toBe("failed");
    expect(graphql).toHaveBeenCalledTimes(1);
    expect(record()).toMatchObject({ status: "failed", failureKind: "not_found" });
    expect(record().attempts).toBeLessThan(MIGRATION_MAX_ATTEMPTS);
    expect(h.block).not.toHaveBeenCalled();
    expect(vi.mocked(logger.error).mock.calls.some((c) => String(c[0]).includes("MIGRATION_GAVE_UP"))).toBe(false);
  });

  it("a shop whose probe fails IS finalised and blocked", async () => {
    h.migrations.push({
      shop: SHOP, status: "failed", attempts: 5, failureKind: "not_found", tokenFingerprint: fingerprintToken("legacy-token"),
      failureKindSince: new Date(Date.now() - 3 * KIND_FINAL_AFTER_MS), startedAt: new Date(), updatedAt: new Date(0), encryptedOldToken: encryptToken("legacy-token"),
    });
    const graphql = vi.fn(async () => { throw Object.assign(new Error("gone"), { response: { code: 404 } }); });
    configureOfflineAdmin(
      deps(reject(404), { unauthenticatedAdmin: vi.fn(async () => ({ session: session("legacy-token"), admin: { graphql } as never })) }),
    );
    await run(0);
    expect(h.block).toHaveBeenCalledTimes(1);
    expect(h.block.mock.calls[0][2]).toMatchObject({ state: "shop_not_found" });
  });
});

describe("a needs_reauth refusal supersedes a stale kind", () => {
  it("markMigrationNeedsReauth resets failureKind / failureKindSince, and a needs_reauth row is not a single-attempt kind", async () => {
    h.migrations.push({ shop: SHOP, status: "failed", attempts: 2, failureKind: "forbidden", failureKindSince: new Date(), encryptedOldToken: null });
    const { markMigrationNeedsReauth, hasSingleAttemptKind } = await import("~/utils/offline-token-migration-store.server");
    expect(hasSingleAttemptKind(record() as never)).toBe(true);
    await markMigrationNeedsReauth(SHOP, "refused", 1);
    expect(record()).toMatchObject({ status: "needs_reauth", failureKind: null, failureKindSince: null });
    expect(hasSingleAttemptKind({ status: "needs_reauth", failureKind: "forbidden" })).toBe(false);
    expect(hasSingleAttemptKind({ status: "failed", failureKind: null })).toBe(false);
  });

  it("the probe's cleanup (deleteSingleAttemptKindRecord) only touches pending / failed rows", async () => {
    h.migrations.push({ shop: SHOP, status: "needs_reauth", failureKind: "not_found", encryptedOldToken: null });
    const { deleteSingleAttemptKindRecord } = await import("~/utils/offline-token-migration-store.server");
    expect(await deleteSingleAttemptKindRecord(SHOP)).toBe(false);
    expect(h.migrations).toHaveLength(1);
  });
});

describe("a 403 never blocks or empties anything", () => {
  it("not in the refreshing client: no block, no stored session, even for an allowlist text", async () => {
    for (const msg of ["Forbidden", "IP address not allowed", "Access denied: write_products"]) {
      __resetOfflineAdminForTests();
      const failure = Object.assign(new Error(msg), { response: { code: 403 } });
      const d = deps(reject(500), { unauthenticatedAdmin: vi.fn(async () => ({ session: session("tok"), admin: { graphql: vi.fn(async () => { throw failure; }) } as never })) });
      configureOfflineAdmin(d);
      await expect((createRefreshingAdmin(SHOP).graphql as any)("q")).rejects.toBe(failure);
      expect(d.storeSession).not.toHaveBeenCalled();
    }
    expect(h.block).not.toHaveBeenCalled();
  });

  it("healIfMigrationCannotRun never re-arms a record given up by kind, but still blanks its dead token after the deadline 403", async () => {
    h.migrations.push({
      shop: SHOP, encryptedOldToken: null, tokenFingerprint: fingerprintToken("legacy-token"), status: "failed",
      attempts: MIGRATION_MAX_ATTEMPTS, failureKind: "not_found", failureKindSince: new Date(Date.now() - 3 * KIND_FINAL_AFTER_MS),
      startedAt: new Date(Date.now() - 4 * KIND_FINAL_AFTER_MS), updatedAt: new Date(), completedAt: null, lastError: "x",
    });
    const deadline = Object.assign(new Error("Non-expiring access tokens are no longer accepted for the Admin API."), { response: { code: 403 } });
    const d = deps(reject(500), {
      unauthenticatedAdmin: vi.fn(async () => ({ session: session("legacy-token"), admin: { graphql: vi.fn(async () => { throw deadline; }) } as never })),
    });
    configureOfflineAdmin(d);
    await expect((createRefreshingAdmin(SHOP).graphql as any)("q")).rejects.toBe(deadline);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(record().attempts).toBe(MIGRATION_MAX_ATTEMPTS); // not re-armed
    expect(d.migrateToExpiringToken).not.toHaveBeenCalled(); // no extra run
    expect(d.storeSession).toHaveBeenCalledTimes(1); // the dead token IS blanked ...
    expect((d.storeSession as any).mock.calls[0][0].accessToken).toBeUndefined(); // ... so the next visit token-exchanges
  });

  it("a non-final (still retrying) kind record is neither re-armed nor blanked", async () => {
    h.migrations.push({
      shop: SHOP, encryptedOldToken: null, tokenFingerprint: fingerprintToken("legacy-token"), status: "failed",
      attempts: 2, failureKind: "forbidden", failureKindSince: new Date(), startedAt: new Date(), updatedAt: new Date(), completedAt: null, lastError: "x",
    });
    const deadline = Object.assign(new Error("Non-expiring access tokens are no longer accepted for the Admin API."), { response: { code: 403 } });
    const d = deps(reject(500), {
      unauthenticatedAdmin: vi.fn(async () => ({ session: session("legacy-token"), admin: { graphql: vi.fn(async () => { throw deadline; }) } as never })),
    });
    configureOfflineAdmin(d);
    await expect((createRefreshingAdmin(SHOP).graphql as any)("q")).rejects.toBe(deadline);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(d.storeSession).not.toHaveBeenCalled();
  });
});
