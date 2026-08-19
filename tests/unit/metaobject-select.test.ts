/**
 * Where `/app/metaobjects?select=…` opens.
 *
 * This rule shipped wrong twice while it lived inline in the page, and both
 * times for the same reason: nothing could test it. The second time was worse
 * than the first, because the "fix" — sending a Metaobject GID — shadowed the
 * only spelling that had been working.
 */

import { describe, it, expect } from "vitest";
import { resolveMetaobjectSelection } from "~/services/metaobject-select.shared";

/** The page's items are TYPES, one per definition. Entries are not in here. */
const items = [
  {
    id: "metaobject_type_color-pattern",
    type: "color-pattern",
    title: "Color pattern",
    definitionName: "Color pattern",
  },
  {
    id: "metaobject_type_shopify--color-pattern",
    type: "shopify--color-pattern",
    title: "Shopify color pattern",
    definitionName: "Shopify color pattern",
  },
  { id: "metaobject_type_material", type: "material", title: "Material", definitionName: "Material" },
];

describe("resolveMetaobjectSelection", () => {
  it("opens the type a Metaobject GID belongs to", () => {
    // A GID names an ENTRY and matches no item, which is why the loader
    // resolves it to a type first. Passing it through raw selects nothing.
    expect(resolveMetaobjectSelection(items, "gid://shopify/Metaobject/8123")).toBeUndefined();
    expect(resolveMetaobjectSelection(items, "gid://shopify/Metaobject/8123", "material")).toBe(
      "metaobject_type_material",
    );
  });

  it("matches a type handle, a definition name and a title", () => {
    expect(resolveMetaobjectSelection(items, "material")).toBe("metaobject_type_material");
    expect(resolveMetaobjectSelection(items, "Material")).toBe("metaobject_type_material");
    expect(resolveMetaobjectSelection(items, "Shopify color pattern")).toBe(
      "metaobject_type_shopify--color-pattern",
    );
  });

  it("takes the EXACT match over one that only matches without its namespace", () => {
    // The near-miss sorts first. In one `find` with five clauses it would win,
    // because `find` evaluates every clause per item, in item order.
    expect(resolveMetaobjectSelection(items, "shopify--color-pattern")).toBe(
      "metaobject_type_shopify--color-pattern",
    );
  });

  it("falls back to the metafield-key spelling when nothing matches exactly", () => {
    // A linked option carries `<namespace>--<key>`, which equals the metaobject
    // type only for Shopify's standard definitions.
    expect(resolveMetaobjectSelection([items[0], items[2]], "custom--material")).toBe(
      "metaobject_type_material",
    );
  });

  it("selects nothing rather than something plausible", () => {
    expect(resolveMetaobjectSelection(items, "colour")).toBeUndefined();
    expect(resolveMetaobjectSelection(items, "custom--unknown")).toBeUndefined();
    expect(resolveMetaobjectSelection(items, null)).toBeUndefined();
    expect(resolveMetaobjectSelection(items, "")).toBeUndefined();
    expect(resolveMetaobjectSelection([], "material")).toBeUndefined();
  });
});
