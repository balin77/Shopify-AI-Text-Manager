/**
 * PLAN_METAOBJECT_TAXONOMY_CREATE Phase 1 + 2.
 *
 * The rules under test are the ones whose failure is silent: a serialisation
 * that differs between the create form and the entry editor, a bad GID
 * forwarded to a mutation that answers `data: null` with no `userErrors`, and
 * an attribute name that does not survive normalisation into its handle.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  isMetaobjectTaxonomyListType,
  metaobjectFieldRole,
  isWritableMetaobjectFieldType,
  isTranslatableMetaobjectFieldType,
  formatMetaobjectFieldValue,
  parseMetaobjectFieldInput,
  parseMetaobjectTaxonomyValues,
  serializeMetaobjectTaxonomyValues,
  taxonomyAttributeHandle,
  taxonomyValueBounds,
  metaobjectFieldSpecs,
  METAOBJECT_TYPE_TAXONOMY_VALUE,
  METAOBJECT_TYPE_TAXONOMY_VALUE_LIST,
} from "~/services/metaobject-fields.shared";
import {
  EDITABLE_METAOBJECT_FIELD_TYPES,
  metaobjectCreatability,
  metaobjectFieldDefs,
  metaobjectFieldsPayload,
  validateCreatePayload,
} from "~/config/create-fields.config";
import {
  clearTaxonomyValueCache,
  normalizeTaxonomyHandle,
  taxonomyValuesForHandle,
  taxonomyValueNames,
} from "~/services/taxonomy-values.server";

const COLOR_GID = "gid://shopify/TaxonomyValue/11";
const OTHER_GID = "gid://shopify/TaxonomyValue/2874";

const COLOR_FIELD = {
  key: "color_taxonomy_reference",
  name: "Colour",
  type: { name: METAOBJECT_TYPE_TAXONOMY_VALUE_LIST },
  required: true,
  validations: [
    { name: "product_taxonomy_attribute_handle", value: "color" },
    { name: "list.min", value: "1" },
    { name: "list.max", value: "4" },
  ],
};
const PATTERN_FIELD = {
  key: "pattern_taxonomy_reference",
  name: "Pattern",
  type: { name: METAOBJECT_TYPE_TAXONOMY_VALUE },
  required: true,
  validations: [{ name: "product_taxonomy_attribute_handle", value: "pattern" }],
};
const LABEL_FIELD = {
  key: "label",
  name: "Label",
  type: { name: "single_line_text_field" },
  required: true,
};

describe("metaobject taxonomy fields — role and serialisation", () => {
  it("gives both flavours the taxonomyValue role and makes them writable", () => {
    for (const type of [METAOBJECT_TYPE_TAXONOMY_VALUE, METAOBJECT_TYPE_TAXONOMY_VALUE_LIST]) {
      expect(metaobjectFieldRole(type)).toBe("taxonomyValue");
      expect(isWritableMetaobjectFieldType(type)).toBe(true);
    }
  });

  it("does NOT make them translatable — one value per shop, like a colour", () => {
    // Sent down the foreign chain they would resolve to "" and the next save
    // in a foreign locale would CLEAR the reference.
    for (const type of [METAOBJECT_TYPE_TAXONOMY_VALUE, METAOBJECT_TYPE_TAXONOMY_VALUE_LIST]) {
      expect(isTranslatableMetaobjectFieldType(type)).toBe(false);
    }
  });

  it("shows the stored value verbatim — no display form to parse back", () => {
    const raw = JSON.stringify([COLOR_GID]);
    expect(formatMetaobjectFieldValue(METAOBJECT_TYPE_TAXONOMY_VALUE_LIST, raw)).toBe(raw);
    expect(formatMetaobjectFieldValue(METAOBJECT_TYPE_TAXONOMY_VALUE, COLOR_GID)).toBe(COLOR_GID);
  });

  it("round-trips a list through parse and serialise", () => {
    const raw = JSON.stringify([COLOR_GID, OTHER_GID]);
    const ids = parseMetaobjectTaxonomyValues(METAOBJECT_TYPE_TAXONOMY_VALUE_LIST, raw);
    expect(ids).toEqual([COLOR_GID, OTHER_GID]);
    expect(serializeMetaobjectTaxonomyValues(METAOBJECT_TYPE_TAXONOMY_VALUE_LIST, ids)).toBe(raw);
  });

  it("round-trips a single value without wrapping it in an array", () => {
    const ids = parseMetaobjectTaxonomyValues(METAOBJECT_TYPE_TAXONOMY_VALUE, COLOR_GID);
    expect(ids).toEqual([COLOR_GID]);
    expect(serializeMetaobjectTaxonomyValues(METAOBJECT_TYPE_TAXONOMY_VALUE, ids)).toBe(COLOR_GID);
  });

  it("reads malformed JSON as an EMPTY selection rather than throwing", () => {
    // The control then shows nothing selected and the merchant can fix it; an
    // exception here takes the whole editor down.
    expect(parseMetaobjectTaxonomyValues(METAOBJECT_TYPE_TAXONOMY_VALUE_LIST, "{oops")).toEqual([]);
  });

  it("serialises an empty selection as '' — i.e. CLEAR, Shopify refuses if required", () => {
    expect(serializeMetaobjectTaxonomyValues(METAOBJECT_TYPE_TAXONOMY_VALUE_LIST, [])).toBe("");
    expect(serializeMetaobjectTaxonomyValues(METAOBJECT_TYPE_TAXONOMY_VALUE, [])).toBe("");
  });
});

describe("metaobject taxonomy fields — input validation", () => {
  it("accepts a well-formed reference", () => {
    expect(parseMetaobjectFieldInput(METAOBJECT_TYPE_TAXONOMY_VALUE, COLOR_GID)).toEqual({
      ok: true,
      value: COLOR_GID,
    });
  });

  it("refuses anything that is not a TaxonomyValue GID", () => {
    // A bad value fails at the GraphQL SCHEMA level, which never reaches
    // `userErrors` — forwarding it would make the save read as a success.
    for (const bad of ["Pink", "gid://shopify/Metaobject/1", "gid://shopify/TaxonomyValue/x"]) {
      expect(parseMetaobjectFieldInput(METAOBJECT_TYPE_TAXONOMY_VALUE, bad)).toEqual({
        ok: false,
        error: "invalidTaxonomyValue",
      });
    }
  });

  it("refuses a list with one bad entry rather than dropping it silently", () => {
    const raw = JSON.stringify([COLOR_GID, "not-a-gid"]);
    expect(parseMetaobjectFieldInput(METAOBJECT_TYPE_TAXONOMY_VALUE_LIST, raw)).toEqual({
      ok: false,
      error: "invalidTaxonomyValue",
    });
  });

  it("treats an empty value as CLEAR, not as malformed", () => {
    expect(parseMetaobjectFieldInput(METAOBJECT_TYPE_TAXONOMY_VALUE, "")).toEqual({ ok: true, value: "" });
  });
});

describe("metaobject taxonomy fields — validations from the definition", () => {
  it("reads the attribute handle, and reports its absence as null", () => {
    expect(taxonomyAttributeHandle(COLOR_FIELD.validations)).toBe("color");
    expect(taxonomyAttributeHandle([])).toBeNull();
    expect(taxonomyAttributeHandle(undefined)).toBeNull();
  });

  it("reads list bounds from the validations rather than hardcoding them", () => {
    expect(taxonomyValueBounds(METAOBJECT_TYPE_TAXONOMY_VALUE_LIST, COLOR_FIELD.validations)).toEqual({
      min: 1,
      max: 4,
    });
  });

  it("caps a NON-list field at exactly one", () => {
    expect(taxonomyValueBounds(METAOBJECT_TYPE_TAXONOMY_VALUE, PATTERN_FIELD.validations)).toEqual({
      min: null,
      max: 1,
    });
  });

  it("carries handle and bounds onto the field spec the editor renders from", () => {
    const specs = metaobjectFieldSpecs(
      { id: "gid://shopify/Metaobject/1", fields: [{ key: "color_taxonomy_reference", value: JSON.stringify([COLOR_GID]) }] },
      [COLOR_FIELD, PATTERN_FIELD],
    );
    const colour = specs.find((s) => s.fieldKey === "color_taxonomy_reference");
    expect(colour?.taxonomy).toEqual({ handle: "color", isList: true, min: 1, max: 4 });
    expect(isMetaobjectTaxonomyListType(colour!.fieldType)).toBe(true);
  });

  it("gives a field the definition does not describe handle: null, never a guess", () => {
    // An entry-only field carries no validations; "we cannot name the
    // attribute" and "there are no values" must not look the same.
    const specs = metaobjectFieldSpecs(
      {
        id: "gid://shopify/Metaobject/1",
        fields: [{ key: "ghost", value: COLOR_GID, type: METAOBJECT_TYPE_TAXONOMY_VALUE }],
      },
      [],
    );
    expect(specs[0]?.taxonomy).toEqual({ handle: null, isList: false, min: null, max: 1 });
  });
});

describe("create form — Phase 2 unlocks the standard definitions", () => {
  it("lists both taxonomy types as collectable", () => {
    expect(EDITABLE_METAOBJECT_FIELD_TYPES).toContain(METAOBJECT_TYPE_TAXONOMY_VALUE);
    expect(EDITABLE_METAOBJECT_FIELD_TYPES).toContain(METAOBJECT_TYPE_TAXONOMY_VALUE_LIST);
  });

  it("makes shopify--color-pattern creatable — THE switch of Phase 2", () => {
    expect(metaobjectCreatability([LABEL_FIELD, COLOR_FIELD, PATTERN_FIELD])).toEqual({ creatable: true });
  });

  it("builds a taxonomyValue field carrying the field key, type and bounds", () => {
    const defs = metaobjectFieldDefs([LABEL_FIELD, COLOR_FIELD, PATTERN_FIELD]);
    const colour = defs.find((d) => d.key === "field.color_taxonomy_reference");
    expect(colour?.kind).toBe("taxonomyValue");
    expect(colour?.taxonomy).toEqual({
      fieldKey: "color_taxonomy_reference",
      fieldType: METAOBJECT_TYPE_TAXONOMY_VALUE_LIST,
      isList: true,
      min: 1,
      max: 4,
    });
    // NOT `listValue`: that flag means "serialise a comma-separated string
    // here", and the picker already hands over the stored form.
    expect(colour?.listValue).toBeUndefined();
  });

  it("passes the picker's value through unchanged — same bytes as the editor writes", () => {
    const defs = metaobjectFieldDefs([COLOR_FIELD, PATTERN_FIELD]);
    const raw = JSON.stringify([COLOR_GID, OTHER_GID]);
    const payload = metaobjectFieldsPayload(defs, {
      "field.color_taxonomy_reference": raw,
      "field.pattern_taxonomy_reference": OTHER_GID,
    });
    expect(payload).toEqual([
      { key: "color_taxonomy_reference", value: raw },
      { key: "pattern_taxonomy_reference", value: OTHER_GID },
    ]);
  });

  it("rejects a non-taxonomy value SERVER-side, before it can reach the mutation", () => {
    const defs = metaobjectFieldDefs([COLOR_FIELD, PATTERN_FIELD]);
    const errors = validateCreatePayload(
      "metaobject",
      { type: "shopify--color-pattern", "field.pattern_taxonomy_reference": "Solid" },
      defs,
    );
    expect(errors).toContainEqual({
      field: "field.pattern_taxonomy_reference",
      code: "invalidTaxonomyValue",
      detail: "Solid",
    });
  });

  it("enforces list.max server-side, under its OWN code", () => {
    // Its own code because one code cannot carry three sentences: "not a
    // taxonomy value", "too many" and "too few" need different remedies, and
    // the shared phrasing told a merchant who had picked five values to "pick
    // a value from the list".
    const defs = metaobjectFieldDefs([COLOR_FIELD]);
    const five = JSON.stringify(Array.from({ length: 5 }, (_, i) => `gid://shopify/TaxonomyValue/${i + 1}`));
    const errors = validateCreatePayload(
      "metaobject",
      { type: "shopify--color-pattern", "field.color_taxonomy_reference": five },
      defs,
    );
    // The detail is the BOUND, so the message can read "at most 4".
    expect(errors).toContainEqual({
      field: "field.color_taxonomy_reference",
      code: "tooManyTaxonomyValues",
      detail: "4",
    });
  });

  it("enforces list.min server-side, under its own code too", () => {
    const defs = metaobjectFieldDefs([COLOR_FIELD]);
    const errors = validateCreatePayload(
      "metaobject",
      { type: "shopify--color-pattern", "field.color_taxonomy_reference": "[]" },
      defs,
    );
    // An empty JSON array is not a CLEAR here — the field is required, so it
    // fails, and it must not be reported as a malformed GID.
    expect(errors.some((e) => e.code === "invalidTaxonomyValue" || e.code === "tooFewTaxonomyValues")).toBe(true);
  });

  it("accepts a payload within the bounds", () => {
    const defs = metaobjectFieldDefs([COLOR_FIELD, PATTERN_FIELD]);
    const errors = validateCreatePayload(
      "metaobject",
      {
        type: "shopify--color-pattern",
        "field.color_taxonomy_reference": JSON.stringify([COLOR_GID]),
        "field.pattern_taxonomy_reference": OTHER_GID,
      },
      defs,
    );
    expect(errors).toEqual([]);
  });
});

describe("create form — the colour field", () => {
  const COLOR_HEX_FIELD = {
    key: "color",
    name: "Colour",
    type: { name: "color" },
    required: false,
  };

  it("offers a colour control instead of skipping the field", () => {
    // Without it a new colour entry came out WITHOUT its colour, and the
    // storefront swatch derived from it stayed empty until the merchant
    // reopened the entry and set it by hand.
    const defs = metaobjectFieldDefs([LABEL_FIELD, COLOR_HEX_FIELD]);
    expect(defs.find((d) => d.key === "field.color")?.kind).toBe("color");
  });

  it("adds the missing '#' rather than refusing it — same as the entry editor", () => {
    const defs = metaobjectFieldDefs([COLOR_HEX_FIELD]);
    expect(metaobjectFieldsPayload(defs, { "field.color": "ffd700" })).toEqual([
      { key: "color", value: "#ffd700" },
    ]);
  });

  it("leaves an empty colour out of the payload rather than sending ''", () => {
    // `metafieldsSet` rejects an empty value; "not set" is an absent key.
    const defs = metaobjectFieldDefs([COLOR_HEX_FIELD]);
    expect(metaobjectFieldsPayload(defs, { "field.color": "" })).toEqual([]);
  });

  it("refuses a non-hex value SERVER-side", () => {
    const defs = metaobjectFieldDefs([COLOR_HEX_FIELD]);
    const errors = validateCreatePayload(
      "metaobject",
      { type: "shopify--color-pattern", "field.color": "gold" },
      defs,
    );
    expect(errors).toContainEqual({ field: "field.color", code: "invalidColor", detail: "gold" });
  });

  it("accepts every hex shape the swatch preview can paint", () => {
    const defs = metaobjectFieldDefs([COLOR_HEX_FIELD]);
    for (const value of ["#fff", "#FFD700", "#ffd700ff", "ffd700"]) {
      const errors = validateCreatePayload(
        "metaobject",
        { type: "shopify--color-pattern", "field.color": value },
        defs,
      );
      expect(errors, value).toEqual([]);
    }
  });
});

describe("taxonomy value lookup", () => {
  beforeEach(() => clearTaxonomyValueCache());

  const attributesResponse = (name: string) => ({
    data: {
      taxonomy: {
        categories: {
          nodes: [
            {
              id: "gid://shopify/TaxonomyCategory/aa",
              attributes: {
                nodes: [{ __typename: "TaxonomyChoiceListAttribute", id: "gid://shopify/TaxonomyAttribute/1", name }],
              },
            },
          ],
        },
      },
    },
  });
  const valuesResponse = {
    data: {
      nodes: [
        {
          __typename: "TaxonomyChoiceListAttribute",
          id: "gid://shopify/TaxonomyAttribute/1",
          name: "Color",
          values: { nodes: [{ id: COLOR_GID, name: "Pink" }] },
        },
      ],
    },
  };

  const adminReturning = (...bodies: unknown[]) => {
    const graphql = vi.fn();
    for (const body of bodies) {
      graphql.mockResolvedValueOnce({ json: async () => body } as unknown as Response);
    }
    return { graphql };
  };

  it("normalises an attribute name onto its handle, including the slash case", () => {
    // "Bag/Case storage features" has to match `bag-case-storage-features`;
    // a space-only rule gets exactly this one wrong.
    expect(normalizeTaxonomyHandle("Bag/Case storage features")).toBe("bag-case-storage-features");
    expect(normalizeTaxonomyHandle("Tool/Utensil material")).toBe("tool-utensil-material");
    expect(normalizeTaxonomyHandle("Color")).toBe("color");
  });

  it("finds the attribute and reads its values", async () => {
    const admin = adminReturning(attributesResponse("Color"), valuesResponse);
    const result = await taxonomyValuesForHandle(admin, "color");
    expect(result).toEqual({
      known: true,
      attributeName: "Color",
      values: [{ id: COLOR_GID, name: "Pink" }],
      truncated: false,
    });
  });

  it("memoises a SUCCESSFUL lookup so a page of entries pays for one sweep", async () => {
    const admin = adminReturning(attributesResponse("Color"), valuesResponse);
    await taxonomyValuesForHandle(admin, "color");
    await taxonomyValuesForHandle(admin, "color");
    expect(admin.graphql).toHaveBeenCalledTimes(2);
  });

  it("reports a MISS as attributeNotFound after trying every search term", async () => {
    // Three bounded rounds: no search, the handle's words, its first word.
    const admin = adminReturning(
      attributesResponse("Something else"),
      attributesResponse("Something else"),
      attributesResponse("Something else"),
    );
    const result = await taxonomyValuesForHandle(admin, "vase-shape");
    expect(result).toEqual({ known: false, reason: "attributeNotFound" });
  });

  it("reports a FAILED call as lookupFailed, never as 'there are no values'", async () => {
    const admin = adminReturning(
      { errors: [{ message: "Throttled" }] },
      { errors: [{ message: "Throttled" }] },
      { errors: [{ message: "Throttled" }] },
    );
    const result = await taxonomyValuesForHandle(admin, "vase-shape");
    expect(result.known).toBe(false);
    expect(result).toMatchObject({ reason: "lookupFailed" });
  });

  it("reports a PARTLY failed sweep as lookupFailed, not as 'not found'", async () => {
    // Round 1 is the no-search round, and that is where Color and Pattern were
    // measured to live. One throttled round + one clean miss must not produce
    // a definitive statement about the merchant's definition.
    const admin = adminReturning(
      { errors: [{ message: "Throttled" }] },
      attributesResponse("Something else"),
      attributesResponse("Something else"),
    );
    const result = await taxonomyValuesForHandle(admin, "vase-shape");
    expect(result).toMatchObject({ known: false, reason: "lookupFailed" });
  });

  it("memoises attributeNotFound — it is an answer, unlike a failed call", async () => {
    const admin = adminReturning(
      attributesResponse("Something else"),
      attributesResponse("Something else"),
      attributesResponse("Something else"),
    );
    await taxonomyValuesForHandle(admin, "vase-shape");
    const calls = admin.graphql.mock.calls.length;
    // A page of 25 entries must not re-run the three-round sweep 25 times.
    await taxonomyValuesForHandle(admin, "vase-shape");
    expect(admin.graphql).toHaveBeenCalledTimes(calls);
  });

  it("does NOT memoise a failure — one throttled minute must not last an hour", async () => {
    const failing = adminReturning({ errors: [{ message: "Throttled" }] });
    await taxonomyValuesForHandle(failing, "color");
    const working = adminReturning(attributesResponse("Color"), valuesResponse);
    const result = await taxonomyValuesForHandle(working, "color");
    expect(result.known).toBe(true);
  });

  it("treats an EMPTY values connection as a failed path, not as a count", async () => {
    const admin = adminReturning(attributesResponse("Color"), {
      data: { nodes: [{ __typename: "TaxonomyChoiceListAttribute", values: { nodes: [] } }] },
    });
    const result = await taxonomyValuesForHandle(admin, "color");
    expect(result).toMatchObject({ known: false, reason: "lookupFailed" });
  });

  it("resolves stored GIDs to names, and returns {} rather than throwing on failure", async () => {
    const ok = adminReturning({
      data: { nodes: [{ __typename: "TaxonomyValue", id: COLOR_GID, name: "Pink" }] },
    });
    expect(await taxonomyValueNames(ok, [COLOR_GID, COLOR_GID])).toEqual({ [COLOR_GID]: "Pink" });

    const bad = adminReturning({ errors: [{ message: "nope" }] });
    expect(await taxonomyValueNames(bad, [COLOR_GID])).toEqual({});
  });
});

describe("deleting a metaobject DEFINITION", () => {
  it("is its own deletable resource, never reusing 'metaobject'", async () => {
    // Reusing the entry kind is how this page once grew a Delete button that
    // 400ed: a `metaobject_type_<type>` row is not a Metaobject GID, and the
    // id check is what catches a client that confuses them.
    const { GID_TYPE_BY_RESOURCE, isGidOfResource } = await import("~/config/create-fields.config");
    expect(GID_TYPE_BY_RESOURCE.metaobjectDefinition).toBe("MetaobjectDefinition");
    expect(isGidOfResource("gid://shopify/MetaobjectDefinition/9", "metaobjectDefinition")).toBe(true);
    // The two must not be interchangeable in either direction.
    expect(isGidOfResource("gid://shopify/Metaobject/9", "metaobjectDefinition")).toBe(false);
    expect(isGidOfResource("gid://shopify/MetaobjectDefinition/9", "metaobject")).toBe(false);
    expect(isGidOfResource("metaobject_type_shopify--color-pattern", "metaobjectDefinition")).toBe(false);
  });

  it("is NOT creatable — Shopify has a create API, this app deliberately has no form", async () => {
    const { CREATE_SPECS } = await import("~/config/create-fields.config");
    expect(Object.keys(CREATE_SPECS)).not.toContain("metaobjectDefinition");
  });
});

describe("deleting a type — the plan gate and the content type", () => {
  it("maps every deletable resource to a plan content type", async () => {
    const { planContentTypeForDelete } = await import("~/config/create-fields.config");
    // The definition has no create spec — this app offers no form for one —
    // so it needs its own answer rather than an index into CREATE_SPECS.
    expect(planContentTypeForDelete("metaobjectDefinition")).toBe("metaobjects");
    // Everything else derives from the create spec, so the two gates cannot
    // disagree about which plan may touch a type.
    expect(planContentTypeForDelete("metaobject")).toBe("metaobjects");
    expect(planContentTypeForDelete("product")).toBe("products");
    expect(planContentTypeForDelete("blog")).toBe("blogs");
  });
});

describe("base colour suggestions", () => {
  it("has no entry for Clear or Multicolor — neither is a colour", async () => {
    // Inventing a hex would put a specific shade behind a name that denies
    // having one.
    const { baseColorFor } = await import("~/services/base-colors.shared");
    expect(baseColorFor("Clear")).toBeNull();
    expect(baseColorFor("Multicolor")).toBeNull();
  });

  it("matches a taxonomy value's name case-insensitively", async () => {
    const { baseColorFor } = await import("~/services/base-colors.shared");
    expect(baseColorFor("Gold")?.hex).toBe("#ffd700");
    expect(baseColorFor("  rose GOLD ")?.hex).toBe("#b76e79");
  });

  it("marks only the values that have no CSS keyword as a convention", async () => {
    // The distinction is the honesty of the tooltip: "the standard says
    // #FFD700" and "we picked a bronze" are different claims.
    const { BASE_COLOR_SUGGESTIONS } = await import("~/services/base-colors.shared");
    const conventions = BASE_COLOR_SUGGESTIONS.filter((c) => c.convention).map((c) => c.name);
    expect(conventions.sort()).toEqual(["Bronze", "Rose gold"]);
  });

  it("offers only values this app's own hex pattern accepts", async () => {
    // A suggestion the swatch preview cannot paint would be a one-click way
    // into an invalid field.
    const { BASE_COLOR_SUGGESTIONS } = await import("~/services/base-colors.shared");
    const { METAOBJECT_HEX_PATTERN } = await import("~/services/metaobject-fields.shared");
    for (const colour of BASE_COLOR_SUGGESTIONS) {
      expect(METAOBJECT_HEX_PATTERN.test(colour.hex), colour.name).toBe(true);
    }
  });

  it("has no duplicate names", async () => {
    const { BASE_COLOR_SUGGESTIONS } = await import("~/services/base-colors.shared");
    const names = BASE_COLOR_SUGGESTIONS.map((c) => c.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("the pulsing language buttons — compound keys, not bare GIDs", () => {
  const ENTRY = {
    id: "gid://shopify/Metaobject/1",
    displayName: "Gold",
    fields: [
      { key: "label", value: "Gold", type: "single_line_text_field" },
      { key: "color", value: "#ffd700", type: "color" },
      { key: "color_taxonomy_reference", value: JSON.stringify([COLOR_GID]), type: METAOBJECT_TYPE_TAXONOMY_VALUE_LIST },
    ],
  };
  const DEFS = [LABEL_FIELD, { key: "color", name: "Colour", type: { name: "color" }, required: false }, COLOR_FIELD];

  it("enumerates translatable fields under the COMPOUND key", async () => {
    // The whole defect in one assertion: the language bar looked for a
    // translation stored under the bare GID, which nothing has written since
    // a field became `<gid>#<fieldKey>`. It therefore found none, ever.
    const { metaobjectTranslatableFields } = await import("~/services/metaobject-fields.shared");
    const fields = metaobjectTranslatableFields([ENTRY], DEFS);
    expect(fields.map((f) => f.compoundKey)).toEqual(["gid://shopify/Metaobject/1#label"]);
    expect(fields[0].compoundKey).not.toBe(ENTRY.id);
  });

  it("leaves out the fields that have no per-locale form at all", async () => {
    // A colour and a taxonomy reference have one value per shop. Counting them
    // as untranslated would keep the pulse permanent for a different reason.
    const { metaobjectTranslatableFields } = await import("~/services/metaobject-fields.shared");
    const keys = metaobjectTranslatableFields([ENTRY], DEFS).map((f) => f.compoundKey);
    expect(keys.some((k) => k.endsWith("#color"))).toBe(false);
    expect(keys.some((k) => k.endsWith("#color_taxonomy_reference"))).toBe(false);
  });

  it("reports a locale as complete once the compound key carries a translation", async () => {
    const { hasLocaleMissingTranslations } = await import("~/utils/field-validation.utils");
    const item = {
      id: "metaobject_type_shopify--color-pattern",
      metaobjects: [ENTRY],
      fieldDefinitions: DEFS,
      translations: [{ key: "gid://shopify/Metaobject/1#label", value: "Or", locale: "fr" }],
    } as never;
    expect(hasLocaleMissingTranslations(item, "fr", "de", "metaobjects")).toBe(false);
    // And still reports a locale that genuinely has nothing.
    expect(hasLocaleMissingTranslations(item, "es", "de", "metaobjects")).toBe(true);
  });

  it("does not call an entry EMPTY just because its definition names no label field", async () => {
    const { hasPrimaryContentMissing } = await import("~/utils/field-validation.utils");
    const item = {
      id: "metaobject_type_x",
      metaobjects: [{ id: "gid://shopify/Metaobject/2", fields: [{ key: "headline", value: "Hi" }] }],
      fieldDefinitions: [],
      translations: [],
    } as never;
    expect(hasPrimaryContentMissing(item, "metaobjects")).toBe(false);
  });
});

describe("a type whose Translations capability is off", () => {
  const item = (capability: boolean | null) =>
    ({
      id: "metaobject_type_x",
      translatableCapability: capability,
      metaobjects: [
        { id: "gid://shopify/Metaobject/9", fields: [{ key: "label", value: "Gold", type: "single_line_text_field" }] },
      ],
      fieldDefinitions: [LABEL_FIELD],
      translations: [],
    }) as never;

  it("stops counting once Shopify says the type does not translate", async () => {
    // Otherwise the pulse is permanent for a different reason: the write path
    // refuses the register for want of a digest, so the merchant cannot clear
    // it either.
    const { hasLocaleMissingTranslations } = await import("~/utils/field-validation.utils");
    expect(hasLocaleMissingTranslations(item(false), "fr", "de", "metaobjects")).toBe(false);
  });

  it("keeps counting while the capability is UNKNOWN", async () => {
    // Hiding a real missing translation behind a guess is the worse error, and
    // a row cached before the column exists knows nothing.
    const { hasLocaleMissingTranslations } = await import("~/utils/field-validation.utils");
    expect(hasLocaleMissingTranslations(item(null), "fr", "de", "metaobjects")).toBe(true);
    expect(hasLocaleMissingTranslations(item(true), "fr", "de", "metaobjects")).toBe(true);
  });

  it("names the missing fields by COMPOUND key, so the tooltip can split them", async () => {
    const { getMissingLocaleTranslationFields } = await import("~/utils/field-validation.utils");
    expect(getMissingLocaleTranslationFields(item(null), "fr", "de", "metaobjects")).toEqual([
      "gid://shopify/Metaobject/9#label",
    ]);
  });
});
