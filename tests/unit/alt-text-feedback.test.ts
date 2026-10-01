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
} from "../../app/services/alt-text-feedback.shared";

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
    expect(altSaveScope({ productId: "p1", locale: "de" }, { productId: "p1", locale: "de" })).toEqual({ sameProduct: true, sameLocale: true });
    expect(altSaveScope({ productId: "p1", locale: "de" }, { productId: "p2", locale: "de" }).sameProduct).toBe(false);
    expect(altSaveScope({ productId: "p1", locale: "de" }, { productId: "p1", locale: "fr" }).sameLocale).toBe(false);
    expect(altSaveScope({}, { productId: "p1", locale: "fr" })).toEqual({ sameProduct: true, sameLocale: true });
  });
});
