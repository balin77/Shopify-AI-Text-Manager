/**
 * A "translate all" run is its own request; one that never answers must not
 * hold the saves behind it, or its spinner, for good. Past the deadline the
 * answer is given up: the spinner stops, and a save that waited for the run is
 * NOT sent (the server may still be writing) -- it is a draft again and the
 * merchant is told to save once more. An unmount aborts the run silently.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render } from "@testing-library/react";
import { createMemoryRouter, RouterProvider, useFetcher, useLoaderData } from "react-router";

vi.mock("~/contexts/TaskCountContext", () => ({ useTaskCount: () => ({ refresh: vi.fn() }) }));
vi.mock("~/hooks/useBackgroundTaskRefresh", () => ({ useBackgroundTaskRefresh: () => {} }));
vi.mock("~/hooks/useAIOperationsStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/hooks/useAIOperationsStore")>()),
  TRANSLATE_RUN_DEADLINE_MS: 200,
}));

import { useUnifiedContentEditor } from "~/hooks/useUnifiedContentEditor";
import { PRODUCTS_CONFIG } from "~/config/content-fields.config";
import { clearAllForResource, isOperationActive } from "~/hooks/useAIOperationsStore";

const ID = "gid://shopify/Product/1";
const tick = (ms = 0) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

function mount() {
  const posted: string[] = [];
  const aborted = { count: 0 };
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any, init?: any) => {
    if (String(input) === "/api/content-editor-action") {
      posted.push("run");
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted.count++;
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    }
    if (String(input).startsWith("/api/running-field-tasks")) {
      return new Response(JSON.stringify({ tasks: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return realFetch(input, init);
  });
  const editor: { current: any } = { current: null };
  const showInfoBox = vi.fn();
  const store = {
    id: ID, title: "Titel", descriptionHtml: "<p>Text</p>", handle: "titel",
    seo: { title: "SEO", description: "Meta" },
    translations: [{ key: "title", locale: "fr", value: "Titre" }], images: [], status: "ACTIVE",
  };
  function Page() {
    const { items } = useLoaderData() as { items: unknown[] };
    const fetcher = useFetcher();
    editor.current = useUnifiedContentEditor({
      config: PRODUCTS_CONFIG, items,
      shopLocales: [
        { locale: "de", primary: true, published: true },
        { locale: "fr", primary: false, published: true },
      ],
      primaryLocale: "de", fetcher, showInfoBox, t: {}, initialItemId: ID,
    } as any);
    return null;
  }
  const router = createMemoryRouter([
    { path: "/api/product-images", loader: async () => ({ success: true, images: [] }) },
    {
      path: "/",
      element: <Page />,
      loader: async () => ({ items: [{ ...store }] }),
      action: async ({ request }) => {
        posted.push(String((await request.formData()).get("action")));
        return { success: true, actionType: "updateContent" };
      },
    },
  ]);
  const { unmount } = render(<RouterProvider router={router} />);
  return { editor, showInfoBox, posted, aborted, unmount };
}

describe("translate run deadline", () => {
  beforeEach(() => {
    clearAllForResource(ID);
    try { window.localStorage.clear(); } catch { /* none */ }
    window.history.replaceState({}, "", "/app/products");
  });
  afterEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState({}, "", "/");
  });

  it("gives up on a run that never answers and returns the save behind it to a draft", async () => {
    const { editor, showInfoBox, posted } = mount();
    await tick(50);
    await act(async () => { await editor.current.handlers.handleLanguageChange("fr"); });
    await tick(50);
    await act(async () => { editor.current.handlers.handleTranslateAllForLocale(); });
    await act(async () => { editor.current.handlers.handleValueChange("title", "Titre à la main"); });
    await act(async () => { editor.current.handlers.handleSave(); });
    await tick(20);
    expect(posted).toEqual(["run"]);
    expect(isOperationActive(ID, "__translateAllForLocale__fr")).toBe(true);
    expect(editor.current.state.isSavingCurrentItem).toBe(true);

    await tick(400);
    expect(isOperationActive(ID, "__translateAllForLocale__fr")).toBe(false);
    // The server may still be writing: the held save is NOT sent. It is a
    // draft again -- still changed, not saving -- and the merchant is told.
    expect(showInfoBox).toHaveBeenCalledWith(expect.stringContaining("save again in a moment"), "warning");
    expect(posted).toEqual(["run"]);
    expect(editor.current.state.isSavingCurrentItem).toBe(false);
    expect(editor.current.state.hasChanges).toBe(true);
    expect(editor.current.state.editableValues.title).toBe("Titre à la main");
    // Saving again goes out now.
    await act(async () => { editor.current.handlers.handleSave(); });
    await tick(50);
    expect(posted).toEqual(["run", "updateContent"]);
  });

  it("an unmount aborts the run's request and says nothing afterwards", async () => {
    const { editor, showInfoBox, posted, aborted, unmount } = mount();
    await tick(50);
    await act(async () => { await editor.current.handlers.handleLanguageChange("fr"); });
    await tick(50);
    await act(async () => { editor.current.handlers.handleTranslateAllForLocale(); });
    await tick(20);
    expect(posted).toEqual(["run"]);
    showInfoBox.mockClear();
    unmount();
    await tick(400);
    expect(aborted.count).toBe(1);
    expect(showInfoBox).not.toHaveBeenCalled();
    expect(isOperationActive(ID, "__translateAllForLocale__fr")).toBe(false);
  });
});
