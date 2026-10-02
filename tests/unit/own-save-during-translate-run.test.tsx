/**
 * An AI/copy button's OWN save while a "translate all" run of the item writes
 * into its language is refused BEFORE anything is staged (review of
 * 10dfd3f7). Refusing it only inside `safeSubmit` came too late: every caller
 * had already moved a baseline, a cache, an overlay, a mark or the item, so
 * the refused value read as saved, later flows fired on it, and an unsaved alt
 * was translated into every language.
 *
 * Each case drives the real editor through a data router and checks the state
 * after the refusal: nothing posted, nothing staged, the AI's text kept as a
 * plain DRAFT where a result had already arrived -- and the `safeSubmit`
 * backstop never reached.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render } from "@testing-library/react";
import { createMemoryRouter, RouterProvider, useFetcher, useLoaderData } from "react-router";

vi.mock("~/contexts/TaskCountContext", () => ({ useTaskCount: () => ({ refresh: vi.fn() }) }));
vi.mock("~/hooks/useBackgroundTaskRefresh", () => ({ useBackgroundTaskRefresh: () => {} }));

import { useUnifiedContentEditor } from "~/hooks/useUnifiedContentEditor";
import { ownSaveRunBackstop } from "~/hooks/useEditorAutoSave";
import { PRODUCTS_CONFIG } from "~/config/content-fields.config";
import { clearAllForResource } from "~/hooks/useAIOperationsStore";
import { setFieldSuggestion, setAltTextSuggestion, __resetSuggestionStore } from "~/hooks/useAISuggestionStore";

const ID = "gid://shopify/Product/1";
const tick = (ms = 0) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
type Row = { key: string; locale: string; value: string };

function mount() {
  const store: any = {
    id: ID, title: "Titel", descriptionHtml: "<p>Text</p>", handle: "titel",
    seo: { title: "SEO", description: "Meta" },
    translations: [
      { key: "title", locale: "fr", value: "Titre ancien" },
    ] as Row[],
    images: [{ url: "https://cdn.shopify.com/a.jpg", altText: "Katze", altTextTranslations: [{ locale: "fr", altText: "Chat", marketId: "" }] }],
    status: "ACTIVE",
  };
  const pending: Array<{ kind: string; form: Record<string, string>; resolve: (b: any) => void }> = [];
  const posted: Array<Record<string, string>> = [];
  const editor: { current: any } = { current: null };
  const showInfoBox = vi.fn();
  const serve = (kind: string) => async (form: Record<string, string>) => {
    posted.push({ ...form, _kind: kind });
    return new Promise<any>((resolve) => { pending.push({ kind, form, resolve }); });
  };
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any, init?: any) => {
    const url = String(input);
    const json = (body: any) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (url === "/api/content-editor-action" || url === "/api/ai") {
      const form = Object.fromEntries((init.body as FormData) as any) as Record<string, string>;
      return json(await serve(url)(form));
    }
    if (url.startsWith("/api/running-field-tasks")) return json({ tasks: [] });
    return realFetch(input, init);
  });
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
      loader: async () => ({
        items: [{
          ...store,
          translations: store.translations.map((r: Row) => ({ ...r })),
          seo: { ...store.seo },
          images: store.images.map((i: any) => ({ ...i, altTextTranslations: i.altTextTranslations.map((t: any) => ({ ...t })) })),
        }],
      }),
      action: async ({ request }) => serve("route")(Object.fromEntries((await request.formData()) as any) as Record<string, string>),
    },
  ]);
  render(<RouterProvider router={router} />);
  const respond = async (action: string, body: any) => {
    const index = pending.findIndex((p) => p.form.action === action);
    if (index < 0) throw new Error(`no pending ${action} (have: ${pending.map((p) => p.form.action).join(",")})`);
    const [entry] = pending.splice(index, 1);
    await act(async () => { entry.resolve(body); });
  };
  const savesPosted = () => posted.filter((p) => p.action === "updateContent");
  return { editor, posted, pending, respond, showInfoBox, savesPosted };
}

const switchTo = async (h: ReturnType<typeof mount>, locale: string) => {
  await act(async () => { await h.editor.current.handlers.handleLanguageChange(locale); });
  await tick(50);
};
const scope = (locale: string) => ({ resourceId: ID, locale, marketId: "" });

describe("own saves during a translate-all run are refused before anything is staged", () => {
  beforeEach(() => {
    clearAllForResource(ID);
    __resetSuggestionStore();
    ownSaveRunBackstop.hits = 0;
    try { window.localStorage.clear(); } catch { /* none */ }
    window.history.replaceState({}, "", "/app/products");
  });
  afterEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState({}, "", "/");
  });

  it("(1) accepting a suggestion on the primary language: a draft, not a saved value", async () => {
    const h = mount();
    await tick(50);
    await act(async () => { h.editor.current.handlers.handleTranslateAll(); });
    await tick(10);
    setFieldSuggestion(scope("de"), "title", "KI Titel");
    await tick(10);
    await act(async () => { h.editor.current.handlers.handleAcceptSuggestion("title"); });
    await tick(20);
    expect(h.savesPosted()).toEqual([]);
    expect(h.editor.current.state.editableValues.title).toBe("KI Titel");
    expect(h.editor.current.state.hasChanges).toBe(true);
    // Not "saved": away and back, the stored title is what the field shows.
    await switchTo(h, "fr");
    await switchTo(h, "de");
    expect(h.editor.current.state.editableValues.title).toBe("Titel");
    expect(h.showInfoBox).toHaveBeenCalledWith(expect.stringContaining("translation of this item"), "info");
    expect(ownSaveRunBackstop.hits).toBe(0);
  });

  it("(2) primary accept-and-translate: nothing is armed for a later save", async () => {
    const h = mount();
    await tick(50);
    await act(async () => { h.editor.current.handlers.handleTranslateAll(); });
    await tick(10);
    setFieldSuggestion(scope("de"), "title", "KI Titel");
    await tick(10);
    await act(async () => { h.editor.current.handlers.handleAcceptAndTranslate("title"); });
    await tick(20);
    expect(h.savesPosted()).toEqual([]);
    expect(h.editor.current.state.editableValues.title).toBe("KI Titel");
    // The run ends; an unrelated save follows.
    await h.respond("translateAll", { success: true, actionType: "translateAll", failedLocales: [], translations: { fr: { title: "Titre" } } });
    await tick(100);
    await act(async () => { h.editor.current.handlers.handleDiscard(); });
    await act(async () => { h.editor.current.handlers.handleValueChange("seoTitle", "SEO neu"); });
    await act(async () => { h.editor.current.handlers.handleSave(); });
    await tick(20);
    await h.respond("updateContent", { success: true, actionType: "updateContent" });
    await tick(150);
    expect(h.posted.filter((p) => p.action === "translateFieldToAllLocales")).toEqual([]);
    expect(ownSaveRunBackstop.hits).toBe(0);
  });

  it("(3) a single-field translate answered during a run of its language lands as a draft", async () => {
    const h = mount();
    await tick(50);
    await switchTo(h, "fr");
    await act(async () => { h.editor.current.handlers.handleTranslateField("title"); });
    await tick(10);
    await act(async () => { h.editor.current.handlers.handleTranslateAllForLocale(); });
    await tick(10);
    await h.respond("translateField", { success: true, translatedValue: "Titre IA" });
    await tick(50);
    expect(h.savesPosted()).toEqual([]);
    expect(h.editor.current.state.editableValues.title).toBe("Titre IA");
    expect(h.editor.current.state.hasChanges).toBe(true);
    expect(h.showInfoBox).not.toHaveBeenCalledWith(expect.stringContaining("translated and saved"), "success");
    expect(ownSaveRunBackstop.hits).toBe(0);
  });

  it("(3b) a single-field translate is not even requested while a run of its language is out", async () => {
    const h = mount();
    await tick(50);
    await switchTo(h, "fr");
    await act(async () => { h.editor.current.handlers.handleTranslateAllForLocale(); });
    await tick(10);
    await act(async () => { h.editor.current.handlers.handleTranslateField("title"); });
    await tick(10);
    expect(h.posted.filter((p) => p.action === "translateField")).toEqual([]);
    expect(h.showInfoBox).toHaveBeenCalledWith(expect.stringContaining("into this language"), "info");
  });

  it("(6) alt accept-and-translate: nothing saved, nothing translated, the item untouched", async () => {
    const h = mount();
    await tick(50);
    await act(async () => { h.editor.current.handlers.handleTranslateAll(); });
    await tick(10);
    setAltTextSuggestion(scope("de"), 0, "Hund");
    await tick(10);
    await act(async () => { h.editor.current.handlers.handleAcceptAndTranslateAltText(0); });
    await tick(20);
    expect(h.savesPosted()).toEqual([]);
    expect(h.posted.filter((p) => p.action === "translateAltTextToAllLocales")).toEqual([]);
    expect(h.editor.current.selectedItem.images[0].altText).toBe("Katze");
    expect(h.editor.current.state.imageAltTexts[0]).toBe("Hund");
    expect(ownSaveRunBackstop.hits).toBe(0);
  });

  it("(7) generate-all-alt-texts during a run: drafts, foreign alts untouched", async () => {
    const h = mount();
    await tick(50);
    await act(async () => { h.editor.current.handlers.handleGenerateAllAltTexts(); });
    await tick(10);
    await act(async () => { h.editor.current.handlers.handleTranslateAll(); });
    await tick(10);
    await h.respond("generateAllAltTexts", { success: true, generatedAltTexts: { 0: "Neu" } });
    await tick(50);
    expect(h.savesPosted()).toEqual([]);
    expect(h.editor.current.state.imageAltTexts[0]).toBe("Neu");
    expect(h.editor.current.selectedItem.images[0].altTextTranslations).toEqual([{ locale: "fr", altText: "Chat", marketId: "" }]);
    expect(ownSaveRunBackstop.hits).toBe(0);
  });

  it("(7b) accepting an alt suggestion on the primary language: foreign alts and the item untouched", async () => {
    const h = mount();
    await tick(50);
    await act(async () => { h.editor.current.handlers.handleTranslateAll(); });
    await tick(10);
    setAltTextSuggestion(scope("de"), 0, "Hund");
    await tick(10);
    await act(async () => { h.editor.current.handlers.handleAcceptAltTextSuggestion(0); });
    await tick(20);
    expect(h.savesPosted()).toEqual([]);
    expect(h.editor.current.selectedItem.images[0].altTextTranslations).toEqual([{ locale: "fr", altText: "Chat", marketId: "" }]);
    expect(h.editor.current.selectedItem.images[0].altText).toBe("Katze");
    expect(h.editor.current.state.imageAltTexts[0]).toBe("Hund");
    expect(ownSaveRunBackstop.hits).toBe(0);
  });
});
