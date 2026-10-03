/**
 * The options & metafields card's lifecycle rules around the shared fetcher,
 * the staged overlay and reloads:
 * - a primary translate-to-all supersedes every staged value of the resources
 *   it wrote, in every locale;
 * - a staged entry EXPIRES once it is older than the keep window and the item
 *   was loaded after it (it used to shadow newer server values forever);
 * - a Phase-2 load answer is applied only to the view it was asked for, never
 *   goes out while the save bar's save is in flight, and is re-sent after a
 *   save that aborted it;
 * - a reload asked for while one is running is QUEUED, not dropped;
 * - a translate answer merges against the item showing NOW.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";

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

import * as subResourcesModule from "~/hooks/useProductSubResources";
const { useProductSubResources } = subResourcesModule;
import { clearAllForResource } from "~/hooks/useAIOperationsStore";

const ITEM = "gid://shopify/Product/41";
const OPT = "gid://shopify/ProductOption/41";
const V1 = "gid://shopify/ProductOptionValue/41";
const V2 = "gid://shopify/ProductOptionValue/42";
const MF = "gid://shopify/Metafield/41";
const MARKET = "gid://shopify/Market/41";

type Rows = Record<string, Array<{ key: string; value: string; locale: string; marketId?: string }>>;

function makeItem(rows: Rows = {}, valueOrder: string[] = [V1, V2]) {
  const names: Record<string, string> = { [V1]: "Rot", [V2]: "Blau" };
  return {
    id: ITEM,
    title: "Shirt",
    options: [{ id: OPT, name: "Farbe", position: 1, values: valueOrder.map((id) => ({ id, name: names[id] })) }],
    metafields: [{ id: MF, namespace: "custom", key: "material", value: "Baumwolle", type: "single_line_text_field" }],
    subResourceTranslations: rows,
  } as never;
}

/** Every resource translated in both foreign locales: no Phase-2 load. */
const FULL: Rows = {
  [OPT]: [
    { key: "name", value: "Colour", locale: "en" },
    { key: "name", value: "Couleur", locale: "fr" },
  ],
  [V1]: [
    { key: "name", value: "Red", locale: "en" },
    { key: "name", value: "Rouge", locale: "fr" },
  ],
  [V2]: [
    { key: "name", value: "Blue", locale: "en" },
    { key: "name", value: "Bleu", locale: "fr" },
  ],
  [MF]: [
    { key: "value", value: "Cotton", locale: "en" },
    { key: "value", value: "Coton", locale: "fr" },
    { key: "value", value: "Cotton CH", locale: "en", marketId: MARKET },
  ],
};

const TRANSLATED: Record<string, string> = { [OPT]: "Color", [V1]: "Crimson", [V2]: "Navy", [MF]: "Cotton2" };

function answerFor(form: FormData) {
  const action = String(form.get("action"));
  if (action === "saveSubResourceTranslations") {
    const data = JSON.parse(String(form.get("translationsData")));
    return { success: true, actionType: action, savedResources: Object.keys(data), failedResources: [] };
  }
  const src = JSON.parse(String(form.get("sourceData"))) as Array<{ resourceId: string; key: string }>;
  const translations: Record<string, Record<string, string>> = {};
  for (const s of src) (translations[s.resourceId] ??= {})[s.key] = TRANSLATED[s.resourceId];
  return { success: true, actionType: action, translations, savedResources: Object.keys(translations), failedResources: [] };
}

let pending: Array<{ form: FormData; release: () => void }> = [];
const revalidate = vi.fn();
const showInfoBox = vi.fn();

async function settleLast() {
  await act(async () => pending[pending.length - 1].release());
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

interface Props {
  it: unknown;
  lang: string;
  market?: string;
  reload?: string;
}

function setup(initial: Props) {
  return renderHook(
    ({ it, lang, market = "", reload = "idle" }: Props) =>
      useProductSubResources({
        selectedItem: it,
        currentLanguage: lang,
        primaryLocale: "de",
        selectedMarketId: market,
        enabledLanguages: ["de", "en", "fr"],
        revalidator: { revalidate, state: reload },
        showInfoBox,
        strings: {},
      } as never),
    { initialProps: initial },
  );
}

const loadSubmits = () =>
  submit.mock.calls.filter((c) => (c[0] as Record<string, unknown>)?.action === "loadSubResourceTranslations");

beforeEach(() => {
  submit.mockClear();
  revalidate.mockClear();
  showInfoBox.mockClear();
  fetcher.state = "idle";
  fetcher.data = undefined;
  pending = [];
  clearAllForResource(ITEM);
  subResourcesModule.__resetSubResourceSpinnerHolds();
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (_url: string, init: { body: FormData }) =>
        new Promise((resolve) => {
          pending.push({ form: init.body, release: () => resolve({ ok: true, json: async () => answerFor(init.body) }) });
        }),
    ),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a primary translate-to-all supersedes staged values", () => {
  it("drops the staged entries of the sent resources in every locale and reloads", async () => {
    const { result, rerender } = setup({ it: makeItem(FULL), lang: "en" });
    act(() => result.current.handlers.translateOptionField(OPT, "value", 0));
    await settleLast();
    expect(result.current.state.localOverlay.en?.[V1]).toEqual({ name: "Crimson" });

    rerender({ it: makeItem(FULL), lang: "de" });
    act(() => result.current.handlers.translateAllSubResourcesToAllLocales());
    await settleLast();

    expect(result.current.state.localOverlay.en?.[V1]).toBeUndefined();
    expect(revalidate).toHaveBeenCalled();
  });
});

describe("staged entries expire", () => {
  it("an entry older than the window is dropped once a newer item is loaded; inside the window it stays", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const { result, rerender } = setup({ it: makeItem(FULL), lang: "en" });
    act(() => result.current.handlers.translateOptionField(OPT, "value", 0));
    await settleLast();
    expect(result.current.state.optionTranslations[OPT].values[0]).toBe("Crimson");

    // A reload delivers a newer item carrying a newer server value.
    const newer: Rows = { ...FULL, [V1]: [{ key: "name", value: "Scarlet", locale: "en" }, { key: "name", value: "Rouge", locale: "fr" }] };
    now += 1_000;
    rerender({ it: makeItem(newer), lang: "en" });

    // Inside the keep window a locale round trip still shows the staged answer.
    rerender({ it: makeItem(newer), lang: "fr" });
    rerender({ it: makeItem(newer), lang: "en" });
    expect(result.current.state.optionTranslations[OPT].values[0]).toBe("Crimson");

    // Past it, the item (loaded after the answer) wins.
    now += 3 * 60 * 1000;
    rerender({ it: makeItem(newer), lang: "fr" });
    const reloaded = makeItem(newer);
    now += 1;
    rerender({ it: reloaded, lang: "fr" });
    rerender({ it: reloaded, lang: "en" });
    expect(result.current.state.optionTranslations[OPT].values[0]).toBe("Scarlet");
    expect(result.current.state.localOverlay.en?.[V1]).toBeUndefined();
  });
});

describe("the Phase-2 load", () => {
  const EN_ONLY: Rows = {
    [OPT]: [{ key: "name", value: "Couleur", locale: "fr" }],
    [V1]: [{ key: "name", value: "Rouge", locale: "fr" }],
    [V2]: [{ key: "name", value: "Bleu", locale: "fr" }],
    [MF]: [{ key: "value", value: "Coton", locale: "fr" }],
  };

  it("an answer that lands after a language switch is not applied to the new view", () => {
    const { result, rerender } = setup({ it: makeItem(EN_ONLY), lang: "en" });
    expect(loadSubmits()).toHaveLength(1);
    rerender({ it: makeItem(EN_ONLY), lang: "fr" });
    expect(result.current.state.optionTranslations[OPT].name).toBe("Couleur");

    act(() => {
      fetcher.data = { success: true, actionType: "loadSubResourceTranslations", translations: { [OPT]: { name: "Colour" } } };
      rerender({ it: makeItem(EN_ONLY), lang: "fr" });
    });
    expect(result.current.state.optionTranslations[OPT].name).toBe("Couleur");
    expect(result.current.state.isLoading).toBe(false);
  });

  it("is not submitted while the save bar's save is in flight, and goes out once it is done", () => {
    const { rerender } = setup({ it: makeItem(FULL), lang: "fr" });
    expect(loadSubmits()).toHaveLength(0);
    fetcher.state = "submitting";
    rerender({ it: makeItem(EN_ONLY), lang: "en" });
    expect(loadSubmits()).toHaveLength(0);

    act(() => {
      fetcher.state = "idle";
      fetcher.data = { success: true, actionType: "saveSubResourceTranslations", savedResources: [], failedResources: [] };
      rerender({ it: makeItem(EN_ONLY), lang: "en" });
    });
    expect(loadSubmits()).toHaveLength(1);
    expect(loadSubmits()[0][0]).toMatchObject({ locale: "en" });
  });

  it("a save that aborted a load in flight re-sends it afterwards", () => {
    const { result, rerender } = setup({ it: makeItem(EN_ONLY), lang: "en" });
    expect(loadSubmits()).toHaveLength(1);
    act(() => result.current.handlers.handleMetafieldChange(MF, "Linen"));
    act(() => result.current.handlers.saveSubResources());
    expect(submit).toHaveBeenCalledTimes(2);

    act(() => {
      fetcher.state = "submitting";
      rerender({ it: makeItem(EN_ONLY), lang: "en" });
    });
    act(() => {
      fetcher.state = "idle";
      fetcher.data = { success: true, actionType: "saveSubResourceTranslations", savedResources: [MF], failedResources: [] };
      rerender({ it: makeItem(EN_ONLY), lang: "en" });
    });
    expect(loadSubmits()).toHaveLength(2);
  });
});

describe("a reload asked for while one is running", () => {
  it("is queued and fires once the revalidator is idle (market clear)", async () => {
    const { result, rerender } = setup({ it: makeItem(FULL), lang: "en", market: MARKET });
    act(() => result.current.handlers.clearAllForLocale());
    rerender({ it: makeItem(FULL), lang: "en", market: MARKET, reload: "loading" });
    await settleLast();
    expect(revalidate).not.toHaveBeenCalled();

    rerender({ it: makeItem(FULL), lang: "en", market: MARKET, reload: "idle" });
    expect(revalidate).toHaveBeenCalledTimes(1);
  });
});

describe("a translate answer", () => {
  it("is merged against the item showing when it lands, not the one it was asked on", async () => {
    const { result, rerender } = setup({ it: makeItem(FULL), lang: "en" });
    act(() => result.current.handlers.translateOptionField(OPT, "value", 0));
    // A reload reorders the values before the answer lands.
    act(() => result.current.handlers.resetForReload());
    rerender({ it: makeItem(FULL, [V2, V1]), lang: "en" });
    expect(result.current.state.optionTranslations[OPT].values).toEqual(["Blue", "Red"]);

    await settleLast();
    expect(result.current.state.optionTranslations[OPT].values).toEqual(["Blue", "Crimson"]);
  });
});
