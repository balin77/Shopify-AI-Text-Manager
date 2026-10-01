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
const translateAll = mk();
let calls = 0;

vi.mock("react-router", () => ({
  // The hook asks for its two fetchers in a fixed order on every render.
  useFetcher: () => (calls++ % 2 === 0 ? main : translateAll),
}));

import { useProductSubResources } from "~/hooks/useProductSubResources";
import { markSubResourceActive, isOperationActive } from "~/hooks/useAIOperationsStore";

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
  calls = 0;
  main.data = undefined;
  translateAll.data = undefined;
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

  it("clears a translate spinner the failed answer named", () => {
    markSubResourceActive(ITEM_ID, `${OPTION}:entire`, "translateSubResource");
    expect(isOperationActive(ITEM_ID, `sub::${OPTION}:entire`)).toBe(true);
    const { rerender } = setup();

    fail(main, rerender, { actionType: "translateSubResources", fieldId: `${OPTION}:entire`, error: "boom" });

    expect(isOperationActive(ITEM_ID, `sub::${OPTION}:entire`)).toBe(false);
  });

  it("clears every translate spinner when the translate-all request failed", () => {
    markSubResourceActive(ITEM_ID, "a:entire", "translateSubResource");
    markSubResourceActive(ITEM_ID, "b:entire", "translateSubResource");
    const { rerender } = setup();

    fail(translateAll, rerender, { actionType: "translateSubResources", error: "boom" });

    expect(isOperationActive(ITEM_ID, "sub::a:entire")).toBe(false);
    expect(isOperationActive(ITEM_ID, "sub::b:entire")).toBe(false);
    expect(showInfoBox).toHaveBeenCalledWith("boom", "critical");
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
