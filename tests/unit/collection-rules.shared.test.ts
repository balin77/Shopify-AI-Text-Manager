/**
 * PLAN_CONTENT_CREATION §7 (Phase 1.4b) — the collection rule model.
 *
 * These tests exist to pin down what was MEASURED against a live shop
 * (PLAN §1.2a), because every one of these properties is something a
 * reasonable person would get wrong from the plan's original draft:
 *
 *   - conditions are a discriminated union, not a {column, relation, value}
 *     triple (that is the legacy `ruleSet` shape)
 *   - each kind carries its OWN relation enum — there is no shared vocabulary
 *   - exclusions can do strictly LESS than inclusions, in both the kinds
 *     available and the relations within a shared kind
 *   - a list condition has its own matchType, on top of the source's — two
 *     levels, and the inner one is what the legacy projection drops
 */

import { describe, it, expect } from "vitest";
import {
  EXCLUSION_CONDITIONS,
  INCLUSION_CONDITIONS,
  MAX_SOURCES,
  RULES_MIN_API_VERSION,
  conditionKind,
  newCondition,
  rulesAvailableOn,
  toConditionInput,
  toSourcesInput,
  validateRuleSources,
  type RuleSource,
} from "~/config/collection-rules.shared";

function source(overrides: Partial<RuleSource> = {}): RuleSource {
  return {
    title: "Rule set 1",
    inclusion: {
      matchType: "ALL",
      conditions: [{ localId: "c1", kind: "productTag", relation: "TAGGED_WITH", value: "sale", matchType: "ANY" }],
    },
    ...overrides,
  };
}

describe("rulesAvailableOn", () => {
  it("needs 2026-07 — sources[] does not exist before it", () => {
    expect(rulesAvailableOn("2025-10")).toBe(false);
    expect(rulesAvailableOn("2026-04")).toBe(false);
    expect(rulesAvailableOn(RULES_MIN_API_VERSION)).toBe(true);
    expect(rulesAvailableOn("2026-10")).toBe(true);
    expect(rulesAvailableOn("unstable")).toBe(true);
  });

  it("refuses a version it does not know rather than assuming", () => {
    expect(rulesAvailableOn("")).toBe(false);
    expect(rulesAvailableOn("2099-01")).toBe(false);
  });
});

describe("the measured condition kinds", () => {
  it("gives each kind its OWN relations", () => {
    // The trap: assuming a shared vocabulary. productTag does not know EQUALS.
    expect(conditionKind("inclusion", "productTag")!.relations).toEqual(["TAGGED_WITH", "NOT_TAGGED_WITH"]);
    expect(conditionKind("inclusion", "productTitle")!.relations).toContain("CONTAINS");
    expect(conditionKind("inclusion", "productTitle")!.relations).not.toContain("TAGGED_WITH");
    expect(conditionKind("inclusion", "metafieldString")!.relations).toEqual(["EQUALS"]);
  });

  it("lets exclusions do strictly LESS than inclusions", () => {
    // Not a subset by accident — deriving the exclusion list from the
    // inclusion one would generate combinations Shopify rejects.
    const inclusionKeys = INCLUSION_CONDITIONS.map((k) => k.key);
    const exclusionKeys = EXCLUSION_CONDITIONS.map((k) => k.key);
    expect(inclusionKeys).toContain("productTitle");
    expect(exclusionKeys).not.toContain("productTitle");

    // Same kind, fewer relations on the exclusion side.
    expect(conditionKind("inclusion", "productType")!.relations.length).toBeGreaterThan(
      conditionKind("exclusion", "productType")!.relations.length,
    );
    expect(conditionKind("exclusion", "productTag")!.relations).toEqual(["TAGGED_WITH"]);
  });

  it("has one kind with no relation at all", () => {
    // Excluding by collection is just a list of ids.
    expect(conditionKind("exclusion", "collection")!.relations).toEqual([]);
  });
});

describe("validateRuleSources", () => {
  it("accepts a plain single-condition source", () => {
    expect(validateRuleSources([source()])).toEqual([]);
  });

  it("rejects a source with no inclusion conditions", () => {
    // It would match nothing, which is never what someone building one meant.
    const errors = validateRuleSources([source({ inclusion: { matchType: "ALL", conditions: [] } })]);
    expect(errors).toContainEqual({ sourceIndex: 0, code: "noConditions" });
  });

  it("rejects a relation that belongs to a DIFFERENT kind", () => {
    const errors = validateRuleSources([
      source({
        inclusion: {
          matchType: "ALL",
          conditions: [{ localId: "c1", kind: "productTag", relation: "CONTAINS", value: "x" }],
        },
      }),
    ]);
    expect(errors).toContainEqual({ sourceIndex: 0, conditionId: "c1", code: "unknownRelation", detail: "productTag.CONTAINS" });
  });

  it("rejects an exclusion relation that only exists on the inclusion side", () => {
    // The asymmetry, enforced. Excluding by productType has two relations.
    const errors = validateRuleSources([
      source({
        exclusion: {
          matchType: "ANY",
          conditions: [{ localId: "e1", kind: "productType", relation: "STARTS_WITH", value: "x" }],
        },
      }),
    ]);
    expect(errors.some((e) => e.conditionId === "e1" && e.code === "unknownRelation")).toBe(true);
  });

  it("rejects a kind the exclusion side does not have at all", () => {
    const errors = validateRuleSources([
      source({
        exclusion: {
          matchType: "ANY",
          conditions: [{ localId: "e1", kind: "productTitle", relation: "EQUALS", value: "x" }],
        },
      }),
    ]);
    expect(errors).toContainEqual({ sourceIndex: 0, conditionId: "e1", code: "unknownKind", detail: "exclusion.productTitle" });
  });

  it("requires a definition id for metafield conditions", () => {
    const errors = validateRuleSources([
      source({
        inclusion: {
          matchType: "ALL",
          conditions: [{ localId: "c1", kind: "metafieldString", relation: "EQUALS", value: "x", definitionId: "" }],
        },
      }),
    ]);
    expect(errors).toContainEqual({ sourceIndex: 0, conditionId: "c1", code: "missingDefinition" });
  });

  it("allows IS_SET to carry no value, and requires one otherwise", () => {
    const isSet = validateRuleSources([
      source({
        inclusion: {
          matchType: "ALL",
          conditions: [{ localId: "c1", kind: "variantCompareAtPrice", relation: "IS_SET", value: "" }],
        },
      }),
    ]);
    expect(isSet).toEqual([]);

    const needsValue = validateRuleSources([
      source({
        inclusion: {
          matchType: "ALL",
          conditions: [{ localId: "c1", kind: "variantPrice", relation: "GREATER_THAN", value: "" }],
        },
      }),
    ]);
    expect(needsValue).toContainEqual({ sourceIndex: 0, conditionId: "c1", code: "emptyValue" });
  });

  it("does NOT validate a source it cannot render", () => {
    // §2.4's read-only rule: an untouched pass-through is not held to this
    // editor's grammar. Holding it there would block a save over a rule the
    // merchant never edited.
    const errors = validateRuleSources([
      { title: "", inclusion: { matchType: "ALL", conditions: [] }, unrenderable: { reason: "subCollections", raw: {} } },
    ]);
    expect(errors).toEqual([]);
  });

  /**
   * The values that are not free text. Every one of these fails at the SCHEMA
   * level — `data: null`, no `userErrors` — so without this gate the merchant
   * gets the generic "rules could not be saved" and no field to look at. Two
   * of them do not even fail: `NaN` and a boolean that is not `"true"` save
   * quietly and mean something else.
   */
  it("rejects a value the enum, the number or the unit does not have", () => {
    const withCondition = (condition: Record<string, unknown>) =>
      validateRuleSources([
        source({
          inclusion: {
            matchType: "ALL",
            conditions: [{ localId: "c1", relation: "EQUALS", ...condition } as never],
          },
        }),
      ]);

    const invalid = (detail: string) => ({ sourceIndex: 0, conditionId: "c1", code: "invalidValue", detail });

    expect(withCondition({ kind: "productStatus", value: "ACTIVE, DRAFT" })).toEqual([]);
    expect(withCondition({ kind: "productStatus", value: "ACTIV" })).toContainEqual(invalid("productStatus.value"));

    // `Number.parseFloat("about 2")` is NaN, and NaN serialises to `null`
    // into a `Float!`.
    expect(withCondition({ kind: "variantWeight", value: "2.5", weightUnit: "GRAMS" })).toEqual([]);
    expect(withCondition({ kind: "variantWeight", value: "about 2", weightUnit: "GRAMS" })).toContainEqual(
      invalid("variantWeight.value"),
    );
    expect(withCondition({ kind: "variantWeight", value: "2", weightUnit: "STONES" })).toContainEqual(
      invalid("variantWeight.weightUnit"),
    );
    // A MISSING unit is refused too: `toConditionInput` would write KILOGRAMS
    // for it, and 2 kilograms is not 2 of whatever was meant.
    expect(withCondition({ kind: "variantWeight", value: "2" })).toContainEqual(invalid("variantWeight.weightUnit"));

    // A whole number, not a truncated one: `parseInt("2.5")` is 2, and the
    // rule would silently match different products than the one typed.
    expect(withCondition({ kind: "variantInventory", value: "2.5" })).toContainEqual(invalid("variantInventory.value"));

    expect(withCondition({ kind: "variantPrice", value: "19.90", currencyCode: "CHF" })).toEqual([]);
    expect(withCondition({ kind: "variantPrice", value: "19.90", currencyCode: "Swiss" })).toContainEqual(
      invalid("variantPrice.currencyCode"),
    );

    // `"yes" === "true"` is false — this one saves and means the opposite.
    expect(
      withCondition({ kind: "metafieldBoolean", value: "yes", definitionId: "gid://shopify/MetafieldDefinition/1" }),
    ).toContainEqual(invalid("metafieldBoolean.value"));
  });

  it("REFUSES a malformed payload instead of throwing on it", () => {
    // Both write paths hand this client JSON and are POST-reachable. A
    // TypeError in the gate would surface as a 500 on a save whose text edits
    // had already landed — the gate would be what loses the merchant's work.
    expect(validateRuleSources([{ title: "No sides" } as never]).some((e) => e.code === "noConditions")).toBe(true);
    expect(validateRuleSources([null as never]).some((e) => e.code === "noConditions")).toBe(true);
    expect(validateRuleSources(null as never)).toHaveLength(1);
    expect(
      validateRuleSources([
        source({ inclusion: { matchType: "ALL", conditions: [{ localId: "c1", kind: "productTag", relation: "TAGGED_WITH" } as never] } }),
      ]).some((e) => e.code === "emptyValue"),
    ).toBe(true);
  });

  it("caps the number of sources", () => {
    const many = Array.from({ length: MAX_SOURCES + 1 }, () => source());
    expect(validateRuleSources(many).some((e) => e.code === "tooManySources")).toBe(true);
  });
});

describe("toConditionInput", () => {
  it("nests a list condition with its OWN matchType", () => {
    // The second level — the one the legacy ruleSet projection drops.
    expect(
      toConditionInput("inclusion", { localId: "c1", kind: "productTag", relation: "TAGGED_WITH", value: "a, b", matchType: "ALL" }),
    ).toEqual({ productTag: { relation: "TAGGED_WITH", values: ["a", "b"], matchType: "ALL" } });
  });

  it("sends a scalar condition as a scalar", () => {
    expect(
      toConditionInput("inclusion", { localId: "c1", kind: "variantInventory", relation: "LESS_THAN", value: "5" }),
    ).toEqual({ variantInventory: { relation: "LESS_THAN", value: 5 } });
  });

  it("omits the value for IS_SET", () => {
    const input = toConditionInput("inclusion", { localId: "c1", kind: "variantCompareAtPrice", relation: "IS_SET", value: "" });
    expect(input).toEqual({ variantCompareAtPrice: { relation: "IS_SET" } });
  });

  it("carries the definition id for metafield conditions", () => {
    const input = toConditionInput("inclusion", {
      localId: "c1",
      kind: "metafieldStringList",
      relation: "INCLUDES",
      value: "red,blue",
      matchType: "ANY",
      definitionId: "gid://shopify/MetafieldDefinition/1",
    });
    expect(input).toMatchObject({
      metafieldStringList: { definitionId: "gid://shopify/MetafieldDefinition/1", values: ["red", "blue"] },
    });
  });

  it("returns null for a kind the side does not have", () => {
    expect(toConditionInput("exclusion", { localId: "c1", kind: "productTitle", relation: "EQUALS", value: "x" })).toBeNull();
  });
});

describe("toSourcesInput", () => {
  it("builds the nested source/inclusion shape", () => {
    const [built] = toSourcesInput([source()]);
    expect(built).toMatchObject({
      source: {
        title: "Rule set 1",
        inclusion: { matchType: "ALL", conditions: [{ productTag: { relation: "TAGGED_WITH" } }] },
      },
    });
  });

  it("omits an empty exclusion rather than sending a hollow one", () => {
    const [built] = toSourcesInput([source({ exclusion: { matchType: "ANY", conditions: [] } })]);
    expect((built.source as Record<string, unknown>).exclusion).toBeUndefined();
  });

  it("OMITS a source it cannot render, so Shopify leaves it untouched", () => {
    // This is §2.4's read-only rule at the point where it bites. Sources are
    // edited by diff, so leaving one out of the payload leaves it alone —
    // whereas rewriting it would change a collection's membership silently.
    const built = toSourcesInput([
      source(),
      { title: "shared", inclusion: { matchType: "ALL", conditions: [] }, unrenderable: { reason: "shareableSource", raw: {} } },
    ]);
    expect(built).toHaveLength(1);
  });
});

describe("newCondition", () => {
  it("starts on a relation the kind actually has", () => {
    expect(newCondition("inclusion", "productTag", "c1").relation).toBe("TAGGED_WITH");
    expect(newCondition("exclusion", "productType", "c1").relation).toBe("EQUALS");
  });

  it("gives list kinds a matchType and scalar kinds none", () => {
    expect(newCondition("inclusion", "productTag", "c1").matchType).toBe("ANY");
    expect(newCondition("inclusion", "variantPrice", "c1").matchType).toBeUndefined();
  });

  it("prepares a definition slot only where one is needed", () => {
    expect(newCondition("inclusion", "metafieldString", "c1").definitionId).toBe("");
    expect(newCondition("inclusion", "productTag", "c1").definitionId).toBeUndefined();
  });
});
