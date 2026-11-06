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

type P = { id: string; title: string; handle?: string; frTitle?: string; frSeo?: string; marketFr?: string; seoDesc?: string };
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

beforeEach(() => { infoBox.mockReset(); try { window.localStorage.clear(); } catch { /* none */ } });

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

describe("BLOCKER 1c / R9 C1: switching away and back before the refusal arrives", () => {
  it("the refused text does not read as saved on return, and the next save does not write it", async () => {
    const items = [{ id: A, title: "rouge" }, { id: B, title: "vert" }];
    const m = mount(items, "de");
    await m.flush();
    act(() => m.h().handleValueChange("title", "verte2"));
    act(() => m.h().handleSave());
    m.fetcher.state = "submitting";
    await m.rerender(items);
    await act(async () => { await m.h().handleItemSelect(B); });
    await m.flush();
    await act(async () => { await m.h().handleItemSelect(A); });
    await m.flush();
    m.fetcher.state = "idle";
    await m.rerender(items, { success: false, error: "busy", rateLimited: true, actionType: "updateContent" });
    expect(infoBox.mock.calls.some((c) => c[1] === "critical" && String(c[0]).includes("rouge"))).toBe(true);
    // no artificial read: the view itself shows what Shopify holds
    expect(m.v().title).toBe("rouge");
    expect(m.dirty()).toBe(false);
    act(() => m.h().handleValueChange("seoTitle", "s"));
    act(() => m.h().handleSave());
    expect(m.sent().title).toBe("rouge");
    expect(m.sent().changedFields ?? "[]").not.toContain("title");
  });
});

describe("R9 C2: a confirmation survives until the overlay ends", () => {
  it("N3: A confirmed, a later save C is refused: the confirmed title stays", async () => {
    const items = [{ id: A, title: "rouge" }];
    const m = mount(items, "de");
    await m.flush();
    act(() => m.h().handleValueChange("title", "rouge2"));
    act(() => m.h().handleSave());
    m.fetcher.state = "submitting";
    await m.rerender(items);
    m.fetcher.state = "idle";
    await m.rerender(items, { success: true, actionType: "updateContent" });
    act(() => m.h().handleValueChange("seoTitle", "seo3"));
    act(() => m.h().handleSave());
    m.fetcher.state = "submitting";
    await m.rerender(items);
    m.fetcher.state = "idle";
    await m.rerender(items, { success: false, error: "busy", rateLimited: true, actionType: "updateContent" });
    await m.rerender([{ id: A, title: "rouge", seoDesc: "lag" }]);
    expect(m.v().title).toBe("rouge2");
    act(() => m.h().handleValueChange("handle", "hh"));
    act(() => m.h().handleSave());
    expect(m.sent().title).toBe("rouge2");
    // Shopify holds rouge2: the title is no change, and is not announced as one
    expect(m.sent().changedFields ?? "[]").not.toContain("title");
  });
});

describe("R9 H1: the snapshot of a newer queued save is not taken as stored", () => {
  it("S1 answered while S2 (other text) is queued: S2's text still reads as a change", async () => {
    const items = [{ id: A, title: "rouge" }];
    const m = mount(items, "de");
    await m.flush();
    act(() => m.h().handleValueChange("title", "t1"));
    act(() => m.h().handleSave());
    m.fetcher.state = "submitting";
    await m.rerender(items);
    act(() => m.h().handleValueChange("seoTitle", "s2"));
    act(() => m.h().handleSave());
    m.fetcher.state = "idle";
    await m.rerender(items, { success: true, actionType: "updateContent" });
    expect(m.dirty()).toBe(true);
  });
});

describe("R9 H2: a queued save of a product the merchant left, refused", () => {
  it("says so with the product's name", async () => {
    const items = [{ id: A, title: "rouge" }, { id: B, title: "vert" }];
    const m = mount(items, "de");
    await m.flush();
    act(() => m.h().handleValueChange("title", "rouge2"));
    act(() => m.h().handleSave());
    m.fetcher.state = "submitting";
    await m.rerender(items);
    act(() => m.h().handleValueChange("seoTitle", "seoQ"));
    act(() => m.h().handleSave());
    await act(async () => { await m.h().handleItemSelect(B); });
    await m.flush();
    const firstAnswer = { success: true, actionType: "updateContent" };
    m.fetcher.state = "idle";
    await m.rerender(items, firstAnswer);
    // A's second save is now out; the fetcher still holds the first answer
    m.fetcher.state = "submitting";
    await m.rerender(items, firstAnswer);
    m.fetcher.state = "idle";
    infoBox.mockClear();
    await m.rerender(items, { success: false, error: "busy", rateLimited: true, actionType: "updateContent" });
    expect(infoBox.mock.calls.some((c) => c[1] === "critical" && String(c[0]).includes("rouge"))).toBe(true);
  });
});

describe("R9: a refused save hands its announced changes on across a reload from the overlay", () => {
  it("the next save announces the field the refused one announced", async () => {
    const items = [{ id: A, title: "rouge" }, { id: B, title: "vert" }];
    const m = mount(items, "de");
    await m.flush();
    act(() => m.h().handleValueChange("metaDescription", "c"));
    act(() => m.h().handleValueChange("title", "b"));
    act(() => m.h().handleSave());
    m.fetcher.state = "submitting";
    await m.rerender(items);
    await act(async () => { await m.h().handleItemSelect(B); });
    await m.flush();
    await act(async () => { await m.h().handleItemSelect(A); });
    await m.flush();
    act(() => m.h().handleSave());
    // pressed after the reload took the first save's text as loaded: announces nothing of it
    m.fetcher.state = "idle";
    await m.rerender(items, { success: false, error: "busy", rateLimited: true, actionType: "updateContent" });
    expect(m.sent().metaDescription).toBe("c");
    expect(JSON.parse(m.sent().changedFields ?? "[]")).toContain("metaDescription");
  });
});

describe("R9: a refused save hands its announced changes on to the save queued behind it", () => {
  it("the queued save announces the field the refused one announced", async () => {
    const items = [{ id: A, title: "rouge" }];
    const m = mount(items, "de");
    await m.flush();
    act(() => m.h().handleValueChange("title", "rouge2"));
    act(() => m.h().handleSave());
    m.fetcher.state = "submitting";
    await m.rerender(items);
    act(() => m.h().handleSave());
    m.fetcher.state = "idle";
    await m.rerender(items, { success: false, error: "busy", rateLimited: true, actionType: "updateContent" });
    expect(m.sent().title).toBe("rouge2");
    expect(JSON.parse(m.sent().changedFields ?? "[]")).toContain("title");
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

describe("R12 C1: a queued save is judged against what the saves ahead of it carry", () => {
  const ok = { success: true, actionType: "updateContent", n: 1 };
  it("E1L: meta typed back to its baseline while an earlier save carries another value is announced", async () => {
    const m = mount([{ id: A, title: "t", seoDesc: "sb" }], "de");
    await m.flush();
    act(() => m.h().handleValueChange("metaDescription", "a"));
    act(() => m.h().handleSave());
    m.fetcher.state = "submitting";
    await m.rerender([{ id: A, title: "t", seoDesc: "sb" }]);
    act(() => m.h().handleValueChange("metaDescription", "sb"));
    act(() => m.h().handleValueChange("title", "z"));
    act(() => m.h().handleSave());
    m.fetcher.state = "loading";
    await m.rerender([{ id: A, title: "t", seoDesc: "sb" }], ok);
    m.fetcher.state = "idle";
    await m.rerender([{ id: A, title: "t", seoDesc: "a" }], ok);
    expect(m.sent().metaDescription).toBe("sb");
    expect(JSON.parse(m.sent().changedFields ?? "[]")).toContain("metaDescription");
  });
  it("E2: an own AI save restoring the baseline value behind a save carrying another one is announced", async () => {
    const m = mount([{ id: A, title: "t", seoDesc: "sb" }], "de");
    await m.flush();
    act(() => m.h().handleValueChange("metaDescription", "a"));
    act(() => m.h().handleSave());
    m.fetcher.state = "submitting";
    await m.rerender([{ id: A, title: "t", seoDesc: "sb" }]);
    act(() => setFieldSuggestion({ resourceId: A, locale: "de", marketId: "" }, "metaDescription", "sb"));
    await m.flush();
    await act(async () => { m.h().handleAcceptSuggestion("metaDescription"); });
    await m.flush();
    m.fetcher.state = "loading";
    await m.rerender([{ id: A, title: "t", seoDesc: "sb" }], ok);
    m.fetcher.state = "idle";
    await m.rerender([{ id: A, title: "t", seoDesc: "a" }], ok);
    expect(m.sent().metaDescription).toBe("sb");
    expect(JSON.parse(m.sent().changedFields ?? "[]")).toEqual(["metaDescription"]);
  });
  it("G: a foreign title typed back to its loaded value is still sent behind a save carrying another one", async () => {
    const m = mount([{ id: A, title: "t", frTitle: "o", seoDesc: "m" }], "fr");
    await m.flush();
    act(() => m.h().handleValueChange("title", "a"));
    act(() => m.h().handleSave());
    m.fetcher.state = "submitting";
    await m.rerender([{ id: A, title: "t", frTitle: "o", seoDesc: "m" }]);
    act(() => m.h().handleValueChange("title", "o"));
    act(() => m.h().handleValueChange("metaDescription", "fm2"));
    act(() => m.h().handleSave());
    m.fetcher.state = "loading";
    await m.rerender([{ id: A, title: "t", frTitle: "o", seoDesc: "m" }], ok);
    m.fetcher.state = "idle";
    await m.rerender([{ id: A, title: "t", frTitle: "a", seoDesc: "m" }], ok);
    expect(m.sent().title).toBe("o");
  });
  it("control: a field still differing from its baseline is announced as before", async () => {
    const m = mount([{ id: A, title: "t", seoDesc: "sb" }], "de");
    await m.flush();
    act(() => m.h().handleValueChange("metaDescription", "a"));
    act(() => m.h().handleSave());
    m.fetcher.state = "submitting";
    await m.rerender([{ id: A, title: "t", seoDesc: "sb" }]);
    act(() => m.h().handleValueChange("title", "z"));
    act(() => m.h().handleSave());
    m.fetcher.state = "loading";
    await m.rerender([{ id: A, title: "t", seoDesc: "sb" }], ok);
    m.fetcher.state = "idle";
    await m.rerender([{ id: A, title: "t", seoDesc: "a" }], ok);
    // meta is still typed as "a" (its own save is out): both are announced, nothing else
    expect(JSON.parse(m.sent().changedFields ?? "[]").sort()).toEqual(["metaDescription", "title"]);
  });
});

describe("R12 C2: text typed after coming back survives the abandoned save's refusal / partial answer", () => {
  for (const kind of ["refused", "partial"] as const) {
    it(kind, async () => {
      const items = [{ id: A, title: "o" }, { id: B, title: "b" }];
      const m = mount(items, "de");
      await m.flush();
      act(() => m.h().handleValueChange("title", "a"));
      act(() => m.h().handleSave());
      m.fetcher.state = "submitting";
      await m.rerender(items);
      await act(async () => { await m.h().handleItemSelect(B); });
      await m.flush();
      await act(async () => { await m.h().handleItemSelect(A); });
      await m.flush();
      act(() => m.h().handleValueChange("title", "q"));
      m.fetcher.state = "idle";
      await m.rerender(items, kind === "refused"
        ? { success: false, error: "busy", rateLimited: true, actionType: "updateContent" }
        : { success: true, actionType: "updateContent", unconfirmedFields: ["title"] });
      expect(m.v().title).toBe("q");
      expect(m.dirty()).toBe(true);
    });
  }
  it("the partial answer's message does not claim the text is still in the fields", async () => {
    const items = [{ id: A, title: "o" }, { id: B, title: "b" }];
    const m = mount(items, "de");
    await m.flush();
    act(() => m.h().handleValueChange("title", "a"));
    act(() => m.h().handleSave());
    m.fetcher.state = "submitting";
    await m.rerender(items);
    await act(async () => { await m.h().handleItemSelect(B); });
    await m.flush();
    infoBox.mockClear();
    m.fetcher.state = "idle";
    await m.rerender(items, { success: true, actionType: "updateContent", unconfirmedFields: ["title"] });
    const text = infoBox.mock.calls.map((c) => String(c[0])).join(" ");
    expect(text).toContain("NOT saved");
    expect(text).not.toContain("still in the fields");
  });
});

describe("R12 M2: an old non-save error on the fetcher is not the pending save's refusal", () => {
  it("F: a language switch during the save re-runs the effect without taking the stale error", async () => {
    const items = [{ id: A, title: "t", frTitle: "f" }];
    const m = mount(items, "de");
    await m.flush();
    const stale = { success: false, error: "alt translate failed", actionType: "translateAltTextToAllLocales" };
    await m.rerender(items, stale);
    infoBox.mockClear();
    act(() => m.h().handleValueChange("title", "new"));
    act(() => m.h().handleSave());
    m.fetcher.state = "submitting";
    await m.rerender(items, stale);
    await act(async () => { await m.h().handleLanguageChange("fr"); });
    await m.flush();
    expect(infoBox.mock.calls.some((c) => String(c[0]).includes("alt translate failed") && c[1] === "critical")).toBe(false);
    expect(m.hook.result.current.state.isSavingCurrentItem).toBe(true);
  });
});

describe("R12 H1: a confirmation ends with the overlay entry it could restore", () => {
  // S1 (title bleu) confirmed; the title then moves elsewhere to "gris"; a LATER refused save that
  // owns the title must give back nothing stale: the screen is clean at what Shopify holds.
  const ok = { success: true, actionType: "updateContent", n: 1 };
  const refused = { success: false, error: "busy", rateLimited: true, actionType: "updateContent", n: 2 };
  it("yield: an external change to a third value drops the confirmation too", async () => {
    const items = [{ id: A, title: "rouge" }];
    const m = mount(items, "de");
    await m.flush();
    act(() => m.h().handleValueChange("title", "bleu"));
    act(() => m.h().handleSave());
    m.fetcher.state = "submitting";
    await m.rerender(items);
    act(() => m.h().handleSave()); // S2: queued behind S1, carries the same title
    m.fetcher.state = "loading";
    await m.rerender(items, ok);
    m.fetcher.state = "idle";
    await m.rerender([{ id: A, title: "bleu" }], ok);
    m.fetcher.state = "submitting";
    await m.rerender([{ id: A, title: "bleu" }], ok);
    await m.rerender([{ id: A, title: "gris", seoDesc: "moved" }], ok);
    expect(m.v().title).toBe("gris");
    m.fetcher.state = "idle";
    await m.rerender([{ id: A, title: "gris", seoDesc: "moved" }], refused);
    expect(m.v().title).toBe("gris");
    expect(m.dirty()).toBe(false);
  });
  const lateRefusal = async (end: (m: ReturnType<typeof mount>) => Promise<void>) => {
    const real = Date.now();
    let offset = 0;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => real + offset);
    try {
      const items = [{ id: A, title: "rouge" }];
      const m = mount(items, "de");
      await m.flush();
      act(() => m.h().handleValueChange("title", "bleu"));
      act(() => m.h().handleSave());
      m.fetcher.state = "submitting";
      await m.rerender(items);
      m.fetcher.state = "loading";
      await m.rerender(items, ok);
      m.fetcher.state = "idle";
      await m.rerender([{ id: A, title: "bleu" }], ok);
      // the overlay ends (clock / reload) while the title was changed elsewhere to "gris"
      offset = 2 * 60_000;
      await end(m);
      await m.rerender([{ id: A, title: "gris", seoDesc: "z" }], ok);
      expect(m.v().title).toBe("gris");
      // a new save C carries the (gris) title and is refused
      act(() => m.h().handleValueChange("seoTitle", "typed"));
      act(() => m.h().handleSave());
      expect(m.sent().title).toBe("gris");
      m.fetcher.state = "submitting";
      await m.rerender([{ id: A, title: "gris", seoDesc: "z" }], ok);
      m.fetcher.state = "idle";
      await m.rerender([{ id: A, title: "gris", seoDesc: "z" }], refused);
      expect(m.v().title).toBe("gris");
      // the typed seoTitle is the only change; the title (Shopify holds gris) is not announced
      act(() => m.h().handleSave());
      expect(JSON.parse(m.sent().changedFields ?? "[]")).toEqual(["seoTitle"]);
    } finally {
      spy.mockRestore();
    }
  };
  it("expiry: the clock ending the overlay drops the confirmation", async () => {
    await lateRefusal(async (m) => { await m.rerender([{ id: A, title: "bleu", seoDesc: "y" }], ok); });
  });
  it("reload: the Reload button dropping the overlay drops the confirmation", async () => {
    await lateRefusal(async (m) => {
      await act(async () => { m.hook.result.current.helpers.triggerDataRefresh(); });
      await m.flush();
    });
  });
});

const formsOf = (m: any) =>
  m.fetcher.submit.mock.calls.map((c: any) => Object.fromEntries([...(c[0] as FormData).entries()].map(([k, v]: any) => [k, String(v)])));

describe("R13 M1: a carried-value announcement does not outlive its carrier", () => {
  it("P1: the carrier is refused, the queued typed-back save no longer announces the unchanged title", async () => {
    const items = [{ id: A, title: "rouge" }, { id: B, title: "vert" }];
    const m = mount(items, "de");
    await m.flush();
    act(() => m.h().handleValueChange("title", "X"));
    act(() => m.h().handleSave());
    m.fetcher.state = "submitting";
    await m.rerender(items);
    act(() => m.h().handleValueChange("title", "rouge"));
    act(() => m.h().handleValueChange("seoTitle", "s1"));
    act(() => m.h().handleSave());
    // pressed behind S1, which still carries "X": the typed-back title is announced
    m.fetcher.state = "idle";
    await m.rerender(items, { success: false, error: "busy", rateLimited: true, actionType: "updateContent" });
    const forms = formsOf(m);
    expect(forms[1].title).toBe("rouge");
    expect(JSON.parse(forms[1].changedFields ?? "[]")).toEqual(["seoTitle"]);
    // no longer announced, but still WRITTEN (the refused carrier may have stored something else): not a passenger
    expect(JSON.parse(forms[1].writtenUnannounced ?? "[]")).toContain("title");
    expect(JSON.parse(forms[1].passengerFields ?? "[]")).not.toContain("title");
  });
  it("control: the carrier is confirmed, the typed-back title IS announced", async () => {
    const items = [{ id: A, title: "rouge" }, { id: B, title: "vert" }];
    const m = mount(items, "de");
    await m.flush();
    act(() => m.h().handleValueChange("title", "X"));
    act(() => m.h().handleSave());
    m.fetcher.state = "submitting";
    await m.rerender(items);
    act(() => m.h().handleValueChange("title", "rouge"));
    act(() => m.h().handleValueChange("seoTitle", "s1"));
    act(() => m.h().handleSave());
    m.fetcher.state = "loading";
    await m.rerender(items, { success: true, actionType: "updateContent", n: 1 });
    m.fetcher.state = "idle";
    await m.rerender([{ id: A, title: "X" }, items[1]], { success: true, actionType: "updateContent", n: 1 });
    expect(JSON.parse(formsOf(m)[1].changedFields ?? "[]").sort()).toEqual(["seoTitle", "title"]);
  });
  it("P4: an accept-and-translate save (changedFields withheld) queued behind a confirmed save stays without them", async () => {
    const items = [{ id: A, title: "rouge" }, { id: B, title: "vert" }];
    const m = mount(items, "de");
    await m.flush();
    act(() => m.h().handleValueChange("seoTitle", "s1"));
    act(() => m.h().handleSave());
    m.fetcher.state = "submitting";
    await m.rerender(items);
    act(() => setFieldSuggestion({ resourceId: A, locale: "de", marketId: "" }, "title", "AI"));
    await m.flush();
    await act(async () => { (m.h() as any).handleAcceptAndTranslate("title"); });
    await m.flush();
    m.fetcher.state = "loading";
    await m.rerender(items, { success: true, actionType: "updateContent", n: 1 });
    m.fetcher.state = "idle";
    await m.rerender(items, m.fetcher.data);
    const forms = formsOf(m);
    expect(forms[1].title).toBe("AI");
    expect(forms[1].changedFields ?? "[]").toBe("[]");
  });
});

describe("R13 M3: an old action-less error on the fetcher is not the new save's refusal", () => {
  it("P10", async () => {
    const items = [{ id: A, title: "rouge" }, { id: B, title: "vert" }];
    const m = mount(items, "de");
    await m.flush();
    const old = { success: false, error: "Invalid field type" };
    await m.rerender(items, old);
    infoBox.mockReset();
    act(() => m.h().handleValueChange("title", "X"));
    act(() => m.h().handleSave());
    m.fetcher.state = "submitting";
    await m.rerender(items, old);
    await m.rerender([{ id: A, title: "rouge", seoDesc: "q" } as any, items[1]], old);
    expect(infoBox.mock.calls.some((c) => String(c[0]).includes("Invalid field type"))).toBe(false);
    expect(m.hook.result.current.state.isSavingCurrentItem).toBe(true);
    m.fetcher.state = "idle";
    await m.rerender([{ id: A, title: "X" }, items[1]], { success: true, actionType: "updateContent" });
    expect(infoBox.mock.calls.some((c) => c[1] === "success")).toBe(true);
  });
});

describe("R14 HIGH: an unannounced write over a known different server value is impossible", () => {
  const ok = { success: true, actionType: "updateContent", n: 1 };
  it("probe: Z read, X confirmed, admin changes the title back to rouge: the next save announces the title", async () => {
    const items = [{ id: A, title: "rouge", seoDesc: "m0" }];
    const m = mount(items, "de");
    await m.flush();
    await m.rerender([{ id: A, title: "Z", seoDesc: "m0" }]);
    act(() => m.h().handleValueChange("title", "X"));
    act(() => m.h().handleSave());
    m.fetcher.state = "submitting";
    await m.rerender([{ id: A, title: "Z", seoDesc: "m0" }]);
    m.fetcher.state = "loading";
    await m.rerender([{ id: A, title: "Z", seoDesc: "m0" }], ok);
    m.fetcher.state = "idle";
    await m.rerender([{ id: A, title: "X", seoDesc: "m0" }], ok);
    await m.rerender([{ id: A, title: "rouge", seoDesc: "m0", frSeo: "moved" }], ok);
    act(() => m.h().handleValueChange("metaDescription", "m1"));
    act(() => m.h().handleSave());
    const f = m.sent();
    expect(f.title === "rouge" || JSON.parse(f.changedFields ?? "[]").includes("title")).toBe(true);
  });
  it("control: a lagging read of the pre-save value after the confirmation does not announce the title", async () => {
    const items = [{ id: A, title: "rouge", seoDesc: "m0" }];
    const m = mount(items, "de");
    await m.flush();
    act(() => m.h().handleValueChange("title", "X"));
    act(() => m.h().handleSave());
    m.fetcher.state = "submitting";
    await m.rerender(items);
    m.fetcher.state = "loading";
    await m.rerender(items, ok);
    m.fetcher.state = "idle";
    await m.rerender([{ id: A, title: "rouge", seoDesc: "m0", frSeo: "lag" }], ok);
    act(() => m.h().handleValueChange("metaDescription", "m1"));
    act(() => m.h().handleSave());
    expect(JSON.parse(m.sent().changedFields ?? "[]")).toEqual(["metaDescription"]);
  });
});

describe("R14 CRITICAL: an own save behind a save carrying the same value is announced when that save is refused", () => {
  it("S1 (X) out, a read lands, own save of X queued: S1 refused, the own save announces the title", async () => {
    const items = [{ id: A, title: "rouge" }, { id: B, title: "vert" }];
    const m = mount(items, "de");
    await m.flush();
    act(() => m.h().handleValueChange("title", "X"));
    act(() => m.h().handleSave());
    m.fetcher.state = "submitting";
    await m.rerender([{ id: A, title: "rouge", seoDesc: "q" }, items[1]]);
    act(() => setFieldSuggestion({ resourceId: A, locale: "de", marketId: "" }, "title", "X"));
    await m.flush();
    await act(async () => { m.h().handleAcceptSuggestion("title"); });
    await m.flush();
    m.fetcher.state = "idle";
    await m.rerender(items, { success: false, error: "busy", rateLimited: true, actionType: "updateContent" });
    const f = m.sent();
    expect(f.title).toBe("X");
    expect(JSON.parse(f.changedFields ?? "[]")).toContain("title");
  });
});

describe("R15 C1: the server's own normalisation of a sent value is not a difference", () => {
  const OK = (n: number) => ({ success: true, actionType: "updateContent", n });
  const withHandle = (p: any) => ({ ...product(p), handle: p.handle ?? "h" });
  const updateForms = (m: any) => formsOf(m).filter((f: any) => f.action === "updateContent");
  for (const midFlight of [false, true]) {
    it(`a sanitised handle is never announced by later saves (re-read ${midFlight ? "mid-flight" : "in the answer's render"})`, async () => {
      const old = [{ id: A, title: "Old" }, { id: B, title: "vert" }];
      const m = mount(old, "de", PRODUCTS_CONFIG, withHandle);
      await m.flush();
      act(() => m.h().handleValueChange("handle", "Neu Über"));
      act(() => m.h().handleSave());
      const st = (sd: string) => [{ id: A, title: "Old", handle: "neu-ueber", seoDesc: sd } as any, old[1]];
      m.fetcher.state = "submitting";
      await m.rerender(old);
      if (midFlight) await m.rerender(st(""));
      m.fetcher.state = "loading";
      await m.rerender(midFlight ? st("") : old, OK(1));
      m.fetcher.state = "idle";
      await m.rerender(st(""), OK(1));
      for (let k = 2; k <= 4; k++) {
        act(() => m.h().handleValueChange("metaDescription", "m" + k));
        act(() => m.h().handleSave());
        m.fetcher.state = "submitting";
        await m.rerender(st("m" + (k - 1)));
        m.fetcher.state = "loading";
        await m.rerender(st("m" + (k - 1)), OK(k));
        m.fetcher.state = "idle";
        await m.rerender(st("m" + k), OK(k));
      }
      for (const f of updateForms(m).slice(1)) {
        expect(JSON.parse(f.changedFields ?? "[]")).not.toContain("handle");
      }
    });
  }
  it("a trimmed title is not announced again", async () => {
    const old = [{ id: A, title: "Old" }];
    const m = mount(old, "de");
    await m.flush();
    act(() => m.h().handleValueChange("title", "Neu "));
    act(() => m.h().handleSave());
    m.fetcher.state = "submitting";
    await m.rerender(old);
    m.fetcher.state = "loading";
    await m.rerender(old, OK(1));
    m.fetcher.state = "idle";
    await m.rerender([{ id: A, title: "Neu" }], OK(1));
    act(() => m.h().handleValueChange("metaDescription", "m"));
    act(() => m.h().handleSave());
    expect(JSON.parse(m.sent().changedFields ?? "[]")).not.toContain("title");
  });
  it("a handle that sits unedited over a different server handle is left out of the form", async () => {
    const old = [{ id: A, title: "Old", handle: "h" }, { id: B, title: "vert" }];
    const m = mount(old, "de", PRODUCTS_CONFIG, withHandle);
    await m.flush();
    act(() => m.h().handleValueChange("title", "T1"));
    act(() => m.h().handleSave());
    m.fetcher.state = "submitting";
    await m.rerender(old);
    m.fetcher.state = "loading";
    await m.rerender(old, OK(1));
    m.fetcher.state = "idle";
    // Shopify's admin changed the handle elsewhere
    await m.rerender([{ id: A, title: "T1", handle: "ext" }, old[1]], OK(1));
    await m.rerender([{ id: A, title: "T1", handle: "ext", seoDesc: "x" }, old[1]], OK(1));
    act(() => m.h().handleValueChange("metaDescription", "m"));
    act(() => m.h().handleSave());
    const f = m.sent();
    // The handle sits unedited in the form: it is named a passenger (the server does not write it) or left out.
    expect(f.handle === undefined || JSON.parse(f.passengerFields ?? "[]").includes("handle")).toBe(true);
    expect(JSON.parse(f.changedFields ?? "[]")).not.toContain("handle");
  });
});

describe("R16 HIGH: the baseline follows the server only for its own normalisation", () => {
  const OK = (n: number) => ({ success: true, actionType: "updateContent", n });
  for (const third of [false, true]) {
    it(`a stale ${third ? "third-value " : ""}read after Reload never makes the old text an unannounced write`, async () => {
      const old = [{ id: A, title: "Old" }, { id: B, title: "vert" }];
      const m = mount(old, "de");
      await m.flush();
      act(() => m.h().handleValueChange("title", "New"));
      act(() => m.h().handleSave());
      m.fetcher.state = "submitting";
      await m.rerender(old);
      // Reload during the flight: the read shows the old (or a third) value, the overlay ends
      await act(async () => { m.hook.result.current.helpers.triggerDataRefresh(); });
      await m.rerender([{ id: A, title: third ? "Third" : "Old", seoDesc: "r" }, old[1]]);
      m.fetcher.state = "loading";
      await m.rerender([{ id: A, title: third ? "Third" : "Old", seoDesc: "r" }, old[1]], OK(1));
      m.fetcher.state = "idle";
      await m.rerender([{ id: A, title: third ? "Third" : "Old", seoDesc: "r" }, old[1]], OK(1));
      await m.flush();
      act(() => m.h().handleValueChange("metaDescription", "m"));
      act(() => m.h().handleSave());
      const f = m.sent();
      const announced = JSON.parse(f.changedFields ?? "[]");
      // title is announced, not sent at all, or named a passenger (the server does not write it); never the
      // old/third text as an unannounced write
      expect(f.title === undefined || announced.includes("title") || JSON.parse(f.passengerFields ?? "[]").includes("title")).toBe(true);
    });
  }
});

describe("R16 HIGH (handle): a stale read after Reload does not make the old handle an unannounced write", () => {
  it("handle", async () => {
    const OK = (n: number) => ({ success: true, actionType: "updateContent", n });
    const withHandle = (p: any) => ({ ...product(p), handle: p.handle ?? "h" });
    const old = [{ id: A, title: "Old", handle: "h" }, { id: B, title: "vert" }];
    const m = mount(old, "de", PRODUCTS_CONFIG, withHandle);
    await m.flush();
    act(() => m.h().handleValueChange("handle", "Neu Über"));
    act(() => m.h().handleSave());
    m.fetcher.state = "submitting";
    await m.rerender(old);
    await act(async () => { m.hook.result.current.helpers.triggerDataRefresh(); });
    const stale = [{ id: A, title: "Old", handle: "h", seoDesc: "r" } as any, old[1]];
    await m.rerender(stale);
    m.fetcher.state = "loading";
    await m.rerender(stale, OK(1));
    m.fetcher.state = "idle";
    await m.rerender(stale, OK(1));
    await m.flush();
    act(() => m.h().handleValueChange("metaDescription", "m"));
    act(() => m.h().handleSave());
    const f = m.sent();
    expect(f.handle === undefined || JSON.parse(f.changedFields ?? "[]").includes("handle") || JSON.parse(f.passengerFields ?? "[]").includes("handle")).toBe(true);
  });
});

describe("R17 MEDIUM: a field this save did not change takes what the read holds", () => {
  it("scenario A: answer and read in one render, an untouched field moved externally: not dirty, not announced", async () => {
    const old = [{ id: A, title: "Old" }, { id: B, title: "vert" }];
    const m = mount(old, "de");
    await m.flush();
    act(() => m.h().handleValueChange("title", "New"));
    act(() => m.h().handleSave());
    m.fetcher.state = "submitting";
    await m.rerender(old);
    m.fetcher.state = "idle";
    await m.rerender([{ id: A, title: "New", seoDesc: "r" } as any, old[1]], { success: true, actionType: "updateContent", n: 1 });
    await m.flush();
    expect(m.hook.result.current.state.hasChanges).toBe(false);
    act(() => m.h().handleValueChange("seoTitle", "s"));
    act(() => m.h().handleSave());
    const f = formsOf(m).filter((x: any) => x.action === "updateContent").pop();
    expect(JSON.parse(f.changedFields ?? "[]")).not.toContain("metaDescription");
  });
});

describe("R18 CRITICAL: a passenger key with a standing overlay never takes a lagging read", () => {
  for (const between of [false, true]) {
    it(`Save1 title, Save2 other field answered while the read still shows Old${between ? " (unrelated content read between)" : ""}`, async () => {
      const OK = (n: number) => ({ success: true, actionType: "updateContent", n });
      const old = [{ id: A, title: "Old" }, { id: B, title: "vert" }];
      const m = mount(old, "de");
      await m.flush();
      act(() => m.h().handleValueChange("title", "New"));
      act(() => m.h().handleSave());
      m.fetcher.state = "submitting";
      await m.rerender(old);
      m.fetcher.state = "idle";
      await m.rerender(old, OK(1));
      await m.flush();
      if (between) await m.rerender([{ id: A, title: "Old", seoDesc: "z" } as any, old[1]], OK(1));
      act(() => m.h().handleValueChange("seoTitle", "s2"));
      act(() => m.h().handleSave());
      m.fetcher.state = "submitting";
      await m.rerender(old, OK(1));
      m.fetcher.state = "idle";
      await m.rerender(between ? [{ id: A, title: "Old", seoDesc: "z" } as any, old[1]] : old, OK(2));
      await m.flush();
      act(() => m.h().handleValueChange("metaDescription", "m3"));
      act(() => m.h().handleSave());
      const f = formsOf(m).filter((x: any) => x.action === "updateContent").pop();
      const announced = JSON.parse(f.changedFields ?? "[]");
      expect(f.title === undefined || f.title === "New" || announced.includes("title")).toBe(true);
    });
  }
});

describe("R16 LOW: a handle that is announced is not left out of the form", () => {
  it("carried-only handle behind a save that is out", async () => {
    const withHandle = (p: any) => ({ ...product(p), handle: p.handle ?? "h" });
    const old = [{ id: A, title: "Old", handle: "h" }, { id: B, title: "vert" }];
    const m = mount(old, "de", PRODUCTS_CONFIG, withHandle);
    await m.flush();
    act(() => m.h().handleValueChange("handle", "X"));
    act(() => m.h().handleSave());
    m.fetcher.state = "submitting";
    await m.rerender([{ id: A, title: "Old", handle: "ext" } as any, old[1]]);
    act(() => m.h().handleValueChange("handle", "h"));
    act(() => m.h().handleValueChange("metaDescription", "m"));
    act(() => m.h().handleSave());
    m.fetcher.state = "idle";
    await m.rerender([{ id: A, title: "Old", handle: "ext" } as any, old[1]], { success: true, actionType: "updateContent", n: 1 });
    await m.flush();
    const f = formsOf(m).filter((x: any) => x.action === "updateContent").pop();
    const announced = JSON.parse(f.changedFields ?? "[]");
    expect(announced).toContain("handle");
    expect(f.handle).toBe("h");
  });
});

describe("R14 MEDIUM: a carried-only announcement of an OWN save is dropped against the server value", () => {
  it("own save of the baseline value behind a refused full save", async () => {
    const items = [{ id: A, title: "A0" }, { id: B, title: "vert" }];
    const m = mount(items, "de");
    await m.flush();
    act(() => m.h().handleValueChange("title", "B1"));
    act(() => m.h().handleSave());
    m.fetcher.state = "submitting";
    await m.rerender(items);
    act(() => setFieldSuggestion({ resourceId: A, locale: "de", marketId: "" }, "title", "A0"));
    await m.flush();
    await act(async () => { m.h().handleAcceptSuggestion("title"); });
    await m.flush();
    m.fetcher.state = "idle";
    await m.rerender(items, { success: false, error: "busy", rateLimited: true, actionType: "updateContent" });
    const f = m.sent();
    expect(f.title).toBe("A0");
    expect(f.changedFields ?? "[]").not.toContain("title");
  });
});

describe("R13 LOW-2: the carried-value lookup of a foreign save uses the view's market", () => {
  it("P6: a global save behind a market save does not carry the market's title", async () => {
    const items = [{ id: A, title: "rouge", frTitle: "noir", marketFr: "noirM" }, { id: B, title: "vert" }];
    const m = mount(items, "fr");
    await m.flush();
    await act(async () => { await (m.h() as any).handleMarketChange(MARKET); });
    await m.flush();
    act(() => m.h().handleValueChange("title", "noirM2"));
    act(() => m.h().handleSave());
    m.fetcher.state = "submitting";
    await m.rerender(items);
    await act(async () => { await (m.h() as any).handleMarketChange(""); });
    await m.flush();
    act(() => m.h().handleValueChange("metaDescription", "g1"));
    act(() => m.h().handleSave());
    const forms = formsOf(m);
    m.fetcher.state = "idle";
    await m.rerender(items, { success: true, actionType: "updateContent", n: 1 });
    const all = formsOf(m);
    expect(all[all.length - 1].metaDescription).toBe("g1");
    expect(all[all.length - 1].title).toBeUndefined();
    expect(forms.length).toBeGreaterThan(0);
  });
  it("P8: a market title typed back behind a market save in between is still sent", async () => {
    const items = [{ id: A, title: "rouge", frSeo: "seoG", marketFr: "noirM" }, { id: B, title: "vert" }];
    const m = mount(items, "fr");
    await m.flush();
    await act(async () => { await (m.h() as any).handleMarketChange(MARKET); });
    await m.flush();
    act(() => m.h().handleValueChange("title", "V1"));
    act(() => m.h().handleSave());
    m.fetcher.state = "submitting";
    await m.rerender(items);
    await act(async () => { await (m.h() as any).handleMarketChange(""); });
    await m.flush();
    act(() => m.h().handleValueChange("seoTitle", "seoG2"));
    act(() => m.h().handleSave());
    await act(async () => { await (m.h() as any).handleMarketChange(MARKET); });
    await m.flush();
    act(() => m.h().handleValueChange("title", "noirM"));
    act(() => m.h().handleValueChange("metaDescription", "zz"));
    act(() => m.h().handleSave());
    for (let k = 0; k < 3; k++) {
      m.fetcher.state = "idle";
      await m.rerender(items, { success: true, actionType: "updateContent", n: 10 + k });
      m.fetcher.state = "submitting";
      await m.rerender(items, m.fetcher.data);
    }
    const last = formsOf(m).filter((f: any) => f.marketId === MARKET).pop();
    expect(last.title).toBe("noirM");
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

describe("M1: Reload during the save of the field itself keeps what that save carries", () => {
  const OK = (n: number) => ({ success: true, actionType: "updateContent", n });
  it("edit meta d, Save, Reload while out, a lagging read, answer: the next save does not write the old meta", async () => {
    const old = [{ id: A, title: "Old", seoDesc: "b" } as any, { id: B, title: "vert" }];
    const m = mount(old, "de");
    await m.flush();
    act(() => m.h().handleValueChange("metaDescription", "d"));
    act(() => m.h().handleSave());
    m.fetcher.state = "submitting";
    await m.rerender(old);
    await act(async () => { m.hook.result.current.helpers.triggerDataRefresh(); });
    await m.rerender([{ id: A, title: "Old", seoDesc: "b", x: 1 } as any, old[1]]);
    m.fetcher.state = "loading";
    await m.rerender([{ id: A, title: "Old", seoDesc: "b", x: 1 } as any, old[1]], OK(1));
    m.fetcher.state = "idle";
    await m.rerender([{ id: A, title: "Old", seoDesc: "b", x: 1 } as any, old[1]], OK(1));
    await m.flush();
    expect(m.hook.result.current.state.editableValues.metaDescription).toBe("d");
    act(() => m.h().handleValueChange("title", "New"));
    act(() => m.h().handleSave());
    const f = m.sent();
    const written = f.metaDescription !== undefined && !JSON.parse(f.passengerFields ?? "[]").includes("metaDescription");
    expect(!written || f.metaDescription === "d").toBe(true);
    expect(f.metaDescription === undefined || f.metaDescription === "d" || JSON.parse(f.passengerFields ?? "[]").includes("metaDescription")).toBe(true);
    expect(JSON.parse(f.changedFields ?? "[]")).not.toContain("metaDescription");
  });
});

describe("Reload with no save out and a lagging read", () => {
  const OK = (n: number) => ({ success: true, actionType: "updateContent", n });
  it("the field shows the old text but is not a change; the next save names it a passenger (not written)", async () => {
    const old = [{ id: A, title: "Old" }, { id: B, title: "vert" }];
    const m = mount(old, "de");
    await m.flush();
    act(() => m.h().handleValueChange("title", "New"));
    act(() => m.h().handleSave());
    m.fetcher.state = "submitting";
    await m.rerender(old);
    m.fetcher.state = "loading";
    await m.rerender(old, OK(1));
    m.fetcher.state = "idle";
    await m.rerender([{ id: A, title: "New" }, old[1]], OK(1));
    await m.flush();
    await act(async () => { m.hook.result.current.helpers.triggerDataRefresh(); });
    await m.rerender([{ id: A, title: "Old", x: 1 } as any, old[1]], OK(1));
    await m.flush();
    const s = m.hook.result.current.state;
    expect(s.editableValues.title).toBe("Old");
    expect(s.hasChanges).toBe(false);
    act(() => m.h().handleValueChange("metaDescription", "m"));
    act(() => m.h().handleSave());
    const f = m.sent();
    expect(JSON.parse(f.changedFields ?? "[]")).toEqual(["metaDescription"]);
    expect(JSON.parse(f.passengerFields ?? "[]")).toContain("title");
  });
});
