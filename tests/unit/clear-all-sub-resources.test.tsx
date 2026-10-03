/**
 * "Clear all" in a FOREIGN locale on the product page must reach the product's
 * options, option values and metafields too. They translate on their OWN
 * Shopify resources, so the item's `updateContent` never removed them: the
 * owner cleared a language and every option translation stayed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
  type Pending = { form: FormData; release: (answer?: unknown) => void };
  let pending: Pending[];
  const showInfoBox = vi.fn();
  const revalidate = vi.fn();

  /** Default answer: every sent resource confirmed. */
  const confirmAll = (form: FormData) => ({
    success: true,
    actionType: "saveSubResourceTranslations",
    savedResources: Object.keys(JSON.parse(String(form.get("translationsData")))),
    failedResources: [],
  });

  beforeEach(() => {
    submit.mockClear();
    showInfoBox.mockClear();
    revalidate.mockClear();
    fetcher.state = "idle";
    fetcher.data = undefined;
    pending = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: { body: FormData }) =>
        new Promise((resolve) => {
          pending.push({
            form: init.body,
            release: (answer?: unknown) =>
              resolve({ ok: true, json: async () => answer ?? confirmAll(init.body) }),
          });
        }),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function setup(language = "en", marketId = "") {
    return renderHook(
      ({ it }) =>
        useProductSubResources({
          selectedItem: it as never,
          currentLanguage: language,
          primaryLocale: "de",
          selectedMarketId: marketId,
          showInfoBox,
          revalidator: { revalidate, state: "idle" },
        } as never),
      { initialProps: { it: item(ROWS) } },
    );
  }

  async function settle(answer?: unknown) {
    await act(async () => pending[pending.length - 1].release(answer));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }

  it("sends the removals as its OWN request and shows the fields empty at once", () => {
    const { result } = setup();
    expect(result.current.state.optionTranslations[OPTION].name).toBe("Colour");
    expect(result.current.state.metafieldTranslations[MF]).toBe("Cotton");
    submit.mockClear();

    act(() => result.current.handlers.clearAllForLocale());

    // Never the shared fetcher: its next submit would abort a Phase-2 load or the
    // save bar's save, and their answers would be read as this one's.
    expect(submit).not.toHaveBeenCalled();
    expect(pending).toHaveLength(1);
    const form = pending[0].form;
    expect(form.get("action")).toBe("saveSubResourceTranslations");
    expect(form.get("locale")).toBe("en");
    expect(form.get("marketId")).toBe("");
    expect(JSON.parse(String(form.get("translationsData")))).toEqual({
      [OPTION]: { name: "" },
      [RED]: { name: "" },
      [LINKED]: { name: "" },
      [MF]: { value: "" },
    });

    expect(result.current.state.optionTranslations[OPTION]).toEqual({ name: "", values: ["", ""] });
    expect(result.current.state.metafieldTranslations[MF]).toBe("");
    expect(result.current.state.hasChanges).toBe(false);
  });

  it("a confirmed clear reports nothing itself (the editor's clear does) and reloads the item", async () => {
    const { result } = setup();
    act(() => result.current.handlers.clearAllForLocale());
    await settle();

    expect(showInfoBox).not.toHaveBeenCalled();
    expect(revalidate).toHaveBeenCalledTimes(1);
    expect(result.current.state.optionTranslations[OPTION].name).toBe("");
    expect(result.current.state.localOverlay.en?.[OPTION]).toEqual({ name: "" });
  });

  it("a failed request puts the cleared values back (nothing was removed)", async () => {
    const { result } = setup();
    act(() => result.current.handlers.clearAllForLocale());
    expect(result.current.state.optionTranslations[OPTION].name).toBe("");

    await settle({ success: false, actionType: "saveSubResourceTranslations", error: "boom" });

    expect(result.current.state.optionTranslations[OPTION].name).toBe("Colour");
    expect(result.current.state.metafieldTranslations[MF]).toBe("Cotton");
    expect(showInfoBox).toHaveBeenCalledWith("boom", "critical");
    // Nothing is left staged that would hide the live translation later.
    expect(result.current.state.localOverlay.en).toBeUndefined();
    expect(revalidate).not.toHaveBeenCalled();
  });

  it("a removal Shopify did not confirm keeps its value, the confirmed ones stay empty", async () => {
    const { result } = setup();
    act(() => result.current.handlers.clearAllForLocale());
    await settle({
      success: true,
      actionType: "saveSubResourceTranslations",
      savedResources: [OPTION, RED, LINKED],
      failedResources: [MF],
    });

    expect(result.current.state.metafieldTranslations[MF]).toBe("Cotton");
    expect(result.current.state.optionTranslations[OPTION].name).toBe("");
    expect(showInfoBox).toHaveBeenCalledWith(expect.any(String), "critical");
    expect(result.current.state.localOverlay.en?.[MF]).toBeUndefined();
  });

  it("a reload or a Phase-2 Shopify read taken before the removal does not bring a cleared value back", async () => {
    const { result, rerender } = setup();
    act(() => result.current.handlers.clearAllForLocale());
    await settle();

    // The loader ran before the delete landed: the fresh item still carries the rows.
    act(() => result.current.handlers.resetForReload());
    rerender({ it: item(ROWS) });
    expect(result.current.state.optionTranslations[OPTION].name).toBe("");
    expect(result.current.state.optionTranslations[OPTION].values[0]).toBe("");
    expect(result.current.state.metafieldTranslations[MF]).toBe("");

    // A Phase-2 answer read from Shopify before the removal.
    fetcher.data = {
      success: true,
      actionType: "loadSubResourceTranslations",
      translations: { [OPTION]: { name: "Colour" }, [RED]: { name: "Red" }, [MF]: { value: "Cotton" } },
    };
    rerender({ it: item(ROWS) });
    expect(result.current.state.optionTranslations[OPTION].name).toBe("");
    expect(result.current.state.optionTranslations[OPTION].values[0]).toBe("");
    expect(result.current.state.metafieldTranslations[MF]).toBe("");
  });

  it("a confirmed MARKET clear shows the inherited global value, greyed, and reloads", async () => {
    const { result } = setup("en", MARKET);
    expect(result.current.state.metafieldTranslations[MF]).toBe("Cotton CH");

    act(() => result.current.handlers.clearAllForLocale());
    expect(JSON.parse(String(pending[0].form.get("translationsData")))).toEqual({ [MF]: { value: "" } });
    expect(pending[0].form.get("marketId")).toBe(MARKET);
    expect(result.current.state.metafieldTranslations[MF]).toBe("");

    await settle();

    expect(result.current.state.metafieldTranslations[MF]).toBe("Cotton");
    expect(result.current.state.fallbackResourceIds.has(MF)).toBe(true);
    // No staged "" left in the market layer to hide the inherited value.
    expect(result.current.state.localOverlay[`en@@${MARKET}`]?.[MF]).toBeUndefined();
    expect(revalidate).toHaveBeenCalledTimes(1);
  });

  it("does nothing in the primary locale", () => {
    const { result } = setup("de");
    submit.mockClear();
    act(() => result.current.handlers.clearAllForLocale());
    expect(submit).not.toHaveBeenCalled();
    expect(pending).toHaveLength(0);
  });
});
