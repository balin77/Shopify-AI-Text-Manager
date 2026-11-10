// @vitest-environment node
/**
 * The /admin "Als deinstalliert markieren" action and its detail evidence:
 * gated by the admin cookie, same-origin, typed confirmation, and a server-side
 * re-read of the facts (the client's view counts for nothing).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  install: [] as Array<Record<string, any>>,
  sessions: [] as Array<Record<string, any>>,
  migrations: [] as Array<Record<string, any>>,
  mark: vi.fn(async (..._a: any[]) => true),
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
    $queryRaw: vi.fn(async () => []),
  };
  return { db, default: db };
});
vi.mock("~/services/shop-uninstall.server", () => ({
  markShopUninstalled: (...a: any[]) => h.mark(...a),
}));
vi.mock("~/services/gdpr.service", () => ({ redactShopData: vi.fn() }));

import { logger } from "~/utils/logger.server";
import * as route from "../../app/routes/admin";
import { serializeAdminSession } from "../../app/utils/admin-auth.server";
import { uninstallReviewView, reviewStaleInstall } from "~/services/stale-install.server";

const DAY = 86_400_000;
const NOW = new Date("2026-11-15T12:00:00Z");
const ago = (d: number) => new Date(NOW.getTime() - d * DAY);
const SHOP = "demo-shop.myshopify.com";

function install(over: Record<string, any> = {}) {
  h.install.push({
    shop: SHOP, uninstalledAt: null, connectionState: "needs_reauth", connectionStateSince: ago(45),
    connectionStateReason: "no_token", lastWebhookAt: ago(60), lastActivityAt: null, lastAuthAt: null,
    lastApiOkAt: null, reinstallEvidenceAt: null, ...over,
  });
}

async function post(fields: Record<string, string>, opts: { auth?: boolean; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.auth !== false) headers.Cookie = (await serializeAdminSession(Date.now())).split(";")[0];
  const request = new Request("https://admin.test/admin", {
    method: "POST",
    headers,
    body: new URLSearchParams(fields),
  });
  const res = (await route.action({ request, params: {}, context: {} } as never)) as any;
  // react-router `data()` results carry status and data
  return { status: res.init?.status ?? res.status ?? 200, body: res.data ?? res };
}
const good = { intent: "mark-uninstalled", shop: SHOP, confirm: SHOP };

beforeEach(() => {
  process.env.ADMIN_PASSWORD = "a-sufficiently-long-password";
  process.env.SHOPIFY_API_SECRET = "api-secret";
  h.install.length = 0;
  h.sessions.length = 0;
  h.migrations.length = 0;
  vi.clearAllMocks();
  h.mark.mockResolvedValue(true);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe("mark-uninstalled action", () => {
  it("refuses an unauthenticated caller", async () => {
    install();
    const r = await post(good, { auth: false });
    expect(r.status).toBe(401);
    expect(h.mark).not.toHaveBeenCalled();
  });

  it("refuses a foreign origin", async () => {
    install();
    const a = await post(good, { headers: { "Sec-Fetch-Site": "cross-site" } });
    expect(a.status).toBe(403);
    const b = await post(good, { headers: { Origin: "https://evil.example" } });
    expect(b.status).toBe(403);
    expect(h.mark).not.toHaveBeenCalled();
  });

  it("refuses a malformed shop domain", async () => {
    const r = await post({ ...good, shop: "evil.example.com", confirm: "evil.example.com" });
    expect(r.status).toBe(400);
    expect(h.mark).not.toHaveBeenCalled();
  });

  it("refuses a wrong or missing confirmation", async () => {
    install();
    expect((await post({ ...good, confirm: "demo-shop" })).status).toBe(400);
    expect((await post({ ...good, confirm: "" })).status).toBe(400);
    expect(h.mark).not.toHaveBeenCalled();
  });

  it("re-reads server-side: a shop without evidence is refused whatever the client claims", async () => {
    install({ lastWebhookAt: ago(2) });
    const r = await post(good, { headers: { "Sec-Fetch-Site": "same-origin" } });
    expect(r.status).toBe(409);
    expect(r.body.error).toContain("Kein Nachweis");
    expect(h.mark).not.toHaveBeenCalled();
  });

  it("refuses unknown and already uninstalled shops", async () => {
    expect((await post(good)).status).toBe(409);
    install({ uninstalledAt: ago(3) });
    expect((await post(good)).status).toBe(409);
    expect(h.mark).not.toHaveBeenCalled();
  });

  it("refuses a shop whose session still holds a token (no force here)", async () => {
    install();
    h.sessions.push({ shop: SHOP, isOnline: false, accessToken: "SECRET-TOKEN-VALUE", refreshToken: null });
    const r = await post({ ...good, forceWithToken: "true", force: "1" });
    expect(r.status).toBe(409);
    expect(r.body.error).toContain("--force-with-token");
    expect(JSON.stringify(r.body)).not.toContain("SECRET-TOKEN-VALUE");
    expect(h.mark).not.toHaveBeenCalled();
  });

  it("reports a state that changed between review and write", async () => {
    install();
    h.mark.mockResolvedValueOnce(false);
    const r = await post(good);
    expect(r.status).toBe(409);
    expect(r.body.error).toContain("geändert");
  });

  it("success: marks once as operator, conditional on the reviewed block, and logs without a token", async () => {
    install();
    h.sessions.push({ shop: SHOP, isOnline: false, accessToken: "", refreshToken: null });
    const r = await post(good, { headers: { "Sec-Fetch-Site": "same-origin" } });
    expect(r.status).toBe(200);
    expect(r.body.ok).toContain(SHOP);
    expect(h.mark).toHaveBeenCalledTimes(1);
    expect(h.mark).toHaveBeenCalledWith(SHOP, { source: "operator", ifBlockedSince: expect.any(Date), failure: {} });
    const lines = (logger.info as any).mock.calls.map((c: any[]) => String(c[0]));
    expect(lines.some((l: string) => l.includes("OPERATOR_MARKED_UNINSTALLED") && l.includes("via=admin_ui"))).toBe(true);
  });
});

describe("mark-uninstalled: database error and delete-shop hardening", () => {
  it("a database error is its own answer, not 'state changed'", async () => {
    install();
    h.mark.mockImplementationOnce(async (_s: string, o: any) => {
      o.failure.reason = "error";
      return false;
    });
    const r = await post(good);
    expect(r.status).toBe(500);
    expect(r.body.error).toContain("Fehler beim Speichern");
  });

  it("delete-shop: foreign origin, malformed domain and raw errors are refused or hidden", async () => {
    const del = { intent: "delete-shop", shop: SHOP, confirm: SHOP };
    expect((await post(del, { headers: { "Sec-Fetch-Site": "cross-site" } })).status).toBe(403);
    expect((await post({ ...del, shop: "x.example.com", confirm: "x.example.com" })).status).toBe(400);
    const gdpr = await import("~/services/gdpr.service");
    (gdpr.redactShopData as any).mockRejectedValueOnce(new Error("SECRET-DB-DETAIL"));
    const r = await post(del);
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.body)).not.toContain("SECRET-DB-DETAIL");
  });
});

describe("uninstall review view", () => {
  it("is eligible with evidence, carries flags and no token", async () => {
    install();
    h.sessions.push({ shop: SHOP, isOnline: false, accessToken: "", refreshToken: "REFRESH-SECRET" });
    const view = uninstallReviewView(await reviewStaleInstall(SHOP, NOW));
    expect(view.eligible).toBe(true);
    expect(view.evidence?.hasToken).toBe(false);
    expect(view.evidence?.hasRefreshToken).toBe(true);
    expect(JSON.stringify(view)).not.toContain("REFRESH-SECRET");
  });

  it("states the reason when not eligible", async () => {
    install({ lastApiOkAt: ago(1) });
    expect(uninstallReviewView(await reviewStaleInstall(SHOP, NOW))).toMatchObject({ eligible: false, refusal: "no_evidence" });
    h.sessions.push({ shop: SHOP, isOnline: false, accessToken: "tok" });
    h.install.length = 0;
    install();
    expect(uninstallReviewView(await reviewStaleInstall(SHOP, NOW)).refusal).toBe("token_present");
    h.install.length = 0;
    expect(uninstallReviewView(await reviewStaleInstall(SHOP, NOW)).refusal).toBe("unknown_shop");
  });
});
