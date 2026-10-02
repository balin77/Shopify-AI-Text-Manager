/**
 * "Clear all" in a FOREIGN locale on the product page must reach the product's
 * options, option values and metafields too. They translate on their OWN
 * Shopify resources, so the item's `updateContent` never removed them: the
 * owner cleared a language and every option translation stayed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { buildClearAllSubResourcePayload } from "~/services/editor/sub-resource-clear.shared";

const submit = vi.fn();
const fetcher: { state: string; data: unknown; submit: typeof submit; load: () => void; Form: () => null } = {
  state: "idle",
  data: undefined,
  submit,
  load: vi.fn(),
  Form: () => null,
};

vi.mock("react-router", () => ({
  useFetcher: () => fetcher,
}));

import { useProductSubResources } from "~/hooks/useProductSubResources";

const OPTION = "gid://shopify/ProductOption/1";
const RED = "gid://shopify/ProductOptionValue/1";
const BLUE = "gid://shopify/ProductOptionValue/2";
const LINKED = "gid://shopify/ProductOption/2";
const LINKED_VALUE = "gid://shopify/ProductOptionValue/3";
const MF = "gid://shopify/Metafield/1";
const MF_EMPTY = "gid://shopify/Metafield/2";
const MARKET = "gid://shopify/Market/9";

function item(rows: Record<string, Array<{ key: string; value: string; locale: string; marketId?: string }>>) {
  return {
    id: "gid://shopify/Product/1",
    title: "Shirt",
    options: [
      { id: OPTION, name: "Farbe", position: 1, values: [{ id: RED, name: "Rot" }, { id: BLUE, name: "Blau" }] },
      { id: LINKED, name: "Muster", position: 2, isLinked: true, values: [{ id: LINKED_VALUE, name: "Streifen" }] },
    ],
    metafields: [
      { id: MF, namespace: "custom", key: "material", value: "Baumwolle", type: "single_line_text_field" },
      { id: MF_EMPTY, namespace: "custom", key: "care", value: "Waschen", type: "single_line_text_field" },
    ],
    subResourceTranslations: rows,
  };
}

const ROWS = {
  [OPTION]: [{ key: "name", value: "Colour", locale: "en" }],
  [RED]: [{ key: "name", value: "Red", locale: "en" }],
  [LINKED]: [{ key: "name", value: "Pattern", locale: "en" }],
  [LINKED_VALUE]: [{ key: "name", value: "Stripes", locale: "en" }],
  [MF]: [
    { key: "value", value: "Cotton", locale: "en" },
    { key: "value", value: "Cotton CH", locale: "en", marketId: MARKET },
  ],
  // Another locale's row is not this clear's business.
  [BLUE]: [{ key: "name", value: "Bleu", locale: "fr" }],
};

describe("buildClearAllSubResourcePayload", () => {
  const base = {
    locale: "en",
    optionTranslations: {},
    metafieldTranslations: {},
    fallbackResourceIds: new Set<string>(),
  };

  it("sends every option name, unlinked option value and metafield that holds a value in the global layer", () => {
    const { translationsData, resourceTypes } = buildClearAllSubResourcePayload({ ...base, item: item(ROWS), marketId: "" });

    expect(translationsData).toEqual({
      [OPTION]: { name: "" },
      [RED]: { name: "" },
      [LINKED]: { name: "" },
      [MF]: { value: "" },
    });
    expect(resourceTypes).toEqual({
      [OPTION]: "ProductOption",
      [RED]: "ProductOptionValue",
      [LINKED]: "ProductOption",
      [MF]: "Metafield",
    });
  });

  it("in a market sends only that market's overrides, never a value inherited from the global layer", () => {
    const { translationsData } = buildClearAllSubResourcePayload({
      ...base,
      item: item(ROWS),
      marketId: MARKET,
      // The card shows the global Colour as inherited.
      optionTranslations: { [OPTION]: { name: "Colour", values: ["Red", ""] } },
      fallbackResourceIds: new Set([OPTION, RED]),
    });

    expect(translationsData).toEqual({ [MF]: { value: "" } });
  });

  it("also covers values only the hook's state or the staged overlay knows (a Shopify read-back, a fresh copy)", () => {
    const { translationsData } = buildClearAllSubResourcePayload({
      ...base,
      item: item({}),
      marketId: "",
      optionTranslations: { [OPTION]: { name: "", values: ["", "Blue"] } },
      metafieldTranslations: { [MF_EMPTY]: "Wash" },
      overlayForLayer: { [OPTION]: { name: "Colour" } },
    });

    expect(Object.keys(translationsData).sort()).toEqual([BLUE, MF_EMPTY, OPTION].sort());
  });

  it("sends nothing for a product with no translation in that locale", () => {
    const { translationsData } = buildClearAllSubResourcePayload({ ...base, locale: "it", item: item(ROWS), marketId: "" });
    expect(translationsData).toEqual({});
  });
});

describe("useProductSubResources.clearAllForLocale", () => {
  beforeEach(() => {
    submit.mockClear();
    fetcher.state = "idle";
    fetcher.data = undefined;
  });

  function setup(language = "en", marketId = "") {
    return renderHook(() =>
      useProductSubResources({
        selectedItem: item(ROWS) as never,
        currentLanguage: language,
        primaryLocale: "de",
        selectedMarketId: marketId,
        showInfoBox: vi.fn(),
      } as never),
    );
  }

  it("submits the removals of this locale and shows the fields empty at once", () => {
    const { result } = setup();
    expect(result.current.state.optionTranslations[OPTION].name).toBe("Colour");
    expect(result.current.state.metafieldTranslations[MF]).toBe("Cotton");

    act(() => result.current.handlers.clearAllForLocale());

    const form = submit.mock.calls.at(-1)?.[0] as Record<string, string>;
    expect(form.action).toBe("saveSubResourceTranslations");
    expect(form.locale).toBe("en");
    expect(form.marketId).toBe("");
    expect(JSON.parse(form.translationsData)).toEqual({
      [OPTION]: { name: "" },
      [RED]: { name: "" },
      [LINKED]: { name: "" },
      [MF]: { value: "" },
    });

    expect(result.current.state.optionTranslations[OPTION]).toEqual({ name: "", values: ["", ""] });
    expect(result.current.state.metafieldTranslations[MF]).toBe("");
    expect(result.current.state.hasChanges).toBe(false);
  });

  it("a failed request puts the cleared values back (nothing was removed)", () => {
    const { result, rerender } = setup();
    act(() => result.current.handlers.clearAllForLocale());
    expect(result.current.state.optionTranslations[OPTION].name).toBe("");

    fetcher.data = { success: false, actionType: "saveSubResourceTranslations", error: "boom" };
    rerender();

    expect(result.current.state.optionTranslations[OPTION].name).toBe("Colour");
    expect(result.current.state.metafieldTranslations[MF]).toBe("Cotton");
  });

  it("does nothing in the primary locale", () => {
    const { result } = setup("de");
    submit.mockClear();
    act(() => result.current.handlers.clearAllForLocale());
    expect(submit).not.toHaveBeenCalled();
  });
});
