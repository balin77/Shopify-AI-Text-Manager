import { describe, it, expect } from "vitest";
import {
  SHOPIFY_TRANSLATION_KEYS,
  UI_FIELD_TO_TRANSLATION_KEY,
  TRANSLATION_KEY_MAP,
} from "../../app/constants/shopifyFields";
import { hasFieldMissingTranslations } from "../../app/utils/field-validation.utils";

const shopLocales = [
  { locale: "de", primary: true, published: true, name: "German" },
  { locale: "fr", primary: false, published: true, name: "French" },
] as never;

const article = (translations: Array<{ key: string; locale: string; value: string }>) =>
  ({
    id: "gid://shopify/Article/1",
    title: "Titel",
    body: "<p>Text</p>",
    summary: "Kurzfassung",
    handle: "titel",
    translations,
  }) as never;

describe("article summary translation key", () => {
  it("is Shopify's summary_html everywhere the UI maps it", () => {
    expect(SHOPIFY_TRANSLATION_KEYS.SUMMARY).toBe("summary_html");
    expect(UI_FIELD_TO_TRANSLATION_KEY.summary).toBe("summary_html");
    expect(TRANSLATION_KEY_MAP.summary).toBe("summary_html");
  });

  it("marks a summary with no foreign translation as missing", () => {
    expect(hasFieldMissingTranslations(article([]), "summary", shopLocales, "de", "blogs")).toBe(true);
  });

  it("clears the marker once the summary_html translation exists", () => {
    const item = article([{ key: "summary_html", locale: "fr", value: "Résumé" }]);
    expect(hasFieldMissingTranslations(item, "summary", shopLocales, "de", "blogs")).toBe(false);
  });
});
