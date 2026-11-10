// @vitest-environment node
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import {
  ADMIN_SECURITY_HEADERS,
  applyDocumentSecurityHeaders,
} from "~/utils/admin-auth.server";

const require = createRequire(import.meta.url);
const { serverReferrerPolicy } = require("../../app/middleware/referrer-policy.cjs");

describe("Referrer-Policy on /admin", () => {
  it("server.js sets nothing for /admin (any case, slash, data request)", () => {
    for (const p of ["/admin", "/Admin/", "/admin.data"]) expect(serverReferrerPolicy(p)).toBeNull();
  });

  it("server.js keeps strict-origin-when-cross-origin for /app and the rest", () => {
    for (const p of ["/app", "/app/products", "/", "/administrator"]) {
      expect(serverReferrerPolicy(p)).toBe("strict-origin-when-cross-origin");
    }
  });

  it("the admin document carries exactly no-referrer; /app keeps the strict one", () => {
    const admin = new Headers();
    applyDocumentSecurityHeaders(new Request("https://x.test/admin"), admin, () => {}, true);
    expect(admin.get("Referrer-Policy")).toBe("no-referrer");
    expect(ADMIN_SECURITY_HEADERS["Referrer-Policy"]).toBe("no-referrer");
    const app = new Headers();
    applyDocumentSecurityHeaders(new Request("https://x.test/app"), app, () => {}, true);
    expect(app.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
  });

  it("server.js asks the helper instead of setting the header unconditionally", () => {
    const src = readFileSync("server.js", "utf8");
    expect(src).toContain("serverReferrerPolicy(req.path)");
    expect(src).not.toMatch(/res\.setHeader\('Referrer-Policy', 'strict-origin/);
  });
});
