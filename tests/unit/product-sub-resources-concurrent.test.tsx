/**
 * Several translate / copy buttons of the options & metafields card pressed in
 * quick succession, on a FOREIGN locale (owner report, 2026-10): some option
 * translations never appeared although Shopify had stored them (a reload
 * showed them), and a button could hang in its loading state for good.
 *
 * Every request must be its own lifecycle: each answer is read, each lands in
 * the card field by field (a later answer never blanks an earlier one), each
 * spinner settles on its own -- and a spinner two requests hold together only
 * goes when BOTH are done.
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
import { isOperationActive, clearAllForResource } from "~/hooks/useAIOperationsStore";

const ITEM = "gid://shopify/Product/7";
const OPT = "gid://shopify/ProductOption/1";
const V1 = "gid://shopify/ProductOptionValue/1";
const V2 = "gid://shopify/ProductOptionValue/2";
const V3 = "gid://shopify/ProductOptionValue/3";
const MF = "gid://shopify/Metafield/9";

function makeItem(subResourceTranslations: Record<string, unknown> = {}) {
  return {
    id: ITEM,
    title: "Shirt",
    options: [
      {
        id: OPT,
        name: "Farbe",
        position: 1,
        values: [
          { id: V1, name: "Rot" },
          { id: V2, name: "Blau" },
          { id: V3, name: "Grün" },
        ],
      },
    ],
    metafields: [{ id: MF, namespace: "custom", key: "material", value: "Baumwolle", type: "single_line_text_field" }],
    subResourceTranslations,
  } as never;
}

const EN: Record<string, string> = {
  [OPT]: "Colour",
  [V1]: "Red",
  [V2]: "Blue",
  [V3]: "Green",
  [MF]: "Cotton",
};

/** A fetch whose answers are released by hand, in any order. */
function deferredFetch() {
  const pending: Array<{ form: FormData; release: (answer?: unknown) => void; fail: () => void }> = [];
  const impl = vi.fn((_url: string, init: { body: FormData }) => {
    return new Promise((resolve, reject) => {
      const form = init.body;
      pending.push({
        form,
        release: (answer?: unknown) => {
          const body =
            answer ??
            (() => {
              const action = String(form.get("action"));
              if (action === "saveSubResourceTranslations") {
                const data = JSON.parse(String(form.get("translationsData")));
                return { success: true, actionType: action, savedResources: Object.keys(data), failedResources: [] };
              }
              const src = JSON.parse(String(form.get("sourceData"))) as Array<{ resourceId: string; key: string }>;
              const translations: Record<string, Record<string, string>> = {};
              for (const s of src) (translations[s.resourceId] ??= {})[s.key] = EN[s.resourceId];
              return {
                success: true,
                actionType: action,
                translations,
                savedResources: Object.keys(translations),
                failedResources: [],
                fieldId: form.get("fieldId"),
              };
            })();
          resolve({ ok: true, json: async () => body });
        },
        fail: () => reject(new Error("network")),
      });
    });
  });
  return { impl, pending };
}

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

const showInfoBox = vi.fn();

function setup(item = makeItem()) {
  return renderHook(
    ({ it }) =>
      useProductSubResources({
        selectedItem: it,
        currentLanguage: "en",
        primaryLocale: "de",
        enabledLanguages: ["de", "en"],
        showInfoBox,
        strings: { translateFailed: "Translation failed", copied: "Copied" },
      } as never),
    { initialProps: { it: item } },
  );
}

const active = (fieldId: string) => isOperationActive(ITEM, `sub::${fieldId}`);

beforeEach(() => {
  submit.mockClear();
  showInfoBox.mockClear();
  fetcher.state = "idle";
  fetcher.data = undefined;
  clearAllForResource(ITEM);
  (subResourcesModule as { __resetSubResourceSpinnerHolds?: () => void }).__resetSubResourceSpinnerHolds?.();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("several sub-resource translates at once", () => {
  it("shows EVERY answer and clears EVERY spinner, whatever order they land in", async () => {
    const f = deferredFetch();
    vi.stubGlobal("fetch", f.impl);
    const { result } = setup();

    act(() => {
      result.current.handlers.translateOptionField(OPT, "name");
      result.current.handlers.translateOptionField(OPT, "value", 0);
      result.current.handlers.translateOptionField(OPT, "value", 1);
      result.current.handlers.translateOptionField(OPT, "value", 2);
      result.current.handlers.translateMetafield(MF);
    });
    expect(f.impl).toHaveBeenCalledTimes(5);
    // None of them went through the shared fetcher -- its next submit would abort them.
    expect(submit.mock.calls.filter((c) => (c[0] as Record<string, unknown>)?.action !== "loadSubResourceTranslations")).toHaveLength(0);
    expect(active(`${OPT}:name`) && active(`${OPT}:value:2`) && active(`${MF}:value`)).toBe(true);

    // Out of order.
    for (const i of [3, 0, 4, 1, 2]) {
      await act(async () => f.pending[i].release());
    }
    await flush();

    const t = result.current.state.optionTranslations[OPT];
    expect(t.name).toBe("Colour");
    expect(t.values).toEqual(["Red", "Blue", "Green"]);
    expect(result.current.state.metafieldTranslations[MF]).toBe("Cotton");
    for (const id of [`${OPT}:name`, `${OPT}:value:0`, `${OPT}:value:1`, `${OPT}:value:2`, `${MF}:value`]) {
      expect(active(id)).toBe(false);
    }
  });

  it("lands a VALUE translation even where the option holds no entry yet", async () => {
    const f = deferredFetch();
    vi.stubGlobal("fetch", f.impl);
    const { result } = setup();
    // Discard empties the card state; the option has no entry until a reload.
    act(() => result.current.handlers.resetChanges());
    expect(result.current.state.optionTranslations[OPT]).toBeUndefined();

    act(() => result.current.handlers.translateOptionField(OPT, "value", 1));
    await act(async () => f.pending[0].release());
    await flush();

    expect(result.current.state.optionTranslations[OPT]?.values[1]).toBe("Blue");
  });

  it("a failed request clears ITS spinner and says so, the others carry on", async () => {
    const f = deferredFetch();
    vi.stubGlobal("fetch", f.impl);
    const { result } = setup();

    act(() => {
      result.current.handlers.translateOptionField(OPT, "value", 0);
      result.current.handlers.translateOptionField(OPT, "value", 1);
    });
    await act(async () => f.pending[0].fail());
    await flush();
    expect(active(`${OPT}:value:0`)).toBe(false);
    expect(active(`${OPT}:value:1`)).toBe(true);
    expect(showInfoBox).toHaveBeenCalledWith("Translation failed", "critical");

    await act(async () => f.pending[1].release());
    await flush();
    expect(active(`${OPT}:value:1`)).toBe(false);
    expect(result.current.state.optionTranslations[OPT].values[1]).toBe("Blue");
  });

  it("translate-all finishing first does not take down an individual spinner still running", async () => {
    const f = deferredFetch();
    vi.stubGlobal("fetch", f.impl);
    const { result } = setup();

    act(() => result.current.handlers.translateOptionField(OPT, "name"));
    act(() => result.current.handlers.translateAllSubResources());
    expect(f.impl).toHaveBeenCalledTimes(2);

    // translate-all lands first.
    await act(async () => f.pending[1].release());
    await flush();
    expect(active("all:subresources")).toBe(false);
    expect(active(`${OPT}:value:0`)).toBe(false);
    // The individual name translate is still out: its spinner stays.
    expect(active(`${OPT}:name`)).toBe(true);

    await act(async () => f.pending[0].release());
    await flush();
    expect(active(`${OPT}:name`)).toBe(false);
  });

  it("two single-option Copies at once both settle and both stay on screen", async () => {
    const f = deferredFetch();
    vi.stubGlobal("fetch", f.impl);
    const { result } = setup();

    act(() => {
      result.current.handlers.copyOptionField(OPT, "value", 0);
      result.current.handlers.copyOptionField(OPT, "value", 1);
    });
    expect(f.impl).toHaveBeenCalledTimes(2);
    expect(active(`${OPT}:value:0`) && active(`${OPT}:value:1`)).toBe(true);

    await act(async () => f.pending[1].release());
    await act(async () => f.pending[0].release());
    await flush();

    expect(active(`${OPT}:value:0`)).toBe(false);
    expect(active(`${OPT}:value:1`)).toBe(false);
    expect(result.current.state.optionTranslations[OPT].values.slice(0, 2)).toEqual(["Rot", "Blau"]);
    // Both copies were confirmed: nothing of theirs is left pending.
    expect(result.current.state.hasChanges).toBe(false);
  });

  it("a Shopify load answer arriving after a translate answer does not blank it", async () => {
    const f = deferredFetch();
    vi.stubGlobal("fetch", f.impl);
    const { result, rerender } = setup();
    // The foreign view asked Shopify for what the DB lacks (Phase 2).
    expect(submit).toHaveBeenCalled();

    act(() => result.current.handlers.translateOptionField(OPT, "value", 2));
    await act(async () => f.pending[0].release());
    await flush();
    expect(result.current.state.optionTranslations[OPT].values[2]).toBe("Green");

    // The load was read before that write: it knows the name only.
    act(() => {
      fetcher.data = { success: true, actionType: "loadSubResourceTranslations", translations: { [OPT]: { name: "Color" } } };
      rerender({ it: makeItem() });
    });
    // Same item id, same view: the load effect itself does not reset.
    const t = result.current.state.optionTranslations[OPT];
    expect(t.name).toBe("Color");
    expect(t.values[2]).toBe("Green");
  });

  it("a reload read before a translate's write does not take the answer away", async () => {
    const f = deferredFetch();
    vi.stubGlobal("fetch", f.impl);
    const { result, rerender } = setup();

    act(() => result.current.handlers.translateOptionField(OPT, "value", 0));
    await act(async () => f.pending[0].release());
    await flush();
    expect(result.current.state.optionTranslations[OPT].values[0]).toBe("Red");

    // The page reloads (e.g. a sync finished) with an item whose loader read
    // predates the write -- it carries no translation for that value.
    act(() => result.current.handlers.resetForReload());
    rerender({ it: makeItem({}) });
    await flush();

    expect(result.current.state.optionTranslations[OPT].values[0]).toBe("Red");
  });
});
