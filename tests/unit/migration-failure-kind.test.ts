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
    // the default probe finds the shop gone (HTTP 404): definitive evidence
    unauthenticatedAdmin: vi.fn(async () => ({
      session: session("legacy-token"),
      admin: { graphql: vi.fn(async () => { throw Object.assign(new Error("gone"), { response: { code: 404 } }); }) } as never,
    })),
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

  it("token-endpoint 403s do not feed the Admin API allowlist suspicion: three shops, no pause", async () => {
    for (const shop of [SHOP, OTHER, "third-shop.myshopify.com"]) {
      configureOfflineAdmin({
        ...deps(reject(403)),
        loadOfflineSession: vi.fn(async () => new Session({ id: `offline_${shop}`, shop, state: "", isOnline: false, accessToken: "legacy-2" })),
      });
      const p = maybeMigrateToExpiringToken(shop);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await p).toBe("failed");
    }
    expect(isIpAllowlistPaused()).toBe(false);
    expect(record()).toMatchObject({ attempts: 1, failureKind: "forbidden" });
    expect(h.block).not.toHaveBeenCalled();
  });

  it("a migrated pair counts as a success for the allowlist heuristic", async () => {
    configureOfflineAdmin(deps(async () => ({ session: session("expiring", new Date(Date.now() + 3600_000)) }) as never));
    expect(await run(0)).toBe("migrated");
    const { classifyForbidden } = await import("~/utils/shopify-forbidden.server");
    const f = Object.assign(new Error("no"), { response: { code: 403 } });
    await classifyForbidden("x1.myshopify.com", f);
    await classifyForbidden("x2.myshopify.com", f);
    expect(await classifyForbidden("x3.myshopify.com", f)).toBe("shop_specific");
  });
});

describe.each([
  { code: 404, kind: "not_found" },
  { code: 403, kind: "forbidden" },
])("a mass $code from the token endpoint (our deploy, not merchants)", ({ code, kind }) => {
  const shops = ["m1.myshopify.com", "m2.myshopify.com", "m3.myshopify.com"];
  const runShop = async (shop: string, afterMs = 0) => {
    await vi.advanceTimersByTimeAsync(afterMs);
    configureOfflineAdmin({
      ...deps(reject(code)),
      loadOfflineSession: vi.fn(async () => new Session({ id: `offline_${shop}`, shop, state: "", isOnline: false, accessToken: "legacy" })),
    });
    const p = maybeMigrateToExpiringToken(shop);
    await vi.advanceTimersByTimeAsync(60_000);
    return p;
  };

  it("is only DETECTED: one loud line, one ops alert, no hold and no skipped attempt", async () => {
    noteApiSuccess("fine.myshopify.com"); // so a 403 stays shop-specific
    const alerts = vi.spyOn(await import("~/services/ops-alert.server"), "notifyOps").mockImplementation(() => undefined);
    for (const s of shops) expect(await runShop(s)).toBe("failed");
    expect(vi.mocked(logger.error).mock.calls.filter((c) => String(c[0]).includes("TOKEN_ENDPOINT_MASS"))).toHaveLength(1);
    expect(alerts).toHaveBeenCalledTimes(1);
    expect(isMigrationConfigHeld()).toBe(false);
    for (const s of shops) expect(h.migrations.find((m) => m.shop === s)).toMatchObject({ attempts: 1, failureKind: kind });
    // a shop that already carries the kind is known dead and does not re-fire the alert
    await runShop(shops[0], KIND_RETRY_INTERVAL_MS + 1000);
    await runShop(shops[1], 0);
    expect(alerts).toHaveBeenCalledTimes(1);
    alerts.mockRestore();
  });

  it("a global fault finalises nobody: every shop whose stored token still answers a probe stays retriable", async () => {
    noteApiSuccess("fine.myshopify.com");
    const graphql = vi.fn(async () => ({ json: async () => ({ data: { shop: { id: "gid://shopify/Shop/1" } } }) }));
    for (const s of shops) {
      h.migrations.push({
        shop: s, status: "failed", attempts: 5, failureKind: kind, tokenFingerprint: fingerprintToken("legacy"),
        failureKindSince: new Date(Date.now() - 3 * KIND_FINAL_AFTER_MS), startedAt: new Date(), updatedAt: new Date(0), encryptedOldToken: encryptToken("legacy"),
      });
    }
    for (const s of shops) {
      configureOfflineAdmin({
        ...deps(reject(code)),
        unauthenticatedAdmin: vi.fn(async () => ({ session: new Session({ id: `offline_${s}`, shop: s, state: "", isOnline: false, accessToken: "legacy" }), admin: { graphql } as never })),
        loadOfflineSession: vi.fn(async () => new Session({ id: `offline_${s}`, shop: s, state: "", isOnline: false, accessToken: "legacy" })),
      });
      const p = maybeMigrateToExpiringToken(s);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await p).toBe("failed");
    }
    expect(graphql).toHaveBeenCalledTimes(3);
    expect(h.block).not.toHaveBeenCalled();
    for (const s of shops) expect(h.migrations.find((m) => m.shop === s)!.attempts).toBeLessThan(MIGRATION_MAX_ATTEMPTS);
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

describe("withheld, deadline and transient edge cases", () => {
  const finalRecord = (over: Record<string, any> = {}) =>
    h.migrations.push({
      shop: SHOP, status: "failed", attempts: 5, failureKind: "not_found", tokenFingerprint: fingerprintToken("legacy-token"),
      failureKindSince: new Date(Date.now() - 3 * KIND_FINAL_AFTER_MS), startedAt: new Date(), updatedAt: new Date(0), encryptedOldToken: encryptToken("legacy-token"), ...over,
    });
  const withAdmin = (graphql: () => Promise<unknown>) =>
    configureOfflineAdmin(
      deps(reject(404), { unauthenticatedAdmin: vi.fn(async () => ({ session: session("legacy-token"), admin: { graphql } as never })) }),
    );

  it("a deadline 403 from the pre-finalise probe does not withhold: the token is useless, the record becomes final", async () => {
    finalRecord();
    withAdmin(async () => { throw Object.assign(new Error("Non-expiring access tokens are no longer accepted for the Admin API."), { response: { code: 403 } }); });
    await run(0);
    expect(record().attempts).toBe(MIGRATION_MAX_ATTEMPTS);
    expect(h.block).toHaveBeenCalledTimes(1);
  });

  it("an allowlist 403 from the pre-finalise probe withholds (our address, not the shop)", async () => {
    finalRecord();
    withAdmin(async () => { throw Object.assign(new Error("the IP address is not on the allowlist"), { response: { code: 403 } }); });
    await run(0);
    expect(record().attempts).toBeLessThan(MIGRATION_MAX_ATTEMPTS);
    expect(h.block).not.toHaveBeenCalled();
  });

  it("a withheld verdict does not count toward the old 40-attempt cap, run after run", async () => {
    finalRecord({ attempts: 38 });
    withAdmin(async () => ({ json: async () => ({ data: { shop: { id: "gid://shopify/Shop/1" } } }) }));
    await run(0);
    expect(record().attempts).toBe(3);
    await run(KIND_RETRY_INTERVAL_MS + 1000);
    await run(KIND_RETRY_INTERVAL_MS + 1000);
    expect(record().attempts).toBe(3);
    expect(record().encryptedOldToken).not.toBeNull(); // never erased
    expect(h.block).not.toHaveBeenCalled();
  });

  it("a successful pre-finalise probe counts as a success for the allowlist heuristic", async () => {
    finalRecord();
    withAdmin(async () => ({ json: async () => ({ data: { shop: { id: "gid://shopify/Shop/1" } } }) }));
    await run(0);
    const { classifyForbidden } = await import("~/utils/shopify-forbidden.server");
    const f = (m: string) => Object.assign(new Error(m), { response: { code: 403 } });
    await classifyForbidden("x1.myshopify.com", f("no"));
    await classifyForbidden("x2.myshopify.com", f("no"));
    expect(await classifyForbidden("x3.myshopify.com", f("no"))).toBe("shop_specific");
  });

  it("a token-endpoint 403 of the deadline kind is transient, not forbidden", async () => {
    const d = deps(reject(403, "Non-expiring access tokens are no longer accepted for the Admin API."));
    configureOfflineAdmin(d);
    expect(await run(0)).toBe("failed");
    expect(d.migrateToExpiringToken).toHaveBeenCalledTimes(4);
    expect(record()).toMatchObject({ failureKind: "transient", attempts: 4 });
  });
});

describe("the pre-finalise probe is three-valued: only definitive evidence finalises", () => {
  const finalRecord = () =>
    h.migrations.push({
      shop: SHOP, status: "failed", attempts: 5, failureKind: "not_found", tokenFingerprint: fingerprintToken("legacy-token"),
      failureKindSince: new Date(Date.now() - 3 * KIND_FINAL_AFTER_MS), startedAt: new Date(), updatedAt: new Date(0), encryptedOldToken: encryptToken("legacy-token"),
    });
  const httpError = (code: number, message = "x") => Object.assign(new Error(message), { response: { code } });
  const withAdmin = (graphql: () => Promise<unknown>, sess = session("legacy-token")) =>
    configureOfflineAdmin(deps(reject(404), { unauthenticatedAdmin: vi.fn(async () => ({ session: sess, admin: { graphql } as never })) }));
  const ok = { json: async () => ({ data: { shop: { id: "gid://shopify/Shop/1" } } }) };

  it.each([
    ["HTTP 401", async () => { throw httpError(401); }],
    ["HTTP 404", async () => { throw httpError(404); }],
    ["a shop-specific 403", async () => { throw httpError(403, "Access denied for shop field"); }],
    ["the deadline 403", async () => { throw httpError(403, "Non-expiring access tokens are no longer accepted for the Admin API."); }],
    ["a 200 with data.shop null and no errors", async () => ({ json: async () => ({ data: { shop: null } }) })],
  ])("DEAD: %s finalises, erases and blocks", async (_n, graphql) => {
    finalRecord();
    withAdmin(graphql);
    await run(0);
    expect(record()).toMatchObject({ attempts: MIGRATION_MAX_ATTEMPTS, encryptedOldToken: null });
    expect(h.block).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["answers", async () => ok],
    ["HTTP 429", async () => { throw httpError(429); }],
    ["HTTP 500", async () => { throw httpError(500); }],
    ["HTTP 503", async () => { throw httpError(503); }],
    ["a network error", async () => { throw new TypeError("fetch failed"); }],
    ["a timeout", async () => { throw Object.assign(new Error("timeout"), { name: "AbortError" }); }],
    ["a GraphQL error (THROTTLED)", async () => ({ json: async () => ({ errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] }) })],
    ["a thrown GraphqlQueryError", async () => { throw Object.assign(new Error("Throttled"), { name: "GraphqlQueryError", body: { errors: [{ message: "Throttled" }] } }); }],
    ["a 200 with no usable body", async () => undefined],
    ["an allowlist 403", async () => { throw httpError(403, "the IP address is not on the allowlist"); }],
  ])("WITHHELD: %s changes nothing but the 4 h retry", async (_n, graphql) => {
    finalRecord();
    withAdmin(graphql);
    await run(0);
    expect(record().attempts).toBe(3); // capped, not counted toward 40
    expect(record().encryptedOldToken).not.toBeNull(); // not erased
    expect(h.block).not.toHaveBeenCalled();
    expect(vi.mocked(logger.error).mock.calls.some((c) => String(c[0]).includes("MIGRATION_GAVE_UP"))).toBe(false);
  });

  it("a blank stored token (a run working from the persisted ciphertext) cannot authenticate: unknown, the last copy is never erased", async () => {
    finalRecord();
    configureOfflineAdmin(deps(reject(404), { unauthenticatedAdmin: vi.fn(async () => ({ session: session(""), admin: {} as never })) }));
    await run(0);
    expect(record().encryptedOldToken).not.toBeNull();
    expect(record().attempts).toBeLessThan(MIGRATION_MAX_ATTEMPTS);
    expect(h.block).not.toHaveBeenCalled();
  });

  it("an unreadable database during the probe is unknown too (the probe never throws)", async () => {
    finalRecord();
    configureOfflineAdmin(
      deps(reject(404), { unauthenticatedAdmin: vi.fn(async () => { throw new Error("connection pool exhausted"); }) }),
    );
    await run(0);
    expect(h.block).not.toHaveBeenCalled();
    expect(record().encryptedOldToken).not.toBeNull();
  });
});

describe("a mass seen in the last 24 h withholds only the final verdict", () => {
  it("the verdict waits (even for a dead probe) while the attempt still runs; after 24 h it proceeds", async () => {
    // three fresh shops with a 404 trip the detector
    for (const s of ["m1", "m2", "m3"].map((x) => `${x}.myshopify.com`)) {
      configureOfflineAdmin({
        ...deps(reject(404)),
        loadOfflineSession: vi.fn(async () => new Session({ id: `offline_${s}`, shop: s, state: "", isOnline: false, accessToken: "legacy" })),
      });
      const p = maybeMigrateToExpiringToken(s);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await p).toBe("failed");
    }
    h.migrations.push({
      shop: SHOP, status: "failed", attempts: 5, failureKind: "not_found", tokenFingerprint: fingerprintToken("legacy-token"),
      failureKindSince: new Date(Date.now() - 3 * KIND_FINAL_AFTER_MS), startedAt: new Date(), updatedAt: new Date(0), encryptedOldToken: encryptToken("legacy-token"),
    });
    configureOfflineAdmin(deps(reject(404))); // the probe says dead
    expect(await run(0)).toBe("failed"); // the attempt ran
    expect(record().attempts).toBe(3);
    expect(h.block).not.toHaveBeenCalled();
    // after the 24 h the verdict proceeds normally
    await vi.advanceTimersByTimeAsync(25 * HOUR);
    configureOfflineAdmin(deps(reject(404)));
    await run(0);
    expect(record().attempts).toBe(MIGRATION_MAX_ATTEMPTS);
    expect(h.block).toHaveBeenCalledTimes(1);
  });
});
