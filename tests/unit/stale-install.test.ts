/**
 * PLAN_ADMIN_SHOP_OVERVIEW 2.7: stale install state. The pure thresholds, the
 * review (evidence) and the OPTIONAL automatic marking (off by default).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  install: [] as Array<Record<string, any>>,
  sessions: [] as Array<Record<string, any>>,
  migrations: [] as Array<Record<string, any>>,
  mark: vi.fn(async (..._a: any[]) => undefined),
}));

vi.mock("~/utils/logger.server", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("~/db.server", async () => {
  const { fakeDelegate } = await import("../helpers/fake-prisma-tables");
  const db = {
    shopInstallState: fakeDelegate(h.install),
    session: fakeDelegate(h.sessions),
    offlineTokenMigration: fakeDelegate(h.migrations),
  };
  return { db, default: db };
});
vi.mock("~/services/shop-uninstall.server", () => ({
  markShopUninstalled: (...a: any[]) => h.mark(...a),
}));

import { logger } from "~/utils/logger.server";
import {
  AUTO_MARK_AFTER_MS,
  AUTO_MARK_AFTER_MS_NOT_FOUND,
  PRESUMED_UNINSTALLED_AFTER_MS,
  hasReinstallEvidenceAfterUninstall,
  isPresumedUninstalled,
  isStaleAutoMarkCandidate,
} from "~/services/shop-connection-status.shared";
import {
  STALE_AUTO_MARK_PER_RUN,
  autoMarkStaleInstalls,
  reviewStaleInstall,
  staleAutoMarkEnabled,
} from "~/services/stale-install.server";

const DAY = 86_400_000;
const NOW = new Date("2026-11-15T12:00:00Z");
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);
const ON = { STALE_INSTALL_AUTO_MARK: "true" };

function blocked(shop: string, daysBlocked: number, over: Record<string, any> = {}) {
  h.install.push({
    shop, uninstalledAt: null, connectionState: "needs_reauth", connectionStateSince: ago(daysBlocked),
    connectionStateReason: "no_token", lastWebhookAt: null, lastActivityAt: null, lastAuthAt: null,
    lastApiOkAt: null, reinstallEvidenceAt: null, ...over,
  });
}

beforeEach(() => {
  h.install.length = 0;
  h.sessions.length = 0;
  h.migrations.length = 0;
  vi.clearAllMocks();
});

describe("thresholds (pure)", () => {
  it("presumed at 30 days (7 for a 404), auto-mark at 90 (14 for a 404)", () => {
    const base = { connectionState: "needs_reauth", connectionStateSince: ago(31) };
    expect(isPresumedUninstalled(base, NOW)).toBe(true);
    expect(isPresumedUninstalled({ ...base, connectionStateSince: ago(29) }, NOW)).toBe(false);
    expect(isStaleAutoMarkCandidate(base, NOW)).toBe(false);
    expect(isStaleAutoMarkCandidate({ ...base, connectionStateSince: ago(91) }, NOW)).toBe(true);
    expect(isStaleAutoMarkCandidate({ ...base, connectionStateSince: ago(89) }, NOW)).toBe(false);
    const nf = { connectionState: "shop_not_found", connectionStateSince: ago(8) };
    expect(isPresumedUninstalled(nf, NOW)).toBe(true);
    expect(isStaleAutoMarkCandidate(nf, NOW)).toBe(false);
    expect(isStaleAutoMarkCandidate({ ...nf, connectionStateSince: ago(15) }, NOW)).toBe(true);
    expect(AUTO_MARK_AFTER_MS).toBe(90 * DAY);
    expect(AUTO_MARK_AFTER_MS_NOT_FOUND).toBe(14 * DAY);
    expect(PRESUMED_UNINSTALLED_AFTER_MS).toBe(30 * DAY);
  });

  it("any sign of life since the block begins (incl. API success and reinstall evidence) excludes", () => {
    const base = { connectionState: "needs_reauth", connectionStateSince: ago(120) };
    for (const field of ["lastWebhookAt", "lastActivityAt", "lastAuthAt", "lastApiOkAt", "reinstallEvidenceAt"]) {
      expect(isStaleAutoMarkCandidate({ ...base, [field]: ago(5) }, NOW)).toBe(false);
      expect(isPresumedUninstalled({ ...base, [field]: ago(5) }, NOW)).toBe(false);
      // life from BEFORE the block says nothing about the block
      expect(isStaleAutoMarkCandidate({ ...base, [field]: ago(200) }, NOW)).toBe(true);
    }
  });

  it("an already uninstalled or unblocked shop is never a candidate", () => {
    expect(isStaleAutoMarkCandidate({ connectionState: "needs_reauth", connectionStateSince: ago(120), uninstalledAt: ago(1) }, NOW)).toBe(false);
    expect(isStaleAutoMarkCandidate({ connectionState: null, connectionStateSince: ago(120) }, NOW)).toBe(false);
    expect(isStaleAutoMarkCandidate({ connectionState: "needs_reauth", connectionStateSince: null }, NOW)).toBe(false);
  });

  it("reinstall evidence after the uninstall: stored evidence, a webhook or an API success", () => {
    const un = ago(10);
    expect(hasReinstallEvidenceAfterUninstall({ uninstalledAt: un })).toBe(false);
    expect(hasReinstallEvidenceAfterUninstall({ uninstalledAt: un, reinstallEvidenceAt: ago(9) })).toBe(true);
    expect(hasReinstallEvidenceAfterUninstall({ uninstalledAt: un, reinstallEvidenceAt: ago(11) })).toBe(false);
    expect(hasReinstallEvidenceAfterUninstall({ uninstalledAt: un, lastWebhookAt: ago(9) })).toBe(true);
    expect(hasReinstallEvidenceAfterUninstall({ uninstalledAt: un, lastWebhookAt: new Date(un.getTime() + 60_000) })).toBe(false);
    expect(hasReinstallEvidenceAfterUninstall({ uninstalledAt: un, lastApiOkAt: ago(9) })).toBe(true);
    expect(hasReinstallEvidenceAfterUninstall({ reinstallEvidenceAt: ago(1) })).toBe(false);
  });
});

describe("reviewStaleInstall", () => {
  it("reports the evidence and the session shape, never a token", async () => {
    blocked("a.myshopify.com", 40);
    h.sessions.push({ shop: "a.myshopify.com", isOnline: false, accessToken: "" });
    const r = await reviewStaleInstall("a.myshopify.com", NOW);
    expect(r).toMatchObject({ found: true, presumedUninstalled: true, autoMarkEligible: false });
    expect(r.sessions).toEqual({ total: 1, withToken: 0 });
    expect(JSON.stringify(r)).not.toContain("accessToken");
    expect((await reviewStaleInstall("none.myshopify.com", NOW)).found).toBe(false);
  });
});

describe("autoMarkStaleInstalls", () => {
  it("is OFF by default and for anything but the exact value 'true'", async () => {
    blocked("a.myshopify.com", 200);
    for (const env of [{}, { STALE_INSTALL_AUTO_MARK: "1" }, { STALE_INSTALL_AUTO_MARK: "TRUE" }, { STALE_INSTALL_AUTO_MARK: "yes" }, { STALE_INSTALL_AUTO_MARK: " true" }]) {
      expect(staleAutoMarkEnabled(env)).toBe(false);
      expect(await autoMarkStaleInstalls(NOW, { env })).toMatchObject({ enabled: false, marked: [] });
    }
    expect(h.mark).not.toHaveBeenCalled();
    expect(staleAutoMarkEnabled(ON)).toBe(true);
  });

  it("marks with source stale_auto after 90 days (14 for a 404) and logs each mark", async () => {
    blocked("old.myshopify.com", 91);
    blocked("young.myshopify.com", 60);
    blocked("gone.myshopify.com", 15, { connectionState: "shop_not_found" });
    blocked("gone-young.myshopify.com", 10, { connectionState: "shop_not_found" });
    const r = await autoMarkStaleInstalls(NOW, { env: ON });
    expect(r.marked.sort()).toEqual(["gone.myshopify.com", "old.myshopify.com"]);
    expect(h.mark).toHaveBeenCalledWith("old.myshopify.com", { source: "stale_auto" });
    expect(h.mark).toHaveBeenCalledWith("gone.myshopify.com", { source: "stale_auto" });
    const lines = vi.mocked(logger.warn).mock.calls.map((c) => String(c[0])).filter((l) => l.includes("AUTO_MARKED_UNINSTALLED"));
    expect(lines).toHaveLength(2);
  });

  it("never marks a shop with recent webhooks, API success, a visit, a sign-in or reinstall evidence", async () => {
    blocked("w.myshopify.com", 200, { lastWebhookAt: ago(3) });
    blocked("api.myshopify.com", 200, { lastApiOkAt: ago(3) });
    blocked("v.myshopify.com", 200, { lastActivityAt: ago(3) });
    blocked("s.myshopify.com", 200, { lastAuthAt: ago(3) });
    blocked("e.myshopify.com", 200, { reinstallEvidenceAt: ago(3) });
    blocked("u.myshopify.com", 200, { uninstalledAt: ago(2) });
    const r = await autoMarkStaleInstalls(NOW, { env: ON });
    expect(r.marked).toEqual([]);
    expect(h.mark).not.toHaveBeenCalled();
  });

  it("never marks over a session that still holds a token", async () => {
    blocked("t.myshopify.com", 200);
    h.sessions.push({ shop: "t.myshopify.com", isOnline: false, accessToken: "x" });
    expect((await autoMarkStaleInstalls(NOW, { env: ON })).marked).toEqual([]);
  });

  it("is bounded per run, oldest block first", async () => {
    for (let i = 0; i < 12; i++) blocked(`s${i}.myshopify.com`, 100 + i);
    const r = await autoMarkStaleInstalls(NOW, { env: ON });
    expect(r.marked).toHaveLength(STALE_AUTO_MARK_PER_RUN);
    expect(r.marked[0]).toBe("s11.myshopify.com");
    expect(h.mark).toHaveBeenCalledTimes(STALE_AUTO_MARK_PER_RUN);
    const two = await autoMarkStaleInstalls(NOW, { env: ON, limit: 2 });
    expect(two.marked).toHaveLength(2);
  });

  it("a failing mark does not stop the others and never throws", async () => {
    blocked("a.myshopify.com", 100);
    blocked("b.myshopify.com", 101);
    h.mark.mockRejectedValueOnce(new Error("boom"));
    const r = await autoMarkStaleInstalls(NOW, { env: ON });
    expect(r.marked).toHaveLength(1);
  });
});
