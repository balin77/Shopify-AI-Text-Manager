/**
 * Switching products WHILE a save of the options & metafields card is running
 * is wanted (it makes the work faster), so a save is no longer a modal state:
 *
 *  - the answer of a save lands on a view the merchant has left and must touch
 *    NOTHING of what is on screen now (edits, lists, dirty sets, save bar),
 *    and say which product it was for;
 *  - a second Save (of the next product) can be pressed before the first one has
 *    answered. All of the card's saves share ONE fetcher, and a submit on a busy
 *    fetcher aborts the request in flight, so saves are serialised: one goes
 *    out, the others wait and go out when the previous answer is handled;
 *  - a Phase-2 load neither aborts a save nor is aborted by one;
 *  - the unsaved-changes confirm is for edits NO save carries yet.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";

const submit = vi.fn();
const fetcher: { state: string; data: unknown; submit: typeof submit; load: () => void; Form: () => null } = {
  state: "idle",
  data: undefined,
  submit,
  load: vi.fn(),
  Form: () => null,
};
vi.mock("react-router", () => ({ useFetcher: () => fetcher }));

import { useProductSubResources } from "~/hooks/useProductSubResources";
import { shouldConfirmSubResourceSwitch } from "~/services/editor/sub-resource-pending.shared";

vi.mock("../../app/utils/app-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../app/utils/app-fetch")>()),
  appFetch: (input: string, init?: RequestInit) => (init === undefined ? fetch(input) : fetch(input, init)),
}));

const MFA = "gid://shopify/Metafield/55";
const MFB = "gid://shopify/Metafield/56";
const OPT = "gid://shopify/ProductOption/1";
const V1 = "gid://shopify/ProductOptionValue/1";

const productA = {
  id: "gid://shopify/Product/1",
  title: "Shirt",
  options: [],
  metafields: [{ id: MFA, namespace: "custom", key: "material", value: "Baumwolle", type: "single_line_text_field" }],
} as any;
const productB = {
  id: "gid://shopify/Product/2",
  title: "Hat",
  options: [],
  metafields: [{ id: MFB, namespace: "custom", key: "material", value: "Wolle", type: "single_line_text_field" }],
} as any;
const optionProduct = (id: string, title: string) =>
  ({
    id,
    title,
    options: [{ id: OPT, name: "Colour", position: 1, values: [{ id: V1, name: "Red" }] }],
    metafields: [],
  }) as any;

const showInfoBox = vi.fn();
const revalidator = { revalidate: vi.fn(), state: "idle" };
const STRINGS = {
  savedOtherProduct: "Saved: {title}",
  savePartialOtherProduct: "Partly saved: {title}",
  saveFailedOtherProduct: "Could not save {title}",
};

function render(item: unknown = productA, language = "de") {
  return renderHook(
    ({ current, lang }: { current: unknown; lang: string }) =>
      useProductSubResources({
        selectedItem: current,
        currentLanguage: lang,
        primaryLocale: "de",
        showInfoBox,
        revalidator,
        strings: STRINGS,
      } as never),
    { initialProps: { current: item, lang: language } },
  );
}

/** The request leaves: the fetcher reports itself busy (as React Router does). */
const goBusy = (rerender: any, current: unknown, lang = "de") => {
  fetcher.state = "submitting";
  rerender({ current, lang });
};
/** The request is answered: idle again, with its data. */
const answer = (rerender: any, current: unknown, data: Record<string, unknown>, lang = "de") => {
  fetcher.data = data;
  fetcher.state = "idle";
  rerender({ current, lang });
};
const OK = { success: true, actionType: "savePrimarySubResources", failedOptions: [], failedMetafields: [] };
const submittedProduct = (n: number) => (submit.mock.calls[n]?.[0] as FormData | undefined)?.get("productId");

beforeEach(() => {
  submit.mockClear();
  showInfoBox.mockClear();
  revalidator.revalidate.mockClear();
  fetcher.state = "idle";
  fetcher.data = undefined;
});

describe("save A, switch to B", () => {
  it("A's answer touches nothing of B, names A, and re-reads", () => {
    const { result, rerender } = render();
    act(() => result.current.handlers.handlePrimaryMetafieldChange(MFA, "Leinen"));
    act(() => result.current.handlers.saveSubResources());
    goBusy(rerender, productA);

    rerender({ current: productB, lang: "de" }); // the merchant moves on while A's save is out
    act(() => result.current.handlers.handlePrimaryMetafieldChange(MFB, "Seide"));
    act(() => result.current.handlers.handleAddOptionValue(OPT, "Green"));
    showInfoBox.mockClear();

    answer(rerender, productB, { ...OK });

    expect(result.current.state.primaryMetafieldEdits).toEqual({ [MFB]: "Seide" });
    expect(result.current.state.optionValuesToAdd).toEqual({ [OPT]: ["Green"] });
    expect(result.current.state.hasChanges).toBe(true);
    expect(showInfoBox).toHaveBeenCalledTimes(1);
    expect(showInfoBox.mock.calls[0]).toEqual(["Saved: Shirt", "success"]);
    expect(revalidator.revalidate).toHaveBeenCalled();
  });

  it("a failure of A is VISIBLE and named: partial, whole-request, unconfirmed purge", () => {
    const run = (data: Record<string, unknown>) => {
      const { result, rerender } = render();
      act(() => result.current.handlers.handlePrimaryMetafieldChange(MFA, "Leinen"));
      act(() => result.current.handlers.saveSubResources());
      goBusy(rerender, productA);
      rerender({ current: productB, lang: "de" });
      act(() => result.current.handlers.handlePrimaryMetafieldChange(MFB, "Seide"));
      showInfoBox.mockClear();
      answer(rerender, productB, data);
      expect(result.current.state.primaryMetafieldEdits).toEqual({ [MFB]: "Seide" });
      return showInfoBox.mock.calls.at(-1);
    };
    expect(run({ ...OK, failedMetafields: [MFA] })).toEqual(["Partly saved: Shirt", "warning"]);
    expect(run({ success: false, actionType: "savePrimarySubResources", error: "boom" })).toEqual(["Could not save Shirt", "critical"]);
    // Saved, but stale translations could not be removed: never a green toast.
    const purge = run({ ...OK, warnings: ["translationPurgeUnconfirmed"], unconfirmedPurge: [MFA] } as any);
    expect(purge?.[1]).toBe("warning");
  });
});

describe("save A, switch, save B BEFORE A has answered", () => {
  it("both saves go out, in press order, neither lost nor sent twice; each answer settles only its own state", () => {
    const { result, rerender } = render();
    act(() => result.current.handlers.handlePrimaryMetafieldChange(MFA, "Leinen"));
    act(() => result.current.handlers.saveSubResources());
    goBusy(rerender, productA);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submittedProduct(0)).toBe(productA.id);

    rerender({ current: productB, lang: "de" });
    act(() => result.current.handlers.handlePrimaryMetafieldChange(MFB, "Seide"));
    act(() => result.current.handlers.saveSubResources());
    // B's Save does NOT abort A's request: it waits.
    expect(submit).toHaveBeenCalledTimes(1);
    expect(result.current.state.isSaving).toBe(true); // B's own save is waiting
    // ... and pressing it again does not queue a duplicate.
    act(() => result.current.handlers.saveSubResources());
    expect(submit).toHaveBeenCalledTimes(1);

    // A answers: it is handled as A's (foreign to the view), then B goes out.
    answer(rerender, productB, { ...OK });
    expect(submit).toHaveBeenCalledTimes(2);
    expect(submittedProduct(1)).toBe(productB.id);
    expect(result.current.state.primaryMetafieldEdits).toEqual({ [MFB]: "Seide" }); // B not settled by A's answer
    expect(result.current.state.hasChanges).toBe(true);

    // B answers: now it IS the view's own answer.
    goBusy(rerender, productB);
    answer(rerender, productB, { ...OK });
    expect(result.current.state.primaryMetafieldEdits).toEqual({});
    expect(result.current.state.hasChanges).toBe(false);
    expect(submit).toHaveBeenCalledTimes(2); // nothing is sent twice
  });

  it("B answered while the merchant moved on to C: B's answer is foreign too, and C is untouched", () => {
    const productC = { ...productB, id: "gid://shopify/Product/3", title: "Cap", metafields: [{ ...productB.metafields[0], id: "gid://shopify/Metafield/57" }] };
    const { result, rerender } = render();
    act(() => result.current.handlers.handlePrimaryMetafieldChange(MFA, "Leinen"));
    act(() => result.current.handlers.saveSubResources());
    goBusy(rerender, productA);
    rerender({ current: productB, lang: "de" });
    act(() => result.current.handlers.handlePrimaryMetafieldChange(MFB, "Seide"));
    act(() => result.current.handlers.saveSubResources());
    answer(rerender, productB, { ...OK }); // A done, B dispatched
    goBusy(rerender, productB);
    rerender({ current: productC, lang: "de" });
    act(() => result.current.handlers.handlePrimaryMetafieldChange("gid://shopify/Metafield/57", "Filz"));
    showInfoBox.mockClear();
    answer(rerender, productC, { ...OK }); // B's answer
    expect(result.current.state.primaryMetafieldEdits).toEqual({ "gid://shopify/Metafield/57": "Filz" });
    expect(showInfoBox.mock.calls[0]).toEqual(["Saved: Hat", "success"]);
  });
});

describe("returning to A while its save is still out", () => {
  it("A shows as saving (Save busy), a second press sends nothing, and A's answer then settles normally", () => {
    const { result, rerender } = render();
    act(() => result.current.handlers.handlePrimaryMetafieldChange(MFA, "Leinen"));
    act(() => result.current.handlers.saveSubResources());
    goBusy(rerender, productA);
    rerender({ current: productB, lang: "de" });
    expect(result.current.state.isSaving).toBe(false); // B is free to work and save
    rerender({ current: productA, lang: "de" }); // back to A
    expect(result.current.state.isSaving).toBe(true); // A's save is still out: no double send
    act(() => result.current.handlers.handlePrimaryMetafieldChange(MFA, "Hanf"));
    act(() => result.current.handlers.saveSubResources());
    expect(submit).toHaveBeenCalledTimes(1);

    answer(rerender, productA, { ...OK });
    // Typed after the return, not carried by the save: kept.
    expect(result.current.state.isSaving).toBe(false);
    expect(revalidator.revalidate).toHaveBeenCalled(); // fresh data for A
  });
});

describe("a Phase-2 load and a save never abort each other", () => {
  const foreignItem = (id: string, title: string) => optionProduct(id, title);

  it("a save pressed while a load is in flight WAITS for it, then goes out", () => {
    const { result, rerender } = render(foreignItem(productA.id, "Shirt"), "fr");
    // The load for the shown view went out on mount.
    expect(submit.mock.calls.map((c) => (c[0] as any)?.action)).toEqual(["loadSubResourceTranslations"]);
    goBusy(rerender, foreignItem(productA.id, "Shirt"), "fr");
    act(() => result.current.handlers.handleOptionNameChange(OPT, "Couleur"));
    act(() => result.current.handlers.saveSubResources());
    // Not submitted: that would abort the load.
    expect(submit).toHaveBeenCalledTimes(1);
    answer(rerender, foreignItem(productA.id, "Shirt"), { success: true, actionType: "loadSubResourceTranslations", translations: {} }, "fr");
    expect(submit).toHaveBeenCalledTimes(2);
    expect((submit.mock.calls[1][0] as any).action).toBe("saveSubResourceTranslations");
  });

  it("a load wanted while a save is in flight is DEFERRED and goes out after the save's answer", () => {
    const { result, rerender } = render(foreignItem(productA.id, "Shirt"), "fr");
    answer(rerender, foreignItem(productA.id, "Shirt"), { success: true, actionType: "loadSubResourceTranslations", translations: {} }, "fr");
    submit.mockClear();
    act(() => result.current.handlers.handleOptionNameChange(OPT, "Couleur"));
    act(() => result.current.handlers.saveSubResources());
    expect((submit.mock.calls[0][0] as any).action).toBe("saveSubResourceTranslations");
    goBusy(rerender, foreignItem(productA.id, "Shirt"), "fr");

    // The merchant switches to B: its load must not abort the save.
    rerender({ current: foreignItem("gid://shopify/Product/2", "Hat"), lang: "fr" });
    expect(submit).toHaveBeenCalledTimes(1);

    answer(rerender, foreignItem("gid://shopify/Product/2", "Hat"), { success: true, actionType: "saveSubResourceTranslations", failedResources: [], savedResources: [OPT] }, "fr");
    expect(submit.mock.calls.map((c) => (c[0] as any)?.action)).toEqual(["saveSubResourceTranslations", "loadSubResourceTranslations"]);
    expect((submit.mock.calls[1][0] as any).itemId).toBe("gid://shopify/Product/2");
  });
});

describe("a FOREIGN-language save answer is tagged with its product and view", () => {
  it("lands after the switch: B's dirty sets and typed translations survive, A is named", () => {
    const A = optionProduct(productA.id, "Shirt");
    const B = optionProduct("gid://shopify/Product/2", "Hat");
    const { result, rerender } = render(A, "fr");
    answer(rerender, A, { success: true, actionType: "loadSubResourceTranslations", translations: {} }, "fr");
    act(() => result.current.handlers.handleOptionNameChange(OPT, "Couleur"));
    act(() => result.current.handlers.saveSubResources());
    goBusy(rerender, A, "fr");

    rerender({ current: B, lang: "fr" });
    act(() => result.current.handlers.handleOptionNameChange(OPT, "Teinte"));
    showInfoBox.mockClear();
    answer(rerender, B, { success: true, actionType: "saveSubResourceTranslations", failedResources: [], savedResources: [OPT] }, "fr");

    expect(result.current.state.hasChanges).toBe(true);
    expect(result.current.state.optionTranslations[OPT]?.name).toBe("Teinte");
    expect(showInfoBox.mock.calls.at(-1)).toEqual(["Saved: Shirt", "success"]);
  });

  it("a FAILED resource of A is not restored onto B's fields", () => {
    const A = optionProduct(productA.id, "Shirt");
    const B = optionProduct("gid://shopify/Product/2", "Hat");
    const { result, rerender } = render(A, "fr");
    answer(rerender, A, { success: true, actionType: "loadSubResourceTranslations", translations: {} }, "fr");
    act(() => result.current.handlers.handleOptionNameChange(OPT, "Couleur"));
    act(() => result.current.handlers.saveSubResources());
    goBusy(rerender, A, "fr");
    rerender({ current: B, lang: "fr" });
    act(() => result.current.handlers.handleOptionNameChange(OPT, "Teinte"));
    showInfoBox.mockClear();
    answer(rerender, B, { success: true, actionType: "saveSubResourceTranslations", failedResources: [OPT], savedResources: [] }, "fr");
    expect(result.current.state.optionTranslations[OPT]?.name).toBe("Teinte");
    expect(result.current.state.hasChanges).toBe(true);
    expect(showInfoBox.mock.calls.at(-1)).toEqual(["Partly saved: Shirt", "warning"]);
  });
});

describe("the unsaved-changes confirm only asks for edits NO save carries", () => {
  it("no 'unsent' changes while a save carries everything; typing after it went out counts", () => {
    const { result, rerender } = render();
    act(() => result.current.handlers.handlePrimaryMetafieldChange(MFA, "Leinen"));
    expect(result.current.state.hasUnsentChanges).toBe(true); // nothing is saving yet
    act(() => result.current.handlers.saveSubResources());
    goBusy(rerender, productA);
    expect(result.current.state.hasChanges).toBe(true);
    expect(result.current.state.hasUnsentChanges).toBe(false); // the in-flight save carries it
    act(() => result.current.handlers.handlePrimaryMetafieldChange(MFA, "Hanf"));
    expect(result.current.state.hasUnsentChanges).toBe(true); // typed after the save went out
  });

  it("a QUEUED save carries its edits too", () => {
    const { result, rerender } = render();
    act(() => result.current.handlers.handlePrimaryMetafieldChange(MFA, "Leinen"));
    act(() => result.current.handlers.saveSubResources());
    goBusy(rerender, productA);
    rerender({ current: productB, lang: "de" });
    act(() => result.current.handlers.handlePrimaryMetafieldChange(MFB, "Seide"));
    act(() => result.current.handlers.saveSubResources()); // waits behind A
    expect(result.current.state.hasUnsentChanges).toBe(false);
  });

  it("the page predicate asks only for unsent changes and never twice", () => {
    expect(shouldConfirmSubResourceSwitch(true, false)).toBe(true);
    expect(shouldConfirmSubResourceSwitch(false, false)).toBe(false); // an in-flight save: no false alarm
    expect(shouldConfirmSubResourceSwitch(true, true)).toBe(false); // the editor asks on its own path
  });
});

describe("an answer with no record of what was sent", () => {
  it("KEEPS the edits instead of settling what cannot be shown to be saved", () => {
    const { result, rerender } = render();
    act(() => result.current.handlers.handlePrimaryMetafieldChange(MFA, "Leinen"));
    answer(rerender, productA, { ...OK }); // no save was pressed: no snapshot
    expect(result.current.state.primaryMetafieldEdits).toEqual({ [MFA]: "Leinen" });
    expect(result.current.state.hasChanges).toBe(true);
  });
});
