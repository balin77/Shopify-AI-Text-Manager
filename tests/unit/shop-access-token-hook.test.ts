/**
 * The root-JS workers' token lookup (app/utils/shop-access-token.js): the app's
 * refreshed offline token when the bundle registered its hook, the old direct
 * read otherwise.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { resolveShopAccessToken } from "../../app/utils/shop-access-token.js";

const SHOP = "test-shop.myshopify.com";

function db(row: unknown) {
  return { session: { findFirst: vi.fn(async () => row) } };
}

afterEach(() => {
  delete (globalThis as { __getShopAccessToken?: unknown }).__getShopAccessToken;
});

describe("resolveShopAccessToken", () => {
  it("uses the app hook when present and never reads the DB", async () => {
    globalThis.__getShopAccessToken = vi.fn(async () => "from-app");
    const d = db({ accessToken: "enc" });
    const res = await resolveShopAccessToken(SHOP, { db: d, decryptToken: () => "x" });
    expect(res).toEqual({ token: "from-app", source: "app" });
    expect(d.session.findFirst).not.toHaveBeenCalled();
  });

  it("reports the hook's failure instead of falling back to a stored (possibly dead) token", async () => {
    globalThis.__getShopAccessToken = vi.fn(async () => {
      throw new Error("refresh failed");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const d = db({ accessToken: "enc" });
    const res = await resolveShopAccessToken(SHOP, { db: d, decryptToken: () => "x" });
    expect(res.token).toBeNull();
    expect(d.session.findFirst).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("falls back to the direct offline-session read without the hook (old behaviour)", async () => {
    const d = db({ accessToken: "enc" });
    const res = await resolveShopAccessToken(SHOP, { db: d, decryptToken: () => "plain" });
    expect(res).toEqual({ token: "plain", source: "db" });
    expect(d.session.findFirst).toHaveBeenCalledWith({
      where: { shop: SHOP, isOnline: false },
      orderBy: { lastActivityAt: "desc" },
    });
  });

  it("refuses an expired stored token in the fallback", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const d = db({ accessToken: "enc", expires: new Date(Date.now() - 1000) });
    const res = await resolveShopAccessToken(SHOP, { db: d, decryptToken: () => "plain" });
    expect(res.token).toBeNull();
    warn.mockRestore();
  });

  it("reports a missing session and a failed decrypt", async () => {
    expect((await resolveShopAccessToken(SHOP, { db: db(null), decryptToken: () => "x" })).token).toBeNull();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await resolveShopAccessToken(SHOP, {
      db: db({ accessToken: "enc" }),
      decryptToken: () => {
        throw new Error("bad key");
      },
    });
    expect(res).toEqual({ token: null, reason: "Failed to decrypt session access token" });
    warn.mockRestore();
  });
});
