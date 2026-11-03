/**
 * Third review round, editor side. Real useUnifiedContentEditor, fake fetcher.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";

vi.mock("react-router", async (orig) => ({
  ...(await orig<typeof import("react-router")>()),
  useRevalidator: () => ({ state: "idle", revalidate: vi.fn() }),
}));
vi.mock("~/contexts/TaskCountContext", () => ({
  useTaskCount: () => ({ refresh: vi.fn(), tasks: [], recentlyCompletedTasks: [], count: 0 }),
}));
vi.mock("~/utils/app-fetch", () => ({
  appFetch: () => new Promise(() => {}),
  appFetchJson: () => new Promise(() => {}),
}));

import { useUnifiedContentEditor } from "~/hooks/useUnifiedContentEditor";
import { PRODUCTS_CONFIG, TEMPLATES_CONFIG } from "~/config/content-fields.config";
import { isOperationActive } from "~/hooks/useAIOperationsStore";

const shopLocales = [
  { locale: "de", name: "Deutsch", primary: true, published: true },
  { locale: "fr", name: "Francais", primary: false, published: true },
] as any;
const A = "gid://shopify/Product/1";
const B = "gid://shopify/Product/2";
const MARKET = "gid://shopify/Market/7";
const infoBox = vi.fn();

type P = { id: string; title: string; frTitle?: string; frSeo?: string; marketFr?: string; seoDesc?: string };
const product = (o: P) => ({
  id: o.id,
  title: o.title,
  handle: "h",
  descriptionHtml: "",
  seo: { title: "", description: o.seoDesc ?? "" },
  translations: [
    ...(o.frTitle ? [{ key: "title", locale: "fr", value: o.frTitle }] : []),
    ...(o.frSeo ? [{ key: "seoTitle", locale: "fr", value: o.frSeo }] : []),
  ],
  marketTranslations: o.marketFr ? { [MARKET]: { title: { fr: o.marketFr } } } : {},
  images: [],
});

function mount(first: P[], locale: "de" | "fr", config: any = PRODUCTS_CONFIG, build: (p: any) => any = product) {
  const fetcher: any = { state: "idle", data: undefined, submit: vi.fn(), load: vi.fn() };
  const props = (items: any[], f: any) => ({
    config, items, shopLocales, primaryLocale: "de", fetcher: { ...f }, showInfoBox: infoBox,
    t: { common: {}, content: {} } as any, initialItemId: items[0].id, initialLocale: locale,
    markets: [{ id: MARKET, name: "CH", locales: ["fr"] }] as any,
  });
  const hook = renderHook((p: any) => useUnifiedContentEditor(props(p.items, p.f) as any), {
    initialProps: { items: first.map(build), f: fetcher },
  });
  const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });
  const sent = (): Record<string, string> => {
    const fd = fetcher.submit.mock.calls.at(-1)![0] as FormData;
    return Object.fromEntries([...fd.entries()].map(([k, v]) => [k, String(v)]));
  };
  const rerender = async (items: P[], data?: any) => {
    fetcher.data = data;
    await act(async () => { hook.rerender({ items: items.map(build), f: { ...fetcher } }); });
    await flush();
  };
  const v = () => hook.result.current.state.editableValues;
  const h = () => hook.result.current.handlers;
  const dirty = () => hook.result.current.state.hasChanges;
  return { hook, fetcher, flush, sent, rerender, v, h, dirty };
}

beforeEach(() => { infoBox.mockReset(); });

describe("BLOCKER 1: a save refused after a product switch does not look saved", () => {
  it("back on A the text is not shown as stored, and the message names the product", async () => {
    const m = mount([{ id: A, title: "rouge" }, { id: B, title: "vert" }], "de");
    await m.flush();
    act(() => m.h().handleValueChange("title", "verte2"));
    act(() => m.h().handleSave());
    await act(async () => { await m.h().handleItemSelect(B); });
    await m.flush();
    expect(m.hook.result.current.state.selectedItemId).toBe(B);
    await m.rerender([{ id: A, title: "rouge" }, { id: B, title: "vert" }], { success: false, error: "busy", rateLimited: true });
    expect(infoBox.mock.calls.some((c) => String(c[0]).includes("rouge"))).toBe(true);
    await act(async () => { await m.h().handleItemSelect(A); });
    await m.flush();
    expect(m.v().title).toBe("rouge");
    expect(m.dirty()).toBe(false);
  });
});

describe("BLOCKER 2: foreign text typed between submit and answer survives", () => {
  it("stays a change and survives the re-read", async () => {
    const m = mount([{ id: A, title: "rouge", frTitle: "noir" }], "fr");
    await m.flush();
    act(() => m.h().handleValueChange("title", "bleu"));
    act(() => m.h().handleSave());
    act(() => m.h().handleValueChange("title", "bleu et plus"));
    await m.rerender([{ id: A, title: "rouge", frTitle: "noir" }], { success: true, actionType: "updateContent" });
    expect(m.dirty()).toBe(true);
    await m.rerender([{ id: A, title: "rouge", frTitle: "bleu" }]);
    expect(m.v().title).toBe("bleu et plus");
    expect(m.dirty()).toBe(true);
  });
});

describe("a stale or blank read does not revert a fresh save, and the bridging really runs a pass", () => {
  const saved = async (locale: "de" | "fr") => {
    const m = mount([{ id: A, title: "rouge", frTitle: "noir" }], locale);
    await m.flush();
    act(() => m.h().handleValueChange("title", "bleu"));
    act(() => m.h().handleSave());
    const base = locale === "de" ? { id: A, title: "rouge", frTitle: "noir" } : { id: A, title: "rouge", frTitle: "noir" };
    await m.rerender([base], { success: true, actionType: "updateContent" });
    // the read that shows the saved value
    await m.rerender([locale === "de" ? { id: A, title: "bleu", frTitle: "noir" } : { id: A, title: "rouge", frTitle: "bleu" }]);
    expect(m.v().title).toBe("bleu");
    return m;
  };
  it.each(["fr", "de"] as const)("%s: an older read (the value before the save) with another field moved: stays", async (locale) => {
    const m = await saved(locale);
    // a pass that really runs (another field moved), showing the OLD value
    await m.rerender([{ id: A, title: "rouge", frTitle: "noir", frSeo: "seo-x", seoDesc: "d" }]);
    expect(m.v().title).toBe("bleu");
    expect(m.dirty()).toBe(false);
  });
  it.each(["fr"] as const)("%s: a read with momentarily no translations: stays", async (locale) => {
    const m = await saved(locale);
    await m.rerender([{ id: A, title: "rouge", frSeo: "seo-x" }]);
    expect(m.v().title).toBe("bleu");
  });
  it("an external third value still wins", async () => {
    const m = await saved("fr");
    await m.rerender([{ id: A, title: "rouge", frTitle: "gris" }]);
    expect(m.v().title).toBe("gris");
    // and a pass that follows it does not bring the cache back
    await m.rerender([{ id: A, title: "rouge", frTitle: "gris", frSeo: "x" }]);
    expect(m.v().title).toBe("gris");
  });
  it("first pass after a switch does not yield: A's saved text bridges a lagging read after switching back", async () => {
    const m = mount([{ id: A, title: "rouge" }, { id: B, title: "vert" }], "de");
    await m.flush();
    act(() => m.h().handleValueChange("title", "verte2"));
    act(() => m.h().handleSave());
    await m.rerender([{ id: A, title: "rouge" }, { id: B, title: "vert" }], { success: true, actionType: "updateContent" });
    await act(async () => { await m.h().handleItemSelect(B); });
    await m.flush();
    await act(async () => { await m.h().handleItemSelect(A); });
    await m.flush();
    expect(m.v().title).toBe("verte2");
  });
});

describe("market views yield to a change in THAT market", () => {
  it("a market value changed elsewhere wins over the staged one", async () => {
    const m = mount([{ id: A, title: "rouge", frTitle: "noir", marketFr: "noir CH" }], "fr");
    await m.flush();
    await act(async () => { m.h().handleMarketChange(MARKET); });
    await m.flush();
    expect(m.v().title).toBe("noir CH");
    act(() => m.h().handleValueChange("title", "bleu CH"));
    act(() => m.h().handleSave());
    await m.rerender([{ id: A, title: "rouge", frTitle: "noir", marketFr: "noir CH" }], { success: true, actionType: "updateContent" });
    await m.rerender([{ id: A, title: "rouge", frTitle: "noir", marketFr: "bleu CH" }]);
    expect(m.v().title).toBe("bleu CH");
    await m.rerender([{ id: A, title: "rouge", frTitle: "noir", marketFr: "gris CH" }]);
    expect(m.v().title).toBe("gris CH");
  });
});

describe("a refused main-language save does not look saved (every failure shape)", () => {
  it.each([
    ["errorKey", { success: false, errorKey: "someKey" }],
    ["neither error nor key", { success: false, actionType: "updateContent" }],
    ["error", { success: false, error: "x" }],
  ])("%s", async (_n, answer) => {
    const m = mount([{ id: A, title: "rouge" }], "de");
    await m.flush();
    act(() => m.h().handleValueChange("title", "verte"));
    act(() => m.h().handleSave());
    await m.rerender([{ id: A, title: "rouge" }], answer);
    await m.rerender([{ id: A, title: "rouge", seoDesc: "moved" }]);
    expect(m.v().title).toBe("verte");
    expect(m.dirty()).toBe(true);
  });
});

describe("translate runs: a refused answer releases the spinner, a tracked run is protected", () => {
  const THEME = "gid://shopify/OnlineStoreThemeJsonTemplate/9";
  const theme = (_: any) => ({
    id: THEME, groupName: "hero", title: "Hero",
    translatableContent: [{ key: "sections.hero.heading", value: "Bonjour", digest: "d" }],
    translations: [],
  });
  it("translate-one-language on a theme page", async () => {
    const m = mount([{ id: THEME, title: "x" }], "fr", TEMPLATES_CONFIG, theme);
    await m.flush();
    act(() => { m.h().handleTranslateAllForLocale(); });
    expect(m.fetcher.submit).toHaveBeenCalledTimes(1);
    expect(isOperationActive(THEME, "__translateAllForLocale__fr")).toBe(true);
    await m.rerender([{ id: THEME, title: "x" }], { success: false, error: "busy", rateLimited: true });
    expect(isOperationActive(THEME, "__translateAllForLocale__fr")).toBe(false);
    // the retry is not refused
    m.fetcher.submit.mockClear();
    act(() => { m.h().handleTranslateAllForLocale(); });
    expect(m.fetcher.submit).toHaveBeenCalledTimes(1);
  });
  it("translate-all with a tracked run of the item out: a refused save answer does not drop its spinner", async () => {
    window.history.pushState({}, "", "/app/products");
    const m = mount([{ id: A, title: "rouge" }], "de");
    await m.flush();
    act(() => { m.h().handleTranslateAll(); });
    expect(isOperationActive(A, "__translateAll__")).toBe(true);
    await m.rerender([{ id: A, title: "rouge" }], { success: false, error: "busy", rateLimited: true });
    expect(isOperationActive(A, "__translateAll__")).toBe(true);
    window.history.pushState({}, "", "/");
  });
});
