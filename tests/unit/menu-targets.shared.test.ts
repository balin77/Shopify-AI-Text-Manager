import { describe, it, expect } from "vitest";
import {
  MENU_TARGET_GROUPS,
  isResourceBoundMenuType,
  looksLikeMenuUrl,
  menuTargetGroupFor,
  menuTargetPatch,
  menuTargetlessTypes,
  summarizeMenuTarget,
} from "../../app/services/menu-targets.shared";
import {
  MENU_ITEM_TYPES_NEEDING_RESOURCE,
  MENU_ITEM_TYPES_WITHOUT_TARGET,
} from "../../app/services/menu-tree.shared";

describe("the picker's catalogue agrees with the write path", () => {
  it("offers a group for every resource-bound type", () => {
    for (const type of MENU_ITEM_TYPES_NEEDING_RESOURCE) {
      expect(menuTargetGroupFor(type), `no group for ${type}`).toBeTruthy();
    }
  });

  it("offers no group for a type that needs no resource", () => {
    for (const group of MENU_TARGET_GROUPS) {
      expect(isResourceBoundMenuType(group.type)).toBe(true);
    }
  });

  it("offers every target-less type, and only those", () => {
    const offered = menuTargetlessTypes();
    expect([...offered].sort()).toEqual([...MENU_ITEM_TYPES_WITHOUT_TARGET].sort());
    // Home page first: it is what a merchant reaches for.
    expect(offered[0]).toBe("FRONTPAGE");
  });

  it("gives each group a distinct source and label", () => {
    expect(new Set(MENU_TARGET_GROUPS.map((g) => g.source)).size).toBe(MENU_TARGET_GROUPS.length);
    expect(new Set(MENU_TARGET_GROUPS.map((g) => g.labelKey)).size).toBe(MENU_TARGET_GROUPS.length);
  });
});

describe("looksLikeMenuUrl", () => {
  it("accepts a path and an absolute URL", () => {
    expect(looksLikeMenuUrl("/pages/about")).toBe(true);
    expect(looksLikeMenuUrl("https://example.com/x")).toBe(true);
    expect(looksLikeMenuUrl("http://example.com")).toBe(true);
    expect(looksLikeMenuUrl("mailto:hi@example.com")).toBe(true);
    expect(looksLikeMenuUrl("tel:+41791234567")).toBe(true);
  });

  it("refuses a plain search query", () => {
    // Otherwise every keystroke offers itself as a link, at the TOP of the
    // dropdown, where a mis-click turns a search into a broken menu item.
    expect(looksLikeMenuUrl("vase")).toBe(false);
    expect(looksLikeMenuUrl("summer sale")).toBe(false);
    expect(looksLikeMenuUrl("")).toBe(false);
    expect(looksLikeMenuUrl("   ")).toBe(false);
  });

  it("refuses a scheme with nothing after it", () => {
    expect(looksLikeMenuUrl("https://")).toBe(false);
    expect(looksLikeMenuUrl("mailto:")).toBe(false);
  });
});

describe("summarizeMenuTarget", () => {
  it("reads a free URL", () => {
    expect(summarizeMenuTarget({ type: "HTTP", url: "https://x.test" })).toEqual({
      kind: "url",
      type: "HTTP",
      url: "https://x.test",
    });
  });

  it("reads a target-less type", () => {
    expect(summarizeMenuTarget({ type: "FRONTPAGE" }).kind).toBe("targetless");
  });

  it("resolves a bound resource when the title is known", () => {
    const summary = summarizeMenuTarget(
      { type: "PRODUCT", resourceId: "gid://shopify/Product/1" },
      (id) => (id === "gid://shopify/Product/1" ? "Vase" : undefined),
    );
    expect(summary).toMatchObject({ kind: "resource", resourceTitle: "Vase" });
  });

  it("keeps the id when the title is NOT known", () => {
    // The whole point: an unresolved target must stay visible as a target.
    const summary = summarizeMenuTarget({ type: "PRODUCT", resourceId: "gid://shopify/Product/9" });
    expect(summary.resourceTitle).toBeNull();
    expect(summary.resourceId).toBe("gid://shopify/Product/9");
  });

  it("calls an unknown type unknown rather than guessing a shape", () => {
    expect(summarizeMenuTarget({ type: "SOMETHING_NEW" }).kind).toBe("unknown");
  });
});

describe("menuTargetPatch", () => {
  it("clears the resourceId when a bound item becomes target-less", () => {
    // The bug this function exists to make impossible: a PRODUCT item turned
    // into FRONTPAGE while still carrying its old resourceId.
    expect(menuTargetPatch({ kind: "targetless", type: "FRONTPAGE" })).toEqual({
      type: "FRONTPAGE",
      url: null,
      resourceId: null,
    });
  });

  it("clears the url when a URL item becomes a resource", () => {
    expect(menuTargetPatch({ kind: "resource", type: "PAGE", id: "gid://shopify/Page/3" })).toEqual({
      type: "PAGE",
      url: null,
      resourceId: "gid://shopify/Page/3",
    });
  });

  it("trims a pasted URL and clears the resourceId", () => {
    expect(menuTargetPatch({ kind: "url", url: "  /pages/about  " })).toEqual({
      type: "HTTP",
      url: "/pages/about",
      resourceId: null,
    });
  });
});
