import { describe, it, expect } from "vitest";
import {
  isAltCoveredByOwnSave,
  isFieldCoveredByOwnSave,
  settleOwnSave,
  settleUnsentSave,
  backstopOwnSaves,
  hasOwnSaveInFlight,
  type OwnSaveInFlight,
} from "~/services/editor/own-save-in-flight.shared";

const token = {};
const entry: OwnSaveInFlight = {
  itemId: "gid://shopify/Product/1",
  locale: "de",
  marketId: "",
  values: { title: "Neu" },
  altValues: { 2: "Alt neu" },
  token,
};
const view = { itemId: "gid://shopify/Product/1", locale: "de", marketId: "" };

describe("own save in flight", () => {
  it("covers exactly the value it sent, in the view it was sent from", () => {
    expect(isFieldCoveredByOwnSave([entry], view, "title", "Neu")).toBe(true);
    expect(isFieldCoveredByOwnSave([entry], view, "title", "Neu!")).toBe(false);
    expect(isFieldCoveredByOwnSave([entry], view, "description", "Neu")).toBe(false);
    expect(isFieldCoveredByOwnSave([entry], { ...view, locale: "fr" }, "title", "Neu")).toBe(false);
    expect(isFieldCoveredByOwnSave([entry], { ...view, marketId: "gid://shopify/Market/2" }, "title", "Neu")).toBe(false);
    expect(isFieldCoveredByOwnSave([entry], { ...view, itemId: "gid://shopify/Product/2" }, "title", "Neu")).toBe(false);
    expect(isFieldCoveredByOwnSave([entry], { ...view, itemId: null }, "title", "Neu")).toBe(false);
  });

  it("covers an alt text the same way", () => {
    expect(isAltCoveredByOwnSave([entry], view, 2, "Alt neu")).toBe(true);
    expect(isAltCoveredByOwnSave([entry], view, 2, "Alt neu?")).toBe(false);
    expect(isAltCoveredByOwnSave([entry], view, 1, "Alt neu")).toBe(false);
    expect(isAltCoveredByOwnSave([entry], view, 2, undefined)).toBe(false);
  });

  it("is settled by its own request's answer only", () => {
    const other: OwnSaveInFlight = { ...entry, token: {} };
    expect(settleOwnSave([entry, other], token)).toEqual([other]);
    const list = [other];
    expect(settleOwnSave(list, token)).toBe(list);
    expect(settleOwnSave(list, null)).toBe(list);
  });
});

describe("own-save switch refusal and idle backstop", () => {
  it("hasOwnSaveInFlight: a switch is refused exactly while an own save is out", () => {
    expect(hasOwnSaveInFlight([])).toBe(false);
    expect(hasOwnSaveInFlight([entry])).toBe(true);
    // Settled by its answer: the switch goes through again.
    expect(hasOwnSaveInFlight(settleOwnSave([entry], token))).toBe(false);
  });

  it("backstopOwnSaves clears everything but the save submitted in this flush", () => {
    const token = {};
    const mine = { itemId: "p", locale: "de", marketId: "", values: { title: "x" }, token };
    const stale = { itemId: "p", locale: "de", marketId: "", values: { body: "y" }, token: {} };
    expect(backstopOwnSaves([mine, stale], null)).toEqual([]);
    expect(backstopOwnSaves([mine, stale], token)).toEqual([mine]);
    const same = [mine];
    expect(backstopOwnSaves(same, token)).toBe(same);
  });
});

describe("settleUnsentSave (a submit that threw)", () => {
  it("drops the entry and clears every slot this request holds", () => {
    let entries: OwnSaveInFlight[] = [entry];
    const toast = "ok";
    const refs = {
      inFlightPartialRef: { current: token as unknown },
      inFlightToastRef: { current: toast as unknown },
      inFlightScopeRef: { current: { locale: "de" } as unknown },
      isSavePendingRef: { current: true },
    };
    settleUnsentSave({
      partial: token,
      successToast: toast,
      setOwnSavesInFlight: (update) => {
        entries = update(entries);
      },
      ...refs,
    });
    expect(entries).toEqual([]);
    expect(refs.inFlightPartialRef.current).toBeNull();
    expect(refs.inFlightToastRef.current).toBeNull();
    expect(refs.inFlightScopeRef.current).toBeNull();
    expect(refs.isSavePendingRef.current).toBe(false);
  });

  it("leaves a NEWER request's partial and toast alone", () => {
    const newer = {};
    const partialRef = { current: newer as unknown };
    const toastRef = { current: "newer" as unknown };
    settleUnsentSave({ partial: token, successToast: "older", inFlightPartialRef: partialRef, inFlightToastRef: toastRef });
    expect(partialRef.current).toBe(newer);
    expect(toastRef.current).toBe("newer");
  });
});
