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
import { setFieldSuggestion } from "~/hooks/useAISuggestionStore";

const shopLocales = [
  { locale: "de", name: "Deutsch", primary: true, published: true },
  { locale: "fr", name: "Francais", primary: false, published: true },
] as any;
const A = "gid://shopify/Product/1";
const B = "gid://shopify/Product/2";
const C = "gid://shopify/Product/3";

type Shop = { title: string; meta: string; body: string };
const FIELDS: Array<[keyof Shop, string]> = [["title", "title"], ["meta", "metaDescription"]];
/** The rich text field is never edited by the random runs; the scripted ones move it from outside. */
const ALL_FIELDS: Array<[keyof Shop, string]> = [...FIELDS, ["body", "description"]];
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
const item = (id: string, shop: Shop, moved: number, rich = false) => ({
  id, title: shop.title, handle: "h", descriptionHtml: rich ? shop.body : `d${moved}`,
  seo: { title: "", description: shop.meta }, translations: [], marketTranslations: {}, images: [],
});

/** One scripted step (the named sequences below): the random runner with its picks fixed. */
type Step = { op: string; key?: string; val?: string; ok?: boolean; hist?: number; prop?: keyof Shop };

async function runOne(seed: number, steps: number, script?: Step[]): Promise<Shop> {
  if (script) steps = script.length;
  const scriptedOk: boolean[] = [];
  const rand = rng(seed);
  const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
  const shop: Shop = { title: "a", meta: "b", body: "<p>a</p>" };
  const history: Shop[] = [{ ...shop }];
  let moved = 0;
  const fetcher: any = { state: "idle", data: undefined, submit: vi.fn(), load: vi.fn() };
  const items = (state: Shop) => [item(A, state, moved, !!script?.some((st) => st.prop === "body")), item(B, { title: "other", meta: "", body: "" }, 0), item(C, { title: "third", meta: "", body: "" }, 0)];
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
      if (process.env.PROPERTY_TRACE) console.log("SUBMIT", Object.keys(sent).join(","), JSON.stringify({ t: sent.title, m: sent.metaDescription, ch: sent.changedFields, keys: Object.keys(sent).length }), "shop", shop.title + "/" + shop.meta);
      // The server does not write PASSENGERS (a field sent without being announced): the model does
      // the same. Invariant 1: a field that is sent and not announced must be NAMED a passenger,
      // whatever Shopify holds - otherwise an old text could be written over a newer one.
      const passengers: string[] = JSON.parse(sent.passengerFields ?? "[]");
      const written = new Set<string>();
      for (const [, key] of ALL_FIELDS) {
        if (!(key in sent)) continue;
        if (changed.includes(key)) { written.add(key); continue; }
        // An accepted suggestion / own-field save carries ONE field and names no passenger: the merchant
        // pressed that button for that field, so it is the intent and is written.
        if (!sent.passengerFields && ALL_FIELDS.filter(([, k]) => k in sent).length === 1) { written.add(key); continue; }
        if (!passengers.includes(key)) fail(`sent ${key}=${sent[key]} neither announced nor named a passenger; Shopify holds ${shop[ALL_FIELDS.find(([, k]) => k === key)![0]]}`);
      }
      // Shopify processes the request when it arrives (the answer comes later); whether it
      // accepts is decided now, so an external change after this point wins in the model too.
      const ok = (scriptedOk.length ? scriptedOk.shift()! : rand() < 0.5);
      if (ok) {
        // Shopify normalises on write (trim): a value typed with spaces is stored trimmed.
        for (const [prop, key] of ALL_FIELDS) if (written.has(key)) shop[prop] = sent[key].trim();
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
      if (script) continue; // scripted runs assert the WRITE side (Shopify's final value) only: the display may lag
      if (!allowed.has(val) && process.env.I3 !== "off") fail(`I3 ${key} shows "${val}"; shop ${shop[prop]} typed ${typed[key]} out ${outValues(key)}`);
      if (unanswered.length === 0 && val !== shop[prop] && !st().hasChanges) fail(`I2 ${key} shows "${val}" vs shop "${shop[prop]}" not dirty`);
    }
    if (unanswered.length === 0) for (const [, key] of FIELDS) pressed[key].clear();
    if (!script && unanswered.length === 0 && st().isSavingCurrentItem && process.env.SPIN !== "off") fail(`spinner stuck`);
  };

  try {
  for (let i = 0; i < steps; i++) {
    const step = script?.[i];
    const op = step?.op ?? pick(OPS);
    if (step?.ok !== undefined && (op === "save" || op === "accept")) scriptedOk.push(step.ok);
    if (op === "edit") {
      const [, key] = step?.key ? FIELDS.find(([, k]) => k === step.key)! : pick(FIELDS); const val = step?.val ?? pick(VALUES);
      if (st().selectedItemId !== A || st().currentLanguage !== "de") continue;
      log.push(`edit ${key}=${val}`);
      typed[key] = val;
      act(() => h().handleValueChange(key, val));
    } else if (op === "spaced") {
      // opt-in op (PROPERTY_OPS): type a value with surrounding spaces; the model stores it trimmed
      const [, key] = pick(FIELDS);
      if (st().selectedItemId !== A || st().currentLanguage !== "de") continue;
      const val = " " + pick(VALUES) + " ";
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
      const [, key] = step?.key ? FIELDS.find(([, k]) => k === step.key)! : pick(FIELDS); const val = step?.val ?? "s" + pick(VALUES);
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
      moved++; const old = step?.hist !== undefined ? history[step.hist] : pick(history); log.push(`lag ${old.title}/${old.meta}`);
      await rerender(old, fetcher.data);
    } else if (op === "external") {
      const [prop] = step?.prop ? [step.prop] : pick(FIELDS); moved++;
      shop[prop] = step?.val ?? "x" + i; if (!script) history.length = 0; history.push({ ...shop });
      log.push(`external ${prop}=x${i}`);
      await rerender(shop, fetcher.data);
    } else if (op === "reload") {
      // The Reload button: the editor re-reads the item in place, the loader answers with `shown`.
      moved++; log.push("reload");
      await act(async () => { hook.result.current.helpers.triggerDataRefresh(); }); await settle();
      await rerender(shown, fetcher.data);
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
  return { ...shop };
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
  // The five documented ways an OLD text could be written back (KNOWN_ISSUES, editor part): each is a
  // fixed sequence over the real hook against the model of Shopify, which does not write a field a
  // save sends without announcing (the server's passenger rule). The run fails when the editor sends
  // such a field without naming it a passenger (invariant 1); the end state is asserted on top.
  const T = (key: string, val: string): Step[] => [{ op: "edit", key, val }];
  const SAVE = (ok = true): Step[] => [{ op: "save", ok }];
  const ANSWER: Step[] = [{ op: "answer" }];
  const scenarios: Array<[string, Step[], Partial<Shop>]> = [
    ["(a) a reload during a save, then a delayed read of the old text, then the next save",
      [...T("title", "c"), ...SAVE(), ...ANSWER, ...T("metaDescription", "d"), ...SAVE(), { op: "reload" }, { op: "lag", hist: 0 },
        ...ANSWER, ...T("metaDescription", "e"), ...SAVE(), ...ANSWER],
      { title: "c", meta: "e" }],
    ["(b) a field that rides along while an outside change lands, then a delayed read of the old text",
      [...T("title", "c"), ...SAVE(), ...ANSWER, ...T("metaDescription", "d"), ...SAVE(), { op: "external", prop: "title", val: "x1" },
        { op: "lag", hist: 1 }, ...ANSWER, ...T("metaDescription", "e"), ...SAVE(), ...ANSWER],
      { title: "x1", meta: "e" }],
    ["(c) a later read with the old content, twice, then a save of another field",
      [...T("title", "c"), ...SAVE(), ...ANSWER, { op: "lag", hist: 0 }, { op: "reload" }, { op: "lag", hist: 0 },
        ...T("metaDescription", "d"), ...SAVE(), ...ANSWER, { op: "lag", hist: 0 }, ...T("metaDescription", "e"), ...SAVE(), ...ANSWER],
      { title: "c", meta: "e" }],
    ["(d1) a delayed read of the old text while someone set a third value",
      [...T("title", "c"), ...SAVE(), ...ANSWER, { op: "external", prop: "title", val: "x9" }, { op: "lag", hist: 1 },
        ...T("metaDescription", "d"), ...SAVE(), ...ANSWER],
      { title: "x9", meta: "d" }],
    ["(d2) a delayed read of our text while someone changed it back to the old one in the admin",
      [...T("title", "c"), ...SAVE(), ...ANSWER, { op: "external", prop: "title", val: "a" }, { op: "lag", hist: 1 },
        ...T("metaDescription", "d"), ...SAVE(), ...ANSWER],
      { title: "a", meta: "d" }],
    ["(e) the rich text changed in the admin while another field is saved",
      [...T("title", "c"), ...SAVE(), { op: "external", prop: "body", val: "<p>x</p>" }, { op: "lag", hist: 0 }, ...ANSWER,
        ...T("title", "d"), ...SAVE(), ...ANSWER],
      { title: "d", body: "<p>x</p>" }],
  ];
  for (const [name, script, expected] of scenarios) {
    it(`${name}: Shopify keeps the newer text`, async () => {
      const finalShop = await runOne(1, script.length, script);
      for (const [key, value] of Object.entries(expected)) expect(finalShop[key as keyof Shop]).toBe(value);
    }, 30_000);
  }
});
