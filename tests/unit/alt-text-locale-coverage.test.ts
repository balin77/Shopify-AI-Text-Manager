import { describe, it, expect } from "vitest";
import {
  hasAltTextForLocale,
  countImagesWithAltForLocale,
} from "~/utils/field-validation.utils";
import type { ContentImage } from "~/types/content-editor.types";

/**
 * The `imagesWithAlt` input the editor's SEO sidebar feeds into
 * computeSeoScore. It used to accept the PRIMARY alt text as coverage in every
 * language, which made the image block of the score identical in all locales —
 * a product with zero alt translations still scored "all images have alt text"
 * while the store-wide audit (reading ProductImageAltTranslation for the same
 * locale) counted them as missing. These lock the per-locale rule.
 */

const PRIMARY = "de";

const img = (
  altText: string,
  translations: Array<{ locale: string; altText: string }> = [],
): ContentImage => ({
  url: "https://cdn.example/img.jpg",
  altText,
  altTextTranslations: translations,
});

describe("hasAltTextForLocale — primary locale", () => {
  it("counts the stored primary alt text", () => {
    expect(hasAltTextForLocale(img("Holzkiste"), PRIMARY, PRIMARY)).toBe(true);
  });

  it("treats an empty / whitespace-only primary alt as missing", () => {
    expect(hasAltTextForLocale(img(""), PRIMARY, PRIMARY)).toBe(false);
    expect(hasAltTextForLocale(img("   "), PRIMARY, PRIMARY)).toBe(false);
  });

  it("lets the live editor value win over the stored one — including when cleared", () => {
    expect(hasAltTextForLocale(img(""), PRIMARY, PRIMARY, "frisch getippt")).toBe(true);
    expect(hasAltTextForLocale(img("Holzkiste"), PRIMARY, PRIMARY, "")).toBe(false);
  });

  it("ignores foreign translations", () => {
    expect(
      hasAltTextForLocale(img("", [{ locale: "fr", altText: "Boîte" }]), PRIMARY, PRIMARY),
    ).toBe(false);
  });
});

describe("hasAltTextForLocale — foreign locale", () => {
  it("does NOT accept the primary alt text as coverage", () => {
    expect(hasAltTextForLocale(img("Holzkiste"), "fr", PRIMARY)).toBe(false);
  });

  it("counts a persisted translation for exactly that locale", () => {
    const image = img("Holzkiste", [{ locale: "fr", altText: "Boîte en bois" }]);
    expect(hasAltTextForLocale(image, "fr", PRIMARY)).toBe(true);
    expect(hasAltTextForLocale(image, "es", PRIMARY)).toBe(false);
  });

  it("treats an empty stored translation as missing", () => {
    expect(hasAltTextForLocale(img("Holzkiste", [{ locale: "fr", altText: "" }]), "fr", PRIMARY)).toBe(
      false,
    );
  });

  it("lets the live editor value win over the persisted translation", () => {
    const image = img("Holzkiste", [{ locale: "fr", altText: "Boîte en bois" }]);
    expect(hasAltTextForLocale(image, "fr", PRIMARY, "")).toBe(false);
    expect(hasAltTextForLocale(img("Holzkiste"), "fr", PRIMARY, "Boîte")).toBe(true);
  });

  it("reports a missing image as uncovered instead of throwing", () => {
    expect(hasAltTextForLocale(undefined, "fr", PRIMARY)).toBe(false);
  });
});

describe("countImagesWithAltForLocale", () => {
  const gallery = [
    img("Vorderseite", [{ locale: "fr", altText: "Avant" }]),
    img("Rückseite"),
    img(""),
  ];

  it("counts primary alt texts in the primary locale", () => {
    expect(countImagesWithAltForLocale(gallery, PRIMARY, PRIMARY)).toBe(2);
  });

  it("counts only translated alt texts in a foreign locale", () => {
    expect(countImagesWithAltForLocale(gallery, "fr", PRIMARY)).toBe(1);
    expect(countImagesWithAltForLocale(gallery, "es", PRIMARY)).toBe(0);
  });

  it("indexes the live editor state by list position", () => {
    // Index 1 gets an unsaved French alt text; index 0's is cleared.
    const live = { 0: "", 1: "Arrière" };
    expect(countImagesWithAltForLocale(gallery, "fr", PRIMARY, live)).toBe(1);
  });

  it("returns 0 for an empty list", () => {
    expect(countImagesWithAltForLocale([], "fr", PRIMARY)).toBe(0);
  });
});
