/**
 * The module-scope save queue (app/services/editor/sub-resource-save-queue.ts):
 * one chain in press order, an answer only ever handed to a MOUNTED owner, a
 * request that never answers cut off as NOT CONFIRMED, and a guard against
 * closing the tab while anything is out.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const appFetchMock = vi.fn();
vi.mock("../../app/utils/app-fetch", () => ({ appFetch: (...a: unknown[]) => appFetchMock(...a) }));

import {
  __resetSaveQueueForTests,
  __setSavePosterForTests,
  enqueueSave,
  getSaveEntries,
  postSave,
  SAVE_NOT_CONFIRMED_CODE,
  SAVE_TIMEOUT_MS,
  subscribeSaves,
  type QueuedSave,
} from "~/services/editor/sub-resource-save-queue";

const entry = (name: string, over: Partial<QueuedSave> = {}): QueuedSave => ({
  kind: "primary",
  itemId: name,
  title: name,
  viewKey: name,
  locale: "",
  fingerprint: "",
  formData: new FormData(),
  owner: { mounted: true, handle: vi.fn() },
  describe: () => ({ text: `done ${name}`, tone: "success" }),
  sent: {},
  ...over,
});

beforeEach(() => {
  __resetSaveQueueForTests();
  appFetchMock.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as any).shopify;
});

describe("the chain", () => {
  it("runs saves one at a time, in press order, and lists them while out or waiting", async () => {
    const order: string[] = [];
    const resolvers: Array<(v: any) => void> = [];
    __setSavePosterForTests((fd) => {
      order.push(String(fd.get("n")));
      return new Promise((resolve) => resolvers.push(resolve));
    });
    const a = entry("A");
    a.formData.set("n", "A");
    const b = entry("B");
    b.formData.set("n", "B");
    void enqueueSave(a);
    void enqueueSave(b);
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["A"]); // B waits
    expect(getSaveEntries().map((e) => e.itemId)).toEqual(["A", "B"]);
    resolvers[0]({ success: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual(["A", "B"]);
    expect(getSaveEntries().map((e) => e.itemId)).toEqual(["B"]);
    resolvers[1]({ success: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(getSaveEntries()).toEqual([]);
  });

  it("is already out of the list when the owner reads the answer, and listeners hear every change", async () => {
    __setSavePosterForTests(async () => ({ success: true }));
    const listener = vi.fn();
    subscribeSaves(listener);
    let listedWhenRead: number | null = null;
    const a = entry("A", { owner: { mounted: true, handle: () => { listedWhenRead = getSaveEntries().length; } } });
    await enqueueSave(a);
    expect(listedWhenRead).toBe(0);
    expect(listener).toHaveBeenCalled();
  });

  it("a request that throws, or an owner that throws, does not stop the chain", async () => {
    let n = 0;
    __setSavePosterForTests(async () => {
      n++;
      if (n === 1) throw new Error("network");
      return { success: true };
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const bad = entry("A", { owner: { mounted: true, handle: () => { throw new Error("owner broke"); } } });
    const handled = vi.fn();
    const good = entry("B", { owner: { mounted: true, handle: handled } });
    await Promise.all([enqueueSave(bad), enqueueSave(good)]);
    expect(handled).toHaveBeenCalledWith(good, { success: true });
    spy.mockRestore();
  });
});

describe("the owner is gone", () => {
  it("is never called; the merchant gets a toast in the shell instead", async () => {
    const toast = vi.fn();
    (globalThis as any).shopify = { toast: { show: toast } };
    __setSavePosterForTests(async () => ({ success: true }));
    const handle = vi.fn();
    await enqueueSave(entry("A", { owner: { mounted: false, handle } }));
    expect(handle).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith("done A", { isError: false });
  });

  it("without a shell there is nothing to say it to, and nothing throws", async () => {
    __setSavePosterForTests(async () => ({ success: false }));
    await expect(enqueueSave(entry("A", { owner: { mounted: false, handle: vi.fn() } }))).resolves.toBeUndefined();
  });
});

describe("leaving the tab", () => {
  it("guards beforeunload while anything is out or waiting, and only then", async () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    let resolve!: (v: any) => void;
    __setSavePosterForTests(() => new Promise((r) => (resolve = r)));
    const done = enqueueSave(entry("A"));
    expect(add.mock.calls.some((c) => c[0] === "beforeunload")).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    resolve({ success: true });
    await done;
    expect(remove.mock.calls.some((c) => c[0] === "beforeunload")).toBe(true);
    add.mockRestore();
    remove.mockRestore();
  });
});

describe("postSave (the real request)", () => {
  it("reads a JSON answer and marks a 4xx/5xx without success:false as a failure", async () => {
    appFetchMock.mockResolvedValue({ ok: false, json: async () => ({ error: "x" }) });
    expect(await postSave(new FormData())).toMatchObject({ success: false, error: "x" });
    appFetchMock.mockResolvedValue({ ok: true, json: async () => ({ success: true, a: 1 }) });
    expect(await postSave(new FormData())).toEqual({ success: true, a: 1 });
    appFetchMock.mockResolvedValue({ ok: true, json: async () => null });
    expect(await postSave(new FormData())).toBeNull();
  });

  it("an expired session carries its code, so the merchant is told to reload", async () => {
    appFetchMock.mockRejectedValue(Object.assign(new Error("sessionExpired"), { code: "sessionExpired" }));
    expect(await postSave(new FormData())).toEqual({ success: false, error: "sessionExpired" });
  });

  it("a request that never answers is cut off and reported NOT CONFIRMED, never failed or saved", async () => {
    vi.useFakeTimers();
    appFetchMock.mockImplementation(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_, reject) => {
          init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
        }),
    );
    const pending = postSave(new FormData());
    await vi.advanceTimersByTimeAsync(SAVE_TIMEOUT_MS + 1);
    expect(await pending).toEqual({ success: false, error: SAVE_NOT_CONFIRMED_CODE, notConfirmed: true });
  });

  it("a hung request does not hold the chain: the next save goes out after the cut-off", async () => {
    vi.useFakeTimers();
    __setSavePosterForTests(null);
    let calls = 0;
    appFetchMock.mockImplementation((_url: string, init: { signal: AbortSignal }) => {
      calls++;
      if (calls > 1) return Promise.resolve({ ok: true, json: async () => ({ success: true }) });
      return new Promise((_, reject) => {
        init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      });
    });
    const first = vi.fn();
    const second = vi.fn();
    void enqueueSave(entry("A", { owner: { mounted: true, handle: first } }));
    void enqueueSave(entry("B", { owner: { mounted: true, handle: second } }));
    await vi.advanceTimersByTimeAsync(10);
    expect(second).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(SAVE_TIMEOUT_MS + 10);
    expect(first.mock.calls[0][1]).toMatchObject({ notConfirmed: true });
    expect(second).toHaveBeenCalledTimes(1);
  });
});
