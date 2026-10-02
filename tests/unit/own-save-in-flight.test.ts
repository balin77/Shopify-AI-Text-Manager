import { describe, it, expect, vi } from "vitest";
import {
  isAltCoveredByOwnSave,
  isFieldCoveredByOwnSave,
  settleOwnSave,
  waitForOwnSavesToSettle,
  backstopOwnSaves,
  createSwitchIntents,
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

  it("an aborted signal releases the wait at once and clears its timer", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      let done = false;
      void waitForOwnSavesToSettle(true, [], 1000, controller.signal).then(() => { done = true; });
      await Promise.resolve();
      expect(done).toBe(false);
      expect(vi.getTimerCount()).toBe(1);
      controller.abort();
      await Promise.resolve();
      expect(done).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      // Already aborted: resolves without registering anything.
      const waiters: Array<() => void> = [];
      await waitForOwnSavesToSettle(true, waiters, 1000, controller.signal);
      expect(waiters).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a normal release clears the bound's timer too", async () => {
    vi.useFakeTimers();
    try {
      const waiters: Array<() => void> = [];
      const p = waitForOwnSavesToSettle(true, waiters, 1000);
      expect(vi.getTimerCount()).toBe(1);
      waiters.forEach((release) => release());
      await p;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("createSwitchIntents: only the latest claim is current, and dispose abandons all", () => {
    const intents = createSwitchIntents();
    const first = intents.claim();
    expect(first()).toBe(true);
    const second = intents.claim();
    expect(first()).toBe(false);
    expect(second()).toBe(true);
    intents.dispose();
    expect(second()).toBe(false);
    expect(intents.signal.aborted).toBe(true);
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
