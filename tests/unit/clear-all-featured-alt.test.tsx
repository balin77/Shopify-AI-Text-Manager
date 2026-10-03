/**
 * "Clear all" in a FOREIGN language on a collection or an article must clear
 * the featured image's alt translation too. Those types load with
 * `images: []` and their one image in `featuredImage`, so walking `images`
 * alone (what the clear did) left that alt translation standing: it stayed on
 * Shopify, in the editor's cache, and came back after the next load.
 *
 * Global layer only: the featured alt is stored and removed globally (no
 * market layer exists for it), so a clear inside a market must NOT send it --
 * that would delete the global translation the market inherits. Products keep
 * their per-image behaviour untouched.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render } from "@testing-library/react";
import { createMemoryRouter, RouterProvider, useFetcher, useLoaderData } from "react-router";

vi.mock("~/contexts/TaskCountContext", () => ({ useTaskCount: () => ({ refresh: vi.fn() }) }));
vi.mock("~/hooks/useBackgroundTaskRefresh", () => ({ useBackgroundTaskRefresh: () => {} }));

import { useUnifiedContentEditor } from "~/hooks/useUnifiedContentEditor";
import { ownSaveRunBackstop } from "~/hooks/useEditorAutoSave";
import { PRODUCTS_CONFIG, COLLECTIONS_CONFIG } from "~/config/content-fields.config";
import { clearAllForResource } from "~/hooks/useAIOperationsStore";

const COLLECTION_ID = "gid://shopify/Collection/1";
const PRODUCT_ID = "gid://shopify/Product/1";
const tick = (ms = 0) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

function mount(kind: "collection" | "product") {
  const id = kind === "collection" ? COLLECTION_ID : PRODUCT_ID;
  const alt = () => ({ url: "https://cdn.shopify.com/a.jpg", altText: "Katze", altTextTranslations: [{ locale: "fr", altText: "Chat", marketId: "" }] });
  const item: any = {
    id, title: "Titel", descriptionHtml: "<p>Text</p>", handle: "titel",
    seo: { title: "SEO", description: "Meta" },
    translations: [{ key: "title", locale: "fr", value: "Titre" }],
    images: kind === "product" ? [alt()] : [],
    // A product with NO images but a featured one must stay untouched.
    featuredImage: kind === "collection" ? alt() : undefined,
    status: "ACTIVE",
  };
  const pending: Array<{ form: Record<string, string>; resolve: (b: any) => void }> = [];
  const posted: Array<Record<string, string>> = [];
  const editor: { current: any } = { current: null };
  const showInfoBox = vi.fn();
  const serve = (form: Record<string, string>) => {
    posted.push(form);
    return new Promise<any>((resolve) => { pending.push({ form, resolve }); });
  };
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any, init?: any) => {
    const url = String(input);
    const json = (body: any) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (url === "/api/content-editor-action" || url === "/api/ai") {
      return json(await serve(Object.fromEntries((init.body as FormData) as any) as Record<string, string>));
    }
    if (url.startsWith("/api/running-field-tasks")) return json({ tasks: [] });
    return realFetch(input, init);
  });
  function Page() {
    const { items } = useLoaderData() as { items: unknown[] };
    const fetcher = useFetcher();
    editor.current = useUnifiedContentEditor({
      config: kind === "collection" ? COLLECTIONS_CONFIG : PRODUCTS_CONFIG, items,
      shopLocales: [
        { locale: "de", primary: true, published: true },
        { locale: "fr", primary: false, published: true },
      ],
      markets: [{ id: "gid://shopify/Market/1", name: "CH" }],
      primaryLocale: "de", fetcher, showInfoBox, t: {}, initialItemId: id,
    } as any);
    return null;
  }
  const router = createMemoryRouter([
    { path: "/api/product-images", loader: async () => ({ success: true, images: [] }) },
    {
      path: "/",
      element: <Page />,
      loader: async () => ({
        items: [{
          ...item,
          translations: item.translations.map((r: any) => ({ ...r })),
          images: item.images.map((i: any) => ({ ...i, altTextTranslations: i.altTextTranslations.map((t: any) => ({ ...t })) })),
          featuredImage: item.featuredImage ? { ...item.featuredImage, altTextTranslations: item.featuredImage.altTextTranslations.map((t: any) => ({ ...t })) } : undefined,
        }],
      }),
      action: async ({ request }) => serve(Object.fromEntries((await request.formData()) as any) as Record<string, string>),
    },
  ]);
  render(<RouterProvider router={router} />);
  const respond = async (action: string, body: any) => {
    const index = pending.findIndex((p) => p.form.action === action);
    if (index < 0) throw new Error(`no pending ${action}`);
    const [entry] = pending.splice(index, 1);
    await act(async () => { entry.resolve(body); });
  };
  const saves = () => posted.filter((p) => p.action === "updateContent");
  return { editor, posted, respond, saves, showInfoBox };
}

const switchTo = async (h: ReturnType<typeof mount>, locale: string) => {
  await act(async () => { await h.editor.current.handlers.handleLanguageChange(locale); });
  await tick(50);
};
const clearAll = async (h: ReturnType<typeof mount>) => {
  await act(async () => { h.editor.current.handlers.handleClearAllForLocaleConfirm(); });
  await tick(20);
};

describe("clear all in a foreign language reaches the featured image alt", () => {
  beforeEach(() => {
    clearAllForResource(COLLECTION_ID);
    clearAllForResource(PRODUCT_ID);
    ownSaveRunBackstop.hits = 0;
    try { window.localStorage.clear(); } catch { /* none */ }
    window.history.replaceState({}, "", "/app/collections");
  });
  afterEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState({}, "", "/");
  });

  it("collection, global layer: the save removes the alt translation and the cache drops it", async () => {
    const h = mount("collection");
    await tick(50);
    await switchTo(h, "fr");
    await clearAll(h);
    expect(h.saves().length).toBe(1);
    expect(JSON.parse(h.saves()[0].imageAltTexts)).toEqual({ 0: "" });
    expect(h.saves()[0].marketId).toBeUndefined();
    expect(h.editor.current.selectedItem.featuredImage.altTextTranslations).toEqual([]);
    expect(h.editor.current.state.imageAltTexts[0]).toBe("");
    // Confirmed: the featured alt stays cleared and nothing is left dirty.
    await h.respond("updateContent", { success: true, actionType: "updateContent" });
    await tick(100);
    expect(h.editor.current.state.imageAltTexts[0]).toBe("");
    expect(h.editor.current.state.hasChanges).toBe(false);
  });

  it("collection, global layer: a removal Shopify did not confirm keeps the alt dirty", async () => {
    const h = mount("collection");
    await tick(50);
    await switchTo(h, "fr");
    await clearAll(h);
    await h.respond("updateContent", { success: true, actionType: "updateContent", failedAltTextIndices: [0] });
    await tick(100);
    expect(h.editor.current.state.hasChanges).toBe(true);
  });

  it("collection inside a market: the global featured alt translation is NOT touched", async () => {
    const h = mount("collection");
    await tick(50);
    await switchTo(h, "fr");
    await act(async () => { await h.editor.current.handlers.handleMarketChange("gid://shopify/Market/1"); });
    await tick(20);
    await clearAll(h);
    expect(h.saves().length).toBe(1);
    expect(h.saves()[0].marketId).toBe("gid://shopify/Market/1");
    expect(h.saves()[0].imageAltTexts).toBeUndefined();
    expect(h.editor.current.selectedItem.featuredImage.altTextTranslations).toEqual([
      { locale: "fr", altText: "Chat", marketId: "" },
    ]);
  });

  it("product: clears the per-image alt translations exactly as before", async () => {
    const h = mount("product");
    await tick(50);
    window.history.replaceState({}, "", "/app/products");
    await switchTo(h, "fr");
    await clearAll(h);
    expect(JSON.parse(h.saves()[0].imageAltTexts)).toEqual({ 0: "" });
    expect(h.editor.current.selectedItem.images[0].altTextTranslations).toEqual([]);
  });

  it("the same-language refusal while a run is out covers the featured alt too", async () => {
    const h = mount("collection");
    await tick(50);
    await switchTo(h, "fr");
    await act(async () => { h.editor.current.handlers.handleTranslateAllForLocale(); });
    await tick(10);
    await act(async () => { h.editor.current.handlers.handleClearAllForLocaleConfirm(); });
    await tick(20);
    expect(h.saves()).toEqual([]);
    expect(h.editor.current.selectedItem.featuredImage.altTextTranslations).toEqual([
      { locale: "fr", altText: "Chat", marketId: "" },
    ]);
  });

  it("a run is refused while the clear (with the featured alt) is out", async () => {
    const h = mount("collection");
    await tick(50);
    await switchTo(h, "fr");
    await clearAll(h);
    expect(h.saves().length).toBe(1);
    await act(async () => { h.editor.current.handlers.handleTranslateAllForLocale(); });
    await tick(10);
    expect(h.posted.filter((p) => p.action === "translateAllForLocale")).toEqual([]);
  });
});
