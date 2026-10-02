/**
 * Owner report (2026-10-02, products): "Translate all" is started in foreign
 * language A, the merchant switches to foreign language B while it runs and
 * presses "Clear all" there. The save bar came up and blocked every switch
 * until A's run had finished.
 *
 * Through a real data router (the editor's one fetcher, its automatic
 * revalidation, the editor JSON door for the translate run):
 *
 *  - "Translate all" occupied the shared fetcher, so B's clear (a save) was
 *    QUEUED behind the AI run: its cleared fields read as unsaved changes and
 *    the save counted as in flight, i.e. the save bar was up and every switch
 *    asked about it, for as long as the AI worked. The run now goes out as its
 *    own request and the clear leaves at once.
 *  - B's clear marked its fields deleted for EVERY locale (the marks were keyed
 *    by translation key alone): A showed empty while it was pending, and A's
 *    answer -- which drops the marks of the fields it answered -- took B's
 *    marks with it.
 *  - The clear blanked the merchandising attributes too (status, vendor ...),
 *    which have no translation: the status select lost its value and the field
 *    stayed "changed" after the save.
 *  - A clear answered after the merchant switched on staged the NEW view's
 *    values under the cleared locale and took them as the new view's baseline.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, renderHook } from "@testing-library/react";
import { createMemoryRouter, RouterProvider, useFetcher, useLoaderData } from "react-router";

vi.mock("~/contexts/TaskCountContext", () => ({ useTaskCount: () => ({ refresh: vi.fn() }) }));
vi.mock("~/hooks/useBackgroundTaskRefresh", () => ({ useBackgroundTaskRefresh: () => {} }));

import { useUnifiedContentEditor } from "~/hooks/useUnifiedContentEditor";
import { PRODUCTS_CONFIG } from "~/config/content-fields.config";
import { useFieldHandlers } from "~/hooks/useFieldHandlers";
import { ownSaveRunBackstop } from "~/hooks/useEditorAutoSave";
import { clearAllForResource, isOperationActive, markOperationActive } from "~/hooks/useAIOperationsStore";

const ID = "gid://shopify/Product/1";
const ID2 = "gid://shopify/Product/2";
const tick = (ms = 0) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

type Row = { key: string; locale: string; value: string };
const KEY_OF: Record<string, string> = {
  body: "body_html", description: "body_html", seoTitle: "meta_title",
  metaDescription: "meta_description", productType: "product_type",
};

function mount(opts: { rows: Row[]; tasks?: unknown[]; secondItem?: boolean }) {
  const store: any = {
    id: ID, title: "Titel", descriptionHtml: "<p>Text</p>", handle: "titel",
    seo: { title: "SEO", description: "Meta" },
    translations: [...opts.rows],
    images: [], status: "ACTIVE",
  };
  const pending: Array<{ form: Record<string, string>; resolve: (b: any) => void }> = [];
  const posted: Array<Record<string, string>> = [];
  const editor: { current: any } = { current: null };
  const showInfoBox = vi.fn();
  const loads = { count: 0 };

  const serve = async (form: Record<string, string>) => {
    posted.push(form);
    const body = await new Promise<any>((resolve) => { pending.push({ form, resolve }); });
    if (form.action === "translateAllForLocale" && body.success) {
      for (const [field, value] of Object.entries(body.translations as Record<string, string>)) {
        const key = KEY_OF[field] ?? field;
        store.translations = store.translations.filter((r: Row) => !(r.locale === form.targetLocale && r.key === key));
        store.translations.push({ key, locale: form.targetLocale, value });
      }
    }
    if (form.action === "updateContent" && body.success && form.locale === "de") {
      // A primary save purges the changed fields' translations everywhere.
      const changed: string[] = form.changedFields ? JSON.parse(form.changedFields) : [];
      for (const field of changed) {
        const key = KEY_OF[field] ?? field;
        store.translations = store.translations.filter((r: Row) => r.key !== key);
      }
      if (form.title) store.title = form.title;
    } else if (form.action === "updateContent" && body.success) {
      // Every field the save sent: "" removes, a value is stored.
      for (const [field, value] of Object.entries(form)) {
        if (!["title", "seoTitle", "metaDescription", "body", "description", "handle", "productType"].includes(field)) continue;
        const key = KEY_OF[field] ?? field;
        store.translations = store.translations.filter((r: Row) => !(r.locale === form.locale && r.key === key));
        if (value !== "") store.translations.push({ key, locale: form.locale, value });
      }
    }
    return body;
  };

  // The editor JSON door: the translate run's own request.
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any, init?: any) => {
    if (String(input) === "/api/content-editor-action") {
      const form = Object.fromEntries((init.body as FormData) as any) as Record<string, string>;
      const body = await serve(form);
      return new Response(JSON.stringify(body), { status: body.success ? 200 : 500, headers: { "content-type": "application/json" } });
    }
    if (String(input).startsWith("/api/running-field-tasks")) {
      return new Response(JSON.stringify({ tasks: opts.tasks ?? [] }), { status: 200, headers: { "content-type": "application/json" } });
    }
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
        { locale: "it", primary: false, published: true },
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
      loader: async () => (loads.count++, {
        items: [
          { ...store, translations: store.translations.map((r: Row) => ({ ...r })), seo: { ...store.seo } },
          ...(opts.secondItem
            ? [{ id: ID2, title: "Zweites", descriptionHtml: "", handle: "zweites", seo: { title: "", description: "" }, translations: [], images: [], status: "ACTIVE" }]
            : []),
        ],
      }),
      action: async ({ request }) => serve(Object.fromEntries((await request.formData()) as any) as Record<string, string>),
    },
  ]);
  render(<RouterProvider router={router} />);
  const respond = async (action: string, body: any) => {
    const index = pending.findIndex((p) => p.form.action === action);
    if (index < 0) throw new Error(`no pending ${action} (have: ${pending.map((p) => p.form.action).join(",")})`);
    const [entry] = pending.splice(index, 1);
    await act(async () => { entry.resolve(body); });
  };
  return { editor, respond, posted, pending, store, showInfoBox, loads };
}

const switchTo = async (h: ReturnType<typeof mount>, locale: string) => {
  await act(async () => { await h.editor.current.handlers.handleLanguageChange(locale); });
  await tick(50);
};

const ROWS: Row[] = [
  { key: "title", locale: "fr", value: "Titre ancien" },
  { key: "title", locale: "it", value: "Titolo vecchio" },
  { key: "meta_title", locale: "it", value: "SEO vecchio" },
];
const TA_FR = {
  success: true, actionType: "translateAllForLocale", targetLocale: "fr", failedLocales: [],
  translations: { title: "Titre nouveau", seoTitle: "SEO nouveau" },
};
const SAVED = { success: true, actionType: "updateContent" };

describe("Clear all in language B while Translate all for language A runs", () => {
  beforeEach(() => {
    clearAllForResource(ID);
    try { window.localStorage.clear(); } catch { /* none */ }
    // A page the editor JSON door serves.
    window.history.replaceState({}, "", "/app/products");
  });
  afterEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState({}, "", "/");
  });

  async function startTranslateInFrThenClearIt() {
    const h = mount({ rows: ROWS });
    await tick(50);
    await switchTo(h, "fr");
    await act(async () => { h.editor.current.handlers.handleTranslateAllForLocale(); });
    await tick(20);
    expect(isOperationActive(ID, "__translateAllForLocale__fr")).toBe(true);
    await switchTo(h, "it");
    expect(h.editor.current.state.editableValues.title).toBe("Titolo vecchio");
    await act(async () => { h.editor.current.handlers.handleClearAllForLocaleConfirm(); });
    await tick(20);
    expect(h.editor.current.state.editableValues.title).toBe("");
    return h;
  }

  it("the clear does not wait for A's run: no save bar, no blocked switch", async () => {
    const h = await startTranslateInFrThenClearIt();
    // Both requests are out at once.
    expect(h.posted.map((p) => p.action).sort()).toEqual(["translateAllForLocale", "updateContent"]);
    const clear = h.posted.find((p) => p.action === "updateContent")!;
    expect(clear.locale).toBe("it");
    expect(clear.title).toBe("");
    expect(clear.seoTitle).toBe("");

    await h.respond("updateContent", SAVED);
    await tick(150);
    // A is still running -- and B is clean and not saving.
    expect(isOperationActive(ID, "__translateAllForLocale__fr")).toBe(true);
    expect(h.editor.current.state.hasChanges).toBe(false);
    expect(h.editor.current.state.isSavingCurrentItem).toBe(false);
    expect(h.editor.current.state.editableValues.title).toBe("");
    expect(h.editor.current.state.editableValues.status).toBe("ACTIVE");

    // A's answer lands afterwards: shown in A, never in B.
    await h.respond("translateAllForLocale", TA_FR);
    await tick(150);
    expect(isOperationActive(ID, "__translateAllForLocale__fr")).toBe(false);
    expect(h.editor.current.state.editableValues.title).toBe("");
    expect(h.editor.current.state.hasChanges).toBe(false);
    await switchTo(h, "fr");
    expect(h.editor.current.state.editableValues.title).toBe("Titre nouveau");
    expect(h.editor.current.state.hasChanges).toBe(false);
    await switchTo(h, "it");
    expect(h.editor.current.state.editableValues.title).toBe("");
    expect(h.editor.current.state.editableValues.seoTitle).not.toBe("SEO vecchio");
  });

  it("A's answer arriving while B's clear is still out does not bring B's values back", async () => {
    const h = await startTranslateInFrThenClearIt();
    await h.respond("translateAllForLocale", TA_FR);
    await tick(150);
    expect(h.editor.current.state.editableValues.title).toBe("");
    expect(h.editor.current.state.editableValues.seoTitle ?? "").not.toBe("SEO vecchio");
    await h.respond("updateContent", SAVED);
    await tick(150);
    expect(h.editor.current.state.editableValues.title).toBe("");
    expect(h.editor.current.state.hasChanges).toBe(false);
    await switchTo(h, "fr");
    expect(h.editor.current.state.editableValues.title).toBe("Titre nouveau");
    await switchTo(h, "it");
    expect(h.editor.current.state.editableValues.title).toBe("");
  });

  it("a save in the language being translated still waits for the run (the merchant's text lands last)", async () => {
    const h = mount({ rows: ROWS });
    await tick(50);
    await switchTo(h, "fr");
    await act(async () => { h.editor.current.handlers.handleTranslateAllForLocale(); });
    await tick(20);
    await act(async () => { h.editor.current.handlers.handleValueChange("title", "Titre à la main"); });
    await tick(10);
    await act(async () => { h.editor.current.handlers.handleSave(); });
    await tick(20);
    expect(h.posted.map((p) => p.action)).toEqual(["translateAllForLocale"]);
    await h.respond("translateAllForLocale", TA_FR);
    await tick(150);
    const save = h.posted.find((p) => p.action === "updateContent")!;
    expect(save.locale).toBe("fr");
    expect(save.title).toBe("Titre à la main");
    await h.respond("updateContent", SAVED);
    await tick(150);
    expect(h.editor.current.state.editableValues.title).toBe("Titre à la main");
  });

  it("a later foreign save never overtakes a primary save the run holds back", async () => {
    const h = mount({ rows: ROWS });
    await tick(50);
    await switchTo(h, "fr");
    await act(async () => { h.editor.current.handlers.handleTranslateAllForLocale(); });
    await switchTo(h, "de");
    await act(async () => { h.editor.current.handlers.handleValueChange("title", "Neuer Titel"); });
    await act(async () => { h.editor.current.handlers.handleSave(); });
    await tick(20);
    await switchTo(h, "it");
    await act(async () => { h.editor.current.handlers.handleValueChange("title", "Titolo a mano"); });
    await act(async () => { h.editor.current.handlers.handleSave(); });
    await tick(20);
    expect(h.posted.map((p) => p.action)).toEqual(["translateAllForLocale"]);
    await h.respond("translateAllForLocale", TA_FR);
    await tick(100);
    const saves = h.posted.filter((p) => p.action === "updateContent");
    expect(saves.map((p) => p.locale)).toEqual(["de"]);
    await h.respond("updateContent", SAVED);
    await tick(100);
    expect(h.posted.filter((p) => p.action === "updateContent").map((p) => p.locale)).toEqual(["de", "it"]);
  });

  it("a run is refused while a save of its language (or any primary save) is still out", async () => {
    const h = mount({ rows: ROWS });
    await tick(50);
    await switchTo(h, "it");
    await act(async () => { h.editor.current.handlers.handleClearAllForLocaleConfirm(); });
    await tick(10);
    expect(h.posted.map((p) => p.action)).toEqual(["updateContent"]);
    // Translate all for Italian right after "clear all": refused, nothing sent.
    await act(async () => { expect(h.editor.current.handlers.handleTranslateAllForLocale()).toBe(false); });
    await act(async () => { expect(h.editor.current.handlers.handleTranslateAll()).toBe(false); });
    await tick(10);
    expect(h.posted.map((p) => p.action)).toEqual(["updateContent"]);
    expect(isOperationActive(ID, "__translateAllForLocale__it")).toBe(false);
    expect(h.showInfoBox).toHaveBeenCalledWith(expect.stringContaining("translate again"), "info");
    await h.respond("updateContent", SAVED);
    await tick(150);
    // Once answered, the run goes.
    await act(async () => { h.editor.current.handlers.handleTranslateAllForLocale(); });
    await tick(10);
    expect(h.posted.map((p) => p.action)).toEqual(["updateContent", "translateAllForLocale"]);
  });

  it("a run in another language is not refused by a save that is out", async () => {
    const h = mount({ rows: ROWS });
    await tick(50);
    await switchTo(h, "it");
    await act(async () => { h.editor.current.handlers.handleClearAllForLocaleConfirm(); });
    await tick(10);
    // The clear is out; switching asks (no save bar in tests) and goes.
    await switchTo(h, "fr");
    await act(async () => { h.editor.current.handlers.handleTranslateAllForLocale(); });
    await tick(10);
    expect(h.posted.map((p) => p.action)).toEqual(["updateContent", "translateAllForLocale"]);
  });

  it("a failed run reloads too (it may have stored some languages)", async () => {
    const h = await startTranslateInFrThenClearIt();
    await h.respond("updateContent", SAVED);
    await tick(150);
    const before = h.loads.count;
    await h.respond("translateAllForLocale", { success: false, actionType: "translateAllForLocale", targetLocale: "fr", error: "boom" });
    await tick(150);
    expect(h.loads.count).toBeGreaterThan(before);
  });

  it("a held save says why it waits and reads as saving until it went out", async () => {
    const h = mount({ rows: ROWS });
    await tick(50);
    await switchTo(h, "fr");
    await act(async () => { h.editor.current.handlers.handleTranslateAllForLocale(); });
    await tick(10);
    await act(async () => { h.editor.current.handlers.handleValueChange("title", "Titre à la main"); });
    await act(async () => { h.editor.current.handlers.handleSave(); });
    await tick(20);
    expect(h.showInfoBox).toHaveBeenCalledWith(expect.stringContaining("Waiting until the translation"), "info");
    expect(h.editor.current.state.isSavingCurrentItem).toBe(true);
    await h.respond("translateAllForLocale", TA_FR);
    await tick(100);
    expect(h.editor.current.state.isSavingCurrentItem).toBe(true);
    await h.respond("updateContent", SAVED);
    await tick(150);
    expect(h.editor.current.state.isSavingCurrentItem).toBe(false);
  });

  it("a primary save held behind a run leaves none of the run's translations of the OLD text on screen", async () => {
    const h = mount({ rows: ROWS });
    await tick(50);
    await switchTo(h, "fr");
    await act(async () => { h.editor.current.handlers.handleTranslateAllForLocale(); });
    await tick(10);
    await switchTo(h, "de");
    await act(async () => { h.editor.current.handlers.handleValueChange("title", "Neuer Titel"); });
    await act(async () => { h.editor.current.handlers.handleSave(); });
    await tick(20);
    // The run answers with a translation of the OLD title...
    await h.respond("translateAllForLocale", TA_FR);
    await tick(100);
    // ...then the held primary save goes out and purges it on the server.
    const save = h.posted.find((p) => p.action === "updateContent")!;
    expect(save.locale).toBe("de");
    await h.respond("updateContent", SAVED);
    await tick(150);
    await switchTo(h, "fr");
    expect(h.editor.current.state.editableValues.title).not.toBe("Titre nouveau");
    expect(h.editor.current.state.editableValues.title).toBe("");
  });

  it("leaving a language whose clear was sent keeps only the marks that save carries", async () => {
    const h = await startTranslateInFrThenClearIt();
    await switchTo(h, "fr");
    await h.respond("updateContent", SAVED);
    await tick(150);
    await switchTo(h, "it");
    // The handle was empty in Italian (inherited from the primary): the clear
    // sent nothing for it, and its mark does not hide the inherited value.
    expect(h.editor.current.state.editableValues.handle).toBe("titel");
    expect(h.editor.current.state.editableValues.title).toBe("");
  });

  it("a refused save answer with no error text does not refuse later runs", async () => {
    const h = mount({ rows: ROWS });
    await tick(50);
    await switchTo(h, "it");
    await act(async () => { h.editor.current.handlers.handleClearAllForLocaleConfirm(); });
    await tick(10);
    await h.respond("updateContent", { success: false, actionType: "updateContent" });
    await tick(150);
    expect(h.editor.current.state.isSavingCurrentItem).toBe(false);
    await act(async () => { h.editor.current.handlers.handleTranslateAllForLocale(); });
    await tick(10);
    expect(h.posted.map((p) => p.action)).toEqual(["updateContent", "translateAllForLocale"]);
  });

  it("a held save of one language does not count an earlier, answered save of another", async () => {
    const h = mount({ rows: ROWS });
    await tick(50);
    // An Italian save, answered.
    await switchTo(h, "it");
    await act(async () => { h.editor.current.handlers.handleValueChange("title", "Titolo a mano"); });
    await act(async () => { h.editor.current.handlers.handleSave(); });
    await tick(10);
    await h.respond("updateContent", SAVED);
    await tick(150);
    // A French run, and a French save held behind it.
    await switchTo(h, "fr");
    await act(async () => { h.editor.current.handlers.handleTranslateAllForLocale(); });
    await act(async () => { h.editor.current.handlers.handleValueChange("title", "Titre à la main"); });
    await act(async () => { h.editor.current.handlers.handleSave(); });
    await tick(20);
    // Italian translate all is NOT refused: nothing Italian is out.
    await act(async () => { h.editor.current.handlers.handleDiscard(); });
    await switchTo(h, "it");
    await act(async () => { h.editor.current.handlers.handleTranslateAllForLocale(); });
    await tick(10);
    expect(h.posted.filter((p) => p.action === "translateAllForLocale").map((p) => p.targetLocale)).toEqual(["fr", "it"]);
  });

  it("an own (copy) save in the language being translated is refused up front, never held", async () => {
    const h = mount({ rows: ROWS });
    await tick(50);
    await switchTo(h, "fr");
    await act(async () => { h.editor.current.handlers.handleTranslateAllForLocale(); });
    await tick(10);
    await act(async () => { h.editor.current.handlers.handleCopyField("title"); });
    await tick(20);
    expect(h.posted.map((p) => p.action)).toEqual(["translateAllForLocale"]);
    expect(h.showInfoBox).toHaveBeenCalledWith(expect.stringContaining("stays unsaved"), "info");
    expect(h.editor.current.helpers.isOwnSaveInFlight()).toBe(false);
    expect(h.editor.current.state.isSavingCurrentItem).toBe(false);
    // Refused before anything moved: the field is as it was, and the
    // backstop in safeSubmit was never reached.
    expect(h.editor.current.state.editableValues.title).toBe("Titre ancien");
    expect(h.editor.current.state.hasChanges).toBe(false);
    expect(isOperationActive(ID, "title")).toBe(false);
    expect(ownSaveRunBackstop.hits).toBe(0);
    // The run answering sends nothing by itself.
    await h.respond("translateAllForLocale", TA_FR);
    await tick(150);
    expect(h.posted.map((p) => p.action)).toEqual(["translateAllForLocale"]);
  });

  it("returning to an item whose save answered while another item was open is not busy", async () => {
    const h = mount({ rows: ROWS, secondItem: true });
    await tick(50);
    await switchTo(h, "fr");
    await act(async () => { h.editor.current.handlers.handleValueChange("title", "Titre à la main"); });
    await act(async () => { h.editor.current.handlers.handleSave(); });
    await tick(10);
    expect(h.editor.current.state.isSavingCurrentItem).toBe(true);
    await act(async () => { await h.editor.current.handlers.handleItemSelect(ID2); });
    await tick(50);
    await h.respond("updateContent", SAVED);
    await tick(150);
    await act(async () => { await h.editor.current.handlers.handleItemSelect(ID); });
    await tick(80);
    expect(h.editor.current.state.isSavingCurrentItem).toBe(false);
  });

  it("two runs answering before one render are both applied", async () => {
    const h = mount({ rows: ROWS });
    await tick(50);
    await switchTo(h, "fr");
    await act(async () => { h.editor.current.handlers.handleTranslateAllForLocale(); });
    await switchTo(h, "it");
    await act(async () => { h.editor.current.handlers.handleTranslateAllForLocale(); });
    await tick(20);
    const runs = h.pending.filter((p) => p.form.action === "translateAllForLocale");
    expect(runs.map((r) => r.form.targetLocale)).toEqual(["fr", "it"]);
    h.pending.length = 0;
    await act(async () => {
      runs[0].resolve(TA_FR);
      runs[1].resolve({ ...TA_FR, targetLocale: "it", translations: { title: "Titolo nuovo" } });
    });
    await tick(150);
    expect(isOperationActive(ID, "__translateAllForLocale__fr")).toBe(false);
    expect(isOperationActive(ID, "__translateAllForLocale__it")).toBe(false);
    expect(h.editor.current.state.editableValues.title).toBe("Titolo nuovo");
    await switchTo(h, "fr");
    expect(h.editor.current.state.editableValues.title).toBe("Titre nouveau");
  });

  it("B's clear does not empty A while it is pending", async () => {
    const h = await startTranslateInFrThenClearIt();
    await switchTo(h, "fr");
    expect(h.editor.current.state.editableValues.title).toBe("Titre ancien");
  });

  it("a clear answered after a switch stages nothing of the new view under the cleared locale", async () => {
    const h = await startTranslateInFrThenClearIt();
    // The merchant switches to French before the clear answered, and types.
    await switchTo(h, "fr");
    await act(async () => { h.editor.current.handlers.handleValueChange("title", "Titre tapé"); });
    await tick(10);
    expect(h.editor.current.state.hasChanges).toBe(true);

    await h.respond("updateContent", SAVED);
    await tick(150);
    // French keeps its draft -- the Italian save does not mark it saved.
    expect(h.editor.current.state.editableValues.title).toBe("Titre tapé");
    expect(h.editor.current.state.hasChanges).toBe(true);
    await act(async () => { h.editor.current.handlers.handleDiscard(); });
    await tick(20);
    // Italian is not given the French text.
    await switchTo(h, "it");
    expect(h.editor.current.state.editableValues.title).toBe("");
  });

  it("a failed translate answer stops its spinner and leaves the clear alone", async () => {
    const h = await startTranslateInFrThenClearIt();
    await h.respond("translateAllForLocale", { success: false, actionType: "translateAllForLocale", targetLocale: "fr", error: "AI provider down" });
    await tick(100);
    expect(isOperationActive(ID, "__translateAllForLocale__fr")).toBe(false);
    expect(h.showInfoBox).toHaveBeenCalledWith(expect.stringContaining("AI provider down"), "critical");
    await h.respond("updateContent", SAVED);
    await tick(150);
    expect(h.editor.current.state.isSavingCurrentItem).toBe(false);
    expect(h.editor.current.state.hasChanges).toBe(false);
    expect(h.showInfoBox).toHaveBeenCalledWith(expect.stringContaining("Changes saved"), "success");
  });
});

// ---------------------------------------------------------------------------
// useFieldHandlers in isolation: the alt-text half and the refusal
// ---------------------------------------------------------------------------

function setupHandlers(language = "fr", overrides: Record<string, unknown> = {}) {
  const item = { id: ID, title: "Titel", images: [{ url: "a.jpg", altText: "Katze", altTextTranslations: [] as any[] }] };
  const currentLanguageRef = { current: language };
  const overlay = { current: { it: { 0: "Gatto vecchio" } } as Record<string, Record<number, string>> };
  const spies = {
    safeSubmit: vi.fn(),
    submitTranslateRun: vi.fn(),
    showInfoBox: vi.fn(),
    setImageAltTexts: vi.fn(),
    setOriginalAltTexts: vi.fn(),
    setIsClearAllModalOpen: vi.fn(),
    submitAIAction: vi.fn(),
  };
  const revalidate = vi.fn();
  const known: Record<string, unknown> = {
    config: { contentType: "products" },
    primaryLocale: "de",
    currentLanguage: language,
    selectedMarketId: "",
    selectedItem: item,
    selectedItemId: item.id,
    selectedItemIdRef: { current: item.id },
    enabledLanguages: ["de", "fr", "it"],
    effectiveFieldDefinitions: [{ key: "title", translationKey: "title", type: "text", label: "Title" }],
    shopLocales: [],
    t: {},
    aiSuggestions: {},
    imageAltTexts: {},
    fallbackFields: new Set<string>(),
    fallbackFieldsRef: { current: new Set<string>() },
    currentLanguageRef,
    selectedMarketIdRef: { current: "" },
    localAltTextOverlayRef: overlay,
    localTranslationsRef: { current: {} },
    deletedTranslationKeysRef: { current: new Set<string>() },
    originalLoadedValuesRef: { current: { title: "x" } },
    imageAltTextsRef: { current: {} },
    originalAltTextsRef: { current: {} },
    editableValuesRef: { current: { title: "x" } },
    baselineValuesRef: { current: { title: "x" } },
    revalidatorRef: { current: { state: "idle", revalidate } },
    ...spies,
    ...overrides,
  };
  const props = new Proxy(known, {
    get: (target, key: string) =>
      key in target ? target[key] : key.endsWith("Ref") ? { current: null } : vi.fn(),
  });
  const { result } = renderHook(() => useFieldHandlers(props as any));
  return { result, currentLanguageRef, overlay, revalidate, known, ...spies };
}

describe("Translate all for one language: the alt-text answer", () => {
  beforeEach(() => clearAllForResource(ID));

  it("lands under the language it was written for, never in the language on screen now", () => {
    const h = setupHandlers("fr");
    act(() => h.result.current.handleTranslateAllForLocale());
    expect(h.submitTranslateRun).toHaveBeenCalledWith(expect.objectContaining({ action: "translateAllForLocale", targetLocale: "fr" }), ID);
    expect(h.safeSubmit).not.toHaveBeenCalled();
    const altCall = h.submitAIAction.mock.calls.find((c) => c[0].action === "translateAllAltTextsForLocale")!;
    // The merchant switched to Italian meanwhile.
    h.currentLanguageRef.current = "it";
    act(() => altCall[2]({ success: true, translatedAltTexts: { "0": "Chat" }, failedImages: [] }));
    expect(h.setImageAltTexts).not.toHaveBeenCalled();
    expect(h.setOriginalAltTexts).not.toHaveBeenCalled();
    expect(h.overlay.current).toEqual({ it: { 0: "Gatto vecchio" }, fr: { 0: "Chat" } });
    expect(h.revalidate).toHaveBeenCalled();
  });

  it("is shown while its language is still on screen", () => {
    const h = setupHandlers("fr");
    act(() => h.result.current.handleTranslateAllForLocale());
    const altCall = h.submitAIAction.mock.calls.find((c) => c[0].action === "translateAllAltTextsForLocale")!;
    act(() => altCall[2]({ success: true, translatedAltTexts: { "0": "Chat" }, failedImages: [] }));
    const shown = h.setImageAltTexts.mock.calls.map((c) => (typeof c[0] === "function" ? c[0]({}) : c[0]));
    expect(shown).toContainEqual({ 0: "Chat" });
  });
});

describe("Clear all while a translation into the SAME language runs", () => {
  beforeEach(() => clearAllForResource(ID));

  it("is refused with a message; a run for another language does not refuse", () => {
    const h = setupHandlers("it");
    markOperationActive(ID, "__translateAllForLocale__fr", "translateAllForLocale", "fr");
    act(() => h.result.current.handleClearAllForLocaleClick());
    expect(h.setIsClearAllModalOpen).toHaveBeenCalledWith(true);
    expect(h.showInfoBox).not.toHaveBeenCalled();

    markOperationActive(ID, "__translateAllForLocale__it", "translateAllForLocale", "it");
    h.setIsClearAllModalOpen.mockClear();
    act(() => h.result.current.handleClearAllForLocaleClick());
    expect(h.setIsClearAllModalOpen).not.toHaveBeenCalledWith(true);
    expect(h.showInfoBox).toHaveBeenCalledWith(expect.stringContaining("still running"), "info");
    // The confirm is refused too (the run may have started while the dialog was open).
    act(() => h.result.current.handleClearAllForLocaleConfirm());
    expect(h.safeSubmit).not.toHaveBeenCalled();
  });

  it("Discard drops the view's draft-clear marks except those a save that is out still carries", () => {
    const marks = { current: new Set(["title##it", "body_html##it", "title##fr"]) };
    const h = setupHandlers("it", {
      deletedTranslationKeysRef: marks,
      isSavingCurrentItem: true,
      deletedMarksOfSavesOut: () => new Set(["body_html##it"]),
    });
    act(() => h.result.current.handleDiscard());
    expect([...marks.current].sort()).toEqual(["body_html##it", "title##fr"]);
  });

  it("a language switch drops the left view's draft-clear marks", async () => {
    const marks = { current: new Set(["title##it", "title##fr"]) };
    const h = setupHandlers("it", { deletedTranslationKeysRef: marks, deletedMarksOfSavesOut: () => new Set<string>() });
    await act(async () => { await h.result.current.handleLanguageChange("fr"); });
    expect([...marks.current]).toEqual(["title##fr"]);
  });

  it("clear all also clears a per-language theme image", () => {
    const h = setupHandlers("it", {
      effectiveFieldDefinitions: [
        { key: "title", translationKey: "title", type: "text", label: "Title" },
        { key: "logo", translationKey: "general.logo", type: "themeImage", supportsTranslation: false, label: "Logo" },
      ],
    });
    act(() => h.result.current.handleClearAllForLocaleConfirm());
    expect([...(h.known.deletedTranslationKeysRef as any).current].sort()).toEqual(["general.logo##it", "title##it"]);
  });

  it("clears its own layer's staged alt translations, never another language's", () => {
    const h = setupHandlers("it");
    h.overlay.current = { it: { 0: "Gatto" }, fr: { 0: "Chat" } };
    act(() => h.result.current.handleClearAllForLocaleConfirm());
    expect(h.overlay.current).toEqual({ fr: { 0: "Chat" } });
    expect(h.known.deletedTranslationKeysRef).toEqual({ current: new Set(["title##it"]) });
  });
});


describe("spinner seeding from running server tasks", () => {
  beforeEach(() => {
    clearAllForResource(ID);
    // The editor reopens in the last language worked in; this view is German.
    try { window.localStorage.clear(); } catch { /* none */ }
    window.history.replaceState({}, "", "/app/products");
  });
  afterEach(() => {
    vi.restoreAllMocks();
    clearAllForResource(ID);
    window.history.replaceState({}, "", "/");
  });

  it("a French field task does not spin in German; a French run keeps its own key", async () => {
    mount({
      rows: ROWS,
      tasks: [
        { fieldType: "title", targetLocale: "fr", type: "translation" },
        { fieldType: "all", targetLocale: "fr", type: "bulkTranslation" },
      ],
    });
    await tick(100);
    expect(isOperationActive(ID, "title")).toBe(false);
    expect(isOperationActive(ID, "__translateAllForLocale__fr")).toBe(true);
    expect(isOperationActive(ID, "__translateAll__")).toBe(false);
  });
});
