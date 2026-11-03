import { describe, it, expect } from "vitest";
import { fingerprintStrings, viewContentFingerprint } from "~/services/editor/content-fingerprint.shared";

describe("content fingerprint", () => {
  it("tells two same-length values apart", () => {
    expect(fingerprintStrings(["noir"])).not.toBe(fingerprintStrings(["bleu"]));
  });
  it("does not confuse a split of the same text", () => {
    expect(fingerprintStrings(["ab", "c"])).not.toBe(fingerprintStrings(["a", "bc"]));
  });
  it("is stable for equal input", () => {
    expect(fingerprintStrings(["x", "y"])).toBe(fingerprintStrings(["x", "y"]));
  });
  const base = {
    locale: "fr",
    translations: [{ key: "title", locale: "fr", value: "noir" }, { key: "title", locale: "es", value: "negro" }],
    marketTranslations: { m1: { title: { fr: "noir CH" } } },
    primaryValues: ["rouge"],
  };
  it("moves when this language's value, a market override or a primary value changes", () => {
    const f = viewContentFingerprint(base);
    expect(viewContentFingerprint({ ...base, translations: [{ key: "title", locale: "fr", value: "bleu" }, base.translations[1]] })).not.toBe(f);
    expect(viewContentFingerprint({ ...base, marketTranslations: { m1: { title: { fr: "bleu CH" } } } })).not.toBe(f);
    expect(viewContentFingerprint({ ...base, primaryValues: ["verte"] })).not.toBe(f);
  });
  it("does not move when only another language changes", () => {
    const f = viewContentFingerprint(base);
    expect(viewContentFingerprint({ ...base, translations: [base.translations[0], { key: "title", locale: "es", value: "azul!" }] })).toBe(f);
  });
});
