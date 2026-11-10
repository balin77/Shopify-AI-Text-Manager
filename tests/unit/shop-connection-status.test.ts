import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONNECTION_STATUS_ORDER,
  MIGRATION_GAVE_UP_ATTEMPTS,
  deriveConnectionStatus,
  isPresumedUninstalled,
  hasWebhookAfterUninstall,
  type ConnectionStatusInput,
} from "../../app/services/shop-connection-status.shared";

const NOW = new Date("2026-12-01T12:00:00Z");
const day = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
const okSession = { tokenEmpty: false, hasRefreshToken: true, expires: day(-1), refreshTokenExpires: day(-60) };

function input(over: Partial<ConnectionStatusInput> = {}): ConnectionStatusInput {
  return { now: NOW, install: {}, session: okSession, migration: null, ...over };
}

describe("deriveConnectionStatus: first applicable rule wins", () => {
  it("pins the migration give-up threshold to the store's constant", () => {
    const src = readFileSync(join(process.cwd(), "app/utils/offline-token-migration-store.server.ts"), "utf8");
    expect(src).toContain(`MIGRATION_MAX_ATTEMPTS = ${MIGRATION_GAVE_UP_ATTEMPTS};`);
  });

  const cases: Array<[string, ConnectionStatusInput, string, string | null]> = [
    ["uninstalled outranks a block", input({ install: { uninstalledAt: day(2), uninstallSource: "webhook", connectionState: "needs_reauth" } }), "uninstalled", "uninstalled_webhook"],
    ["shop_not_found", input({ install: { connectionState: "shop_not_found", connectionStateReason: "token_endpoint_404", connectionStateSince: day(3) } }), "shop_not_found", "token_endpoint_404"],
    ["access_denied", input({ install: { connectionState: "access_denied", connectionStateReason: "token_endpoint_403" } }), "access_denied", "token_endpoint_403"],
    ["recorded needs_reauth", input({ install: { connectionState: "needs_reauth", connectionStateReason: "admin_api_401" } }), "needs_reauth", "admin_api_401"],
    ["empty token without a record", input({ session: { ...okSession, tokenEmpty: true } }), "needs_reauth", "no_token"],
    ["expired refresh token", input({ session: { ...okSession, refreshTokenExpires: day(1) } }), "needs_reauth", "refresh_token_expired"],
    ["migration needs_reauth", input({ migration: { status: "needs_reauth", attempts: 1 } }), "needs_reauth", "invalid_subject_token"],
    ["migration given up", input({ migration: { status: "failed", attempts: 40, failureKind: "transient" } }), "migration_gave_up", "transient"],
    ["migration failing", input({ migration: { status: "failed", attempts: 7 } }), "failing_transiently", "migration_failed"],
    ["migration pending after attempts", input({ migration: { status: "pending", attempts: 2 } }), "failing_transiently", "migration_failed"],
    ["fresh pending migration is fine", input({ migration: { status: "pending", attempts: 0 } }), "valid_expiring", null],
    ["expiring session", input(), "valid_expiring", null],
    ["non-expiring session", input({ session: { tokenEmpty: false, hasRefreshToken: false } }), "valid_non_expiring", null],
    ["no session", input({ session: null }), "no_session", null],
    ["no data at all is unknown, not a problem", input({ install: null, session: null, migration: null }), "no_session", null],
  ];
  it.each(cases)("%s", (_n, inp, status, reason) => {
    const r = deriveConnectionStatus(inp);
    expect(r.status).toBe(status);
    expect(r.reason).toBe(reason);
  });

  it("an unknown connectionState value is ignored, not trusted", () => {
    expect(deriveConnectionStatus(input({ install: { connectionState: "bogus" } })).status).toBe("valid_expiring");
  });

  it("every status is reachable and listed in the order array", () => {
    const seen = new Set(cases.map((c) => c[2]));
    for (const s of CONNECTION_STATUS_ORDER) expect(seen.has(s), s).toBe(true);
  });

  it("webhooksPaused follows the recorded block only", () => {
    expect(deriveConnectionStatus(input({ install: { connectionState: "needs_reauth", droppedWebhookCount: 4, resyncRequiredSince: day(1) } }))).toMatchObject({
      webhooksPaused: true, droppedWebhookCount: 4, resyncRequiredSince: day(1),
    });
    expect(deriveConnectionStatus(input({ session: { ...okSession, tokenEmpty: true } })).webhooksPaused).toBe(false);
  });
});

describe("presumedUninstalled", () => {
  const blocked = (over = {}) => ({ connectionState: "needs_reauth", connectionStateSince: day(31), ...over });
  it("needs 30 days of block with no webhook and no visit since", () => {
    expect(isPresumedUninstalled(blocked(), NOW)).toBe(true);
    expect(isPresumedUninstalled(blocked({ connectionStateSince: day(29) }), NOW)).toBe(false);
  });
  it("is 7 days for a 404", () => {
    expect(isPresumedUninstalled(blocked({ connectionState: "shop_not_found", connectionStateSince: day(8) }), NOW)).toBe(true);
    expect(isPresumedUninstalled(blocked({ connectionState: "shop_not_found", connectionStateSince: day(6) }), NOW)).toBe(false);
  });
  it.each(["lastWebhookAt", "lastActivityAt", "lastAuthAt"])("a %s since the block start defeats it", (k) => {
    expect(isPresumedUninstalled(blocked({ [k]: day(2) }), NOW)).toBe(false);
    expect(isPresumedUninstalled(blocked({ [k]: day(40) }), NOW)).toBe(true);
  });
  it("is never true without a block, without a start, or once uninstalled", () => {
    expect(isPresumedUninstalled({}, NOW)).toBe(false);
    expect(isPresumedUninstalled(null, NOW)).toBe(false);
    expect(isPresumedUninstalled({ connectionState: "needs_reauth" }, NOW)).toBe(false);
    expect(isPresumedUninstalled(blocked({ uninstalledAt: day(5) }), NOW)).toBe(false);
  });
  it("is part of the derived result", () => {
    expect(deriveConnectionStatus(input({ install: blocked() })).presumedUninstalled).toBe(true);
  });
});

describe("webhooksAfterUninstall", () => {
  it("needs a webhook more than 5 minutes after uninstalledAt", () => {
    const u = day(3);
    expect(hasWebhookAfterUninstall({ uninstalledAt: u, lastWebhookAt: new Date(u.getTime() + 4 * 60_000) })).toBe(false);
    expect(hasWebhookAfterUninstall({ uninstalledAt: u, lastWebhookAt: new Date(u.getTime() + 6 * 60_000) })).toBe(true);
    expect(hasWebhookAfterUninstall({ uninstalledAt: u, lastWebhookAt: null })).toBe(false);
    expect(hasWebhookAfterUninstall({ lastWebhookAt: day(1) })).toBe(false);
  });
});

describe("serialised dates (loader data reaches the client as ISO strings)", () => {
  const iso = (d: Date) => d.toISOString();
  it("reads every timestamp from ISO strings and epoch numbers", () => {
    const install = {
      connectionState: "needs_reauth",
      connectionStateSince: iso(day(31)),
      lastWebhookAt: iso(day(40)),
    };
    expect(isPresumedUninstalled(install, iso(NOW))).toBe(true);
    expect(isPresumedUninstalled({ ...install, lastWebhookAt: iso(day(2)) }, iso(NOW))).toBe(false);
    expect(isPresumedUninstalled({ ...install, connectionStateSince: day(31).getTime() }, NOW.getTime())).toBe(true);
    expect(hasWebhookAfterUninstall({ uninstalledAt: iso(day(3)), lastWebhookAt: iso(day(1)) })).toBe(true);
    expect(deriveConnectionStatus(input({ now: iso(NOW), install: { uninstalledAt: iso(day(2)) } })).status).toBe("uninstalled");
    expect(
      deriveConnectionStatus(input({ now: iso(NOW), session: { ...okSession, refreshTokenExpires: iso(day(1)) } })),
    ).toMatchObject({ status: "needs_reauth", reason: "refresh_token_expired" });
  });
  it("an unparseable value is unknown, not evidence", () => {
    expect(deriveConnectionStatus(input({ install: { uninstalledAt: "garbage" } })).status).toBe("valid_expiring");
    expect(isPresumedUninstalled({ connectionState: "needs_reauth", connectionStateSince: "garbage" }, NOW)).toBe(false);
  });
});
