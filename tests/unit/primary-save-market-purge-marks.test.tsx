/**
 * A PRIMARY save that purges stale foreign translations removes them on
 * Shopify in BOTH layers, but the editor marked only the global one and the
 * loaded item (read-only) still carried the old MARKET override in
 * `marketTranslations`: opening a foreign language with a market selected
 * showed a value Shopify no longer serves, and saving it wrote it back.
 *
 * The market layer of every changed field now stops resolving (a locale mark
 * per market/locale the item holds). It retires once the loaded item reflects
 * the save (so a purge that did not happen -- switch off -- leaves the value
 * on screen), and a market value saved afterwards shows.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render } from "@testing-library/react";
import { createMemoryRouter, RouterProvider, useFetcher, useLoaderData } from "react-router";

vi.mock("~/contexts/TaskCountContext", () => ({ useTaskCount: () => ({ refresh: vi.fn() }) }));
vi.mock("~/hooks/useBackgroundTaskRefresh", () => ({ useBackgroundTaskRefresh: () => {} }));

import { useUnifiedContentEditor } from "~/hooks/useUnifiedContentEditor";
import { PRODUCTS_CONFIG } from "~/config/content-fields.config";
import { clearAllForResource } from "~/hooks/useAIOperationsStore";

const ID = "gid://shopify/Product/1";
const M = "gid://shopify/Market/1";
const tick = (ms = 0) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

function mount() {
  // What the loader serves; the test moves it to model "server caught up".
  const server: any = { title: "Titel", marketRows: true, marketValue: "Titre CH ancien", keepStale: false };
  const pending: Array<{ form: Record<string, string>; resolve: (b: any) => void }> = [];
  const editor: { current: any } = { current: null };
  const showInfoBox = vi.fn();
  const serve = (form: Record<string, string>) => new Promise<any>((resolve) => { pending.push({ form, resolve }); });
  function Page() {
    const { items } = useLoaderData() as { items: unknown[] };
    const fetcher = useFetcher();
    editor.current = useUnifiedContentEditor({
      config: PRODUCTS_CONFIG, items,
      shopLocales: [
        { locale: "de", primary: true, published: true },
        { locale: "fr", primary: false, published: true },
      ],
      markets: [{ id: M, name: "CH" }],
      primaryLocale: "de", fetcher, showInfoBox, t: {}, initialItemId: ID,
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
          id: ID, title: server.title, descriptionHtml: "<p>Text</p>", handle: "titel",
          seo: { title: "SEO", description: "Meta" },
          translations: server.marketRows ? [{ key: "title", locale: "fr", value: "Titre global" }] : [],
          marketTranslations: server.marketRows ? { [M]: { title: { fr: server.marketValue } } } : {},
          images: [], status: "ACTIVE",
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
  return { editor, server, respond, router };
}

const openFrMarket = async (h: ReturnType<typeof mount>) => {
  await act(async () => { await h.editor.current.handlers.handleLanguageChange("fr"); });
  await tick(30);
  await act(async () => { await h.editor.current.handlers.handleMarketChange(M); });
  await tick(30);
};
const saveNewPrimaryTitle = async (h: ReturnType<typeof mount>, answer: Record<string, unknown> = { marketPurgedFields: ["title"] }) => {
  await act(async () => { h.editor.current.handlers.handleValueChange("title", "Neuer Titel"); });
  await act(async () => { h.editor.current.handlers.handleSave(); });
  await tick(20);
  await h.respond("updateContent", { success: true, actionType: "updateContent", ...answer });
  await tick(100);
};
const title = (h: ReturnType<typeof mount>) => h.editor.current.state.editableValues.title;

describe("a primary save's purge also hides the market overrides it removed", () => {
  beforeEach(() => {
    clearAllForResource(ID);
    try { window.localStorage.clear(); } catch { /* none */ }
    window.history.replaceState({}, "", "/app/products");
  });
  afterEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState({}, "", "/");
  });

  it("M1: the server reports the purge -> the old market override does not show before the re-read", async () => {
    const h = mount();
    await tick(50);
    await openFrMarket(h);
    expect(title(h)).toBe("Titre CH ancien");
    await act(async () => { await h.editor.current.handlers.handleLanguageChange("de"); });
    await tick(30);
    h.server.keepStale = true;
    await saveNewPrimaryTitle(h);
    await openFrMarket(h);
    expect(title(h)).not.toBe("Titre CH ancien");
  });

  it("M1: no `marketPurgedFields` (purge off, or an unconfirmed removal) -> the live override stays visible", async () => {
    const h = mount();
    await tick(50);
    h.server.keepStale = true;
    await saveNewPrimaryTitle(h, {});
    await openFrMarket(h);
    expect(title(h)).toBe("Titre CH ancien");
  });

  it("M3: a language or market switch does not bring the hidden override back", async () => {
    const h = mount();
    await tick(50);
    h.server.keepStale = true;
    await saveNewPrimaryTitle(h);
    await openFrMarket(h);
    expect(title(h)).not.toBe("Titre CH ancien");
    await act(async () => { await h.editor.current.handlers.handleMarketChange(""); });
    await tick(20);
    await act(async () => { await h.editor.current.handlers.handleLanguageChange("de"); });
    await tick(30);
    await openFrMarket(h);
    expect(title(h)).not.toBe("Titre CH ancien");
  });

  it("M2: a revalidation that still carries the row keeps the mark; the first re-read without it retires it", async () => {
    const h = mount();
    await tick(50);
    h.server.keepStale = true;
    await saveNewPrimaryTitle(h);
    // A (stale) loader read that began before the answer lands: row still there.
    await act(async () => { await h.router.revalidate(); });
    await tick(50);
    await openFrMarket(h);
    expect(title(h)).not.toBe("Titre CH ancien");
    // The server catches up: the re-read no longer carries the override ...
    h.server.marketRows = false;
    await act(async () => { await h.router.revalidate(); });
    await tick(50);
    // ... and a market value that appears later is shown (the mark is gone).
    h.server.marketRows = true;
    h.server.marketValue = "Titre CH neu";
    await act(async () => { await h.router.revalidate(); });
    await tick(50);
    await act(async () => { await h.editor.current.handlers.handleLanguageChange("de"); });
    await tick(30);
    await openFrMarket(h);
    expect(title(h)).toBe("Titre CH neu");
  });

  it("a market value typed and saved afterwards shows", async () => {
    const h = mount();
    await tick(50);
    h.server.keepStale = true;
    await saveNewPrimaryTitle(h);
    await openFrMarket(h);
    expect(title(h)).not.toBe("Titre CH ancien");
    await act(async () => { h.editor.current.handlers.handleValueChange("title", "Titre CH neu"); });
    await act(async () => { h.editor.current.handlers.handleSave(); });
    await tick(20);
    await h.respond("updateContent", { success: true, actionType: "updateContent" });
    await tick(100);
    expect(title(h)).toBe("Titre CH neu");
  });
});
