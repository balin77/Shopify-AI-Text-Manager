import { describe, it, expect } from "vitest";
import { THEME_SAVE_ERROR_KEYS, themeSaveIssuesMessage } from "~/services/editor/theme-save-errors.shared";
import { de } from "~/i18n/de";
import { en } from "~/i18n/en";
import { es } from "~/i18n/es";

const label = (key: string) => ({ "general.headline": "Überschrift" } as Record<string, string>)[key] ?? key;

describe("theme save issues, rendered for the merchant", () => {
  it("names fields by LABEL and counts the ones that were cut off", () => {
    const text = themeSaveIssuesMessage(
      { errors: [{ errorKey: "themeSaveNotLocated", fields: ["general.headline"], count: 3 }] },
      label,
      en.content as unknown as Record<string, string>,
    );
    expect(text).toContain("Überschrift (+2)");
    expect(text).not.toContain("general.headline");
  });

  it("puts Shopify's own words inside the localised lead-in", () => {
    const text = themeSaveIssuesMessage(
      { errors: [{ errorKey: "themeSaveShopifyRejected", detail: "Liquid syntax error" }] },
      label,
      de.content as unknown as Record<string, string>,
    );
    expect(text).toBe("Shopify hat einen Teil der Änderungen abgelehnt. Meldung von Shopify: Liquid syntax error");
  });

  it("falls back (null) for a code the bundle does not know, or when there is nothing", () => {
    expect(themeSaveIssuesMessage({ errors: [{ errorKey: "somethingNew" }] }, label, en.content as any)).toBeNull();
    expect(themeSaveIssuesMessage({}, label, en.content as any)).toBeNull();
  });

  it("every code has a text in de, en and es", () => {
    for (const bundle of [de, en, es]) {
      for (const key of THEME_SAVE_ERROR_KEYS) {
        expect(typeof (bundle.content as unknown as Record<string, unknown>)[key]).toBe("string");
      }
    }
  });
});
