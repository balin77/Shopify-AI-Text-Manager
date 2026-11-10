import { describe, it, expect } from "vitest";
import {
  compareShopStatus,
  computeShopStatus,
  type ShopStatusInput,
} from "../../app/services/admin/shop-status.shared";

const NOW = new Date("2026-11-10T12:00:00Z");
const ago = (d: number) => new Date(NOW.getTime() - d * 86_400_000);
const hours = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

const goodSession = { tokenEmpty: false, hasRefreshToken: true, expires: ago(-1), refreshTokenExpires: ago(-60) };

function input(over: Partial<ShopStatusInput> = {}): ShopStatusInput {
  return {
    shop: "a.example.test",
    onlyInWebhookLog: false,
    install: { lastActivityAt: ago(1), initialSyncCompletedAt: ago(30) },
    session: goodSession,
    migration: null,
    webhooks24h: { total: 0, failed: 0 },
    ...over,
  };
}

const run = (over: Partial<ShopStatusInput>, now: Date = NOW) => computeShopStatus(input(over), now);

describe("computeShopStatus", () => {
  const cases: Array<[string, Partial<ShopStatusInput>, "red" | "yellow" | "green" | "grey", RegExp | null, Date?]> = [
    ["plain healthy shop is green", {}, "green", null],
    ["uninstalled, quiet: grey", { install: { uninstalledAt: ago(5), lastActivityAt: ago(6) }, session: null }, "grey", /Deinstalliert/],
    ["uninstalled an hour ago, webhooks from BEFORE the mark: grey", { install: { uninstalledAt: hours(1), lastWebhookAt: hours(2) }, session: null, webhooks24h: { total: 3, failed: 0 } }, "grey", /Deinstalliert/],
    ["uninstalled with a webhook after it: red", { install: { uninstalledAt: ago(5), lastWebhookAt: ago(1) }, session: null }, "red", /deinstalliert/],
    ["uninstalled with reinstall evidence: red", { install: { uninstalledAt: ago(5), reinstallEvidenceAt: ago(1) }, session: null }, "red", /Belege/],
    ["needs_reauth block: red", { install: { lastActivityAt: ago(1), connectionState: "needs_reauth", connectionStateReason: "admin_api_401", connectionStateSince: ago(2) } }, "red", /neu installieren/],
    ["access denied: red", { install: { lastActivityAt: ago(1), connectionState: "access_denied", connectionStateSince: ago(2) } }, "red", /abgelehnt/],
    ["shop gone: red", { install: { lastActivityAt: ago(1), connectionState: "shop_not_found", connectionStateSince: ago(2) } }, "red", /nicht mehr/],
    ["empty token from the session: red", { session: { ...goodSession, tokenEmpty: true } }, "red", /neu installieren/],
    ["expired refresh token: red", { session: { ...goodSession, refreshTokenExpires: ago(1) } }, "red", /neu installieren/],
    ["migration gave up: red", { migration: { status: "failed", attempts: 40, startedAt: ago(9) } }, "red", /aufgegeben/],
    [
      "presumed uninstalled gets its hint",
      { install: { connectionState: "needs_reauth", connectionStateSince: ago(40), lastActivityAt: ago(60), initialSyncCompletedAt: ago(90) } },
      "red",
      /Abgleich ausstehend/,
    ],
    ["10 failures and 50 percent: red", { webhooks24h: { total: 20, failed: 10 } }, "red", /10 von 20/],
    ["10 failures but under 50 percent: yellow", { webhooks24h: { total: 100, failed: 10 } }, "yellow", /10 Webhook-Fehler/],
    ["9 failures of 9: yellow", { webhooks24h: { total: 9, failed: 9 } }, "yellow", /9 Webhook-Fehler/],
    ["only in the webhook log: red", { onlyInWebhookLog: true, install: null, session: null, webhooks24h: { total: 4, failed: 4 } }, "red", /nur im Webhook-Protokoll/],
    ["not opened for 15 days: yellow", { install: { lastActivityAt: ago(15), initialSyncCompletedAt: ago(30) } }, "yellow", /15 Tagen/],
    ["opened 14 days ago exactly: green", { install: { lastActivityAt: ago(14), initialSyncCompletedAt: ago(30) } }, "green", null],
    ["last opened unknown: yellow", { install: { initialSyncCompletedAt: ago(30) } }, "yellow", /unbekannt/],
    ["sign-in counts as opened", { install: { lastAuthAt: ago(2), initialSyncCompletedAt: ago(30) } }, "green", null],
    ["refresh token ends within 14 days: yellow", { session: { ...goodSession, refreshTokenExpires: ago(-5) } }, "yellow", /Refresh-Token läuft/],
    ["migration pending over 24 h: yellow", { migration: { status: "pending", attempts: 0, startedAt: hours(30) } }, "yellow", /Umstellung/],
    ["migration pending 2 h: green", { migration: { status: "pending", attempts: 0, startedAt: hours(2) } }, "green", null],
    ["failing migration: yellow", { migration: { status: "failed", attempts: 3, failureKind: "transient", failureKindSince: ago(2), startedAt: ago(3) } }, "yellow", /hängt/],
    ["installed without an offline session: yellow", { session: null }, "yellow", /Offline-Session/],
    ["initial sync open: yellow", { install: { lastActivityAt: ago(1) } }, "yellow", /Erstsynchronisation/],
    ["non-expiring token before 2026-12-01: green", { session: { ...goodSession, hasRefreshToken: false, refreshTokenExpires: null } }, "green", null],
    ["non-expiring token on 2026-12-01: yellow", { session: { ...goodSession, hasRefreshToken: false, refreshTokenExpires: null }, install: { lastActivityAt: new Date("2026-11-30T00:00:00Z"), initialSyncCompletedAt: ago(90) } }, "yellow", /nicht auf ablaufende/, new Date("2026-12-01T00:00:00Z")],
    ["non-expiring token on 2027-01-01: red", { session: { ...goodSession, hasRefreshToken: false, refreshTokenExpires: null }, install: { lastActivityAt: new Date("2026-12-31T00:00:00Z"), initialSyncCompletedAt: ago(90) } }, "red", /2027-01-01/, new Date("2027-01-01T00:00:00Z")],
  ];

  it.each(cases)("%s", (_name, over, color, reason, now) => {
    const status = run(over, now ?? NOW);
    expect(status.color).toBe(color);
    if (reason) expect(status.reasons.join(" | ")).toMatch(reason);
    else expect(status.reasons).toEqual([]);
  });

  it("order: red outranks yellow and lists only the winning colour's reasons", () => {
    const s = run({
      install: { lastActivityAt: ago(40), connectionState: "needs_reauth", connectionStateSince: ago(1) },
      webhooks24h: { total: 3, failed: 1 },
    });
    expect(s.color).toBe("red");
    expect(s.reasons.join(" ")).not.toMatch(/Webhook-Fehler|Tagen nicht geöffnet/);
  });

  it("grey outranks red evidence of a quiet uninstalled shop and a missing session", () => {
    const s = run({ install: { uninstalledAt: ago(3) }, session: null, migration: { status: "failed", attempts: 40 } });
    expect(s.color).toBe("grey");
    expect(s.tokenStatus).toBe("uninstalled");
  });

  it("returns the token verdict in German and the last-opened instant", () => {
    const s = run({});
    expect(s.tokenStatus).toBe("valid_expiring");
    expect(s.tokenLabel).toBe("gültig (ablaufend)");
    expect(s.lastOpenedMs).toBe(ago(1).getTime());
  });

  it("accepts serialised dates (the client gets ISO strings)", () => {
    const s = run({ install: { lastActivityAt: ago(1).toISOString(), initialSyncCompletedAt: ago(30).toISOString() }, session: { ...goodSession, expires: ago(-1).toISOString(), refreshTokenExpires: ago(-60).toISOString() } });
    expect(s.color).toBe("green");
  });
});

describe("compareShopStatus", () => {
  const mk = (shop: string, color: "red" | "yellow" | "green" | "grey", lastOpenedMs: number | null) => ({
    shop,
    status: { color, lastOpenedMs },
  });
  it("sorts red, yellow, green, grey, then most recently opened, unknown last, then name", () => {
    const rows = [
      mk("g.test", "green", 5),
      mk("n.test", "grey", 9),
      mk("y.test", "yellow", 1),
      mk("r-old.test", "red", 1),
      mk("r-new.test", "red", 8),
      mk("r-unknown.test", "red", null),
      mk("b.test", "green", 5),
    ];
    expect(rows.sort(compareShopStatus).map((r) => r.shop)).toEqual([
      "r-new.test",
      "r-old.test",
      "r-unknown.test",
      "y.test",
      "b.test",
      "g.test",
      "n.test",
    ]);
  });
});
