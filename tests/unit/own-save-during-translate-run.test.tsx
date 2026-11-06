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
import { useState } from "react";
import { createMemoryRouter, RouterProvider, useFetcher, useLoaderData } from "react-router";

vi.mock("~/contexts/TaskCountContext", () => ({ useTaskCount: () => ({ refresh: vi.fn() }) }));
vi.mock("~/hooks/useBackgroundTaskRefresh", () => ({ useBackgroundTaskRefresh: () => {} }));
// Short deadline so the "no answer" case can be driven; every other case answers well within it.
vi.mock("~/services/editor/foreign-step1.shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/services/editor/foreign-step1.shared")>()),
  FOREIGN_STEP1_DEADLINE_MS: 600,
}));

import { useUnifiedContentEditor } from "~/hooks/useUnifiedContentEditor";
import { ownSaveRunBackstop } from "~/hooks/useEditorAutoSave";
import { PRODUCTS_CONFIG } from "~/config/content-fields.config";
import { clearAllForResource } from "~/hooks/useAIOperationsStore";
import { setFieldSuggestion, setAltTextSuggestion, __resetSuggestionStore } from "~/hooks/useAISuggestionStore";

const ID = "gid://shopify/Product/1";
const ID2 = "gid://shopify/Product/2";
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
  const initialId = { current: ID };
  const bump: { current: () => void } = { current: () => {} };
  function Page() {
    const { items } = useLoaderData() as { items: unknown[] };
    const [, setTick] = useState(0);
    bump.current = () => setTick((n) => n + 1);
    const fetcher = useFetcher();
    editor.current = useUnifiedContentEditor({
      config: PRODUCTS_CONFIG, items,
      shopLocales: [
        { locale: "de", primary: true, published: true },
        { locale: "fr", primary: false, published: true },
        { locale: "es", primary: false, published: true },
      ],
      primaryLocale: "de", fetcher, showInfoBox, t: {}, initialItemId: initialId.current,
    } as any);
    return null;
  }
  const router = createMemoryRouter([
    { path: "/api/product-images", loader: async () => ({ success: true, images: [] }) },
    {
      path: "/",
      element: <Page />,
      loader: async () => ({
        items: [{ ...store, id: ID2, title: "Zweites Produkt", handle: "zweites", translations: [], images: [], seo: { title: "S2", description: "M2" } }, {
          ...store,
          translations: store.translations.map((r: Row) => ({ ...r })),
          seo: { ...store.seo },
          images: store.images.map((i: any) => ({ ...i, altTextTranslations: i.altTextTranslations.map((t: any) => ({ ...t })) })),
        }],
      }),
      action: async ({ request }) => serve("route")(Object.fromEntries((await request.formData()) as any) as Record<string, string>),
    },
  ]);
  const rendered = render(<RouterProvider router={router} />);
  const respond = async (action: string, body: any) => {
    const index = pending.findIndex((p) => p.form.action === action);
    if (index < 0) throw new Error(`no pending ${action} (have: ${pending.map((p) => p.form.action).join(",")})`);
    const [entry] = pending.splice(index, 1);
    await act(async () => { entry.resolve(body); });
  };
  const savesPosted = () => posted.filter((p) => p.action === "updateContent");
  const unmount = () => rendered.unmount();
  const selectItemFromOutside = async (id: string) => { initialId.current = id; await act(async () => { bump.current(); }); };
  return { editor, posted, pending, respond, showInfoBox, savesPosted, unmount, selectItemFromOutside };
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

  it("(F1) a primary save held behind a run blocks an own save in a THIRD language up front", async () => {
    const h = mount();
    await tick(50);
    await switchTo(h, "fr");
    await act(async () => { h.editor.current.handlers.handleTranslateAllForLocale(); });
    await tick(10);
    await switchTo(h, "de");
    await act(async () => { h.editor.current.handlers.handleValueChange("title", "Neuer Titel"); });
    await act(async () => { h.editor.current.handlers.handleSave(); });
    await tick(20);
    expect(h.savesPosted()).toEqual([]);
    await switchTo(h, "es");
    h.showInfoBox.mockClear();
    await act(async () => { h.editor.current.handlers.handleTranslateField("title"); });
    await tick(20);
    expect(h.posted.filter((p) => p.action === "translateField")).toEqual([]);
    expect(h.showInfoBox).toHaveBeenCalledTimes(1);
    expect(h.showInfoBox).toHaveBeenCalledWith(expect.stringContaining("waiting for a translation"), "info");
    expect(h.editor.current.state.hasChanges).toBe(false);
    expect(ownSaveRunBackstop.hits).toBe(0);
  });

  it("(F2) copy / translate to every language is refused during any run of the item", async () => {
    const h = mount();
    await tick(50);
    await switchTo(h, "fr");
    await act(async () => { h.editor.current.handlers.handleTranslateAllForLocale(); });
    await tick(10);
    await switchTo(h, "de");
    await act(async () => { h.editor.current.handlers.handleCopyFieldToAllLocales("title"); });
    await act(async () => { h.editor.current.handlers.handleTranslateFieldToAllLocales("title"); });
    await act(async () => { h.editor.current.handlers.handleCopyAltTextToAllLocales(0); });
    await act(async () => { h.editor.current.handlers.handleTranslateAltTextToAllLocales(0); });
    await tick(20);
    // Only the run itself (its field and alt-text halves) went out.
    expect(h.posted.map((p) => p.action)).toEqual(["translateAllForLocale", "translateAllAltTextsForLocale"]);
    expect(h.showInfoBox).toHaveBeenCalledWith(expect.stringContaining("try again"), "info");
    expect(ownSaveRunBackstop.hits).toBe(0);
  });

  it("(F2) a run is refused while a copy to every language is out", async () => {
    const h = mount();
    await tick(50);
    await act(async () => { h.editor.current.handlers.handleCopyFieldToAllLocales("title"); });
    await tick(20);
    expect(h.posted.filter((p) => p.action === "updateContent").length).toBeGreaterThan(0);
    h.showInfoBox.mockClear();
    await act(async () => { expect(h.editor.current.handlers.handleTranslateAll()).toBe(false); });
    await tick(10);
    expect(h.posted.filter((p) => p.action === "translateAll")).toEqual([]);
    expect(h.showInfoBox).toHaveBeenCalledWith(expect.stringContaining("translate again"), "info");
  });
  it("(F3) primary alt accept-and-translate: step 2 is a request a run must not race, from queued to answered", async () => {
    const h = mount();
    await tick(50);
    setAltTextSuggestion(scope("de"), 0, "Hund");
    await tick(10);
    await act(async () => { h.editor.current.handlers.handleAcceptAndTranslateAltText(0); });
    await tick(20);
    // Step 1 (the primary alt save) is out and step 2 waits behind it in the queue.
    expect(h.savesPosted().length).toBe(1);
    expect(h.posted.filter((p) => p.action === "translateAltTextToAllLocales")).toEqual([]);
    h.showInfoBox.mockClear();
    await act(async () => { expect(h.editor.current.handlers.handleTranslateAll()).toBe(false); });
    expect(h.showInfoBox).toHaveBeenCalledWith(expect.stringContaining("translate again"), "info");
    await h.respond("updateContent", { success: true, actionType: "updateContent" });
    await tick(100);
    // Step 2 is now the request in flight: still refused.
    expect(h.posted.filter((p) => p.action === "translateAltTextToAllLocales").length).toBe(1);
    h.showInfoBox.mockClear();
    await act(async () => { expect(h.editor.current.handlers.handleTranslateAll()).toBe(false); });
    await act(async () => { h.editor.current.handlers.handleTranslateAllForLocale(); });
    expect(h.posted.filter((p) => p.action === "translateAll" || p.action === "translateAllForLocale")).toEqual([]);
    expect(h.showInfoBox).toHaveBeenCalledWith(expect.stringContaining("translate again"), "info");
    // Answered (a FAILED answer ends it the same way: nothing is flagged).
    await h.respond("translateAltTextToAllLocales", { success: false, error: "boom" });
    await tick(100);
    await act(async () => { h.editor.current.handlers.handleTranslateAll(); });
    await tick(20);
    expect(h.posted.filter((p) => p.action === "translateAll").length).toBe(1);
    expect(ownSaveRunBackstop.hits).toBe(0);
  });

  it("(F3b) step 2 of the primary alt accept-and-translate is not started while a run is out", async () => {
    const h = mount();
    await tick(50);
    await act(async () => { h.editor.current.handlers.handleTranslateAll(); });
    await tick(10);
    setAltTextSuggestion(scope("de"), 0, "Hund");
    await tick(10);
    await act(async () => { h.editor.current.handlers.handleAcceptAndTranslateAltText(0); });
    await tick(20);
    expect(h.posted.filter((p) => p.action === "translateAltTextToAllLocales" || p.action === "updateContent")).toEqual([]);
  });
  it("(F4) the automatic product-type translation says so when the busy rule blocks it", async () => {
    const h = mount();
    await tick(50);
    await act(async () => { h.editor.current.handlers.handleTranslateAll(); });
    await tick(10);
    h.showInfoBox.mockClear();
    await act(async () => { h.editor.current.handlers.handleTranslateFieldToAllLocales("productType", { auto: true }); });
    await tick(10);
    expect(h.posted.filter((p) => p.action === "translateFieldToAllLocales")).toEqual([]);
    expect(h.showInfoBox).toHaveBeenCalledTimes(1);
    expect(h.showInfoBox).toHaveBeenCalledWith(expect.stringContaining("product type was not translated"), "info");
  });
  it("(F5) primary accept-and-translate with step 2 skipped still tells the merchant what the save's answer said", async () => {
    const h = mount();
    await tick(50);
    setFieldSuggestion(scope("de"), "title", "KI Titel");
    await tick(10);
    await act(async () => { h.editor.current.handlers.handleAcceptAndTranslate("title"); });
    await tick(20);
    expect(h.savesPosted().length).toBe(1);
    // A primary save of the item queued behind it blocks step 2 (its purge
    // must not land after the translations).
    await act(async () => { h.editor.current.handlers.handleValueChange("seoTitle", "SEO neu"); });
    await act(async () => { h.editor.current.handlers.handleSave(); });
    await tick(20);
    h.showInfoBox.mockClear();
    await h.respond("updateContent", { success: true, actionType: "updateContent", warnings: ["translationPurgeUnconfirmed"] });
    await tick(100);
    expect(h.posted.filter((p) => p.action === "translateFieldToAllLocales")).toEqual([]);
    const call = h.showInfoBox.mock.calls.find(([text]) => String(text).includes("was skipped"));
    expect(call).toBeTruthy();
    expect(String(call![0])).toContain("could not be removed on Shopify");
    expect(call![1]).toBe("warning");
  });
  it("(F4b) the product-type notice is appended to the message shown just before it, never replacing it", async () => {
    const h = mount();
    await tick(50);
    await act(async () => { h.editor.current.handlers.handleTranslateAll(); });
    await tick(10);
    h.showInfoBox.mockClear();
    // A message of the save/answer, then the skipped automatic step.
    await act(async () => { h.editor.current.handlers.handleTranslateField("title"); });
    await act(async () => { h.editor.current.handlers.handleTranslateFieldToAllLocales("productType", { auto: true }); });
    const last = h.showInfoBox.mock.calls[h.showInfoBox.mock.calls.length - 1];
    expect(String(last[0])).toContain("translation of this item is still running");
    expect(String(last[0])).toContain("product type was not translated");
  });
});

describe("foreign accept-and-translate: the primary base save carries only the translated field", () => {
  beforeEach(() => {
    clearAllForResource(ID);
    __resetSuggestionStore();
    try { window.localStorage.clear(); } catch { /* none */ }
    window.history.replaceState({}, "", "/app/products");
  });
  afterEach(() => { vi.restoreAllMocks(); window.history.replaceState({}, "", "/"); });

  it("no title (read from a click-time item) rides along, so a stale one cannot be written unannounced", async () => {
    const h = mount();
    await tick(50);
    await switchTo(h, "fr");
    setFieldSuggestion(scope("fr"), "seoTitle", "SEO fr");
    await tick(10);
    await act(async () => { h.editor.current.handlers.handleAcceptAndTranslate("seoTitle"); });
    await tick(20);
    await h.respond("updateContent", { success: true, actionType: "updateContent" });
    await tick(20);
    await h.respond("translateFieldToAllLocales", { success: true, actionType: "translateFieldToAllLocales", translations: { de: "SEO de", es: "SEO es" } });
    await tick(50);
    const primary = h.savesPosted().find((p) => p.locale === "de");
    expect(primary).toBeTruthy();
    expect(primary!.seoTitle).toBe("SEO de");
    expect("title" in primary!).toBe(false);
  });
});

describe("a REFUSED accept-and-translate save takes back everything the flow armed", () => {
  beforeEach(() => {
    clearAllForResource(ID);
    __resetSuggestionStore();
    try { window.localStorage.clear(); } catch { /* none */ }
    window.history.replaceState({}, "", "/app/products");
  });
  afterEach(() => { vi.restoreAllMocks(); window.history.replaceState({}, "", "/"); });

  it("(M1) primary step 1 refused: the NEXT successful save does not fire step 2 with the old suggestion", async () => {
    const h = mount();
    await tick(50);
    setFieldSuggestion(scope("de"), "title", "KI Titel");
    await tick(10);
    await act(async () => { h.editor.current.handlers.handleAcceptAndTranslate("title"); });
    await tick(20);
    expect(h.savesPosted()).toHaveLength(1);
    await h.respond("updateContent", { success: false, actionType: "updateContent", error: "Shopify refused" });
    await tick(50);

    // An ordinary Save of another field, answered with success.
    await act(async () => { h.editor.current.handlers.handleValueChange("seoTitle", "SEO neu"); });
    await act(async () => { h.editor.current.handlers.handleSave(); });
    await tick(20);
    await h.respond("updateContent", { success: true, actionType: "updateContent" });
    await tick(100);
    expect(h.posted.filter((p) => p.action === "translateFieldToAllLocales")).toEqual([]);
  });

  it("(H2) foreign step 2 refused (other SEO half unreadable): the main-language overlay is given back and the message does not say 'nothing saved'", async () => {
    const h = mount();
    await tick(50);
    await switchTo(h, "fr");
    setFieldSuggestion(scope("fr"), "seoTitle", "SEO fr");
    await tick(10);
    await act(async () => { h.editor.current.handlers.handleAcceptAndTranslate("seoTitle"); });
    await tick(20);
    await h.respond("updateContent", { success: true, actionType: "updateContent" });
    await tick(20);
    await h.respond("translateFieldToAllLocales", { success: true, actionType: "translateFieldToAllLocales", translations: { de: "SEO de", es: "SEO es" } });
    await tick(50);
    expect(h.savesPosted().some((p) => p.locale === "de" && p.seoTitle === "SEO de")).toBe(true);
    h.showInfoBox.mockClear();
    await h.respond("updateContent", { success: false, actionType: "updateContent", error: "seoOtherHalfUnreadable", errorKey: "seoOtherHalfUnreadable" });
    await tick(50);

    const critical = h.showInfoBox.mock.calls.filter(([, tone]) => tone === "critical").map(([m]) => String(m));
    expect(critical).toHaveLength(1);
    // The specific sentence: this language WAS saved, the main-language translation was not.
    expect(critical[0]).toContain("The text in this language was saved, but the translation into the main language was not");
    // The main language shows what is stored, never the refused translation.
    await switchTo(h, "de");
    expect(h.editor.current.state.editableValues.seoTitle).toBe("SEO");
  });

  it("(M1') an EARLIER save answering success before step 2 does not drop step 2's rollback", async () => {
    const h = mount();
    await tick(50);
    await switchTo(h, "fr");
    setFieldSuggestion(scope("fr"), "seoTitle", "SEO fr");
    await tick(10);
    await act(async () => { h.editor.current.handlers.handleAcceptAndTranslate("seoTitle"); });
    await tick(20);
    await h.respond("updateContent", { success: true, actionType: "updateContent" });
    await tick(20);
    // While the AI works, an ordinary Save-bar save of another field goes out (ahead of step 2).
    await act(async () => { h.editor.current.handlers.handleValueChange("title", "Titre neuf"); });
    await act(async () => { h.editor.current.handlers.handleSave(); });
    await tick(20);
    await h.respond("translateFieldToAllLocales", { success: true, actionType: "translateFieldToAllLocales", translations: { de: "SEO de", es: "SEO es" } });
    await tick(50);
    // The earlier save answers FIRST, successfully.
    await h.respond("updateContent", { success: true, actionType: "updateContent" });
    await tick(50);
    // Then step 2 is refused.
    await h.respond("updateContent", { success: false, actionType: "updateContent", error: "seoOtherHalfUnreadable", errorKey: "seoOtherHalfUnreadable" });
    await tick(50);
    await switchTo(h, "de");
    expect(h.editor.current.state.editableValues.seoTitle).toBe("SEO");
  });

  it("(M2) a refused EARLIER save of the same item does not drop the queued accept-and-translate follow-up", async () => {
    const h = mount();
    await tick(50);
    await act(async () => { h.editor.current.handlers.handleValueChange("seoTitle", "SEO neu"); });
    await act(async () => { h.editor.current.handlers.handleSave(); });
    await tick(20);
    setFieldSuggestion(scope("de"), "title", "KI Titel");
    await tick(10);
    await act(async () => { h.editor.current.handlers.handleAcceptAndTranslate("title"); });
    await tick(20);
    expect(h.savesPosted().length).toBeGreaterThanOrEqual(1);
    // The Save-bar save is refused; step 1 (queued behind it) then succeeds.
    await h.respond("updateContent", { success: false, actionType: "updateContent", error: "Shopify refused" });
    await tick(50);
    await h.respond("updateContent", { success: true, actionType: "updateContent" });
    await tick(100);
    expect(h.posted.filter((p) => p.action === "translateFieldToAllLocales")).toHaveLength(1);
  });

  it("(Low) EVERY refusal of foreign step 2 says the foreign text was saved, not only the SEO one", async () => {
    const h = mount();
    await tick(50);
    await switchTo(h, "fr");
    setFieldSuggestion(scope("fr"), "seoTitle", "SEO fr");
    await tick(10);
    await act(async () => { h.editor.current.handlers.handleAcceptAndTranslate("seoTitle"); });
    await tick(20);
    await h.respond("updateContent", { success: true, actionType: "updateContent" });
    await tick(20);
    await h.respond("translateFieldToAllLocales", { success: true, actionType: "translateFieldToAllLocales", translations: { de: "SEO de", es: "SEO es" } });
    await tick(50);
    h.showInfoBox.mockClear();
    await h.respond("updateContent", { success: false, actionType: "updateContent", error: "Shopify refused" });
    await tick(50);
    const critical = h.showInfoBox.mock.calls.filter(([, tone]) => tone === "critical").map(([m]) => String(m));
    expect(critical).toEqual(["The text in this language was saved, but the translation into the main language was not. Shopify refused"]);
  });

  it("(M1b) an earlier save answering success does not consume the queued primary step 2: step 1 success gives exactly one translate", async () => {
    const h = mount();
    await tick(50);
    await act(async () => { h.editor.current.handlers.handleValueChange("seoTitle", "SEO neu"); });
    await act(async () => { h.editor.current.handlers.handleSave(); });
    await tick(20);
    setFieldSuggestion(scope("de"), "title", "KI Titel");
    await tick(10);
    await act(async () => { h.editor.current.handlers.handleAcceptAndTranslate("title"); });
    await tick(20);
    await h.respond("updateContent", { success: true, actionType: "updateContent" });
    await tick(60);
    expect(h.posted.filter((p) => p.action === "translateFieldToAllLocales")).toEqual([]);
    await h.respond("updateContent", { success: true, actionType: "updateContent" });
    await tick(100);
    expect(h.posted.filter((p) => p.action === "translateFieldToAllLocales")).toHaveLength(1);
  });

  it("(M1c) earlier save success, then step 1 REFUSED: no translation and no skipped message for it", async () => {
    const h = mount();
    await tick(50);
    await act(async () => { h.editor.current.handlers.handleValueChange("seoTitle", "SEO neu"); });
    await act(async () => { h.editor.current.handlers.handleSave(); });
    await tick(20);
    setFieldSuggestion(scope("de"), "title", "KI Titel");
    await tick(10);
    await act(async () => { h.editor.current.handlers.handleAcceptAndTranslate("title"); });
    await tick(20);
    await h.respond("updateContent", { success: true, actionType: "updateContent" });
    await tick(60);
    h.showInfoBox.mockClear();
    await h.respond("updateContent", { success: false, actionType: "updateContent", error: "Shopify refused" });
    await tick(100);
    expect(h.posted.filter((p) => p.action === "translateFieldToAllLocales")).toEqual([]);
    const texts = h.showInfoBox.mock.calls.map(([m]) => String(m));
    expect(texts.some((m) => m.includes("was skipped"))).toBe(false);
    expect(texts).toContain("Shopify refused");
  });

  it("(M2) foreign step 2 in flight counts as an own save: a language switch is REFUSED until it answers", async () => {
    const h = mount();
    await tick(50);
    await switchTo(h, "fr");
    setFieldSuggestion(scope("fr"), "seoTitle", "SEO fr");
    await tick(10);
    await act(async () => { h.editor.current.handlers.handleAcceptAndTranslate("seoTitle"); });
    await tick(20);
    await h.respond("updateContent", { success: true, actionType: "updateContent" });
    await tick(20);
    await h.respond("translateFieldToAllLocales", { success: true, actionType: "translateFieldToAllLocales", translations: { de: "SEO de", es: "SEO es" } });
    await tick(50);
    expect(h.savesPosted().some((p) => p.locale === "de")).toBe(true);
    h.showInfoBox.mockClear();
    await act(async () => { await h.editor.current.handlers.handleLanguageChange("es"); });
    expect(h.showInfoBox).toHaveBeenCalledWith(expect.stringContaining("Still saving"), "info");
    expect(h.editor.current.state.currentLanguage).toBe("fr");
  });

  it("(L4) step 1 REFUSED: the translation into the other languages is never requested and the message says nothing was translated", async () => {
    const h = mount();
    await tick(50);
    await switchTo(h, "fr");
    setFieldSuggestion(scope("fr"), "seoTitle", "SEO fr");
    await tick(10);
    await act(async () => { h.editor.current.handlers.handleAcceptAndTranslate("seoTitle"); });
    await tick(20);
    // Nothing is translated while step 1 is out.
    expect(h.posted.filter((p) => p.action === "translateFieldToAllLocales")).toEqual([]);
    h.showInfoBox.mockClear();
    await h.respond("updateContent", { success: false, actionType: "updateContent", error: "Shopify refused" });
    await tick(60);
    expect(h.posted.filter((p) => p.action === "translateFieldToAllLocales")).toEqual([]);
    expect(h.savesPosted().filter((p) => p.locale === "de")).toHaveLength(0);
    const critical = h.showInfoBox.mock.calls.filter(([, tone]) => tone === "critical").map(([m]) => String(m));
    expect(critical).toHaveLength(1);
    expect(critical[0]).toContain("Shopify refused");
    expect(critical[0]).toContain("Nothing was translated");
  });

  it("(S1) step 1 answers but Shopify did not echo the field: nothing is translated, a warning says so", async () => {
    const h = mount();
    await tick(50);
    await switchTo(h, "fr");
    setFieldSuggestion(scope("fr"), "seoTitle", "SEO fr");
    await tick(10);
    await act(async () => { h.editor.current.handlers.handleAcceptAndTranslate("seoTitle"); });
    await tick(20);
    h.showInfoBox.mockClear();
    await h.respond("updateContent", { success: true, actionType: "updateContent", unconfirmedFields: ["seoTitle"] });
    await tick(60);
    expect(h.posted.filter((p) => p.action === "translateFieldToAllLocales")).toEqual([]);
    expect(h.savesPosted().filter((p) => p.locale === "de")).toHaveLength(0);
    expect(h.showInfoBox).toHaveBeenCalledWith(expect.stringContaining("Nothing was translated"), "warning");
  });

  it("(S2) step 1 CONFIRMED: only now is the translation requested", async () => {
    const h = mount();
    await tick(50);
    await switchTo(h, "fr");
    setFieldSuggestion(scope("fr"), "seoTitle", "SEO fr");
    await tick(10);
    await act(async () => { h.editor.current.handlers.handleAcceptAndTranslate("seoTitle"); });
    await tick(20);
    expect(h.posted.filter((p) => p.action === "translateFieldToAllLocales")).toEqual([]);
    await h.respond("updateContent", { success: true, actionType: "updateContent" });
    await tick(30);
    expect(h.posted.filter((p) => p.action === "translateFieldToAllLocales")).toHaveLength(1);
  });

  it("(S4) the editor unmounts while step 1 is out: the deadline never shows a box afterwards", async () => {
    const h = mount();
    await tick(50);
    await switchTo(h, "fr");
    setFieldSuggestion(scope("fr"), "seoTitle", "SEO fr");
    await tick(10);
    await act(async () => { h.editor.current.handlers.handleAcceptAndTranslate("seoTitle"); });
    await tick(20);
    h.showInfoBox.mockClear();
    h.unmount();
    await new Promise((r) => setTimeout(r, 750));
    expect(h.showInfoBox.mock.calls.some(([m]) => String(m).includes("Nothing was translated"))).toBe(false);
  });

  it("(S5) step 1 answered after the merchant's item changed (abandoned save): the waiting translation stands down, no false box at the deadline", async () => {
    const h = mount();
    await tick(50);
    await switchTo(h, "fr");
    setFieldSuggestion(scope("fr"), "seoTitle", "SEO fr");
    await tick(10);
    await act(async () => { h.editor.current.handlers.handleAcceptAndTranslate("seoTitle"); });
    await tick(20);
    await h.selectItemFromOutside(ID2);
    await tick(30);
    expect(h.editor.current.state.selectedItemId ?? h.editor.current.state.selectedItem?.id).toBe(ID2);
    // and back on the original item, where a deadline box would otherwise be shown
    await h.selectItemFromOutside(ID);
    await tick(30);
    h.showInfoBox.mockClear();
    await h.respond("updateContent", { success: true, actionType: "updateContent" });
    await tick(60);
    expect(h.posted.filter((p) => p.action === "translateFieldToAllLocales")).toEqual([]);
    await tick(700);
    expect(h.showInfoBox.mock.calls.some(([m]) => String(m).includes("Nothing was translated"))).toBe(false);
  });

  it("(S3) step 1 never answers: past the deadline nothing is translated, and a late answer starts nothing", async () => {
    const h = mount();
    await tick(50);
    await switchTo(h, "fr");
    setFieldSuggestion(scope("fr"), "seoTitle", "SEO fr");
    await tick(10);
    await act(async () => { h.editor.current.handlers.handleAcceptAndTranslate("seoTitle"); });
    await tick(20);
    h.showInfoBox.mockClear();
    await tick(700);
    expect(h.showInfoBox).toHaveBeenCalledWith(expect.stringContaining("no answer arrived in time"), "warning");
    await h.respond("updateContent", { success: true, actionType: "updateContent" });
    await tick(60);
    expect(h.posted.filter((p) => p.action === "translateFieldToAllLocales")).toEqual([]);
  });

  it("(L3) a refusal of step 2 that names neither error nor key is worded too", async () => {
    const h = mount();
    await tick(50);
    await switchTo(h, "fr");
    setFieldSuggestion(scope("fr"), "seoTitle", "SEO fr");
    await tick(10);
    await act(async () => { h.editor.current.handlers.handleAcceptAndTranslate("seoTitle"); });
    await tick(20);
    await h.respond("updateContent", { success: true, actionType: "updateContent" });
    await tick(20);
    await h.respond("translateFieldToAllLocales", { success: true, actionType: "translateFieldToAllLocales", translations: { de: "SEO de", es: "SEO es" } });
    await tick(50);
    h.showInfoBox.mockClear();
    await h.respond("updateContent", { success: false, actionType: "updateContent" });
    await tick(50);
    const critical = h.showInfoBox.mock.calls.filter(([, tone]) => tone === "critical").map(([m]) => String(m));
    expect(critical).toHaveLength(1);
    expect(critical[0]).toContain("The text in this language was saved, but the translation into the main language was not.");
  });

  it("(M1x) two OVERLAPPING foreign flows of different fields keep their own records: the first one's step-2 refusal still rolls back its overlay", async () => {
    const h = mount();
    await tick(50);
    await switchTo(h, "fr");
    // Flow A: seoTitle
    setFieldSuggestion(scope("fr"), "seoTitle", "SEO fr");
    await tick(10);
    await act(async () => { h.editor.current.handlers.handleAcceptAndTranslate("seoTitle"); });
    await tick(20);
    await h.respond("updateContent", { success: true, actionType: "updateContent" });
    await tick(20);
    // Flow B: metaDescription starts while A's translation is still out
    setFieldSuggestion(scope("fr"), "metaDescription", "Meta fr");
    await tick(10);
    await act(async () => { h.editor.current.handlers.handleAcceptAndTranslate("metaDescription"); });
    await tick(20);
    await h.respond("updateContent", { success: true, actionType: "updateContent" });
    await tick(20);
    // Both translations answer, then each primary save is posted.
    await h.respond("translateFieldToAllLocales", { success: true, actionType: "translateFieldToAllLocales", translations: { de: "SEO de", es: "SEO es" } });
    await tick(50);
    await h.respond("translateFieldToAllLocales", { success: true, actionType: "translateFieldToAllLocales", translations: { de: "Meta de", es: "Meta es" } });
    await tick(50);
    // Flow A's step 2 is refused, flow B's one succeeds.
    await h.respond("updateContent", { success: false, actionType: "updateContent", error: "seoOtherHalfUnreadable", errorKey: "seoOtherHalfUnreadable" });
    await tick(50);
    await h.respond("updateContent", { success: true, actionType: "updateContent" });
    await tick(50);
    await switchTo(h, "de");
    expect(h.editor.current.state.editableValues.seoTitle).toBe("SEO");
  });

  it("(M2y) foreign step 1 refused: the translation never starts, so step 2 is never sent", async () => {
    const h = mount();
    await tick(50);
    await switchTo(h, "fr");
    setFieldSuggestion(scope("fr"), "seoTitle", "SEO fr");
    await tick(10);
    await act(async () => { h.editor.current.handlers.handleAcceptAndTranslate("seoTitle"); });
    await tick(20);
    await h.respond("updateContent", { success: false, actionType: "updateContent", error: "Shopify refused" });
    await tick(60);
    expect(h.posted.filter((p) => p.action === "translateFieldToAllLocales")).toEqual([]);
    expect(h.savesPosted().filter((p) => p.locale === "de")).toHaveLength(0);
  });

  it("(MED) an earlier primary save S refused before step 2 is refused: step 2 gives back nothing it no longer owns, the main language shows the stored text", async () => {
    const h = mount();
    await tick(50);
    // An earlier, CONFIRMED main-language save keeps another field in the overlay (so the item's overlay object survives).
    await act(async () => { h.editor.current.handlers.handleValueChange("metaDescription", "Meta neu"); });
    await act(async () => { h.editor.current.handlers.handleSave(); });
    await tick(20);
    await h.respond("updateContent", { success: true, actionType: "updateContent" });
    await tick(60);
    // S: an ordinary Save-bar save of the main language, still out.
    await act(async () => { h.editor.current.handlers.handleValueChange("seoTitle", "X draft"); });
    await act(async () => { h.editor.current.handlers.handleSave(); });
    await tick(20);
    await switchTo(h, "fr");
    setFieldSuggestion(scope("fr"), "seoTitle", "SEO fr");
    await tick(10);
    await act(async () => { h.editor.current.handlers.handleAcceptAndTranslate("seoTitle"); });
    await tick(20);
    // S is refused, step 1 succeeds, only then the translation is requested and answers, step 2 is refused.
    await h.respond("updateContent", { success: false, actionType: "updateContent", error: "Shopify refused" });
    await tick(50);
    await h.respond("updateContent", { success: true, actionType: "updateContent" });
    await tick(50);
    await h.respond("translateFieldToAllLocales", { success: true, actionType: "translateFieldToAllLocales", translations: { de: "SEO de", es: "SEO es" } });
    await tick(50);
    await h.respond("updateContent", { success: false, actionType: "updateContent", error: "Shopify refused again" });
    await tick(80);
    await switchTo(h, "de");
    expect(h.editor.current.state.editableValues.seoTitle).toBe("SEO");
  });

  it("(LOW1) a refused foreign step 1 takes the staged foreign text back: it reads as an unsaved draft, not as stored", async () => {
    const h = mount();
    await tick(50);
    await switchTo(h, "fr");
    setFieldSuggestion(scope("fr"), "seoTitle", "SEO fr");
    await tick(10);
    await act(async () => { h.editor.current.handlers.handleAcceptAndTranslate("seoTitle"); });
    await tick(20);
    await h.respond("updateContent", { success: false, actionType: "updateContent", error: "Shopify refused" });
    await tick(60);
    expect(h.editor.current.state.editableValues.seoTitle).toBe("SEO fr");
    expect(h.editor.current.state.hasChanges).toBe(true);
  });

  it("(MED2) a value an earlier save CONFIRMED goes back when step 2 is refused, not nothing", async () => {
    const h = mount();
    await tick(50);
    await act(async () => { h.editor.current.handlers.handleValueChange("seoTitle", "SEO conf"); });
    await act(async () => { h.editor.current.handlers.handleSave(); });
    await tick(20);
    await h.respond("updateContent", { success: true, actionType: "updateContent" });
    await tick(60);
    await switchTo(h, "fr");
    setFieldSuggestion(scope("fr"), "seoTitle", "SEO fr");
    await tick(10);
    await act(async () => { h.editor.current.handlers.handleAcceptAndTranslate("seoTitle"); });
    await tick(20);
    await h.respond("updateContent", { success: true, actionType: "updateContent" });
    await tick(20);
    await h.respond("translateFieldToAllLocales", { success: true, actionType: "translateFieldToAllLocales", translations: { de: "SEO de", es: "SEO es" } });
    await tick(50);
    await h.respond("updateContent", { success: false, actionType: "updateContent", error: "Shopify refused" });
    await tick(80);
    await switchTo(h, "de");
    expect(h.editor.current.state.editableValues.seoTitle).toBe("SEO conf");
  });

  it("(M1z) a refused step 1 deletes its overlay entry; a value an earlier unstored press had staged does not come back", async () => {
    const h = mount();
    await tick(50);
    await switchTo(h, "fr");
    setFieldSuggestion(scope("fr"), "seoTitle", "A text");
    await tick(10);
    await act(async () => { h.editor.current.handlers.handleAcceptAndTranslate("seoTitle"); });
    await tick(20);
    // A second press of the same field while the first step 1 is still out stages over "A text".
    setFieldSuggestion(scope("fr"), "seoTitle", "B text");
    await tick(10);
    await act(async () => { h.editor.current.handlers.handleAcceptAndTranslate("seoTitle"); });
    await tick(20);
    await h.respond("updateContent", { success: false, actionType: "updateContent", error: "Shopify refused" });
    await tick(40);
    await h.respond("updateContent", { success: false, actionType: "updateContent", error: "Shopify refused" });
    await tick(60);
    const overlay = h.editor.current.helpers.getValidationOverlays().localTranslations;
    expect(overlay.meta_title?.fr).toBeUndefined();
  });

  it("(M2z) a refused step 1 puts back the deleted marks it cleared: a field the merchant had cleared still reads as cleared", async () => {
    const h = mount();
    await tick(50);
    await switchTo(h, "fr");
    await act(async () => { h.editor.current.handlers.handleClearField("title"); });
    await tick(20);
    const marksBefore = [...h.editor.current.helpers.getValidationOverlays().deletedKeys].sort();
    expect(marksBefore.length).toBeGreaterThan(0);
    setFieldSuggestion(scope("fr"), "title", "Titre KI");
    await tick(10);
    await act(async () => { h.editor.current.handlers.handleAcceptAndTranslate("title"); });
    await tick(20);
    expect([...h.editor.current.helpers.getValidationOverlays().deletedKeys].sort()).not.toEqual(marksBefore);
    await h.respond("updateContent", { success: false, actionType: "updateContent", error: "Shopify refused" });
    await tick(60);
    expect([...h.editor.current.helpers.getValidationOverlays().deletedKeys].sort()).toEqual(marksBefore);
  });
});
