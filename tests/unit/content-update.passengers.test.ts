/**
 * A primary save carries every field of the form; the ones the merchant did not change are named
 * PASSENGERS (`passengerFields`) and the server does not write them - so a stale copy of an old
 * text (a delayed read, a baseline that fell back, an unannounced rich text) can never go over
 * what Shopify holds by now. Announced fields and saves without the list are written as before.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { COLLECTIONS_CONFIG, PRODUCTS_CONFIG } from "~/config/content-fields.config";

let productForm: FormData | null;
vi.mock("~/actions/product/update.actions", () => ({
  handleUpdateProduct: vi.fn(async (_ctx: unknown, fd: FormData) => {
    productForm = fd;
    return { success: true, product: { handle: "h" } };
  }),
}));
vi.mock("~/actions/product/shared/action-context", () => ({
  prepareActionContext: vi.fn(async () => ({})),
}));

const applyCollectionRuleChange = vi.fn(async () => undefined);
vi.mock("~/services/collection-rules.server", () => ({
  applyCollectionRuleChange: (...a: unknown[]) => (applyCollectionRuleChange as (...x: unknown[]) => unknown)(...a),
}));

import { handleUpdateContent } from "~/actions/content/content-update.action";
import { ShopifyContentService } from "../../src/services/shopify-content.service";

const SHOP = "test-shop.myshopify.com";
let redirectsLooked: number;

function admin() {
  return {
    graphql: async (query: string) => {
      if (query.includes("urlRedirect")) redirectsLooked++;
      return {
        json: async () => ({ data: { urlRedirects: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } } } }),
      };
    },
  };
}

function form(fields: Record<string, string>, locale = "de") {
  const fd = new FormData();
  fd.set("action", "updateContent");
  fd.set("locale", locale);
  fd.set("primaryLocale", "de");
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

const baseDb = () => ({
  collection: { findFirst: vi.fn(async () => ({ handle: "alt", attributesSyncedAt: new Date(), status: null })) },
  contentTranslation: { findMany: vi.fn(async () => []) },
});

function ctx(config: unknown, itemId: string, updateContent: ReturnType<typeof vi.fn>) {
  return {
    admin: admin() as never,
    session: { shop: SHOP } as never,
    contentConfig: config as never,
    db: baseDb() as never,
    aiSettings: { seoAutoHandleRedirect: true } as never,
    itemId,
    shopifyContentService: { updateContent } as never,
  } as unknown as Parameters<typeof handleUpdateContent>[0];
}

beforeEach(() => {
  productForm = null;
  redirectsLooked = 0;
});

describe("handleUpdateContent: passengers are not written", () => {
  it("a collection save leaves out the unchanged fields and writes the announced one", async () => {
    const updateContent = vi.fn(async () => ({ success: true }));
    await handleUpdateContent(
      ctx(COLLECTIONS_CONFIG, "gid://shopify/Collection/1", updateContent),
      form({
        title: "Old title", description: "<p>old body</p>", handle: "old", seoTitle: "t", metaDescription: "m",
        changedFields: JSON.stringify(["metaDescription"]),
        passengerFields: JSON.stringify(["title", "description", "handle", "seoTitle"]),
      }),
    );
    expect(updateContent).toHaveBeenCalledTimes(1);
    const arg = (updateContent.mock.calls[0] as unknown[])[0] as { updates: Record<string, string>; changedFields: string[] };
    expect(arg.updates).toEqual({ metaDescription: "m" });
    expect(arg.changedFields).toEqual(["metaDescription"]);
  });

  it("an unchanged handle passenger starts no redirect work", async () => {
    const updateContent = vi.fn(async () => ({ success: true }));
    await handleUpdateContent(
      ctx(COLLECTIONS_CONFIG, "gid://shopify/Collection/1", updateContent),
      form({
        title: "T2", handle: "stale-old-handle",
        changedFields: JSON.stringify(["title"]),
        passengerFields: JSON.stringify(["handle"]),
      }),
    );
    expect(redirectsLooked).toBe(0);
    const arg = (updateContent.mock.calls[0] as unknown[])[0] as { updates: Record<string, string> };
    expect(arg.updates).toEqual({ title: "T2" });
  });

  it("a field that is both announced and listed is announced: it is written", async () => {
    const updateContent = vi.fn(async () => ({ success: true }));
    await handleUpdateContent(
      ctx(COLLECTIONS_CONFIG, "gid://shopify/Collection/1", updateContent),
      form({
        title: "New", description: "d",
        changedFields: JSON.stringify(["title"]),
        passengerFields: JSON.stringify(["title", "description"]),
      }),
    );
    const arg = (updateContent.mock.calls[0] as unknown[])[0] as { updates: Record<string, string> };
    expect(arg.updates).toEqual({ title: "New" });
  });

  it("a save without the list (an older caller, an own-field save) writes every field it carries", async () => {
    const updateContent = vi.fn(async () => ({ success: true }));
    await handleUpdateContent(
      ctx(COLLECTIONS_CONFIG, "gid://shopify/Collection/1", updateContent),
      form({ title: "A", description: "B", changedFields: JSON.stringify(["title"]) }),
    );
    const arg = (updateContent.mock.calls[0] as unknown[])[0] as { updates: Record<string, string> };
    expect(arg.updates).toEqual({ title: "A", description: "B" });
  });

  it("a foreign-language save ignores the list (its form carries changed fields only)", async () => {
    const updateContent = vi.fn(async () => ({ success: true }));
    await handleUpdateContent(
      ctx(COLLECTIONS_CONFIG, "gid://shopify/Collection/1", updateContent),
      form({ title: "Titre", passengerFields: JSON.stringify(["title"]) }, "fr"),
    );
    const arg = (updateContent.mock.calls[0] as unknown[])[0] as { updates: Record<string, string> };
    expect(arg.updates).toEqual({ title: "Titre" });
  });

  it("an unreadable list names no passenger", async () => {
    const updateContent = vi.fn(async () => ({ success: true }));
    await handleUpdateContent(
      ctx(COLLECTIONS_CONFIG, "gid://shopify/Collection/1", updateContent),
      form({ title: "A", passengerFields: "not json" }),
    );
    const arg = (updateContent.mock.calls[0] as unknown[])[0] as { updates: Record<string, string> };
    expect(arg.updates).toEqual({ title: "A" });
  });

  it("only translatable content fields can be passengers: a merchandising attribute named in the list is still forwarded", async () => {
    const updateContent = vi.fn(async () => ({ success: true }));
    await handleUpdateContent(
      ctx(COLLECTIONS_CONFIG, "gid://shopify/Collection/1", updateContent),
      form({ title: "A", sortOrder: "MANUAL", changedFields: JSON.stringify(["title"]), passengerFields: JSON.stringify(["sortOrder"]) }),
    );
    const arg = (updateContent.mock.calls[0] as unknown[])[0] as { updates: Record<string, string> };
    expect(arg.updates.sortOrder).toBe("MANUAL");
  });

  it("a product save forwards neither the unchanged text nor the unchanged rich text to the product writer", async () => {
    const updateContent = vi.fn();
    await handleUpdateContent(
      ctx(PRODUCTS_CONFIG, "gid://shopify/Product/1", updateContent),
      form({
        title: "Old", description: "<p>old</p>", handle: "old-h", seoTitle: "st", metaDescription: "new meta", productType: "pt",
        changedFields: JSON.stringify(["metaDescription"]),
        passengerFields: JSON.stringify(["title", "description", "handle", "seoTitle", "productType"]),
      }),
    );
    expect(productForm).not.toBeNull();
    const sent = Object.fromEntries([...productForm!.entries()]);
    expect(sent.metaDescription).toBe("new meta");
    expect(sent.changedFields).toBe(JSON.stringify(["metaDescription"]));
    for (const gone of ["title", "descriptionHtml", "handle", "seoTitle", "productType"]) expect(gone in sent).toBe(false);
  });
});

describe("the unchanged SEO half is a passenger and no fallback value travels any more", () => {
  it("neither writer is handed the editor's copy of the unchanged half", async () => {
    const updateContent = vi.fn(async () => ({ success: true }));
    await handleUpdateContent(
      ctx(COLLECTIONS_CONFIG, "gid://shopify/Collection/1", updateContent),
      form({ seoTitle: "T-client", metaDescription: "M", changedFields: JSON.stringify(["metaDescription"]), passengerFields: JSON.stringify(["seoTitle"]) }),
    );
    const arg = (updateContent.mock.calls[0] as unknown[])[0] as { updates: Record<string, string>; seoFallback?: unknown };
    expect(arg.updates).toEqual({ metaDescription: "M" });
    expect("seoFallback" in arg).toBe(false);

    await handleUpdateContent(
      ctx(PRODUCTS_CONFIG, "gid://shopify/Product/1", vi.fn()),
      form({ seoTitle: "T-client", metaDescription: "M", changedFields: JSON.stringify(["metaDescription"]), passengerFields: JSON.stringify(["seoTitle"]) }),
    );
    expect(productForm!.has("seoFallback")).toBe(false);
  });

  // The REAL content service: the other half cannot be read from Shopify, so the collection writer itself
  // refuses and no mutation is sent. (A mocked `updateContent` would only test that a refusal is passed on.)
  const realServiceCtx = (graphql: ReturnType<typeof vi.fn>) => ({
    ...ctx(COLLECTIONS_CONFIG, "gid://shopify/Collection/1", vi.fn()),
    shopifyContentService: new ShopifyContentService({ graphql } as never),
  }) as unknown as Parameters<typeof handleUpdateContent>[0];
  const oneSided = (extra: Record<string, string> = {}) => form({
    seoTitle: "T-client", metaDescription: "M", changedFields: JSON.stringify(["metaDescription"]),
    passengerFields: JSON.stringify(["seoTitle"]), ...extra,
  });

  it("real collection writer: unreadable other half -> structured refusal, status 200, no mutation sent", async () => {
    const graphql = vi.fn(async (query: string) => {
      if (query.includes("getSeo")) throw new Error("throttled");
      return { json: async () => ({ data: { collectionUpdate: { collection: { id: "x" }, userErrors: [] } } }) };
    });
    const res: any = await handleUpdateContent(realServiceCtx(graphql), oneSided());
    expect(res?.init?.status ?? 200).toBe(200);
    const payload = res?.data ?? res;
    expect(payload).toMatchObject({ success: false, error: "seoOtherHalfUnreadable", errorKey: "seoOtherHalfUnreadable", actionType: "updateContent" });
    const sent = graphql.mock.calls.map((c) => String(c[0]));
    expect(sent.some((q) => q.includes("collectionUpdate"))).toBe(false);
  });

  it("a refused collection save does NOT apply the rule change that rode along", async () => {
    applyCollectionRuleChange.mockClear();
    const graphql = vi.fn(async () => { throw new Error("throttled"); });
    await handleUpdateContent(
      realServiceCtx(graphql),
      oneSided({ changedAttributeFields: JSON.stringify(["collectionRules"]), collectionRules: "[]" }),
    );
    expect(applyCollectionRuleChange).not.toHaveBeenCalled();
  });

  it("a successful collection save still applies the rule change", async () => {
    applyCollectionRuleChange.mockClear();
    const updateContent = vi.fn(async () => ({ success: true }));
    await handleUpdateContent(
      ctx(COLLECTIONS_CONFIG, "gid://shopify/Collection/1", updateContent),
      oneSided({ changedAttributeFields: JSON.stringify(["collectionRules"]), collectionRules: "[]" }),
    );
    expect(applyCollectionRuleChange).toHaveBeenCalledTimes(1);
  });
});

describe("buildPreservedSeo (collections)", () => {
  const make = (answer: () => unknown) =>
    new ShopifyContentService({ graphql: async () => ({ json: async () => answer() }) } as never);
  it("throws / null node -> the typed refusal (no fallback); fresh read -> the live half", async () => {
    await expect(make(() => { throw new Error("x"); }).buildPreservedSeo("gid://c/1", undefined, "D"))
      .rejects.toMatchObject({ code: "seoOtherHalfUnreadable" });
    await expect(make(() => ({ data: null })).buildPreservedSeo("gid://c/1", undefined, "D"))
      .rejects.toMatchObject({ code: "seoOtherHalfUnreadable" });
    expect(await make(() => ({ data: { node: { seo: { title: "T-live", description: "x" } } } })).buildPreservedSeo("gid://c/1", undefined, "D"))
      .toEqual({ title: "T-live", description: "D" });
  });
});
