import { describe, it, expect } from "vitest";
import {
  keepsForeignMediaOnPrimaryChange,
  rememberThemeImagePick,
  fileIdForThemeImage,
} from "~/utils/theme-image-reference.shared";
import { countStringOccurrences } from "~/utils/templates/templates.utils";
import { survivesValuePrompt } from "~/services/translations/stale-translations.shared";

describe("a primary change of a media setting keeps the foreign values", () => {
  it("covers image and video values, either side, and nothing else", () => {
    expect(keepsForeignMediaOnPrimaryChange("shopify://shop_images/a.png", "shopify://shop_images/b.png")).toBe(true);
    expect(keepsForeignMediaOnPrimaryChange("text", "shopify://shop_images/b.png")).toBe(true);
    expect(keepsForeignMediaOnPrimaryChange("https://youtu.be/abcdefghijk", "https://youtu.be/zzzzzzzzzzz")).toBe(true);
    expect(keepsForeignMediaOnPrimaryChange("Alt", "Neu")).toBe(false);
    expect(keepsForeignMediaOnPrimaryChange(undefined, "Neu")).toBe(false);
  });

  it("the AI value prompt already declines media values", () => {
    expect(survivesValuePrompt("shopify://shop_images/a.png")).toBe(false);
    expect(survivesValuePrompt("https://www.youtube.com/watch?v=abcdefghijk")).toBe(false);
  });
});

describe("remembered picks", () => {
  it("only well-formed references and MediaImage ids are remembered", () => {
    rememberThemeImagePick("shopify://shop_images/x.png", "gid://shopify/MediaImage/1");
    rememberThemeImagePick("not a reference", "gid://shopify/MediaImage/2");
    rememberThemeImagePick("shopify://shop_images/y.png", "gid://shopify/Video/3");
    expect(fileIdForThemeImage("shopify://shop_images/x.png")).toBe("gid://shopify/MediaImage/1");
    expect(fileIdForThemeImage("not a reference")).toBeNull();
    expect(fileIdForThemeImage("shopify://shop_images/y.png")).toBeNull();
  });
});

describe("countStringOccurrences", () => {
  it("counts whole-value matches anywhere in the tree", () => {
    expect(countStringOccurrences({ a: "x", b: { c: "x", d: ["x", "xx"] } }, "x")).toBe(3);
    expect(countStringOccurrences(null, "x")).toBe(0);
  });
});
