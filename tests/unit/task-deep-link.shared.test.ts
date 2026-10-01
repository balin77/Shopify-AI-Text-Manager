/**
 * The Tasks page's "open this item" link.
 *
 * Two of these cases are the defects the module was written for: a blog POST
 * stores `resourceType: "Article"` and a blog CONTAINER stores `"Blog"`, and
 * the admin-path map this replaced keyed off those strings — it had no
 * `article` entry (so every blog task lost its link) and sent `blog` to
 * `/admin/articles/<id>`, an address for a different object.
 */

import { describe, it, expect } from "vitest";
import { taskEditorDeepLink } from "~/services/tasks/task-deep-link.shared";

describe("taskEditorDeepLink", () => {
  it("routes every kind this app can open", () => {
    const cases: Array<[string, string, string]> = [
      ["gid://shopify/Product/1", "/app/products", "Product"],
      ["gid://shopify/Collection/2", "/app/collections", "Collection"],
      ["gid://shopify/Page/3", "/app/pages", "Page"],
      ["gid://shopify/Article/4", "/app/blog", "Article"],
      ["gid://shopify/Blog/5", "/app/blog", "Blog"],
      ["gid://shopify/ShopPolicy/6", "/app/policies", "ShopPolicy"],
      ["gid://shopify/Metaobject/7", "/app/metaobjects", "Metaobject"],
      ["gid://shopify/Menu/8", "/app/menus", "Menu"],
    ];
    for (const [gid, path, type] of cases) {
      expect(taskEditorDeepLink(type, gid), type).toEqual({ path, select: gid });
    }
  });

  it("ignores the resourceType string — the GID decides", () => {
    // The spellings really written to Task.resourceType for a blog post.
    for (const spelling of ["Article", "blog", "blogs", "articles", "seo", null, undefined]) {
      expect(taskEditorDeepLink(spelling, "gid://shopify/Article/4")).toEqual({
        path: "/app/blog",
        select: "gid://shopify/Article/4",
      });
    }
    // A blog CONTAINER is the blog page too — never /app/pages, whatever the
    // type string claims.
    expect(taskEditorDeepLink("page", "gid://shopify/Blog/5")?.path).toBe("/app/blog");
  });

  it("yields NO link for anything this app cannot select by id", () => {
    // A site-wide SEO run, a theme content group, a theme, an e-mail template:
    // no single item, so no guessed route.
    expect(taskEditorDeepLink("seo", null)).toBeNull();
    expect(taskEditorDeepLink("templateTitles", null)).toBeNull();
    expect(taskEditorDeepLink("templates", "gid://shopify/OnlineStoreTheme/1")).toBeNull();
    expect(taskEditorDeepLink("templates", "group_12345")).toBeNull();
    expect(taskEditorDeepLink("product", "8123")).toBeNull();
    expect(taskEditorDeepLink("product", "")).toBeNull();
    expect(taskEditorDeepLink("seo", "gid://shopify/MediaImage/1")).toBeNull();
  });

  it("carries the GID through trimmed, so ?select= matches the cached id", () => {
    expect(taskEditorDeepLink("product", "  gid://shopify/Product/1  ")).toEqual({
      path: "/app/products",
      select: "gid://shopify/Product/1",
    });
  });
});
