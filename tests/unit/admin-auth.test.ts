// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createCookie } from "react-router";
import { createHash } from "node:crypto";

const logged: Array<{ level: string; msg: string; meta: unknown }> = [];
vi.mock("~/utils/logger.server", () => ({
  logger: {
    info: (msg: string, meta?: unknown) => logged.push({ level: "info", msg, meta }),
    warn: (msg: string, meta?: unknown) => logged.push({ level: "warn", msg, meta }),
    error: (msg: string, meta?: unknown) => logged.push({ level: "error", msg, meta }),
    debug: () => {},
  },
}));

const auditRow = {
  id: "a1",
  shop: "x.myshopify.com",
  requestType: "customers/data_request",
  status: "completed",
  customerEmail: "customer@example.com",
  error: null,
  dataExported: '{"secret":"export-payload"}',
  webhookId: "w-1234567890",
  requestedAt: new Date("2026-01-01T00:00:00Z"),
  completedAt: new Date("2026-01-01T00:00:01Z"),
};
vi.mock("~/db.server", () => ({
  db: {
    offlineTokenMigration: { findMany: vi.fn(async () => []) },
    webhookLog: { groupBy: vi.fn(async () => []) },
    webhookRetry: { groupBy: vi.fn(async () => []) },
    imageOperationCounter: { findMany: vi.fn(async () => []) },
    managedAiGlobalCounter: { findMany: vi.fn(async () => []) },
    shopInstallState: { findMany: vi.fn(async () => []) },
    aISettings: { findMany: vi.fn(async () => []) },
    product: { groupBy: vi.fn(async () => []) },
    collection: { groupBy: vi.fn(async () => []) },
    article: { groupBy: vi.fn(async () => []) },
    page: { groupBy: vi.fn(async () => []) },
    task: { groupBy: vi.fn(async () => []) },
    $queryRaw: vi.fn(async () => []),
    gdprAuditLog: {
      // Mimic `select`: only the selected columns come back.
      findMany: vi.fn(async (args: { select: Record<string, boolean> }) =>
        [auditRow].map((r) =>
          Object.fromEntries(Object.entries(r).filter(([k]) => args.select[k])),
        ),
      ),
      findUnique: vi.fn(async () => auditRow),
    },
  },
}));
vi.mock("~/services/gdpr.service", () => ({ redactShopData: vi.fn() }));

import * as route from "../../app/routes/admin";
import {
  deriveAdminCookieSecret,
  isAdminAuthenticated,
  serializeAdminSession,
  ADMIN_SESSION_MAX_AGE_MS,
  applyDocumentSecurityHeaders,
} from "../../app/utils/admin-auth.server";

const PW = "a-sufficiently-long-password";
const SECRET = "api-secret";

function cookieHeader(setCookie: string) {
  return setCookie.split(";")[0];
}
function req(url: string, init: RequestInit = {}) {
  return new Request(`https://admin.test${url}`, init);
}
async function sessionCookie(iat = Date.now()) {
  return cookieHeader(await serializeAdminSession(iat));
}

beforeEach(() => {
  process.env.ADMIN_PASSWORD = PW;
  process.env.SHOPIFY_API_SECRET = SECRET;
  logged.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

describe("admin cookie", () => {
  it("accepts a fresh cookie signed with the derived secret", async () => {
    const c = await sessionCookie();
    expect(await isAdminAuthenticated(req("/admin", { headers: { Cookie: c } }))).toBe(true);
  });

  it("never uses the bare password as secret", () => {
    expect(deriveAdminCookieSecret()).not.toBe(PW);
    expect(deriveAdminCookieSecret()).toBe(
      createHash("sha256").update(SECRET + "\0admin-cookie\0" + PW).digest("hex"),
    );
  });

  it("rejects a cookie signed with the bare password", async () => {
    const legacy = createCookie("cp_admin", { secrets: [PW], path: "/" });
    const c = cookieHeader(await legacy.serialize({ iat: Date.now() }));
    expect(await isAdminAuthenticated(req("/admin", { headers: { Cookie: c } }))).toBe(false);
    const legacyOk = cookieHeader(await legacy.serialize("ok"));
    expect(await isAdminAuthenticated(req("/admin", { headers: { Cookie: legacyOk } }))).toBe(false);
  });

  it("rejects a cookie older than 8 hours, even though the signature is valid", async () => {
    const c = await sessionCookie(Date.now() - ADMIN_SESSION_MAX_AGE_MS - 1000);
    expect(await isAdminAuthenticated(req("/admin", { headers: { Cookie: c } }))).toBe(false);
  });

  it("is invalidated by a password change", async () => {
    const c = await sessionCookie();
    process.env.ADMIN_PASSWORD = "another-long-password-1";
    expect(await isAdminAuthenticated(req("/admin", { headers: { Cookie: c } }))).toBe(false);
  });

  it("keeps the page locked for a password under 16 characters", async () => {
    const c = await sessionCookie();
    process.env.ADMIN_PASSWORD = "short-pw-15-char"; // 16 -> ok
    expect(process.env.ADMIN_PASSWORD.length).toBe(16);
    process.env.ADMIN_PASSWORD = "short-pw-15-cha"; // 15
    expect(await isAdminAuthenticated(req("/admin", { headers: { Cookie: c } }))).toBe(false);
    const res = await route.loader({ request: req("/admin"), params: {}, context: {} } as never);
    const body = (res as unknown as { data: Record<string, unknown> }).data;
    expect(body).toMatchObject({ authed: false, configured: false, tooShort: true });
    const form = new FormData();
    form.set("intent", "login");
    form.set("password", "short-pw-15-cha");
    const r = await route.action({
      request: req("/admin", { method: "POST", body: form }),
      params: {},
      context: {},
    } as never);
    expect((r as unknown as { init: { status: number } }).init.status).toBe(503);
  });
});

describe("admin headers and login", () => {
  const expected = {
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "frame-ancestors 'none'",
    "X-Robots-Tag": "noindex, nofollow",
    "Referrer-Policy": "same-origin",
  };

  it("exports the four headers", () => {
    expect(route.headers()).toMatchObject(expected);
  });

  it("sets them on the login form response, a failed login and a redirect", async () => {
    const loginForm = await route.loader({ request: req("/admin"), params: {}, context: {} } as never);
    const h1 = (loginForm as unknown as { init: { headers: Record<string, string> } }).init.headers;
    expect(h1).toMatchObject(expected);

    const bad = new FormData();
    bad.set("intent", "login");
    bad.set("password", "wrong");
    const failed = await route.action({
      request: req("/admin", { method: "POST", body: bad, headers: { "x-forwarded-for": "9.9.9.9" } }),
      params: {},
      context: {},
    } as never);
    expect((failed as unknown as { init: { headers: Record<string, string> } }).init.headers).toMatchObject(expected);

    const good = new FormData();
    good.set("intent", "login");
    good.set("password", PW);
    const ok = (await route.action({
      request: req("/admin", { method: "POST", body: good, headers: { "x-forwarded-for": "8.8.8.8" } }),
      params: {},
      context: {},
    } as never)) as Response;
    for (const [k, v] of Object.entries(expected)) expect(ok.headers.get(k)).toBe(v);
    expect(ok.headers.get("Set-Cookie")).toContain("cp_admin=");
  });

  it("logs a successful login with the IP and without the password", async () => {
    const good = new FormData();
    good.set("intent", "login");
    good.set("password", PW);
    await route.action({
      request: req("/admin", { method: "POST", body: good, headers: { "x-forwarded-for": "7.7.7.7" } }),
      params: {},
      context: {},
    } as never);
    const entry = logged.find((l) => l.level === "info" && /Anmeldung/.test(l.msg));
    expect(entry).toBeTruthy();
    expect(JSON.stringify(entry)).toContain("7.7.7.7");
    expect(JSON.stringify(logged)).not.toContain(PW);
  });
});

describe("GDPR area on demand", () => {
  it("does not put customer e-mail or export into the page's loader output", async () => {
    const c = await sessionCookie();
    const res = await route.loader({
      request: req("/admin", { headers: { Cookie: c } }),
      params: {},
      context: {},
    } as never);
    const text = JSON.stringify((res as unknown as { data: unknown }).data);
    expect(text).toContain("customers/data_request");
    expect(text).not.toContain("customer@example.com");
    expect(text).not.toContain("export-payload");
  });

  it("returns the detail only on click with a valid cookie", async () => {
    const c = await sessionCookie();
    const res = await route.loader({
      request: req("/admin?audit=a1", { headers: { Cookie: c } }),
      params: {},
      context: {},
    } as never);
    const text = JSON.stringify((res as unknown as { data: unknown }).data);
    expect(text).toContain("customer@example.com");
    expect(text).toContain("export-payload");
  });

  it("refuses the on-demand request without a valid admin cookie", async () => {
    const none = await route.loader({ request: req("/admin?audit=a1"), params: {}, context: {} } as never);
    expect((none as unknown as { init: { status: number } }).init.status).toBe(401);
    const old = await sessionCookie(Date.now() - ADMIN_SESSION_MAX_AGE_MS - 1000);
    const expired = await route.loader({
      request: req("/admin?audit=a1", { headers: { Cookie: old } }),
      params: {},
      context: {},
    } as never);
    expect((expired as unknown as { init: { status: number } }).init.status).toBe(401);
    expect(JSON.stringify((expired as unknown as { data: unknown }).data)).not.toContain("customer@example.com");
  });
});

describe("document headers (entry path)", () => {
  // Stand-in for Shopify's helper: frames allowed for the ?shop= store.
  const embedded = (r: Request, h: Headers) => {
    const shop = new URL(r.url).searchParams.get("shop");
    h.set("Content-Security-Policy", `frame-ancestors https://${shop} https://admin.shopify.com;`);
  };

  it("keeps the admin headers on /admin and /admin.data even with ?shop=", () => {
    for (const path of ["/admin?shop=evil.myshopify.com", "/Admin?shop=evil.myshopify.com", "/admin/?shop=evil.myshopify.com", "/ADMIN/?shop=evil.myshopify.com"]) {
      const h = new Headers(route.headers());
      applyDocumentSecurityHeaders(req(path), h, embedded, true);
      expect(h.get("X-Frame-Options")).toBe("DENY");
      expect(h.get("Content-Security-Policy")).toBe("frame-ancestors 'none'");
      expect(h.get("Referrer-Policy")).toBe("same-origin");
      expect(h.get("X-Content-Type-Options")).toBe("nosniff");
    }
  });

  it("sets the admin headers itself, and follows the matched route over the path", () => {
    const h = new Headers();
    applyDocumentSecurityHeaders(req("/something-else?shop=a.myshopify.com"), h, embedded, false, true);
    expect(h.get("X-Frame-Options")).toBe("DENY");
    expect(h.get("Content-Security-Policy")).toBe("frame-ancestors 'none'");
    expect(h.get("Cache-Control")).toBe("no-store");
    expect(h.get("X-Robots-Tag")).toBe("noindex, nofollow");
  });

  it("still applies the embedded-app headers to other routes, including look-alike paths", () => {
    for (const path of ["/app?shop=a.myshopify.com", "/admin/x?shop=a.myshopify.com", "/administrator"]) {
      const h = new Headers();
      applyDocumentSecurityHeaders(req(path), h, embedded, false);
      expect(h.get("X-Frame-Options")).toBe("SAMEORIGIN");
      expect(h.get("Content-Security-Policy")).toContain("admin.shopify.com");
    }
  });
});

describe("route headers() through React Router's request handler", () => {
  async function handle(path: string, init: RequestInit = {}) {
    const { createRequestHandler } = await import("react-router");
    const Noop = () => null;
    const build = {
      entry: {
        module: {
          default: (_r: Request, status: number, headers: Headers) =>
            new Response("<html></html>", { status, headers }),
        },
      },
      routes: {
        root: { id: "root", path: "", module: { default: Noop } },
        "routes/admin": {
          id: "routes/admin",
          parentId: "root",
          path: "admin",
          module: {
            default: Noop,
            loader: route.loader,
            action: route.action,
            headers: route.headers,
            ErrorBoundary: route.ErrorBoundary,
          },
        },
      },
      assets: { routes: {}, entry: { imports: [], module: "" }, url: "", version: "" },
      future: {},
      ssr: true,
      isSpaMode: false,
      publicPath: "/",
      assetsBuildDirectory: "build/client",
      basename: "/",
      routeDiscovery: { mode: "initial" },
    };
    return createRequestHandler(build as never, "production")(req(path, init));
  }

  it("delivers no-store and the security headers on the page and on the audit data response", async () => {
    const c = await sessionCookie();
    const page = await handle("/admin", { headers: { Cookie: c, "Sec-Fetch-Dest": "document" } });
    expect(page.headers.get("Cache-Control")).toBe("no-store");
    expect(page.headers.get("X-Frame-Options")).toBe("DENY");
    const audit = await handle("/admin.data?audit=a1", { headers: { Cookie: c } });
    expect(audit.headers.get("Cache-Control")).toBe("no-store");
    expect(audit.headers.get("X-Frame-Options")).toBe("DENY");
    expect(audit.headers.get("Content-Security-Policy")).toBe("frame-ancestors 'none'");
  });

  it("passes Retry-After of a locked-out login through", async () => {
    const { adminLoginLimiter } = await import("../../app/utils/admin-login-limiter.server");
    const spy = vi
      .spyOn(adminLoginLimiter, "check")
      .mockReturnValue({ allowed: false, retryAfterSec: 120 });
    const form = new FormData();
    form.set("intent", "login");
    form.set("password", "x");
    const res = await handle("/admin", {
      method: "POST",
      body: form,
      headers: { "x-forwarded-for": "6.6.6.6" },
    });
    expect(res.headers.get("Retry-After")).toBe("120");
    expect(res.headers.get("Cache-Control")).toBe("no-store");

    // The same refusal as a .data action POST (what the login form sends).
    const data = await handle("/admin.data", {
      method: "POST",
      body: form,
      headers: { "x-forwarded-for": "6.6.6.6" },
    });
    expect(data.headers.get("Retry-After")).toBe("120");
    expect(data.headers.get("Cache-Control")).toBe("no-store");
    spy.mockRestore();
  });

  it("exports an ErrorBoundary", () => {
    expect(typeof route.ErrorBoundary).toBe("function");
  });
});

describe("locked states and audit document request", () => {
  it("stays locked without SHOPIFY_API_SECRET", async () => {
    const c = await sessionCookie();
    delete process.env.SHOPIFY_API_SECRET;
    expect(deriveAdminCookieSecret()).toBeNull();
    expect(await isAdminAuthenticated(req("/admin", { headers: { Cookie: c } }))).toBe(false);
    const res = await route.loader({ request: req("/admin"), params: {}, context: {} } as never);
    expect((res as unknown as { data: unknown }).data).toMatchObject({ authed: false, noSecret: true });
  });

  it("redirects a document request to ?audit= back to /admin, without detail", async () => {
    const c = await sessionCookie();
    const res = (await route.loader({
      request: req("/admin?audit=a1", { headers: { Cookie: c, "Sec-Fetch-Dest": "document" } }),
      params: {},
      context: {},
    } as never)) as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/admin");
  });
});
