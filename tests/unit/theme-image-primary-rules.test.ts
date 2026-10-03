import { describe, it, expect } from "vitest";
import {
  keepsForeignMediaOnPrimaryChange,
  isThemeImageReference,
  isSafeThemeImageFilename,
  rememberThemeImagePick,
  fileIdForThemeImage,
} from "~/utils/theme-image-reference.shared";
import { removeThemeLayers } from "~/services/theme-translation-cache.shared";
import { countStringOccurrences } from "~/utils/templates/templates.utils";
import { survivesValuePrompt } from "~/services/translations/stale-translations.shared";

describe("a primary change of a media setting keeps the foreign values", () => {
  it("needs BOTH an image field and an image reference as the old value", () => {
    expect(keepsForeignMediaOnPrimaryChange(true, "shopify://shop_images/a.png")).toBe(true);
    // A text/url field is text, whatever shape its value has.
    expect(keepsForeignMediaOnPrimaryChange(false, "shopify://shop_images/a.png")).toBe(false);
    expect(keepsForeignMediaOnPrimaryChange(false, "https://youtu.be/abcdefghijk")).toBe(false);
    expect(keepsForeignMediaOnPrimaryChange(true, "https://youtu.be/abcdefghijk")).toBe(false);
    expect(keepsForeignMediaOnPrimaryChange(true, "Alt")).toBe(false);
    expect(keepsForeignMediaOnPrimaryChange(true, undefined)).toBe(false);
  });

  it("a legitimate name with a space or an umlaut is a reference; separators and quotes are not", () => {
    expect(isThemeImageReference("shopify://shop_images/Müller Logo.png")).toBe(true);
    expect(isSafeThemeImageFilename("Müller Logo.png")).toBe(true);
    for (const bad of ["a/b.png", "a\\b.png", 'a"b.png', "a<b>.png", "a\nb.png", " a.png", "..", "a?b.png", "a#b.png"]) {
      expect(isSafeThemeImageFilename(bad)).toBe(false);
    }
    expect(isThemeImageReference('shopify://shop_images/a"b.png')).toBe(false);
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

describe("removeThemeLayers", () => {
  it("drops exactly the named layers and nothing else", () => {
    const cache = {
      en: [
        { key: "k", value: "x", locale: "en", marketId: "" },
        { key: "k", value: "x", locale: "en", marketId: "m1" },
        { key: "k2", value: "y", locale: "en", marketId: "" },
      ],
      fr: [{ key: "k", value: "z", locale: "fr", marketId: "" }],
    };
    const next = removeThemeLayers(cache, [{ key: "k", locale: "en", marketId: "" }]);
    expect(next.en.map((r) => `${r.key}|${r.marketId}`)).toEqual(["k|m1", "k2|"]);
    expect(next.fr).toHaveLength(1);
  });
});
