/**
 * The image manager's single-language alt translate (🌍 in a foreign locale).
 *
 * Regression: the button sent the FOREIGN field's own text (a typed draft, or
 * empty) as the source, and the server put it into the JSON-shaped field
 * translate prompt with no source language. The model answered in prose,
 * `parseJSONResponse` threw "Could not parse JSON from AI response", and every
 * retry sent the same input and failed the same way. Now the source is the
 * SAVED primary alt, an empty one is refused before any AI work, and the
 * translation is a plain-text single-value call (no JSON to parse).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("~/utils/logger.server", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  loggers: new Proxy({}, { get: () => vi.fn() }),
}));
vi.mock("~/services/tasks/resource-title.server", () => ({
  taskTitleOrFallback: vi.fn(async () => "Box"),
}));
const { getCachedShopLocales } = vi.hoisted(() => ({ getCachedShopLocales: vi.fn() }));
vi.mock("~/utils/shop-locales-cache.server", () => ({ getCachedShopLocales }));

const { translateContent, translateProduct } = vi.hoisted(() => ({
  translateContent: vi.fn(),
  translateProduct: vi.fn(),
}));
vi.mock("../../src/services/ai.service", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    AIService: class {
      translateContent = translateContent;
    },
  };
});
vi.mock("../../src/services/translation.service", () => ({
  TranslationService: class {
    translateProduct = translateProduct;
  },
}));

import {
  ALT_NO_SOURCE_TEXT,
  altTranslateSourceText,
  classifyAltAiResponse,
  planAltTranslate,
} from "~/services/alt-text-feedback.shared";

describe("altTranslateSourceText", () => {
  it("is the trimmed primary alt, null when there is nothing to translate", () => {
    expect(altTranslateSourceText("  Red box ")).toBe("Red box");
    expect(altTranslateSourceText("")).toBeNull();
    expect(altTranslateSourceText("   ")).toBeNull();
    expect(altTranslateSourceText(undefined)).toBeNull();
    expect(altTranslateSourceText(null)).toBeNull();
  });
});

describe("planAltTranslate", () => {
  it("names the source language and keeps the trimmed source", () => {
    expect(planAltTranslate({ sourceAltText: " Rote Kiste ", targetLocale: "en", primaryLocale: "de" }))
      .toEqual({ ok: true, source: "Rote Kiste", fromLang: "de" });
  });
  it("refuses an empty source", () => {
    expect(planAltTranslate({ sourceAltText: "", targetLocale: "en", primaryLocale: "de" }))
      .toEqual({ ok: false, reason: "noSource" });
  });
  it("refuses a target that is the primary language", () => {
    expect(planAltTranslate({ sourceAltText: "Kiste", targetLocale: "DE", primaryLocale: "de" }))
      .toEqual({ ok: false, reason: "targetIsPrimary" });
  });
  it("still translates when the primary language is unknown", () => {
    const plan = planAltTranslate({ sourceAltText: "Kiste", targetLocale: "en", primaryLocale: "" });
    expect(plan.ok).toBe(true);
  });
});

describe("classifyAltAiResponse", () => {
  it("reads the no-source refusal as its own verdict", () => {
    expect(classifyAltAiResponse({ success: false, errorCode: ALT_NO_SOURCE_TEXT, error: "x" }))
      .toEqual({ kind: "noSource" });
  });
});

describe("handleTranslateAltText (content route action)", () => {
  beforeEach(() => {
    translateContent.mockReset();
    translateProduct.mockReset();
    getCachedShopLocales.mockReset();
    getCachedShopLocales.mockResolvedValue([
      { locale: "de", primary: true, published: true },
      { locale: "en", primary: false, published: true },
    ]);
  });

  function makeDb() {
    return {
      task: {
        create: vi.fn(async () => ({ id: "t1" })),
        update: vi.fn(async () => ({})),
      },
    };
  }

  async function run(fields: Record<string, string>, db = makeDb()) {
    const { handleTranslateAltText } = await import("~/actions/content/alt-text.action");
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    const res: any = await handleTranslateAltText(
      {
        admin: {}, session: { shop: "s.myshopify.com" }, db, itemId: "gid://shopify/Product/1",
        provider: "claude", serviceConfig: {}, aiSettings: null,
        contentConfig: { resourceType: "Product", contentType: "products" },
      } as never,
      fd,
    );
    return { body: res.data ?? res, status: res.init?.status, db };
  }

  it("translates the source from the shop's primary language with the plain-text call (no JSON prompt)", async () => {
    translateContent.mockResolvedValue(" Red box ");
    const { body } = await run({ imageIndex: "0", sourceAltText: "Rote Kiste", targetLocale: "en" });
    expect(body).toMatchObject({ success: true, translatedAltText: "Red box", targetLocale: "en" });
    expect(translateContent).toHaveBeenCalledTimes(1);
    expect(translateContent.mock.calls[0].slice(0, 3)).toEqual(["Rote Kiste", "de", "en"]);
    expect(translateProduct).not.toHaveBeenCalled();
  });

  it("refuses an empty source with its code BEFORE any AI work or task row", async () => {
    const { body, status, db } = await run({ imageIndex: "0", sourceAltText: "  ", targetLocale: "en" });
    expect(status).toBe(400);
    expect(body.errorCode).toBe(ALT_NO_SOURCE_TEXT);
    expect(translateContent).not.toHaveBeenCalled();
    expect(db.task.create).not.toHaveBeenCalled();
  });

  it("refuses a target equal to the primary language", async () => {
    const { status } = await run({ imageIndex: "0", sourceAltText: "Kiste", targetLocale: "de" });
    expect(status).toBe(400);
    expect(translateContent).not.toHaveBeenCalled();
  });

  it("an empty AI answer is a failure, never an empty translation to save", async () => {
    translateContent.mockResolvedValue("   ");
    const { body, status } = await run({ imageIndex: "0", sourceAltText: "Kiste", targetLocale: "en" });
    expect(status).toBe(500);
    expect(body.success).toBe(false);
    expect(body.translatedAltText).toBeUndefined();
  });

  it("falls back to the form's primaryLocale when the shop lookup found nothing", async () => {
    // getCachedShopLocales maps a failed (non-401) lookup to [] by itself.
    getCachedShopLocales.mockResolvedValue([]);
    translateContent.mockResolvedValue("Red box");
    await run({ imageIndex: "0", sourceAltText: "Rote Kiste", targetLocale: "en", primaryLocale: "de" });
    expect(translateContent.mock.calls[0][1]).toBe("de");
  });

  it("lets a re-thrown 401 from the shop-locale lookup through (re-authentication), never swallows it", async () => {
    const unauthorized = new Response(null, { status: 401 });
    getCachedShopLocales.mockRejectedValue(unauthorized);
    await expect(
      run({ imageIndex: "0", sourceAltText: "Rote Kiste", targetLocale: "en", primaryLocale: "de" }),
    ).rejects.toBe(unauthorized);
    expect(translateContent).not.toHaveBeenCalled();
  });

  function dbWith(images: Array<{ mediaId: string; altText: string | null }>, library: { altText: string | null } | null = null) {
    return {
      ...makeDb(),
      product: { findUnique: vi.fn(async () => ({ images })) },
      mediaLibraryImage: { findUnique: vi.fn(async () => library) },
    };
  }

  it("takes the source from the SERVER's cached product image named by mediaId, not from the client", async () => {
    translateContent.mockResolvedValue("Red box");
    const db = dbWith([{ mediaId: "gid://shopify/MediaImage/9", altText: "Rote Kiste" }]);
    const { body } = await run(
      { imageIndex: "3", mediaId: "gid://shopify/MediaImage/9", sourceAltText: "something the client made up", targetLocale: "en" },
      db as never,
    );
    expect(body.success).toBe(true);
    expect(translateContent.mock.calls[0][0]).toBe("Rote Kiste");
  });

  it("refuses with noSource when the server's primary alt is empty, whatever the client sent", async () => {
    const db = dbWith([{ mediaId: "gid://shopify/MediaImage/9", altText: null }]);
    const { body, status } = await run(
      { mediaId: "gid://shopify/MediaImage/9", sourceAltText: "Kiste", targetLocale: "en" },
      db as never,
    );
    expect(status).toBe(400);
    expect(body.errorCode).toBe(ALT_NO_SOURCE_TEXT);
    expect(translateContent).not.toHaveBeenCalled();
  });

  it("reads a media-library file (variant gallery) from the library cache", async () => {
    translateContent.mockResolvedValue("Blue vase");
    const db = dbWith([], { altText: "Blaue Vase" });
    await run({ mediaId: "gid://shopify/MediaImage/77", sourceAltText: "", targetLocale: "en" }, db as never);
    expect(translateContent.mock.calls[0][0]).toBe("Blaue Vase");
  });

  it("refuses an unknown mediaId instead of translating the client's text", async () => {
    const db = dbWith([], null);
    const { body, status } = await run(
      { mediaId: "gid://shopify/MediaImage/404", sourceAltText: "Kiste", targetLocale: "en" },
      db as never,
    );
    expect(status).toBe(404);
    expect(body.errorCode).toBe("imageNotFound");
    expect(translateContent).not.toHaveBeenCalled();
  });
});

describe("handleTranslateAltTextToAllLocales", () => {
  it("refuses an empty source before any AI work", async () => {
    const { handleTranslateAltTextToAllLocales } = await import("~/actions/content/alt-text.action");
    const db = { task: { create: vi.fn() }, product: { findUnique: vi.fn() } };
    const fd = new FormData();
    fd.set("sourceAltText", "");
    fd.set("targetLocales", JSON.stringify(["en"]));
    const res: any = await handleTranslateAltTextToAllLocales(
      {
        admin: {}, session: { shop: "s" }, db, itemId: "p1", provider: "claude", serviceConfig: {},
        contentConfig: { resourceType: "Product", contentType: "products" }, aiSettings: null,
      } as never,
      fd,
    );
    expect(res.init?.status).toBe(400);
    expect((res.data ?? res).errorCode).toBe(ALT_NO_SOURCE_TEXT);
    expect(translateProduct).not.toHaveBeenCalled();
    expect(db.task.create).not.toHaveBeenCalled();
  });
});
