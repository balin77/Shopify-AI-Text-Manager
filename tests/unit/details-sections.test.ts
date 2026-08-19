import { describe, it, expect } from "vitest";
import {
  groupDetailsFields,
  shouldRenderDetailsSections,
  detailsSectionLabel,
  DETAILS_SECTION_FALLBACK_LABELS,
  type DetailsSectionId,
} from "../../app/config/details-sections";
import {
  PRODUCTS_CONFIG,
  COLLECTIONS_CONFIG,
  PAGES_CONFIG,
  BLOGS_CONFIG,
} from "../../app/config/content-fields.config";
import { fieldCard } from "../../app/services/content-attributes.shared";
import type { FieldDefinition } from "../../app/types/content-editor.types";

const field = (key: string, detailsSection?: DetailsSectionId) => ({ key, detailsSection });

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

describe("groupDetailsFields", () => {
  it("folds consecutive fields of the same section into one subcard", () => {
    const blocks = groupDetailsFields([
      field("vendor", "organization"),
      field("tags", "organization"),
      field("templateSuffix", "theme"),
    ]);

    expect(blocks).toHaveLength(2);
    expect(blocks[0].fields.map((f) => f.key)).toEqual(["vendor", "tags"]);
    expect(blocks[1].id).toBe("theme");
  });

  it("keeps the config order authoritative — a split section stays split", () => {
    // Merging the two organization runs would move a field into a subcard
    // further up the card.
    const blocks = groupDetailsFields([
      field("vendor", "organization"),
      field("commerce", "publishing"),
      field("tags", "organization"),
    ]);

    expect(blocks.map((b) => b.id)).toEqual(["organization", "publishing", "organization"]);
  });

  it("collects unsectioned fields into null blocks", () => {
    const blocks = groupDetailsFields([field("status"), field("vendor", "organization")]);
    expect(blocks.map((b) => b.id)).toEqual([null, "organization"]);
  });

  it("returns nothing for an empty field list", () => {
    expect(groupDetailsFields([])).toEqual([]);
  });
});

describe("shouldRenderDetailsSections", () => {
  it("draws subcards from two FRAMED blocks up", () => {
    expect(shouldRenderDetailsSections(groupDetailsFields([
      field("commerce", "publishing"),
      field("templateSuffix", "theme"),
    ]))).toBe(true);
  });

  it("does not count a headless section — it draws no frame to separate", () => {
    // "organization" renders bare: no heading, no subcard. Counting it would
    // put a lone titled box next to it with nothing to be separated FROM,
    // which is the box-in-a-box this guard exists to prevent. That is exactly
    // the collection's Details card (rules + sort order, then the theme
    // template).
    expect(shouldRenderDetailsSections(groupDetailsFields([
      field("vendor", "organization"),
      field("templateSuffix", "theme"),
    ]))).toBe(false);
    // Two framed ones still win, headless section or not.
    expect(shouldRenderDetailsSections(groupDetailsFields([
      field("commerce", "publishing"),
      field("vendor", "organization"),
      field("templateSuffix", "theme"),
    ]))).toBe(true);
  });

  it("stays flat for a single section — the card heading already names it", () => {
    expect(shouldRenderDetailsSections(groupDetailsFields([field("templateSuffix", "theme")]))).toBe(false);
    expect(shouldRenderDetailsSections([])).toBe(false);
  });

  it("does not let an unsectioned block push the count over the line", () => {
    // [bare field, one subcard] must stay flat: the subcard would be the very
    // box-in-a-box the guard exists to prevent, with an orphan field beside it.
    const blocks = groupDetailsFields([field("status"), field("templateSuffix", "theme")]);
    expect(blocks).toHaveLength(2);
    expect(shouldRenderDetailsSections(blocks)).toBe(false);
  });
});

describe("content configs", () => {
  it("splits the product Details card into contiguous sections", () => {
    const blocks = groupDetailsFields(detailsCardFields(PRODUCTS_CONFIG.fieldDefinitions));
    expect(blocks.map((b) => b.id)).toEqual(["publishing", "organization", "theme"]);
    expect(blocks[0].fields.map((f) => f.key)).toEqual(["commerce"]);
    // The category left this card for the main one; the product type took its
    // place. See the swap test below.
    expect(blocks[1].fields.map((f) => f.key)).toEqual(["vendor", "productType", "collections", "tags"]);
    expect(shouldRenderDetailsSections(blocks)).toBe(true);
  });

  it("swaps the category and the product type between the two cards", () => {
    // The pair merchants confuse. The category is Shopify's taxonomy and now
    // sits where the admin puts it — high up, in the main card; the free-text
    // product type moved down next to the rest of the organization. Asserted
    // on `fieldCard` rather than on the raw `card` mark, because the DEFAULT
    // is what the rest of the config relies on and a regression would most
    // likely be a dropped mark, not a changed one.
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

  it("splits collections into organization + theme", () => {
    const blocks = groupDetailsFields(detailsCardFields(COLLECTIONS_CONFIG.fieldDefinitions));
    expect(blocks.map((b) => b.id)).toEqual(["organization", "theme"]);
  });

  it("splits articles into organization + theme", () => {
    // BLOGS_CONFIG's default field set IS the article one.
    const blocks = groupDetailsFields(detailsCardFields(BLOGS_CONFIG.fieldDefinitions));
    expect(blocks.map((b) => b.id)).toEqual(["organization", "theme"]);
  });

  it("leaves pages and blog containers flat — the theme template is their only attribute", () => {
    const blogContainerFields = BLOGS_CONFIG.getFieldDefinitions!({ isBlogContainer: true } as never);
    for (const fields of [PAGES_CONFIG.fieldDefinitions, blogContainerFields]) {
      const blocks = groupDetailsFields(detailsCardFields(fields));
      expect(blocks.map((b) => b.id)).toEqual(["theme"]);
      expect(shouldRenderDetailsSections(blocks)).toBe(false);
    }
  });

  it("gives every Details-card field a section, so none renders outside a subcard", () => {
    for (const config of [PRODUCTS_CONFIG, COLLECTIONS_CONFIG, PAGES_CONFIG, BLOGS_CONFIG]) {
      for (const f of detailsCardFields(config.fieldDefinitions)) {
        expect(f.detailsSection, `${config.contentType}/${f.key}`).toBeTruthy();
      }
    }
  });
});

describe("detailsSectionLabel", () => {
  it("prefers the i18n bundle", () => {
    const t = { content: { detailsSections: { theme: "Theme-Vorlage" } } };
    expect(detailsSectionLabel(t, "theme")).toBe("Theme-Vorlage");
  });

  it("falls back to English when the bundle has no entry", () => {
    expect(detailsSectionLabel({}, "organization")).toBe(DETAILS_SECTION_FALLBACK_LABELS.organization);
    expect(detailsSectionLabel({ content: {} }, "publishing")).toBe(DETAILS_SECTION_FALLBACK_LABELS.publishing);
  });
});
