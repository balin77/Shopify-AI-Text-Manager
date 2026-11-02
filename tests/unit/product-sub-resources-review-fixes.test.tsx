import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";

const submit = vi.fn();
const fetcher: any = { state: "idle", data: undefined, submit, load: vi.fn(), Form: () => null };
vi.mock("react-router", () => ({ useFetcher: () => fetcher }));

import { useProductSubResources } from "~/hooks/useProductSubResources";
import { installSaves } from "../helpers/sub-resource-save-harness";

const MFA = "gid://shopify/Metafield/55";
const OPT = "gid://shopify/ProductOption/1";
const OPT2 = "gid://shopify/ProductOption/2";
const V1 = "gid://shopify/ProductOptionValue/1";
const V2 = "gid://shopify/ProductOptionValue/2";

const mk = (id: string, title: string, extra: any = {}) =>
  ({
    id,
    title,
    options: [{ id: OPT, name: "Colour", position: 1, values: [{ id: V1, name: "Red" }, { id: V2, name: "Blue" }] }],
    metafields: [{ id: MFA, namespace: "c", key: "a", value: "Baumwolle", type: "single_line_text_field" }],
    ...extra,
  }) as any;
const P = mk("gid://shopify/Product/1", "Shirt");
const Q = mk("gid://shopify/Product/2", "Hat");
const withOpt = (name: string, v1 = "Red", v2 = "Blue") =>
  mk(P.id, "Shirt", { options: [{ id: OPT, name, position: 1, values: [{ id: V1, name: v1 }, { id: V2, name: v2 }] }] });

const showInfoBox = vi.fn();
const STRINGS = {
  savedOtherProduct: "Saved: {title}",
  savePartialOtherProduct: "Partly saved: {title}",
  saveFailedOtherProduct: "Could not save {title}; enter it again.",
  saveNotConfirmed: "No answer for {title}.",
  reloadBeforeSave: "RELOADING",
  alreadyAdded: "Already added: {names}",
  optionsSavedSuccess: "SAVED-OK",
  metafieldDeleteRefused: "Not removed: {message}",
  optionRefusedByShopify: "Shopify said: {message}",
  optionValuesEmpty: "VALUES-EMPTY",
  optionWarning_metafieldWriteFailed: "WRITE-FAILED",
};
const OKP = { success: true, actionType: "savePrimarySubResources", failedOptions: [], failedMetafields: [] };
const UNKNOWN = { success: false, error: "saveNotConfirmed", notConfirmed: true, notConfirmedReason: "badGateway" };

let saves: ReturnType<typeof installSaves>;
let rv: { revalidate: any; state: string };
const render = (item: any = P, lang = "de") =>
  renderHook(
    ({ current, lang }: { current: any; lang: string }) =>
      useProductSubResources({
        selectedItem: current,
        currentLanguage: lang,
        primaryLocale: "de",
        showInfoBox,
        revalidator: rv,
        onSaveResponse: vi.fn(),
        strings: STRINGS,
      } as never),
    { initialProps: { current: item, lang } },
  );
const press = async (result: any) => {
  let out: unknown;
  act(() => {
    out = result.current.handlers.saveSubResources();
  });
  await saves.flush();
  return out;
};

/** A reload that started after the answer runs and delivers `item`. */
const reloadLands = (rerender: (props: { current: any; lang: string }) => void, item: any, lang = "de") => {
  rv = { ...rv, state: "loading" };
  rerender({ current: item, lang });
  rv = { ...rv, state: "idle" };
  rerender({ current: item, lang });
};

beforeEach(() => {
  saves = installSaves();
  showInfoBox.mockClear();
  rv = { revalidate: vi.fn(), state: "idle" };
  fetcher.state = "idle";
  fetcher.data = undefined;
});
afterEach(() => vi.useRealTimers());

describe("compare against what Shopify holds (F1, F2)", () => {
  it("F1: a landed rename of V1 is not reverted when only V2 is edited and the item is still stale", async () => {
    vi.useFakeTimers();
    const { result } = render();
    act(() => result.current.handlers.handlePrimaryOptionValueChange(OPT, V1, "Crimson"));
    await press(result);
    await saves.settle({ ...OKP });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_100); // the lock gives up; the item is still the old one
    });
    act(() => result.current.handlers.handlePrimaryOptionValueChange(OPT, V2, "Navy"));
    await press(result);
    expect(JSON.parse(saves.fields(1).optionsChanges)[OPT].valueUpdates).toEqual([{ id: V2, name: "Navy" }]);
  });

  it("F2a: typed back to the item's value while a save is out: the second Save sends it", async () => {
    vi.useFakeTimers();
    const { result } = render();
    act(() => result.current.handlers.handlePrimaryOptionValueChange(OPT, V1, "Crimson"));
    await press(result);
    act(() => result.current.handlers.handlePrimaryOptionValueChange(OPT, V1, "Red"));
    await saves.settle({ ...OKP });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_100);
    });
    expect(result.current.state.hasChanges).toBe(true);
    await press(result);
    expect(JSON.parse(saves.fields(1).optionsChanges)[OPT].valueUpdates).toEqual([{ id: V1, name: "Red" }]);
  });

  it("F2b: A landed, B landed on another product, back, typing A again is sent", async () => {
    const { result, rerender } = render();
    act(() => result.current.handlers.handlePrimaryOptionNameChange(OPT, "AAA"));
    await press(result);
    await saves.settle({ ...OKP });
    rerender({ current: withOpt("AAA"), lang: "de" });
    act(() => result.current.handlers.handlePrimaryOptionNameChange(OPT, "BBB"));
    await press(result);
    rerender({ current: Q, lang: "de" });
    await saves.settle({ ...OKP });
    reloadLands(rerender, withOpt("BBB"));
    act(() => result.current.handlers.handlePrimaryOptionNameChange(OPT, "AAA"));
    await press(result);
    expect(saves.sent).toHaveLength(3);
    expect(JSON.parse(saves.fields(2).optionsChanges)[OPT].name).toBe("AAA");
  });

  it("F2b: the same with a value and a sibling edit sends both", async () => {
    const { result, rerender } = render();
    act(() => result.current.handlers.handlePrimaryOptionValueChange(OPT, V1, "AAA"));
    await press(result);
    await saves.settle({ ...OKP });
    rerender({ current: withOpt("Colour", "AAA"), lang: "de" });
    act(() => result.current.handlers.handlePrimaryOptionValueChange(OPT, V1, "BBB"));
    await press(result);
    rerender({ current: Q, lang: "de" });
    await saves.settle({ ...OKP });
    reloadLands(rerender, withOpt("Colour", "BBB"));
    act(() => result.current.handlers.handlePrimaryOptionValueChange(OPT, V1, "AAA"));
    act(() => result.current.handlers.handlePrimaryOptionValueChange(OPT, V2, "Navy"));
    await press(result);
    expect(JSON.parse(saves.fields(2).optionsChanges)[OPT].valueUpdates).toEqual([
      { id: V1, name: "AAA" },
      { id: V2, name: "Navy" },
    ]);
  });

  it("F2c: an unknown outcome that landed, then the previous value typed again, is sent", async () => {
    const { result, rerender } = render();
    act(() => result.current.handlers.handlePrimaryOptionNameChange(OPT, "AAA"));
    await press(result);
    await saves.settle({ ...OKP });
    rerender({ current: withOpt("AAA"), lang: "de" });
    act(() => result.current.handlers.handlePrimaryOptionNameChange(OPT, "BBB"));
    await press(result);
    await saves.settle({ ...UNKNOWN });
    rerender({ current: withOpt("BBB"), lang: "de" });
    act(() => result.current.handlers.handlePrimaryOptionNameChange(OPT, "AAA"));
    await press(result);
    expect(saves.sent).toHaveLength(3);
    expect(JSON.parse(saves.fields(2).optionsChanges)[OPT].name).toBe("AAA");
  });

  it("a trailing space the server trimmed does not re-send the sibling value", async () => {
    const { result, rerender } = render();
    act(() => result.current.handlers.handlePrimaryOptionValueChange(OPT, V1, "Crimson "));
    await press(result);
    await saves.settle({ ...OKP });
    rerender({ current: withOpt("Colour", "Crimson"), lang: "de" });
    act(() => result.current.handlers.handlePrimaryOptionValueChange(OPT, V2, "Navy"));
    await press(result);
    expect(JSON.parse(saves.fields(1).optionsChanges)[OPT].valueUpdates).toEqual([{ id: V2, name: "Navy" }]);
  });

  it("undo: a value typed and then typed back to the item's, nothing landed: nothing is sent", async () => {
    const { result } = render();
    act(() => result.current.handlers.handlePrimaryOptionValueChange(OPT, V1, "Crimson"));
    act(() => result.current.handlers.handlePrimaryOptionValueChange(OPT, V1, "Red"));
    await press(result);
    expect(saves.sent).toHaveLength(0);
    expect(result.current.state.hasChanges).toBe(false);
  });

  it("sibling: an edit of V2 alone sends V2 only", async () => {
    const { result } = render();
    act(() => result.current.handlers.handlePrimaryOptionValueChange(OPT, V2, "Navy"));
    await press(result);
    expect(JSON.parse(saves.fields(0).optionsChanges)[OPT].valueUpdates).toEqual([{ id: V2, name: "Navy" }]);
  });

  it("a metafield cleared and typed back while stale is still sent", async () => {
    vi.useFakeTimers();
    const { result } = render();
    act(() => result.current.handlers.handlePrimaryMetafieldChange(MFA, ""));
    await press(result);
    act(() => result.current.handlers.handlePrimaryMetafieldChange(MFA, "Baumwolle"));
    await saves.settle({ ...OKP });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_100);
    });
    await press(result);
    expect(JSON.parse(saves.fields(1).metafieldChanges)).toEqual({ [MFA]: "Baumwolle" });
  });
});

describe("reconcile after an unknown outcome (F3, F4, F5)", () => {
  it("F3: typed translations keep the save bar when the reload releases the lock", async () => {
    const { result, rerender } = render();
    act(() => result.current.handlers.handleCreateOption("Material", ["Silk"]));
    await press(result);
    await saves.settle({ ...UNKNOWN });
    rerender({ current: P, lang: "en" });
    act(() => result.current.handlers.handleOptionNameChange(OPT, "typed translation"));
    expect(result.current.state.hasChanges).toBe(true);
    rerender({ current: { ...P }, lang: "en" });
    expect(result.current.state.hasChanges).toBe(true);
    expect(result.current.state.optionTranslations[OPT]?.name).toBe("typed translation");
  });

  it("F4: a linked add that landed is not kept queued", async () => {
    const linked = { id: "gid://shopify/Metaobject/9", name: "Linked" };
    const { result, rerender } = render();
    act(() => result.current.handlers.handleAddLinkedOptionValue(OPT, linked));
    await press(result);
    await saves.settle({ ...UNKNOWN });
    rerender({
      current: mk(P.id, "Shirt", { options: [{ id: OPT, name: "Colour", position: 1, values: [{ id: V1, name: "Red" }, { id: "v9", name: "Linked", linkedValue: linked.id }] }] }),
      lang: "de",
    });
    expect(result.current.state.optionLinkedValuesToAdd[OPT] ?? []).toEqual([]);
  });

  it("F4: a linked add that did not land stays queued", async () => {
    const linked = { id: "gid://shopify/Metaobject/9", name: "Linked" };
    const { result, rerender } = render();
    act(() => result.current.handlers.handleAddLinkedOptionValue(OPT, linked));
    await press(result);
    await saves.settle({ ...UNKNOWN });
    rerender({ current: { ...P }, lang: "de" });
    expect(result.current.state.optionLinkedValuesToAdd[OPT]).toEqual([linked]);
  });

  it("F5: delete Size + create Size, nothing landed: both stay", async () => {
    const two = mk(P.id, "Shirt", { options: [...P.options, { id: OPT2, name: "Size", position: 2, values: [{ id: "s", name: "S" }] }] });
    const { result, rerender } = render(two);
    act(() => result.current.handlers.handleDeleteOption(OPT2));
    act(() => result.current.handlers.handleCreateOption("Size", ["XL"]));
    await press(result);
    await saves.settle({ ...UNKNOWN });
    rerender({ current: { ...two }, lang: "de" });
    expect(result.current.state.optionsToCreate).toHaveLength(1);
    expect(result.current.state.optionsToDelete).toEqual([OPT2]);
    await press(result);
    expect(JSON.parse(saves.fields(1).optionsToDelete)).toEqual([OPT2]);
    expect(JSON.parse(saves.fields(1).optionsToCreate)).toHaveLength(1);
  });

  it("F5: delete Size + create Size, it landed: both are dropped", async () => {
    const two = mk(P.id, "Shirt", { options: [...P.options, { id: OPT2, name: "Size", position: 2, values: [{ id: "s", name: "S" }] }] });
    const { result, rerender } = render(two);
    act(() => result.current.handlers.handleDeleteOption(OPT2));
    act(() => result.current.handlers.handleCreateOption("Size", ["XL"]));
    await press(result);
    await saves.settle({ ...UNKNOWN });
    const landed = mk(P.id, "Shirt", { options: [...P.options, { id: "gid://shopify/ProductOption/3", name: "Size", position: 2, values: [{ id: "x", name: "XL" }] }] });
    rerender({ current: landed, lang: "de" });
    expect(result.current.state.optionsToCreate).toEqual([]);
    expect(result.current.state.optionsToDelete).toEqual([]);
  });

  it("F5: a value queued for deletion does not count as already added", async () => {
    const { result, rerender } = render();
    act(() => result.current.handlers.handleRemoveOptionValue(OPT, V2));
    act(() => result.current.handlers.handleAddOptionValue(OPT, "Blue"));
    await press(result);
    await saves.settle({ ...UNKNOWN });
    rerender({ current: { ...P }, lang: "de" });
    expect(result.current.state.optionValuesToAdd[OPT]).toEqual(["Blue"]);
    expect(result.current.state.optionValuesToDelete[OPT]).toEqual([V2]);
  });
});

describe("the reload lock belongs to its product (F6)", () => {
  it("a Save of product B is not refused while product A reloads", async () => {
    const { result, rerender } = render();
    act(() => result.current.handlers.handlePrimaryMetafieldChange(MFA, "Leinen"));
    await press(result);
    await saves.settle({ ...OKP });
    rv = { ...rv, state: "loading" };
    rerender({ current: P, lang: "de" });
    rerender({ current: Q, lang: "de" });
    act(() => result.current.handlers.handlePrimaryMetafieldChange(MFA, "Seide"));
    const out = await press(result);
    expect(out).not.toBe("waiting");
    expect(saves.sent).toHaveLength(2);
  });

  it("back on A the lock is still held until the reload lands", async () => {
    const { result, rerender } = render();
    act(() => result.current.handlers.handlePrimaryMetafieldChange(MFA, "Leinen"));
    await press(result);
    await saves.settle({ ...OKP });
    rv = { ...rv, state: "loading" };
    rerender({ current: P, lang: "de" });
    rerender({ current: Q, lang: "de" });
    rerender({ current: P, lang: "de" });
    act(() => result.current.handlers.handlePrimaryMetafieldChange(MFA, "Baumwolle"));
    const out = await press(result);
    expect(out).toBe("waiting");
    expect(saves.sent).toHaveLength(1);
  });
});

describe("armed re-read on a foreign tab (F7)", () => {
  it("is not spent on the item of a reload that began before the write", async () => {
    const rows = { [OPT]: [{ key: "name", value: "Purged", locale: "en" }] };
    const withRows = () => mk(P.id, "Shirt", { subResourceTranslations: rows });
    const start = withRows();
    const { result, rerender } = render(start);
    act(() => result.current.handlers.handlePrimaryMetafieldChange(MFA, "Leinen"));
    await press(result);
    rerender({ current: start, lang: "en" });
    rv = { ...rv, state: "loading" }; // a reload already running
    rerender({ current: start, lang: "en" });
    await saves.settle({ ...OKP }); // arms; queues a second reload behind the running one
    rv = { ...rv, state: "idle" };
    const preWrite = withRows();
    rerender({ current: preWrite, lang: "en" }); // the pre-write item
    rv = { ...rv, state: "loading" };
    rerender({ current: preWrite, lang: "en" });
    rv = { ...rv, state: "idle" };
    rerender({ current: mk(P.id, "Shirt"), lang: "en" }); // the fresh item: the purge removed the row
    expect(result.current.state.optionTranslations[OPT]?.name ?? "").toBe("");
  });
});

describe("Discard then typing (P8)", () => {
  it("the saved text stays when the pre-write item arrives", async () => {
    const rows = { [OPT]: [{ key: "name", value: "OLD", locale: "en" }] };
    const item = mk(P.id, "Shirt", { subResourceTranslations: rows });
    const { result, rerender } = render(item, "en");
    act(() => result.current.handlers.resetChanges());
    act(() => result.current.handlers.handleOptionNameChange(OPT, "NEW"));
    await press(result);
    await saves.settle({ success: true, actionType: "saveSubResourceTranslations", failedResources: [], savedResources: [OPT] });
    rerender({ current: { ...item }, lang: "en" });
    expect(result.current.state.optionTranslations[OPT]?.name).toBe("NEW");
  });
});

describe("a blanked value is refused before anything is sent", () => {
  it("name + value edits + an add: nothing goes out and every edit stays", async () => {
    const { result } = render();
    act(() => result.current.handlers.handlePrimaryOptionNameChange(OPT, "Farbe"));
    act(() => result.current.handlers.handlePrimaryOptionValueChange(OPT, V1, "Crimson"));
    act(() => result.current.handlers.handlePrimaryOptionValueChange(OPT, V2, ""));
    act(() => result.current.handlers.handleAddOptionValue(OPT, "Green"));
    await press(result);
    expect(saves.sent).toHaveLength(0);
    expect(showInfoBox).toHaveBeenCalledWith("VALUES-EMPTY", "critical");
    expect(result.current.state.primaryOptionEdits[OPT].values[V2]).toBe("");
    expect(result.current.state.optionValuesToAdd[OPT]).toEqual(["Green"]);
    expect(result.current.state.hasChanges).toBe(true);
  });

  it("a blank value that is being deleted does not block the save", async () => {
    const { result } = render();
    act(() => result.current.handlers.handlePrimaryOptionValueChange(OPT, V2, ""));
    act(() => result.current.handlers.handleRemoveOptionValue(OPT, V2));
    act(() => result.current.handlers.handlePrimaryOptionValueChange(OPT, V1, "Crimson"));
    await press(result);
    expect(saves.sent).toHaveLength(1);
    expect(JSON.parse(saves.fields(0).optionsChanges)[OPT].valueUpdates).toEqual([{ id: V1, name: "Crimson" }]);
  });
});

describe("a blank pending addition is refused before anything is sent", () => {
  const blankRow = (text: string) => {
    const hook = render();
    act(() => hook.result.current.handlers.handlePrimaryOptionNameChange(OPT, "Farbe"));
    act(() => hook.result.current.handlers.handleAddOptionValue(OPT, "Green"));
    act(() => hook.result.current.handlers.handleEditPendingValue(OPT, 0, text));
    return hook;
  };

  for (const text of ["", "   "]) {
    it(`blank text ${JSON.stringify(text)}: refused, nothing sent, everything kept`, async () => {
      const { result } = blankRow(text);
      await press(result);
      expect(saves.sent).toHaveLength(0);
      expect(showInfoBox).toHaveBeenCalledWith("VALUES-EMPTY", "critical");
      expect(result.current.state.primaryOptionEdits[OPT].name).toBe("Farbe");
      expect(result.current.state.optionValuesToAdd[OPT]).toEqual([text]);
      expect(result.current.state.hasChanges).toBe(true);
    });
  }

  it("corrected, the next press sends the rename and the add", async () => {
    const { result } = blankRow("");
    await press(result);
    act(() => result.current.handlers.handleEditPendingValue(OPT, 0, "Green"));
    await press(result);
    expect(JSON.parse(saves.fields(0).optionsChanges)[OPT]).toEqual({ name: "Farbe", valuesToAdd: ["Green"] });
  });

  it("the row removed, the next press sends the rename alone", async () => {
    const { result } = blankRow("");
    await press(result);
    act(() => result.current.handlers.handleRemoveOptionValue(OPT, "", 0));
    await press(result);
    expect(JSON.parse(saves.fields(0).optionsChanges)[OPT]).toEqual({ name: "Farbe" });
  });

  it("a blank row on an option being deleted does not block", async () => {
    const { result } = blankRow("");
    act(() => result.current.handlers.handleDeleteOption(OPT));
    await press(result);
    expect(saves.sent).toHaveLength(1);
    expect(showInfoBox).not.toHaveBeenCalledWith("VALUES-EMPTY", "critical");
  });

  it("a new option with only blank values is refused", async () => {
    const { result } = render();
    act(() => result.current.handlers.handleCreateOption("Material", ["", "  "]));
    act(() => result.current.handlers.handlePrimaryOptionNameChange(OPT, "Farbe"));
    await press(result);
    expect(saves.sent).toHaveLength(0);
    expect(showInfoBox).toHaveBeenCalledWith("VALUES-EMPTY", "critical");
    expect(result.current.state.optionsToCreate).toHaveLength(1);
    expect(result.current.state.primaryOptionEdits[OPT].name).toBe("Farbe");
  });

  it("a new option with no values at all is refused too", async () => {
    const { result } = render();
    act(() => result.current.handlers.handleCreateOption("Material", []));
    await press(result);
    expect(saves.sent).toHaveLength(0);
    expect(showInfoBox).toHaveBeenCalledWith("VALUES-EMPTY", "critical");
  });

  it("a new option with one real value (and a blank extra) is sent", async () => {
    const { result } = render();
    act(() => result.current.handlers.handleCreateOption("Material", ["Silk", " "]));
    await press(result);
    expect(saves.sent).toHaveLength(1);
    expect(JSON.parse(saves.fields(0).optionsToCreate)).toEqual([{ name: "Material", values: ["Silk", " "] }]);
    expect(showInfoBox).not.toHaveBeenCalledWith("VALUES-EMPTY", "critical");
  });
});

describe("a blank row on an option that is gone from the item", () => {
  const OPT2 = "gid://shopify/ProductOption/2";
  const withSize = () =>
    mk(P.id, "Shirt", { options: [...P.options, { id: OPT2, name: "Size", position: 2, values: [{ id: "s", name: "S" }] }] });
  const pendingBlank = (result: any) => {
    act(() => result.current.handlers.handleAddOptionValue(OPT2, "Green"));
    act(() => result.current.handlers.handleEditPendingValue(OPT2, 0, ""));
  };

  it("route 1: delete landed after an unknown outcome - the row goes, the next Save of another option goes out", async () => {
    const { result, rerender } = render(withSize());
    pendingBlank(result);
    act(() => result.current.handlers.handleDeleteOption(OPT2));
    act(() => result.current.handlers.handlePrimaryOptionNameChange(OPT, "Farbe"));
    await press(result);
    await saves.settle({ ...UNKNOWN });
    reloadLands(rerender, mk(P.id, "Shirt", { options: [{ ...P.options[0], name: "Farbe" }] }));
    expect(result.current.state.optionValuesToAdd[OPT2]).toBeUndefined();
    expect(result.current.state.optionsToDelete).toEqual([]);
    act(() => result.current.handlers.handlePrimaryOptionNameChange(OPT, "Farbe2"));
    showInfoBox.mockClear();
    await press(result);
    expect(saves.sent).toHaveLength(2);
    expect(showInfoBox).not.toHaveBeenCalledWith("VALUES-EMPTY", "critical");
    expect(saves.fields(1).optionsChanges).not.toContain('[""]');
    expect(JSON.parse(saves.fields(1).optionsChanges)).toEqual({ [OPT]: { name: "Farbe2" } });
  });

  it("route 2: the option disappears on a plain reload - nothing is stuck, nothing blank is sent", async () => {
    const { result, rerender } = render(withSize());
    pendingBlank(result);
    rerender({ current: mk(P.id, "Shirt"), lang: "de" });
    act(() => result.current.handlers.handlePrimaryOptionNameChange(OPT, "Farbe"));
    await press(result);
    expect(showInfoBox).not.toHaveBeenCalledWith("VALUES-EMPTY", "critical");
    expect(JSON.parse(saves.fields(0).optionsChanges)).toEqual({ [OPT]: { name: "Farbe" } });
    await saves.settle({ ...OKP });
    reloadLands(rerender, mk(P.id, "Shirt", { options: [{ ...P.options[0], name: "Farbe" }] }));
    expect(result.current.state.primaryOptionEdits).toEqual({});
  });

  it("route 2 with nothing else pending: the press sends nothing and the bar clears", async () => {
    const { result, rerender } = render(withSize());
    pendingBlank(result);
    rerender({ current: mk(P.id, "Shirt"), lang: "de" });
    await press(result);
    expect(showInfoBox).not.toHaveBeenCalledWith("VALUES-EMPTY", "critical");
    expect(saves.sent).toHaveLength(0);
    expect(result.current.state.hasChanges).toBe(false);
  });
});

describe("returning to a product before its reload lands", () => {
  const fresh = (text: string) => mk(P.id, "Shirt", { metafields: [{ id: MFA, namespace: "c", key: "a", value: text, type: "single_line_text_field" }] });

  it("A answered while B showed: back on A the lock is there and the Save waits", async () => {
    const { result, rerender } = render();
    act(() => result.current.handlers.handlePrimaryMetafieldChange(MFA, "Leinen"));
    await press(result);
    rerender({ current: Q, lang: "de" });
    await saves.settle({ ...OKP });
    rv = { ...rv, state: "loading" };
    rerender({ current: Q, lang: "de" });
    rerender({ current: P, lang: "de" }); // the stale item
    expect(result.current.state.metafieldTranslationBlocked).toBe(true);
    expect(result.current.state.optionTranslationBlockedIds.size).toBeGreaterThan(0);
    act(() => result.current.handlers.handlePrimaryMetafieldChange(MFA, "Baumwolle")); // the old text typed back
    expect(await press(result)).toBe("waiting");
    expect(saves.sent).toHaveLength(1);
    expect(result.current.state.hasChanges).toBe(true);
    rv = { ...rv, state: "idle" };
    rerender({ current: fresh("Leinen"), lang: "de" });
    await press(result);
    expect(JSON.parse(saves.fields(1).metafieldChanges)).toEqual({ [MFA]: "Baumwolle" });
  });

  it("A and B both answered: the lock and the record of A survive B's answer", async () => {
    const { result, rerender } = render();
    act(() => result.current.handlers.handlePrimaryMetafieldChange(MFA, "Leinen"));
    await press(result);
    await saves.settle({ ...OKP });
    rv = { ...rv, state: "loading" };
    rerender({ current: P, lang: "de" });
    rerender({ current: Q, lang: "de" });
    act(() => result.current.handlers.handlePrimaryMetafieldChange(MFA, "Seide"));
    await press(result);
    await saves.settle({ ...OKP });
    rerender({ current: P, lang: "de" });
    expect(result.current.state.metafieldTranslationBlocked).toBe(true);
    act(() => result.current.handlers.handlePrimaryMetafieldChange(MFA, "Wolle"));
    expect(await press(result)).toBe("waiting");
  });

  it("the locks give up after 20 s even when the product is not showing, and the bar follows the send rule", async () => {
    vi.useFakeTimers();
    const { result, rerender } = render();
    act(() => result.current.handlers.handlePrimaryMetafieldChange(MFA, "Leinen"));
    await press(result);
    rerender({ current: Q, lang: "de" });
    await saves.settle({ ...OKP });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_100);
    });
    rerender({ current: P, lang: "de" }); // still the stale item, lock gone
    expect(result.current.state.metafieldTranslationBlocked).toBe(false);
    act(() => result.current.handlers.handlePrimaryMetafieldChange(MFA, "Baumwolle"));
    expect(result.current.state.hasChanges).toBe(true);
    await press(result);
    expect(JSON.parse(saves.fields(1).metafieldChanges)).toEqual({ [MFA]: "Baumwolle" });
  });
});

describe("failure reasons reach the merchant", () => {
  it("Shopify's reason for a refused option write is shown, intact view and elsewhere", async () => {
    const { result, rerender } = render();
    act(() => result.current.handlers.handlePrimaryOptionNameChange(OPT, "Farbe"));
    await press(result);
    showInfoBox.mockClear();
    await saves.settle({ ...OKP, failedOptions: [OPT], optionWarnings: ["optionsFailed"], optionRefusals: ["Option name is too long"] });
    expect(String(showInfoBox.mock.calls[0]?.[0])).toContain("Option name is too long");

    reloadLands(rerender, P);
    act(() => result.current.handlers.handlePrimaryOptionNameChange(OPT, "Couleur"));
    await press(result);
    rerender({ current: Q, lang: "de" });
    showInfoBox.mockClear();
    await saves.settle({ ...OKP, failedOptions: [OPT], optionWarnings: ["optionsFailed"], optionRefusals: ["Option name is too long"] });
    expect(String(showInfoBox.mock.calls[0]?.[0])).toContain("Option name is too long");
  });

  it("a refused clear names Shopify's message; a code names its sentence", async () => {
    const { result } = render();
    act(() => result.current.handlers.handlePrimaryMetafieldChange(MFA, ""));
    await press(result);
    showInfoBox.mockClear();
    await saves.settle({
      ...OKP,
      failedMetafields: [MFA],
      metafieldDeleteRefusal: "Definition is pinned",
      optionWarnings: ["metafieldWriteFailed"],
    });
    const text = String(showInfoBox.mock.calls[0]?.[0]);
    expect(text).toContain("Definition is pinned");
    expect(text).toContain("WRITE-FAILED");
  });
});
