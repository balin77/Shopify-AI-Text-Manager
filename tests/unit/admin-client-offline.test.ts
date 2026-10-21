/**
 * createAdminClientFromShop keeps its public contract (a raw Response on 2xx,
 * a throw otherwise) but no longer keeps a token: it asks offline-admin per
 * call and retries once on a 401 with a forced reload.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  getOfflineAdmin: vi.fn(),
  invalidateOfflineAdmin: vi.fn(),
  findSessionsByShop: vi.fn(async () => []),
}));

vi.mock("~/utils/logger.server", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("~/shopify.server", () => ({
  apiVersion: "2026-07",
  sessionStorage: { findSessionsByShop: h.findSessionsByShop },
}));
vi.mock("~/utils/offline-admin.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/utils/offline-admin.server")>();
  return {
    ...actual,
    getOfflineAdmin: h.getOfflineAdmin,
    invalidateOfflineAdmin: h.invalidateOfflineAdmin,
  };
});

import { createAdminClientFromShop } from "~/utils/admin-client.server";
import { OfflineAdminUnavailableError } from "~/utils/offline-admin.server";

const SHOP = "test-shop.myshopify.com";
const ctx = (token: string) => ({ session: { accessToken: token }, admin: {} });
const fetchMock = vi.fn();

beforeEach(() => {
  h.getOfflineAdmin.mockReset();
  h.invalidateOfflineAdmin.mockReset();
  h.findSessionsByShop.mockReset().mockResolvedValue([]);
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const tokenSent = (call: number) =>
  (fetchMock.mock.calls[call][1] as { headers: Record<string, string> }).headers["X-Shopify-Access-Token"];

describe("createAdminClientFromShop", () => {
  it("re-acquires the token per call through the offline helper", async () => {
    h.getOfflineAdmin.mockResolvedValueOnce(ctx("t0")).mockResolvedValueOnce(ctx("t1")).mockResolvedValueOnce(ctx("t2"));
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    const client = await createAdminClientFromShop(SHOP);
    await client.graphql("q1");
    await client.graphql("q2");
    expect(tokenSent(0)).toBe("t1");
    expect(tokenSent(1)).toBe("t2");
    expect(String(fetchMock.mock.calls[0][0])).toBe(`https://${SHOP}/admin/api/2026-07/graphql.json`);
  });

  it("retries once on 401 with a forced reload", async () => {
    h.getOfflineAdmin.mockResolvedValueOnce(ctx("t0")).mockResolvedValueOnce(ctx("old")).mockResolvedValueOnce(ctx("new"));
    fetchMock
      .mockResolvedValueOnce(new Response("", { status: 401 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const client = await createAdminClientFromShop(SHOP);
    const res = await client.graphql("q");
    expect(res.status).toBe(200);
    expect(tokenSent(0)).toBe("old");
    expect(tokenSent(1)).toBe("new");
    expect(h.invalidateOfflineAdmin).toHaveBeenCalledWith(SHOP);
    expect(h.getOfflineAdmin).toHaveBeenLastCalledWith(SHOP, { forceReload: true });
  });

  it("still throws on a non-2xx (unchanged contract)", async () => {
    h.getOfflineAdmin.mockResolvedValue(ctx("t"));
    fetchMock.mockResolvedValue(new Response("nope", { status: 500, statusText: "Server Error" }));
    const client = await createAdminClientFromShop(SHOP);
    await expect(client.graphql("q")).rejects.toThrow(/500/);
  });

  it("throws 'No session found' eagerly when there is no session at all", async () => {
    h.getOfflineAdmin.mockRejectedValue(new OfflineAdminUnavailableError(SHOP, "no_session", "none"));
    await expect(createAdminClientFromShop(SHOP)).rejects.toThrow(/No session found/);
  });

  it("refuses an invalid shop domain", async () => {
    await expect(createAdminClientFromShop("evil.com")).rejects.toThrow(/Invalid shop domain/);
  });
});
