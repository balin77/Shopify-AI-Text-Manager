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
const fetcher = { state: "idle", data: undefined, submit, load: vi.fn(), Form: () => null };

vi.mock("react-router", () => ({
  useFetcher: () => fetcher,
}));

import { useProductSubResources } from "~/hooks/useProductSubResources";

const OPTION = "gid://shopify/ProductOption/1";
const SECOND = "gid://shopify/ProductOption/2";

const selectedItem = {
  id: "gid://shopify/Product/1",
  title: "Shirt",
  options: [
    { id: OPTION, name: "Colour", position: 1, values: [{ id: "gid://shopify/ProductOptionValue/1", name: "Red" }] },
    { id: SECOND, name: "Size", position: 2, values: [{ id: "gid://shopify/ProductOptionValue/2", name: "S" }] },
  ],
  metafields: [],
} as never;

function setup() {
  return renderHook(() =>
    useProductSubResources({
      selectedItem,
      currentLanguage: "de",
      primaryLocale: "de",
    } as never),
  );
}

/** The fields of the last submitted FormData. */
function submitted() {
  const form = submit.mock.calls.at(-1)?.[0] as FormData;
  return Object.fromEntries(form.entries()) as Record<string, string>;
}

beforeEach(() => {
  submit.mockClear();
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

    act(() => result.current.handlers.handleReorderOptions([SECOND, OPTION]));
    act(() => result.current.handlers.handleDeleteOption(SECOND));
    act(() => result.current.handlers.saveSubResources());

    expect(JSON.parse(submitted().optionOrder)).toEqual([OPTION]);
  });

  it("sends no order at all when nothing was dragged", () => {
    // An empty order list would ask Shopify to reorder nothing on every save.
    const { result } = setup();

    act(() => result.current.handlers.handleAddOptionValue(OPTION, "Blue"));
    act(() => result.current.handlers.saveSubResources());

    expect(submitted().optionOrder).toBeUndefined();
  });

  it("stays silent when there is nothing to save", () => {
    const { result } = setup();

    act(() => result.current.handlers.saveSubResources());

    expect(submit).not.toHaveBeenCalled();
  });
});
