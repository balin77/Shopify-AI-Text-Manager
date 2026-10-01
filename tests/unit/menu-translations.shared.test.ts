/**
 * The pure half of menu translations.
 *
 * The GID derivation is the load-bearing piece: it is measured behaviour
 * (gid://shopify/MenuItem/<n> -> gid://shopify/Link/<n>), and a wrong or
 * fabricated id would be written to without Shopify complaining — the silent
 * no-op this codebase treats as the worst possible outcome. So the tests care
 * as much about what it REFUSES as about what it derives.
 */

import { describe, it, expect } from "vitest";
import {
  linkGidForMenuItem,
  flattenMenuItems,
  diffMenuTranslations,
} from "../../app/services/menu-translations.shared";

describe("linkGidForMenuItem", () => {
  it("keeps the number and swaps the type", () => {
    expect(linkGidForMenuItem("gid://shopify/MenuItem/796316107084")).toBe(
      "gid://shopify/Link/796316107084",
    );
  });

  it("tolerates surrounding whitespace", () => {
    expect(linkGidForMenuItem("  gid://shopify/MenuItem/123  ")).toBe("gid://shopify/Link/123");
  });

  it("refuses anything that is not a MenuItem GID rather than guessing", () => {
    // Each of these would otherwise produce a plausible-looking Link GID that
    // addresses nothing, and translationsRegister would accept it silently.
    expect(linkGidForMenuItem("gid://shopify/Link/123")).toBeNull();
    expect(linkGidForMenuItem("gid://shopify/Product/123")).toBeNull();
    expect(linkGidForMenuItem("gid://shopify/MenuItem/abc")).toBeNull();
    expect(linkGidForMenuItem("gid://shopify/MenuItem/")).toBeNull();
    expect(linkGidForMenuItem("796316107084")).toBeNull();
    expect(linkGidForMenuItem("")).toBeNull();
  });
});

describe("flattenMenuItems", () => {
  const tree = [
    {
      id: "gid://shopify/MenuItem/1",
      title: "Produkte",
      items: [
        {
          id: "gid://shopify/MenuItem/2",
          title: "Stifthalter",
          items: [
            { id: "gid://shopify/MenuItem/3", title: "Halter Lila" },
            { id: "gid://shopify/MenuItem/4", title: "Halter Rot" },
          ],
        },
      ],
    },
    { id: "gid://shopify/MenuItem/5", title: "Kontakt" },
  ];

  it("returns every item at every depth, in merchant order", () => {
    const flat = flattenMenuItems(tree);
    expect(flat.map((i) => i.title)).toEqual([
      "Produkte",
      "Stifthalter",
      "Halter Lila",
      "Halter Rot",
      "Kontakt",
    ]);
    expect(flat.map((i) => i.depth)).toEqual([1, 2, 3, 3, 1]);
  });

  it("derives a Link GID for every level — depth is not a discriminator", () => {
    const flat = flattenMenuItems(tree);
    expect(flat.every((i) => i.linkId !== null)).toBe(true);
    expect(flat.find((i) => i.title === "Halter Rot")?.linkId).toBe("gid://shopify/Link/4");
  });

  it("numbers items by position path", () => {
    const flat = flattenMenuItems(tree);
    expect(flat.find((i) => i.title === "Halter Rot")?.path).toEqual([1, 1, 2]);
    expect(flat.find((i) => i.title === "Kontakt")?.path).toEqual([2]);
  });

  it("survives the shapes a Json column can actually hold", () => {
    expect(flattenMenuItems(null)).toEqual([]);
    expect(flattenMenuItems(undefined)).toEqual([]);
    expect(flattenMenuItems("not an array")).toEqual([]);
    expect(flattenMenuItems([{ title: "no id" }])).toEqual([]);
    // A missing title is renderable (the sweep supplies the real one); a
    // missing id is not addressable and must be dropped.
    expect(flattenMenuItems([{ id: "gid://shopify/MenuItem/9" }])).toHaveLength(1);
  });

  it("stops at maxDepth instead of hanging on a cyclic row", () => {
    const cyclic: Record<string, unknown> = { id: "gid://shopify/MenuItem/1", title: "loop" };
    cyclic.items = [cyclic];
    expect(flattenMenuItems([cyclic], 4)).toHaveLength(4);
  });
});

describe("diffMenuTranslations", () => {
  it("reports only what changed", () => {
    const changes = diffMenuTranslations(
      { a: "Designer Vases", b: "Flower Pots" },
      { a: "Designer Vases", b: "Planters" },
    );
    expect(changes).toEqual([{ linkId: "b", value: "Planters" }]);
  });

  it("treats a cleared field as a removal, not as a blank value", () => {
    expect(diffMenuTranslations({ a: "Designer Vases" }, { a: "" })).toEqual([
      { linkId: "a", value: "" },
    ]);
  });

  it("does not queue a write for whitespace-only wobble", () => {
    expect(diffMenuTranslations({ a: "Vases" }, { a: "  Vases  " })).toEqual([]);
  });

  it("trims the value it hands on, so what is compared is what is written", () => {
    expect(diffMenuTranslations({ a: "Vases" }, { a: "  Designer Vases  " })).toEqual([
      { linkId: "a", value: "Designer Vases" },
    ]);
  });

  it("counts a first translation as a change", () => {
    expect(diffMenuTranslations({}, { a: "Pen Holders" })).toEqual([
      { linkId: "a", value: "Pen Holders" },
    ]);
  });

  it("ignores items the merchant never touched", () => {
    expect(diffMenuTranslations({ a: "x" }, {})).toEqual([]);
  });
});
