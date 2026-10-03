/**
 * The image manager's FOREIGN alt box when the image has no PRIMARY alt.
 *
 * Shopify offers an image's `alt` for translation only when it has a value in
 * the primary language, so a translation typed there can never be stored: the
 * save is refused (no digest), and the image manager used to keep the text as a
 * FAILED draft, holding the save bar open for good. Now the box is locked with
 * the reason, the server names the case (`errorCode: altTextNoPrimary`) and the
 * client reverts the draft to the language's own value instead of keeping it.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("~/utils/logger.server", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  loggers: new Proxy({}, { get: () => vi.fn() }),
}));
const { markTranslationSaved } = vi.hoisted(() => ({ markTranslationSaved: vi.fn() }));
vi.mock("~/utils/translation-save-lock.server", () => ({
  markTranslationSaved,
  isTranslationRecentlySaved: vi.fn().mockReturnValue(false),
}));
vi.mock("~/services/tasks/resource-title.server", () => ({
  taskTitleOrFallback: vi.fn(async () => "Box"),
}));

import {
  ALT_NO_PRIMARY,
  classifyAltSaveResponse,
  foreignAltLocked,
} from "~/services/alt-text-feedback.shared";
import { revertAltDraftsWithoutPrimary } from "~/components/image-manager/alt-draft";

const SHOP = "s.myshopify.com";
const MEDIA = "gid://shopify/MediaImage/1";
const MARKET = "gid://shopify/Market/77";

beforeEach(() => vi.clearAllMocks());

describe("classifyAltSaveResponse: no primary alt", () => {
  it("is its own verdict, not a retryable failure", () => {
    expect(classifyAltSaveResponse({ success: false, errorCode: ALT_NO_PRIMARY, error: "x" })).toEqual({ kind: "noPrimary" });
    expect(classifyAltSaveResponse({ success: false, error: "boom" })).toEqual({ kind: "failed", message: "boom" });
    expect(classifyAltSaveResponse({ success: true, errorCode: ALT_NO_PRIMARY })).toEqual({ kind: "saved" });
  });
});

describe("foreignAltLocked", () => {
  const base = { isPrimaryLocale: false, primaryAlt: "", own: undefined, dirty: false };
  it("locks a foreign box whose image has no saved primary alt", () => {
    expect(foreignAltLocked(base)).toBe(true);
    expect(foreignAltLocked({ ...base, primaryAlt: "   " })).toBe(true);
    expect(foreignAltLocked({ ...base, own: "" })).toBe(true);
  });
  it("never locks the primary language", () => {
    expect(foreignAltLocked({ ...base, isPrimaryLocale: true })).toBe(false);
  });
  it("opens as soon as a primary alt is saved", () => {
    expect(foreignAltLocked({ ...base, primaryAlt: "Red box" })).toBe(false);
  });
  it("keeps a value the language already holds editable, so it can still be cleared", () => {
    expect(foreignAltLocked({ ...base, own: "Rote Kiste" })).toBe(false);
    // …and does not snap shut while it is being cleared (dirty, now empty).
    expect(foreignAltLocked({ ...base, own: "", dirty: true })).toBe(false);
  });
  it("an INHERITED (market fallback) value does not unlock it: it is only a placeholder", () => {
    // The caller passes the market layer's OWN value; the inherited global one never reaches `own`.
    expect(foreignAltLocked({ ...base, own: undefined })).toBe(true);
  });
});

describe("revertAltDraftsWithoutPrimary", () => {
  it("puts the language's own value back (or none) for every planned tile", () => {
    const texts = { a: "typed", b: "typed", c: "other" };
    const baselines = new Map<string, string | undefined>([["a", undefined], ["b", "old"]]);
    const res = revertAltDraftsWithoutPrimary({
      texts,
      baselines,
      planned: [{ url: "a", altText: "typed" }, { url: "b", altText: "typed" }],
    });
    expect(res.reverted).toEqual(["a", "b"]);
    expect(res.texts).toEqual({ b: "old", c: "other" });
  });
  it("leaves a tile alone that was typed on after the save was sent", () => {
    const res = revertAltDraftsWithoutPrimary({
      texts: { a: "newer" },
      baselines: new Map([["a", undefined]]),
      planned: [{ url: "a", altText: "typed" }],
    });
    expect(res.reverted).toEqual([]);
    expect(res.texts).toEqual({ a: "newer" });
  });
});

describe("handleSaveImageAltText: foreign save of an image without a primary alt", () => {
  function adminWithoutPrimaryAlt() {
    const graphql = vi.fn(async (query: string) => {
      let body: unknown = { data: {} };
      if (query.includes("translatableResource")) {
        // No primary alt => Shopify lists no `alt` key, i.e. no digest.
        body = { data: { translatableResource: { resourceId: MEDIA, translatableContent: [] } } };
      }
      return { ok: true, status: 200, json: async () => body };
    });
    return { graphql };
  }
  const db: any = {
    productImage: { findFirst: vi.fn(async () => ({ productId: "p1" })) },
    productImageAltTranslation: { upsert: vi.fn(), deleteMany: vi.fn() },
  };

  it.each([[undefined], [MARKET]])("answers errorCode altTextNoPrimary, writes and mirrors nothing (market %s)", async (marketId) => {
    const { handleSaveImageAltText } = await import("~/actions/content/alt-text.action");
    const admin = adminWithoutPrimaryAlt();
    const fd = new FormData();
    fd.set("mediaId", MEDIA);
    fd.set("altText", "Kiste");
    fd.set("locale", "de");
    fd.set("primaryLocale", "en");
    if (marketId) fd.set("marketId", marketId);
    const res: any = await handleSaveImageAltText({ admin, db, session: { shop: SHOP } } as never, fd);
    const body = res.data ?? res;
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe(ALT_NO_PRIMARY);
    expect(classifyAltSaveResponse(body)).toEqual({ kind: "noPrimary" });
    const sent = admin.graphql.mock.calls.map((c) => String(c[0]));
    expect(sent.some((q) => q.includes("translationsRegister("))).toBe(false);
    expect(db.productImageAltTranslation.upsert).not.toHaveBeenCalled();
    expect(markTranslationSaved).not.toHaveBeenCalled();
  });
});
