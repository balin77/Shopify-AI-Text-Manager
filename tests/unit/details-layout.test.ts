import { describe, it, expect } from "vitest";
import {
  splitDetailsFields,
  isDetailsAsideField,
  isFullWidthDetailsField,
  isHalfHeightDetailsField,
} from "../../app/config/details-layout";
import {
  PRODUCTS_CONFIG,
  COLLECTIONS_CONFIG,
  PAGES_CONFIG,
  BLOGS_CONFIG,
} from "../../app/config/content-fields.config";
import { fieldCard } from "../../app/services/content-attributes.shared";
import type { FieldDefinition } from "../../app/types/content-editor.types";

/**
 * What the Details card actually receives: whatever `fieldCard` routes there,
 * MINUS the ones the editor hoists into the action bar (`statusControl` takes
 * `status` for products and `isPublished` for pages/articles).
 *
 * `fieldCard`, not `isAttributeField`: the two came apart deliberately for the
 * category (an attribute rendered in the MAIN card) and the product type
 * (translatable content rendered HERE). Filtering by the save-semantics
 * predicate would test a layout this editor no longer has.
 */
const detailsCardFields = (fields: FieldDefinition[]) =>
  fields.filter((f) => fieldCard(f) === "details" && f.key !== "status" && f.key !== "isPublished");

/** The grid's field keys, cell by cell — a nested cell reads as a stack. */
const cellKeys = <F extends { key: string }>(grid: F[][]) => grid.map((cell) => cell.map((f) => f.key));

/** One bare attribute control: half a card, so it pairs up with the next one. */
const half = (key: string, type = "text") => ({
  key,
  type,
  translationKey: "",
  supportsTranslation: false,
});

describe("splitDetailsFields", () => {
  it("keeps the config order inside each region", () => {
    const layout = splitDetailsFields([
      half("vendor"),
      { key: "commerce", type: "commerce" },
      { key: "tags", type: "tags" },
    ]);
    expect(cellKeys(layout.grid)).toEqual([["vendor"], ["tags"]]);
    expect(layout.aside.map((f) => f.key)).toEqual(["commerce"]);
  });

  it("stacks two half-height boxes into one cell, however far apart they sit", () => {
    // The product's two are the FIRST and the LAST field of the grid. Pairing
    // is by order, not by proximity — otherwise the one control this is about
    // never meets the other one.
    const layout = splitDetailsFields([
      half("vendor"),
      { key: "tags", type: "tags" },
      half("templateSuffix", "themeTemplate"),
    ]);
    expect(cellKeys(layout.grid)).toEqual([["vendor", "templateSuffix"], ["tags"]]);
  });

  it("leaves a third half-height box to open a stack of its own", () => {
    // Two per cell: a third would make its cell taller than the boxes beside
    // it, which is the ragged row the half-row grid exists to avoid.
    const layout = splitDetailsFields([half("a"), half("b"), half("c"), half("d"), half("e")]);
    expect(cellKeys(layout.grid)).toEqual([["a", "b"], ["c", "d"], ["e"]]);
  });

  it("never stacks a full-height field", () => {
    // A field carrying chips or an AI row under its box is a whole card; two of
    // them in one cell would be two cards' worth of height in one cell's space.
    const layout = splitDetailsFields([
      { key: "collections", type: "collections" },
      { key: "tags", type: "tags" },
    ]);
    expect(cellKeys(layout.grid)).toEqual([["collections"], ["tags"]]);
  });

  it("leaves the aside empty for a type that has no channel panel", () => {
    const layout = splitDetailsFields([{ key: "templateSuffix", type: "text" }]);
    expect(layout.aside).toEqual([]);
    expect(layout.grid).toHaveLength(1);
  });

  it("returns two empty regions for an empty field list", () => {
    expect(splitDetailsFields([])).toEqual({ grid: [], aside: [] });
  });
});

describe("the two shape predicates", () => {
  it("routes the channel panel out of the grid and the rule builder across it", () => {
    // A list of switch rows and a rule editor are the two fields here that are
    // not a box; everything else shares one column width.
    expect(isDetailsAsideField({ type: "commerce" })).toBe(true);
    expect(isFullWidthDetailsField({ type: "collectionRules" })).toBe(true);
  });

  it("gives half a card to a field that is one bare control", () => {
    // An attribute rendered as a single Polaris box: a label and an input, and
    // nothing under it. Two of those stack in the space one tag picker takes.
    const attribute = { translationKey: "", supportsTranslation: false };
    expect(isHalfHeightDetailsField({ ...attribute, type: "text" })).toBe(true);
    expect(isHalfHeightDetailsField({ ...attribute, type: "themeTemplate" })).toBe(true);
    expect(isHalfHeightDetailsField({ ...attribute, type: "select" })).toBe(true);
    expect(isHalfHeightDetailsField({ ...attribute, type: "toggle" })).toBe(true);
  });

  it("keeps the full card for anything that carries more than its box", () => {
    const attribute = { translationKey: "", supportsTranslation: false };
    // Chips under the input, a rule editor, a live panel.
    for (const type of ["tags", "collections", "taxonomy", "collectionRules", "commerce"]) {
      expect(isHalfHeightDetailsField({ ...attribute, type }), type).toBe(false);
    }
  });

  it("does not shrink the product type — a `text` that is not an attribute", () => {
    // `productType` is translatable CONTENT rendered in this card, so it goes
    // through AIEditableField and carries the improve / translate / copy row
    // underneath. Keying the half card off the type alone would cut that row's
    // card in half; `isAttributeField` is the line, and it is the same
    // predicate that decides how the field SAVES.
    expect(
      isHalfHeightDetailsField({ type: "text", translationKey: "product_type", supportsTranslation: true }),
    ).toBe(false);
  });

  it("leaves every ordinary field in a column of its own", () => {
    for (const type of ["text", "tags", "collections", "select", "toggle", "money"]) {
      expect(isDetailsAsideField({ type }), type).toBe(false);
      expect(isFullWidthDetailsField({ type }), type).toBe(false);
    }
  });

  it("never puts one field in both — the aside is not inside the grid", () => {
    // `--full` is a grid-column rule; on a field that never reaches the grid it
    // would be a style with nothing to apply to, and the two answers would be
    // read as contradicting each other.
    for (const type of ["commerce", "collectionRules"]) {
      expect(isDetailsAsideField({ type }) && isFullWidthDetailsField({ type }), type).toBe(false);
    }
  });
});

describe("content configs", () => {
  it("halves exactly the vendor and the theme template on a product", () => {
    const layout = splitDetailsFields(detailsCardFields(PRODUCTS_CONFIG.fieldDefinitions));
    expect(layout.grid.flat().filter(isHalfHeightDetailsField).map((f) => f.key)).toEqual([
      "vendor",
      "templateSuffix",
    ]);
  });

  it("reads the product card left to right, channels last", () => {
    // The order the merchant asked for: vendor, product type, collections,
    // tags — and then the channel panel, which renders as the region on the
    // RIGHT and is therefore last in the list. The theme template is the one
    // field that moves: it is a bare control like the vendor, so the two share
    // the vendor's cell rather than opening a fifth column between them.
    const layout = splitDetailsFields(detailsCardFields(PRODUCTS_CONFIG.fieldDefinitions));
    expect(cellKeys(layout.grid)).toEqual([
      ["vendor", "templateSuffix"],
      ["productType"],
      ["collections"],
      ["tags"],
    ]);
    expect(layout.aside.map((f) => f.key)).toEqual(["commerce"]);
  });

  it("swaps the category and the product type between the two cards", () => {
    // The pair merchants confuse. The category is Shopify's taxonomy and sits
    // where the admin puts it — high up, in the main card; the free-text
    // product type sits down here with the rest of the organization. Asserted
    // on `fieldCard` rather than on the raw `card` mark, because the DEFAULT is
    // what the rest of the config relies on and a regression would most likely
    // be a dropped mark, not a changed one.
    const byKey = new Map(PRODUCTS_CONFIG.fieldDefinitions.map((f) => [f.key, f]));
    expect(fieldCard(byKey.get("category")!)).toBe("main");
    expect(fieldCard(byKey.get("productType")!)).toBe("details");
    // Each keeps its own save semantics: the category is still an attribute
    // (locked in a foreign locale, gated on changedFields), the product type
    // is still translatable content.
    expect(byKey.get("category")!.supportsTranslation).toBe(false);
    expect(byKey.get("productType")!.supportsTranslation).toBe(true);
  });

  it("keeps the default variant's price out of the Details card", () => {
    // It describes a VARIANT and lives in the variants card, next to the
    // options that say which variant is which. A second price control here
    // would be a second answer to one question.
    expect(PRODUCTS_CONFIG.fieldDefinitions.map((f) => f.key)).not.toContain("price");
  });

  it("gives the other content types a grid and nothing beside it", () => {
    // Only a product has sales channels, so every other type is one grid — and
    // the collection's rule builder is the one field in it that spans.
    const blogContainerFields = BLOGS_CONFIG.getFieldDefinitions!({ isBlogContainer: true } as never);
    for (const fields of [
      COLLECTIONS_CONFIG.fieldDefinitions,
      PAGES_CONFIG.fieldDefinitions,
      BLOGS_CONFIG.fieldDefinitions,
      blogContainerFields,
    ]) {
      const layout = splitDetailsFields(detailsCardFields(fields));
      expect(layout.aside).toEqual([]);
      expect(layout.grid.length).toBeGreaterThan(0);
    }

    const collections = splitDetailsFields(detailsCardFields(COLLECTIONS_CONFIG.fieldDefinitions));
    expect(collections.grid.flat().filter(isFullWidthDetailsField).map((f) => f.key)).toEqual([
      "collectionRules",
    ]);
  });
});
