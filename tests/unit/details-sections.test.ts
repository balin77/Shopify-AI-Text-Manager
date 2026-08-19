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
import { isAttributeField } from "../../app/services/content-attributes.shared";
import type { FieldDefinition } from "../../app/types/content-editor.types";

const field = (key: string, detailsSection?: DetailsSectionId) => ({ key, detailsSection });

/**
 * What the Details card actually receives: the attribute fields MINUS the ones
 * the editor hoists into the action bar (`statusControl` takes `status` for
 * products and `isPublished` for pages/articles).
 */
const detailsCardFields = (fields: FieldDefinition[]) =>
  fields.filter((f) => isAttributeField(f) && f.key !== "status" && f.key !== "isPublished");

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
      field("templateSuffix", "theme"),
      field("tags", "organization"),
    ]);

    expect(blocks.map((b) => b.id)).toEqual(["organization", "theme", "organization"]);
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
  it("draws subcards from two blocks up", () => {
    expect(shouldRenderDetailsSections(groupDetailsFields([
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
    // The sales-channel panel leads, UNSECTIONED — see the exception below.
    expect(blocks.map((b) => b.id)).toEqual([null, "organization", "theme"]);
    expect(blocks[0].fields.map((f) => f.key)).toEqual(["commerce"]);
    expect(blocks[1].fields.map((f) => f.key)).toEqual(["vendor", "category", "collections", "tags"]);
    expect(shouldRenderDetailsSections(blocks)).toBe(true);
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

  it("gives every attribute field a section — except the one that draws its own", () => {
    // `commerce` is the single exception and is named here rather than left as
    // a hole: the sales-channel panel renders its own heading, so a subcard
    // around it would print the same word twice. Anything else without a
    // section is an oversight.
    for (const config of [PRODUCTS_CONFIG, COLLECTIONS_CONFIG, PAGES_CONFIG, BLOGS_CONFIG]) {
      for (const f of detailsCardFields(config.fieldDefinitions)) {
        if (f.key === "commerce") {
          expect(f.detailsSection).toBeUndefined();
          continue;
        }
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
    expect(detailsSectionLabel({ content: {} }, "theme")).toBe(DETAILS_SECTION_FALLBACK_LABELS.theme);
  });
});
