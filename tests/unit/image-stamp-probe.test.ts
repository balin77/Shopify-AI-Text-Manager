/**
 * Image-stamp probe: the alt is restored no matter what, a replacement image
 * is never picked, and the verdict follows the measured urls.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("~/utils/logger.server", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { runImageStampProbe } from "../../app/services/localized-media/image-stamp-probe.server";
import { compareImageUrls, computeStampVerdict } from "../../app/services/localized-media/image-stamp-probe.shared";

const PRODUCT = "gid://shopify/Product/1";
const IMG = "gid://shopify/MediaImage/10";
const BASE = "https://cdn.shopify.com/s/files/1/a.jpg";

function reply(data: unknown) {
  return { json: async () => ({ data }) } as unknown as Response;
}

function makeAdmin(opts: {
  urlAfterChange: string;
  failChangeRead?: boolean;
  restoreFails?: boolean;
  restoreThrowsOnce?: boolean;
  startAlt?: string;
  slow?: boolean;
  metafield?: string | null;
}) {
  let alt = opts.startAlt ?? "Red shoe";
  let restoreThrown = false;
  let url = `${BASE}?v=1`;
  const alts: string[] = [];
  const graphql = vi.fn(async (query: string, o?: { variables?: Record<string, unknown> }) => {
    const v = o?.variables ?? {};
    if (query.includes("imageStampCandidates")) {
      return reply({
        products: { nodes: [{ id: PRODUCT, metafield: opts.metafield ? { value: opts.metafield } : null, media: { nodes: [{ id: IMG, mediaContentType: "IMAGE", alt, status: "READY", image: { url } }] } }] },
      });
    }
    if (query.includes("imageStampSetAlt")) {
      const next = (v.media as Array<{ alt: string }>)[0].alt;
      if (opts.slow) await new Promise((r) => setTimeout(r, 20));
      const isRestore = next === (opts.startAlt ?? "Red shoe");
      if (isRestore && opts.restoreThrowsOnce && !restoreThrown) { restoreThrown = true; throw new Error("throttled"); }
      if (isRestore && opts.restoreFails) return reply({ productUpdateMedia: { media: [], mediaUserErrors: [{ field: [], message: "nope" }] } });
      alts.push(next);
      alt = next;
      if (!isRestore) url = opts.urlAfterChange;
      return reply({ productUpdateMedia: { media: [{ id: IMG, alt }], mediaUserErrors: [] } });
    }
    if (query.includes("imageStampRead")) {
      if (opts.failChangeRead && alt !== "Red shoe") throw new Error("boom");
      return reply({ node: { id: IMG, alt, image: { url } } });
    }
    throw new Error("unexpected query");
  });
  return { graphql, alts, getAlt: () => alt };
}

function makeDb() {
  const calls: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
  return { calls, db: { productImage: { updateMany: vi.fn(async (a: { where: Record<string, unknown>; data: Record<string, unknown> }) => { calls.push(a); return { count: 1 }; }) } } };
}

const fast = { sleep: async () => {}, pollAttempts: 3, pollMs: 0, db: makeDb().db };

describe("image stamp probe", () => {
  it("reports an unchanged query and restores the alt", async () => {
    const a = makeAdmin({ urlAfterChange: `${BASE}?v=1` });
    const r = await runImageStampProbe(a.graphql, fast);
    expect(r.altChangeConfirmed).toBe(true);
    expect(r.restoreConfirmed).toBe(true);
    expect(r.queryChanged).toBe(false);
    expect(r.pathChanged).toBe(false);
    expect(r.verdict[0]).toContain("does NOT change");
    expect(a.getAlt()).toBe("Red shoe");
    expect(a.alts).toEqual(["Red shoe [probe]", "Red shoe"]);
  });

  it("reports a changed query", async () => {
    const a = makeAdmin({ urlAfterChange: `${BASE}?v=2` });
    const r = await runImageStampProbe(a.graphql, fast);
    expect(r.queryChanged).toBe(true);
    expect(r.pathChanged).toBe(false);
    expect(r.verdict[0]).toContain("must ignore the query");
  });

  it("restores the alt even when the middle step throws", async () => {
    const a = makeAdmin({ urlAfterChange: `${BASE}?v=2`, failChangeRead: true });
    const r = await runImageStampProbe(a.graphql, fast);
    expect(r.error).toContain("boom");
    expect(a.getAlt()).toBe("Red shoe");
    expect(r.restoreConfirmed).toBe(true);
  });

  it("shouts when the restore cannot be confirmed", async () => {
    const a = makeAdmin({ urlAfterChange: `${BASE}?v=1`, restoreFails: true });
    const r = await runImageStampProbe(a.graphql, fast);
    expect(r.restoreFailed).toBe(true);
    expect(r.verdict[0]).toContain("RESTORE FAILED");
    expect(r.verdict[0]).toContain("Red shoe");
  });

  it("never touches an image that is part of a replacement", async () => {
    const entry = { o: "a.jpg", m: IMG, l: "de", k: "", u: "https://cdn.shopify.com/x.jpg", f: "gid://shopify/MediaImage/99", a: "m", s: BASE, t: "" };
    const a = makeAdmin({ urlAfterChange: `${BASE}?v=2`, metafield: JSON.stringify({ e: [entry] }) });
    const r = await runImageStampProbe(a.graphql, fast);
    expect(a.alts).toEqual([]);
    expect(r.mediaId).toBeNull();
    expect(r.verdict[0]).toContain("INCONCLUSIVE");
  });
});

describe("image stamp probe guards", () => {
  it("refuses an image whose alt already ends with the marker", async () => {
    const a = makeAdmin({ urlAfterChange: `${BASE}?v=2`, startAlt: "Red shoe [probe]" });
    const r = await runImageStampProbe(a.graphql, fast);
    expect(a.alts).toEqual([]);
    expect(r.mediaId).toBeNull();
  });

  it("answers 'already running' to a concurrent second run and touches nothing", async () => {
    const a = makeAdmin({ urlAfterChange: `${BASE}?v=2`, slow: true });
    const first = runImageStampProbe(a.graphql, fast);
    const second = await runImageStampProbe(a.graphql, fast);
    expect(second.error).toBe("already running");
    expect(second.verdict[0]).toContain("already running");
    const r = await first;
    expect(r.restoreConfirmed).toBe(true);
    expect(a.alts).toEqual(["Red shoe [probe]", "Red shoe"]);
    const third = await runImageStampProbe(makeAdmin({ urlAfterChange: `${BASE}?v=2` }).graphql, fast);
    expect(third.error).toBeNull();
  });

  it("shields the cached row before the marker write and puts a leaked marker back", async () => {
    const m = makeDb();
    const a = makeAdmin({ urlAfterChange: `${BASE}?v=2` });
    await runImageStampProbe(a.graphql, { ...fast, db: m.db, shop: "s.myshopify.com" });
    expect(m.calls[0].data.altTextModifiedAt).toBeInstanceOf(Date);
    expect(m.calls[0].data).not.toHaveProperty("altText");
    expect(m.calls[0].where).toMatchObject({ mediaId: IMG, product: { shop: "s.myshopify.com" } });
    expect(m.calls[1].where).toMatchObject({ mediaId: IMG, altText: "Red shoe [probe]" });
    expect(m.calls[1].data).toEqual({ altText: "Red shoe" });
  });

  it("retries a thrown restore once", async () => {
    const a = makeAdmin({ urlAfterChange: `${BASE}?v=2`, restoreThrowsOnce: true });
    const r = await runImageStampProbe(a.graphql, fast);
    expect(r.restoreConfirmed).toBe(true);
    expect(r.restoreFailed).toBe(false);
    expect(a.getAlt()).toBe("Red shoe");
  });

  it("skips a product whose localized_media value is non-empty, even an unparseable one", async () => {
    const a = makeAdmin({ urlAfterChange: `${BASE}?v=2`, metafield: "not json" });
    const r = await runImageStampProbe(a.graphql, fast);
    expect(a.alts).toEqual([]);
    expect(r.mediaId).toBeNull();
  });
});

describe("verdict", () => {
  it("splits path and query", () => {
    expect(compareImageUrls(`${BASE}?v=1`, `${BASE}?v=2`)).toEqual({ pathChanged: false, queryChanged: true });
    expect(compareImageUrls(`${BASE}?v=1`, `${BASE}.png?v=1`)).toEqual({ pathChanged: true, queryChanged: false });
    expect(compareImageUrls(null, BASE)).toBeNull();
  });
  it("is inconclusive without a confirmed change", () => {
    expect(computeStampVerdict({ altChangeConfirmed: false, urlBefore: BASE, urlAfterAltChange: BASE })[0]).toContain("INCONCLUSIVE");
  });
});
