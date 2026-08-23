import { describe, it, expect, beforeEach } from "vitest";
import {
  setFieldSuggestion,
  clearFieldSuggestion,
  getFieldSuggestion,
  readFieldSuggestions,
  setAltTextSuggestion,
  clearAltTextSuggestion,
  readAltTextSuggestions,
  clearSuggestionsForScope,
  __resetSuggestionStore,
  type SuggestionScope,
} from "~/hooks/useAISuggestionStore";

const PRODUCT = "gid://shopify/Product/1";
const OTHER = "gid://shopify/Product/2";

const scope = (over: Partial<SuggestionScope> = {}): SuggestionScope => ({
  resourceId: PRODUCT,
  locale: "de",
  marketId: "",
  ...over,
});

describe("useAISuggestionStore", () => {
  beforeEach(() => {
    __resetSuggestionStore();
  });

  it("keeps a suggestion the merchant has not decided on", () => {
    // The whole point: the editor may unmount in between (main-nav tab, item
    // switch) — the store is not part of its lifecycle.
    setFieldSuggestion(scope(), "seoTitle", "Kumiko-Box aus Kirschholz");
    expect(getFieldSuggestion(scope(), "seoTitle")).toBe("Kumiko-Box aus Kirschholz");
    expect(readFieldSuggestions(scope())).toEqual({ seoTitle: "Kumiko-Box aus Kirschholz" });
  });

  it("scopes by item, so another item's suggestion is not shown", () => {
    setFieldSuggestion(scope(), "seoTitle", "für Produkt 1");
    expect(readFieldSuggestions(scope({ resourceId: OTHER }))).toEqual({});
    // …and the first one survives the detour.
    expect(readFieldSuggestions(scope())).toEqual({ seoTitle: "für Produkt 1" });
  });

  it("scopes by locale — a German suggestion never surfaces on the French tab", () => {
    // Accepting writes into the value currently on screen, so a suggestion
    // leaking across locales would write German text into the French field.
    setFieldSuggestion(scope(), "metaDescription", "deutscher Vorschlag");
    expect(readFieldSuggestions(scope({ locale: "fr" }))).toEqual({});
    expect(readFieldSuggestions(scope())).toEqual({ metaDescription: "deutscher Vorschlag" });
  });

  it("scopes by market", () => {
    setFieldSuggestion(scope(), "seoTitle", "global");
    expect(readFieldSuggestions(scope({ marketId: "gid://shopify/Market/9" }))).toEqual({});
  });

  it("forgets a suggestion once it is accepted or rejected", () => {
    setFieldSuggestion(scope(), "seoTitle", "Vorschlag");
    clearFieldSuggestion(scope(), "seoTitle");
    expect(getFieldSuggestion(scope(), "seoTitle")).toBeUndefined();
  });

  it("ignores an empty answer instead of clearing what is on screen", () => {
    setFieldSuggestion(scope(), "seoTitle", "Vorschlag");
    setFieldSuggestion(scope(), "seoTitle", "   ");
    expect(getFieldSuggestion(scope(), "seoTitle")).toBe("Vorschlag");
  });

  it("stores nothing without an item", () => {
    setFieldSuggestion(scope({ resourceId: "" }), "seoTitle", "Vorschlag");
    expect(readFieldSuggestions(scope({ resourceId: "" }))).toEqual({});
  });

  it("keeps alt-text suggestions out of the field record and vice versa", () => {
    setFieldSuggestion(scope(), "seoTitle", "Titel");
    setAltTextSuggestion(scope(), 2, "Nahaufnahme der Maserung");

    expect(readFieldSuggestions(scope())).toEqual({ seoTitle: "Titel" });
    expect(readAltTextSuggestions(scope())).toEqual({ 2: "Nahaufnahme der Maserung" });
  });

  it("clears every suggestion of one scope, and only that scope", () => {
    // "Alles leeren" emptied this item in this locale — a surviving banner
    // would offer to refill exactly what the merchant just deleted.
    setAltTextSuggestion(scope(), 0, "Bild 0");
    setFieldSuggestion(scope(), "seoTitle", "Titel");
    setAltTextSuggestion(scope({ locale: "fr" }), 0, "image 0");
    setFieldSuggestion(scope({ locale: "fr" }), "seoTitle", "titre");

    clearSuggestionsForScope(scope());

    expect(readAltTextSuggestions(scope())).toEqual({});
    expect(readFieldSuggestions(scope())).toEqual({});
    expect(readAltTextSuggestions(scope({ locale: "fr" }))).toEqual({ 0: "image 0" });
    expect(readFieldSuggestions(scope({ locale: "fr" }))).toEqual({ seoTitle: "titre" });
  });

  it("clears one alt-text suggestion", () => {
    setAltTextSuggestion(scope(), 0, "Bild 0");
    setAltTextSuggestion(scope(), 1, "Bild 1");
    clearAltTextSuggestion(scope(), 0);
    expect(readAltTextSuggestions(scope())).toEqual({ 1: "Bild 1" });
  });

  it("keeps a pending suggestion indefinitely — only a decision removes it", () => {
    // No clock: an age limit is not observable from React without a timer, so
    // the rendered record and the imperative reader would disagree about
    // whether an "expired" suggestion still exists.
    setFieldSuggestion(scope(), "seoTitle", "Vorschlag");
    expect(getFieldSuggestion(scope(), "seoTitle")).toBe("Vorschlag");
    expect(readFieldSuggestions(scope())).toEqual({ seoTitle: "Vorschlag" });
  });

  it("caps the store by evicting the oldest write, not the newest", () => {
    for (let i = 0; i < 120; i++) {
      setFieldSuggestion(scope({ resourceId: `gid://shopify/Product/${i}` }), "seoTitle", `#${i}`);
    }
    // The first writes are gone, the last ones — the ones the merchant is
    // plausibly still deciding on — are still there.
    expect(getFieldSuggestion(scope({ resourceId: "gid://shopify/Product/0" }), "seoTitle")).toBeUndefined();
    expect(getFieldSuggestion(scope({ resourceId: "gid://shopify/Product/119" }), "seoTitle")).toBe("#119");
  });

  it("re-generating moves the entry to the end of the eviction queue", () => {
    setFieldSuggestion(scope(), "seoTitle", "erster Versuch");
    for (let i = 0; i < 99; i++) {
      setFieldSuggestion(scope({ resourceId: `gid://shopify/Product/${100 + i}` }), "seoTitle", `#${i}`);
    }
    // Store is exactly full; re-writing the oldest entry must renew it rather
    // than leave it first in line.
    setFieldSuggestion(scope(), "seoTitle", "zweiter Versuch");
    setFieldSuggestion(scope({ resourceId: "gid://shopify/Product/999" }), "seoTitle", "neu");

    expect(getFieldSuggestion(scope(), "seoTitle")).toBe("zweiter Versuch");
  });
});
