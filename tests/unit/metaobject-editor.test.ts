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
  metaobjectListValueIsAmbiguous,
  metaobjectWriteAccess,
  parseMetaobjectFieldInput,
  parseMetaobjectFieldKey,
} from "~/services/metaobject-fields.shared";
import {
  countLinkedOptionUsage,
  liveMetaobjectUsage,
  LINKED_OPTION_SCAN_CAP,
  LIVE_REFERENCE_PAGE,
} from "~/services/metaobject-usage.server";
import { isGidOfResource } from "~/config/create-fields.config";
import { METAOBJECTS_CONFIG } from "~/config/content-fields.config";
import { isAttributeField } from "~/services/content-attributes.shared";
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

// ─── Every field of an entry belongs to that ENTRY's card ─────────────────
//
// The editor splits its fields across three cards, and the merchandising half
// is recognised by `translationKey: "" + supportsTranslation: false`. A
// metaobject colour, file reference and taxonomy reference carry exactly that
// pair for an unrelated reason (one value per SHOP, not per locale), so they
// were read as merchandising attributes and rendered in the page-wide
// "Details" card at the bottom: the entries in their cards, and far below them
// a flat list of every entry's colour, with a help text as the only clue which
// colour belonged to which entry. That also silently disabled the colour
// swatch in the card header, which is picked out of the group's own fields and
// therefore never found one.

describe("a metaobject entry's fields are routed to its own card", () => {
  const definition = [
    { key: "label", name: "Label", type: { name: "single_line_text_field" }, required: true },
    { key: "colour", name: "Colour", type: { name: "color" } },
    { key: "image", name: "Image", type: { name: "file_reference" } },
    {
      key: "colour_taxonomy",
      name: "Colour taxonomy",
      type: { name: "list.product_taxonomy_value_reference" },
      validations: [{ name: "product_taxonomy_attribute_handle", value: "color" }],
    },
  ];
  const item = {
    id: "metaobject_type_shopify--color-pattern",
    type: "shopify--color-pattern",
    metaobjects: [{ id: ENTRY, displayName: "Rot", handle: "rot", fields: [{ key: "label", value: "Rot" }] }],
    fieldDefinitions: definition,
  };

  it("gives every field the entry's groupId and lets none of them be read as an attribute", () => {
    const fields = METAOBJECTS_CONFIG.getFieldDefinitions?.(item as never) ?? [];
    expect(fields.map((f) => f.key)).toEqual([
      `${ENTRY}#label`,
      `${ENTRY}#colour`,
      `${ENTRY}#image`,
      `${ENTRY}#colour_taxonomy`,
    ]);
    // The groupId is what puts a field in its entry's card...
    expect(fields.every((f) => f.groupId === ENTRY)).toBe(true);
    // ...and what keeps the attribute router's hands off it. Without the veto
    // the last three land in the page-wide "Details" card instead.
    expect(fields.filter((f) => isAttributeField(f)).map((f) => f.key)).toEqual([]);
  });

  it("keeps the empty translation key that the routing bug rode in on", () => {
    // The pair is still there and still right — a colour has ONE value per
    // shop, and a translation key would clear it on a foreign-locale save.
    // Only its reading as "merchandising attribute" was wrong.
    const fields = METAOBJECTS_CONFIG.getFieldDefinitions?.(item as never) ?? [];
    const colour = fields.find((f) => f.key === `${ENTRY}#colour`);
    expect(colour?.translationKey).toBe("");
    expect(colour?.supportsTranslation).toBe(false);
  });

  it("says how a list is separated and does not repeat the entry name under every control", () => {
    // The card heading carries the name now, so a help text saying it again
    // says the same thing twice.
    const listItem = {
      ...item,
      fieldDefinitions: [{ key: "aliases", name: "Aliases", type: { name: "list.single_line_text_field" } }],
    };
    const fields = METAOBJECTS_CONFIG.getFieldDefinitions?.(listItem as never) ?? [];
    expect(fields[0].helpText).toBe("separate values with |");

    const plain = METAOBJECTS_CONFIG.getFieldDefinitions?.(item as never) ?? [];
    expect(plain.every((f) => f.helpText === undefined)).toBe(true);
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
    // MEASURED (PLAN §2.1): this is what every Shopify STANDARD definition on
    // the probed shop actually reports, `shopify--color-pattern` included. It
    // must not lock the editor.
    expect(metaobjectWriteAccess("PUBLIC_READ_WRITE")).toBe("writable");
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

// ─── 7. The list separator hazard (review follow-up) ───────────────────────

describe("metaobjectListValueIsAmbiguous", () => {
  it("flags a list whose ENTRY contains the display separator", () => {
    // The display form joins with " | " and the parser splits on "|", so such
    // an entry would be shattered into several on the next save.
    expect(metaobjectListValueIsAmbiguous("list.single_line_text_field", '["Rot|Blau","Grün"]')).toBe(true);
    expect(metaobjectListValueIsAmbiguous("list.single_line_text_field", '["Rot","Blau"]')).toBe(false);
  });

  it("says nothing about types that are not lists", () => {
    expect(metaobjectListValueIsAmbiguous("single_line_text_field", "a|b")).toBe(false);
    expect(metaobjectListValueIsAmbiguous("color", "#ff0000")).toBe(false);
  });

  it("leaves a non-JSON value alone — it is shown verbatim, so it never round-trips", () => {
    expect(metaobjectListValueIsAmbiguous("list.single_line_text_field", "not json|at all")).toBe(false);
  });
});

describe("the display-form comparison that decides 'unchanged'", () => {
  it("matches for a list that came back exactly as it was shown", () => {
    // This is the check the save path uses instead of comparing storage forms:
    // a list is shown as `A | B | C` and stored as JSON, so a byte comparison
    // of the two would call an untouched field changed.
    const stored = '["Rot","Blau"]';
    const shown = formatMetaobjectFieldValue("list.single_line_text_field", stored);
    expect(shown).toBe("Rot | Blau");
    const reparsed = parseMetaobjectFieldInput("list.single_line_text_field", shown);
    expect(reparsed).toEqual({ ok: true, value: stored });
  });
});

// ─── 8. The live cross-check (V4, measured 2026-08-19) ─────────────────────

describe("liveMetaobjectUsage", () => {
  const ENTRY_ID = "gid://shopify/Metaobject/1";

  /** Only `graphql(...).json()` is ever reached — the cast keeps the stub to
   *  what the function actually uses instead of building a whole Response. */
  function adminWith(body: unknown) {
    return { graphql: vi.fn(async () => ({ json: async () => body })) } as never;
  }

  function relations(...productIds: Array<string | null>) {
    return {
      data: {
        metaobject: {
          id: ENTRY_ID,
          referencedBy: {
            nodes: productIds.map((id) =>
              id === null
                ? { referencer: { __typename: "Collection" } }
                : { referencer: { __typename: "Product", id } },
            ),
          },
        },
      },
    };
  }

  it("counts DISTINCT products for the message, and ALL references for the decision", async () => {
    const usage = await liveMetaobjectUsage(adminWith(relations("p1", "p1", "p2")), ENTRY_ID);
    expect(usage).toEqual({ known: true, references: 3, products: 2, atLeast: false });
  });

  it("reports a real zero when Shopify says nothing references it", async () => {
    const usage = await liveMetaobjectUsage(adminWith(relations()), ENTRY_ID);
    expect(usage).toEqual({ known: true, references: 0, products: 0, atLeast: false });
  });

  it("flags a full page as 'at least', because the connection has no count field", async () => {
    const many = Array.from({ length: LIVE_REFERENCE_PAGE }, (_, i) => `p${i}`);
    const usage = await liveMetaobjectUsage(adminWith(relations(...many)), ENTRY_ID);
    expect(usage).toEqual({
      known: true,
      references: LIVE_REFERENCE_PAGE,
      products: LIVE_REFERENCE_PAGE,
      atLeast: true,
    });
  });

  it("still COUNTS a referencer that is not a product — Shopify refuses on any of them", async () => {
    // This is the case that decides: zero products but one reference. Reading
    // only the product count would let the delete through into a raw platform
    // refusal for an entry something else holds.
    const usage = await liveMetaobjectUsage(adminWith(relations(null)), ENTRY_ID);
    expect(usage).toEqual({ known: true, references: 1, products: 0, atLeast: false });
  });

  it("returns UNKNOWN — never zero — when the query errors", async () => {
    const usage = await liveMetaobjectUsage(
      adminWith({ data: null, errors: [{ message: "Throttled" }] }),
      ENTRY_ID,
    );
    expect(usage).toEqual({ known: false });
  });

  it("returns UNKNOWN when the entry itself does not resolve", async () => {
    // Another shop's id, or one deleted meanwhile. An absent metaobject is a
    // question that was not asked, not an entry nothing references.
    const usage = await liveMetaobjectUsage(adminWith({ data: { metaobject: null } }), ENTRY_ID);
    expect(usage).toEqual({ known: false });
  });

  it("returns UNKNOWN when the call throws", async () => {
    const admin = { graphql: vi.fn(async () => { throw new Error("socket hang up"); }) } as never;
    expect(await liveMetaobjectUsage(admin, ENTRY_ID)).toEqual({ known: false });
  });
});
