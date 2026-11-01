/**
 * Switching products WHILE a save of the options & metafields card is running
 * is wanted (it makes the work faster), so a save is no longer a modal state:
 *
 *  - the answer of a save lands on a view the merchant has left and must touch
 *    NOTHING of what is on screen now (edits, lists, dirty sets, save bar), and
 *    say which product it was for;
 *  - a second Save (of the next product) can be pressed before the first one
 *    has answered. The card's saves run through ONE chain (module scope, plain
 *    fetch) so they never abort each other, never run at once and survive the
 *    component unmounting;
 *  - an answer settles exactly what its own request carried: text, option
 *    lists and translations typed AFTER the press are never dropped;
 *  - a Phase-2 load neither waits for nor aborts a save;
 *  - the unsaved-changes confirm is for edits NO save carries yet.
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
vi.mock("react-router", () => ({ useFetcher: () => fetcher }));

import { useProductSubResources } from "~/hooks/useProductSubResources";
import { shouldConfirmSubResourceSwitch } from "~/services/editor/sub-resource-pending.shared";
import { installSaves } from "../helpers/sub-resource-save-harness";

vi.mock("../../app/utils/app-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../app/utils/app-fetch")>()),
  appFetch: (input: string, init?: RequestInit) => (init === undefined ? fetch(input) : fetch(input, init)),
}));

const MFA = "gid://shopify/Metafield/55";
const MFB = "gid://shopify/Metafield/56";
const OPT = "gid://shopify/ProductOption/1";
const V1 = "gid://shopify/ProductOptionValue/1";

const mk = (id: string, title: string, extra: any = {}) =>
  ({
    id,
    title,
    options: [{ id: OPT, name: "Colour", position: 1, values: [{ id: V1, name: "Red" }] }],
    metafields: [
      { id: MFA, namespace: "c", key: "a", value: "Baumwolle", type: "single_line_text_field" },
      { id: MFB, namespace: "c", key: "b", value: "Wolle", type: "single_line_text_field" },
    ],
    ...extra,
  }) as any;
const A = mk("gid://shopify/Product/1", "Shirt");
const B = mk("gid://shopify/Product/2", "Hat");
const C = mk("gid://shopify/Product/3", "Cap");

const showInfoBox = vi.fn();
const revalidator = { revalidate: vi.fn(), state: "idle" };
const STRINGS = {
  savedOtherProduct: "Saved: {title}",
  savePartialOtherProduct: "Partly saved: {title}",
  saveFailedOtherProduct: "Could not save {title}; enter it again.",
  saveNotConfirmed: "No answer for {title}.",
  metafieldValueRefused: "Shopify refused: {message} Your text stays in the field.",
  metafieldRefusedElsewhere: "Shopify refused: {message}",
};

let saves: ReturnType<typeof installSaves>;
const onSaveResponse = vi.fn();

function render(item: any = A, language = "de") {
  return renderHook(
    ({ current, lang }: { current: any; lang: string }) =>
      useProductSubResources({
        selectedItem: current,
        currentLanguage: lang,
        primaryLocale: "de",
        showInfoBox,
        revalidator,
        onSaveResponse,
        strings: STRINGS,
      } as never),
    { initialProps: { current: item, lang: language } },
  );
}

const OKP = { success: true, actionType: "savePrimarySubResources", failedOptions: [], failedMetafields: [] };
const OKF = (ids: string[]) => ({ success: true, actionType: "saveSubResourceTranslations", failedResources: [], savedResources: ids });
const LOAD = { success: true, actionType: "loadSubResourceTranslations", translations: {} };
/** A Phase-2 load answer arrives on the (load-only) fetcher. */
const loadAnswer = (rerender: any, current: any, data: Record<string, unknown>, lang: string) => {
  fetcher.data = data;
  fetcher.state = "idle";
  rerender({ current, lang });
};
const productOf = (n: number) => saves.sent[n]?.get("productId") ?? saves.sent[n]?.get("itemId");

const press = async (result: any) => {
  act(() => result.current.handlers.saveSubResources());
  await saves.flush();
};

beforeEach(() => {
  saves = installSaves();
  submit.mockClear();
  showInfoBox.mockClear();
  onSaveResponse.mockClear();
  revalidator.revalidate.mockClear();
  fetcher.state = "idle";
  fetcher.data = undefined;
});
afterEach(() => {
  delete (globalThis as any).shopify;
});

describe("save A, switch to B", () => {
  it("A's answer touches nothing of B, names A, and re-reads", async () => {
    const { result, rerender } = render();
    act(() => result.current.handlers.handlePrimaryMetafieldChange(MFA, "Leinen"));
    await press(result);
    rerender({ current: B, lang: "de" });
    act(() => result.current.handlers.handlePrimaryMetafieldChange(MFB, "Seide"));
    act(() => result.current.handlers.handleAddOptionValue(OPT, "Green"));
    showInfoBox.mockClear();

    await saves.settle({ ...OKP });

    expect(result.current.state.primaryMetafieldEdits).toEqual({ [MFB]: "Seide" });
    expect(result.current.state.optionValuesToAdd).toEqual({ [OPT]: ["Green"] });
    expect(result.current.state.hasChanges).toBe(true);
    expect(showInfoBox).toHaveBeenCalledTimes(1);
    expect(showInfoBox.mock.calls[0]).toEqual(["Saved: Shirt", "success"]);
    expect(revalidator.revalidate).toHaveBeenCalled();
  });

  it("a failure of A is VISIBLE, named, says the text must be entered again, and gives the concrete reason", async () => {
    const run = async (data: Record<string, unknown> | null) => {
      const { result, rerender } = render();
      act(() => result.current.handlers.handlePrimaryMetafieldChange(MFA, "Leinen"));
      await press(result);
      rerender({ current: B, lang: "de" });
      act(() => result.current.handlers.handlePrimaryMetafieldChange(MFB, "Seide"));
      showInfoBox.mockClear();
      await saves.settle(data);
      expect(result.current.state.primaryMetafieldEdits).toEqual({ [MFB]: "Seide" });
      return showInfoBox.mock.calls.at(-1);
    };
    // partial, with Shopify's concrete reason for the refused value
    expect(
      await run({ ...OKP, failedMetafields: [MFA], unverifiedMetafields: [MFA], metafieldRefusals: { [MFA]: "Must be an integer." } }),
    ).toEqual(["Partly saved: Shirt Shopify refused: Must be an integer.", "warning"]);
    // ... and never claims the text stays in a field that is not on screen
    expect(String(showInfoBox.mock.calls.at(-1)?.[0])).not.toContain("stays in the field");
    // whole request failed: named, "enter it again", and the server's reason
    const failed = await run({ success: false, actionType: "savePrimarySubResources", error: "Plan limit reached." });
    expect(failed?.[1]).toBe("critical");
    expect(String(failed?.[0])).toContain("Could not save Shirt; enter it again.");
    // a request that got no answer in time is NOT claimed as failed
    expect(await run({ success: false, error: "saveNotConfirmed", notConfirmed: true })).toEqual(["No answer for Shirt.", "warning"]);
    // saved, but stale translations could not be removed: never green
    expect((await run({ ...OKP, warnings: ["translationPurgeUnconfirmed"], unconfirmedPurge: [MFA] } as any))?.[1]).toBe("warning");
    // a request that vanished (network): named failure
    expect((await run(null))?.[1]).toBe("critical");
  });

  it("a failed save for another product still hands its retranslation tasks to the watcher", async () => {
    const { result, rerender } = render();
    act(() => result.current.handlers.handlePrimaryMetafieldChange(MFA, "Leinen"));
    await press(result);
    rerender({ current: B, lang: "de" });
    await saves.settle({ success: false, actionType: "savePrimarySubResources", error: "boom", retranslationTaskIds: ["t1"] });
    expect(onSaveResponse).toHaveBeenCalledTimes(1);
  });
});

describe("save A, switch, save B BEFORE A has answered", () => {
  it("both saves go out in press order, one at a time, neither lost nor sent twice; each answer settles only its own state", async () => {
    const { result, rerender } = render();
    act(() => result.current.handlers.handlePrimaryMetafieldChange(MFA, "Leinen"));
    await press(result);
    expect(saves.sent).toHaveLength(1);
    expect(productOf(0)).toBe(A.id);

    rerender({ current: B, lang: "de" });
    act(() => result.current.handlers.handlePrimaryMetafieldChange(MFB, "Seide"));
    await press(result);
    // B's Save does NOT run beside A's request: it waits for it.
    expect(saves.sent).toHaveLength(1);
    expect(result.current.state.isSaving).toBe(true);
    await press(result); // pressing again does not queue a duplicate
    expect(saves.sent).toHaveLength(1);

    await saves.settle({ ...OKP }); // A's answer: handled as A's, then B goes out
    expect(saves.sent).toHaveLength(2);
    expect(productOf(1)).toBe(B.id);
    expect(result.current.state.primaryMetafieldEdits).toEqual({ [MFB]: "Seide" });
    expect(result.current.state.hasChanges).toBe(true);

    await saves.settle({ ...OKP }); // B's answer: now the view's own
    expect(result.current.state.primaryMetafieldEdits).toEqual({});
    expect(result.current.state.hasChanges).toBe(false);
    expect(saves.sent).toHaveLength(2);
  });

  it("B answered while the merchant moved on to C: B's answer is foreign too, and C is untouched", async () => {
    const { result, rerender } = render();
    act(() => result.current.handlers.handlePrimaryMetafieldChange(MFA, "Leinen"));
    await press(result);
    rerender({ current: B, lang: "de" });
    act(() => result.current.handlers.handlePrimaryMetafieldChange(MFB, "Seide"));
    await press(result);
    await saves.settle({ ...OKP });
    rerender({ current: C, lang: "de" });
    act(() => result.current.handlers.handlePrimaryMetafieldChange(MFA, "Filz"));
    showInfoBox.mockClear();
    await saves.settle({ ...OKP });
    expect(result.current.state.primaryMetafieldEdits).toEqual({ [MFA]: "Filz" });
    expect(showInfoBox.mock.calls[0]).toEqual(["Saved: Hat", "success"]);
  });
});

describe("leaving the page with saves out or waiting (unmount)", () => {
  it("a queued save is still SENT after the component is gone, and its answer is announced with a toast, never applied to state", async () => {
    const toast = vi.fn();
    (globalThis as any).shopify = { toast: { show: toast } };
    const { result, rerender, unmount } = render();
    act(() => result.current.handlers.handlePrimaryMetafieldChange(MFA, "Leinen"));
    await press(result);
    rerender({ current: B, lang: "de" });
    act(() => result.current.handlers.handlePrimaryMetafieldChange(MFB, "Seide"));
    await press(result); // waits behind A
    rerender({ current: C, lang: "de" });
    expect(saves.sent).toHaveLength(1);

    unmount(); // Bulk / Settings
    showInfoBox.mockClear();
    await saves.settle({ ...OKP }); // A answers with nobody mounted
    expect(saves.sent).toHaveLength(2); // B was NOT dropped
    expect(productOf(1)).toBe(B.id);
    await saves.settle({ ...OKP });
    expect(showInfoBox).not.toHaveBeenCalled(); // no unmounted state touched
    expect(toast.mock.calls.map((c) => c[0])).toEqual(["Saved: Shirt", "Saved: Hat"]);
  });

  it("a failure after the unmount is announced as an error", async () => {
    const toast = vi.fn();
    (globalThis as any).shopify = { toast: { show: toast } };
    const { result, unmount } = render();
    act(() => result.current.handlers.handlePrimaryMetafieldChange(MFA, "Leinen"));
    await press(result);
    unmount();
    await saves.settle({ success: false, actionType: "savePrimarySubResources", error: "boom" });
    expect(String(toast.mock.calls[0][0])).toContain("Could not save Shirt");
    expect(toast.mock.calls[0][1]).toEqual({ isError: true, duration: 15000 });
  });

  it("a hook that mounts again sees the saves still out (Save busy, no double send)", async () => {
    const first = render();
    act(() => first.result.current.handlers.handlePrimaryMetafieldChange(MFA, "Leinen"));
    await press(first.result);
    first.unmount();
    const second = render();
    expect(second.result.current.state.isSaving).toBe(true);
    act(() => second.result.current.handlers.handlePrimaryMetafieldChange(MFA, "Hanf"));
    await press(second.result);
    expect(saves.sent).toHaveLength(1);
  });
});

describe("returning to A while its save is still out", () => {
  it("A shows as saving (Save busy), a second press sends nothing, and the answer re-reads", async () => {
    const { result, rerender } = render();
    act(() => result.current.handlers.handlePrimaryMetafieldChange(MFA, "Leinen"));
    await press(result);
    rerender({ current: B, lang: "de" });
    expect(result.current.state.isSaving).toBe(false); // B is free to work and save
    rerender({ current: A, lang: "de" });
    expect(result.current.state.isSaving).toBe(true); // no double send
    // The source text is moving: a translate must not use the old text.
    expect(result.current.state.metafieldTranslationBlocked).toBe(true);
    act(() => result.current.handlers.handlePrimaryMetafieldChange(MFA, "Hanf"));
    await press(result);
    expect(saves.sent).toHaveLength(1);
    await saves.settle({ ...OKP });
    expect(result.current.state.isSaving).toBe(false);
    expect(revalidator.revalidate).toHaveBeenCalled();
    // Typed after the return and not carried by the save: kept, with its save bar.
    expect(result.current.state.primaryMetafieldEdits).toEqual({ [MFA]: "Hanf" });
    expect(result.current.state.hasChanges).toBe(true);
  });
});

describe("a primary answer while the same product shows on a foreign tab (C1)", () => {
  it("leaves the foreign view's text, dirty ids and save bar alone", async () => {
    const { result, rerender } = render(A, "de");
    act(() => result.current.handlers.handlePrimaryMetafieldChange(MFA, "Leinen"));
    await press(result);
    rerender({ current: A, lang: "fr" });
    act(() => result.current.handlers.handleMetafieldChange(MFB, "Laine"));
    expect(result.current.state.hasChanges).toBe(true);
    showInfoBox.mockClear();

    await saves.settle({ ...OKP });

    expect(result.current.state.hasChanges).toBe(true);
    expect(result.current.state.metafieldTranslations[MFB]).toBe("Laine");
    expect(showInfoBox.mock.calls[0]).toEqual(["Saved: Shirt", "success"]);
    // ... and the foreign Save still sends it.
    await press(result);
    expect(saves.sent).toHaveLength(2);
    expect(JSON.parse(saves.fields(1).translationsData)).toEqual({ [MFB]: { value: "Laine" } });
  });
});

describe("a FOREIGN save answers for exactly what it carried (C2, M4)", () => {
  it("text typed in ANOTHER field after the press stays dirty and unsaved", async () => {
    const { result, rerender } = render(A, "fr");
    loadAnswer(rerender, A, { ...LOAD }, "fr");
    act(() => result.current.handlers.handleMetafieldChange(MFA, "Coton"));
    await press(result);
    act(() => result.current.handlers.handleMetafieldChange(MFB, "Laine"));
    await saves.settle(OKF([MFA]));
    expect(result.current.state.hasChanges).toBe(true);
    expect(result.current.state.metafieldTranslations[MFB]).toBe("Laine");
    await press(result); // the save carries ONLY the field typed after the first press
    expect(JSON.parse(saves.fields(1).translationsData)).toEqual({ [MFB]: { value: "Laine" } });
  });

  it("a RETYPE of a carried field stays dirty; it is not marked saved and not reverted", async () => {
    const { result, rerender } = render(A, "fr");
    loadAnswer(rerender, A, { ...LOAD }, "fr");
    act(() => result.current.handlers.handleMetafieldChange(MFA, "Coton"));
    await press(result);
    act(() => result.current.handlers.handleMetafieldChange(MFA, "Cotonnade"));
    await saves.settle({ success: true, actionType: "saveSubResourceTranslations", failedResources: [MFA], savedResources: [] });
    expect(result.current.state.metafieldTranslations[MFA]).toBe("Cotonnade");
    expect(result.current.state.hasChanges).toBe(true);
  });

  it("returning to the view while its save is out shows the SAVED text once it answers, and keeps what was typed since", async () => {
    const { result, rerender } = render(A, "fr");
    loadAnswer(rerender, A, { ...LOAD }, "fr");
    act(() => result.current.handlers.handleMetafieldChange(MFA, "Coton"));
    await press(result);
    rerender({ current: B, lang: "fr" });
    rerender({ current: A, lang: "fr" }); // re-read from the OLD item: the typed text is not on screen
    expect(result.current.state.metafieldTranslations[MFA]).not.toBe("Coton");
    act(() => result.current.handlers.handleMetafieldChange(MFB, "Laine"));
    await saves.settle(OKF([MFA]));
    expect(result.current.state.metafieldTranslations[MFA]).toBe("Coton"); // M4
    expect(result.current.state.metafieldTranslations[MFB]).toBe("Laine");
    expect(result.current.state.hasChanges).toBe(true);
  });
});

describe("structural edits after the press (C2: P3)", () => {
  it("a value added AFTER the press survives the answer, and the save bar with it", async () => {
    const { result, rerender } = render(A, "de");
    act(() => result.current.handlers.handlePrimaryMetafieldChange(MFA, "Leinen"));
    act(() => result.current.handlers.handleAddOptionValue(OPT, "Blue"));
    await press(result);
    act(() => result.current.handlers.handleAddOptionValue(OPT, "Green"));
    showInfoBox.mockClear();
    await saves.settle({ ...OKP });
    expect(result.current.state.optionValuesToAdd).toEqual({ [OPT]: ["Green"] });
    expect(result.current.state.hasChanges).toBe(true);
    // The next save waits for the reload (a Save pressed against the stale item
    // could conclude "unchanged"), then sends only the new value.
    await press(result);
    expect(saves.sent).toHaveLength(1);
    rerender({ current: { ...A }, lang: "de" });
    await press(result);
    expect(JSON.parse(JSON.parse(saves.fields(1).optionsChanges)[OPT] ? saves.fields(1).optionsChanges : "{}")[OPT].valuesToAdd).toEqual(["Green"]);
  });

  it("a delete queued after the press stays queued", async () => {
    const { result } = render(A, "de");
    act(() => result.current.handlers.handlePrimaryMetafieldChange(MFA, "Leinen"));
    await press(result);
    act(() => result.current.handlers.handleRemoveOptionValue(OPT, V1));
    await saves.settle({ ...OKP });
    expect(result.current.state.optionValuesToDelete).toEqual({ [OPT]: [V1] });
    expect(result.current.state.hasChanges).toBe(true);
  });
});

describe("a Phase-2 load and a save are independent", () => {
  it("a save pressed during a load goes out at once on its own request and leaves the load alone", async () => {
    const { result, rerender } = render(A, "fr");
    expect(submit.mock.calls.map((c) => (c[0] as any)?.action)).toEqual(["loadSubResourceTranslations"]);
    fetcher.state = "loading";
    rerender({ current: A, lang: "fr" });
    act(() => result.current.handlers.handleOptionNameChange(OPT, "Couleur"));
    await press(result);
    expect(saves.sent).toHaveLength(1);
    expect(submit).toHaveBeenCalledTimes(1); // the load fetcher was not touched
  });

  it("a load wanted while a save is out is NOT held back by it", async () => {
    const { result, rerender } = render(A, "fr");
    loadAnswer(rerender, A, { ...LOAD }, "fr");
    submit.mockClear();
    act(() => result.current.handlers.handleOptionNameChange(OPT, "Couleur"));
    await press(result);
    rerender({ current: B, lang: "fr" });
    expect(submit.mock.calls.map((c) => (c[0] as any)?.action)).toEqual(["loadSubResourceTranslations"]);
    expect((submit.mock.calls[0][0] as any).itemId).toBe(B.id);
  });

  it("a loaded value never overwrites text typed while the load was out (M3)", async () => {
    const { result, rerender } = render(A, "fr");
    fetcher.state = "loading";
    rerender({ current: A, lang: "fr" });
    act(() => result.current.handlers.handleMetafieldChange(MFA, "typed by merchant"));
    loadAnswer(rerender, A, { ...LOAD, translations: { [MFA]: { value: "from shopify" } } }, "fr");
    expect(result.current.state.metafieldTranslations[MFA]).toBe("typed by merchant");
    await press(result);
    expect(JSON.parse(saves.fields(0).translationsData)).toEqual({ [MFA]: { value: "typed by merchant" } });
  });
});

describe("a background refresh of the loader (M2)", () => {
  it("refreshTranslations keeps what B's merchant typed when A's answer reloads the item; resetForReload does not", () => {
    const base = mk("gid://shopify/Product/9", "B");
    const run = (kind: "refreshTranslations" | "resetForReload") => {
      const { result, rerender } = render(base, "de");
      rerender({ current: mk(base.id, "B"), lang: "de" });
      act(() => result.current.handlers[kind]());
      act(() => result.current.handlers.handlePrimaryMetafieldChange(MFA, "typed on B"));
      rerender({ current: mk(base.id, "B"), lang: "de" }); // the reload A's answer causes
      return result.current.state.primaryMetafieldEdits;
    };
    expect(run("refreshTranslations")).toEqual({ [MFA]: "typed on B" });
    // resetForReload no longer empties the load key either: a later reload keeps what was typed.
    expect(run("resetForReload")).toEqual({ [MFA]: "typed on B" });
  });
});

describe("what the page asks (clear all, translate all) sees queued saves too (M5)", () => {
  it("isSaveInFlight is true for a primary save (any language) and a foreign save (its language) while out OR waiting", async () => {
    const { result, rerender } = render(A, "de");
    act(() => result.current.handlers.handlePrimaryMetafieldChange(MFA, "Leinen"));
    await press(result);
    expect(result.current.handlers.isSaveInFlight(A.id, "fr")).toBe(true);
    expect(result.current.handlers.isSaveInFlight(B.id, "fr")).toBe(false);
    rerender({ current: B, lang: "fr" });
    loadAnswer(rerender, B, { ...LOAD }, "fr");
    act(() => result.current.handlers.handleMetafieldChange(MFB, "Laine"));
    await press(result); // waits behind A
    expect(result.current.handlers.isSaveInFlight(B.id, "fr")).toBe(true);
    expect(result.current.handlers.isSaveInFlight(B.id, "es")).toBe(false);
    await saves.settle({ ...OKP });
    await saves.settle(OKF([MFB]));
    expect(result.current.handlers.isSaveInFlight(B.id, "fr")).toBe(false);
  });
});

describe("the unsaved-changes confirm only asks for edits NO save carries", () => {
  it("no 'unsent' changes while a save carries everything; typing after it went out counts", async () => {
    const { result } = render();
    act(() => result.current.handlers.handlePrimaryMetafieldChange(MFA, "Leinen"));
    expect(result.current.state.hasUnsentChanges).toBe(true);
    await press(result);
    expect(result.current.state.hasChanges).toBe(true);
    expect(result.current.state.hasUnsentChanges).toBe(false);
    act(() => result.current.handlers.handlePrimaryMetafieldChange(MFA, "Hanf"));
    expect(result.current.state.hasUnsentChanges).toBe(true);
  });

  it("a QUEUED save carries its edits too", async () => {
    const { result, rerender } = render();
    act(() => result.current.handlers.handlePrimaryMetafieldChange(MFA, "Leinen"));
    await press(result);
    rerender({ current: B, lang: "de" });
    act(() => result.current.handlers.handlePrimaryMetafieldChange(MFB, "Seide"));
    await press(result);
    expect(result.current.state.hasUnsentChanges).toBe(false);
  });

  it("a translate or load landing for OTHER fields during a foreign save is no 'unsent' change", async () => {
    const { result, rerender } = render(A, "fr");
    loadAnswer(rerender, A, { ...LOAD }, "fr");
    act(() => result.current.handlers.handleMetafieldChange(MFA, "Coton"));
    await press(result);
    expect(result.current.state.hasUnsentChanges).toBe(false);
    // a load answer fills an unrelated field
    loadAnswer(rerender, A, { ...LOAD, translations: { [OPT]: { name: "Couleur" } } }, "fr");
    expect(result.current.state.hasUnsentChanges).toBe(false);
  });

  it("the page predicate asks only for unsent changes and never twice", () => {
    expect(shouldConfirmSubResourceSwitch(true, false)).toBe(true);
    expect(shouldConfirmSubResourceSwitch(false, false)).toBe(false);
    expect(shouldConfirmSubResourceSwitch(true, true)).toBe(false);
  });
});

// ============================================================================
// Review round: leaving and returning, discard, type-back, reloads, unknown outcomes
// ============================================================================

/** The reloaded item a revalidation would deliver: same product, a new object carrying `rows`. */
const reloaded = (item: any, rows: Record<string, Array<{ key: string; value: string; locale: string }>>) => ({
  ...item,
  subResourceTranslations: { ...(item.subResourceTranslations ?? {}), ...rows },
});

describe("leaving and returning to the product before the answer (C-A)", () => {
  const leaveAndReturn = (rerender: any, item: any, lang: string) => {
    rerender({ current: B, lang });
    rerender({ current: item, lang });
  };

  it.each([
    ["no answer at all", null],
    ["a server reason", { success: false, error: "Shopify exploded" }],
  ])("a failure (%s) says WHICH product and that the text must be entered again - never 'your edits are kept'", async (_n, answer) => {
    const { result, rerender } = render();
    act(() => result.current.handlers.handlePrimaryMetafieldChange(MFA, "Leinen"));
    await press(result);
    leaveAndReturn(rerender, A, "de");
    expect(result.current.state.primaryMetafieldEdits).toEqual({}); // the draft is gone
    showInfoBox.mockClear();
    await saves.settle(answer);
    const [message, tone] = showInfoBox.mock.calls.at(-1) ?? [];
    expect(String(message)).toContain("Could not save Shirt; enter it again.");
    expect(String(message)).not.toMatch(/edits are kept/i);
    expect(tone).toBe("critical");
    expect(result.current.state.hasChanges).toBe(false);
    if (answer && "error" in answer) expect(String(message)).toContain("Shopify exploded");
  });

  it("a REFUSED value does not claim 'your text stays in the field'", async () => {
    const { result, rerender } = render();
    act(() => result.current.handlers.handlePrimaryMetafieldChange(MFA, "Leinen"));
    await press(result);
    leaveAndReturn(rerender, A, "de");
    showInfoBox.mockClear();
    await saves.settle({ ...OKP, failedMetafields: [MFA], unverifiedMetafields: [MFA], metafieldRefusals: { [MFA]: "Must be int." } });
    const message = String(showInfoBox.mock.calls.at(-1)?.[0]);
    expect(message).toContain("Shopify refused: Must be int.");
    expect(message).not.toContain("stays in the field");
    expect(result.current.state.primaryMetafieldEdits).toEqual({});
  });

  it("a foreign failure on a re-entered view names the product instead of 'reverted to original values'", async () => {
    const { result, rerender } = render(A, "en");
    loadAnswer(rerender, A, { ...LOAD }, "en");
    act(() => result.current.handlers.handleOptionNameChange(OPT, "NeuName"));
    await press(result);
    leaveAndReturn(rerender, A, "en");
    showInfoBox.mockClear();
    await saves.settle({ success: true, actionType: "saveSubResourceTranslations", failedResources: [OPT], savedResources: [] });
    expect(showInfoBox.mock.calls.at(-1)).toEqual(["Partly saved: Shirt", "warning"]);
  });

  it("a CLEAN answer on a re-read view still settles (nothing is lost, nothing is shown as failed)", async () => {
    const { result, rerender } = render();
    act(() => result.current.handlers.handlePrimaryMetafieldChange(MFA, "Leinen"));
    await press(result);
    leaveAndReturn(rerender, A, "de");
    act(() => result.current.handlers.handlePrimaryMetafieldChange(MFA, "Hanf")); // typed after the return
    await saves.settle({ ...OKP });
    expect(result.current.state.primaryMetafieldEdits).toEqual({ [MFA]: "Hanf" });
  });
});

describe("discard and reload re-read in place, never by emptying the load key (C-B)", () => {
  it("discard, type, then ANY later reload keeps the typed text (primary)", async () => {
    const { result, rerender } = render();
    act(() => result.current.handlers.handlePrimaryMetafieldChange(MFA, "X"));
    act(() => result.current.handlers.resetChanges());
    act(() => result.current.handlers.handlePrimaryMetafieldChange(MFA, "Typed after discard"));
    rerender({ current: { ...A }, lang: "de" });
    expect(result.current.state.primaryMetafieldEdits).toEqual({ [MFA]: "Typed after discard" });
    expect(result.current.state.hasChanges).toBe(true);
  });

  it("a foreign discard re-reads the fields from the item instead of leaving them blank, and typing after it survives a reload", async () => {
    const rows = { [OPT]: [{ key: "name", value: "AltName", locale: "en" }] };
    const withRows = reloaded(A, rows);
    const { result, rerender } = render(withRows, "en");
    expect(result.current.state.optionTranslations[OPT]?.name).toBe("AltName");
    act(() => result.current.handlers.handleOptionNameChange(OPT, "X"));
    act(() => result.current.handlers.resetChanges());
    expect(result.current.state.optionTranslations[OPT]?.name).toBe("AltName"); // not blank
    act(() => result.current.handlers.handleOptionNameChange(OPT, "Typed after discard"));
    rerender({ current: { ...withRows }, lang: "en" });
    expect(result.current.state.optionTranslations[OPT]?.name).toBe("Typed after discard");
    expect(result.current.state.hasChanges).toBe(true);
  });

  it("A's answer reloading the item after a discard on B does not wipe what was typed on B", async () => {
    const { result, rerender } = render();
    act(() => result.current.handlers.handlePrimaryMetafieldChange(MFA, "Leinen"));
    await press(result);
    rerender({ current: B, lang: "de" });
    act(() => result.current.handlers.handlePrimaryMetafieldChange(MFB, "to be discarded"));
    act(() => result.current.handlers.resetChanges());
    act(() => result.current.handlers.handlePrimaryMetafieldChange(MFB, "typed after"));
    await saves.settle({ ...OKP });
    rerender({ current: { ...B }, lang: "de" }); // the reload A's answer asked for
    expect(result.current.state.primaryMetafieldEdits).toEqual({ [MFB]: "typed after" });
  });
});

describe("a Save pressed before the reload has landed (C-C)", () => {
  it("typing back to the old value during the save, then Save against the stale item: waits for the reload, then sends", async () => {
    const { result, rerender } = render();
    act(() => result.current.handlers.handlePrimaryMetafieldChange(MFA, "Leinen"));
    await press(result);
    act(() => result.current.handlers.handlePrimaryMetafieldChange(MFA, "Baumwolle")); // the ORIGINAL value
    await saves.settle({ ...OKP });
    expect(result.current.state.primaryMetafieldEdits).toEqual({ [MFA]: "Baumwolle" });
    expect(result.current.state.hasChanges).toBe(true);

    showInfoBox.mockClear();
    await press(result); // the item is still the old one: Baumwolle would read as "unchanged"
    expect(saves.sent).toHaveLength(1); // nothing sent...
    expect(result.current.state.hasChanges).toBe(true); // ...and the bar is NOT cleared
    expect(result.current.state.primaryMetafieldEdits).toEqual({ [MFA]: "Baumwolle" });
    expect(String(showInfoBox.mock.calls.at(-1)?.[0])).toMatch(/reload/i);

    // The reload lands: the item now holds Leinen, Baumwolle IS a change.
    rerender({ current: mk(A.id, "Shirt", { metafields: [{ id: MFA, namespace: "c", key: "a", value: "Leinen", type: "single_line_text_field" }, A.metafields[1]] }), lang: "de" });
    await press(result);
    expect(saves.sent).toHaveLength(2);
    expect(JSON.parse(saves.fields(1).metafieldChanges)).toEqual({ [MFA]: "Baumwolle" });
  });
});

describe("a foreign save reloads the item, or the saved text reverts on screen (M1)", () => {
  it("asks for a reload, and the saved text is still there after leaving and returning once it landed", async () => {
    const { result, rerender } = render(A, "en");
    loadAnswer(rerender, A, { ...LOAD }, "en");
    act(() => result.current.handlers.handleOptionNameChange(OPT, "NeuName"));
    await press(result);
    await saves.settle(OKF([OPT]));
    expect(revalidator.revalidate).toHaveBeenCalled();
    // The reload lands carrying the saved row.
    const fresh = reloaded(A, { [OPT]: [{ key: "name", value: "NeuName", locale: "en" }] });
    rerender({ current: fresh, lang: "en" });
    rerender({ current: B, lang: "en" });
    rerender({ current: fresh, lang: "en" });
    expect(result.current.state.optionTranslations[OPT]?.name).toBe("NeuName");
  });

  it("a saved CLEAR shows as empty when the view was re-entered while the save was out", async () => {
    const withRow = reloaded(A, { [OPT]: [{ key: "name", value: "OldName", locale: "en" }] });
    const { result, rerender } = render(withRow, "en");
    act(() => result.current.handlers.handleOptionNameChange(OPT, ""));
    await press(result);
    rerender({ current: B, lang: "en" });
    rerender({ current: withRow, lang: "en" });
    expect(result.current.state.optionTranslations[OPT]?.name).toBe("OldName");
    await saves.settle(OKF([OPT]));
    expect(result.current.state.optionTranslations[OPT]?.name).toBe("");
  });
});

describe("a partial save reloads (M2)", () => {
  it("a create landed but a reorder failed: the item is re-read and the translate source locked", async () => {
    const { result } = render();
    act(() => result.current.handlers.handleCreateOption("Material", ["Silk"]));
    await press(result);
    await saves.settle({ ...OKP, structuralFailures: 1 });
    expect(revalidator.revalidate).toHaveBeenCalled();
    expect(result.current.state.metafieldTranslationBlocked).toBe(true);
  });
});

describe("an outcome nobody knows (M3, M6)", () => {
  afterEach(() => vi.useRealTimers());

  it("not confirmed: reloads now and once more later, locks until it lands, and does not re-create what may have landed", async () => {
    vi.useFakeTimers();
    const { result, rerender } = render();
    act(() => result.current.handlers.handleCreateOption("Material", ["Silk"]));
    act(() => result.current.handlers.handlePrimaryMetafieldChange(MFA, "Leinen"));
    await press(result);
    showInfoBox.mockClear();
    await saves.settle({ success: false, error: "saveNotConfirmed", notConfirmed: true, notConfirmedReason: "connectionLost" });
    expect(String(showInfoBox.mock.calls.at(-1)?.[0])).toContain("No answer for Shirt.");
    expect(showInfoBox.mock.calls.at(-1)?.[1]).toBe("warning");
    expect(revalidator.revalidate).toHaveBeenCalledTimes(1);
    expect(result.current.state.metafieldTranslationBlocked).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8100);
    });
    expect(revalidator.revalidate).toHaveBeenCalledTimes(2);
    // The queued CREATE is dropped (it may have landed); the text edit is idempotent and stays.
    expect(result.current.state.optionsToCreate).toEqual([]);
    expect(result.current.state.primaryMetafieldEdits).toEqual({ [MFA]: "Leinen" });
    rerender({ current: { ...A }, lang: "de" }); // the reload lands
    await press(result);
    expect(saves.sent).toHaveLength(2);
    expect(saves.fields(1).optionsToCreate).toBeUndefined();
  });

  it("a foreign unknown outcome reloads too", async () => {
    const { result, rerender } = render(A, "en");
    loadAnswer(rerender, A, { ...LOAD }, "en");
    act(() => result.current.handlers.handleOptionNameChange(OPT, "NeuName"));
    await press(result);
    await saves.settle({ success: false, error: "saveNotConfirmed", notConfirmed: true, notConfirmedReason: "badGateway" });
    expect(revalidator.revalidate).toHaveBeenCalled();
  });
});

describe("the same product mounts again before the answer (M5)", () => {
  it("the new hook reloads, locks, tracks the tasks and reads purged market rows - nothing is dropped", async () => {
    const first = render();
    act(() => first.result.current.handlers.handlePrimaryMetafieldChange(MFA, "Leinen"));
    await press(first.result);
    first.unmount();
    const second = render();
    expect(second.result.current.state.metafieldTranslationBlocked).toBe(true); // a save of this product is out
    await saves.settle({ ...OKP, retranslationTaskIds: ["t1"], marketPurgedResourceIds: [MFA] });
    expect(revalidator.revalidate).toHaveBeenCalled();
    expect(onSaveResponse).toHaveBeenCalled();
    expect(second.result.current.state.metafieldTranslationBlocked).toBe(true); // locked until the reload lands
    second.rerender({ current: { ...A }, lang: "de" });
    expect(second.result.current.state.metafieldTranslationBlocked).toBe(false);
    // and it did not claim a "saved" for a view it never pressed
    expect(second.result.current.state.hasChanges).toBe(false);
  });
});

describe("answers of a save while another view shows (ports of the first queue tests)", () => {
  it("lands after the switch: B's dirty ids and typed translations survive, A is named", async () => {
    const { result, rerender } = render(A, "fr");
    loadAnswer(rerender, A, { ...LOAD }, "fr");
    act(() => result.current.handlers.handleOptionNameChange(OPT, "Couleur"));
    await press(result);
    rerender({ current: B, lang: "fr" });
    act(() => result.current.handlers.handleOptionNameChange(OPT, "Teinte"));
    showInfoBox.mockClear();
    await saves.settle(OKF([OPT]));
    expect(result.current.state.hasChanges).toBe(true);
    expect(result.current.state.optionTranslations[OPT]?.name).toBe("Teinte");
    expect(showInfoBox.mock.calls.at(-1)).toEqual(["Saved: Shirt", "success"]);
  });

  it("a FAILED resource of A is not restored onto B's fields", async () => {
    const { result, rerender } = render(A, "fr");
    loadAnswer(rerender, A, { ...LOAD }, "fr");
    act(() => result.current.handlers.handleOptionNameChange(OPT, "Couleur"));
    await press(result);
    rerender({ current: B, lang: "fr" });
    act(() => result.current.handlers.handleOptionNameChange(OPT, "Teinte"));
    showInfoBox.mockClear();
    await saves.settle({ success: true, actionType: "saveSubResourceTranslations", failedResources: [OPT], savedResources: [] });
    expect(result.current.state.optionTranslations[OPT]?.name).toBe("Teinte");
    expect(result.current.state.hasChanges).toBe(true);
    expect(showInfoBox.mock.calls.at(-1)).toEqual(["Partly saved: Shirt", "warning"]);
  });

  it("the primary answer on another tab of the same product re-numbers the card's local order state", async () => {
    const { result, rerender } = render(A, "de");
    act(() => result.current.handlers.handlePrimaryMetafieldChange(MFA, "Leinen"));
    await press(result);
    rerender({ current: A, lang: "fr" });
    const before = result.current.state.savedNonce;
    await saves.settle({ ...OKP });
    expect(result.current.state.savedNonce).toBeGreaterThan(before);
  });

  it("a foreign field that cannot be sent any more does not leave a stuck save bar", async () => {
    const { result, rerender } = render(A, "fr");
    loadAnswer(rerender, A, { ...LOAD }, "fr");
    act(() => result.current.handlers.handleOptionNameChange("gid://shopify/ProductOption/gone", "Orphan"));
    expect(result.current.state.hasChanges).toBe(true);
    await press(result);
    expect(saves.sent).toHaveLength(0);
    expect(result.current.state.hasChanges).toBe(false);
  });
});
