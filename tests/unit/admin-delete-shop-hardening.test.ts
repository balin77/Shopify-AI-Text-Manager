// @vitest-environment node
/**
 * /admin "Alle Daten löschen": installed-shop refusal with the "trotzdem
 * löschen" override, durable audit row, IP only in the log, generic browser
 * error, strict Origin on the destructive intents, sanitised audit error.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  install: [] as Array<Record<string, any>>,
  sessions: [] as Array<Record<string, any>>,
  audits: [] as Array<Record<string, any>>,
  redact: vi.fn(async (..._a: any[]) => undefined),
  audit: vi.fn(async (..._a: any[]) => undefined),
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
    gdprAuditLog: {
      findUnique: vi.fn(async () => h.audits[0] ?? null),
      findMany: vi.fn(async () => []),
    },
    offlineTokenMigration: fakeDelegate([]),
    $queryRaw: vi.fn(async () => []),
  };
  return { db, default: db };
});
vi.mock("~/services/shop-uninstall.server", () => ({ markShopUninstalled: (...a: any[]) => h.mark(...a) }));
vi.mock("~/services/gdpr.service", () => ({
  redactShopData: (...a: any[]) => h.redact(...a),
  logGDPRRequest: (...a: any[]) => h.audit(...a),
}));

import { logger } from "~/utils/logger.server";
import * as route from "../../app/routes/admin";
import {
  isStrictSameOriginAdminRequest,
  serializeAdminSession,
} from "../../app/utils/admin-auth.server";
import { loadAuditDetail } from "~/services/admin/shop-overview.server";

const SHOP = "demo-shop.myshopify.com";
const DEL = { intent: "delete-shop", shop: SHOP, confirm: SHOP };

async function post(fields: Record<string, string>, headers: Record<string, string> = { Origin: "https://admin.test" }) {
  const hdrs: Record<string, string> = { ...headers };
  hdrs.Cookie = (await serializeAdminSession(Date.now())).split(";")[0];
  const request = new Request("https://admin.test/admin", {
    method: "POST",
    headers: hdrs,
    body: new URLSearchParams(fields),
  });
  const res = (await route.action({ request, params: {}, context: {} } as never)) as any;
  return { status: res.init?.status ?? res.status ?? 200, body: res.data ?? res };
}

beforeEach(() => {
  process.env.ADMIN_PASSWORD = "a-sufficiently-long-password";
  process.env.SHOPIFY_API_SECRET = "api-secret";
  delete process.env.SHOPIFY_APP_URL;
  h.install.length = 0;
  h.sessions.length = 0;
  h.audits.length = 0;
  vi.clearAllMocks();
});
afterEach(() => {
  delete process.env.SHOPIFY_APP_URL;
});

const installed = () => {
  h.install.push({ shop: SHOP, uninstalledAt: null });
  h.sessions.push({ shop: SHOP, isOnline: false, accessToken: "tok" });
};

describe("delete-shop: installed shops", () => {
  it("refuses an installed shop in German and deletes nothing", async () => {
    installed();
    const r = await post(DEL);
    expect(r.status).toBe(409);
    expect(r.body.error).toContain("noch installiert");
    expect(h.redact).not.toHaveBeenCalled();
  });

  it("deletes an installed shop when 'trotzdem löschen' is ticked", async () => {
    installed();
    const r = await post({ ...DEL, force: "on" });
    expect(r.status).toBe(200);
    expect(h.redact).toHaveBeenCalledWith({ shop_id: 0, shop_domain: SHOP });
  });

  it("a blanked token (needs_reauth) still counts as installed", async () => {
    h.install.push({ shop: SHOP, uninstalledAt: null });
    h.sessions.push({ shop: SHOP, isOnline: false, accessToken: "" });
    expect((await post(DEL)).status).toBe(409);
    expect(h.redact).not.toHaveBeenCalled();
  });

  it("deletes without the switch when the shop is marked uninstalled or has no session", async () => {
    h.install.push({ shop: SHOP, uninstalledAt: new Date() });
    h.sessions.push({ shop: SHOP, isOnline: false, accessToken: "tok" });
    expect((await post(DEL)).status).toBe(200);
    h.install.length = 0;
    h.sessions.length = 0;
    h.install.push({ shop: SHOP, uninstalledAt: null });
    expect((await post(DEL)).status).toBe(200);
    expect(h.redact).toHaveBeenCalledTimes(2);
  });
});

describe("delete-shop: audit, IP and error text", () => {
  it("writes an admin_redact audit row and logs the IP, not the row", async () => {
    const r = await post(DEL, { Origin: "https://admin.test", "x-forwarded-for": "198.51.100.7" });
    expect(r.status).toBe(200);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0]).toEqual([SHOP, "admin_redact", null, undefined, undefined, undefined]);
    expect(JSON.stringify(h.audit.mock.calls)).not.toContain("198.51.100.7");
    const lines = (logger.warn as any).mock.calls.map((c: any[]) => String(c[0]));
    expect(lines.some((l: string) => l.includes("198.51.100.7"))).toBe(true);
  });

  it("a failed delete: generic text to the browser, full text in the log and the audit row", async () => {
    h.redact.mockRejectedValueOnce(new Error("SECRET-DB-DETAIL"));
    const r = await post(DEL);
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.body)).not.toContain("SECRET-DB-DETAIL");
    expect(JSON.stringify((logger.error as any).mock.calls)).toContain("SECRET-DB-DETAIL");
    expect(h.audit.mock.calls[0][5]).toBe("SECRET-DB-DETAIL");
  });

  it("an audit write that fails does not turn the finished delete into an error", async () => {
    h.audit.mockRejectedValueOnce(new Error("audit down"));
    expect((await post(DEL)).status).toBe(200);
  });

  it("the stored audit error is sanitised before it reaches the page", async () => {
    h.audits.push({
      id: "a1", shop: SHOP, customerEmail: null, dataExported: null, webhookId: null,
      error: "failed with shpat_abcdef123456 for owner@example.com",
    });
    const d = await loadAuditDetail("a1");
    expect(d?.error).not.toContain("shpat_abcdef123456");
    expect(d?.error).not.toContain("owner@example.com");
  });
});

describe("strict Origin on destructive intents", () => {
  it("delete-shop and mark-uninstalled refuse a missing, foreign or null Origin", async () => {
    for (const intent of ["delete-shop", "mark-uninstalled"]) {
      const f = { intent, shop: SHOP, confirm: SHOP };
      expect((await post(f, {})).status).toBe(403);
      expect((await post(f, { Origin: "https://evil.example" })).status).toBe(403);
      expect((await post(f, { Origin: "null" })).status).toBe(403);
      expect((await post(f, { Origin: "https://admin.test", "Sec-Fetch-Site": "same-site" })).status).toBe(403);
    }
    expect(h.redact).not.toHaveBeenCalled();
    expect(h.mark).not.toHaveBeenCalled();
  });

  it("accepts the app's own origin", async () => {
    expect((await post(DEL, { Origin: "https://admin.test", "Sec-Fetch-Site": "same-origin" })).status).toBe(200);
  });
});

describe("isStrictSameOriginAdminRequest", () => {
  const req = (h: Record<string, string>, url = "http://internal:3000/admin") => new Request(url, { method: "POST", headers: h });

  it("matches SHOPIFY_APP_URL even when the proxy rewrote the request URL", () => {
    process.env.SHOPIFY_APP_URL = "https://app.custom.example";
    expect(isStrictSameOriginAdminRequest(req({ Origin: "https://app.custom.example" }))).toBe(true);
    expect(isStrictSameOriginAdminRequest(req({ Origin: "https://sibling.custom.example" }))).toBe(false);
  });

  it("falls back to the forwarded host without SHOPIFY_APP_URL", () => {
    expect(isStrictSameOriginAdminRequest(req({ Origin: "https://a.example", "X-Forwarded-Host": "a.example" }))).toBe(true);
    expect(isStrictSameOriginAdminRequest(req({ Origin: "https://a.example" }))).toBe(false);
  });

  it("requires an Origin at all", () => {
    expect(isStrictSameOriginAdminRequest(req({ "X-Forwarded-Host": "a.example" }))).toBe(false);
  });
});
