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
const runControl = vi.hoisted(() => ({ finish: null as null | ((v: unknown) => void), calls: 0 }));
vi.mock("~/utils/app-fetch", () => ({
  appFetch: () => new Promise(() => {}),
  // The translate run of a product page: pending until a test lets it end.
  appFetchJson: () => new Promise((resolve) => { runControl.calls++; runControl.finish = resolve; }),
}));

import { useUnifiedContentEditor } from "~/hooks/useUnifiedContentEditor";
import { PRODUCTS_CONFIG, TEMPLATES_CONFIG } from "~/config/content-fields.config";
import { isOperationActive } from "~/hooks/useAIOperationsStore";
import { setFieldSuggestion } from "~/hooks/useAISuggestionStore";

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

describe("BLOCKER 1b: the answer still held in fetcher.data is not the abandoned save's answer", () => {
  it("an earlier success on the fetcher does not consume the abandoned save; its later refusal is still recognised", async () => {
    const items = [{ id: A, title: "rouge" }, { id: B, title: "vert" }];
    const m = mount(items, "de");
    await m.flush();
    act(() => m.h().handleValueChange("title", "v1"));
    act(() => m.h().handleSave());
    // First save answered: its answer stays on the fetcher.
    await m.rerender(items, { success: true, actionType: "updateContent" });
    const first = m.fetcher.data;
    act(() => m.h().handleValueChange("title", "v2"));
    act(() => m.h().handleSave());
    await act(async () => { await m.h().handleItemSelect(B); });
    await m.flush();
    // Re-renders while the second save is still out: fetcher.data is still the FIRST answer.
    await m.rerender(items, first);
    await m.rerender(items, first);
    expect(infoBox.mock.calls.some((c) => String(c[0]).includes("rouge"))).toBe(false);
    await m.rerender(items, { success: false, error: "busy", rateLimited: true });
    expect(infoBox.mock.calls.some((c) => c[1] === "critical" && String(c[0]).includes("rouge"))).toBe(true);
    await act(async () => { await m.h().handleItemSelect(A); });
    await m.flush();
    expect(m.v().title).not.toBe("v2");
  });
});

describe("BLOCKER 1c: switching away and back before the answer", () => {
  it("the refusal is still recognised and the text does not look saved", async () => {
    const items = [{ id: A, title: "rouge" }, { id: B, title: "vert" }];
    const m = mount(items, "de");
    await m.flush();
    act(() => m.h().handleValueChange("title", "verte2"));
    act(() => m.h().handleSave());
    await act(async () => { await m.h().handleItemSelect(B); });
    await m.flush();
    await act(async () => { await m.h().handleItemSelect(A); });
    await m.flush();
    await m.rerender(items, { success: false, error: "busy", rateLimited: true });
    expect(infoBox.mock.calls.some((c) => c[1] === "critical")).toBe(true);
    await m.rerender([{ id: A, title: "rouge", seoDesc: "moved" }, items[1]]);
    expect(m.v().title).toBe("rouge");
  });
});

describe("H1: an abandoned save answered while the next item's save is queued behind it", () => {
  const items = [{ id: A, title: "rouge" }, { id: B, title: "vert" }];
  const setup = async () => {
    const m = mount(items, "de");
    await m.flush();
    act(() => m.h().handleValueChange("title", "rouge2"));
    act(() => m.h().handleSave());
    m.fetcher.state = "submitting";
    await m.rerender(items);
    await act(async () => { await m.h().handleItemSelect(B); });
    await m.flush();
    act(() => m.h().handleValueChange("seoTitle", "seoB"));
    act(() => m.h().handleSave());
    return m;
  };
  it("a refusal is shown with the abandoned product's name, and not as B's", async () => {
    const m = await setup();
    infoBox.mockClear();
    m.fetcher.state = "idle";
    await m.rerender(items, { success: false, error: "busy", rateLimited: true });
    const critical = infoBox.mock.calls.filter((c) => c[1] === "critical");
    expect(critical.length).toBe(1);
    expect(String(critical[0][0])).toContain("rouge");
  });
  it("a success is not applied to B: no 'saved' message, B's save is still pending", async () => {
    const m = await setup();
    infoBox.mockClear();
    const submits = m.fetcher.submit.mock.calls.length;
    m.fetcher.state = "idle";
    await m.rerender(items, { success: true, actionType: "updateContent" });
    expect(infoBox).not.toHaveBeenCalled();
    // B's own queued save goes out after A's answer
    expect(m.fetcher.submit.mock.calls.length).toBe(submits + 1);
    expect(m.sent().itemId).toBe(B);
    expect(m.sent().seoTitle).toBe("seoB");
  });
});

describe("M1b: only an answer of a save can be the abandoned save's answer", () => {
  it("another request's failure does not consume the record; the real refusal is still recognised", async () => {
    const items = [{ id: A, title: "rouge" }, { id: B, title: "vert" }];
    const m = mount(items, "de");
    await m.flush();
    act(() => m.h().handleValueChange("title", "rouge2"));
    act(() => m.h().handleSave());
    m.fetcher.state = "submitting";
    await m.rerender(items);
    await act(async () => { await m.h().handleItemSelect(B); });
    await m.flush();
    infoBox.mockClear();
    await m.rerender(items, { success: false, error: "other", actionType: "generateAIText" });
    expect(infoBox.mock.calls.some((c) => String(c[0]).includes("rouge"))).toBe(false);
    await m.rerender(items, { success: false, error: "busy", rateLimited: true });
    expect(infoBox.mock.calls.some((c) => c[1] === "critical" && String(c[0]).includes("rouge"))).toBe(true);
  });
});

describe("R5 critical: a refused save does not forget what a newer save of the same field cached", () => {
  it("an own AI save queued behind the refused full save", async () => {
    const items = [{ id: A, title: "rouge" }];
    const m = mount(items, "de");
    await m.flush();
    act(() => m.h().handleValueChange("title", "rouge2"));
    act(() => m.h().handleSave());
    m.fetcher.state = "submitting";
    await m.rerender(items);
    act(() => setFieldSuggestion({ resourceId: A, locale: "de", marketId: "" }, "title", "rouge3"));
    await m.flush();
    await act(async () => { m.h().handleAcceptSuggestion("title"); });
    await m.flush();
    m.fetcher.state = "idle";
    await m.rerender(items, { success: false, error: "busy", rateLimited: true });
    expect(m.sent().title).toBe("rouge3");
    await m.rerender(items, { success: true, actionType: "updateContent", n: 2 });
    await m.rerender([{ id: A, title: "rouge", seoDesc: "lag" }]);
    expect(m.v().title).toBe("rouge3");
  });
  it("a second Save press queued behind the refused one", async () => {
    const items = [{ id: A, title: "rouge" }];
    const m = mount(items, "de");
    await m.flush();
    act(() => m.h().handleValueChange("title", "rouge2"));
    act(() => m.h().handleSave());
    m.fetcher.state = "submitting";
    await m.rerender(items);
    act(() => m.h().handleValueChange("title", "rouge3"));
    act(() => m.h().handleSave());
    m.fetcher.state = "idle";
    await m.rerender(items, { success: false, error: "busy", rateLimited: true });
    expect(m.sent().title).toBe("rouge3");
    await m.rerender(items, { success: true, actionType: "updateContent", n: 2 });
    await m.rerender([{ id: A, title: "rouge", seoDesc: "lag" }]);
    expect(m.v().title).toBe("rouge3");
  });
  it("a re-save after switching away and back, while the first is still out", async () => {
    const items = [{ id: A, title: "rouge" }, { id: B, title: "vert" }];
    const m = mount(items, "de");
    await m.flush();
    act(() => m.h().handleValueChange("title", "rouge2"));
    act(() => m.h().handleSave());
    m.fetcher.state = "submitting";
    await m.rerender(items);
    await act(async () => { await m.h().handleItemSelect(B); });
    await m.flush();
    await act(async () => { await m.h().handleItemSelect(A); });
    await m.flush();
    act(() => m.h().handleValueChange("title", "rouge3"));
    act(() => m.h().handleSave());
    m.fetcher.state = "idle";
    await m.rerender(items, { success: false, error: "busy", rateLimited: true });
    expect(m.sent().title).toBe("rouge3");
    await m.rerender(items, { success: true, actionType: "updateContent", n: 2 });
    await m.rerender([{ id: A, title: "rouge", seoDesc: "lag" }, items[1]]);
    expect(m.v().title).toBe("rouge3");
  });
});

describe("R5 high 1: an abandoned answer is not applied to the item on screen", () => {
  it("foreign: B's unsent text is not staged as stored by A's answer", async () => {
    const items = [{ id: A, title: "rouge", frTitle: "noirA" }, { id: B, title: "vert", frTitle: "noirB" }];
    const m = mount(items, "fr");
    await m.flush();
    act(() => m.h().handleValueChange("title", "A-new"));
    act(() => m.h().handleSave());
    m.fetcher.state = "submitting";
    await m.rerender(items);
    await act(async () => { await m.h().handleItemSelect(B); });
    await m.flush();
    act(() => m.h().handleValueChange("seoTitle", "seoB"));
    act(() => m.h().handleSave());
    m.fetcher.state = "idle";
    await m.rerender(items, { success: true, actionType: "updateContent" });
    // B's own save goes out; its refusal leaves B showing what Shopify holds for the title
    await m.rerender([items[0], { ...items[1], seoDesc: "x" } as any]);
    await m.rerender(items, { success: false, error: "busy", rateLimited: true });
    await m.rerender([items[0], { ...items[1], frSeo: "seoB" } as any]);
    expect(m.v().title).toBe("noirB");
  });
  it("primary: A's market purge marks are not applied to B and B's real answer is still processed", async () => {
    const items = [{ id: A, title: "rouge" }, { id: B, title: "vert" }];
    const m = mount(items, "de");
    await m.flush();
    act(() => m.h().handleValueChange("title", "rouge2"));
    act(() => m.h().handleSave());
    m.fetcher.state = "submitting";
    await m.rerender(items);
    await act(async () => { await m.h().handleItemSelect(B); });
    await m.flush();
    act(() => m.h().handleValueChange("seoTitle", "seoB"));
    act(() => m.h().handleSave());
    m.fetcher.state = "idle";
    await m.rerender(items, { success: true, actionType: "updateContent", marketPurgedFields: ["title"] });
    expect(m.fetcher.submit.mock.calls.length).toBe(2);
    expect(m.sent().itemId).toBe(B);
    // B's answer: the save is settled (not skipped as "no saved locale")
    await m.rerender(items, { success: true, actionType: "updateContent", n: 2 });
    expect(m.dirty()).toBe(false);
  });
});

describe("R5 high 2: an abandoned refusal does not wipe what B's merchant typed during B's save", () => {
  it("B's typed field stays a change", async () => {
    const items = [{ id: A, title: "rouge", frTitle: "noirA" }, { id: B, title: "vert", frTitle: "noirB" }];
    const m = mount(items, "fr");
    await m.flush();
    act(() => m.h().handleValueChange("seoTitle", "seoA"));
    act(() => m.h().handleSave());
    m.fetcher.state = "submitting";
    await m.rerender(items);
    await act(async () => { await m.h().handleItemSelect(B); });
    await m.flush();
    act(() => m.h().handleValueChange("seoTitle", "seoB"));
    act(() => m.h().handleSave());
    await m.flush();
    act(() => m.h().handleValueChange("title", "typedB"));
    m.fetcher.state = "idle";
    await m.rerender(items, { success: false, error: "busy", rateLimited: true });
    await m.rerender(items, { success: true, actionType: "updateContent", n: 2 });
    expect(m.dirty()).toBe(true);
    await m.rerender([items[0], { ...items[1], frSeo: "seoB" } as any]);
    expect(m.v().title).toBe("typedB");
    expect(m.dirty()).toBe(true);
  });
});

describe("R5 medium: text typed while a save is only HELD behind a translate run stays a change", () => {
  it("the held save's answer does not mark it saved", async () => {
    window.history.pushState({}, "", "/app/products");
    const items = [{ id: A, title: "rouge", frTitle: "noir" }];
    const m = mount(items, "fr");
    await m.flush();
    act(() => { m.h().handleTranslateAll(); });
    act(() => m.h().handleValueChange("title", "bleu"));
    act(() => m.h().handleSave());
    await m.flush();
    expect(m.fetcher.submit).not.toHaveBeenCalled(); // held, the pending flag is down
    act(() => m.h().handleValueChange("seoTitle", "typed-while-held"));
    // the run ends (refused): the held save goes out
    await act(async () => { runControl.finish?.({ data: { success: false, error: "busy" } }); await new Promise((r) => setTimeout(r, 50)); });
    expect(m.fetcher.submit).toHaveBeenCalledTimes(1);
    await m.rerender(items, { success: true, actionType: "updateContent" });
    expect(m.dirty()).toBe(true);
    window.history.pushState({}, "", "/");
  });
});

describe("R7 H1: a refused newer save gives back what an earlier save confirmed", () => {
  const run = async (second: "refused" | "success") => {
    const items = [{ id: A, title: "rouge" }];
    const m = mount(items, "de");
    await m.flush();
    act(() => m.h().handleValueChange("title", "rouge2"));
    act(() => m.h().handleSave());
    m.fetcher.state = "submitting";
    await m.rerender(items);
    act(() => m.h().handleValueChange("seoTitle", "seo2"));
    act(() => m.h().handleSave());
    m.fetcher.state = "idle";
    await m.rerender(items, { success: true, actionType: "updateContent" });
    await m.rerender(items, second === "refused"
      ? { success: false, error: "busy", rateLimited: true, actionType: "updateContent" }
      : { success: true, actionType: "updateContent", n: 2 });
    await m.rerender([{ id: A, title: "rouge", seoDesc: "lag" }]);
    return m;
  };
  it("P4: A confirmed, B (same title) refused: a lagging read does not revert the title", async () => {
    const m = await run("refused");
    expect(m.v().title).toBe("rouge2");
  });
  it("P4c control: B answered too", async () => {
    const m = await run("success");
    expect(m.v().title).toBe("rouge2");
  });
  it("a refusal with NO earlier confirmation still forgets its text (nothing is stored)", async () => {
    const items = [{ id: A, title: "rouge" }];
    const m = mount(items, "de");
    await m.flush();
    act(() => m.h().handleValueChange("title", "rouge2"));
    act(() => m.h().handleSave());
    await m.rerender(items, { success: false, error: "busy", rateLimited: true, actionType: "updateContent" });
    await m.rerender([{ id: A, title: "rouge", seoDesc: "lag" }]);
    expect(m.v().title).toBe("rouge2"); // the draft stays on screen
    expect(m.dirty()).toBe(true);
  });
});

describe("R7 H2: text typed after the second press stays a change when the FIRST save answers", () => {
  const run = async (first: any) => {
    const items = [{ id: A, title: "rouge", frTitle: "noir" }];
    const m = mount(items, "fr");
    await m.flush();
    act(() => m.h().handleValueChange("title", "bleu"));
    act(() => m.h().handleSave());
    m.fetcher.state = "submitting";
    await m.rerender(items);
    act(() => m.h().handleValueChange("title", "bleu2"));
    act(() => m.h().handleSave());
    await m.flush();
    act(() => m.h().handleValueChange("seoTitle", "typed"));
    m.fetcher.state = "idle";
    await m.rerender(items, first);
    await m.rerender(items, { success: true, actionType: "updateContent", n: 2 });
    expect(m.dirty()).toBe(true);
    await m.rerender([{ id: A, title: "rouge", frTitle: "bleu2" }]);
    expect(m.v().seoTitle).toBe("typed");
    expect(m.dirty()).toBe(true);
  };
  it("P1: A success, B success", async () => { await run({ success: true, actionType: "updateContent" }); });
  it("P2: A refused, B success", async () => { await run({ success: false, error: "busy", rateLimited: true, actionType: "updateContent" }); });
});

describe("R7 M1: an abandoned success still tells the merchant what the answer says", () => {
  it("the purge warning is shown with the product's name", async () => {
    const items = [{ id: A, title: "rouge" }, { id: B, title: "vert" }];
    const m = mount(items, "de");
    await m.flush();
    act(() => m.h().handleValueChange("title", "rouge2"));
    act(() => m.h().handleSave());
    m.fetcher.state = "submitting";
    await m.rerender(items);
    await act(async () => { await m.h().handleItemSelect(B); });
    await m.flush();
    act(() => m.h().handleValueChange("seoTitle", "seoB"));
    act(() => m.h().handleSave());
    infoBox.mockClear();
    m.fetcher.state = "idle";
    await m.rerender(items, { success: true, actionType: "updateContent", warnings: ["translationPurgeUnconfirmed"] });
    const shown = infoBox.mock.calls.filter((c) => String(c[0]).includes("rouge"));
    expect(shown.length).toBe(1);
    expect(shown[0][1]).toBe("warning");
  });
});

describe("M1: the record of an abandoned save does not outlive its answer", () => {
  it("a later unrelated failure is not shown as the abandoned product's refusal", async () => {
    const items = [{ id: A, title: "rouge", frTitle: "noirA" }, { id: B, title: "vert", frTitle: "noirB" }];
    const m = mount(items, "de");
    await m.flush();
    act(() => m.h().handleValueChange("title", "rouge2"));
    act(() => m.h().handleSave());
    m.fetcher.state = "submitting";
    await m.rerender(items);
    await act(async () => { await m.h().handleItemSelect(B); });
    await m.flush();
    act(() => m.h().handleValueChange("seoTitle", "seoB"));
    act(() => m.h().handleSave());
    m.fetcher.state = "idle";
    await m.rerender(items, { success: true, actionType: "updateContent" });
    await m.rerender(items, { success: true, actionType: "updateContent", n: 2 });
    infoBox.mockClear();
    await m.rerender(items, { success: false, error: "unrelated", actionType: "generateAIText" });
    expect(infoBox.mock.calls.some((c) => String(c[0]).includes("rouge"))).toBe(false);
  });
});

describe("H1: a saved overlay has an absolute end", () => {
  it("after the server moved back to the pre-save value the overlay still ends, and shows what Shopify holds", async () => {
    const real = Date.now();
    let offset = 0;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => real + offset);
    try {
      const m = mount([{ id: A, title: "rouge" }], "de");
      await m.flush();
      act(() => m.h().handleValueChange("title", "bleu"));
      act(() => m.h().handleSave());
      await m.rerender([{ id: A, title: "rouge" }], { success: true, actionType: "updateContent" });
      await m.rerender([{ id: A, title: "bleu" }]);
      // somebody else put the old text back
      await m.rerender([{ id: A, title: "rouge", seoDesc: "x" }]);
      expect(m.v().title).toBe("bleu");
      offset = 2 * 60_000; // past the bridge after the first catch-up, well before the hard cap
      await m.rerender([{ id: A, title: "rouge", seoDesc: "y" }]);
      expect(m.v().title).toBe("rouge");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("H1b: an overlay the server never confirmed ends at the hard cap", () => {
  it("shows what Shopify holds after ten minutes", async () => {
    const real = Date.now();
    let offset = 0;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => real + offset);
    try {
      const m = mount([{ id: A, title: "rouge" }], "de");
      await m.flush();
      act(() => m.h().handleValueChange("title", "bleu"));
      act(() => m.h().handleSave());
      await m.rerender([{ id: A, title: "rouge" }], { success: true, actionType: "updateContent" });
      await m.rerender([{ id: A, title: "rouge", seoDesc: "x" }]);
      expect(m.v().title).toBe("bleu");
      offset = 11 * 60_000;
      await m.rerender([{ id: A, title: "rouge", seoDesc: "y" }]);
      expect(m.v().title).toBe("rouge");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("C1: a second save of the same field does not turn the first one's value into a third value", () => {
  it.each(["de", "fr"] as const)("%s: a lagging read showing the first save's value keeps the second save", async (locale) => {
    const base = (t: string): P => (locale === "de" ? { id: A, title: t, frTitle: "noir" } : { id: A, title: "rouge", frTitle: t });
    const m = mount([base(locale === "de" ? "rouge" : "noir")], locale);
    await m.flush();
    act(() => m.h().handleValueChange("title", "bleu"));
    act(() => m.h().handleSave());
    await m.rerender([base(locale === "de" ? "rouge" : "noir")], { success: true, actionType: "updateContent" });
    await m.rerender([base("bleu")]);
    act(() => m.h().handleValueChange("title", "vert"));
    act(() => m.h().handleSave());
    await m.rerender([base("bleu")], { success: true, actionType: "updateContent" });
    // reads that lag: first the value from before any save, then the FIRST save's value
    await m.rerender([{ ...base(locale === "de" ? "rouge" : "noir"), frSeo: "seo-y", seoDesc: "y" }]);
    expect(m.v().title).toBe("vert");
    await m.rerender([{ ...base("bleu"), frSeo: "seo-z", seoDesc: "z" }]);
    expect(m.v().title).toBe("vert");
  });
});

describe("M2: the foreign overlay has an absolute end too", () => {
  it("shows what Shopify holds after the server moved back, once the clock ran out", async () => {
    const real = Date.now();
    let offset = 0;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => real + offset);
    try {
      const m = mount([{ id: A, title: "rouge", frTitle: "noir" }], "fr");
      await m.flush();
      act(() => m.h().handleValueChange("title", "bleu"));
      act(() => m.h().handleSave());
      await m.rerender([{ id: A, title: "rouge", frTitle: "noir" }], { success: true, actionType: "updateContent" });
      await m.rerender([{ id: A, title: "rouge", frTitle: "bleu" }]);
      await m.rerender([{ id: A, title: "rouge", frTitle: "noir", seoDesc: "x" }]);
      expect(m.v().title).toBe("bleu");
      offset = 2 * 60_000;
      await m.rerender([{ id: A, title: "rouge", frTitle: "noir", seoDesc: "y" }]);
      expect(m.v().title).toBe("noir");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("H2: a lagging read after switching away and back does not revert a caught-up save", () => {
  it("shows the saved text, not the pre-save one", async () => {
    const items = [{ id: A, title: "rouge" }, { id: B, title: "vert" }];
    const m = mount(items, "de");
    await m.flush();
    act(() => m.h().handleValueChange("title", "bleu"));
    act(() => m.h().handleSave());
    await m.rerender(items, { success: true, actionType: "updateContent" });
    await m.rerender([{ id: A, title: "bleu" }, items[1]]);
    await act(async () => { await m.h().handleItemSelect(B); });
    await m.flush();
    await act(async () => { await m.h().handleItemSelect(A); });
    await m.flush();
    await m.rerender([{ id: A, title: "rouge", seoDesc: "moved" }, items[1]]);
    expect(m.v().title).toBe("bleu");
  });
});

describe("a third value written elsewhere while the merchant was on another product wins on the first read back", () => {
  it("shows the external value, not the cached save", async () => {
    const items = [{ id: A, title: "rouge" }, { id: B, title: "vert" }];
    const m = mount(items, "de");
    await m.flush();
    act(() => m.h().handleValueChange("title", "bleu"));
    act(() => m.h().handleSave());
    await m.rerender(items, { success: true, actionType: "updateContent" });
    await m.rerender([{ id: A, title: "bleu" }, items[1]]);
    await act(async () => { await m.h().handleItemSelect(B); });
    await m.flush();
    // written elsewhere while B is on screen
    await m.rerender([{ id: A, title: "gris", seoDesc: "moved" }, items[1]]);
    await act(async () => { await m.h().handleItemSelect(A); });
    await m.flush();
    expect(m.v().title).toBe("gris");
  });
});

describe("H3: foreign text typed during flight in a field the save did not carry stays a change", () => {
  it("reads dirty after the answer and survives the re-read", async () => {
    const m = mount([{ id: A, title: "rouge", frTitle: "noir" }], "fr");
    await m.flush();
    act(() => m.h().handleValueChange("title", "bleu"));
    act(() => m.h().handleSave());
    await m.flush(); // a later click, not the same tick
    act(() => m.h().handleValueChange("seoTitle", "typed"));
    await m.rerender([{ id: A, title: "rouge", frTitle: "noir" }], { success: true, actionType: "updateContent" });
    expect(m.dirty()).toBe(true);
    await m.rerender([{ id: A, title: "rouge", frTitle: "bleu" }]);
    expect(m.v().seoTitle).toBe("typed");
    expect(m.dirty()).toBe(true);
  });
});

describe("H2: a foreign clear during flight is not lost", () => {
  it("the cleared field stays a change after the answer and the re-read", async () => {
    const m = mount([{ id: A, title: "rouge", frTitle: "noir", frSeo: "seo-old" }], "fr");
    await m.flush();
    act(() => m.h().handleValueChange("title", "bleu"));
    act(() => m.h().handleSave());
    await m.flush();
    act(() => m.h().handleClearField("seoTitle"));
    expect(m.v().seoTitle).toBe("");
    await m.rerender([{ id: A, title: "rouge", frTitle: "noir", frSeo: "seo-old" }], { success: true, actionType: "updateContent" });
    expect(m.dirty()).toBe(true);
    await m.rerender([{ id: A, title: "rouge", frTitle: "bleu", frSeo: "seo-old" }]);
    expect(m.v().seoTitle).toBe("");
    expect(m.dirty()).toBe(true);
  });
});

describe("H3b: text typed on top of a sent foreign field is not cached as stored", () => {
  it("Discard after the answer shows what was SENT", async () => {
    const m = mount([{ id: A, title: "rouge", frTitle: "noir" }], "fr");
    await m.flush();
    act(() => m.h().handleValueChange("title", "bleu"));
    act(() => m.h().handleSave());
    await m.flush();
    act(() => m.h().handleValueChange("title", "bleu et plus"));
    await m.rerender([{ id: A, title: "rouge", frTitle: "noir" }], { success: true, actionType: "updateContent" });
    await m.rerender([{ id: A, title: "rouge", frTitle: "bleu", seoDesc: "z" }]);
    act(() => m.h().handleDiscard());
    await m.flush();
    expect(m.v().title).toBe("bleu");
  });
});

describe("L3: an abandoned save confirmed only in part keeps no unconfirmed text as stored", () => {
  it("the unconfirmed field shows what Shopify holds when the merchant is back", async () => {
    const items = [{ id: A, title: "rouge" }, { id: B, title: "vert" }];
    const m = mount(items, "de");
    await m.flush();
    act(() => m.h().handleValueChange("title", "a1"));
    act(() => m.h().handleSave());
    await act(async () => { await m.h().handleItemSelect(B); });
    await m.flush();
    await m.rerender(items, { success: true, actionType: "updateContent", unconfirmedFields: ["title"] });
    await act(async () => { await m.h().handleItemSelect(A); });
    await m.flush();
    await m.rerender([{ id: A, title: "rouge", seoDesc: "moved" }, items[1]]);
    expect(m.v().title).toBe("rouge");
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
  it("a second save while the server still shows the first one: an unchanged read does not revert it", async () => {
    const m = await saved("fr");
    act(() => m.h().handleValueChange("title", "bleu2"));
    act(() => m.h().handleSave());
    await m.rerender([{ id: A, title: "rouge", frTitle: "bleu" }], { success: true, actionType: "updateContent" });
    // a pass that runs, the server value of the field has NOT moved since the last pass
    await m.rerender([{ id: A, title: "rouge", frTitle: "bleu", frSeo: "seo-y" }]);
    expect(m.v().title).toBe("bleu2");
    expect(m.dirty()).toBe(false);
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

describe("a refused save forgets only the keys it carried", () => {
  it("an earlier confirmed save of another field keeps bridging its lagging read", async () => {
    const m = mount([{ id: A, title: "rouge" }], "de");
    await m.flush();
    const accept = async (field: string, text: string) => {
      act(() => setFieldSuggestion({ resourceId: A, locale: "de", marketId: "" }, field, text));
      await m.flush();
      await act(async () => { m.h().handleAcceptSuggestion(field); });
      await m.flush();
    };
    await accept("title", "T1");
    expect(m.sent().changedFields).toBe(JSON.stringify(["title"]));
    await m.rerender([{ id: A, title: "rouge" }], { success: true, actionType: "updateContent" });
    await accept("metaDescription", "M1");
    expect(m.sent().changedFields).toBe(JSON.stringify(["metaDescription"]));
    await m.rerender([{ id: A, title: "rouge" }], { success: false, error: "busy", rateLimited: true });
    // a pass over a read that still lags behind the confirmed title
    await m.rerender([{ id: A, title: "rouge", seoDesc: "moved" }]);
    expect(m.v().title).toBe("T1");
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
  it("a refusal of ANOTHER action (a save) does not release a one-language run's spinner", async () => {
    const m = mount([{ id: THEME, title: "x" }], "fr", TEMPLATES_CONFIG, theme);
    await m.flush();
    act(() => { m.h().handleTranslateAllForLocale(); });
    expect(isOperationActive(THEME, "__translateAllForLocale__fr")).toBe(true);
    await m.rerender([{ id: THEME, title: "x" }], { success: false, error: "busy", rateLimited: true, actionType: "updateContent" });
    expect(isOperationActive(THEME, "__translateAllForLocale__fr")).toBe(true);
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
  it("translate-one-language with a tracked run out: a refused save answer does not drop its spinner", async () => {
    window.history.pushState({}, "", "/app/products");
    const m = mount([{ id: A, title: "rouge", frTitle: "noir" }], "fr");
    await m.flush();
    act(() => { m.h().handleTranslateAllForLocale(); });
    expect(isOperationActive(A, "__translateAllForLocale__fr")).toBe(true);
    await m.rerender([{ id: A, title: "rouge", frTitle: "noir" }], { success: false, error: "busy", rateLimited: true });
    expect(isOperationActive(A, "__translateAllForLocale__fr")).toBe(true);
    window.history.pushState({}, "", "/");
  });
});
