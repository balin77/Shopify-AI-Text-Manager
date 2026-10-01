/**
 * "Images per language" after folding its three routes into existing ones
 * (the product page's actions, api.files, api.translation-probe): the refusal
 * of a foreign metafield value, the door's allow-list and the codes the card
 * maps in the merchant's language.
 */
import { describe, expect, it, vi } from "vitest";
import {
  isForeignLocalizedMediaValue,
  serializeLocalizedMedia,
  type LocalizedMediaEntry,
} from "../../app/services/localized-media/localized-media.shared";
import { removeLocalizedImage, setLocalizedImage } from "../../app/services/localized-media/localized-media.server";
import { contentEditorActionAllowed } from "../../app/services/editor/content-action-endpoint.shared";
import { themeMediaRefusalBody } from "../../app/utils/theme-image-reference.shared";
import { resolvePickedMedia } from "../../app/components/localized-images/resolve-picked-image";

const PRODUCT = "gid://shopify/Product/1";
const MEDIA = "gid://shopify/MediaImage/10";
const FILE = "gid://shopify/MediaImage/99";
const ORIG_URL = "https://cdn.shopify.com/s/files/1/0001/files/shirt.jpg?v=1";

const entry: LocalizedMediaEntry = {
  o: "shirt.jpg", m: MEDIA, l: "fr", k: "", u: "https://cdn.shopify.com/s/files/1/0001/files/shirt-fr.jpg?v=2",
  f: FILE, a: "manual", s: ORIG_URL, t: "2026-01-01T00:00:00.000Z",
};

function fakeGraphql(value: string) {
  const calls: string[] = [];
  const fn = vi.fn(async (query: string) => {
    calls.push(query);
    return new Response(JSON.stringify({
      data: {
        product: {
          metafield: { id: "gid://shopify/Metafield/5", value },
          media: { nodes: [{ id: MEDIA, mediaContentType: "IMAGE", alt: null, image: { url: ORIG_URL } }] },
        },
      },
    }));
  });
  return { fn, calls };
}

const scope = {
  shopLocales: [{ locale: "de", primary: true }, { locale: "fr", primary: false }],
  activeMarketIds: [],
};

describe("a foreign custom.localized_media value is never overwritten", () => {
  it("tells our shapes (blank, empty list, entries) from someone else's", () => {
    expect(isForeignLocalizedMediaValue(null)).toBe(false);
    expect(isForeignLocalizedMediaValue("  ")).toBe(false);
    expect(isForeignLocalizedMediaValue(serializeLocalizedMedia([]))).toBe(false);
    expect(isForeignLocalizedMediaValue(serializeLocalizedMedia([entry]))).toBe(false);
    expect(isForeignLocalizedMediaValue("not json")).toBe(true);
    expect(isForeignLocalizedMediaValue('{"foo":1}')).toBe(true);
    expect(isForeignLocalizedMediaValue('["a"]')).toBe(true);
    // Entries that all fail the parse would be dropped by a rewrite.
    expect(isForeignLocalizedMediaValue('{"v":1,"e":[{"o":"x"}]}')).toBe(true);
  });

  it("refuses to set and to remove, and writes nothing", async () => {
    for (const value of ["not json", '{"foo":1}', '{"v":1,"e":[{"o":"x"}]}']) {
      const set = fakeGraphql(value);
      expect(await setLocalizedImage({
        graphql: set.fn as never, productId: PRODUCT, sourceMediaId: MEDIA, locale: "fr", marketId: "", fileId: FILE, origin: "manual", scope,
      })).toMatchObject({ ok: false, code: "foreignMetafieldValue" });
      expect(set.calls).toHaveLength(1);

      const rem = fakeGraphql(value);
      expect(await removeLocalizedImage({
        graphql: rem.fn as never, productId: PRODUCT, sourceMediaId: MEDIA, locale: "fr", marketId: "",
      })).toMatchObject({ ok: false, code: "foreignMetafieldValue" });
      expect(rem.calls).toHaveLength(1);
    }
  });
});

describe("images per language folded into existing routes", () => {
  it("the product page's door lists the three card actions, and only for products", () => {
    for (const a of ["localizedMediaLoad", "localizedMediaSet", "localizedMediaRemove"]) {
      expect(contentEditorActionAllowed("/app/products", a)).toBe(true);
      expect(contentEditorActionAllowed("/app/collections", a)).toBe(false);
    }
  });

  it("the media refusal travels as a code with the editor's echo fields", () => {
    expect(themeMediaRefusalBody("translateField", "title")).toEqual({
      success: false, error: "themeMediaValue", code: "themeMediaValue", actionType: "translateField", fieldType: "title",
    });
  });

  it("a wrong pick answers with a code, not a sentence to display", async () => {
    expect(await resolvePickedMedia(undefined, "image")).toMatchObject({ code: "noImageSelected" });
    expect(await resolvePickedMedia({ source: "library", kind: "video", gid: "g", assetUrl: "u" } as never, "image")).toMatchObject({ code: "onlyImagesForImage" });
    expect(await resolvePickedMedia({ source: "external_url" } as never, "video")).toMatchObject({ code: "linkNotFile" });
  });
});
