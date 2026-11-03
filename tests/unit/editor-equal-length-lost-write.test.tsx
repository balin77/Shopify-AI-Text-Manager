/**
 * A value that moved to another value of the SAME LENGTH must not make a later
 * save drop the merchant's retyped text.
 *
 * Real `useUnifiedContentEditor`, fake route fetcher (it records what is
 * submitted and answers when told to), mocked revalidator.
 *
 * Scenario: the field held X ("noir"); something else changed it to Y ("bleu",
 * same length) -- a save of this session, an AI run, an external edit. The
 * merchant retypes X and saves. A foreign-language save sends only the fields
 * that differ from the loaded baseline: the baseline still said X, the field
 * was left out, the action answered success on the empty submission, Shopify
 * kept Y.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";

const revalidate = vi.fn();
vi.mock("react-router", async (orig) => ({
  ...(await orig<typeof import("react-router")>()),
  useRevalidator: () => ({ state: "idle", revalidate }),
}));
vi.mock("~/contexts/TaskCountContext", () => ({
  useTaskCount: () => ({ refresh: vi.fn(), tasks: [], recentlyCompletedTasks: [], count: 0 }),
}));

vi.mock("~/utils/app-fetch", () => ({
  appFetch: () => new Promise(() => {}),
  appFetchJson: () => new Promise(() => {}),
}));

import { useUnifiedContentEditor } from "~/hooks/useUnifiedContentEditor";
import { PRODUCTS_CONFIG, METAOBJECTS_CONFIG, TEMPLATES_CONFIG } from "~/config/content-fields.config";

const PRODUCT = "gid://shopify/Product/1";
const META_TYPE = "gid://shopify/MetaobjectDefinition/1";
const ENTRY = "gid://shopify/Metaobject/10";
const META_KEY = `${ENTRY}#label`;

const shopLocales = [
  { locale: "de", name: "Deutsch", primary: true, published: true },
  { locale: "fr", name: "Francais", primary: false, published: true },
] as any;

function productItem(title: string, frTitle: string) {
  return {
    id: PRODUCT,
    title,
    handle: "h",
    descriptionHtml: "",
    seo: { title: "", description: "" },
    translations: frTitle ? [{ key: "title", locale: "fr", value: frTitle }] : [],
    images: [],
  };
}

function metaItem(primaryLabel: string, frLabel: string) {
  return {
    id: META_TYPE,
    type: "color",
    title: "Color",
    fieldDefinitions: [{ key: "label", name: "Label", type: { name: "single_line_text_field" }, required: false }],
    metaobjects: [
      { id: ENTRY, handle: "e", displayName: primaryLabel, fields: [{ key: "label", value: primaryLabel, type: "single_line_text_field" }] },
    ],
    translations: frLabel ? [{ key: META_KEY, locale: "fr", value: frLabel }] : [],
    marketTranslations: {},
  };
}

const THEME_KEY = "sections.hero.heading";
function themeItem(primaryText: string, frText: string) {
  return {
    id: "gid://shopify/OnlineStoreThemeJsonTemplate/1",
    groupName: "hero",
    title: "Hero",
    translatableContent: [{ key: THEME_KEY, value: primaryText, digest: "d" }],
    translations: frText ? [{ key: THEME_KEY, locale: "fr", value: frText }] : [],
  };
}

type Fake = { state: string; data: any; submit: ReturnType<typeof vi.fn>; load: ReturnType<typeof vi.fn> };

function mount(opts: { config: any; item: (a: string, b: string) => any; key: string; primary: string; foreign: string }) {
  const fetcher: Fake = { state: "idle", data: undefined, submit: vi.fn(), load: vi.fn() };
  const showInfoBox = vi.fn();
  const props = (items: any[], f: Fake) => ({
    config: opts.config,
    items,
    shopLocales,
    primaryLocale: "de",
    fetcher: { ...f } as any,
    showInfoBox,
    t: { common: {}, content: {} } as any,
    initialItemId: items[0].id,
    initialLocale: "fr",
  });
  const hook = renderHook((p: { items: any[]; f: Fake }) => useUnifiedContentEditor(props(p.items, p.f) as any), {
    initialProps: { items: [opts.item(opts.primary, opts.foreign)], f: fetcher },
  });
  const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });
  return { hook, fetcher, flush, showInfoBox };
}

const sentForm = (f: Fake): Record<string, string> => {
  const fd = f.submit.mock.calls.at(-1)![0] as FormData;
  return Object.fromEntries([...fd.entries()].map(([k, v]) => [k, String(v)]));
};

/** The server answered the last submit with success. */
async function answer(m: ReturnType<typeof mount>, items: any[], data: any = { success: true, actionType: "updateContent" }) {
  m.fetcher.data = data;
  await act(async () => { m.hook.rerender({ items, f: { ...m.fetcher } }); });
  await m.flush();
}

const CASES = [
  { name: "products (foreign title)", config: PRODUCTS_CONFIG, item: productItem, key: "title" },
  { name: "metaobjects (foreign label)", config: METAOBJECTS_CONFIG, item: metaItem, key: META_KEY },
  { name: "theme content (foreign heading)", config: TEMPLATES_CONFIG, item: themeItem, key: THEME_KEY },
];

describe.each(CASES)("equal-length change, $name", ({ config, item, key }) => {
  beforeEach(() => { revalidate.mockReset(); });

  it("a save of this session, then retyping the old text, still sends it", async () => {
    const m = mount({ config, item, key, primary: "rouge", foreign: "noir" });
    await m.flush();
    expect(m.hook.result.current.state.editableValues[key]).toBe("noir");

    // 1. noir -> bleu, saved.
    act(() => m.hook.result.current.handlers.handleValueChange(key, "bleu"));
    act(() => m.hook.result.current.handlers.handleSave());
    expect(sentForm(m.fetcher)[key]).toBe("bleu");
    // The revalidation brings the stored value: same length as before.
    await answer(m, [item("rouge", "bleu")]);

    // 2. The merchant retypes noir and saves.
    act(() => m.hook.result.current.handlers.handleValueChange(key, "noir"));
    expect(m.hook.result.current.state.hasChanges).toBe(true);
    m.fetcher.submit.mockClear();
    m.fetcher.data = undefined;
    await act(async () => { m.hook.rerender({ items: [item("rouge", "bleu")], f: { ...m.fetcher } }); });
    act(() => m.hook.result.current.handlers.handleSave());
    expect(m.fetcher.submit).toHaveBeenCalledTimes(1);
    expect(sentForm(m.fetcher)[key]).toBe("noir");
  });

  it("an external change of the same length, delivered by a revalidation, is shown and the retyped old text is sent", async () => {
    const m = mount({ config, item, key, primary: "rouge", foreign: "noir" });
    await m.flush();

    // Something else wrote bleu; the loader delivers it (no save from here).
    await act(async () => { m.hook.rerender({ items: [item("rouge", "bleu")], f: m.fetcher }); });
    await m.flush();
    expect(m.hook.result.current.state.editableValues[key]).toBe("bleu");

    act(() => m.hook.result.current.handlers.handleValueChange(key, "noir"));
    act(() => m.hook.result.current.handlers.handleSave());
    expect(m.fetcher.submit).toHaveBeenCalledTimes(1);
    expect(sentForm(m.fetcher)[key]).toBe("noir");
  });

  it("a change arriving while the merchant types keeps the typed text", async () => {
    const m = mount({ config, item, key, primary: "rouge", foreign: "noir" });
    await m.flush();
    act(() => m.hook.result.current.handlers.handleValueChange(key, "vert-clair"));

    await act(async () => { m.hook.rerender({ items: [item("rouge", "bleu")], f: m.fetcher }); });
    await m.flush();
    expect(m.hook.result.current.state.editableValues[key]).toBe("vert-clair");
    expect(m.hook.result.current.state.hasChanges).toBe(true);

    // Retyping the ORIGINAL text (not the new stored one) is still a change.
    act(() => m.hook.result.current.handlers.handleValueChange(key, "noir"));
    act(() => m.hook.result.current.handlers.handleSave());
    expect(sentForm(m.fetcher)[key]).toBe("noir");
  });

  it("an untouched field stays out of the submission", async () => {
    const m = mount({ config, item, key, primary: "rouge", foreign: "noir" });
    await m.flush();
    await answer(m, [item("rouge", "bleu")], undefined);
    await act(async () => { m.hook.rerender({ items: [item("rouge", "bleu")], f: m.fetcher }); });
    await m.flush();
    // Nothing typed: no changes, no submit.
    expect(m.hook.result.current.state.hasChanges).toBe(false);
    act(() => m.hook.result.current.handlers.handleSave());
    expect(m.fetcher.submit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Primary language, the re-read window, and switching products
// ---------------------------------------------------------------------------

describe.each(CASES)("equal-length change in the main language, $name", ({ config, item, key }) => {
  beforeEach(() => { revalidate.mockReset(); });

  it("retyping the old main text after a save of this session is announced as a change and sent", async () => {
    const m = mount({ config, item, key, primary: "rouge", foreign: "" });
    // Main-language view.
    await act(async () => { m.hook.result.current.handlers.handleLanguageChange("de"); });
    await m.flush();
    expect(m.hook.result.current.state.editableValues[key]).toBe("rouge");

    act(() => m.hook.result.current.handlers.handleValueChange(key, "verte"));
    act(() => m.hook.result.current.handlers.handleSave());
    expect(JSON.parse(sentForm(m.fetcher).changedFields)).toContain(key);
    await answer(m, [item("verte", "")]);

    act(() => m.hook.result.current.handlers.handleValueChange(key, "rouge"));
    m.fetcher.submit.mockClear();
    m.fetcher.data = undefined;
    await act(async () => { m.hook.rerender({ items: [item("verte", "")], f: { ...m.fetcher } }); });
    act(() => m.hook.result.current.handlers.handleSave());
    expect(m.fetcher.submit).toHaveBeenCalledTimes(1);
    const form = sentForm(m.fetcher);
    expect(form[key]).toBe("rouge");
    expect(JSON.parse(form.changedFields)).toContain(key);
  });
});

describe("the re-read window after a save", () => {
  beforeEach(() => { revalidate.mockReset(); });

  it("a retype between the answer and the re-read is sent (same-length value)", async () => {
    const m = mount({ config: PRODUCTS_CONFIG, item: productItem, key: "title", primary: "rouge", foreign: "noir" });
    await m.flush();
    act(() => m.hook.result.current.handlers.handleValueChange("title", "bleu"));
    act(() => m.hook.result.current.handlers.handleSave());
    // The answer lands, the loader has NOT delivered the new item yet.
    await answer(m, [productItem("rouge", "noir")]);
    act(() => m.hook.result.current.handlers.handleValueChange("title", "noir"));
    expect(m.hook.result.current.state.hasChanges).toBe(true);
    m.fetcher.submit.mockClear();
    m.fetcher.data = undefined;
    await act(async () => { m.hook.rerender({ items: [productItem("rouge", "noir")], f: { ...m.fetcher } }); });
    act(() => m.hook.result.current.handlers.handleSave());
    expect(sentForm(m.fetcher).title).toBe("noir");
  });

  it("the re-read that lands while the merchant types keeps the typed text", async () => {
    const m = mount({ config: PRODUCTS_CONFIG, item: productItem, key: "title", primary: "rouge", foreign: "noir" });
    await m.flush();
    act(() => m.hook.result.current.handlers.handleValueChange("title", "bleu"));
    act(() => m.hook.result.current.handlers.handleSave());
    await answer(m, [productItem("rouge", "noir")]);
    act(() => m.hook.result.current.handlers.handleValueChange("title", "noir"));
    // The re-read arrives: the stored text is "bleu" (same length as "noir").
    await act(async () => { m.hook.rerender({ items: [productItem("rouge", "bleu")], f: { ...m.fetcher, data: undefined } }); });
    await m.flush();
    expect(m.hook.result.current.state.editableValues.title).toBe("noir");
    expect(m.hook.result.current.state.hasChanges).toBe(true);
  });
});

describe("switching products", () => {
  beforeEach(() => { revalidate.mockReset(); });
  const A = "gid://shopify/Product/1";
  const B = "gid://shopify/Product/2";
  const two = (a: string, b: string) => [
    { ...productItem("rouge", a), id: A },
    { ...productItem("vert", b), id: B },
  ];

  it("typing in A survives an equal-length change of A, and B shows its own text after the switch", async () => {
    const m = mount({ config: PRODUCTS_CONFIG, item: productItem, key: "title", primary: "rouge", foreign: "noir" });
    await act(async () => { m.hook.rerender({ items: two("noir", "gris"), f: m.fetcher }); });
    await m.flush();
    act(() => m.hook.result.current.handlers.handleValueChange("title", "vert-clair"));
    await act(async () => { m.hook.rerender({ items: two("bleu", "gris"), f: m.fetcher }); });
    await m.flush();
    expect(m.hook.result.current.state.editableValues.title).toBe("vert-clair");
  });

  it("a save of A answered after the switch to B leaves B's text and baseline alone", async () => {
    const m = mount({ config: PRODUCTS_CONFIG, item: productItem, key: "title", primary: "rouge", foreign: "noir" });
    await act(async () => { m.hook.rerender({ items: two("noir", "gris"), f: m.fetcher }); });
    await m.flush();
    act(() => m.hook.result.current.handlers.handleValueChange("title", "bleu"));
    act(() => m.hook.result.current.handlers.handleSave());
    await act(async () => { await m.hook.result.current.handlers.handleItemSelect(B); });
    await m.flush();
    expect(m.hook.result.current.state.selectedItemId).toBe(B);
    await answer(m, two("bleu", "gris"));
    expect(m.hook.result.current.state.editableValues.title).toBe("gris");
    expect(m.hook.result.current.state.hasChanges).toBe(false);
    // B edited and retyped to what A had sent: still B's own change.
    act(() => m.hook.result.current.handlers.handleValueChange("title", "bleu"));
    m.fetcher.submit.mockClear();
    m.fetcher.data = undefined;
    await act(async () => { m.hook.rerender({ items: two("bleu", "gris"), f: { ...m.fetcher } }); });
    act(() => m.hook.result.current.handlers.handleSave());
    expect(sentForm(m.fetcher).title).toBe("bleu");
  });
});

describe("the re-read after a save, whatever the length", () => {
  it("text typed between the answer and the re-read survives a re-read that changes the length", async () => {
    const m = mount({ config: PRODUCTS_CONFIG, item: productItem, key: "title", primary: "rouge", foreign: "noir" });
    await m.flush();
    act(() => m.hook.result.current.handlers.handleValueChange("title", "bleue!"));
    act(() => m.hook.result.current.handlers.handleSave());
    await answer(m, [productItem("rouge", "noir")]);
    act(() => m.hook.result.current.handlers.handleValueChange("title", "typed after the answer"));
    await act(async () => { m.hook.rerender({ items: [productItem("rouge", "bleue!")], f: { ...m.fetcher, data: undefined } }); });
    await m.flush();
    expect(m.hook.result.current.state.editableValues.title).toBe("typed after the answer");
    expect(m.hook.result.current.state.hasChanges).toBe(true);
  });
});
