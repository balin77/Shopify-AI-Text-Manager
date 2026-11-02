/**
 * Background reads over plain fetch: a failed read (the rate limiter's 429, a
 * dropped connection) stays local - it never throws into a route error boundary -
 * and a late answer for a scope the merchant has left is ignored.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";

const appFetchJson = vi.fn();
vi.mock("~/utils/app-fetch", () => ({ appFetchJson: (...args: unknown[]) => appFetchJson(...args) }));

import { useSeoKeywordLoad } from "~/hooks/useSeoKeywordLoad";
import { useBackgroundJson } from "~/hooks/useBackgroundJson";

type Deferred = { resolve: (v: unknown) => void; reject: (e: unknown) => void; url: string; signal?: AbortSignal };
let pending: Deferred[] = [];

beforeEach(() => {
  pending = [];
  appFetchJson.mockReset();
  appFetchJson.mockImplementation(
    (url: string, init?: RequestInit) =>
      new Promise((resolve, reject) => {
        pending.push({ resolve, reject, url, signal: init?.signal ?? undefined });
      }),
  );
});

const answer = (ok: boolean, data: unknown, status = ok ? 200 : 429) => ({ response: { ok, status }, data });
const flush = () => act(async () => { await Promise.resolve(); });

describe("useSeoKeywordLoad", () => {
  const setup = (resourceId = "gid://shopify/Product/1", locale = "de") => {
    const onLoaded = vi.fn();
    const onFailed = vi.fn();
    const hook = renderHook(
      (p: { resourceId: string; locale: string }) =>
        useSeoKeywordLoad<{ id: string }>({ resourceId: p.resourceId, resourceType: "product", locale: p.locale, onLoaded, onFailed }),
      { initialProps: { resourceId, locale } },
    );
    return { ...hook, onLoaded, onFailed };
  };

  it("loads over the plain fetch path", async () => {
    const { onLoaded, onFailed } = setup();
    expect(pending[0].url).toBe("/api/seo-keyword?resourceId=gid%3A%2F%2Fshopify%2FProduct%2F1&locale=de");
    pending[0].resolve(answer(true, { keywords: [{ id: "k" }] }));
    await flush();
    expect(onLoaded).toHaveBeenCalledWith([{ id: "k" }]);
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("a 429 stays local: reported as failed, never as an empty list, nothing thrown", async () => {
    const { onLoaded, onFailed } = setup();
    pending[0].resolve(answer(false, { error: "Too many requests, please try again later", retryAfter: 30 }));
    await flush();
    expect(onFailed).toHaveBeenCalledTimes(1);
    expect(onLoaded).not.toHaveBeenCalled();
  });

  it("a rejected request (network, session) is a local failure too", async () => {
    const { onLoaded, onFailed } = setup();
    pending[0].reject(new Error("network"));
    await flush();
    expect(onFailed).toHaveBeenCalledTimes(1);
    expect(onLoaded).not.toHaveBeenCalled();
  });

  it("a 200 without a keywords array is a failure, not 'no keywords'", async () => {
    const { onLoaded, onFailed } = setup();
    pending[0].resolve(answer(true, {}));
    await flush();
    expect(onFailed).toHaveBeenCalledTimes(1);
    expect(onLoaded).not.toHaveBeenCalled();
  });

  it("a late answer for the previous item or locale is ignored, and its request is aborted", async () => {
    const { rerender, onLoaded, onFailed } = setup("gid://shopify/Product/1", "de");
    rerender({ resourceId: "gid://shopify/Product/2", locale: "de" });
    expect(pending[0].signal?.aborted).toBe(true);
    pending[1].resolve(answer(true, { keywords: [{ id: "second" }] }));
    pending[0].resolve(answer(true, { keywords: [{ id: "first" }] })); // late
    await flush();
    expect(onLoaded).toHaveBeenCalledTimes(1);
    expect(onLoaded).toHaveBeenCalledWith([{ id: "second" }]);

    rerender({ resourceId: "gid://shopify/Product/2", locale: "en" });
    pending[1].reject(new Error("late failure")); // the aborted request of product 2 / de
    await flush();
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("retry asks again", async () => {
    const { result } = setup();
    pending[0].resolve(answer(false, {}));
    await flush();
    act(() => result.current.retry());
    expect(pending).toHaveLength(2);
  });
});

describe("useBackgroundJson", () => {
  it("a failure sets `failed` and leaves the data empty; nothing is thrown", async () => {
    const { result } = renderHook(() => useBackgroundJson<{ x: number }>());
    act(() => result.current.load("/api/a"));
    expect(result.current.state).toBe("loading");
    pending[0].resolve(answer(false, { error: "Too many requests" }));
    await flush();
    expect(result.current.state).toBe("idle");
    expect(result.current.failed).toBe(true);
  });

  it("a transport rejection is a local failure", async () => {
    const { result } = renderHook(() => useBackgroundJson<{ x: number }>());
    act(() => result.current.load("/api/a"));
    pending[0].reject(new Error("boom"));
    await flush();
    expect(result.current.failed).toBe(true);
    expect(result.current.data).toBeNull();
  });

  it("latest wins: the earlier request is aborted and its late answer is dropped", async () => {
    const { result } = renderHook(() => useBackgroundJson<{ x: number }>());
    act(() => result.current.load("/api/a"));
    act(() => result.current.load("/api/b"));
    expect(pending[0].signal?.aborted).toBe(true);
    pending[1].resolve(answer(true, { x: 2 }));
    pending[0].resolve(answer(true, { x: 1 }));
    await flush();
    expect(result.current.data).toEqual({ x: 2 });
    expect(result.current.failed).toBe(false);
  });

  it("nothing is set after unmount", async () => {
    const { result, unmount } = renderHook(() => useBackgroundJson<{ x: number }>());
    act(() => result.current.load("/api/a"));
    unmount();
    expect(pending[0].signal?.aborted).toBe(true);
    pending[0].resolve(answer(true, { x: 1 }));
    await Promise.resolve();
  });
});

import { useEditorImageManagement } from "~/hooks/useEditorImageManagement";

describe("useEditorImageManagement on-demand images", () => {
  const item = { id: "gid://shopify/Product/1", images: [] } as any;
  const render = () =>
    renderHook(() =>
      useEditorImageManagement({ config: { contentType: "products" } as any, selectedItemId: item.id, baseSelectedItem: item }),
    );

  it("a 429 ends the spinner and shows no images; it is not retried in a loop", async () => {
    const { result } = render();
    expect(pending).toHaveLength(1);
    expect(pending[0].url).toBe("/api/product-images?productId=gid%3A%2F%2Fshopify%2FProduct%2F1");
    pending[0].resolve(answer(false, { error: "Too many requests" }));
    await flush();
    expect(result.current.isLoadingImages).toBe(false);
    expect(result.current.onDemandImages).toEqual([]);
    expect(pending).toHaveLength(1);
  });

  it("an answer lands as before", async () => {
    const { result } = render();
    pending[0].resolve(answer(true, { success: true, images: [{ url: "https://x/y.png", altText: "a" }] }));
    await flush();
    expect(result.current.onDemandImages).toHaveLength(1);
  });
});
