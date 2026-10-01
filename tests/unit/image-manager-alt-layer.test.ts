import { describe, it, expect, vi, beforeEach } from "vitest";
import { splitLoadedAltTexts, altFieldView, shouldSaveAltText } from "~/components/image-manager/alt-market-layer";
import { isAltTextTranslated } from "~/utils/field-validation.utils";
import { translateErrorMessage } from "~/utils/editor-error-messages";

vi.mock("~/utils/logger.server", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  loggers: new Proxy({}, { get: () => vi.fn() }),
}));
vi.mock("~/services/shopify-api-gateway.service", () => ({
  ShopifyApiGateway: class {},
}));
vi.mock("~/services/tasks/resource-title.server", () => ({ taskTitleOrFallback: vi.fn(async () => "Box") }));
vi.mock("~/utils/translation-save-lock.server", () => ({
  markTranslationSaved: vi.fn(),
  isTranslationRecentlySaved: vi.fn().mockReturnValue(false),
}));

describe("alt-market-layer", () => {
  it("splits inherited from own values by media id", () => {
    const url = (m: string) => ({ a: "ua", b: "ub" } as Record<string, string>)[m];
    const r = splitLoadedAltTexts({ a: "market", b: "global" }, ["b"], url);
    expect(r.own).toEqual({ ua: "market" });
    expect(r.inherited).toEqual({ ub: "global" });
  });

  it("an inherited value is a placeholder, not the value, and is not 'translated'", () => {
    const v = altFieldView({ own: undefined, inherited: "global", primaryAlt: "prim", fallbackPlaceholder: "ph" });
    expect(v).toMatchObject({ value: "", placeholder: "global", isTranslated: false, showsInherited: true });
  });

  it("own value wins and falls back to the primary alt / default placeholder", () => {
    expect(altFieldView({ own: "mine", inherited: "g", primaryAlt: "p", fallbackPlaceholder: "ph" })).toMatchObject({ value: "mine", isTranslated: true, showsInherited: false });
    expect(altFieldView({ own: undefined, inherited: undefined, primaryAlt: "p", fallbackPlaceholder: "ph" }).placeholder).toBe("p");
    expect(altFieldView({ own: undefined, inherited: undefined, primaryAlt: "", fallbackPlaceholder: "ph" }).placeholder).toBe("ph");
  });

  it("a blur without an edit saves nothing", () => {
    expect(shouldSaveAltText(false)).toBe(false);
    expect(shouldSaveAltText(true)).toBe(true);
  });
});

describe("client layer readers", () => {
  it("isAltTextTranslated reads the global layer, not any market row of the locale", () => {
    const image = { url: "u", altTextTranslations: [{ locale: "de", marketId: "gid://shopify/Market/1", altText: "m" }] } as never;
    expect(isAltTextTranslated(image, "de", "en")).toBe(false);
    const both = { url: "u", altTextTranslations: [{ locale: "de", marketId: "gid://shopify/Market/1", altText: "m" }, { locale: "de", marketId: "", altText: "g" }] } as never;
    expect(isAltTextTranslated(both, "de", "en")).toBe(true);
  });

  it("the server refusal text is localized in the editor", () => {
    const t = { imageManager: { altImageNotFound: "weg" }, errors: {} } as never;
    expect(translateErrorMessage("Image not found on this product", t)).toBe("weg");
  });
});

describe("api-ai handler: translate-all resolves by mediaId", () => {
  beforeEach(() => vi.clearAllMocks());
  const A = "gid://shopify/MediaImage/1";
  const B = "gid://shopify/MediaImage/2";

  async function run(fields: Record<string, string>) {
    const { handleTranslateAltTextToAllLocales } = await import("~/routes/api-ai-handlers/alt-text.handler");
    const db: any = {
      task: { create: vi.fn(async () => ({ id: "t" })), update: vi.fn(async () => ({})) },
      product: {
        findUnique: vi.fn(async () => ({
          id: "gid://shopify/Product/1",
          images: [{ id: "ra", mediaId: A, position: 0 }, { id: "rb", mediaId: B, position: 1 }],
        })),
      },
    };
    const fd = new FormData();
    fd.set("sourceAltText", "Box");
    fd.set("targetLocales", JSON.stringify(["de"]));
    fd.set("primaryLocale", "en");
    fd.set("productId", "gid://shopify/Product/1");
    fd.set("imageIndex", "0");
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    const res: any = await handleTranslateAltTextToAllLocales({
      session: { shop: "s.myshopify.com" }, admin: { graphql: vi.fn() }, db, settings: {}, formData: fd,
      contentType: "products", itemId: "gid://shopify/Product/1",
    } as never);
    return { body: res.data ?? res, status: res.init?.status, db };
  }

  it("an unknown mediaId is refused before any task or AI work", async () => {
    const { body, status, db } = await run({ mediaId: "gid://shopify/MediaImage/999" });
    expect(status).toBe(404);
    expect(body.errorCode).toBe("imageNotFound");
    expect(db.task.create).not.toHaveBeenCalled();
  });
});
