/**
 * PLAN_ADMIN_SHOP_OVERVIEW 2.6: the connection sweep. `db` is a set of in-memory
 * fakes that interpret the sweep's REAL `where` shapes; the Shopify side
 * (getOfflineAdmin) and the block module are spies.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  install: [] as Array<Record<string, any>>,
  sessions: [] as Array<Record<string, any>>,
  migrations: [] as Array<Record<string, any>>,
  getAdmin: vi.fn(),
  block: vi.fn(async (..._a: any[]): Promise<any> => ({ state: "needs_reauth" })),
  clear: vi.fn(async (..._a: any[]) => ({ cleared: true })),
  getBlock: vi.fn(async (_s: string): Promise<any> => null),
  configHeld: false,
  active: new Set<string>(),
  catchUp: vi.fn(async (..._a: any[]) => "done"),
  createClient: vi.fn(async (_s: string) => ({ graphql: vi.fn() })),
  reportDeadline: vi.fn(),
}));

vi.mock("~/utils/logger.server", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("~/db.server", async () => {
  const { fakeDelegate, migrationDefaults } = await import("../helpers/fake-prisma-tables");
  const db = {
    shopInstallState: fakeDelegate(h.install),
    session: fakeDelegate(h.sessions),
    offlineTokenMigration: fakeDelegate(h.migrations, migrationDefaults),
  };
  return { db, default: db };
});
vi.mock("~/utils/offline-admin.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/utils/offline-admin.server")>();
  return {
    ...actual,
    getOfflineAdmin: (s: string) => h.getAdmin(s),
    isMigrationConfigHeld: () => h.configHeld,
    reportNonExpiringTokenRejection: (...a: any[]) => h.reportDeadline(...a),
  };
});
vi.mock("~/utils/shop-connection-block.server", () => ({ blockShopConnection: (...a: any[]) => h.block(...a) }));
vi.mock("~/utils/shop-connection-state.server", () => ({
  clearConnectionBlock: (...a: any[]) => h.clear(...a),
  getConnectionBlock: (s: string) => h.getBlock(s),
}));
vi.mock("~/services/sync-scheduler.service", () => ({ syncScheduler: { isShopActive: (s: string) => h.active.has(s) } }));
vi.mock("~/utils/admin-client.server", () => ({ createAdminClientFromShop: (s: string) => h.createClient(s) }));
vi.mock("~/services/webhook-catchup.server", () => ({ runWebhookCatchUp: (...a: any[]) => h.catchUp(...a) }));

import { logger } from "~/utils/logger.server";
import { encryptToken } from "~/utils/encryption.server";
import { OfflineAdminUnavailableError } from "~/utils/offline-admin.server";
import { fingerprintToken, MIGRATION_RECOVERY_WINDOW_MS } from "~/utils/offline-token-migration-store.server";
import { __resetForbiddenForTests, isIpAllowlistPaused } from "~/utils/shopify-forbidden.server";
import {
  CATCHUP_BATCH,
  PROBE_BATCH,
  PROBE_INTERVAL_MS,
  SUMMARY_INTERVAL_MS,
  ShopConnectionSweepService,
} from "~/services/shop-connection-sweep.service";

const NOW = new Date("2026-11-15T12:00:00Z");
const HOUR = 3600_000;
const sweep = () => ShopConnectionSweepService.getInstance();

function shopRow(shop: string, over: Record<string, any> = {}) {
  const row = {
    shop, uninstalledAt: null, connectionState: null, lastProbeAt: null, lastApiOkAt: null,
    resyncRequiredSince: null, droppedWebhookCount: 0, initialSyncCompletedAt: null, ...over,
  };
  h.install.push(row);
  return row;
}
function sessionRow(shop: string, over: Record<string, any> = {}) {
  const row = { id: `offline_${shop}`, shop, isOnline: false, accessToken: encryptToken("tok"), expires: null, ...over };
  h.sessions.push(row);
  return row;
}
const blockedShop = (shop: string, over: Record<string, any> = {}) => {
  shopRow(shop, { connectionState: "needs_reauth", connectionStateSince: new Date(NOW.getTime() - 48 * HOUR), ...over });
  sessionRow(shop);
};
const okResponse = () => ({ json: async () => ({ data: { shop: { id: "gid://shopify/Shop/1" } } }) });
const status = (code: number, message = "x") => Object.assign(new Error(message), { response: { code } });
const installOf = (shop: string) => h.install.find((r) => r.shop === shop)!;

beforeEach(() => {
  h.install.length = 0;
  h.sessions.length = 0;
  h.migrations.length = 0;
  h.getAdmin.mockReset().mockResolvedValue({ admin: { graphql: vi.fn(async () => okResponse()) } });
  h.block.mockReset().mockImplementation(async (shop: string, reason: string) => {
    const row = h.install.find((r) => r.shop === shop);
    if (row) Object.assign(row, { connectionState: "needs_reauth", connectionStateReason: reason });
    return { state: "needs_reauth" };
  });
  h.clear.mockReset().mockResolvedValue({ cleared: true });
  h.reportDeadline.mockClear();
  h.getBlock.mockReset().mockResolvedValue(null);
  h.configHeld = false;
  h.active.clear();
  h.catchUp.mockClear();
  h.createClient.mockClear();
  vi.mocked(logger.info).mockClear();
  vi.mocked(logger.error).mockClear();
  __resetForbiddenForTests();
  sweep().__resetForTests();
  process.env.SHOP_CONNECTION_BACKFILL_DISABLED = "true"; // the probe tests are about the probe
});
afterEach(() => {
  delete process.env.SHOP_CONNECTION_BACKFILL_DISABLED;
});

describe("probe of blocked shops", () => {
  it("a success lifts the block (probe_ok) and records lastProbeAt and lastApiOkAt", async () => {
    blockedShop("a.myshopify.com");
    const stats = await sweep().tick(NOW, { pauseMs: 0 });
    expect(stats.probed).toBe(1);
    expect(stats.probeLifted).toBe(1);
    expect(h.clear).toHaveBeenCalledWith("a.myshopify.com", "probe_ok", { sinceAtOrBefore: NOW });
    expect(installOf("a.myshopify.com").lastProbeAt).toBeInstanceOf(Date);
    expect(installOf("a.myshopify.com").lastApiOkAt).toBeInstanceOf(Date);
  });

  it("drops a stale 404 / 403 migration record of the shop that just proved it works, and only that kind", async () => {
    blockedShop("a.myshopify.com");
    blockedShop("b.myshopify.com");
    h.migrations.push(
      { shop: "a.myshopify.com", status: "failed", failureKind: "not_found", attempts: 40 },
      { shop: "b.myshopify.com", status: "failed", failureKind: "transient", attempts: 8 },
    );
    await sweep().tick(NOW, { pauseMs: 0 });
    expect(h.migrations.map((m) => m.shop)).toEqual(["b.myshopify.com"]);
  });

  it("a 403 never lifts, never blocks, never empties anything; it is only stamped", async () => {
    blockedShop("a.myshopify.com");
    h.getAdmin.mockResolvedValue({ admin: { graphql: vi.fn(async () => { throw status(403, "Access denied for shop field"); }) } });
    const tokenBefore = h.sessions[0].accessToken;
    const stats = await sweep().tick(NOW, { pauseMs: 0 });
    expect(stats.probeLifted).toBe(0);
    expect(h.clear).not.toHaveBeenCalled();
    expect(h.block).not.toHaveBeenCalled();
    expect(h.sessions[0].accessToken).toBe(tokenBefore);
    expect(installOf("a.myshopify.com").connectionState).toBe("needs_reauth");
    expect(installOf("a.myshopify.com").lastProbeAt).toBeInstanceOf(Date);
    expect(installOf("a.myshopify.com").lastApiOkAt).toBeNull();
  });

  it("a 403 that names the IP allowlist pauses further probes of the same tick", async () => {
    for (const s of ["a", "b", "c"]) blockedShop(`${s}.myshopify.com`);
    h.getAdmin.mockResolvedValue({ admin: { graphql: vi.fn(async () => { throw status(403, "the IP address is not on the allowlist"); }) } });
    const stats = await sweep().tick(NOW, { pauseMs: 0 });
    expect(stats.probed).toBe(1);
    expect(stats.probesPaused).toBe(true);
    expect(isIpAllowlistPaused()).toBe(true);
    expect(h.clear).not.toHaveBeenCalled();
    // and the next tick does not probe at all while the pause is in force
    h.getAdmin.mockClear();
    await sweep().tick(new Date(NOW.getTime() + 11 * 60_000), { pauseMs: 0 });
    expect(h.getAdmin).not.toHaveBeenCalled();
  });

  it("does not probe while the migration config hold is in force", async () => {
    blockedShop("a.myshopify.com");
    h.configHeld = true;
    const stats = await sweep().tick(NOW, { pauseMs: 0 });
    expect(stats.probesPaused).toBe(true);
    expect(h.getAdmin).not.toHaveBeenCalled();
  });

  it("a 401 leaves the block as it is", async () => {
    blockedShop("a.myshopify.com");
    h.getAdmin.mockResolvedValue({ admin: { graphql: vi.fn(async () => { throw status(401); }) } });
    await sweep().tick(NOW, { pauseMs: 0 });
    expect(h.clear).not.toHaveBeenCalled();
    expect(h.block).not.toHaveBeenCalled();
    expect(installOf("a.myshopify.com").lastProbeAt).toBeInstanceOf(Date);
  });

  it("an unavailable access (refresh failed) and a 200 with GraphQL errors do not lift", async () => {
    blockedShop("a.myshopify.com");
    blockedShop("b.myshopify.com");
    h.getAdmin.mockImplementation(async (shop: string) => {
      if (shop === "a.myshopify.com") throw new OfflineAdminUnavailableError(shop, "refresh_failed", "x");
      return { admin: { graphql: vi.fn(async () => ({ json: async () => ({ errors: [{ message: "Access denied" }] }) })) } };
    });
    await sweep().tick(NOW, { pauseMs: 0 });
    expect(h.clear).not.toHaveBeenCalled();
  });

  it("never probes an uninstalled shop", async () => {
    blockedShop("gone.myshopify.com", { uninstalledAt: new Date(NOW.getTime() - 24 * HOUR) });
    const stats = await sweep().tick(NOW, { pauseMs: 0 });
    expect(stats.probeCandidates).toBe(0);
    expect(h.getAdmin).not.toHaveBeenCalled();
    // and the direct entrance refuses as well (the shop may be marked between select and probe)
    expect(await sweep().probeShop("gone.myshopify.com")).toBe("uninstalled");
    expect(h.getAdmin).not.toHaveBeenCalled();
  });

  it("a shop without a token is stamped, not probed, so it does not clog the queue", async () => {
    shopRow("empty.myshopify.com", { connectionState: "needs_reauth" });
    sessionRow("empty.myshopify.com", { accessToken: "" });
    const stats = await sweep().tick(NOW, { pauseMs: 0 });
    expect(stats.probed).toBe(0);
    expect(h.getAdmin).not.toHaveBeenCalled();
    expect(installOf("empty.myshopify.com").lastProbeAt).toBeInstanceOf(Date);
  });

  it("a block set after the probe began is not lifted (the lift is conditional in the database)", async () => {
    blockedShop("a.myshopify.com");
    h.migrations.push({ shop: "a.myshopify.com", status: "failed", failureKind: "not_found", attempts: 3 });
    h.clear.mockResolvedValueOnce({ cleared: false });
    const stats = await sweep().tick(NOW, { pauseMs: 0 });
    expect(stats.probeLifted).toBe(0);
    expect(h.clear.mock.calls[0][2]).toEqual({ sinceAtOrBefore: NOW });
    expect(h.migrations).toHaveLength(1); // nothing was proven about the old verdict
    expect(installOf("a.myshopify.com").lastProbeAt).toBeInstanceOf(Date);
  });

  it("a probe that throws unexpectedly still stamps lastProbeAt (no hot loop on the same shop)", async () => {
    blockedShop("a.myshopify.com");
    h.clear.mockRejectedValueOnce(new Error("db"));
    await sweep().tick(NOW, { pauseMs: 0 });
    expect(installOf("a.myshopify.com").lastProbeAt).toBeInstanceOf(Date);
  });

  it("a probe 403 of a blocked shop does not feed the allowlist suspicion (three blocked shops, no pause)", async () => {
    for (const s of ["a", "b", "c", "d"]) blockedShop(`${s}.myshopify.com`);
    h.getAdmin.mockResolvedValue({ admin: { graphql: vi.fn(async () => { throw status(403, "Forbidden"); }) } });
    const stats = await sweep().tick(NOW, { pauseMs: 0 });
    expect(stats.probed).toBe(4);
    expect(isIpAllowlistPaused()).toBe(false);
  });

  it("a deadline 403 seen by the probe starts the migration handling like anywhere else", async () => {
    blockedShop("a.myshopify.com");
    h.getAdmin.mockResolvedValue({
      admin: { graphql: vi.fn(async () => { throw status(403, "Non-expiring access tokens are no longer accepted for the Admin API."); }) },
    });
    await sweep().tick(NOW, { pauseMs: 0 });
    expect(h.reportDeadline).toHaveBeenCalledWith("a.myshopify.com");
    expect(h.clear).not.toHaveBeenCalled();
  });

  it("is bounded per tick and every shop waits 6 h for its next probe", async () => {
    for (let i = 0; i < 12; i++) blockedShop(`s${String(i).padStart(2, "0")}.myshopify.com`);
    h.getAdmin.mockResolvedValue({ admin: { graphql: vi.fn(async () => { throw status(401); }) } });
    expect((await sweep().tick(NOW, { pauseMs: 0 })).probed).toBe(PROBE_BATCH);
    expect((await sweep().tick(NOW, { pauseMs: 0 })).probed).toBe(PROBE_BATCH);
    expect((await sweep().tick(NOW, { pauseMs: 0 })).probed).toBe(2);
    // all twelve were probed once; none is due again for 6 h
    const calls = h.getAdmin.mock.calls.length;
    expect(calls).toBe(12);
    expect((await sweep().tick(new Date(NOW.getTime() + PROBE_INTERVAL_MS - 5 * 60_000), { pauseMs: 0 })).probed).toBe(0);
  });

  it("probes again once the interval has passed (lastProbeAt is durable)", async () => {
    blockedShop("a.myshopify.com", { lastProbeAt: new Date(NOW.getTime() - PROBE_INTERVAL_MS - 1000) });
    expect((await sweep().tick(NOW, { pauseMs: 0 })).probed).toBe(1);
    blockedShop("b.myshopify.com", { lastProbeAt: new Date(NOW.getTime() - PROBE_INTERVAL_MS + 60_000) });
    expect((await sweep().tick(NOW, { pauseMs: 0 })).probed).toBe(0); // a was just probed, b is not due
  });

  it("an unblocked shop is not probed", async () => {
    shopRow("fine.myshopify.com");
    sessionRow("fine.myshopify.com");
    await sweep().tick(NOW, { pauseMs: 0 });
    expect(h.getAdmin).not.toHaveBeenCalled();
  });
});

describe("backfill", () => {
  beforeEach(() => {
    delete process.env.SHOP_CONNECTION_BACKFILL_DISABLED;
  });

  it("records a needs_reauth migration whose shop holds an empty token, or the very token it was about", async () => {
    shopRow("empty.myshopify.com");
    sessionRow("empty.myshopify.com", { accessToken: "" });
    shopRow("same.myshopify.com");
    sessionRow("same.myshopify.com", { accessToken: encryptToken("dead") });
    h.migrations.push(
      { shop: "empty.myshopify.com", status: "needs_reauth", tokenFingerprint: fingerprintToken("dead") },
      { shop: "same.myshopify.com", status: "needs_reauth", tokenFingerprint: fingerprintToken("dead") },
    );
    const stats = await sweep().tick(NOW, { pauseMs: 0 });
    expect(stats.backfilledNeedsReauth).toBe(2);
    const reasons = h.block.mock.calls.map((c) => c[1]);
    expect(reasons).toEqual(["backfill_migration_needs_reauth", "backfill_migration_needs_reauth"]);
    expect(h.block.mock.calls[0][2]).toEqual({ observedAt: NOW });
  });

  it("skips a shop that re-authenticated (different token), an expiring session, an uninstalled or already blocked shop", async () => {
    shopRow("new-token.myshopify.com");
    sessionRow("new-token.myshopify.com", { accessToken: encryptToken("fresh") });
    shopRow("expiring.myshopify.com");
    sessionRow("expiring.myshopify.com", { expires: new Date(NOW.getTime() + HOUR) });
    shopRow("gone.myshopify.com", { uninstalledAt: new Date(NOW.getTime() - HOUR) });
    sessionRow("gone.myshopify.com", { accessToken: "" });
    shopRow("blocked.myshopify.com", { connectionState: "access_denied" });
    sessionRow("blocked.myshopify.com", { accessToken: "" });
    for (const s of ["new-token", "expiring", "gone", "blocked"]) {
      h.migrations.push({ shop: `${s}.myshopify.com`, status: "needs_reauth", tokenFingerprint: fingerprintToken("dead") });
    }
    // a record without any session at all
    h.migrations.push({ shop: "nosession.myshopify.com", status: "needs_reauth", tokenFingerprint: null });
    await sweep().tick(NOW, { pauseMs: 0 });
    expect(h.block.mock.calls.filter((c) => c[1] === "backfill_migration_needs_reauth")).toHaveLength(0);
  });

  it("records an empty token, except where a migration can still recover it", async () => {
    shopRow("dead.myshopify.com");
    sessionRow("dead.myshopify.com", { accessToken: "" });
    shopRow("recovering.myshopify.com");
    sessionRow("recovering.myshopify.com", { accessToken: "" });
    h.migrations.push({
      shop: "recovering.myshopify.com", status: "pending", encryptedOldToken: "cipher", startedAt: new Date(NOW.getTime() - HOUR - 0),
    });
    // an old token past the recovery window recovers nothing
    shopRow("late.myshopify.com");
    sessionRow("late.myshopify.com", { accessToken: "" });
    h.migrations.push({
      shop: "late.myshopify.com", status: "pending", encryptedOldToken: "cipher",
      startedAt: new Date(Date.now() - MIGRATION_RECOVERY_WINDOW_MS - HOUR),
    });
    const stats = await sweep().tick(NOW, { pauseMs: 0 });
    expect(h.block.mock.calls.map((c) => c[0]).sort()).toEqual(["dead.myshopify.com", "late.myshopify.com"]);
    expect(h.block.mock.calls.every((c) => c[1] === "backfill_no_token")).toBe(true);
    expect(stats.backfilledNoToken).toBe(2);
  });

  it("gives 404 records their kind, leaves 403 and unrelated records alone, and is idempotent", async () => {
    h.migrations.push(
      { shop: "nf.myshopify.com", status: "failed", failureKind: null, attempts: 12, lastError: "Received an error response (404 Not Found) from Shopify" },
      { shop: "nf-done.myshopify.com", status: "failed", failureKind: null, attempts: 40, lastError: "HTTP 404" },
      { shop: "fb.myshopify.com", status: "failed", failureKind: null, attempts: 12, lastError: "Received an error response (403 Forbidden) from Shopify" },
      { shop: "other.myshopify.com", status: "failed", failureKind: null, attempts: 12, lastError: "fetch failed" },
    );
    const stats = await sweep().tick(NOW, { pauseMs: 0 });
    expect(stats.backfilledNotFound).toBe(2);
    const rec = (s: string) => h.migrations.find((m) => m.shop === `${s}.myshopify.com`)!;
    expect(rec("nf")).toMatchObject({ failureKind: "not_found", attempts: 1 });
    expect(rec("nf").failureKindSince).toEqual(NOW);
    expect(rec("nf-done")).toMatchObject({ failureKind: "not_found", attempts: 40 }); // stays given up
    expect(rec("fb").failureKind).toBeNull();
    expect(rec("other").failureKind).toBeNull();
    // a second pass (a restart) changes nothing
    sweep().__resetForTests();
    const again = await sweep().tick(new Date(NOW.getTime() + HOUR), { pauseMs: 0 });
    expect(again.backfilledNotFound).toBe(0);
    expect(rec("nf").failureKindSince).toEqual(NOW);
  });

  it("runs once per process, and not at all when switched off", async () => {
    shopRow("dead.myshopify.com");
    sessionRow("dead.myshopify.com", { accessToken: "" });
    await sweep().tick(NOW, { pauseMs: 0 });
    await sweep().tick(NOW, { pauseMs: 0 });
    expect(h.block).toHaveBeenCalledTimes(1);
    sweep().__resetForTests();
    h.block.mockClear();
    process.env.SHOP_CONNECTION_BACKFILL_DISABLED = "true";
    await sweep().tick(NOW, { pauseMs: 0 });
    expect(h.block).not.toHaveBeenCalled();
  });
});

describe("backfill (hardening)", () => {
  beforeEach(() => {
    delete process.env.SHOP_CONNECTION_BACKFILL_DISABLED;
  });

  it("does not re-block a shop whose block was lifted AFTER the evidence was written", async () => {
    shopRow("proven.myshopify.com", { connectionClearedAt: new Date(NOW.getTime() + 0) });
    sessionRow("proven.myshopify.com", { accessToken: "" });
    shopRow("old-clear.myshopify.com", { connectionClearedAt: new Date(NOW.getTime() - 10 * HOUR) });
    sessionRow("old-clear.myshopify.com", { accessToken: "" });
    h.migrations.push(
      { shop: "proven.myshopify.com", status: "needs_reauth", tokenFingerprint: null, updatedAt: new Date(NOW.getTime() - HOUR) },
      { shop: "old-clear.myshopify.com", status: "needs_reauth", tokenFingerprint: null, updatedAt: new Date(NOW.getTime() - HOUR) },
    );
    await sweep().tick(NOW, { pauseMs: 0 });
    // proven: cleared after the record changed. old-clear: cleared BEFORE the record was written, so the record is newer evidence.
    expect(h.block.mock.calls.filter((c) => c[1] === "backfill_migration_needs_reauth").map((c) => c[0])).toEqual(["old-clear.myshopify.com"]);
    // a blank session of a once-cleared shop is left to the live detection
    expect(h.block.mock.calls.filter((c) => c[1] === "backfill_no_token")).toHaveLength(0);
  });

  it("pages past 500 rows instead of silently stopping", async () => {
    for (let i = 0; i < 620; i++) {
      const shop = `p${String(i).padStart(4, "0")}.myshopify.com`;
      shopRow(shop);
      sessionRow(shop, { accessToken: "" });
    }
    const stats = await sweep().tick(NOW, { pauseMs: 0 });
    expect(stats.backfilledNoToken).toBe(620);
  });
});

describe("catch-up", () => {
  const owing = (shop: string, over: Record<string, any> = {}) =>
    shopRow(shop, { resyncRequiredSince: new Date(NOW.getTime() - HOUR), droppedWebhookCount: 3, initialSyncCompletedAt: new Date(NOW.getTime() - 99 * HOUR), ...over });

  it("runs the catch-up for an unblocked, installed shop that owes one and has no running scheduler", async () => {
    owing("a.myshopify.com");
    const stats = await sweep().tick(NOW, { pauseMs: 0 });
    expect(stats.catchUpRun).toBe(1);
    expect(h.catchUp).toHaveBeenCalledWith("a.myshopify.com", expect.anything());
  });

  it("leaves blocked, uninstalled, active-scheduler and not-yet-synced shops alone", async () => {
    owing("blocked.myshopify.com", { connectionState: "needs_reauth" });
    owing("gone.myshopify.com", { uninstalledAt: new Date(NOW.getTime() - HOUR) });
    owing("active.myshopify.com");
    h.active.add("active.myshopify.com");
    owing("fresh.myshopify.com", { initialSyncCompletedAt: null });
    shopRow("none-owed.myshopify.com", { initialSyncCompletedAt: new Date(NOW.getTime() - HOUR) });
    await sweep().tick(NOW, { pauseMs: 0 });
    expect(h.catchUp).not.toHaveBeenCalled();
  });

  it("is bounded per tick", async () => {
    for (let i = 0; i < 6; i++) owing(`s${i}.myshopify.com`);
    const stats = await sweep().tick(NOW, { pauseMs: 0 });
    expect(stats.catchUpRun).toBe(CATCHUP_BATCH);
  });

  it("only runs that really worked count toward the limit; busy / paused / throwing shops are skipped over", async () => {
    for (let i = 0; i < 6; i++) owing(`s${i}.myshopify.com`);
    const outcomes: Record<string, string | Error> = {
      "s0.myshopify.com": "busy", "s1.myshopify.com": "paused", "s2.myshopify.com": new Error("boom"),
      "s3.myshopify.com": "done", "s4.myshopify.com": "incomplete", "s5.myshopify.com": "done",
    };
    h.catchUp.mockImplementation(async (shop: string) => {
      const o = outcomes[shop];
      if (o instanceof Error) throw o;
      return o;
    });
    const stats = await sweep().tick(NOW, { pauseMs: 0 });
    expect(stats.catchUpRun).toBe(CATCHUP_BATCH);
    expect(h.catchUp.mock.calls.map((c) => c[0])).toEqual(["s0", "s1", "s2", "s3", "s4"].map((s) => `${s}.myshopify.com`));
  });

  it("rotates: a shop tried a moment ago does not sit at the front and starve the others", async () => {
    for (let i = 0; i < 3; i++) owing(`s${i}.myshopify.com`);
    h.catchUp.mockImplementation(async (shop: string) => (shop === "s0.myshopify.com" ? "paused" : "done"));
    await sweep().tick(NOW, { pauseMs: 0 });
    h.catchUp.mockClear();
    await sweep().tick(NOW, { pauseMs: 0 });
    expect(h.catchUp.mock.calls.map((c) => c[0])).not.toContain("s0.myshopify.com");
  });

  it("a probe that lifts a block hands the shop to the catch-up on the NEXT tick, not the same one", async () => {
    owing("a.myshopify.com", { connectionState: "needs_reauth" });
    sessionRow("a.myshopify.com");
    // the fake clear does not touch the row; simulate what clearConnectionBlock does
    h.clear.mockImplementationOnce(async () => {
      installOf("a.myshopify.com").connectionState = null;
      return { cleared: true };
    });
    await sweep().tick(NOW, { pauseMs: 0 });
    expect(h.catchUp).toHaveBeenCalledTimes(1); // the same tick may already run it: the block is gone
  });
});

describe("summary", () => {
  it("logs one SUMMARY line a day with the blocked shops and what is owed", async () => {
    blockedShop("a.myshopify.com");
    blockedShop("b.myshopify.com", { connectionState: "shop_not_found" });
    shopRow("c.myshopify.com", { resyncRequiredSince: NOW, droppedWebhookCount: 7 });
    h.getAdmin.mockResolvedValue({ admin: { graphql: vi.fn(async () => { throw status(401); }) } });
    await sweep().tick(NOW, { pauseMs: 0 });
    const lines = vi.mocked(logger.info).mock.calls.map((c) => String(c[0])).filter((l) => l.includes("SUMMARY"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("blocked=2");
    expect(lines[0]).toContain("needs_reauth=1");
    expect(lines[0]).toContain("shop_not_found=1");
    expect(lines[0]).toContain("owingCatchUp=1");
    expect(lines[0]).toContain("droppedWebhooks=7");
    expect(lines[0]).toContain("unauthorized=2");
    await sweep().tick(new Date(NOW.getTime() + HOUR), { pauseMs: 0 });
    expect(vi.mocked(logger.info).mock.calls.filter((c) => String(c[0]).includes("SUMMARY"))).toHaveLength(1);
    await sweep().tick(new Date(NOW.getTime() + SUMMARY_INTERVAL_MS + HOUR), { pauseMs: 0 });
    expect(vi.mocked(logger.info).mock.calls.filter((c) => String(c[0]).includes("SUMMARY"))).toHaveLength(2);
  });
});

describe("a failing step does not take the tick down", () => {
  it("a throwing probe step still runs catch-up and summary", async () => {
    h.getBlock.mockRejectedValue(new Error("db down"));
    blockedShop("a.myshopify.com");
    await expect(sweep().tick(NOW, { pauseMs: 0 })).resolves.toBeTruthy();
  });
});
