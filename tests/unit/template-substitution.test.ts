import { describe, it, expect } from "vitest";
import {
  substituteTemplateVariables,
  extractTemplateVariables,
} from "~/utils/template-substitution.utils";

describe("extractTemplateVariables", () => {
  it("returns distinct names in first-seen order", () => {
    expect(
      extractTemplateVariables("{{a}} {{ b }} {{a}} text {{c_1}}"),
    ).toEqual(["a", "b", "c_1"]);
  });

  it("returns [] for empty / placeholder-free input", () => {
    expect(extractTemplateVariables("")).toEqual([]);
    expect(extractTemplateVariables("no vars here")).toEqual([]);
  });

  it("ignores inner whitespace differences", () => {
    expect(extractTemplateVariables("{{name}}{{ name }}")).toEqual(["name"]);
  });
});

describe("substituteTemplateVariables", () => {
  it("replaces known placeholders and tolerates whitespace", () => {
    const r = substituteTemplateVariables(
      "Write a {{ field }} for {{name}}",
      { field: "title", name: "Blue Mug" },
    );
    expect(r.result).toBe("Write a title for Blue Mug");
    expect(r.usedVars.sort()).toEqual(["field", "name"]);
    expect(r.missingVars).toEqual([]);
  });

  it("leaves unknown placeholders intact and reports them", () => {
    const r = substituteTemplateVariables("{{a}} and {{b}}", { a: "X" });
    expect(r.result).toBe("X and {{b}}");
    expect(r.usedVars).toEqual(["a"]);
    expect(r.missingVars).toEqual(["b"]);
  });

  it("treats empty string as a valid (used) value, not missing", () => {
    const r = substituteTemplateVariables("[{{x}}]", { x: "" });
    expect(r.result).toBe("[]");
    expect(r.usedVars).toEqual(["x"]);
    expect(r.missingVars).toEqual([]);
  });

  it("treats null/undefined values as missing (placeholder kept)", () => {
    const r = substituteTemplateVariables("{{x}}|{{y}}", {
      x: null,
      y: undefined,
    });
    expect(r.result).toBe("{{x}}|{{y}}");
    expect(r.missingVars.sort()).toEqual(["x", "y"]);
    expect(r.usedVars).toEqual([]);
  });

  it("does not treat an inherited prototype property as provided", () => {
    const r = substituteTemplateVariables("{{toString}}", {});
    expect(r.result).toBe("{{toString}}");
    expect(r.missingVars).toEqual(["toString"]);
  });

  it("replaces every occurrence of a repeated placeholder", () => {
    const r = substituteTemplateVariables("{{a}}-{{a}}-{{a}}", { a: "1" });
    expect(r.result).toBe("1-1-1");
    expect(r.usedVars).toEqual(["a"]);
  });

  it("returns empty result for empty template", () => {
    expect(substituteTemplateVariables("", { a: "1" })).toEqual({
      result: "",
      usedVars: [],
      missingVars: [],
    });
  });
});
