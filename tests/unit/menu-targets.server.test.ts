import { describe, it, expect } from "vitest";
import { collectMenuResourceIds, gidKind } from "../../app/services/menu-targets.server";

describe("gidKind", () => {
  it("names the resource kind", () => {
    expect(gidKind("gid://shopify/Product/1")).toBe("Product");
    expect(gidKind("gid://shopify/ShopPolicy/refund-policy")).toBe("ShopPolicy");
  });

  it("answers empty for anything that is not a GID", () => {
    // An empty kind means "no resolver", which leaves the id unresolved and
    // renders as type + id — never as a wrong title.
    expect(gidKind("https://example.com")).toBe("");
    expect(gidKind("")).toBe("");
    expect(gidKind("gid://shopify/Product")).toBe("");
  });
});

describe("collectMenuResourceIds", () => {
  it("finds targets at every depth", () => {
    const tree = [
      { id: "a", resourceId: "gid://shopify/Collection/1", items: [
        { id: "b", items: [
          { id: "c", resourceId: "gid://shopify/Product/2" },
        ] },
      ] },
      { id: "d", resourceId: "gid://shopify/Page/3" },
    ];
    expect(collectMenuResourceIds(tree).sort()).toEqual([
      "gid://shopify/Collection/1",
      "gid://shopify/Page/3",
      "gid://shopify/Product/2",
    ]);
  });

  it("ignores items with no target and a malformed tree", () => {
    expect(collectMenuResourceIds([{ id: "a" }, { id: "b", resourceId: "" }])).toEqual([]);
    expect(collectMenuResourceIds(null)).toEqual([]);
    expect(collectMenuResourceIds("nope")).toEqual([]);
  });
});
