/**
 * What the product editor's save actually SENDS for the variants card.
 *
 * The structural edits — an added value, a deleted option, a dragged order —
 * are the first ones in this hook that live outside `primaryOptionEdits`, and
 * the save callback is memoised. A dependency list that does not name them
 * closes over the state as it was when the callback was last built, so the
 * merchant's addition is dropped and the save reports success — the classic
 * false-success shape this app treats as a bug rather than a nuisance.
 *
 * So these tests do not inspect state; they read the submitted FormData.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";

const submit = vi.fn();

// One STABLE fetcher object. A fresh one per render would be a new dependency
// every time, rebuilding every memoised callback in the hook and hiding
// exactly the staleness these tests exist to catch.
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
const SECOND = "gid://shopify/ProductOption/2";
const THIRD = "gid://shopify/ProductOption/3";

const selectedItem = {
  id: "gid://shopify/Product/1",
  title: "Shirt",
  options: [
    {
      id: OPTION,
      name: "Colour",
      position: 1,
      values: [
        { id: "gid://shopify/ProductOptionValue/1", name: "Red" },
        { id: "gid://shopify/ProductOptionValue/1b", name: "Blue" },
      ],
    },
    { id: SECOND, name: "Size", position: 2, values: [{ id: "gid://shopify/ProductOptionValue/2", name: "S" }] },
    { id: THIRD, name: "Material", position: 3, values: [{ id: "gid://shopify/ProductOptionValue/3", name: "Cotton" }] },
  ],
  metafields: [],
} as never;

function setup(item: unknown = selectedItem) {
  return renderHook(
    ({ current }: { current: unknown }) =>
      useProductSubResources({
        selectedItem: current,
        currentLanguage: "de",
        primaryLocale: "de",
        showInfoBox,
        // The reason strings the route wires in. A code with no entry drops
        // its reason rather than printing an English one, which is why the
        // test supplies them rather than relying on a fallback.
        strings: { optionWarning_optionLastOne: "The last one cannot be removed." },
      } as never),
    { initialProps: { current: item } },
  );
}

const showInfoBox = vi.fn();

/** The fields of the last submitted FormData. */
function submitted() {
  const form = submit.mock.calls.at(-1)?.[0] as FormData;
  return Object.fromEntries(form.entries()) as Record<string, string>;
}

beforeEach(() => {
  submit.mockClear();
  showInfoBox.mockClear();
  fetcher.state = "idle";
  fetcher.data = undefined;
});

describe("saveSubResources — the structural half", () => {
  it("carries EVERY added value, not only the first", () => {
    // The first edit flips `hasChanges`, which rebuilds the memoised save on
    // its own. From the second one on, nothing in a dependency list that omits
    // these lists changes — so a stale callback sends ["Blue"] and reports
    // success, and the merchant's "Green" is silently gone.
    const { result } = setup();

    act(() => result.current.handlers.handleAddOptionValue(OPTION, "Blue"));
    act(() => result.current.handlers.handleAddOptionValue(OPTION, "Green"));
    act(() => result.current.handlers.saveSubResources());

    const fields = submitted();
    expect(JSON.parse(fields.optionsChanges)[OPTION].valuesToAdd).toEqual(["Blue", "Green"]);
  });

  it("carries a removed value, a new option and a delete", () => {
    const { result } = setup();

    act(() => result.current.handlers.handleRemoveOptionValue(OPTION, "gid://shopify/ProductOptionValue/1"));
    act(() => result.current.handlers.handleCreateOption("Material", ["Cotton"]));
    act(() => result.current.handlers.handleDeleteOption(SECOND));
    act(() => result.current.handlers.saveSubResources());

    const fields = submitted();
    expect(JSON.parse(fields.optionsChanges)[OPTION].valuesToDelete).toEqual([
      "gid://shopify/ProductOptionValue/1",
    ]);
    expect(JSON.parse(fields.optionsToCreate)).toEqual([{ name: "Material", values: ["Cotton"] }]);
    expect(JSON.parse(fields.optionsToDelete)).toEqual([SECOND]);
  });

  it("drops an option from the order when the same save deletes it", () => {
    // Naming a gone option would fail the reorder for all of them.
    const { result } = setup();

    act(() => result.current.handlers.handleReorderOptions([SECOND, THIRD, OPTION]));
    act(() => result.current.handlers.handleDeleteOption(SECOND));
    act(() => result.current.handlers.saveSubResources());

    expect(JSON.parse(submitted().optionOrder)).toEqual([THIRD, OPTION]);
  });

  it("sends no order at all when nothing was dragged", () => {
    // An empty order list would ask Shopify to reorder nothing on every save.
    const { result } = setup();

    act(() => result.current.handlers.handleAddOptionValue(OPTION, "Blue"));
    act(() => result.current.handlers.saveSubResources());

    expect(submitted().optionOrder).toBeUndefined();
  });

  it("sends no order when the drag ended where it started", () => {
    // Dragging an option away and back leaves the pending order non-null. A
    // reorder that reorders nothing is a Shopify call with a chance of going
    // wrong and no chance of achieving anything.
    const { result } = setup();

    act(() => result.current.handlers.handleReorderOptions([SECOND, OPTION, THIRD]));
    act(() => result.current.handlers.handleReorderOptions([OPTION, SECOND, THIRD]));
    act(() => result.current.handlers.saveSubResources());

    expect(submit).not.toHaveBeenCalled();
  });

  it("sends no order when a delete leaves the survivors in their saved order", () => {
    // The order that matters is the one over the options that REMAIN.
    const { result } = setup();

    act(() => result.current.handlers.handleReorderOptions([OPTION, SECOND, THIRD]));
    act(() => result.current.handlers.handleDeleteOption(SECOND));
    act(() => result.current.handlers.saveSubResources());

    expect(submitted().optionOrder).toBeUndefined();
    expect(JSON.parse(submitted().optionsToDelete)).toEqual([SECOND]);
  });

  it("drops a not-yet-saved option again without touching anything else", () => {
    const { result } = setup();

    act(() => result.current.handlers.handleCreateOption("Material", ["Cotton"]));
    act(() => result.current.handlers.handleCreateOption("Finish", ["Matte"]));
    act(() => result.current.handlers.handleCancelCreateOption(0));
    act(() => result.current.handlers.saveSubResources());

    expect(JSON.parse(submitted().optionsToCreate)).toEqual([{ name: "Finish", values: ["Matte"] }]);
  });

  it("stays silent when there is nothing to save", () => {
    const { result } = setup();

    act(() => result.current.handlers.saveSubResources());

    expect(submit).not.toHaveBeenCalled();
  });
});

describe("the pending lists belong to ONE product", () => {
  it("does not carry a queued option onto the next product", () => {
    // `optionsToCreate` carries no id, so nothing downstream could notice it
    // belongs to another product: it would be created on the one now open,
    // with `variantStrategy: CREATE` multiplying THAT product's matrix.
    const other = { ...(selectedItem as Record<string, unknown>), id: "gid://shopify/Product/2" };
    const { result, rerender } = setup();

    act(() => result.current.handlers.handleCreateOption("Material", ["Cotton"]));
    act(() => result.current.handlers.handleDeleteOption(SECOND));
    rerender({ current: other });
    act(() => result.current.handlers.handleAddOptionValue(OPTION, "Blue"));
    act(() => result.current.handlers.saveSubResources());

    const fields = submitted();
    expect(fields.productId).toBe("gid://shopify/Product/2");
    expect(fields.optionsToCreate).toBeUndefined();
    expect(fields.optionsToDelete).toBeUndefined();
  });
});

describe("a value renamed and deleted in the same save", () => {
  it("is sent as a delete only, never as both", () => {
    // Shopify rejects the contradiction, and because failures are per option
    // that would take the merchant's other renames on the same option with it.
    const { result } = setup();

    act(() => result.current.handlers.handlePrimaryOptionValuesChange(OPTION, ["Crimson", "Blue"]));
    act(() =>
      result.current.handlers.handleRemoveOptionValue(OPTION, "gid://shopify/ProductOptionValue/1"),
    );
    act(() => result.current.handlers.saveSubResources());

    const change = JSON.parse(submitted().optionsChanges)[OPTION];
    expect(change.valuesToDelete).toEqual(["gid://shopify/ProductOptionValue/1"]);
    expect(change.valueUpdates).toBeUndefined();
  });
});

describe("what the client calls a success", () => {
  /** Queues a structural edit, then plays a server response back. */
  function saveAndAnswer(answer: Record<string, unknown>) {
    const { result, rerender } = setup();
    act(() => result.current.handlers.handleCreateOption("Material", ["Cotton"]));
    act(() => result.current.handlers.saveSubResources());

    fetcher.data = { success: true, actionType: "savePrimarySubResources", ...answer };
    rerender({ current: selectedItem });
    return result;
  }

  it("treats a create/delete/reorder failure as a FAILURE", () => {
    // These carry no option id, so counting only `failedOptions` made every
    // one of them read as a success: green toast, pending lists cleared, the
    // merchant's edit destroyed and reported as saved.
    const result = saveAndAnswer({
      failedOptions: [],
      failedMetafields: [],
      structuralFailures: 1,
      optionWarnings: ["optionLastOne"],
    });

    expect(showInfoBox.mock.calls.at(-1)?.[1]).toBe("critical");
    // And it does not stay armed to re-fire on the next unrelated edit.
    expect(result.current.state.optionsToCreate).toEqual([]);
  });

  it("names the reason it was given, in the merchant's language", () => {
    setup();
    showInfoBox.mockClear();
    const { result, rerender } = setup();
    act(() => result.current.handlers.handleCreateOption("Material", ["Cotton"]));
    act(() => result.current.handlers.saveSubResources());
    fetcher.data = {
      success: true,
      actionType: "savePrimarySubResources",
      failedOptions: [],
      failedMetafields: [],
      structuralFailures: 1,
      optionWarnings: ["optionLastOne"],
    };
    rerender({ current: selectedItem });

    // The generic count alone leaves the merchant guessing what went wrong.
    expect(String(showInfoBox.mock.calls.at(-1)?.[0])).toContain("The last one cannot be removed.");
  });

  it("still calls a clean answer a success", () => {
    const result = saveAndAnswer({
      failedOptions: [],
      failedMetafields: [],
      structuralFailures: 0,
      optionWarnings: [],
    });

    expect(showInfoBox.mock.calls.at(-1)?.[1]).toBe("success");
    expect(result.current.state.optionsToCreate).toEqual([]);
  });
});

describe("reordering VALUES", () => {
  it("sends the moved order, and the option list to hang it on", () => {
    // The reorder mutation nests values under an option, so a pure value drag
    // still needs the current option order named.
    const { result } = setup();

    act(() =>
      result.current.handlers.handleReorderOptionValues(OPTION, [
        "gid://shopify/ProductOptionValue/1b",
        "gid://shopify/ProductOptionValue/1",
      ]),
    );
    act(() => result.current.handlers.saveSubResources());

    expect(JSON.parse(submitted().optionValueOrder)).toEqual({
      [OPTION]: ["gid://shopify/ProductOptionValue/1b", "gid://shopify/ProductOptionValue/1"],
    });
    expect(JSON.parse(submitted().optionOrder)).toEqual([OPTION, SECOND, THIRD]);
  });

  it("sends nothing when the values ended where they started", () => {
    const { result } = setup();

    act(() =>
      result.current.handlers.handleReorderOptionValues(OPTION, [
        "gid://shopify/ProductOptionValue/1",
        "gid://shopify/ProductOptionValue/1b",
      ]),
    );
    act(() => result.current.handlers.saveSubResources());

    expect(submit).not.toHaveBeenCalled();
  });
});

describe("a drag that was abandoned or undone", () => {
  it("does not reorder an option that the same save deletes", () => {
    // Its order has nothing left to change, and keeping it would force a
    // reorder call whose entire content is restating unmoved positions.
    const { result } = setup();

    act(() =>
      result.current.handlers.handleReorderOptionValues(OPTION, [
        "gid://shopify/ProductOptionValue/1b",
        "gid://shopify/ProductOptionValue/1",
      ]),
    );
    act(() => result.current.handlers.handleDeleteOption(OPTION));
    act(() => result.current.handlers.saveSubResources());

    expect(submitted().optionValueOrder).toBeUndefined();
    expect(submitted().optionOrder).toBeUndefined();
  });
});
