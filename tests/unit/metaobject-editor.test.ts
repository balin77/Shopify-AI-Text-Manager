/**
 * PLAN_METAOBJECTS_EDITOR — the parts that are pure enough to pin down.
 *
 * Three of them are the load-bearing ones and each replaced a defect:
 *
 * 1. The COMPOUND field key. Before it, a metaobject form field was the bare
 *    entry GID, so an entry could only ever have one editable field. The split
 *    has to be unambiguous in both directions or a save writes the wrong field
 *    of a real entry.
 * 2. `translationKey: ""` for a colour or a file reference. `resolve()`
 *    short-circuits an empty key to the primary value; a non-empty one would
 *    resolve to "" in a foreign locale and the next save would CLEAR the
 *    shop-wide value.
 * 3. Usage counting is THREE-valued. "0 products" and "we cannot tell" look
 *    the same in a number and mean opposite things when the next click deletes
 *    something from a live shop.
 */

import { describe, it, expect, vi } from "vitest";
import {
  METAOBJECT_HEX_PATTERN,
  formatMetaobjectFieldValue,
  isTranslatableMetaobjectFieldType,
  isWritableMetaobjectFieldType,
  metaobjectFieldKey,
  metaobjectFieldRole,
  metaobjectFieldSpecs,
  metaobjectFieldValueFor,
  metaobjectWriteAccess,
  parseMetaobjectFieldInput,
  parseMetaobjectFieldKey,
} from "~/services/metaobject-fields.shared";
import { countLinkedOptionUsage, LINKED_OPTION_SCAN_CAP } from "~/services/metaobject-usage.server";
import { isGidOfResource } from "~/config/create-fields.config";
import { resolveSwatch } from "~/services/product-option-swatch.shared";

const ENTRY = "gid://shopify/Metaobject/12345";
const isLabel = (key: string) => key === "label" || key === "name" || key === "display_name";

// ─── 1. The compound key (§6.1) ────────────────────────────────────────────

describe("metaobject compound field keys", () => {
  it("round-trips a key and keeps the GID prefix the server scans for", () => {
    const key = metaobjectFieldKey(ENTRY, "colour");
    expect(key).toBe(`${ENTRY}#colour`);
    // The server recognises a metaobject form field by this prefix — putting
    // the field key in front would make every save skip every entry.
    expect(key.startsWith("gid://shopify/Metaobject/")).toBe(true);
    expect(parseMetaobjectFieldKey(key)).toEqual({ metaobjectId: ENTRY, fieldKey: "colour" });
  });

  it("splits at the FIRST separator, so a field key containing one survives", () => {
    // Shopify field keys are [a-z0-9_]-shaped, so this cannot occur today —
    // the split is defined anyway, because "cannot occur" is not a parser.
    expect(parseMetaobjectFieldKey(`${ENTRY}#a#b`)).toEqual({ metaobjectId: ENTRY, fieldKey: "a#b" });
  });

  it("refuses a BARE entry GID rather than guessing the field", () => {
    // A stale tab sends this. Guessing the label field would write a real
    // entry from a client that meant something else.
    expect(parseMetaobjectFieldKey(ENTRY)).toBeNull();
    expect(parseMetaobjectFieldKey("")).toBeNull();
    expect(parseMetaobjectFieldKey(`#colour`)).toBeNull();
    expect(parseMetaobjectFieldKey(`${ENTRY}#`)).toBeNull();
  });

  it("keys of two different fields of one entry never collide", () => {
    expect(metaobjectFieldKey(ENTRY, "label")).not.toBe(metaobjectFieldKey(ENTRY, "colour"));
    expect(metaobjectFieldKey(ENTRY, "label")).not.toBe(metaobjectFieldKey(`${ENTRY}0`, "label"));
  });
});

// ─── 2. Field roles and translatability (§6.1) ──────────────────────────────

describe("metaobject field roles", () => {
  it("maps the three text types to editable roles and everything else honestly", () => {
    expect(metaobjectFieldRole("single_line_text_field")).toBe("text");
    expect(metaobjectFieldRole("multi_line_text_field")).toBe("textarea");
    expect(metaobjectFieldRole("list.single_line_text_field")).toBe("list");
    expect(metaobjectFieldRole("rich_text_field")).toBe("richText");
    expect(metaobjectFieldRole("color")).toBe("color");
    expect(metaobjectFieldRole("file_reference")).toBe("file");
    expect(metaobjectFieldRole("product_reference")).toBe("unsupported");
    expect(metaobjectFieldRole("")).toBe("unsupported");
  });

  it("colours and file references are WRITABLE but never TRANSLATABLE", () => {
    // The whole point of translationKey: "" — one value per shop, and a
    // foreign-locale save that carried one would clear it.
    for (const type of ["color", "file_reference"]) {
      expect(isWritableMetaobjectFieldType(type)).toBe(true);
      expect(isTranslatableMetaobjectFieldType(type)).toBe(false);
    }
    for (const type of ["single_line_text_field", "multi_line_text_field", "list.single_line_text_field"]) {
      expect(isWritableMetaobjectFieldType(type)).toBe(true);
      expect(isTranslatableMetaobjectFieldType(type)).toBe(true);
    }
  });

  it("rich text is neither writable nor translatable", () => {
    expect(isWritableMetaobjectFieldType("rich_text_field")).toBe(false);
    expect(isTranslatableMetaobjectFieldType("rich_text_field")).toBe(false);
  });
});

describe("metaobject field values", () => {
  it("shows a list as A | B | C and stores it back as JSON", () => {
    expect(formatMetaobjectFieldValue("list.single_line_text_field", '["Rot","Blau"]')).toBe("Rot | Blau");
    expect(parseMetaobjectFieldInput("list.single_line_text_field", "Rot | Blau")).toEqual({
      ok: true,
      value: '["Rot","Blau"]',
    });
  });

  it("refuses a list with an empty entry instead of storing a blank value", () => {
    expect(parseMetaobjectFieldInput("list.single_line_text_field", "Rot ||Blau")).toEqual({
      ok: false,
      error: "emptyListEntry",
    });
  });

  it("accepts a hex colour with or without the hash and refuses anything else", () => {
    expect(parseMetaobjectFieldInput("color", "#a1b2c3")).toEqual({ ok: true, value: "#a1b2c3" });
    expect(parseMetaobjectFieldInput("color", "A1B2C3")).toEqual({ ok: true, value: "#A1B2C3" });
    expect(parseMetaobjectFieldInput("color", "rot")).toEqual({ ok: false, error: "invalidColor" });
  });

  it("treats an empty value as CLEAR for every type, leaving the refusal to Shopify", () => {
    // A required-field validation lives on the definition; guessing it here
    // would refuse edits Shopify accepts.
    for (const type of ["single_line_text_field", "color", "list.single_line_text_field", "file_reference"]) {
      expect(parseMetaobjectFieldInput(type, "")).toEqual({ ok: true, value: "" });
    }
  });

  it("refuses to write a type it has no editor for", () => {
    expect(parseMetaobjectFieldInput("rich_text_field", "hello")).toEqual({ ok: false, error: "notWritable" });
    expect(parseMetaobjectFieldInput("product_reference", "gid://shopify/Product/1")).toEqual({
      ok: false,
      error: "notWritable",
    });
  });

  it("shares its hex pattern with the swatch resolver, so a written colour can be painted", () => {
    const written = parseMetaobjectFieldInput("color", "1a2b3c");
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    expect(METAOBJECT_HEX_PATTERN.test(written.value)).toBe(true);
    // The same value has to resolve to a swatch — a second regex here would be
    // free to accept colours the preview then refuses to show.
    expect(resolveSwatch("whatever", { color: written.value })).toEqual({
      color: written.value,
      source: "shopify",
    });
  });
});

// ─── 3. Field specs come from the DEFINITION, not from what happens to be set ─

describe("metaobjectFieldSpecs", () => {
  const definition = [
    { key: "label", name: "Label", type: { name: "single_line_text_field" }, required: true },
    { key: "colour", name: "Colour", type: { name: "color" }, required: false },
    { key: "swatch_image", name: "Swatch", type: { name: "file_reference" } },
  ];

  it("lists a field the entry has never filled in — that is the field the merchant came for", () => {
    const specs = metaobjectFieldSpecs(
      { id: ENTRY, fields: [{ key: "label", value: "Rot" }] },
      definition,
    );
    expect(specs.map((s) => s.fieldKey)).toEqual(["label", "colour", "swatch_image"]);
    expect(specs[1].rawValue).toBe("");
    expect(specs[1].role).toBe("color");
    // `required` absent on the definition stays UNDEFINED, never false.
    expect(specs[2].required).toBeUndefined();
  });

  it("appends a field the ENTRY has but the cached definition does not know", () => {
    const specs = metaobjectFieldSpecs(
      { id: ENTRY, fields: [{ key: "note", value: "x", type: "single_line_text_field" }] },
      definition,
    );
    expect(specs.map((s) => s.fieldKey)).toEqual(["label", "colour", "swatch_image", "note"]);
    expect(specs[3].role).toBe("text");
  });

  it("falls back to the entry's own fields when no definition is cached", () => {
    const specs = metaobjectFieldSpecs(
      { id: ENTRY, fields: [{ key: "label", value: "Rot", type: "single_line_text_field" }] },
      undefined,
    );
    expect(specs).toHaveLength(1);
    expect(specs[0].compoundKey).toBe(`${ENTRY}#label`);
  });
});

describe("metaobjectFieldValueFor", () => {
  const entries = [
    {
      id: ENTRY,
      displayName: "Rot",
      fields: [
        { key: "label", value: "Rot", type: "single_line_text_field" },
        { key: "sizes", value: '["S","M"]', type: "list.single_line_text_field" },
      ],
    },
  ];

  it("reads one field of one entry through its compound key", () => {
    expect(metaobjectFieldValueFor(entries, undefined, `${ENTRY}#label`, isLabel)).toBe("Rot");
    expect(metaobjectFieldValueFor(entries, undefined, `${ENTRY}#sizes`, isLabel)).toBe("S | M");
  });

  it("tolerates a BARE GID by showing the label — reading is not writing", () => {
    expect(metaobjectFieldValueFor(entries, undefined, ENTRY, isLabel)).toBe("Rot");
  });

  it("returns empty for an unknown entry or field rather than another entry's value", () => {
    expect(metaobjectFieldValueFor(entries, undefined, `${ENTRY}#nope`, isLabel)).toBe("");
    expect(metaobjectFieldValueFor(entries, undefined, "gid://shopify/Metaobject/9#label", isLabel)).toBe("");
    expect(metaobjectFieldValueFor(undefined, undefined, `${ENTRY}#label`, isLabel)).toBe("");
  });
});

// ─── 4. Write access is three-valued (§7.2) ────────────────────────────────

describe("metaobjectWriteAccess", () => {
  it("treats an unsynced definition as UNKNOWN, never as writable or read-only", () => {
    expect(metaobjectWriteAccess(null)).toBe("unknown");
    expect(metaobjectWriteAccess(undefined)).toBe("unknown");
    expect(metaobjectWriteAccess("")).toBe("unknown");
  });

  it("locks only the regimes that actually exclude this app's writes", () => {
    expect(metaobjectWriteAccess("MERCHANT_READ")).toBe("readOnly");
    expect(metaobjectWriteAccess("PRIVATE")).toBe("readOnly");
    expect(metaobjectWriteAccess("MERCHANT_READ_WRITE")).toBe("writable");
    // A value this app has never seen is not evidence of a restriction.
    expect(metaobjectWriteAccess("SOMETHING_NEW")).toBe("writable");
  });
});

// ─── 5. A metaobject TYPE row is not a deletable object (B1) ───────────────

describe("isGidOfResource", () => {
  it("refuses the metaobjects tab's pseudo type id", () => {
    // This is B1: the delete button used to reach deleteContent with
    // `metaobject_type_color` and 400 AFTER the merchant typed the name.
    expect(isGidOfResource("metaobject_type_color", "metaobject")).toBe(false);
    expect(isGidOfResource(ENTRY, "metaobject")).toBe(true);
    expect(isGidOfResource("gid://shopify/Product/1", "metaobject")).toBe(false);
    expect(isGidOfResource("gid://shopify/Product/1", "product")).toBe(true);
  });
});

// ─── 6. Usage counting: 0, n, and "we cannot tell" (§5.1) ──────────────────

interface FakeOption {
  productId: string;
  values: string;
}

function fakeDb(productCount: number, options: FakeOption[]) {
  return {
    product: { count: vi.fn(async () => productCount) },
    productOption: { findMany: vi.fn(async () => options) },
  } as never;
}

const OTHER = "gid://shopify/Metaobject/99";

function linkedValues(...gids: string[]): string {
  return JSON.stringify(gids.map((g, i) => ({ id: `v${i}`, name: `v${i}`, linked: true, linkedValue: g })));
}

describe("countLinkedOptionUsage", () => {
  it("counts distinct PRODUCTS and options, not raw rows", async () => {
    const usage = await countLinkedOptionUsage(
      fakeDb(5, [
        { productId: "p1", values: linkedValues(ENTRY) },
        { productId: "p1", values: linkedValues(ENTRY, OTHER) },
        { productId: "p2", values: linkedValues(ENTRY) },
        { productId: "p3", values: linkedValues(OTHER) },
      ]),
      "shop.myshopify.com",
      [ENTRY, OTHER],
    );
    expect(usage[ENTRY]).toEqual({ known: true, products: 2, options: 3 });
    expect(usage[OTHER]).toEqual({ known: true, products: 2, options: 2 });
  });

  it("reports a real ZERO when the shop has products and none use the entry", async () => {
    const usage = await countLinkedOptionUsage(
      fakeDb(5, [{ productId: "p1", values: linkedValues(OTHER) }]),
      "shop.myshopify.com",
      [ENTRY],
    );
    expect(usage[ENTRY]).toEqual({ known: true, products: 0, options: 0 });
  });

  it("reports UNKNOWN — not zero — when no product is cached and the shop has some", async () => {
    // The distinction this module exists for: an empty cache is "we have not
    // looked", and the UI offers a sync instead of a reassuring 0.
    const usage = await countLinkedOptionUsage(
      fakeDb(0, []),
      "shop.myshopify.com",
      [ENTRY],
      async () => 42,
    );
    expect(usage[ENTRY]).toEqual({ known: false, reason: "noProducts" });
  });

  it("stays UNKNOWN when the live product count cannot be asked", async () => {
    // No callback and a failed callback mean the same thing: the question was
    // not answered, so the cache's emptiness stays uninterpretable.
    expect((await countLinkedOptionUsage(fakeDb(0, []), "s", [ENTRY]))[ENTRY]).toEqual({
      known: false,
      reason: "noProducts",
    });
    expect(
      (await countLinkedOptionUsage(fakeDb(0, []), "s", [ENTRY], async () => null))[ENTRY],
    ).toEqual({ known: false, reason: "noProducts" });
  });

  it("reports a real ZERO when Shopify says the shop has no products at all", async () => {
    // Without this a shop with an empty catalogue could never delete an entry:
    // the remedy the UI offers (sync your products) cannot change the answer.
    const usage = await countLinkedOptionUsage(
      fakeDb(0, []),
      "shop.myshopify.com",
      [ENTRY],
      async () => 0,
    );
    expect(usage[ENTRY]).toEqual({ known: true, products: 0, options: 0 });
  });

  it("counts an option row that has no linkedMetafieldKey cached", async () => {
    // The sync's fallback path writes `values` without that column, and
    // filtering on it made a USED entry look unused — which unlocks exactly
    // the delete the guard exists to refuse.
    const usage = await countLinkedOptionUsage(
      fakeDb(3, [{ productId: "p1", values: linkedValues(ENTRY) }]),
      "shop.myshopify.com",
      [ENTRY],
    );
    expect(usage[ENTRY]).toEqual({ known: true, products: 1, options: 1 });
  });

  it("does not let one GID's substring match another entry's usage", async () => {
    // The DB prefilter is a substring match and .../123 is a prefix of
    // .../1234 — the JSON parse afterwards is what makes the answer exact.
    const shorter = "gid://shopify/Metaobject/123";
    const longer = "gid://shopify/Metaobject/1234";
    const usage = await countLinkedOptionUsage(
      fakeDb(3, [{ productId: "p1", values: linkedValues(longer) }]),
      "shop.myshopify.com",
      [shorter, longer],
    );
    expect(usage[shorter]).toEqual({ known: true, products: 0, options: 0 });
    expect(usage[longer]).toEqual({ known: true, products: 1, options: 1 });
  });

  it("reports UNKNOWN when the linked-option scan hits its cap", async () => {
    const many = Array.from({ length: LINKED_OPTION_SCAN_CAP + 1 }, (_, i) => ({
      productId: `p${i}`,
      values: linkedValues(OTHER),
    }));
    const usage = await countLinkedOptionUsage(fakeDb(9, many), "shop.myshopify.com", [ENTRY]);
    expect(usage[ENTRY]).toEqual({ known: false, reason: "scanTruncated" });
  });

  it("reports UNKNOWN when the lookup itself fails", async () => {
    const db = {
      product: { count: vi.fn(async () => { throw new Error("db down"); }) },
      productOption: { findMany: vi.fn() },
    } as never;
    const usage = await countLinkedOptionUsage(db, "shop.myshopify.com", [ENTRY]);
    expect(usage[ENTRY]).toEqual({ known: false, reason: "lookupFailed" });
  });

  it("survives a malformed values blob without making the whole shop unknown", async () => {
    const usage = await countLinkedOptionUsage(
      fakeDb(3, [
        { productId: "p1", values: "not json at all" },
        { productId: "p2", values: linkedValues(ENTRY) },
      ]),
      "shop.myshopify.com",
      [ENTRY],
    );
    expect(usage[ENTRY]).toEqual({ known: true, products: 1, options: 1 });
  });

  it("answers for every requested id, so a missing key never has to be interpreted", async () => {
    const usage = await countLinkedOptionUsage(fakeDb(0, []), "shop.myshopify.com", [ENTRY, OTHER]);
    expect(Object.keys(usage).sort()).toEqual([ENTRY, OTHER].sort());
  });
});
