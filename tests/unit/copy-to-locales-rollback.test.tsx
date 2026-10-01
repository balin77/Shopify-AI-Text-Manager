/**
 * "Copy to all languages" writes the copied value into the overlay for every
 * locale up front, and the overlay outranks the loaded data in resolve(). A
 * locale whose save then FAILED must show what Shopify holds again -- before
 * this, it went on showing the copied value until the page was reloaded.
 */
import { describe, it, expect } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { useUiDataLoader } from "~/hooks/useUiDataLoader";
import type { ContentEditorConfig, TranslatableContentItem } from "~/types/content-editor.types";

const config = { contentType: "product" } as unknown as ContentEditorConfig;

const item = {
  id: "gid://shopify/Product/1",
  title: "Titel",
  handle: "titel",
  translations: [
    { key: "title", locale: "fr", value: "Titre existant" },
    { key: "title", locale: "it", value: "Titolo esistente" },
  ],
} as unknown as TranslatableContentItem;

function setup() {
  return renderHook(() => useUiDataLoader({ config, primaryLocale: "de" }));
}

const value = (api: ReturnType<typeof setup>["result"]["current"], locale: string) =>
  api.resolve(item, "title", "title", locale).value;

describe("onCopyToLocalesFailed", () => {
  it("takes the copied value back for the FAILED locales only", () => {
    const { result } = setup();
    act(() => {
      result.current.onTranslateFieldToAllLocalesComplete("title", { fr: "Titel", it: "Titel" }, "de");
    });
    expect(value(result.current, "fr")).toBe("Titel");
    expect(value(result.current, "it")).toBe("Titel");

    act(() => result.current.onCopyToLocalesFailed("title", ["fr"], "Titel"));

    // fr did not save: what Shopify holds is shown again. it did: stays.
    expect(value(result.current, "fr")).toBe("Titre existant");
    expect(value(result.current, "it")).toBe("Titel");
  });

  it("leaves a value written there since alone", () => {
    const { result } = setup();
    act(() => {
      result.current.onTranslateFieldToAllLocalesComplete("title", { fr: "Titel" }, "de");
      // The merchant typed a French title before the copy's answer came back.
      result.current.onTranslateFieldToAllLocalesComplete("title", { fr: "Mon titre" }, "fr");
    });
    act(() => result.current.onCopyToLocalesFailed("title", ["fr"], "Titel"));
    expect(value(result.current, "fr")).toBe("Mon titre");
  });

  it("puts back the deleted marker the copy cleared", () => {
    const { result } = setup();
    // The merchant had emptied the French title (deleted marker), then copied.
    act(() => {
      result.current.refs.deletedTranslationKeysRef.current.add("title");
      result.current.onTranslateFieldToAllLocalesComplete("title", { fr: "Titel" }, "de");
    });
    expect(result.current.refs.deletedTranslationKeysRef.current.has("title")).toBe(false);

    act(() => result.current.onCopyToLocalesFailed("title", ["fr"], "Titel"));
    expect(result.current.refs.deletedTranslationKeysRef.current.has("title")).toBe(true);
    expect(value(result.current, "fr")).toBe("");
  });

  it("does not invent a deleted marker that was never there", () => {
    const { result } = setup();
    act(() => {
      result.current.onTranslateFieldToAllLocalesComplete("title", { fr: "Titel" }, "de");
    });
    act(() => result.current.onCopyToLocalesFailed("title", ["fr"], "Titel"));
    expect(result.current.refs.deletedTranslationKeysRef.current.has("title")).toBe(false);
  });

  it("keeps the marker cleared when only SOME locales failed", () => {
    const { result } = setup();
    act(() => {
      result.current.refs.deletedTranslationKeysRef.current.add("title");
      result.current.onTranslateFieldToAllLocalesComplete("title", { fr: "Titel", it: "Titel" }, "de");
    });
    act(() =>
      result.current.onCopyToLocalesFailed("title", ["fr"], "Titel", {
        itemUnchanged: true,
        allLocalesFailed: false,
      }),
    );
    expect(result.current.refs.deletedTranslationKeysRef.current.has("title")).toBe(false);
  });

  it("does not restore the marker when the item changed meanwhile", () => {
    const { result } = setup();
    act(() => {
      result.current.refs.deletedTranslationKeysRef.current.add("title");
      result.current.onTranslateFieldToAllLocalesComplete("title", { fr: "Titel" }, "de");
    });
    act(() =>
      result.current.onCopyToLocalesFailed("title", ["fr"], "Titel", {
        itemUnchanged: false,
        allLocalesFailed: true,
      }),
    );
    expect(result.current.refs.deletedTranslationKeysRef.current.has("title")).toBe(false);
  });

  it("forgets a cleared marker on item switch, so a later failure cannot resurrect it", () => {
    const { result } = setup();
    act(() => {
      result.current.refs.deletedTranslationKeysRef.current.add("title");
      result.current.onTranslateFieldToAllLocalesComplete("title", { fr: "Titel" }, "de");
      result.current.onItemSwitch();
    });
    act(() => result.current.onCopyToLocalesFailed("title", ["fr"], "Titel"));
    expect(result.current.refs.deletedTranslationKeysRef.current.has("title")).toBe(false);
  });
});
