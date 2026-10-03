import { describe, it, expect } from "vitest";
import {
  FIELD_TO_TRANSLATION_KEY,
  fieldTranslationKeyMap,
  TRANSLATION_KEY_TO_FIELD,
} from "../../app/services/translations/translation-keys.shared";
import {
  FIELD_TO_TRANSLATION_KEY as REEXPORTED,
  fieldTranslationKeyMap as reexportedFn,
} from "../../src/services/shopify-content.service";
import { UI_FIELD_TO_TRANSLATION_KEY } from "../../app/constants/shopifyFields";

// Characterisation of the field -> translation-key mapping per resource type.
const CANONICAL = {
  title: "title",
  description: "body_html",
  body: "body_html",
  handle: "handle",
  seoTitle: "meta_title",
  metaDescription: "meta_description",
  productType: "product_type",
  summary: "summary_html",
};

describe("translation-keys.shared", () => {
  it.each(["Product", "Collection", "Page", "Article", "Blog", "Metaobject"])(
    "%s uses the canonical map",
    (type) => {
      expect(fieldTranslationKeyMap(type)).toEqual(CANONICAL);
    },
  );

  it("ShopPolicy translates description/body under body", () => {
    expect(fieldTranslationKeyMap("ShopPolicy")).toEqual({ ...CANONICAL, description: "body", body: "body" });
  });

  it("shopify-content.service re-exports the same objects", () => {
    expect(REEXPORTED).toBe(FIELD_TO_TRANSLATION_KEY);
    expect(reexportedFn).toBe(fieldTranslationKeyMap);
  });

  it("inverse map matches the former TRANSLATION_KEY_TO_FIELD_KEY literal", () => {
    expect(TRANSLATION_KEY_TO_FIELD).toEqual({
      title: "title",
      body_html: "description",
      body: "description",
      handle: "handle",
      meta_title: "seoTitle",
      meta_description: "metaDescription",
      product_type: "productType",
      summary_html: "summary",
    });
  });

  it("UI map keeps its aliases and the body -> body policy behaviour", () => {
    expect(UI_FIELD_TO_TRANSLATION_KEY).toEqual({
      title: "title",
      description: "body_html",
      body_html: "body_html",
      body: "body",
      handle: "handle",
      seoTitle: "meta_title",
      meta_title: "meta_title",
      metaDescription: "meta_description",
      meta_description: "meta_description",
      productType: "product_type",
      product_type: "product_type",
      summary: "summary_html",
    });
  });
});
