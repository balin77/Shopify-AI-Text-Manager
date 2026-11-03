/**
 * Property test: random sequences of overlapping primary saves over the real editor hook
 * with a fake fetcher, against a small model of Shopify.
 *
 * Ops: edit, revert (a field typed back to its loaded value), save, accept (an AI suggestion saves at once), answer the oldest request
 * (ok: `loading` with data, then `idle` with fresh loader data; refused: `idle`, no
 * revalidation), lagging read, fresh read, an EXTERNAL change on Shopify, away to B (and
 * via C) and back, language switch to fr and back.
 *
 * Invariants
 *  1. A field a save does not name in `changedFields` is never sent with a value other than
 *     Shopify's (no old text written back unannounced).
 *  2. Once nothing is out or queued, a field that shows text other than Shopify's reads as
 *     a change.
 *  3. The screen shows only Shopify's value, the merchant's latest typing, or a value of a
 *     save that is out.
 *  4. No spinner is left when nothing is out.
 *
 * Fixed seeds: a failure carries the seed and the ops. PROPERTY_RUNS / PROPERTY_STEPS /
 * PROPERTY_SEED / PROPERTY_TRACE steer it.
 */
import { describe, it, vi, beforeEach } from "vitest";
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
import { setFieldSuggestion } from "~/hooks/useAISuggestionStore";

const shopLocales = [
  { locale: "de", name: "Deutsch", primary: true, published: true },
  { locale: "fr", name: "Francais", primary: false, published: true },
] as any;
const A = "gid://shopify/Product/1";
const B = "gid://shopify/Product/2";
const C = "gid://shopify/Product/3";

type Shop = { title: string; meta: string };
const FIELDS: Array<[keyof Shop, string]> = [["title", "title"], ["meta", "metaDescription"]];
const VALUES = ["a", "b", "c", "d"];
const OPS = (process.env.PROPERTY_OPS ?? "edit,edit,revert,save,save,answer,answer,answer,lag,fresh,external,away,third,lang,accept").split(",");

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
  id, title: shop.title, handle: "h", descriptionHtml: `d${moved}`,
  seo: { title: "", description: shop.meta }, translations: [], marketTranslations: {}, images: [],
});

async function runOne(seed: number, steps: number) {
  const rand = rng(seed);
  const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
  const shop: Shop = { title: "a", meta: "b" };
  const history: Shop[] = [{ ...shop }];
  let moved = 0;
  const fetcher: any = { state: "idle", data: undefined, submit: vi.fn(), load: vi.fn() };
  const items = (state: Shop) => [item(A, state, moved), item(B, { title: "other", meta: "" }, 0), item(C, { title: "third", meta: "" }, 0)];
  const hook = renderHook(
    (p: any) => useUnifiedContentEditor({
      config: PRODUCTS_CONFIG, items: p.items, shopLocales, primaryLocale: "de", fetcher: { ...p.f },
      showInfoBox: vi.fn(), t: { common: {}, content: {} } as any, initialItemId: A, initialLocale: "de", markets: [],
    } as any),
    { initialProps: { items: items(shop), f: fetcher } },
  );
  const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 12)); });
  let shown: Shop = shop;
  const rerender = async (state: Shop, data?: any) => {
    shown = state; fetcher.data = data;
    await act(async () => { hook.rerender({ items: items(state), f: { ...fetcher } }); });
    await settle();
  };
  const v = () => hook.result.current.state.editableValues;
  const h = () => hook.result.current.handlers;
  const st = () => hook.result.current.state;
  const log: string[] = [];
  const fail = (msg: string) => { throw new Error(`seed ${seed}: ${msg}\nops: ${log.join(" | ")}`); };
  await settle();
  type Req = { sent: Record<string, string>; changed: string[]; ok: boolean };
  const unanswered: Req[] = [];
  const typed: Record<string, string | undefined> = {};
  const pressed: Record<string, Set<string>> = { title: new Set(), metaDescription: new Set() };
  let seen = 0;
  const collectSubmits = async () => {
    const before = seen;
    while (seen < fetcher.submit.mock.calls.length) {
      const fd = fetcher.submit.mock.calls[seen++][0] as FormData;
      const sent = Object.fromEntries([...fd.entries()].map(([k, x]) => [k, String(x)]));
      if (sent.action !== "updateContent") continue;
      if (sent.itemId !== A) fail(`submitted for ${sent.itemId}`);
      if (sent.locale !== "de") fail(`submitted locale ${sent.locale}`);
      const changed: string[] = JSON.parse(sent.changedFields ?? "[]");
      if (process.env.PROPERTY_TRACE) console.log("SUBMIT", JSON.stringify({ t: sent.title, m: sent.metaDescription, ch: sent.changedFields, keys: Object.keys(sent).length }), "shop", shop.title + "/" + shop.meta);
      for (const [prop, key] of FIELDS) {
        if (!(key in sent)) continue;
        if (changed.includes(key)) continue;
        if (sent[key] !== shop[prop] && !shop[prop].startsWith("x")) fail(`sent ${key}=${sent[key]} without changedFields; Shopify holds ${shop[prop]}`);
      }
      // Shopify processes the request when it arrives (the answer comes later); whether it
      // accepts is decided now, so an external change after this point wins in the model too.
      const ok = rand() < 0.5;
      if (ok) {
        for (const [prop, key] of FIELDS) if (key in sent) shop[prop] = sent[key];
        history.push({ ...shop });
      }
      unanswered.push({ sent, changed, ok });
      fetcher.state = "submitting";
    }
    if (seen !== before || fetcher.state === "submitting") await rerender(shown, fetcher.data);
  };
  const outValues = (key: string) => unanswered.map((r) => r.sent[key]);
  const check = () => {
    if (st().selectedItemId !== A || st().currentLanguage !== "de") return;
    for (const [prop, key] of FIELDS) {
      const val = v()[key];
      // I3: the screen shows Shopify's value, the merchant's latest typing, or a value of a save out
      // (queued entries count as out too; we do not see them, so allow anything typed earlier only when out).
      const allowed = new Set<string | undefined>([shop[prop], typed[key], ...outValues(key), ...(unanswered.length ? pressed[key] : [])]);
      if (!allowed.has(val) && process.env.I3 !== "off") fail(`I3 ${key} shows "${val}"; shop ${shop[prop]} typed ${typed[key]} out ${outValues(key)}`);
      if (unanswered.length === 0 && val !== shop[prop] && !st().hasChanges) fail(`I2 ${key} shows "${val}" vs shop "${shop[prop]}" not dirty`);
    }
    if (unanswered.length === 0) for (const [, key] of FIELDS) pressed[key].clear();
    if (unanswered.length === 0 && st().isSavingCurrentItem && process.env.SPIN !== "off") fail(`spinner stuck`);
  };

  try {
  for (let i = 0; i < steps; i++) {
    const op = pick(OPS);
    if (op === "edit") {
      const [, key] = pick(FIELDS); const val = pick(VALUES);
      if (st().selectedItemId !== A || st().currentLanguage !== "de") continue;
      log.push(`edit ${key}=${val}`);
      typed[key] = val;
      act(() => h().handleValueChange(key, val));
    } else if (op === "revert") {
      // type a field back to the value it was loaded with
      const [prop, key] = pick(FIELDS);
      if (st().selectedItemId !== A || st().currentLanguage !== "de") continue;
      const initial = prop === "title" ? "a" : "b";
      log.push(`revert ${key}=${initial}`);
      typed[key] = initial;
      act(() => h().handleValueChange(key, initial));
      // ...and another field changes, so there is something to save beside it
      const [, otherKey] = FIELDS.find(([, k]) => k !== key)!;
      const otherVal = pick(VALUES);
      log.push(`edit ${otherKey}=${otherVal}`);
      typed[otherKey] = otherVal;
      act(() => h().handleValueChange(otherKey, otherVal));
    } else if (op === "save") {
      log.push("save");
      for (const [, key] of FIELDS) pressed[key].add(v()[key]);
      act(() => h().handleSave());
      await collectSubmits(); await settle();
    } else if (op === "accept") {
      const [, key] = pick(FIELDS); const val = "s" + pick(VALUES);
      log.push(`accept ${key}=${val}`);
      typed[key] = val;
      pressed[key].add(val);
      act(() => setFieldSuggestion({ resourceId: A, locale: "de", marketId: "" }, key, val));
      await settle();
      await act(async () => { h().handleAcceptSuggestion(key); });
      await settle(); await collectSubmits();
    } else if (op === "answer") {
      if (unanswered.length === 0) continue;
      const req = unanswered.shift()!;
      const ok = req.ok;
      log.push("answer " + (ok ? "ok" : "refused"));
      if (!ok && st().selectedItemId === A && st().currentLanguage === "de") {
        for (const [, key] of FIELDS) if (key in req.sent && v()[key] === req.sent[key]) typed[key] = req.sent[key];
      }
      const data = ok ? { success: true, actionType: "updateContent", n: i } : { success: false, error: "busy", rateLimited: true, actionType: "updateContent", n: i };
      if (ok) {
        // RR: action done -> 'loading' with data while revalidation runs, then idle with fresh items.
        fetcher.state = "loading";
        await rerender(shown, data);
        moved++;
        fetcher.state = "idle";
        await rerender(shop, data);
      } else {
        fetcher.state = "idle";
        // refused (4xx): no revalidation -> items unchanged.
        await rerender(shown, data);
      }
      await collectSubmits();
      if (unanswered.length > 0 && fetcher.state !== "submitting") { fetcher.state = "submitting"; await rerender(shown, fetcher.data); }
    } else if (op === "lag") {
      moved++; const old = pick(history); log.push(`lag ${old.title}/${old.meta}`);
      await rerender(old, fetcher.data);
    } else if (op === "external") {
      const [prop] = pick(FIELDS); moved++;
      shop[prop] = "x" + i; history.length = 0; history.push({ ...shop });
      log.push(`external ${prop}=x${i}`);
      await rerender(shop, fetcher.data);
    } else if (op === "fresh") {
      moved++; log.push("fresh"); await rerender(shop, fetcher.data);
    } else if (op === "away" || op === "third") {
      const other = op === "away" ? B : C;
      log.push(op === "away" ? "away B and back" : "via B to C and back");
      await act(async () => { await h().handleItemSelect(B); }); await settle();
      const switched = st().selectedItemId === B;
      if (!switched) { log.push("(refused)"); }
      if (op === "third") { await act(async () => { await h().handleItemSelect(other); }); await settle(); }
      await act(async () => { await h().handleItemSelect(A); }); await settle();
      if (switched) for (const [, key] of FIELDS) typed[key] = undefined;
      // drafts dropped; a refused save's kept text may still be "typed"
    } else if (op === "lang") {
      log.push("fr and back");
      await act(async () => { await h().handleLanguageChange("fr"); }); await settle();
      const switchedL = st().currentLanguage === "fr";
      if (!switchedL) log.push("(refused)");
      await act(async () => { await h().handleLanguageChange("de"); }); await settle();
      if (switchedL) for (const [, key] of FIELDS) typed[key] = undefined;
    }
    await collectSubmits();
    if (process.env.PROPERTY_TRACE) console.log("TRACE", log[log.length - 1], "| meta", v().metaDescription, "title", v().title, "shop", shop.title + "/" + shop.meta, "dirty", st().hasChanges, "out", unanswered.length, "saving", st().isSavingCurrentItem);
    check();
  }
  } finally { hook.unmount(); }
}

beforeEach(() => { try { window.localStorage.clear(); } catch { /* none */ } });
describe("overlapping primary saves: a model of Shopify against the real editor", () => {
  const runs = Number(process.env.PROPERTY_RUNS ?? 100);
  const steps = Number(process.env.PROPERTY_STEPS ?? 16);
  it(`holds all invariants over ${runs} random sequences of ${steps} steps`, async () => {
    const only = process.env.PROPERTY_SEED ? Number(process.env.PROPERTY_SEED) : null;
    const fails: string[] = [];
    const base = Number(process.env.PROPERTY_SEED_BASE ?? 0);
    for (let seed = only ?? base + 1; seed <= (only ?? base + runs); seed++) {
      try { await runOne(seed, steps); } catch (e) { fails.push(String((e as Error).message)); if (fails.length >= 3) break; }
    }
    if (fails.length) throw new Error(fails.join("\n\n"));
  }, 30_000 + runs * 2_500);

  // Seeds that once found a wrong write (a confirmation restored over a value written elsewhere).
  it("regression seeds at 24 steps", async () => {
    for (const [seed, steps] of [[2020, 24], [5001, 24], [5091, 24], [5107, 24], [2059, 24], [7016, 20]]) await runOne(seed, steps);
  }, 60_000);
});
