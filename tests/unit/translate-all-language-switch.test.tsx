/**
 * Owner report (2026-10-02, products): "Translate all" (or a translate-into-
 * every-language button) is pressed in the PRIMARY language, the merchant
 * switches to a foreign language — and back — while it runs, and the
 * translations never appear in the editor although Shopify stored them (a
 * reload shows them).
 *
 * An answer to a translate-into-every-language request is keyed by LOCALE, so
 * it must land under the locale it was written for whatever view is open when
 * it arrives — never be read against the view the button was pressed in (that
 * is always the primary, which no such answer ever writes).
 *
 *  - The image alt texts of "Translate all" (useFieldHandlers) and of the
 *    alt-text card's own button (useEditorAltText) read the click-time
 *    `currentLanguage` — the primary — so nothing was shown on the foreign
 *    view, and the whole-item path staged no overlay at all: the alt load reads
 *    the overlay first and is not re-run by a revalidation.
 *  - Options / option values / metafields: see
 *    product-sub-resources-translate-all-switch.test.tsx.
 *  - The main fields (useUnifiedContentEditor + useUiDataLoader) were already
 *    keyed by locale; they are pinned here through a real data router so a
 *    future change cannot regress them.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, renderHook } from "@testing-library/react";
import { createMemoryRouter, RouterProvider, useFetcher, useLoaderData } from "react-router";

vi.mock("~/contexts/TaskCountContext", () => ({ useTaskCount: () => ({ refresh: vi.fn() }) }));
vi.mock("~/hooks/useBackgroundTaskRefresh", () => ({ useBackgroundTaskRefresh: () => {} }));

import { useUnifiedContentEditor } from "~/hooks/useUnifiedContentEditor";
import { useFieldHandlers } from "~/hooks/useFieldHandlers";
import { PRODUCTS_CONFIG } from "~/config/content-fields.config";
import { applyAltTranslateAllAnswer } from "~/services/alt-text-feedback.shared";
import { clearAllForResource } from "~/hooks/useAIOperationsStore";

const tick = (ms = 0) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

// ---------------------------------------------------------------------------
// Pure: the alt-text answer
// ---------------------------------------------------------------------------

describe("applyAltTranslateAllAnswer", () => {
  const RESULTS = { "0": { fr: "Chat", it: "Gatto" }, "1": { fr: "Chien", it: "Cane" } };

  it("stages every saved (image, locale) under its own locale", () => {
    const overlay: Record<string, Record<number, string>> = {};
    applyAltTranslateAllAnswer(overlay, RESULTS, [], { locale: "de", marketId: "", primaryLocale: "de", current: {}, original: {} });
    expect(overlay).toEqual({ fr: { 0: "Chat", 1: "Chien" }, it: { 0: "Gatto", 1: "Cane" } });
  });

  it("returns the values of the locale on screen NOW, global view only", () => {
    const view = { locale: "it", marketId: "", primaryLocale: "de", current: {}, original: {} };
    expect(applyAltTranslateAllAnswer({}, RESULTS, [], view)).toEqual({ 0: "Gatto", 1: "Cane" });
    expect(applyAltTranslateAllAnswer({}, RESULTS, [], { ...view, marketId: "gid://shopify/Market/1" })).toEqual({});
    expect(applyAltTranslateAllAnswer({}, RESULTS, [], { ...view, locale: "de" })).toEqual({});
  });

  it("never overwrites a typed draft, and skips failed images", () => {
    const overlay: Record<string, Record<number, string>> = {};
    const visible = applyAltTranslateAllAnswer(overlay, RESULTS, [1], {
      locale: "fr", marketId: "", primaryLocale: "de",
      current: { 0: "mon brouillon" }, original: { 0: "" },
    });
    expect(visible).toEqual({});
    expect(overlay).toEqual({ fr: { 0: "Chat" }, it: { 0: "Gatto" } });
  });
});

// ---------------------------------------------------------------------------
// useFieldHandlers: the alt-text half of "Translate all"
// ---------------------------------------------------------------------------

describe("Translate all: the alt-text answer lands on the view open when it arrives", () => {
  // The "already running" guard lives in a module-scope store.
  beforeEach(() => clearAllForResource("gid://shopify/Product/1"));
  function setup() {
    const item = { id: "gid://shopify/Product/1", title: "Titel", images: [{ url: "a.jpg", altText: "Katze" }] };
    const currentLanguageRef = { current: "de" };
    const overlay = { current: {} as Record<string, Record<number, string>> };
    const spies = {
      safeSubmit: vi.fn(),
      showInfoBox: vi.fn(),
      setImageAltTexts: vi.fn(),
      setOriginalAltTexts: vi.fn(),
      submitAIAction: vi.fn(),
    };
    const known: Record<string, unknown> = {
      config: { contentType: "products" },
      primaryLocale: "de",
      currentLanguage: "de",
      selectedMarketId: "",
      selectedItem: item,
      selectedItemId: item.id,
      selectedItemIdRef: { current: item.id },
      enabledLanguages: ["de", "fr"],
      effectiveFieldDefinitions: [{ key: "title", translationKey: "title", type: "text", label: "Title" }],
      shopLocales: [],
      t: {},
      aiSuggestions: {},
      imageAltTexts: {},
      fallbackFields: new Set<string>(),
      currentLanguageRef,
      selectedMarketIdRef: { current: "" },
      localAltTextOverlayRef: overlay,
      imageAltTextsRef: { current: {} },
      originalAltTextsRef: { current: {} },
      editableValuesRef: { current: { title: "Titel" } },
      baselineValuesRef: { current: { title: "Titel" } },
      revalidatorRef: { current: { state: "loading", revalidate: vi.fn() } },
      ...spies,
    };
    const props = new Proxy(known, {
      get: (target, key: string) =>
        key in target ? target[key] : key.endsWith("Ref") ? { current: null } : vi.fn(),
    });
    const { result } = renderHook(() => useFieldHandlers(props as any));
    return { result, currentLanguageRef, overlay, ...spies };
  }

  it("shows the foreign alt texts after a switch, and stages them for every locale", () => {
    const h = setup();
    act(() => h.result.current.handleTranslateAll());
    const altCall = h.submitAIAction.mock.calls.find((c) => c[0].action === "translateAllAltTextsToAllLocales");
    expect(altCall).toBeTruthy();

    // The merchant switched to French while the run worked.
    h.currentLanguageRef.current = "fr";
    act(() => altCall![2]({ success: true, translatedCount: 1, imageCount: 1, failedImages: [], translatedResults: { "0": { fr: "Chat" } } }));

    expect(h.overlay.current).toEqual({ fr: { 0: "Chat" } });
    const shown = h.setImageAltTexts.mock.calls.map((c) => (typeof c[0] === "function" ? c[0]({}) : c[0]));
    expect(shown).toContainEqual({ 0: "Chat" });
  });

  it("back on the primary view it shows nothing there, but stages the overlay", () => {
    const h = setup();
    act(() => h.result.current.handleTranslateAll());
    const altCall = h.submitAIAction.mock.calls.find((c) => c[0].action === "translateAllAltTextsToAllLocales");
    act(() => altCall![2]({ success: true, translatedCount: 1, imageCount: 1, failedImages: [], translatedResults: { "0": { fr: "Chat" } } }));
    expect(h.setImageAltTexts).not.toHaveBeenCalled();
    expect(h.overlay.current).toEqual({ fr: { 0: "Chat" } });
  });
});

// ---------------------------------------------------------------------------
// The main fields, through a real data router (fetcher + revalidation)
// ---------------------------------------------------------------------------

describe("Translate all: the main fields land after a language switch", () => {
  beforeEach(() => {
    clearAllForResource("gid://shopify/Product/1");
    try { window.localStorage.clear(); } catch { /* none */ }
  });

  function mount() {
    const id = "gid://shopify/Product/1";
    const store: any = {
      id, title: "Alt", descriptionHtml: "<p>alt</p>", handle: "alt",
      seo: { title: "SEO alt", description: "Meta alt" },
      translations: [{ key: "title", locale: "fr", value: "Titre ancien" }],
      images: [], status: "ACTIVE",
    };
    let answer: (body: any) => void = () => {};
    const editor: { current: any } = { current: null };
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
        primaryLocale: "de", fetcher, showInfoBox: vi.fn(), t: {}, initialItemId: id,
      } as any);
      return null;
    }
    const router = createMemoryRouter([
      { path: "/api/product-images", loader: async () => ({ success: true, images: [] }) },
      {
        path: "/",
        element: <Page />,
        loader: async () => ({ items: [{ ...store, translations: [...store.translations], seo: { ...store.seo } }] }),
        action: async ({ request }) => {
          const form = Object.fromEntries((await request.formData()) as any) as Record<string, string>;
          const body = await new Promise<any>((resolve) => { answer = resolve; });
          if (form.action === "translateAll" && body.success) {
            store.translations = Object.entries(body.translations as Record<string, Record<string, string>>)
              .map(([locale, f]) => ({ key: "title", locale, value: f.title }));
          }
          return body;
        },
      },
    ]);
    render(<RouterProvider router={router} />);
    return { editor, respond: (b: any) => act(async () => { answer(b); }) };
  }

  const TA = {
    success: true, actionType: "translateAll", failedLocales: [],
    translations: { fr: { title: "Titre nouveau" }, it: { title: "Titolo nuovo" } },
  };
  const switchTo = async (h: ReturnType<typeof mount>, l: string) => {
    await act(async () => { await h.editor.current.handlers.handleLanguageChange(l); });
    await tick(50);
  };

  it("primary -> foreign -> primary while running, then foreign", async () => {
    const h = mount(); await tick(50);
    await act(async () => { h.editor.current.handlers.handleTranslateAll(); });
    await tick(20);
    await switchTo(h, "fr");
    await switchTo(h, "de");
    await h.respond(TA); await tick(100);
    await switchTo(h, "fr");
    expect(h.editor.current.state.editableValues.title).toBe("Titre nouveau");
    expect(h.editor.current.state.hasChanges).toBe(false);
  });

  it("answer arriving on a foreign view shows there, and in the other foreign language", async () => {
    const h = mount(); await tick(50);
    await act(async () => { h.editor.current.handlers.handleTranslateAll(); });
    await tick(20);
    await switchTo(h, "fr");
    await h.respond(TA); await tick(100);
    expect(h.editor.current.state.editableValues.title).toBe("Titre nouveau");
    await switchTo(h, "it");
    expect(h.editor.current.state.editableValues.title).toBe("Titolo nuovo");
    expect(h.editor.current.state.hasChanges).toBe(false);
  });
});
