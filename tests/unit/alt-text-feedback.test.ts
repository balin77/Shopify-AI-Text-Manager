import { describe, it, expect } from "vitest";
import {
  classifyAltSaveResponse,
  classifyAltAiResponse,
  classifyAllLocalesResponse,
  altTranslateTaskStatus,
  overlayWritesFromTranslations,
  overlayIndexWrites,
  enqueueAltSave,
  altSaveScope,
  knownPrimaryAlt,
} from "../../app/services/alt-text-feedback.shared";
import { preserveUnsavedEdits } from "../../app/hooks/useUiDataLoader";

describe("classifyAltSaveResponse", () => {
  it("only an explicit success is a save", () => {
    expect(classifyAltSaveResponse({ success: true })).toEqual({ kind: "saved" });
    expect(classifyAltSaveResponse({ success: false })).toEqual({ kind: "failed", message: "" });
    expect(classifyAltSaveResponse({})).toEqual({ kind: "failed", message: "" });
    expect(classifyAltSaveResponse(undefined)).toEqual({ kind: "failed", message: "" });
  });
  it("carries the server's reason", () => {
    expect(classifyAltSaveResponse({ success: false, error: "Shopify API error" })).toEqual({
      kind: "failed",
      message: "Shopify API error",
    });
  });
});

describe("classifyAltAiResponse", () => {
  it("ok / refused / error", () => {
    expect(classifyAltAiResponse({ success: true, altText: "x" }).kind).toBe("ok");
    expect(classifyAltAiResponse({ altText: "x" }).kind).toBe("ok");
    expect(classifyAltAiResponse({ success: false, code: "AI_BUDGET_EXCEEDED", error: "Budget used up" })).toEqual({
      kind: "refused",
      message: "Budget used up",
    });
    expect(classifyAltAiResponse({ success: false, error: "boom" })).toEqual({ kind: "error", message: "boom" });
  });
});

describe("classifyAllLocalesResponse", () => {
  it("success", () => {
    expect(classifyAllLocalesResponse({ success: true, savedLocales: ["de", "fr"], failedLocales: [] })).toEqual({
      kind: "success",
      savedCount: 2,
    });
  });
  it("partial names the failed locales", () => {
    expect(classifyAllLocalesResponse({ success: true, savedLocales: ["de"], failedLocales: ["fr"] })).toEqual({
      kind: "partial",
      savedCount: 1,
      failedLocales: ["fr"],
    });
  });
  it("falls back to the target list when savedLocales is absent", () => {
    expect(classifyAllLocalesResponse({ success: true, failedLocales: ["fr"] }, ["de", "fr", "es"])).toMatchObject({
      kind: "partial",
      savedCount: 2,
    });
  });
  it("refusal and error", () => {
    expect(classifyAllLocalesResponse({ success: false, code: "AI_CONSENT_REQUIRED", error: "Consent" }).kind).toBe("refused");
    expect(classifyAllLocalesResponse({ success: false, error: "x" })).toEqual({ kind: "error", message: "x" });
    expect(classifyAllLocalesResponse(null)).toEqual({ kind: "error", message: "" });
  });
});

describe("altTranslateTaskStatus", () => {
  it("downgrades on any failure", () => {
    expect(altTranslateTaskStatus(0)).toBe("completed");
    expect(altTranslateTaskStatus(2)).toBe("completed_with_errors");
  });
});

describe("overlay helpers", () => {
  it("writes only saved locales with a value", () => {
    expect(overlayWritesFromTranslations({ de: "a", fr: "b", es: "" }, ["fr"])).toEqual([{ locale: "de", value: "a" }]);
    expect(overlayWritesFromTranslations(undefined, [])).toEqual([]);
  });
  it("indexes per image and skips failed images", () => {
    expect(overlayIndexWrites({ "0": "a", "1": "b", x: "c" }, [1])).toEqual({ 0: "a" });
  });
});

describe("enqueueAltSave", () => {
  it("a newer queued save of the same image and locale replaces the older one", () => {
    const a = { url: "u1", mediaId: "m1", altText: "a", locale: "de" };
    const b = { url: "u2", mediaId: "m2", altText: "b", locale: "de" };
    const a2 = { url: "u1", mediaId: "m1", altText: "a2", locale: "de" };
    expect(enqueueAltSave(enqueueAltSave([a], b), a2)).toEqual([b, a2]);
    expect(enqueueAltSave([a], { ...a2, locale: "fr" })).toHaveLength(2);
  });
});

describe("altSaveScope", () => {
  it("flags a late answer for another product or language", () => {
    expect(altSaveScope({ productId: "p1", locale: "de" }, { productId: "p1", locale: "de" })).toEqual({ sameProduct: true, sameLocale: true, sameMarket: true });
    expect(altSaveScope({ productId: "p1", locale: "de" }, { productId: "p2", locale: "de" }).sameProduct).toBe(false);
    expect(altSaveScope({ productId: "p1", locale: "de" }, { productId: "p1", locale: "fr" }).sameLocale).toBe(false);
    expect(altSaveScope({}, { productId: "p1", locale: "fr" })).toEqual({ sameProduct: true, sameLocale: true, sameMarket: true });
  });
  it("a failed save of market A is not market B's", () => {
    expect(altSaveScope({ locale: "de", marketId: "A" }, { locale: "de", marketId: "B" }).sameMarket).toBe(false);
    expect(altSaveScope({ locale: "de", marketId: "A" }, { locale: "de", marketId: "" }).sameMarket).toBe(false);
    expect(altSaveScope({ locale: "de" }, { locale: "de", marketId: "" }).sameMarket).toBe(true);
    expect(altSaveScope({ locale: "de", marketId: "A" }, { locale: "de", marketId: "A" }).sameMarket).toBe(true);
  });
});

describe("unconfirmed foreign field survives the reload after the save", () => {
  it("keeps the typed text against the restored (previous) baseline", () => {
    const { values, preservedKeys } = preserveUnsavedEdits(
      { a: "A", b: "alt" },
      { a: "A", b: "neu" },
      { a: "A", b: "alt" },
    );
    expect(values.b).toBe("neu");
    expect(preservedKeys).toEqual(["b"]);
  });
});

describe("classifyAllLocalesResponse — no source", () => {
  it("maps the noSourceAltText refusal to its own verdict (worded by the page), not a generic error", () => {
    expect(
      classifyAllLocalesResponse({ success: false, errorCode: "noSourceAltText", error: "No primary-language alt text to translate" }),
    ).toEqual({ kind: "noSource" });
  });
});

describe("knownPrimaryAlt", () => {
  const images = [
    { url: "https://cdn/a.jpg", mediaId: "gid://shopify/MediaImage/1", altText: "Rote Kiste" },
    { url: "https://cdn/b.jpg", mediaId: "gid://shopify/MediaImage/2", altText: null },
  ];
  it("knows a product image by url, else by its media GID (a variant tile's other url)", () => {
    expect(knownPrimaryAlt({ url: "https://cdn/a.jpg", gid: undefined, images })).toBe("Rote Kiste");
    expect(knownPrimaryAlt({ url: "https://cdn/a.jpg?v=2", gid: "gid://shopify/MediaImage/1", images })).toBe("Rote Kiste");
  });
  it("an empty primary alt is KNOWN to be empty", () => {
    expect(knownPrimaryAlt({ url: "https://cdn/b.jpg", gid: null, images })).toBe("");
  });
  it("a media-library file (not one of the product's images) is UNKNOWN, never empty", () => {
    expect(knownPrimaryAlt({ url: "https://cdn/lib.jpg", gid: "gid://shopify/MediaImage/99", images })).toBeUndefined();
  });
});
