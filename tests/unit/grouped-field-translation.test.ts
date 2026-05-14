import { describe, it, expect } from "vitest";
import { normalizeGroupedValue, isGroupedFieldKey } from "../../app/utils/grouped-field.utils";

describe("normalizeGroupedValue", () => {
  it("trims surrounding whitespace", () => {
    expect(normalizeGroupedValue("  Vase  ")).toBe("vase");
  });

  it("collapses multiple spaces", () => {
    expect(normalizeGroupedValue("Schatulle   und  Geschenkbox")).toBe(
      "schatulle und geschenkbox",
    );
  });

  it("lowercases for stable lookup", () => {
    expect(normalizeGroupedValue("Schatulle und Geschenkbox")).toBe(
      "schatulle und geschenkbox",
    );
  });

  it("treats different casings as the same key", () => {
    expect(normalizeGroupedValue("VASE")).toBe(normalizeGroupedValue("vase"));
  });
});

describe("isGroupedFieldKey", () => {
  it("accepts productType", () => {
    expect(isGroupedFieldKey("productType")).toBe(true);
  });

  it("rejects unsupported field keys", () => {
    expect(isGroupedFieldKey("title")).toBe(false);
    expect(isGroupedFieldKey("vendor")).toBe(false);
  });
});
