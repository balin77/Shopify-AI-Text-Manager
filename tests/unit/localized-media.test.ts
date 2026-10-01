/**
 * "Images per language" (PLAN_LOCALIZED_IMAGES): the pure rules and the
 * Shopify write path. What is pinned here is what the storefront trusts —
 * the entry shape, the validation of the two values that land in CSS and
 * JSON, the storefront's precedence, and the echo rule on the write.
 */
import { describe, expect, it, vi } from "vitest";
import {
  isSafeFilename,
  isShopifyCdnUrl,
  marketNumericId,
  parseLocalizedMediaValue,
  removeLocalizedMediaEntry,
  resolveLocalizedMedia,
  serializeLocalizedMedia,
  storefrontFilename,
  upsertLocalizedMediaEntry,
  type LocalizedMediaEntry,
} from "../../app/services/localized-media/localized-media.shared";
import {
  removeLocalizedImage,
  setLocalizedImage,
  writeProductLocalizedMedia,
} from "../../app/services/localized-media/localized-media.server";
import {
  filenameFromCdnUrl,
  isThemeImageReference,
  themeImageFilename,
  themeImageReferenceFor,
} from "../../app/utils/theme-image-reference.shared";
import { survivesValuePrompt } from "../../app/services/translations/stale-translations.shared";
import { detectFieldType, createTemplateFieldDefinitions } from "../../app/utils/templates-field-factory";

const PRODUCT = "gid://shopify/Product/1";
const MEDIA = "gid://shopify/MediaImage/10";
const FILE = "gid://shopify/MediaImage/99";
const ORIG_URL = "https://cdn.shopify.com/s/files/1/0001/files/shirt.jpg?v=1";
const REPL_URL = "https://cdn.shopify.com/s/files/1/0001/files/shirt-fr.jpg?v=2";

function entry(over: Partial<LocalizedMediaEntry> = {}): LocalizedMediaEntry {
  return { o: "shirt.jpg", m: MEDIA, l: "fr", k: "", u: REPL_URL, f: FILE, a: "manual", s: ORIG_URL, t: "2026-09-30T00:00:00Z", ...over };
}

describe("theme image reference", () => {
  it("recognises exactly one reference and nothing else", () => {
    expect(isThemeImageReference("shopify://shop_images/banner.jpg")).toBe(true);
    expect(isThemeImageReference(" shopify://shop_images/banner.jpg ")).toBe(true);
    expect(isThemeImageReference("see shopify://shop_images/banner.jpg")).toBe(false);
    expect(isThemeImageReference("shopify://shop_images/")).toBe(false);
    expect(isThemeImageReference("shopify://collections/x")).toBe(false);
    expect(isThemeImageReference(null)).toBe(false);
  });
  it("round-trips a filename", () => {
    expect(themeImageFilename(themeImageReferenceFor("a.png"))).toBe("a.png");
    expect(filenameFromCdnUrl(REPL_URL)).toBe("shirt-fr.jpg");
  });
  it("is never offered to the value prompt of the stale repair", () => {
    expect(survivesValuePrompt("shopify://shop_images/banner.jpg")).toBe(false);
    expect(survivesValuePrompt("Hello")).toBe(true);
  });
  it("renders as an image field with no AI and no translate buttons", () => {
    expect(detectFieldType("shopify://shop_images/banner.jpg")).toBe("themeImage");
    const [def] = createTemplateFieldDefinitions([{ key: "section.x.image", value: "shopify://shop_images/banner.jpg" }]);
    expect(def.type).toBe("themeImage");
    expect(def.supportsAI).toBe(false);
    expect(def.supportsTranslation).toBe(false);
    const [text] = createTemplateFieldDefinitions([{ key: "section.x.heading", value: "Hi" }]);
    expect(text.supportsAI).toBe(true);
  });
});

describe("localized media — pure rules", () => {
  it("validates what the storefront puts into CSS and JSON", () => {
    expect(isSafeFilename("shirt%20red.jpg")).toBe(true);
    expect(isSafeFilename('x"],*{display:none}')).toBe(false);
    expect(isSafeFilename("..")).toBe(false);
    expect(isShopifyCdnUrl(REPL_URL)).toBe(true);
    expect(isShopifyCdnUrl("https://evil.example/x.jpg")).toBe(false);
    expect(isShopifyCdnUrl("http://cdn.shopify.com/x.jpg")).toBe(false);
    expect(isShopifyCdnUrl('https://cdn.shopify.com/x.jpg"</script>')).toBe(false);
  });

  it("derives the storefront match key from the URL", () => {
    expect(storefrontFilename(ORIG_URL)).toBe("shirt.jpg");
    expect(storefrontFilename("//shop.example/cdn/shop/files/shirt.jpg?v=1&width=800")).toBe("shirt.jpg");
  });

  it("maps market GIDs to Liquid's numeric id", () => {
    expect(marketNumericId("gid://shopify/Market/42")).toBe("42");
    expect(marketNumericId("")).toBe("");
    expect(marketNumericId("gid://shopify/Product/42")).toBeNull();
  });

  it("drops malformed entries instead of writing them back", () => {
    const raw = JSON.stringify({ v: 1, e: [entry(), { o: 'bad"name', m: MEDIA, l: "de", k: "", u: REPL_URL, f: FILE }, { nope: 1 }] });
    const parsed = parseLocalizedMediaValue(raw);
    expect(parsed).toHaveLength(1);
    expect(parseLocalizedMediaValue("not json")).toEqual([]);
    expect(parseLocalizedMediaValue(null)).toEqual([]);
  });

  it("keeps one replacement per (original, language, market)", () => {
    let list = upsertLocalizedMediaEntry([], entry());
    list = upsertLocalizedMediaEntry(list, entry({ u: REPL_URL.replace("fr", "fr2") }));
    expect(list).toHaveLength(1);
    list = upsertLocalizedMediaEntry(list, entry({ k: "42" }));
    list = upsertLocalizedMediaEntry(list, entry({ l: "DE" }));
    expect(list).toHaveLength(3);
    expect(list.find((e) => e.k === "" && e.l === "de")).toBeTruthy();
    expect(removeLocalizedMediaEntry(list, MEDIA, "fr", "42")).toHaveLength(2);
  });

  it("applies the storefront's precedence: market beats every-market, none ⇒ original", () => {
    const list = [entry(), entry({ k: "42", u: REPL_URL.replace("fr", "ch") })];
    expect(resolveLocalizedMedia(list, MEDIA, "fr", "42")?.entry.k).toBe("42");
    const other = resolveLocalizedMedia(list, MEDIA, "fr", "7");
    expect(other?.entry.k).toBe("");
    expect(other?.inherited).toBe(true);
    expect(resolveLocalizedMedia(list, MEDIA, "fr", "")?.inherited).toBe(false);
    expect(resolveLocalizedMedia(list, MEDIA, "it", "")).toBeNull();
  });
});

type Call = { query: string; variables: Record<string, unknown> };

function fakeGraphql(handlers: Array<(c: Call) => unknown>) {
  const calls: Call[] = [];
  const fn = vi.fn(async (query: string, opts?: { variables?: Record<string, unknown> }) => {
    const call = { query, variables: opts?.variables ?? {} };
    calls.push(call);
    const h = handlers.shift();
    const data = h ? h(call) : null;
    return new Response(JSON.stringify({ data }));
  });
  return { fn, calls };
}

const productRead = (value: string | null) => () => ({
  product: {
    metafield: value === null ? null : { id: "gid://shopify/Metafield/5", value },
    media: { nodes: [{ id: MEDIA, mediaContentType: "IMAGE", alt: "Shirt", image: { url: ORIG_URL } }] },
  },
});
const fileRead = (url = REPL_URL, status = "READY") => () => ({ node: { id: FILE, fileStatus: status, image: { url } } });
const echoSet = () => (c: Call) => {
  const mf = (c.variables.metafields as Array<{ ownerId: string; namespace: string; key: string; value: string }>)[0];
  return { metafieldsSet: { metafields: [{ key: mf.key, namespace: mf.namespace, value: mf.value, owner: { id: mf.ownerId } }], userErrors: [] } };
};

const scope = {
  shopLocales: [{ locale: "de", primary: true }, { locale: "fr", primary: false }],
  activeMarketIds: ["gid://shopify/Market/42"],
};

describe("localized media — Shopify write path", () => {
  it("writes the entry the server derived, not what the client claimed", async () => {
    const { fn, calls } = fakeGraphql([productRead(null), fileRead(), echoSet()]);
    const res = await setLocalizedImage({
      graphql: fn as never, productId: PRODUCT, sourceMediaId: MEDIA, locale: "FR", marketId: "gid://shopify/Market/42",
      fileId: FILE, origin: "manual", scope,
    });
    expect(res.ok).toBe(true);
    const written = JSON.parse((calls[2].variables.metafields as Array<{ value: string }>)[0].value);
    expect(written.e[0]).toMatchObject({ o: "shirt.jpg", m: MEDIA, l: "fr", k: "42", u: REPL_URL, a: "manual", s: ORIG_URL });
  });

  it("refuses a primary, unknown or unconfirmable language and an inactive market", async () => {
    for (const [locale, marketId, sc, code] of [
      ["de", "", scope, "invalidLocale"],
      ["it", "", scope, "invalidLocale"],
      ["fr", "", { shopLocales: [], activeMarketIds: [] }, "invalidLocale"],
      ["fr", "gid://shopify/Market/7", scope, "invalidMarket"],
    ] as const) {
      const { fn } = fakeGraphql([]);
      const res = await setLocalizedImage({ graphql: fn as never, productId: PRODUCT, sourceMediaId: MEDIA, locale, marketId, fileId: FILE, origin: "manual", scope: sc as unknown as typeof scope });
      expect(res).toMatchObject({ ok: false, code });
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it("refuses a file that is not ready, off-CDN or the original itself", async () => {
    for (const [file, code] of [
      [fileRead(REPL_URL, "PROCESSING"), "fileNotReady"],
      [fileRead("https://evil.example/x.jpg"), "invalidFile"],
      [fileRead(ORIG_URL), "sameFile"],
    ] as const) {
      const { fn, calls } = fakeGraphql([productRead(null), file]);
      const res = await setLocalizedImage({ graphql: fn as never, productId: PRODUCT, sourceMediaId: MEDIA, locale: "fr", marketId: "", fileId: FILE, origin: "manual", scope });
      expect(res).toMatchObject({ ok: false, code });
      expect(calls).toHaveLength(2);
    }
  });

  it("refuses a replacement that is itself one of the product's images (no chains, no cycles)", async () => {
    const OTHER_URL = "https://cdn.shopify.com/s/files/1/0001/files/shirt-back.jpg?v=3";
    const read = () => ({
      product: {
        metafield: null,
        media: { nodes: [
          { id: MEDIA, mediaContentType: "IMAGE", alt: null, image: { url: ORIG_URL } },
          { id: "gid://shopify/MediaImage/11", mediaContentType: "IMAGE", alt: null, image: { url: OTHER_URL } },
        ] },
      },
    });
    const { fn, calls } = fakeGraphql([read, fileRead(OTHER_URL)]);
    const res = await setLocalizedImage({ graphql: fn as never, productId: PRODUCT, sourceMediaId: MEDIA, locale: "fr", marketId: "", fileId: FILE, origin: "manual", scope });
    expect(res).toMatchObject({ ok: false, code: "replacementIsOriginal" });
    expect(calls).toHaveLength(2);
  });

  it("counts a write only when Shopify echoes this product's value", async () => {
    const noEcho = fakeGraphql([() => ({ metafieldsSet: { metafields: [], userErrors: [] } })]);
    expect(await writeProductLocalizedMedia(noEcho.fn as never, PRODUCT, [entry()], false)).toMatchObject({ ok: false, code: "writeNotConfirmed" });
    const otherValue = fakeGraphql([() => ({
      metafieldsSet: { metafields: [{ key: "localized_media", namespace: "custom", value: serializeLocalizedMedia([]), owner: { id: PRODUCT } }], userErrors: [] },
    })]);
    expect(await writeProductLocalizedMedia(otherValue.fn as never, PRODUCT, [entry()], false)).toMatchObject({ ok: false });
  });

  it("deletes the metafield when the last entry goes, and confirms by the echo", async () => {
    const stored = serializeLocalizedMedia([entry()]);
    const { fn, calls } = fakeGraphql([
      productRead(stored),
      () => ({ metafieldsDelete: { deletedMetafields: [{ ownerId: PRODUCT, namespace: "custom", key: "localized_media" }], userErrors: [] } }),
    ]);
    const res = await removeLocalizedImage({ graphql: fn as never, productId: PRODUCT, sourceMediaId: MEDIA, locale: "fr", marketId: "" });
    expect(res).toMatchObject({ ok: true, entries: [] });
    expect(calls[1].query).toContain("metafieldsDelete");
  });

  it("does not write when there is nothing to remove", async () => {
    const { fn, calls } = fakeGraphql([productRead(null)]);
    const res = await removeLocalizedImage({ graphql: fn as never, productId: PRODUCT, sourceMediaId: MEDIA, locale: "fr", marketId: "" });
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
  });
});

describe("videos per language", () => {
  const VID = "gid://shopify/Video/20";
  const EXT = "gid://shopify/ExternalVideo/30";
  const KEY = "abcdef0123456789";
  const KEY2 = "fedcba9876543210";
  const videoRead = () => ({
    product: {
      metafield: null,
      media: { nodes: [
        { id: MEDIA, mediaContentType: "IMAGE", alt: null, image: { url: ORIG_URL } },
        { id: VID, mediaContentType: "VIDEO", alt: null, sources: [{ url: `https://cdn.shopify.com/videos/c/vp/${KEY}/${KEY}.HD-1080p.mp4`, mimeType: "video/mp4" }], preview: { image: { url: "https://cdn.shopify.com/s/files/1/files/preview_images/poster.jpg?v=1" } } },
        { id: EXT, mediaContentType: "EXTERNAL_VIDEO", alt: null, originUrl: "https://www.youtube.com/watch?v=AAAAAAAAAAA", preview: { image: { url: "https://cdn.shopify.com/s/files/1/files/preview_images/yt.jpg" } } },
      ] },
    },
  });

  it("derives the storefront key of every kind", async () => {
    const { toProductMediaItem } = await import("../../app/services/localized-media/localized-media.server");
    const nodes = videoRead().product.media.nodes;
    expect(toProductMediaItem(nodes[1] as never)).toMatchObject({ kind: "video", key: KEY, poster: "poster.jpg" });
    expect(toProductMediaItem(nodes[2] as never)).toMatchObject({ kind: "external", key: "youtube.AAAAAAAAAAA", poster: "yt.jpg" });
  });

  it("replaces a Shopify video with another Shopify video only", async () => {
    const replacementVideo = () => ({ node: { id: "gid://shopify/Video/99", fileStatus: "READY", sources: [{ url: `https://cdn.shopify.com/videos/c/vp/${KEY2}/${KEY2}.HD-720p.mp4`, mimeType: "video/mp4" }], preview: { image: { url: "https://cdn.shopify.com/s/files/1/files/preview_images/new.jpg" } } } });
    const { fn, calls } = fakeGraphql([videoRead, replacementVideo, echoSet()]);
    const res = await setLocalizedImage({ graphql: fn as never, productId: PRODUCT, sourceMediaId: VID, locale: "fr", marketId: "", fileId: "gid://shopify/Video/99", origin: "manual", scope });
    expect(res.ok).toBe(true);
    const written = JSON.parse((calls[2].variables.metafields as Array<{ value: string }>)[0].value).e[0];
    expect(written).toMatchObject({ x: "v", o: KEY, p: "poster.jpg", f: "gid://shopify/Video/99" });
    expect(written.w[0].u).toContain(KEY2);

    const mismatch = fakeGraphql([videoRead]);
    expect(await setLocalizedImage({ graphql: mismatch.fn as never, productId: PRODUCT, sourceMediaId: VID, locale: "fr", marketId: "", fileId: FILE, origin: "manual", scope }))
      .toMatchObject({ ok: false, code: "kindMismatch" });
  });

  it("replaces a YouTube video with a YouTube/Vimeo link, never with the same video", async () => {
    const { fn, calls } = fakeGraphql([videoRead, echoSet()]);
    const res = await setLocalizedImage({ graphql: fn as never, productId: PRODUCT, sourceMediaId: EXT, locale: "fr", marketId: "", externalUrl: "https://vimeo.com/123456789", origin: "manual", scope });
    expect(res.ok).toBe(true);
    const written = JSON.parse((calls[1].variables.metafields as Array<{ value: string }>)[0].value).e[0];
    expect(written).toMatchObject({ x: "e", o: "youtube.AAAAAAAAAAA", r: "https://player.vimeo.com/video/123456789", u: "", p: "yt.jpg" });

    for (const [url, code] of [["https://example.com/x", "invalidExternalUrl"], ["https://youtu.be/AAAAAAAAAAA", "sameFile"]] as const) {
      const g = fakeGraphql([videoRead]);
      expect(await setLocalizedImage({ graphql: g.fn as never, productId: PRODUCT, sourceMediaId: EXT, locale: "fr", marketId: "", externalUrl: url, origin: "manual", scope }))
        .toMatchObject({ ok: false, code });
    }
  });

  it("drops a stored video entry whose embed or sources are not safe", () => {
    const raw = JSON.stringify({ v: 1, e: [
      { o: "youtube.AAAAAAAAAAA", m: EXT, l: "fr", k: "", u: "", f: "", x: "e", p: "", r: "javascript:alert(1)" },
      { o: KEY, m: VID, l: "fr", k: "", u: "", f: "x", x: "v", p: "", w: [{ u: "https://evil.example/v.mp4", t: "video/mp4" }] },
      { o: "youtube.AAAAAAAAAAA", m: EXT, l: "fr", k: "", u: "", f: "", x: "e", p: "", r: "https://www.youtube.com/embed/BBBBBBBBBBB" },
    ] });
    const parsed = parseLocalizedMediaValue(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].r).toBe("https://www.youtube.com/embed/BBBBBBBBBBB");
  });

  it("keeps theme video choices away from the AI", async () => {
    const { isThemeMediaValue } = await import("../../app/utils/theme-image-reference.shared");
    expect(isThemeMediaValue("https://www.youtube.com/watch?v=AAAAAAAAAAA")).toBe(true);
    expect(isThemeMediaValue("shopify://files/videos/intro.mp4")).toBe(true);
    expect(isThemeMediaValue("Watch our video on YouTube")).toBe(false);
    expect(survivesValuePrompt("https://vimeo.com/123456789")).toBe(false);
  });
});
