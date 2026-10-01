/**
 * Which resource the single-item reload button posts to.
 *
 * Both special cases here shipped wrong once. The theme-content one produced a
 * loud "Unknown resource type: sellingPlans". The blogs one produced the worse
 * kind of failure: a blog container reloaded as an ARTICLE GID, which resolves
 * to nothing, while the route still answered "Data reloaded successfully" over
 * an untouched cache.
 */

import { describe, it, expect } from "vitest";
import { getReloadResourceType } from "~/utils/reload-resource-type";

const BLOG_GID = "gid://shopify/Blog/123";
const ARTICLE_GID = "gid://shopify/Article/456";

describe("getReloadResourceType", () => {
  it("maps the plain rubrics", () => {
    expect(getReloadResourceType("products", "gid://shopify/Product/1")).toBe("product");
    expect(getReloadResourceType("collections", "gid://shopify/Collection/1")).toBe("collection");
    expect(getReloadResourceType("pages", "gid://shopify/Page/1")).toBe("page");
    expect(getReloadResourceType("policies", "gid://shopify/ShopPolicy/1")).toBe("policy");
  });

  it("routes the whole theme-content family through 'templates'", () => {
    for (const rubric of ["templates", "system", "sellingPlans", "onlineStoreExtras"]) {
      expect(getReloadResourceType(rubric, "group_x")).toBe("templates");
    }
  });

  it("tells a blog CONTAINER apart from an article on the same tab", () => {
    // The blogs rubric serves both; only the GID can distinguish them.
    expect(getReloadResourceType("blogs", BLOG_GID)).toBe("blog");
    expect(getReloadResourceType("blogs", ARTICLE_GID)).toBe("article");
  });

  it("falls back to 'article' for the blogs tab when no id is available", () => {
    // Articles are the overwhelming majority on that tab, and the old
    // behaviour — before "blog" existed — is the safe default.
    expect(getReloadResourceType("blogs")).toBe("article");
  });

  it("does not mistake a Blog GID on another tab for a blog container", () => {
    expect(getReloadResourceType("pages", BLOG_GID)).toBe("page");
  });
});
