/**
 * app/services/offline-token-sweep.service.ts
 *
 * The sweep that migrates / keeps alive the offline tokens of shops that never
 * open the app. `db.session` / `db.shopInstallState` / the migration table are
 * in-memory fakes that interpret the sweep's REAL `where` shapes, so what is
 * asserted is its selection logic, not a hand-picked return value.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  sessions: [] as Array<Record<string, any>>,
  installState: [] as Array<Record<string, any>>,
  migrations: [] as Array<Record<string, any>>,
  activeSchedulers: new Set<string>(),
  backoff: new Set<string>(),
  lastActivityOverride: new Map<string, Date | null>(),
  migrate: vi.fn(),
  getAdmin: vi.fn(),
  released: [] as string[],
}));

vi.mock("~/utils/logger.server", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("~/db.server", async () => {
  const { fakeDelegate, migrationDefaults } = await import("../helpers/fake-prisma-tables");
  const db = {
    session: fakeDelegate(h.sessions),
    shopInstallState: fakeDelegate(h.installState),
    offlineTokenMigration: fakeDelegate(h.migrations, migrationDefaults),
  };
  return { db, default: db };
});
vi.mock("~/services/sync-scheduler.service", () => ({
  syncScheduler: { isShopActive: (shop: string) => h.activeSchedulers.has(shop) },
}));
vi.mock("~/middleware/activity-tracker.middleware", () => ({
  getLastActivity: async (shop: string) => {
    if (h.lastActivityOverride.has(shop)) return h.lastActivityOverride.get(shop) ?? null;
    return h.sessions.find((s) => s.shop === shop)?.lastActivityAt ?? null;
  },
}));
vi.mock("~/utils/offline-admin.server", () => ({
  maybeMigrateToExpiringToken: (shop: string) => h.migrate(shop),
  migrationMayBeNeeded: (shop: string) => !h.backoff.has(shop),
  MIGRATION_RETRY_DELAYS_MS: [2000, 5000, 15000],
  releaseStaleMigrationBlock: (shop: string) => h.released.push(shop),
  getOfflineAdmin: (shop: string) => h.getAdmin(shop),
}));

import {
  BATCH_SIZE,
  FIRST_TICK_DELAY_MS,
  envNumber,
  KEEP_ALIVE_MIN_INTERVAL_MS,
  OfflineTokenSweepService,
  SWEEP_QUIET_MS,
  TICK_INTERVAL_MS,
} from "~/services/offline-token-sweep.service";

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const NOW = new Date("2026-11-15T12:00:00Z");

function offlineSession(shop: string, over: Record<string, any> = {}) {
  const row = {
    id: `offline_${shop}`,
    shop,
    isOnline: false,
    accessToken: "enc-token",
    expires: null,
    refreshToken: null,
    refreshTokenExpires: null,
    lastActivityAt: new Date(NOW.getTime() - 2 * DAY),
    ...over,
  };
  h.sessions.push(row);
  return row;
}

function expiringSession(shop: string, refreshExpiresInDays: number, over: Record<string, any> = {}) {
  return offlineSession(shop, {
    expires: new Date(NOW.getTime() - 60 * DAY),
    refreshToken: "enc-refresh",
    refreshTokenExpires: new Date(NOW.getTime() + refreshExpiresInDays * DAY),
    ...over,
  });
}

const sweep = () => OfflineTokenSweepService.getInstance();
const tick = () => sweep().tick(NOW, { pauseMs: 0 });

const ENV = ["SHOPIFY_EXPIRING_OFFLINE_TOKENS", "SHOPIFY_MIGRATE_TO_EXPIRING_TOKENS"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV) {
    saved[k] = process.env[k];
    process.env[k] = "true";
  }
  h.sessions.length = 0;
  h.installState.length = 0;
  h.migrations.length = 0;
  h.activeSchedulers.clear();
  h.backoff.clear();
  h.lastActivityOverride.clear();
  h.released.length = 0;
  h.migrate.mockReset().mockResolvedValue("migrated");
  h.getAdmin.mockReset().mockResolvedValue({ session: { refreshTokenExpires: new Date(NOW.getTime() + 90 * DAY) } });
  sweep().__resetForTests();
});

afterEach(() => {
  sweep().__resetForTests();
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.useRealTimers();
});

describe("migration of dormant shops", () => {
  it("picks only quiet, installed, non-expiring shops with a token (or a recoverable record)", async () => {
    offlineSession("quiet-old.myshopify.com");
    offlineSession("quiet-unknown.myshopify.com", { lastActivityAt: null });
    offlineSession("just-active.myshopify.com", { lastActivityAt: new Date(NOW.getTime() - 5 * MIN) });
    offlineSession("expiring.myshopify.com", { expires: new Date(NOW.getTime() + 3600_000), refreshToken: "r" });
    offlineSession("online.myshopify.com", { isOnline: true, id: "online_1" });
    offlineSession("uninstalled.myshopify.com");
    h.installState.push({ shop: "uninstalled.myshopify.com", uninstalledAt: new Date(NOW.getTime() - DAY) });
    offlineSession("reinstalled.myshopify.com"); // marker present but cleared
    h.installState.push({ shop: "reinstalled.myshopify.com", uninstalledAt: null });
    offlineSession("scheduler.myshopify.com");
    h.activeSchedulers.add("scheduler.myshopify.com");
    offlineSession("no-token.myshopify.com", { accessToken: "" }); // nothing to migrate with
    // lost its token mid-migration, but the durable record still has the old one
    offlineSession("lost-token.myshopify.com", { accessToken: "" });
    h.migrations.push({
      shop: "lost-token.myshopify.com",
      encryptedOldToken: "ciphertext",
      status: "pending",
      attempts: 1,
      startedAt: new Date(NOW.getTime() - DAY),
    });
    // ...and one whose recovery window is over does not make an empty session eligible
    offlineSession("lost-late.myshopify.com", { accessToken: "" });
    h.migrations.push({
      shop: "lost-late.myshopify.com",
      encryptedOldToken: "ciphertext",
      status: "failed",
      attempts: 4,
      startedAt: new Date(NOW.getTime() - 9 * DAY),
    });

    const stats = await tick();

    const migrated = h.migrate.mock.calls.map(([shop]) => shop).sort();
    expect(migrated).toEqual(
      ["lost-token.myshopify.com", "quiet-old.myshopify.com", "quiet-unknown.myshopify.com", "reinstalled.myshopify.com"].sort(),
    );
    expect(stats.migrated).toBe(4);
    expect(stats.migrateSkipped).toBeGreaterThanOrEqual(2); // uninstalled, scheduler
  });

  it("skips shops marked needs_reauth", async () => {
    offlineSession("refused.myshopify.com");
    offlineSession("fine.myshopify.com");
    h.migrations.push({ shop: "refused.myshopify.com", encryptedOldToken: null, status: "needs_reauth", attempts: 1, startedAt: NOW });
    await tick();
    expect(h.migrate.mock.calls.map(([s]) => s)).toEqual(["fine.myshopify.com"]);
  });

  it("skips a shop that is migrating / in backoff in this process", async () => {
    offlineSession("busy.myshopify.com");
    h.backoff.add("busy.myshopify.com");
    const stats = await tick();
    expect(h.migrate).not.toHaveBeenCalled();
    expect(stats.migrateSkipped).toBe(1);
  });

  it("re-checks quietness at run time (the merchant may have opened the app since the query)", async () => {
    offlineSession("opened.myshopify.com");
    h.lastActivityOverride.set("opened.myshopify.com", new Date(NOW.getTime() - 1000));
    await tick();
    expect(h.migrate).not.toHaveBeenCalled();
  });

  it("respects the batch size and takes the longest-quiet shops first", async () => {
    const total = BATCH_SIZE + 4;
    for (let i = 0; i < total; i++) {
      // i = 0 is the most recently active; the last one is the oldest
      offlineSession(`shop-${i}.myshopify.com`, { lastActivityAt: new Date(NOW.getTime() - (2 + i) * DAY) });
    }
    const stats = await tick();
    expect(h.migrate).toHaveBeenCalledTimes(BATCH_SIZE);
    expect(h.migrate.mock.calls[0][0]).toBe(`shop-${total - 1}.myshopify.com`);
    expect(stats.migrated).toBe(BATCH_SIZE);
  });

  it("does not let skipped shops (backoff) use up the batch", async () => {
    for (let i = 0; i < BATCH_SIZE + 2; i++) {
      offlineSession(`stuck-${i}.myshopify.com`, { lastActivityAt: new Date(NOW.getTime() - (30 + i) * DAY) });
      h.backoff.add(`stuck-${i}.myshopify.com`);
    }
    offlineSession("healthy.myshopify.com");
    await tick();
    expect(h.migrate.mock.calls.map(([s]) => s)).toEqual(["healthy.myshopify.com"]);
  });

  it("migrates sequentially, never two at once, with the configured pause in between", async () => {
    for (let i = 0; i < 3; i++) offlineSession(`seq-${i}.myshopify.com`);
    let running = 0;
    let maxRunning = 0;
    h.migrate.mockImplementation(async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return "migrated";
    });
    await tick();
    expect(h.migrate).toHaveBeenCalledTimes(3);
    expect(maxRunning).toBe(1);

    vi.useFakeTimers();
    h.migrate.mockReset().mockResolvedValue("migrated");
    sweep().__resetForTests();
    const run = sweep().tick(NOW, { pauseMs: 5_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.migrate).toHaveBeenCalledTimes(1); // first shop at once, then the pause
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.migrate).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5_000);
    await run;
    expect(h.migrate).toHaveBeenCalledTimes(3);
  });

  it("tallies the outcomes", async () => {
    for (const s of ["a", "b", "c", "d"]) offlineSession(`${s}.myshopify.com`, { lastActivityAt: null });
    h.migrate
      .mockResolvedValueOnce("migrated")
      .mockResolvedValueOnce("needs_reauth")
      .mockResolvedValueOnce("failed")
      .mockResolvedValueOnce("not_needed");
    const stats = await tick();
    expect(stats).toMatchObject({ migrated: 1, migrateNeedsReauth: 1, migrateFailed: 1, migrateSkipped: 1 });
  });
});

describe("quietness, backoff exclusion, env knobs", () => {
  it("a failed activity lookup (null) does not release a shop whose row HAD an activity stamp", async () => {
    offlineSession("had-stamp.myshopify.com"); // row: 2 days ago
    h.lastActivityOverride.set("had-stamp.myshopify.com", null); // lookup error
    offlineSession("never.myshopify.com", { lastActivityAt: null }); // row itself says unknown
    await tick();
    expect(h.migrate.mock.calls.map(([s]) => s)).toEqual(["never.myshopify.com"]);
  });

  it("shops in persisted backoff / given up are excluded in SQL and do not starve the batch", async () => {
    for (let i = 0; i < BATCH_SIZE + 2; i++) {
      offlineSession(`failed-${i}.myshopify.com`, { lastActivityAt: new Date(NOW.getTime() - (30 + i) * DAY) });
      h.migrations.push({ shop: `failed-${i}.myshopify.com`, encryptedOldToken: "c", status: "failed", attempts: i === 0 ? 40 : 4, startedAt: NOW, updatedAt: NOW });
    }
    offlineSession("healthy.myshopify.com");
    await tick();
    expect(h.migrate.mock.calls.map(([s]) => s)).toEqual(["healthy.myshopify.com"]);
    // once the backoff has passed it is a candidate again (the capped one never is)
    h.migrate.mockClear();
    await sweep().tick(new Date(NOW.getTime() + 2 * 3600_000), { pauseMs: 0 });
    const again = h.migrate.mock.calls.map(([s]) => s);
    expect(again).toContain("failed-6.myshopify.com");
    expect(again).not.toContain("failed-0.myshopify.com");
  });

  it("a blocking record of ANOTHER token (fingerprint differs from the session) no longer blocks the shop", async () => {
    const { fingerprintToken } = await import("~/utils/offline-token-migration-store.server");
    offlineSession("reissued.myshopify.com", { accessToken: "new-nonexpiring" });
    offlineSession("same.myshopify.com", { accessToken: "still-the-dead-one" });
    offlineSession("legacy-row.myshopify.com", { accessToken: "whatever" });
    h.migrations.push(
      { shop: "reissued.myshopify.com", encryptedOldToken: null, status: "needs_reauth", attempts: 1, startedAt: NOW, updatedAt: NOW, tokenFingerprint: fingerprintToken("old-token") },
      { shop: "same.myshopify.com", encryptedOldToken: null, status: "needs_reauth", attempts: 1, startedAt: NOW, updatedAt: NOW, tokenFingerprint: fingerprintToken("still-the-dead-one") },
      { shop: "legacy-row.myshopify.com", encryptedOldToken: null, status: "needs_reauth", attempts: 1, startedAt: NOW, updatedAt: NOW, tokenFingerprint: null },
    );
    await tick();
    expect(h.migrate.mock.calls.map(([s]) => s)).toEqual(["reissued.myshopify.com"]);
  });

  it("asks the process to forget a stale in-process block for every candidate (database wins over memory)", async () => {
    offlineSession("reset.myshopify.com");
    await tick();
    expect(h.released).toContain("reset.myshopify.com");
  });

  it("m-3: erases the ciphertext of past-window records whose session holds no token (fingerprint stays)", async () => {
    offlineSession("blank.myshopify.com", { accessToken: "" });
    offlineSession("holds.myshopify.com", { accessToken: "still-has-it" });
    const old = new Date(NOW.getTime() - 9 * DAY);
    for (const shop of ["blank.myshopify.com", "holds.myshopify.com"]) {
      h.migrations.push({ shop, encryptedOldToken: "cipher", tokenFingerprint: "abcd", status: "failed", attempts: 4, startedAt: old, updatedAt: old });
    }
    h.migrations.push({ shop: "fresh.myshopify.com", encryptedOldToken: "cipher", tokenFingerprint: "abcd", status: "pending", attempts: 0, startedAt: NOW, updatedAt: NOW });
    await tick();
    const by = (s: string) => h.migrations.find((m) => m.shop === s)!;
    expect(by("blank.myshopify.com").encryptedOldToken).toBeNull();
    expect(by("blank.myshopify.com").tokenFingerprint).toBe("abcd");
    expect(by("holds.myshopify.com").encryptedOldToken).toBe("cipher");
    expect(by("fresh.myshopify.com").encryptedOldToken).toBe("cipher");
  });

  it("m-E: the purge pages oldest-first with a cursor, so kept rows do not starve the ones behind them", async () => {
    const { PURGE_PAGE_SIZE } = await import("~/services/offline-token-sweep.service");
    // PURGE_PAGE_SIZE rows whose session still HOLDS a token (kept), then 3 behind them, one unrecoverable
    for (let i = 0; i < PURGE_PAGE_SIZE + 3; i++) {
      const shop = `p-${String(i).padStart(4, "0")}.myshopify.com`;
      const blank = i === PURGE_PAGE_SIZE + 1;
      offlineSession(shop, { accessToken: blank ? "" : "has-token", lastActivityAt: NOW });
      const started = new Date(NOW.getTime() - 20 * DAY + i * 1000);
      h.migrations.push({ shop, encryptedOldToken: "cipher", tokenFingerprint: "abcd", status: "failed", attempts: 4, startedAt: started, updatedAt: NOW });
    }
    const target = h.migrations[PURGE_PAGE_SIZE + 1];
    await tick();
    expect(target.encryptedOldToken).toBe("cipher"); // beyond the first page
    await tick();
    expect(target.encryptedOldToken).toBeNull(); // reached on the next tick
  });

  it("envNumber falls back for NaN, empty, below-minimum values", () => {
    expect(envNumber("abc", 600000, 60000)).toBe(600000);
    expect(envNumber("", 5, 1)).toBe(5);
    expect(envNumber(undefined, 5, 1)).toBe(5);
    expect(envNumber("0", 5, 1)).toBe(5);
    expect(envNumber("10", 600000, 60000)).toBe(600000); // interval below the minimum
    expect(envNumber("120000", 600000, 60000)).toBe(120000);
    expect(envNumber("0", 5000, 0)).toBe(0); // a zero pause is valid
    expect(envNumber("-1", 5000, 0)).toBe(5000);
  });
});

describe("keep-alive of expiring tokens", () => {
  it("refreshes quiet shops whose refresh token ends within 14 days, soonest first", async () => {
    expiringSession("soon.myshopify.com", 3);
    expiringSession("soonish.myshopify.com", 13);
    expiringSession("later.myshopify.com", 40);
    expiringSession("dead.myshopify.com", -2); // refresh token already expired: cannot help
    expiringSession("active.myshopify.com", 5, { lastActivityAt: new Date(NOW.getTime() - 2 * MIN) });
    expiringSession("scheduler.myshopify.com", 5);
    h.activeSchedulers.add("scheduler.myshopify.com");
    expiringSession("gone.myshopify.com", 5);
    h.installState.push({ shop: "gone.myshopify.com", uninstalledAt: NOW });
    offlineSession("legacy.myshopify.com"); // non-expiring: the migration's business, not keep-alive's

    const stats = await tick();

    expect(h.getAdmin.mock.calls.map(([s]) => s)).toEqual(["soon.myshopify.com", "soonish.myshopify.com"]);
    expect(stats.keepAliveRefreshed).toBe(2);
  });

  it("counts a failed refresh and carries on with the next shop", async () => {
    expiringSession("bad.myshopify.com", 2);
    expiringSession("good.myshopify.com", 4);
    h.getAdmin.mockRejectedValueOnce(new Error("refresh failed")).mockResolvedValueOnce({ session: {} });
    const stats = await tick();
    expect(stats).toMatchObject({ keepAliveRefreshed: 1, keepAliveFailed: 1 });
  });

  it("does not refresh the same shop again before KEEP_ALIVE_MIN_INTERVAL_MS (no storm if the expiry does not move)", async () => {
    expiringSession("once.myshopify.com", 2);
    await tick();
    await tick();
    expect(h.getAdmin).toHaveBeenCalledTimes(1);
    await sweep().tick(new Date(NOW.getTime() + KEEP_ALIVE_MIN_INTERVAL_MS + 1), { pauseMs: 0 });
    expect(h.getAdmin).toHaveBeenCalledTimes(2);
  });

  it("respects the batch size", async () => {
    for (let i = 0; i < BATCH_SIZE + 3; i++) expiringSession(`k-${i}.myshopify.com`, 1 + i * 0.1);
    await tick();
    expect(h.getAdmin).toHaveBeenCalledTimes(BATCH_SIZE);
  });
});

describe("switches off", () => {
  it.each([
    ["both off", {}],
    ["migration switch without the first", { SHOPIFY_EXPIRING_OFFLINE_TOKENS: undefined, SHOPIFY_MIGRATE_TO_EXPIRING_TOKENS: "true" }],
  ])("%s: tick() does nothing, not even a query", async (_name, env) => {
    for (const k of ENV) delete process.env[k];
    Object.assign(process.env, Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)));
    offlineSession("quiet.myshopify.com");
    expiringSession("expiring.myshopify.com", 2);
    const { db } = await import("~/db.server");
    const spy = vi.spyOn(db.session, "findMany");
    const stats = await tick();
    expect(spy).not.toHaveBeenCalled();
    expect(h.migrate).not.toHaveBeenCalled();
    expect(h.getAdmin).not.toHaveBeenCalled();
    expect(Object.values(stats).every((v) => v === 0)).toBe(true);
    spy.mockRestore();
  });

  it("expiring switch only: keep-alive still runs, the migration part does not", async () => {
    delete process.env.SHOPIFY_MIGRATE_TO_EXPIRING_TOKENS;
    offlineSession("quiet.myshopify.com");
    expiringSession("expiring.myshopify.com", 2);
    const stats = await tick();
    expect(h.migrate).not.toHaveBeenCalled();
    expect(stats.migrateCandidates).toBe(0);
    expect(h.getAdmin.mock.calls.map(([s]) => s)).toEqual(["expiring.myshopify.com"]);
  });

  it("start() with the expiring switch only DOES start the timer (keep-alive); with both off it does not", () => {
    vi.useFakeTimers();
    delete process.env.SHOPIFY_MIGRATE_TO_EXPIRING_TOKENS;
    sweep().start();
    expect(vi.getTimerCount()).toBe(2);
    sweep().stop();
    delete process.env.SHOPIFY_EXPIRING_OFFLINE_TOKENS;
    sweep().start();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("start() starts no timer at all", () => {
    vi.useFakeTimers();
    for (const k of ENV) delete process.env[k];
    sweep().start();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("start / stop", () => {
  it("is idempotent, ticks after the first delay and then on the interval, and stop() clears the timers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    offlineSession("quiet.myshopify.com");
    sweep().start();
    sweep().start();
    expect(vi.getTimerCount()).toBe(2); // first-tick timeout + interval
    expect(h.migrate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(FIRST_TICK_DELAY_MS + 10);
    expect(h.migrate).toHaveBeenCalledTimes(1);
    sweep().stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(TICK_INTERVAL_MS).toBeGreaterThan(0);
    expect(SWEEP_QUIET_MS).toBeGreaterThan(5 * MIN); // longer than the scheduler's own inactivity stop
  });
});
