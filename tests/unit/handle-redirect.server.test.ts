/**
 * PLAN_CONTENT_CREATION §Phase 3.3 — the SERVER half of the handle redirect.
 *
 * `handle-redirect.shared.test.ts` covers WHEN a redirect is owed. This file
 * covers what happens once it is: the echo rule, and the one property that
 * matters more than any of it — a redirect failure must never look like a
 * failed save. The content update it accompanies has already happened; a
 * thrown error here would tell the merchant their edit did not land when it
 * did, and invite them to make it a second time.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { applyHandleRedirect } from "~/services/seo/handle-redirect.server";

const createRedirect = vi.fn();
const listRedirects = vi.fn();
const updateRedirect = vi.fn();
const deleteRedirect = vi.fn();
vi.mock("~/services/seo/redirects.service", () => ({
  createRedirect: (...args: unknown[]) => createRedirect(...args),
  listRedirects: (...args: unknown[]) => listRedirects(...args),
  updateRedirect: (...args: unknown[]) => updateRedirect(...args),
  deleteRedirect: (...args: unknown[]) => deleteRedirect(...args),
}));

const admin = {} as never;
const change = {
  resource: "product" as const,
  previousHandle: "old",
  nextHandle: "new",
  wanted: true,
};

beforeEach(() => {
  createRedirect.mockReset();
  listRedirects.mockReset();
  updateRedirect.mockReset();
  deleteRedirect.mockReset();
  // The default shop has no redirects at all — each test that cares says so.
  listRedirects.mockResolvedValue({ redirects: [], hasNextPage: false, endCursor: null });
  updateRedirect.mockResolvedValue({ redirect: { id: "gid://shopify/UrlRedirect/9" }, userErrors: [] });
  deleteRedirect.mockResolvedValue({ deletedId: "gid://shopify/UrlRedirect/9", userErrors: [] });
});

describe("applyHandleRedirect", () => {
  it("creates the redirect and reports it", async () => {
    createRedirect.mockResolvedValue({ redirect: { id: "gid://shopify/UrlRedirect/1" }, userErrors: [] });

    const result = await applyHandleRedirect(admin, "test.myshopify.com", change);

    expect(result.created).toBe(true);
    expect(createRedirect).toHaveBeenCalledWith(admin, { path: "/products/old", target: "/products/new" });
    expect(result.noteCode).toBe("created");
    expect(result.fromPath).toBe("/products/old");
  });

  it("does not call Shopify at all when no redirect is owed", async () => {
    // The decision is made before the call, not inside it — otherwise every
    // save of an unchanged handle would cost a mutation.
    const result = await applyHandleRedirect(admin, "test.myshopify.com", { ...change, nextHandle: "old" });

    expect(createRedirect).not.toHaveBeenCalled();
    expect(result.created).toBe(false);
    expect(result.skippedReason).toBe("unchanged");
  });

  it("treats a missing echo as failure, even with no userErrors", async () => {
    // The repo-wide echo rule: `userErrors: []` is not the answer. Without the
    // returned id, nothing is known to exist.
    createRedirect.mockResolvedValue({ redirect: null, userErrors: [] });

    const result = await applyHandleRedirect(admin, "test.myshopify.com", change);

    expect(result.created).toBe(false);
    expect(result.skippedReason).toBe("notConfirmed");
    // The merchant is told, because otherwise they assume the old URL is
    // covered when it is not.
    expect(result.noteCode).toBe("notConfirmed");
  });

  it("never throws when Shopify errors — the save already happened", async () => {
    createRedirect.mockRejectedValue(new Error("network"));

    const result = await applyHandleRedirect(admin, "test.myshopify.com", change);

    expect(result.created).toBe(false);
    expect(result.skippedReason).toBe("error");
    expect(result.noteCode).toBe("failed");
  });

  it("tells the merchant when an article's blog handle is unknown", async () => {
    // Silence here would be the worst outcome: the old article URL stays
    // broken and nothing says so.
    const result = await applyHandleRedirect(admin, "test.myshopify.com", {
      ...change,
      resource: "article",
      blogHandle: null,
    });

    expect(createRedirect).not.toHaveBeenCalled();
    expect(result.skippedReason).toBe("missingBlogHandle");
    expect(result.noteCode).toBe("missingBlogHandle");
  });

  it("warns that a renamed blog's ARTICLES are not covered", async () => {
    // Redirecting `/blogs/old` → `/blogs/new` leaves every
    // `/blogs/old/<article>` broken, and Shopify redirects have no wildcards.
    // Reporting this as a plain "created" would be a half-truth the merchant
    // has no way to check.
    createRedirect.mockResolvedValue({ redirect: { id: "gid://shopify/UrlRedirect/1" }, userErrors: [] });

    const result = await applyHandleRedirect(admin, "test.myshopify.com", { ...change, resource: "blog" });

    expect(result.created).toBe(true);
    expect(createRedirect).toHaveBeenCalledWith(admin, { path: "/blogs/old", target: "/blogs/new" });
    expect(result.noteCode).toBe("blogArticlesUncovered");
  });

  it("stays silent about the routine skips", async () => {
    // "The merchant switched it off" and "nothing changed" are not news.
    const optedOut = await applyHandleRedirect(admin, "test.myshopify.com", { ...change, wanted: false });
    expect(optedOut.noteCode).toBeUndefined();

    const brandNew = await applyHandleRedirect(admin, "test.myshopify.com", { ...change, isNew: true });
    expect(brandNew.noteCode).toBeUndefined();
  });
});

/**
 * Renaming the same object twice is the ordinary case, not an edge one — a
 * merchant shaping a handle tries two or three. Each of these would leave the
 * shop in a state this app's OWN crawler reports as a defect, which is the
 * worst possible outcome: a feature manufacturing the findings it then flags.
 */
describe("repeated renames", () => {
  beforeEach(() => {
    createRedirect.mockResolvedValue({ redirect: { id: "gid://shopify/UrlRedirect/1" }, userErrors: [] });
  });

  it("repoints an earlier redirect instead of building a chain", async () => {
    // a→b already happened. Now b→c. Without this, the shop holds
    // `/a→/b` AND `/b→/c` — a chain `redirect-chains.ts` reports.
    listRedirects.mockResolvedValue({
      redirects: [{ id: "gid://shopify/UrlRedirect/7", path: "/products/a", target: "/products/b" }],
      hasNextPage: false,
      endCursor: null,
    });

    await applyHandleRedirect(admin, "test.myshopify.com", {
      ...change,
      previousHandle: "b",
      nextHandle: "c",
    });

    expect(updateRedirect).toHaveBeenCalledWith(admin, "gid://shopify/UrlRedirect/7", {
      path: "/products/a",
      target: "/products/c",
    });
    expect(createRedirect).toHaveBeenCalledWith(admin, { path: "/products/b", target: "/products/c" });
  });

  it("uses FIELDED search terms, not a bare path", async () => {
    // A bare term is not documented to match targets as well as paths. If it
    // only indexed `path`, the chain repointing below would silently find
    // nothing in production while every test here still passed.
    await applyHandleRedirect(admin, "test.myshopify.com", change);
    const queries = listRedirects.mock.calls.map((c) => (c[1] as { query: string }).query);
    expect(queries).toContain("path:/products/old");
    expect(queries).toContain("target:/products/old");
    expect(queries).toContain("path:/products/new");
    expect(queries).toContain("target:/products/new");
  });

  it("clears a redirect that would shadow the new URL", async () => {
    // a→b, then back b→a. `/a→/b` must go: `/a` is a LIVE page again and
    // Shopify serves the redirect in preference to it, so leaving the row
    // makes the object unreachable at its own address. (It is also half of a
    // two-member cycle, which this app refuses to auto-fix.)
    listRedirects.mockResolvedValue({
      redirects: [{ id: "gid://shopify/UrlRedirect/7", path: "/products/a", target: "/products/b" }],
      hasNextPage: false,
      endCursor: null,
    });

    await applyHandleRedirect(admin, "test.myshopify.com", {
      ...change,
      previousHandle: "b",
      nextHandle: "a",
    });

    expect(deleteRedirect).toHaveBeenCalledWith(admin, "gid://shopify/UrlRedirect/7");
    // …and the redirect that IS owed still gets made.
    expect(createRedirect).toHaveBeenCalledWith(admin, { path: "/products/b", target: "/products/a" });
    // The stale row was deleted, not repointed onto itself.
    expect(updateRedirect).not.toHaveBeenCalled();
  });

  it("tells the merchant when it removed one of their redirects", async () => {
    // The removed row may have been set up by hand. Deleting it is right — a
    // redirect on a live path hides the page — but doing it in silence is not.
    listRedirects.mockResolvedValue({
      redirects: [{ id: "gid://shopify/UrlRedirect/7", path: "/products/new", target: "/pages/promo" }],
      hasNextPage: false,
      endCursor: null,
    });

    const result = await applyHandleRedirect(admin, "test.myshopify.com", change);

    expect(deleteRedirect).toHaveBeenCalledWith(admin, "gid://shopify/UrlRedirect/7");
    expect(result.created).toBe(true);
    expect(result.noteCode).toBe("shadowRemoved");
  });

  it("updates rather than re-creates a redirect on the same old path", async () => {
    // Shopify rejects a second redirect on a path it already knows, so a
    // create here would come back as a userError and read as a failure.
    listRedirects.mockResolvedValue({
      redirects: [{ id: "gid://shopify/UrlRedirect/7", path: "/products/old", target: "/products/x" }],
      hasNextPage: false,
      endCursor: null,
    });

    const result = await applyHandleRedirect(admin, "test.myshopify.com", change);

    expect(createRedirect).not.toHaveBeenCalled();
    expect(updateRedirect).toHaveBeenCalledWith(admin, "gid://shopify/UrlRedirect/7", {
      path: "/products/old",
      target: "/products/new",
    });
    expect(result.created).toBe(true);
  });

  it("ignores a near-miss from the search", async () => {
    // `listRedirects` takes a SEARCH term, not an exact path, so an unrelated
    // row can come back. Repointing it would rewrite a redirect the merchant
    // made by hand.
    listRedirects.mockResolvedValue({
      redirects: [{ id: "gid://shopify/UrlRedirect/8", path: "/products/older-thing", target: "/products/elsewhere" }],
      hasNextPage: false,
      endCursor: null,
    });

    await applyHandleRedirect(admin, "test.myshopify.com", change);

    expect(updateRedirect).not.toHaveBeenCalled();
    expect(deleteRedirect).not.toHaveBeenCalled();
    expect(createRedirect).toHaveBeenCalledWith(admin, { path: "/products/old", target: "/products/new" });
  });
});
