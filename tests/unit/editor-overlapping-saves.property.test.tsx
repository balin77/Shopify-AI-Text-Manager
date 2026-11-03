/**
 * Property test: random sequences of overlapping primary saves over the real editor
 * hook with a fake fetcher, against a small model of Shopify.
 *
 * Invariants
 *  1. A field a save does not name in `changedFields` is never sent with a value that
 *     Shopify neither holds nor is about to hold (the value of a save still out): no
 *     old text is written back unannounced.
 *  2. Once nothing is out or queued, a field that shows text other than what Shopify
 *     holds reads as a change (a refused save's text never reads as stored).
 *
 * Fixed seed, so a failure is reproducible: the message carries the seed and the ops.
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
import { PRODUCTS_CONFIG } from "~/config/content-fields.config";

const shopLocales = [
  { locale: "de", name: "Deutsch", primary: true, published: true },
  { locale: "fr", name: "Francais", primary: false, published: true },
] as any;
const A = "gid://shopify/Product/1";
const B = "gid://shopify/Product/2";

type Shop = { title: string; meta: string };
const FIELDS: Array<[keyof Shop, string]> = [["title", "title"], ["meta", "metaDescription"]];
const VALUES = ["a", "b", "c", "d"];

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const item = (id: string, shop: Shop, moved: number) => ({
  id,
  title: shop.title,
  handle: "h",
  descriptionHtml: `d${moved}`,
  seo: { title: "", description: shop.meta },
  translations: [],
  marketTranslations: {},
  images: [],
});

async function runOne(seed: number, steps: number) {
  const rand = rng(seed);
  const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
  const shop: Shop = { title: "start", meta: "m0" };
  const history: Shop[] = [{ ...shop }];
  let moved = 0;
  const fetcher: any = { state: "idle", data: undefined, submit: vi.fn(), load: vi.fn() };
  const items = (state: Shop) => [item(A, state, moved), item(B, { title: "other", meta: "" }, 0)];
  const hook = renderHook(
    (p: any) =>
      useUnifiedContentEditor({
        config: PRODUCTS_CONFIG, items: p.items, shopLocales, primaryLocale: "de", fetcher: { ...p.f },
        showInfoBox: vi.fn(), t: { common: {}, content: {} } as any, initialItemId: A, initialLocale: "de", markets: [],
      } as any),
    { initialProps: { items: items(shop), f: fetcher } },
  );
  const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 12)); });
  let shown: Shop = shop;
  const rerender = async (state: Shop, data?: any) => {
    shown = state;
    fetcher.data = data;
    await act(async () => { hook.rerender({ items: items(state), f: { ...fetcher } }); });
    await settle();
  };
  const v = () => hook.result.current.state.editableValues;
  const h = () => hook.result.current.handlers;
  const log: string[] = [];
  const fail = (msg: string) => { throw new Error(`seed ${seed}: ${msg}\nops: ${log.join(" | ")}`); };
  await settle();

  type Req = { sent: Record<string, string>; changed: string[] };
  const unanswered: Req[] = [];
  let seen = 0;
  // The hook reads the fetcher's state from its props: a submit it did not make itself
  // (a drained queue entry) must be followed by a render that shows 'submitting'.
  const collectSubmits = async () => {
    const before = seen;
    while (seen < fetcher.submit.mock.calls.length) {
      const fd = fetcher.submit.mock.calls[seen++][0] as FormData;
      const sent = Object.fromEntries([...fd.entries()].map(([k, x]) => [k, String(x)]));
      if (sent.action !== "updateContent" || sent.itemId !== A) continue;
      const changed: string[] = JSON.parse(sent.changedFields ?? "[]");
      // invariant 1
      for (const [prop, key] of FIELDS) {
        if (changed.includes(key)) continue;
        const allowed = new Set([shop[prop], ...unanswered.map((r) => r.sent[key])]);
        if (!allowed.has(sent[key])) fail(`sent ${key}=${sent[key]} without changedFields; Shopify holds ${shop[prop]}`);
      }
      unanswered.push({ sent, changed });
      fetcher.state = "submitting";
    }
    if (seen !== before || fetcher.state === "submitting") await rerender(shown, fetcher.data);
  };
  const checkClean = () => {
    if (unanswered.length > 0 || hook.result.current.state.selectedItemId !== A) return;
    for (const [prop, key] of FIELDS) {
      if (v()[key] !== shop[prop] && !hook.result.current.state.hasChanges) {
        fail(`${key} shows "${v()[key]}" but Shopify holds "${shop[prop]}" and nothing reads as changed`);
      }
    }
  };

  for (let i = 0; i < steps; i++) {
    const op = pick(["edit", "edit", "save", "save", "answer", "answer", "lag", "fresh", "away"]);
    if (op === "edit") {
      const [, key] = pick(FIELDS);
      const val = pick(VALUES);
      log.push(`edit ${key}=${val}`);
      act(() => h().handleValueChange(key, val));
    } else if (op === "save") {
      log.push("save");
      act(() => h().handleSave());
      await collectSubmits();
      await settle();
    } else if (op === "answer") {
      if (unanswered.length === 0) continue;
      const req = unanswered.shift()!;
      const ok = rand() < 0.5;
      log.push(ok ? "answer ok" : "answer refused");
      if (ok) {
        for (const [prop, key] of FIELDS) shop[prop] = req.sent[key];
        history.push({ ...shop });
      }
      fetcher.state = "idle";
      await rerender(shop, ok ? { success: true, actionType: "updateContent", n: i } : { success: false, error: "busy", rateLimited: true, actionType: "updateContent", n: i });
      await collectSubmits();
      if (unanswered.length > 0 && fetcher.state !== "submitting") { fetcher.state = "submitting"; await rerender(shown, fetcher.data); }
    } else if (op === "lag") {
      moved++;
      const old = pick(history);
      log.push(`lagging read ${old.title}/${old.meta}`);
      await rerender(old, fetcher.data);
    } else if (op === "fresh") {
      moved++;
      log.push("fresh read");
      await rerender(shop, fetcher.data);
    } else if (op === "away") {
      log.push("away and back");
      await act(async () => { await h().handleItemSelect(B); });
      await settle();
      await act(async () => { await h().handleItemSelect(A); });
      await settle();
    }
    await collectSubmits();
    if (process.env.PROPERTY_TRACE) console.log("TRACE", log[log.length - 1], "| meta", v().metaDescription, "title", v().title, "shop", shop.title + "/" + shop.meta, "dirty", hook.result.current.state.hasChanges, "out", unanswered.length);
    checkClean();
  }
}

beforeEach(() => { try { window.localStorage.clear(); } catch { /* none */ } });

describe("overlapping primary saves: a model of Shopify against the real editor", () => {
  it("holds both invariants over random sequences", async () => {
    const runs = Number(process.env.PROPERTY_RUNS ?? 200);
    const only = process.env.PROPERTY_SEED ? Number(process.env.PROPERTY_SEED) : null;
    for (let seed = only ?? 1; seed <= (only ?? runs); seed++) await runOne(seed, 16);
  }, 120_000);
});
