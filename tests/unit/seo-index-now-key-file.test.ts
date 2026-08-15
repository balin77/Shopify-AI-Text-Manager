import { describe, it, expect, vi } from "vitest";
import { keyFilePath, ensureKeyRedirect, removeKeyRedirect } from "~/services/seo/index-now-key-file.server";

/**
 * The URL redirect that puts the IndexNow key at the storefront ROOT.
 *
 * Measured on a live shop: a key served from the app-proxy sub-path is fetched
 * fine but every submission is rejected with 422 "not related to your site
 * verified through the keylocation parameter" — a non-root key verifies only
 * its own sub-path. These tests pin the echo rule for the redirect that fixes
 * it: an id is stored only when Shopify echoes back the redirect we asked for,
 * and cleared only when a delete is confirmed.
 */

const PATH = "/abc.txt";
const TARGET = "/apps/contentpilot/indexnow-key";

/** Routes each mutation/query to a canned response body. */
function makeAdmin(handlers: Record<string, unknown>) {
  const graphql = vi.fn(async (query: string) => {
    const kind = query.includes("urlRedirectCreate")
      ? "create"
      : query.includes("urlRedirectUpdate")
        ? "update"
        : query.includes("urlRedirectDelete")
          ? "delete"
          : "query";
    return { json: async () => handlers[kind] ?? {} };
  });
  return { admin: { graphql } as any, graphql };
}

function makeDb() {
  const updateMany = vi.fn(async (_args: any) => ({ count: 1 }));
  const findUnique = vi.fn(async () => null);
  return { db: { seoIndexNowConfig: { updateMany, findUnique } } as any, updateMany };
}

describe("keyFilePath", () => {
  it("is the key as a root-level .txt file", () => {
    expect(keyFilePath("abc")).toBe("/abc.txt");
  });
});

describe("ensureKeyRedirect", () => {
  it("creates the redirect and stores the id Shopify echoed back", async () => {
    const { admin } = makeAdmin({
      create: {
        data: { urlRedirectCreate: { urlRedirect: { id: "gid://shopify/UrlRedirect/1", path: PATH, target: TARGET }, userErrors: [] } },
      },
    });
    const { db, updateMany } = makeDb();

    const res = await ensureKeyRedirect(admin, db, "s.myshopify.com", { key: "abc", keyRedirectId: null });
    expect(res).toEqual({ ok: true, redirectId: "gid://shopify/UrlRedirect/1" });
    expect(updateMany.mock.calls[0][0].data).toEqual({ keyRedirectId: "gid://shopify/UrlRedirect/1" });
  });

  it("does NOT store an id when Shopify returns userErrors and no redirect", async () => {
    const { admin } = makeAdmin({
      create: { data: { urlRedirectCreate: { urlRedirect: null, userErrors: [{ message: "Something failed" }] } } },
      query: { data: { urlRedirects: { edges: [] } } },
    });
    const { db, updateMany } = makeDb();

    const res = await ensureKeyRedirect(admin, db, "s.myshopify.com", { key: "abc", keyRedirectId: null });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("Something failed");
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("does NOT store an id when the echo does not match what we asked for", async () => {
    // Shopify answered, but for a different path — treating that as success
    // would record an id pointing at a redirect that is not ours.
    const { admin } = makeAdmin({
      create: { data: { urlRedirectCreate: { urlRedirect: { id: "gid://1", path: "/other.txt", target: TARGET }, userErrors: [] } } },
      query: { data: { urlRedirects: { edges: [] } } },
    });
    const { db, updateMany } = makeDb();

    const res = await ensureKeyRedirect(admin, db, "s.myshopify.com", { key: "abc", keyRedirectId: null });
    expect(res.ok).toBe(false);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("adopts a redirect that already occupies the path and repoints it", async () => {
    const { admin } = makeAdmin({
      create: { data: { urlRedirectCreate: { urlRedirect: null, userErrors: [{ message: "Path has already been taken" }] } } },
      query: { data: { urlRedirects: { edges: [{ node: { id: "gid://existing", path: PATH, target: "/somewhere-else" } }] } } },
      update: { data: { urlRedirectUpdate: { urlRedirect: { id: "gid://existing", path: PATH, target: TARGET }, userErrors: [] } } },
    });
    const { db, updateMany } = makeDb();

    const res = await ensureKeyRedirect(admin, db, "s.myshopify.com", { key: "abc", keyRedirectId: null });
    expect(res).toEqual({ ok: true, redirectId: "gid://existing" });
    expect(updateMany).toHaveBeenCalled();
  });

  it("ignores a fuzzy search hit whose path is not exactly ours", async () => {
    const { admin } = makeAdmin({
      create: { data: { urlRedirectCreate: { urlRedirect: null, userErrors: [{ message: "Path has already been taken" }] } } },
      // The redirect search is fuzzy — a near-match must not be repointed.
      query: { data: { urlRedirects: { edges: [{ node: { id: "gid://someone-elses", path: "/abc.txt.bak", target: "/x" } }] } } },
    });
    const { db, updateMany } = makeDb();

    const res = await ensureKeyRedirect(admin, db, "s.myshopify.com", { key: "abc", keyRedirectId: null });
    expect(res.ok).toBe(false);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("recreates the redirect when the stored id no longer updates", async () => {
    const { admin, graphql } = makeAdmin({
      update: { data: { urlRedirectUpdate: { urlRedirect: null, userErrors: [{ message: "Redirect does not exist" }] } } },
      create: { data: { urlRedirectCreate: { urlRedirect: { id: "gid://new", path: PATH, target: TARGET }, userErrors: [] } } },
    });
    const { db } = makeDb();

    const res = await ensureKeyRedirect(admin, db, "s.myshopify.com", { key: "abc", keyRedirectId: "gid://deleted" });
    expect(res).toEqual({ ok: true, redirectId: "gid://new" });
    expect(graphql.mock.calls.some((c) => String(c[0]).includes("urlRedirectCreate"))).toBe(true);
  });

  it("never throws when the Admin API blows up", async () => {
    const admin = { graphql: vi.fn(async () => { throw new Error("network"); }) } as any;
    const { db } = makeDb();
    const res = await ensureKeyRedirect(admin, db, "s.myshopify.com", { key: "abc", keyRedirectId: null });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("network");
  });
});

describe("removeKeyRedirect", () => {
  it("clears the stored id once Shopify confirms the deletion", async () => {
    const { admin } = makeAdmin({
      delete: { data: { urlRedirectDelete: { deletedRedirectId: "gid://1", userErrors: [] } } },
    });
    const { db, updateMany } = makeDb();

    expect(await removeKeyRedirect(admin, db, "s.myshopify.com", "gid://1")).toBe(true);
    expect(updateMany.mock.calls[0][0].data).toEqual({ keyRedirectId: null });
  });

  it("KEEPS the id when the deletion is not confirmed", async () => {
    // Forgetting the id here would orphan a redirect in the merchant's admin
    // that we could never clean up again.
    const { admin } = makeAdmin({
      delete: { data: { urlRedirectDelete: { deletedRedirectId: null, userErrors: [{ message: "nope" }] } } },
    });
    const { db, updateMany } = makeDb();

    expect(await removeKeyRedirect(admin, db, "s.myshopify.com", "gid://1")).toBe(false);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("is a no-op without a stored id", async () => {
    const { admin, graphql } = makeAdmin({});
    const { db } = makeDb();
    expect(await removeKeyRedirect(admin, db, "s.myshopify.com", null)).toBe(true);
    expect(graphql).not.toHaveBeenCalled();
  });
});
