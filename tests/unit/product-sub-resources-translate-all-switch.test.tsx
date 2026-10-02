/**
 * "Translate all" into every language, pressed in the PRIMARY language, and the
 * merchant switches language while it runs (owner report, 2026-10-02): the
 * option / option-value / metafield translations never appeared although
 * Shopify stored them.
 *
 * The server answered `translations: {}` and the client relied on a
 * revalidation alone -- which the card's load effect never re-reads for a view
 * that is already open (its key is item::locale::market) and which is skipped
 * outright while another revalidation is in flight. The answer now carries
 * the CONFIRMED values per locale (`localeTranslations`) and each is staged
 * under the locale it was written for.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";

const fetcher = { state: "idle", data: undefined, submit: vi.fn(), load: vi.fn(), Form: () => null };
vi.mock("react-router", () => ({ useFetcher: () => fetcher }));

import * as subResourcesModule from "~/hooks/useProductSubResources";
import { clearAllForResource } from "~/hooks/useAIOperationsStore";
const { useProductSubResources } = subResourcesModule;

const tick = (ms = 0) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

describe("Translate all: option and metafield answers land after a language switch", () => {
  const ITEM = "gid://shopify/Product/7";
  const OPT = "gid://shopify/ProductOption/1";
  const V1 = "gid://shopify/ProductOptionValue/1";
  const MF = "gid://shopify/Metafield/9";
  const item = {
    id: ITEM,
    title: "Shirt",
    options: [{ id: OPT, name: "Farbe", position: 1, values: [{ id: V1, name: "Rot" }] }],
    metafields: [{ id: MF, namespace: "custom", key: "material", value: "Baumwolle", type: "single_line_text_field" }],
    // Nothing translated yet, and no revalidation brings it in this test.
    subResourceTranslations: {},
  } as never;
  const LOCALE_TRANSLATIONS = {
    en: { [OPT]: { name: "Colour" }, [V1]: { name: "Red" }, [MF]: { value: "Cotton" } },
    fr: { [OPT]: { name: "Couleur" }, [V1]: { name: "Rouge" }, [MF]: { value: "Coton" } },
  };

  let release: (body: unknown) => void = () => {};
  beforeEach(() => {
    clearAllForResource(ITEM);
    (subResourcesModule as { __resetSubResourceSpinnerHolds?: () => void }).__resetSubResourceSpinnerHolds?.();
    vi.stubGlobal("fetch", vi.fn((url: string, init: { body: FormData }) => {
      if (String(init?.body?.get?.("action")) === "loadSubResourceTranslations") {
        return Promise.resolve({ ok: true, json: async () => ({ success: true, translations: {} }) });
      }
      return new Promise((resolve) => {
        release = (body) => resolve({ ok: true, headers: { get: () => "application/json" }, json: async () => body });
      });
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  function setup() {
    return renderHook(
      ({ lang }) =>
        useProductSubResources({
          selectedItem: item,
          currentLanguage: lang,
          primaryLocale: "de",
          selectedMarketId: "",
          enabledLanguages: ["de", "en", "fr"],
          revalidator: { state: "loading", revalidate: vi.fn() },
          showInfoBox: vi.fn(),
          strings: {},
        } as never),
      { initialProps: { lang: "de" } },
    );
  }

  const answer = {
    success: true,
    actionType: "translateSubResourceToAllLocales",
    translations: {},
    localeTranslations: LOCALE_TRANSLATIONS,
    translatedLocales: ["en", "fr"],
    failedLocales: [],
    failedResources: [],
    notTranslatable: [],
  };

  it("answer arriving while a foreign language is open shows at once", async () => {
    const { result, rerender } = setup();
    act(() => result.current.handlers.translateAllSubResourcesToAllLocales());
    rerender({ lang: "en" });
    await tick();
    await act(async () => release(answer));
    await tick();
    expect(result.current.state.optionTranslations[OPT]?.name).toBe("Colour");
    expect(result.current.state.optionTranslations[OPT]?.values[0]).toBe("Red");
    expect(result.current.state.metafieldTranslations[MF]).toBe("Cotton");
  });

  it("answer arriving back on the primary shows on the next foreign view", async () => {
    const { result, rerender } = setup();
    act(() => result.current.handlers.translateAllSubResourcesToAllLocales());
    rerender({ lang: "en" });
    await tick();
    rerender({ lang: "de" });
    await tick();
    await act(async () => release(answer));
    await tick();
    rerender({ lang: "fr" });
    await tick();
    expect(result.current.state.optionTranslations[OPT]?.name).toBe("Couleur");
    expect(result.current.state.metafieldTranslations[MF]).toBe("Coton");
  });

  it("never overwrites what the merchant typed into the open view meanwhile", async () => {
    const { result, rerender } = setup();
    act(() => result.current.handlers.translateAllSubResourcesToAllLocales());
    rerender({ lang: "en" });
    await tick();
    act(() => result.current.handlers.handleMetafieldChange(MF, "Organic cotton"));
    act(() => result.current.handlers.handleOptionNameChange(OPT, "Shade"));
    await act(async () => release(answer));
    await tick();
    // The typed resources keep the typing...
    expect(result.current.state.metafieldTranslations[MF]).toBe("Organic cotton");
    expect(result.current.state.optionTranslations[OPT]?.name).toBe("Shade");
    // ...an untouched one takes the answer.
    expect(result.current.state.optionTranslations[OPT]?.values[0]).toBe("Red");
  });

  it("maps the answer onto the item showing NOW, not the one the button was pressed on", async () => {
    const V0 = "gid://shopify/ProductOptionValue/0";
    const reloaded = {
      ...(item as unknown as Record<string, unknown>),
      // A reload put a new value in front: V1 is now at index 1.
      options: [{ id: OPT, name: "Farbe", position: 1, values: [{ id: V0, name: "Blau" }, { id: V1, name: "Rot" }] }],
    } as never;
    const { result, rerender } = renderHook(
      ({ lang, it }) =>
        useProductSubResources({
          selectedItem: it,
          currentLanguage: lang,
          primaryLocale: "de",
          selectedMarketId: "",
          enabledLanguages: ["de", "en", "fr"],
          revalidator: { state: "loading", revalidate: vi.fn() },
          showInfoBox: vi.fn(),
          strings: {},
        } as never),
      { initialProps: { lang: "de", it: item } },
    );
    act(() => result.current.handlers.translateAllSubResourcesToAllLocales());
    rerender({ lang: "en", it: item });
    await tick();
    rerender({ lang: "en", it: reloaded });
    await tick();
    await act(async () => release(answer));
    await tick();
    const values = result.current.state.optionTranslations[OPT]?.values ?? [];
    expect(values[1]).toBe("Red");
    expect(values[0]).not.toBe("Red");
  });
});
