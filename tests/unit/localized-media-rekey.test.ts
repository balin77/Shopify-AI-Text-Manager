import { describe, it, expect } from "vitest";
import { isSafeFilename as tsSafe, storefrontFilename as tsName } from "~/services/localized-media/localized-media.shared";
import * as js from "../../localized-media-rekey.js";

const NAMES: unknown[] = [
  "a.webp", "a b.webp", "a\"b.jpg", "a'b", "<x>.png", "a\\b", ".", "..", "", "x".repeat(255), "x".repeat(256),
  "café.png", "a%20b.webp", "a+b~c-d_e.webp", "a/b", null, undefined, 5, "a;b", "a]b",
];
const URLS = [
  "https://cdn.shopify.com/s/files/1/0/0/products/a_b.webp?v=123", "https://cdn.shopify.com/x/y.png#frag",
  "https://cdn.shopify.com/x/", "", null, undefined, "plain.jpg", "https://cdn.shopify.com/x/a b.png",
];

describe("webp re-key parity with the TS rules", () => {
  it("isSafeFilename agrees", () => {
    for (const n of NAMES) expect(js.isSafeFilename(n), String(n)).toBe(tsSafe(n));
  });
  it("storefrontFilename agrees", () => {
    for (const u of URLS) expect(js.storefrontFilename(u), String(u)).toBe(tsName(u as any));
  });
});

const OLD = "gid://shopify/MediaImage/1";
const NEW = "gid://shopify/MediaImage/2";
const URL2 = "https://cdn.shopify.com/s/files/1/x/new_name.webp?v=9";
const e = (o: any) => ({ o: "old.png", m: OLD, l: "de", k: "", u: "https://cdn.shopify.com/r.png", f: "gid://shopify/MediaImage/9", a: "manual", s: "https://cdn.shopify.com/old.png?v=1", t: "2026", ...o });

describe("rekeyLocalizedMediaValue", () => {
  it("rewrites only entries of the old medium", () => {
    const other = e({ m: "gid://shopify/MediaImage/5", o: "z.png" });
    const video = { ...e({}), x: "v" };
    const raw = JSON.stringify({ v: 1, extra: 1, e: [e({}), other, video, e({ l: "fr" })] });
    const r = js.rekeyLocalizedMediaValue(raw as string, OLD, NEW, URL2);
    expect(r.changed).toBe(true);
    expect(r.count).toBe(2);
    const out = JSON.parse(r.value as string);
    expect(out.extra).toBe(1);
    expect(out.e[0]).toEqual({ ...e({}), m: NEW, o: "new_name.webp", s: URL2 });
    expect(out.e[1]).toEqual(other);
    expect(out.e[2]).toEqual(video);
    expect(out.e[3].m).toBe(NEW);
  });
  it("leaves foreign, empty and unrelated values alone", () => {
    for (const raw of [null, "", "not json", "[]", '{"a":1}', JSON.stringify({ v: 1, e: [] })]) {
      expect(js.rekeyLocalizedMediaValue(raw, OLD, NEW, URL2).changed).toBe(false);
    }
    const r = js.rekeyLocalizedMediaValue(JSON.stringify({ v: 1, e: [e({ m: "gid://shopify/MediaImage/5" })] }), OLD, NEW, URL2);
    expect(r).toEqual({ changed: false, reason: "no-entries" });
  });
  it("treats a list with no usable entry as foreign", () => {
    const raw = JSON.stringify({ v: 1, e: [{ m: OLD, foo: 1 }] });
    expect(js.rekeyLocalizedMediaValue(raw, OLD, NEW, URL2).reason).toBe("foreign");
  });
  it("refuses an unsafe new filename", () => {
    const raw = JSON.stringify({ v: 1, e: [e({})] });
    expect(js.rekeyLocalizedMediaValue(raw, OLD, NEW, "https://cdn.shopify.com/x/a\"b.png").reason).toBe("unsafe-filename");
    expect(js.rekeyLocalizedMediaValue(raw, OLD, NEW, "").reason).toBe("unsafe-filename");
  });
});

describe("rekeyLocalizedMediaAfterConversion", () => {
  const mk = (stored: string | null, echo: "ok" | "none" | "errors") => {
    const calls: string[] = [];
    const fetchFn = async (_u: string, o: any) => {
      const { query, variables } = JSON.parse(o.body);
      calls.push(query.includes("mutation") ? "write" : "read");
      let data: any;
      if (!query.includes("mutation")) data = { product: { metafield: stored === null ? null : { value: stored } } };
      else if (echo === "errors") data = { metafieldsSet: { metafields: [], userErrors: [{ message: "x" }] } };
      else data = { metafieldsSet: { metafields: echo === "ok" ? [{ owner: { id: "p" }, namespace: "custom", key: "localized_media", value: JSON.stringify(JSON.parse(variables.m[0].value), null, 1) }] : [], userErrors: [] } };
      return { ok: true, json: async () => ({ data }) };
    };
    return { calls, fetchFn };
  };
  const run = (stored: string | null, echo: any, url: string | null) => {
    const m = mk(stored, echo);
    return m.fetchFn && js.rekeyLocalizedMediaAfterConversion({
      fetchFn: m.fetchFn, shopifyApiUrl: "u", headers: {}, productId: "p", oldMediaId: OLD, newMediaId: NEW,
      resolvedUrl: null, fetchUrl: async () => url, sleep: async () => {},
    }).then((r: string) => ({ r, calls: m.calls }));
  };
  const stored = JSON.stringify({ v: 1, e: [e({})] });
  it("writes and confirms by echo", async () => {
    expect(await run(stored, "ok", URL2)).toEqual({ r: "rekeyed 1 entry", calls: ["read", "write"] });
  });
  it("serialises concurrent runs for one product", async () => {
    let stored = JSON.stringify({ v: 1, e: [e({}), e({ m: "gid://shopify/MediaImage/3", o: "b.png" })] });
    const fetchFn = async (_u: string, o: any) => {
      const { query, variables } = JSON.parse(o.body);
      await new Promise((r) => setTimeout(r, 5));
      if (!query.includes("mutation")) return { ok: true, json: async () => ({ data: { product: { metafield: { value: stored } } } }) };
      stored = variables.m[0].value;
      return { ok: true, json: async () => ({ data: { metafieldsSet: { metafields: [{ owner: { id: "p" }, namespace: "custom", key: "localized_media", value: stored }], userErrors: [] } } }) };
    };
    const go = (o: string, n: string, u: string) => js.rekeyLocalizedMediaAfterConversion({ fetchFn, shopifyApiUrl: "u", headers: {}, productId: "p", oldMediaId: o, newMediaId: n, resolvedUrl: u, fetchUrl: async () => null });
    await Promise.all([go(OLD, NEW, URL2), go("gid://shopify/MediaImage/3", "gid://shopify/MediaImage/4", "https://cdn.shopify.com/s/c.webp")]);
    expect(JSON.parse(stored).e.map((x: any) => x.m)).toEqual([NEW, "gid://shopify/MediaImage/4"]);
  });
  it("no entries: one read, no write", async () => {
    expect(await run(null, "ok", URL2)).toEqual({ r: "skipped: empty", calls: ["read"] });
  });
  it("no URL: no write", async () => {
    const x = await run(stored, "ok", null);
    expect(x?.r).toMatch(/^orphaned/);
    expect(x?.calls).toEqual(["read"]);
  });
  it("userErrors or missing echo is not success", async () => {
    expect((await run(stored, "errors", URL2))?.r).toMatch(/^failed/);
    expect((await run(stored, "none", URL2))?.r).toMatch(/^failed/);
  });
});
