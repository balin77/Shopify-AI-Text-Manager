import { describe, it, expect, vi } from "vitest";
import { isSafeFilename as tsSafe, storefrontFilename as tsName, isForeignLocalizedMediaValue as tsForeign } from "~/services/localized-media/localized-media.shared";
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

describe("foreign-value classification parity", () => {
  const O = "gid://shopify/MediaImage/1";
  const img = (o: any = {}) => ({ o: "a.png", m: O, l: "de", k: "", u: "https://cdn.shopify.com/r.png", f: "gid://shopify/File/9", ...o });
  const vid = (o: any = {}) => ({ ...img({ u: "" }), x: "v", p: "p.jpg", w: [{ u: "https://cdn.shopify.com/v.mp4", t: "video/mp4" }], ...o });
  const emb = (o: any = {}) => ({ ...img({ u: "" }), x: "e", r: "https://www.youtube.com/embed/abcdefghijk", ...o });
  const doc = (e: any[]) => JSON.stringify({ v: 1, e });
  const { f: _f, ...noF } = img();
  const FIXTURES: Array<[string, unknown]> = [
    ["valid image", doc([img()])], ["missing f", doc([noF])], ["non-CDN u", doc([img({ u: "https://evil.com/r.png" })])],
    ["empty k string missing", doc([{ ...img(), k: undefined }])],
    ["valid video", doc([vid()])], ["video no sources", doc([vid({ w: [] })])], ["video bad mime", doc([vid({ w: [{ u: "https://cdn.shopify.com/v.mp4", t: "text/html" }] })])],
    ["video bad poster", doc([vid({ p: "a/b" })])], ["video non-CDN u", doc([vid({ u: "https://evil.com/x" })])],
    ["valid embed", doc([emb()])], ["embed bad r", doc([emb({ r: "https://evil.com/embed/x" })])],
    ["embed bad u", doc([emb({ u: "https://cdn.shopify.com/x.png" })])],
    ["unknown x", doc([img({ x: "z" })])], ["mixed list", doc([img({ u: "http://x" }), img()])],
    ["empty list", doc([])], ["no e", JSON.stringify({ v: 1 })], ["array", "[]"], ["non-JSON", "nope"], ["blank", "  "], ["null", null],
    ["entry null", doc([null as any])],
  ];
  for (const [name, raw] of FIXTURES) {
    it(name, () => expect(js.isForeignLocalizedMediaValue(raw), name).toBe(tsForeign(raw)));
  }
  it("does not rewrite what TS calls foreign", () => {
    for (const [name, raw] of FIXTURES) {
      if (typeof raw === "string" && tsForeign(raw)) {
        expect(js.rekeyLocalizedMediaValue(raw, O, "gid://shopify/MediaImage/2", "https://cdn.shopify.com/n.webp").changed, name).toBe(false);
      }
    }
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

describe("rekeyLocalizedMediaAfterConversion: retries, deadline, chain, echo", () => {
  const stored = JSON.stringify({ v: 1, e: [e({})] });
  const base = (fetchFn: any, extra: any = {}) => ({
    fetchFn, shopifyApiUrl: "u", headers: {}, productId: "p", oldMediaId: OLD, newMediaId: NEW,
    resolvedUrl: URL2, fetchUrl: async () => null, sleep: async () => {}, ...extra,
  });
  const ok = (data: any) => ({ ok: true, json: async () => ({ data }) });
  const writeOk = (v: string, id = "p", value?: string) => ok({ metafieldsSet: { metafields: [{ owner: { id }, namespace: "custom", key: "localized_media", value: value ?? v }], userErrors: [] } });
  const throttled = { ok: true, json: async () => ({ errors: [{ extensions: { code: "THROTTLED" } }] }) };

  it("retries a THROTTLED read once, using the injected sleep", async () => {
    let reads = 0;
    const sleep = vi.fn(async () => {});
    const fetchFn = async (_u: string, o: any) => {
      const { query, variables } = JSON.parse(o.body);
      if (!query.includes("mutation")) { reads += 1; return reads === 1 ? throttled : ok({ product: { metafield: { value: stored } } }); }
      return writeOk(variables.m[0].value);
    };
    expect(await js.rekeyLocalizedMediaAfterConversion(base(fetchFn, { sleep }))).toBe("rekeyed 1 entry");
    expect(reads).toBe(2);
    expect(sleep).toHaveBeenCalledWith(1000);
  });
  it("fails after two THROTTLED answers", async () => {
    let n = 0;
    const fetchFn = async () => { n += 1; return throttled; };
    expect(await js.rekeyLocalizedMediaAfterConversion(base(fetchFn))).toMatch(/^failed: .*THROTTLED/);
    expect(n).toBe(2);
  });
  it("deadline starts when the job runs and reports a timeout, not a failure", async () => {
    const fetchFn = () => new Promise(() => {});
    const r = await js.rekeyLocalizedMediaAfterConversion(base(fetchFn, { productId: "dl", deadlineMs: 20 }));
    expect(r).toMatch(/^timed out/);
    expect(r).toMatch(/may still complete in background/);
  });
  it("the chain continues after a hung job and after a rejecting one", async () => {
    let first = true;
    const hang = () => new Promise(() => {});
    const good = async (_u: string, o: any) => {
      const { query, variables } = JSON.parse(o.body);
      return !query.includes("mutation") ? ok({ product: { metafield: { value: stored } } }) : writeOk(variables.m[0].value, variables.m[0].ownerId);
    };
    const fetchFn = (u: string, o: any) => { if (first) { first = false; return hang(); } return good(u, o); };
    const a = js.rekeyLocalizedMediaAfterConversion(base(fetchFn, { productId: "ch", deadlineMs: 20 }));
    const b = js.rekeyLocalizedMediaAfterConversion(base(fetchFn, { productId: "ch", deadlineMs: 200 }));
    expect(await a).toMatch(/^timed out/);
    expect(await b).toBe("rekeyed 1 entry");
    const rej = async () => { throw new Error("boom"); };
    const c = js.rekeyLocalizedMediaAfterConversion(base(rej, { productId: "ch2" }));
    const d = js.rekeyLocalizedMediaAfterConversion(base(good, { productId: "ch2" }));
    expect(await c).toBe("failed: boom");
    expect(await d).toBe("rekeyed 1 entry");
  });
  it("an echo with a different value, or another owner, is not success", async () => {
    const mk = (id: string, value?: string) => async (_u: string, o: any) => {
      const { query, variables } = JSON.parse(o.body);
      return !query.includes("mutation") ? ok({ product: { metafield: { value: stored } } }) : writeOk(variables.m[0].value, id, value);
    };
    expect(await js.rekeyLocalizedMediaAfterConversion(base(mk("p", JSON.stringify({ v: 1, e: [] }))))).toBe("failed: not confirmed by echo");
    expect(await js.rekeyLocalizedMediaAfterConversion(base(mk("other")))).toBe("failed: not confirmed by echo");
  });
});
