/**
 * PLAN_CONTENT_CREATION §7 (Phase 1) — the shared create spec.
 *
 * This file is the ONE description of what may be created and with what, and
 * the server validates against it (§1.5). The tests that matter are therefore
 * not "does the config list a title field" but the rules a client could
 * otherwise talk its way past: an invented field, a missing mandatory one, a
 * status value the bulk editor would not accept.
 */

import { describe, it, expect } from "vitest";
import {
  CREATE_PRODUCT_STATUSES,
  CREATE_SPECS,
  createSpecFor,
  metaobjectCreatability,
  metaobjectFieldDefs,
  suggestHandle,
  validateCreatePayload,
} from "~/config/create-fields.config";

describe("validateCreatePayload", () => {
  it("rejects a field the spec does not describe", () => {
    // The whole point of a shared spec: a client cannot widen the write
    // surface by inventing a key. Silently dropping it would look like a
    // successful create that quietly lost data.
    const errors = validateCreatePayload("product", { title: "T", giftCard: "true" });
    expect(errors).toContainEqual({ field: "giftCard", code: "unknownField" });
  });

  it("requires the mandatory fields of each type", () => {
    expect(validateCreatePayload("product", {})).toContainEqual({ field: "title", code: "required" });
    expect(validateCreatePayload("page", {})).toContainEqual({ field: "title", code: "required" });
    // §1.4 — an article needs BOTH a blog and an author, and the author has no
    // equivalent anywhere else in this app.
    const article = validateCreatePayload("article", { title: "T" });
    expect(article).toContainEqual({ field: "blogId", code: "required" });
    expect(article).toContainEqual({ field: "author", code: "required" });
  });

  it("treats whitespace as empty for a required field", () => {
    expect(validateCreatePayload("product", { title: "   " })).toContainEqual({ field: "title", code: "required" });
  });

  it("accepts a complete minimal payload", () => {
    expect(validateCreatePayload("product", { title: "A shirt" })).toEqual([]);
    expect(validateCreatePayload("blog", { title: "News" })).toEqual([]);
  });

  it("rejects a status outside the four the bulk editor accepts", () => {
    // §2.3: the single editor must offer the SAME set as the bulk editor.
    // A value only one of them accepts is the inconsistency the plan calls out.
    expect(validateCreatePayload("product", { title: "T", status: "PUBLISHED" }))
      .toContainEqual({ field: "status", code: "invalidOption", detail: "PUBLISHED" });
    for (const status of CREATE_PRODUCT_STATUSES) {
      expect(validateCreatePayload("product", { title: "T", status })).toEqual([]);
    }
  });

  it("rejects a handle that is not Shopify's grammar", () => {
    expect(validateCreatePayload("product", { title: "T", handle: "Not A Handle" }))
      .toContainEqual({ field: "handle", code: "invalidHandle" });
    expect(validateCreatePayload("product", { title: "T", handle: "a-good-handle-2" })).toEqual([]);
  });

  it("rejects a price that is not a decimal", () => {
    expect(validateCreatePayload("product", { title: "T", price: "cheap" }))
      .toContainEqual({ field: "price", code: "invalidMoney" });
    // A comma decimal is a real merchant habit and is accepted (normalised
    // server-side), so it must not be rejected here.
    expect(validateCreatePayload("product", { title: "T", price: "19,99" })).toEqual([]);
    expect(validateCreatePayload("product", { title: "T", price: "19.99" })).toEqual([]);
  });

  it("enforces the length caps", () => {
    const long = "x".repeat(300);
    const errors = validateCreatePayload("product", { title: long });
    expect(errors.some((e) => e.field === "title" && e.code === "tooLong")).toBe(true);
  });

  it("knows a metaobject's runtime fields only when told about them", () => {
    // Without extraFields the definition's own field is an unknown key; with
    // them it validates like any other. This is why the server passes them in.
    const values = { type: "size_guide", "field.headline": "Sizes" };
    expect(validateCreatePayload("metaobject", values)).toContainEqual({ field: "field.headline", code: "unknownField" });

    const extras = metaobjectFieldDefs([{ key: "headline", required: true, type: { name: "single_line_text_field" } }]);
    expect(validateCreatePayload("metaobject", values, extras)).toEqual([]);
  });
});

describe("metaobjectCreatability", () => {
  it("allows a definition whose required fields are all plain text", () => {
    expect(
      metaobjectCreatability([
        { key: "headline", required: true, type: { name: "single_line_text_field" } },
        { key: "body", required: false, type: { name: "multi_line_text_field" } },
      ]),
    ).toEqual({ creatable: true });
  });

  it("refuses when a REQUIRED field has a type this app cannot edit", () => {
    const result = metaobjectCreatability([
      { key: "hero", required: true, type: { name: "file_reference" } },
    ]);
    expect(result.creatable).toBe(false);
    expect(result).toMatchObject({ reason: "unsupportedRequiredType" });
    // The reason names the offending field: "cannot create here" with no cause
    // reads as a bug rather than an explanation.
    expect((result as { detail?: string }).detail).toContain("hero");
  });

  it("allows an unsupported field type when it is OPTIONAL", () => {
    // Only required fields block: an optional one we cannot render is simply
    // left unset, which Shopify accepts.
    expect(
      metaobjectCreatability([{ key: "hero", required: false, type: { name: "file_reference" } }]),
    ).toEqual({ creatable: true });
  });

  it("refuses with its OWN reason when `required` is unknown", () => {
    // Definitions cached before the Phase-0 sync carry no `required` flag.
    // Absent is not false — treating it as "nothing is required" would offer a
    // form Shopify rejects for a field the merchant was never asked for.
    const result = metaobjectCreatability([{ key: "headline", type: { name: "single_line_text_field" } }]);
    expect(result).toEqual({ creatable: false, reason: "requiredUnknown" });
  });
});

describe("metaobjectFieldDefs", () => {
  it("marks a list field so the server can serialise it", () => {
    // `list.single_line_text_field` is stored as a JSON ARRAY. Sending the
    // comma-separated string the form collects would be rejected every time,
    // which would make a definition with such a REQUIRED field "offered but
    // impossible to create" — advertised, then always refused.
    const defs = metaobjectFieldDefs([
      { key: "sizes", type: { name: "list.single_line_text_field" } },
      { key: "headline", type: { name: "single_line_text_field" } },
    ]);
    const list = defs.find((d) => d.key === "field.sizes")!;
    const plain = defs.find((d) => d.key === "field.headline")!;
    expect(list.listValue).toBe(true);
    expect(list.kind).toBe("tags");
    expect(plain.listValue).toBe(false);
  });

  it("renders only the three editable field types", () => {
    const defs = metaobjectFieldDefs([
      { key: "a", type: { name: "single_line_text_field" } },
      { key: "b", type: { name: "multi_line_text_field" } },
      { key: "c", type: { name: "list.single_line_text_field" } },
      { key: "d", type: { name: "file_reference" } },
      { key: "e", type: { name: "number_integer" } },
    ]);
    expect(defs.map((d) => d.key)).toEqual(["field.a", "field.b", "field.c"]);
  });

  it("prefixes the keys so they cannot collide with the spec's own", () => {
    // A definition with a field literally called "handle" would otherwise
    // overwrite the resource's handle.
    const defs = metaobjectFieldDefs([{ key: "handle", type: { name: "single_line_text_field" } }]);
    expect(defs[0].key).toBe("field.handle");
  });
});

describe("suggestHandle", () => {
  it("mirrors Shopify's slug grammar", () => {
    expect(suggestHandle("Käse & Brot — Über Uns")).toBe("kase-brot-uber-uns");
    expect(suggestHandle("  Trailing  ")).toBe("trailing");
    expect(suggestHandle("!!!")).toBe("");
  });
});

describe("the specs themselves", () => {
  it("gives every creatable resource a title field", () => {
    for (const spec of Object.values(CREATE_SPECS)) {
      // Except metaobjects, which are identified by their definition + fields.
      if (spec.resource === "metaobject") continue;
      expect(spec.fields.some((f) => f.key === "title" && f.required)).toBe(true);
    }
  });

  it("routes SEO through metafields exactly for the types that have no seo input", () => {
    // §1.3 — page/article/blog carry meta title/description in
    // global.title_tag / description_tag, and forgetting the second step is
    // the documented false-success bug.
    expect(CREATE_SPECS.page.seoViaMetafields).toBe(true);
    expect(CREATE_SPECS.article.seoViaMetafields).toBe(true);
    expect(CREATE_SPECS.product.seoViaMetafields).toBeUndefined();
    expect(CREATE_SPECS.collection.seoViaMetafields).toBeUndefined();
  });

  it("does not offer templateSuffix anywhere (§2.5)", () => {
    for (const spec of Object.values(CREATE_SPECS)) {
      expect(spec.fields.some((f) => f.key === "templateSuffix")).toBe(false);
    }
  });

  it("has no spec for resources that cannot be created", () => {
    expect(createSpecFor("policy")).toBeNull();
    expect(createSpecFor("theme")).toBeNull();
  });
});
