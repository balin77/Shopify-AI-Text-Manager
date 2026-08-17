/**
 * PLAN_CONTENT_CREATION §7 (Phase 3) — redirect on handle change.
 *
 * The plan's §A1 records the live bug: this app changes handles in three
 * places and creates a redirect in none of them, so every handle edit silently
 * 404s whatever linked to the old address.
 *
 * The tests below are almost entirely about the cases that must NOT produce a
 * redirect. Creating one where it does not belong is not a harmless extra: a
 * redirect from a handle that never existed clutters the merchant's list, and
 * one whose source equals its target is a loop that this app's own crawler
 * would go on to report as a defect.
 */

import { describe, it, expect } from "vitest";
import {
  decideHandleRedirect,
  redirectResourceFor,
  resolveRedirectPreference,
  storefrontPathFor,
  wasEverLive,
} from "~/services/seo/handle-redirect.shared";

/**
 * "Was the old URL ever reachable?" — the question that decides whether a
 * rename owes anything at all.
 *
 * The asymmetry here is deliberate and worth stating: UNKNOWN proceeds. A
 * redirect too many is one row a merchant can delete; a redirect too few is
 * traffic nobody notices losing. IndexNow resolves the same uncertainty the
 * OTHER way, because there acting on a guess would publish a draft's URL.
 */
describe("wasEverLive", () => {
  it("counts UNLISTED as live, not just ACTIVE", () => {
    // An unlisted product is reachable by direct link — exactly the kind of
    // URL that sits in someone's newsletter. Treating it as a draft is the
    // three-value assumption that has bitten this app before.
    expect(wasEverLive("product", { status: "ACTIVE" })).toBe(true);
    expect(wasEverLive("product", { status: "UNLISTED" })).toBe(true);
    expect(wasEverLive("product", { status: "DRAFT" })).toBe(false);
    expect(wasEverLive("product", { status: "ARCHIVED" })).toBe(false);
  });

  it("reads a page or article off isPublished — but only once it is known", () => {
    expect(wasEverLive("page", { isPublished: true, attributesKnown: true })).toBe(true);
    expect(wasEverLive("page", { isPublished: false, attributesKnown: true })).toBe(false);
    // §2.4 — before the attribute sync the column is the migration's default.
    // Null, not false: refusing the redirect here would silently cost every
    // un-synced shop its redirects.
    expect(wasEverLive("article", { isPublished: false, attributesKnown: false })).toBeNull();
  });

  it("answers UNKNOWN where the app genuinely cannot tell", () => {
    // A collection's visibility lives in publications, which this app has no
    // scope for. Guessing "draft" would drop redirects a shop needs.
    expect(wasEverLive("collection", {})).toBeNull();
    expect(wasEverLive("product", { status: "" })).toBeNull();
  });

  it("treats a blog index as always live", () => {
    // It exists as soon as the blog does — there is no draft state to read.
    expect(wasEverLive("blog", {})).toBe(true);
  });
});

describe("redirectResourceFor", () => {
  it("maps each handled type", () => {
    expect(redirectResourceFor("Product", "gid://shopify/Product/1")).toBe("product");
    expect(redirectResourceFor("Collection", "gid://shopify/Collection/1")).toBe("collection");
    expect(redirectResourceFor("Page", "gid://shopify/Page/1")).toBe("page");
    expect(redirectResourceFor("Article", "gid://shopify/Article/1")).toBe("article");
  });

  it("tells a blog CONTAINER from an article by its GID", () => {
    // The blogs tab serves both and their URLs differ in shape: `/blogs/<x>`
    // versus `/blogs/<blog>/<article>`. The resource type alone cannot say
    // which, because the tab reports both as its own config type.
    expect(redirectResourceFor("Article", "gid://shopify/Blog/9")).toBe("blog");
    expect(redirectResourceFor("Blog", "gid://shopify/Blog/9")).toBe("blog");
  });

  it("returns null for types with no handle-derived URL", () => {
    // A policy or a metaobject has no storefront address built from a handle,
    // so a redirect for one would be a row pointing nowhere.
    expect(redirectResourceFor("ShopPolicy", "gid://shopify/ShopPolicy/1")).toBeNull();
    expect(redirectResourceFor("Metaobject", "gid://shopify/Metaobject/1")).toBeNull();
    expect(redirectResourceFor("ONLINE_STORE_THEME", "gid://shopify/OnlineStoreTheme/1")).toBeNull();
  });
});

describe("resolveRedirectPreference", () => {
  it("lets an explicit per-save choice win over the shop setting", () => {
    expect(resolveRedirectPreference("true", false)).toBe(true);
    expect(resolveRedirectPreference("false", true)).toBe(false);
  });

  it("falls back to the shop setting when the save says nothing", () => {
    expect(resolveRedirectPreference(undefined, false)).toBe(false);
    expect(resolveRedirectPreference("", true)).toBe(true);
  });

  it("defaults to ON when neither is set", () => {
    // A shop row that predates the column reads as null — which must behave as
    // on, not as an opt-out nobody chose.
    expect(resolveRedirectPreference(undefined, null)).toBe(true);
    expect(resolveRedirectPreference(undefined, undefined)).toBe(true);
  });

  it("treats any other submitted value as 'not stated'", () => {
    // Only the two exact strings the form sends count. Anything else is noise
    // and must not silently disable a protective default.
    expect(resolveRedirectPreference("on", false)).toBe(false);
    expect(resolveRedirectPreference("1", null)).toBe(true);
  });
});

describe("storefrontPathFor", () => {
  it("knows each type's URL shape", () => {
    expect(storefrontPathFor("product", "a-shirt")).toBe("/products/a-shirt");
    expect(storefrontPathFor("collection", "sale")).toBe("/collections/sale");
    expect(storefrontPathFor("page", "about")).toBe("/pages/about");
    expect(storefrontPathFor("article", "hello", "news")).toBe("/blogs/news/hello");
    expect(storefrontPathFor("blog", "news")).toBe("/blogs/news");
  });

  it("returns null for an article with no blog handle", () => {
    // A guessed path is worse than none: it would redirect a URL that never
    // existed and leave the real old one broken.
    expect(storefrontPathFor("article", "hello")).toBeNull();
    expect(storefrontPathFor("article", "hello", "   ")).toBeNull();
  });

  it("tolerates stray slashes", () => {
    expect(storefrontPathFor("product", "/a-shirt/")).toBe("/products/a-shirt");
  });
});

describe("decideHandleRedirect", () => {
  const base = { resource: "product" as const, previousHandle: "old", nextHandle: "new", wanted: true };

  it("redirects a genuine handle change", () => {
    expect(decideHandleRedirect(base)).toEqual({
      redirect: true,
      fromPath: "/products/old",
      toPath: "/products/new",
    });
  });

  it("does nothing when the merchant did not ask", () => {
    // Offered, never imposed — the plan is explicit that this is a checkbox.
    expect(decideHandleRedirect({ ...base, wanted: false })).toEqual({ redirect: false, reason: "notWanted" });
  });

  it("does nothing for a brand-new object", () => {
    // There is no old URL to preserve, and a redirect from a handle that never
    // existed becomes a loop the moment the merchant reuses it elsewhere.
    expect(decideHandleRedirect({ ...base, isNew: true })).toEqual({ redirect: false, reason: "isNew" });
  });

  it("treats a case- or whitespace-only difference as unchanged", () => {
    // Shopify lowercases and trims handles, so these are not changes — and a
    // redirect would point at itself.
    expect(decideHandleRedirect({ ...base, previousHandle: "Same", nextHandle: "same" }))
      .toEqual({ redirect: false, reason: "unchanged" });
    expect(decideHandleRedirect({ ...base, previousHandle: "same", nextHandle: "  same  " }))
      .toEqual({ redirect: false, reason: "unchanged" });
  });

  it("does nothing when either handle is missing", () => {
    expect(decideHandleRedirect({ ...base, previousHandle: "" })).toEqual({ redirect: false, reason: "missingHandle" });
    expect(decideHandleRedirect({ ...base, nextHandle: null })).toEqual({ redirect: false, reason: "missingHandle" });
  });

  it("refuses an article whose blog handle it does not know", () => {
    const decision = decideHandleRedirect({
      resource: "article",
      previousHandle: "old",
      nextHandle: "new",
      wanted: true,
    });
    expect(decision).toEqual({ redirect: false, reason: "missingBlogHandle" });
  });

  it("redirects an article under its blog", () => {
    expect(
      decideHandleRedirect({ resource: "article", previousHandle: "old", nextHandle: "new", wanted: true, blogHandle: "news" }),
    ).toEqual({ redirect: true, fromPath: "/blogs/news/old", toPath: "/blogs/news/new" });
  });

  it("never produces a redirect to itself", () => {
    // Shopify would accept it, and this app's own crawler would then report
    // the loop as a defect — a bug reporting a bug it created.
    const decision = decideHandleRedirect({ ...base, previousHandle: "/same/", nextHandle: "same" });
    expect(decision).toEqual({ redirect: false, reason: "unchanged" });
  });

  it("does nothing for an object whose URL was never reachable", () => {
    // The commonest real case, and the one `isNew` does NOT cover: a product
    // that has sat in DRAFT for weeks and is now being renamed. Its old
    // address was never live, so a redirect from it is clutter — and a loop
    // waiting to happen the moment the merchant reuses that handle.
    expect(decideHandleRedirect({ ...base, previouslyLive: false }))
      .toEqual({ redirect: false, reason: "neverLive" });
  });

  it("proceeds when it cannot tell whether the URL was live", () => {
    // Unknown is not "no". Losing a redirect costs traffic nobody notices.
    expect(decideHandleRedirect({ ...base, previouslyLive: null }).redirect).toBe(true);
    expect(decideHandleRedirect({ ...base, previouslyLive: undefined }).redirect).toBe(true);
  });

  it("checks 'wanted' before anything else, so an opt-out is never overridden", () => {
    expect(decideHandleRedirect({ ...base, wanted: false, isNew: true })).toEqual({ redirect: false, reason: "notWanted" });
  });
});
