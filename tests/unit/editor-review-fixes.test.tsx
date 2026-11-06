/**
 * Review round: inherited fields keep their typed text through a re-read (B1),
 * an external change wins over a stale local cache (H1), a refused primary save
 * does not look saved afterwards (H2). Real useUnifiedContentEditor, fake fetcher.
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

type Item = { title: string; frTitle?: string; frSeo?: string; seo?: string };
const item = (o: Item) => ({
  id: "gid://shopify/Product/1",
  title: o.title,
  handle: "h",
  descriptionHtml: "",
  seo: { title: o.seo ?? "", description: "" },
  translations: [
    ...(o.frTitle ? [{ key: "title", locale: "fr", value: o.frTitle }] : []),
    ...(o.frSeo ? [{ key: "seoTitle", locale: "fr", value: o.frSeo }] : []),
  ],
  images: [],
});

function mount(first: Item, locale: "de" | "fr") {
  const fetcher: any = { state: "idle", data: undefined, submit: vi.fn(), load: vi.fn() };
  const props = (items: any[], f: any) => ({
    config: PRODUCTS_CONFIG, items, shopLocales, primaryLocale: "de", fetcher: { ...f },
    showInfoBox: vi.fn(), t: { common: {}, content: {} } as any, initialItemId: items[0].id, initialLocale: locale,
  });
  const hook = renderHook((p: any) => useUnifiedContentEditor(props(p.items, p.f) as any), {
    initialProps: { items: [item(first)], f: fetcher },
  });
  const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });
  const sent = (): Record<string, string> => {
    const fd = fetcher.submit.mock.calls.at(-1)![0] as FormData;
    return Object.fromEntries([...fd.entries()].map(([k, v]) => [k, String(v)]));
  };
  const rerender = async (i: Item, data?: any) => {
    fetcher.data = data;
    await act(async () => { hook.rerender({ items: [item(i)], f: { ...fetcher } }); });
    await flush();
  };
  const v = () => hook.result.current.state.editableValues;
  const h = () => hook.result.current.handlers;
  return { hook, fetcher, flush, sent, rerender, v, h };
}

describe("B1: an inherited field the merchant typed in is stored, whatever re-read lands", () => {
  it.each([
    ["equal length", "bleu"],
    ["different length", "bleue claire"],
  ])("foreign seoTitle, %s change of the inherited source", async (_n, next) => {
    const m = mount({ title: "rouge", frTitle: "noir" }, "fr");
    await m.flush();
    expect(m.v().seoTitle).toBe("noir"); // inherited from the translated title
    act(() => m.h().handleValueChange("seoTitle", "mon titre"));
    await m.rerender({ title: "rouge", frTitle: next });
    expect(m.v().seoTitle).toBe("mon titre");
    expect(m.hook.result.current.state.hasChanges).toBe(true);
    act(() => m.h().handleSave());
    expect(m.fetcher.submit).toHaveBeenCalledTimes(1);
    expect(m.sent().seoTitle).toBe("mon titre");
  });
});

describe("H1: a change made elsewhere wins over the local cache of an earlier save", () => {
  it("foreign: saved bleu, re-read bleu, then gris arrives: the field shows gris and retyping bleu is a change", async () => {
    const m = mount({ title: "rouge", frTitle: "noir" }, "fr");
    await m.flush();
    act(() => m.h().handleValueChange("title", "bleu"));
    act(() => m.h().handleSave());
    await m.rerender({ title: "rouge", frTitle: "noir" }, { success: true, actionType: "updateContent" });
    await m.rerender({ title: "rouge", frTitle: "bleu" }, undefined); // the re-read
    expect(m.v().title).toBe("bleu");
    await m.rerender({ title: "rouge", frTitle: "gris" }); // external
    expect(m.v().title).toBe("gris");
    act(() => m.h().handleValueChange("title", "bleu"));
    expect(m.hook.result.current.state.hasChanges).toBe(true);
    m.fetcher.submit.mockClear();
    act(() => m.h().handleSave());
    expect(m.sent().title).toBe("bleu");
  });

  it("a lagging read right after the save does not revert the fresh save", async () => {
    const m = mount({ title: "rouge", frTitle: "noir" }, "fr");
    await m.flush();
    act(() => m.h().handleValueChange("title", "bleu"));
    act(() => m.h().handleSave());
    await m.rerender({ title: "rouge", frTitle: "noir" }, { success: true, actionType: "updateContent" });
    await m.rerender({ title: "rouge", frTitle: "noir" }); // still the OLD value (lag)
    expect(m.v().title).toBe("bleu");
    expect(m.hook.result.current.state.hasChanges).toBe(false);
  });

  it("primary with an empty SEO title: saved verte, then bleue arrives: bleue is shown, retyping verte is a change", async () => {
    const m = mount({ title: "rouge" }, "de");
    await m.flush();
    act(() => m.h().handleValueChange("title", "verte"));
    act(() => m.h().handleSave());
    await m.rerender({ title: "rouge" }, { success: true, actionType: "updateContent" });
    await m.rerender({ title: "verte" });
    expect(m.v().title).toBe("verte");
    await m.rerender({ title: "bleue" });
    expect(m.v().title).toBe("bleue");
    act(() => m.h().handleValueChange("title", "verte"));
    expect(m.hook.result.current.state.hasChanges).toBe(true);
    m.fetcher.submit.mockClear();
    act(() => m.h().handleSave());
    expect(m.sent().title).toBe("verte");
  });
});

describe("H2: a refused save does not look saved", () => {
  it("after {success:false, rateLimited:true} the unsent primary text stays a change, also after a data move", async () => {
    const m = mount({ title: "rouge" }, "de");
    await m.flush();
    act(() => m.h().handleValueChange("title", "verte"));
    act(() => m.h().handleSave());
    await m.rerender({ title: "rouge" }, { success: false, error: "busy", rateLimited: true, actionType: "updateContent" });
    expect(m.v().title).toBe("verte");
    expect(m.hook.result.current.state.hasChanges).toBe(true);
    // an unrelated move of the data
    await m.rerender({ title: "rouge", seo: "x" });
    expect(m.v().title).toBe("verte");
    expect(m.hook.result.current.state.hasChanges).toBe(true);
  });
});

describe("M2: a refused translate-all on a theme page releases its spinner", () => {
  it("the fetcher path clears __translateAll__ on a failed answer", async () => {
    const THEME = "gid://shopify/OnlineStoreThemeJsonTemplate/9";
    const themeItem = () => ({
      id: THEME, groupName: "hero", title: "Hero",
      translatableContent: [{ key: "sections.hero.heading", value: "Bonjour", digest: "d" }],
      translations: [],
    });
    const fetcher: any = { state: "idle", data: undefined, submit: vi.fn(), load: vi.fn() };
    const mk = (f: any) => ({
      config: TEMPLATES_CONFIG, items: [themeItem()], shopLocales, primaryLocale: "de", fetcher: { ...f },
      showInfoBox: vi.fn(), t: { common: {}, content: {} } as any, initialItemId: THEME, initialLocale: "de",
    });
    const hook = renderHook((f: any) => useUnifiedContentEditor(mk(f) as any), { initialProps: fetcher });
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    act(() => { hook.result.current.handlers.handleTranslateAll(); });
    expect(fetcher.submit).toHaveBeenCalledTimes(1);
    expect(isOperationActive(THEME, "__translateAll__")).toBe(true);
    fetcher.data = { success: false, error: "busy", rateLimited: true };
    await act(async () => { hook.rerender({ ...fetcher }); });
    expect(isOperationActive(THEME, "__translateAll__")).toBe(false);
  });
});

describe("H4: a field Shopify did not confirm keeps its old baseline and is sent again", () => {
  it("foreign save with unconfirmedFields: still a change, the next Save carries it", async () => {
    const m = mount({ title: "rouge", frTitle: "noir" }, "fr");
    await m.flush();
    act(() => m.h().handleValueChange("title", "bleu"));
    act(() => m.h().handleSave());
    await m.rerender({ title: "rouge", frTitle: "noir" }, { success: true, actionType: "updateContent", unconfirmedFields: ["title"] });
    expect(m.hook.result.current.state.hasChanges).toBe(true);
    m.fetcher.submit.mockClear();
    m.fetcher.data = undefined;
    act(() => m.h().handleSave());
    expect(m.fetcher.submit).toHaveBeenCalledTimes(1);
    expect(m.sent().title).toBe("bleu");
  });
});
