/**
 * A sub-resource request that fails AS A WHOLE (a server error, the plan gate's
 * refusal, a managed-AI refusal) used to hit `if (!data.success) return` before
 * anything else: no message, a spinner that hung until the store's ten-minute
 * timeout, and the detached repairs a half-finished save had started were never
 * handed to the watcher. The edits must also stay PENDING so the save can
 * simply be pressed again.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";

type FakeFetcher = { state: string; data: unknown; submit: ReturnType<typeof vi.fn>; load: ReturnType<typeof vi.fn>; Form: () => null };
const mk = (): FakeFetcher => ({ state: "idle", data: undefined, submit: vi.fn(), load: vi.fn(), Form: () => null });
const main = mk();

vi.mock("react-router", () => ({
  // The hook's ONE fetcher (load + save bar); translates and copies have
  // their own plain fetch.
  useFetcher: () => main,
}));

import { useProductSubResources } from "~/hooks/useProductSubResources";
import { markSubResourceActive, markSubResourceCompleted, isOperationActive } from "~/hooks/useAIOperationsStore";

const ITEM_ID = "gid://shopify/Product/42";
const OPTION = "gid://shopify/ProductOption/1";
const item = {
  id: ITEM_ID,
  title: "Shirt",
  options: [{ id: OPTION, name: "Colour", position: 1, values: [{ id: "gid://shopify/ProductOptionValue/1", name: "Red" }] }],
  metafields: [],
} as never;

const showInfoBox = vi.fn();
const onSaveResponse = vi.fn();
const strings = {
  upgradeRequired: "Upgrade needed",
  translateFailed: "Translation failed",
  subResourcesRequestFailed: "Saving failed. Your edits are kept.",
};

function setup() {
  return renderHook(
    () =>
      useProductSubResources({
        selectedItem: item,
        currentLanguage: "de",
        primaryLocale: "de",
        showInfoBox,
        onSaveResponse,
        strings,
      } as never),
  );
}

/** Deliver a failed answer on a fetcher and let the effect run. */
function fail(fetcher: FakeFetcher, rerender: () => void, body: Record<string, unknown>) {
  act(() => {
    fetcher.data = { success: false, ...body };
    rerender();
  });
}

beforeEach(() => {
  main.data = undefined;
  vi.unstubAllGlobals();
  showInfoBox.mockClear();
  onSaveResponse.mockClear();
});

describe("a sub-resource request that failed as a whole", () => {
  it("says so in a critical box and keeps the edit pending", () => {
    const { result, rerender } = setup();
    act(() => result.current.handlers.handlePrimaryOptionNameChange(OPTION, "Farbe"));
    expect(result.current.state.hasChanges).toBe(true);

    fail(main, rerender, { actionType: "savePrimarySubResources", error: "boom" });

    expect(showInfoBox).toHaveBeenCalledWith("boom", "critical");
    expect(result.current.state.hasChanges).toBe(true);
  });

  it("maps the plan gate's refusal code to the upgrade message", () => {
    const { rerender } = setup();
    fail(main, rerender, { actionType: "saveSubResourceTranslations", error: "gated" });
    expect(showInfoBox).toHaveBeenCalledWith("Upgrade needed", "critical");
  });

  it("falls back to the generic save sentence when the server gave none", () => {
    const { rerender } = setup();
    fail(main, rerender, { actionType: "savePrimarySubResources" });
    expect(showInfoBox).toHaveBeenCalledWith("Saving failed. Your edits are kept.", "critical");
  });

  it("clears a failed translate's spinner and says why", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      json: async () => ({ success: false, actionType: "translateSubResources", error: "boom" }),
    })));
    const { result } = setup();
    await act(async () => {
      result.current.handlers.translateOption(OPTION);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(isOperationActive(ITEM_ID, `sub::${OPTION}:entire`)).toBe(false);
    expect(showInfoBox).toHaveBeenCalledWith("boom", "critical");
  });

  it("clears every spinner of a translate-all whose request failed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("network down");
    }));
    // A foreign view, where "translate all" exists.
    const foreign = renderHook(() =>
      useProductSubResources({
        selectedItem: item,
        currentLanguage: "fr",
        primaryLocale: "de",
        showInfoBox,
        onSaveResponse,
        strings,
      } as never),
    );
    await act(async () => {
      foreign.result.current.handlers.translateAllSubResources();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(isOperationActive(ITEM_ID, `sub::${OPTION}:name`)).toBe(false);
    expect(isOperationActive(ITEM_ID, "sub::all:subresources")).toBe(false);
    expect(showInfoBox).toHaveBeenCalledWith("Translation failed", "critical");
  });

  it("a failed SAVE leaves the spinner of a translate still running alone", () => {
    markSubResourceActive(ITEM_ID, `${OPTION}:entire`, "translateSubResource");
    const { rerender } = setup();
    fail(main, rerender, { error: "gated" });
    expect(isOperationActive(ITEM_ID, `sub::${OPTION}:entire`)).toBe(true);
    markSubResourceCompleted(ITEM_ID, `${OPTION}:entire`);
  });

  it("still hands the task ids of a failed save to the watcher", () => {
    const { rerender } = setup();
    fail(main, rerender, {
      actionType: "savePrimarySubResources",
      error: "boom",
      retranslationTaskIds: ["task-1"],
    });
    expect(onSaveResponse).toHaveBeenCalledTimes(1);
    expect(onSaveResponse.mock.calls[0][0]).toMatchObject({ retranslationTaskIds: ["task-1"] });
  });

  it("does not shout about the silent background load", () => {
    const { rerender } = setup();
    fail(main, rerender, { actionType: "loadSubResourceTranslations", error: "boom" });
    expect(showInfoBox).not.toHaveBeenCalled();
  });
});
