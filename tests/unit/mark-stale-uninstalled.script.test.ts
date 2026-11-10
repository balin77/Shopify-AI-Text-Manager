/**
 * PLAN_ADMIN_SHOP_OVERVIEW 2.7: the operator script. Dry run by default, writes
 * only with --apply, refuses without evidence.
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

import { parseArgs, runMarkStaleUninstalled } from "../../scripts/mark-stale-uninstalled";

const DAY = 86_400_000;
const NOW = new Date("2026-11-15T12:00:00Z");
const ago = (d: number) => new Date(NOW.getTime() - d * DAY);
const SHOP = "demo-shop.myshopify.com";

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { log: (l: string) => out.push(l), error: (l: string) => err.push(l) } };
}
function install(over: Record<string, any> = {}) {
  h.install.push({
    shop: SHOP, uninstalledAt: null, connectionState: "needs_reauth", connectionStateSince: ago(45),
    connectionStateReason: "no_token", lastWebhookAt: ago(60), lastActivityAt: null, lastAuthAt: null,
    lastApiOkAt: null, reinstallEvidenceAt: null, ...over,
  });
}

beforeEach(() => {
  h.install.length = 0;
  h.sessions.length = 0;
  h.migrations.length = 0;
  vi.clearAllMocks();
});

describe("mark-stale-uninstalled", () => {
  it("parses its arguments", () => {
    expect(parseArgs(["--shop", "A.myshopify.com", "--apply"])).toEqual({ shop: "a.myshopify.com", apply: true, forceWithToken: false, unknown: [] });
    expect(parseArgs(["--shop", "a.myshopify.com", "--force-with-token"]).forceWithToken).toBe(true);
    expect(parseArgs(["--shop=a.myshopify.com", "--x"]).unknown).toEqual(["--x"]);
  });

  it("rejects a missing or malformed shop", async () => {
    const a = io();
    expect(await runMarkStaleUninstalled([], a.io, NOW)).toBe(1);
    expect(await runMarkStaleUninstalled(["--shop", "not-a-shop"], a.io, NOW)).toBe(1);
    expect(h.mark).not.toHaveBeenCalled();
  });

  it("dry run (default): prints the evidence and changes nothing, even with evidence", async () => {
    install();
    const a = io();
    expect(await runMarkStaleUninstalled(["--shop", SHOP], a.io, NOW)).toBe(0);
    const text = a.out.join("\n");
    expect(text).toContain("last webhook");
    expect(text).toContain("last API success");
    expect(text).toContain("needs_reauth");
    expect(text).toContain("DRY RUN");
    expect(h.mark).not.toHaveBeenCalled();
  });

  it("--apply marks through markShopUninstalled with source operator", async () => {
    install();
    const a = io();
    expect(await runMarkStaleUninstalled(["--shop", SHOP, "--apply"], a.io, NOW)).toBe(0);
    expect(h.mark).toHaveBeenCalledTimes(1);
    expect(h.mark).toHaveBeenCalledWith(SHOP, { source: "operator", ifBlockedSince: expect.any(Date), failure: {} });
  });

  it("refuses (exit 2) without evidence, also with --apply", async () => {
    const cases: Array<Record<string, any>> = [
      { connectionState: null, connectionStateSince: null },
      { connectionStateSince: ago(10) },
      { lastWebhookAt: ago(2) },
      { lastApiOkAt: ago(2) },
      { lastActivityAt: ago(2) },
      { reinstallEvidenceAt: ago(2) },
      { uninstalledAt: ago(2) },
    ];
    for (const over of cases) {
      h.install.length = 0;
      install(over);
      const a = io();
      expect(await runMarkStaleUninstalled(["--shop", SHOP, "--apply"], a.io, NOW)).toBe(2);
      expect(a.err.join("\n")).toContain("REFUSED");
    }
    const a = io();
    h.install.length = 0;
    expect(await runMarkStaleUninstalled(["--shop", SHOP, "--apply"], a.io, NOW)).toBe(2);
    expect(h.mark).not.toHaveBeenCalled();
  });

  it("a 404 shop needs only 7 days", async () => {
    install({ connectionState: "shop_not_found", connectionStateSince: ago(8) });
    expect(await runMarkStaleUninstalled(["--shop", SHOP, "--apply"], io().io, NOW)).toBe(0);
    expect(h.mark).toHaveBeenCalledTimes(1);
  });

  it("refuses a shop whose session still holds a token unless --force-with-token", async () => {
    install();
    h.sessions.push({ shop: SHOP, isOnline: false, accessToken: "tok", refreshToken: null });
    const a = io();
    expect(await runMarkStaleUninstalled(["--shop", SHOP, "--apply"], a.io, NOW)).toBe(2);
    expect(a.err.join("\n")).toContain("--force-with-token");
    expect(h.mark).not.toHaveBeenCalled();
    expect(await runMarkStaleUninstalled(["--shop", SHOP, "--apply", "--force-with-token"], io().io, NOW)).toBe(0);
    expect(h.mark).toHaveBeenCalledTimes(1);
  });

  it("does not report success when the conditional mark finds the state changed", async () => {
    install();
    h.mark.mockResolvedValueOnce(false as any);
    expect(await runMarkStaleUninstalled(["--shop", SHOP, "--apply"], io().io, NOW)).toBe(2);
  });

  it("never prints a token", async () => {
    install();
    h.sessions.push({ shop: SHOP, isOnline: false, accessToken: "SECRET-TOKEN-VALUE" });
    const a = io();
    await runMarkStaleUninstalled(["--shop", SHOP], a.io, NOW);
    expect(a.out.join("\n") + a.err.join("\n")).not.toContain("SECRET-TOKEN-VALUE");
  });
});
