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
  metafieldValueRefused: "Shopify refused: {message}",
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
    expect(toast.mock.calls[0][1]).toEqual({ isError: true });
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
    const { result } = render(A, "de");
    act(() => result.current.handlers.handlePrimaryMetafieldChange(MFA, "Leinen"));
    act(() => result.current.handlers.handleAddOptionValue(OPT, "Blue"));
    await press(result);
    act(() => result.current.handlers.handleAddOptionValue(OPT, "Green"));
    showInfoBox.mockClear();
    await saves.settle({ ...OKP });
    expect(result.current.state.optionValuesToAdd).toEqual({ [OPT]: ["Green"] });
    expect(result.current.state.hasChanges).toBe(true);
    // The carried value is gone; the next save sends only the new one.
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
    // The trap the page used to fall into: the reset empties the load key, so the next reload wipes the typed edit.
    expect(run("resetForReload")).toEqual({});
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
