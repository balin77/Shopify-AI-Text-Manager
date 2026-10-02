import { describe, it, expect, vi } from "vitest";
import {
  isAltCoveredByOwnSave,
  isFieldCoveredByOwnSave,
  settleOwnSave,
  waitForOwnSavesToSettle,
  backstopOwnSaves,
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

describe("own-save switch wait and idle backstop", () => {
  it("waitForOwnSavesToSettle resolves at once when nothing is pending", async () => {
    const waiters: Array<() => void> = [];
    await waitForOwnSavesToSettle(false, waiters);
    expect(waiters).toHaveLength(0);
  });

  it("waits until released, and gives up after the bound", async () => {
    vi.useFakeTimers();
    try {
      const waiters: Array<() => void> = [];
      let done = false;
      void waitForOwnSavesToSettle(true, waiters, 1000).then(() => { done = true; });
      await Promise.resolve();
      expect(done).toBe(false);
      waiters.forEach((release) => release());
      await Promise.resolve();
      expect(done).toBe(true);

      let timedOut = false;
      void waitForOwnSavesToSettle(true, [], 1000).then(() => { timedOut = true; });
      await vi.advanceTimersByTimeAsync(1000);
      expect(timedOut).toBe(true);
    } finally {
      vi.useRealTimers();
    }
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
