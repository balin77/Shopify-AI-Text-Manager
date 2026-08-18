/**
 * Which colour goes next to an option value.
 *
 * The whole risk in this module is the third source — guessing a colour from
 * the value's NAME. A swatch that is confidently wrong is worse than none,
 * because it is the thing the merchant looks at instead of the name. So the
 * tests are mostly about what it refuses to answer.
 */

import { describe, it, expect } from "vitest";
import { looksLikeColourOption, resolveSwatch } from "~/services/product-option-swatch.shared";

describe("resolveSwatch", () => {
  it("takes Shopify's own swatch over anything derivable", () => {
    // The merchant set it, per value. It can only be wrong if they made it so.
    expect(resolveSwatch("Red", { color: "#123456" })).toEqual({ color: "#123456", source: "shopify" });
  });

  it("shows a swatch IMAGE as an image", () => {
    // A pattern or a fabric cannot be expressed as one colour.
    expect(resolveSwatch("Tweed", { imageUrl: "https://cdn.example/x.png" })).toEqual({
      imageUrl: "https://cdn.example/x.png",
      source: "shopify",
    });
  });

  it("ignores a Shopify swatch that is not a colour", () => {
    // Whatever it is, painting it would put arbitrary text into a CSS
    // background — and the value's name may still say something usable.
    expect(resolveSwatch("Red", { color: "url(javascript:alert(1))" })?.source).toBe("name");
    expect(resolveSwatch("Tweed", { color: "not a colour" })).toBeNull();
  });

  it("reads a hex out of the name, with or without the #", () => {
    expect(resolveSwatch("#B71C1C")).toEqual({ color: "#B71C1C", source: "hex" });
    expect(resolveSwatch("B71C1C")).toEqual({ color: "#B71C1C", source: "hex" });
  });

  it("knows the basic colour words of the three languages the app ships in", () => {
    expect(resolveSwatch("Rot")?.source).toBe("name");
    expect(resolveSwatch("blue")?.source).toBe("name");
    expect(resolveSwatch("AZUL")?.source).toBe("name");
  });

  it("says nothing about a word it cannot be sure of", () => {
    // "Sand", "Nude" and "Petrol" are colours in a catalogue and not in any
    // dictionary this app should own.
    expect(resolveSwatch("Sand")).toBeNull();
    expect(resolveSwatch("Nude")).toBeNull();
    expect(resolveSwatch("Petrol")).toBeNull();
    expect(resolveSwatch("XL")).toBeNull();
    expect(resolveSwatch("")).toBeNull();
  });

  it("does not read a colour out of a longer phrase", () => {
    // "Rot meliert" is a fabric, and painting it red states something the
    // merchant did not.
    expect(resolveSwatch("Rot meliert")).toBeNull();
    expect(resolveSwatch("Dark blue")).toBeNull();
  });
});

describe("looksLikeColourOption", () => {
  it("recognises the option in each language and via the metafield key", () => {
    expect(looksLikeColourOption("Farbe")).toBe(true);
    expect(looksLikeColourOption("Colour")).toBe(true);
    expect(looksLikeColourOption("Color")).toBe(true);
    expect(looksLikeColourOption("Muster", "shopify--color-pattern")).toBe(true);
  });

  it("does not claim every option is one", () => {
    expect(looksLikeColourOption("Size")).toBe(false);
    expect(looksLikeColourOption("Material", "custom--material")).toBe(false);
  });
});
