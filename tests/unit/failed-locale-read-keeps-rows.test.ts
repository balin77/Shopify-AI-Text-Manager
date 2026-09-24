/**
 * A failed translation READ is not a removal (CLAUDE.md).
 *
 * Every delete-then-recreate sync rewrites a resource's mirror as "delete what
 * this run fetched, insert what came back". Only a failed MARKET layer used to
 * be taken out of that delete: a GLOBAL locale whose read errored came back
 * empty and its rows were deleted — one Shopify blip emptied the language in
 * the app until the next successful sync. These tests pin the global half:
 * the fetcher REPORTS the failed locale, the write scope keeps its rows, and
 * the reconciliation is told the locale was unread rather than empty.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("~/utils/logger.server", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("~/utils/translation-save-lock.server", () => ({
  isTranslationRecentlySaved: vi.fn().mockReturnValue(false),
}));

const fetchAllTranslationsMock = vi.fn();
vi.mock("~/services/sync-utils", async () => {
  const actual = await vi.importActual<typeof import("~/services/sync-utils")>("~/services/sync-utils");
  return {
    ...actual,
    fetchShopLocales: vi.fn().mockResolvedValue([
      { locale: "de", primary: true, published: true },
      { locale: "en", primary: false, published: true },
      { locale: "fr", primary: false, published: true },
    ]),
    fetchShopMarkets: vi.fn().mockResolvedValue([]),
    fetchAllTranslations: (...args: unknown[]) => fetchAllTranslationsMock(...args),
  };
});

const reconcileMock = vi.fn().mockResolvedValue({});
vi.mock("~/services/translations/stale-translation-sync.server", () => ({
  loadPreviousTranslationDigests: vi.fn().mockResolvedValue({}),
  reconcileStaleTranslations: (...args: unknown[]) => reconcileMock(...args),
}));

const tx = {
  contentTranslation: {
    deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    createMany: vi.fn().mockResolvedValue({ count: 0 }),
  },
  collection: { upsert: vi.fn().mockResolvedValue({}) },
};
vi.mock("~/db.server", () => ({
  db: {
    $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    contentTranslation: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));

const { fetchAllTranslations: realFetchAllTranslations, translationWriteScope } = await vi.importActual<
  typeof import("~/services/sync-utils")
>("~/services/sync-utils");
const { ContentSyncService } = await import("~/services/content-sync.service");

const shop = "test.myshopify.com";
const locales = [
  { locale: "en", primary: false, published: true },
  { locale: "fr", primary: false, published: true },
];

function jsonResponse(body: unknown) {
  return { json: async () => body } as unknown as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("fetchAllTranslations — failedGlobalLocales", () => {
  const okBody = (locale: string) => ({
    data: {
      translatableResource: {
        translatableContent: [{ key: "title", value: "Titel", digest: "d1", locale: "de" }],
        translations: [{ key: "title", value: `title-${locale}`, locale, outdated: false }],
      },
    },
  });

  it("reports a locale whose read returned GraphQL errors", async () => {
    const graphql = vi.fn(async (_q: string, opts: { variables: { locale: string } }) =>
      opts.variables.locale === "fr"
        ? jsonResponse({ errors: [{ message: "Throttled" }] })
        : jsonResponse(okBody(opts.variables.locale)),
    );
    const failed = new Set<string>();
    const rows = await realFetchAllTranslations(graphql as never, "gid://shopify/Page/1", locales, "Page", [], undefined, undefined, failed);
    expect([...failed]).toEqual(["fr"]);
    expect(rows.map((r) => r.locale)).toEqual(["en"]);
  });

  it("reports a null resource and a throw the same way", async () => {
    const graphql = vi.fn(async (_q: string, opts: { variables: { locale: string } }) => {
      if (opts.variables.locale === "fr") throw new Error("network");
      return jsonResponse({ data: { translatableResource: null } });
    });
    const failed = new Set<string>();
    await realFetchAllTranslations(graphql as never, "gid://shopify/Page/1", locales, "Page", [], undefined, undefined, failed);
    expect([...failed].sort()).toEqual(["en", "fr"]);
  });

  it("a failed MARKET layer stays a market failure, not a global one", async () => {
    const graphql = vi.fn(async (_q: string, opts: { variables: { locale: string; marketId: string | null } }) =>
      opts.variables.marketId ? jsonResponse({ errors: [{ message: "x" }] }) : jsonResponse(okBody(opts.variables.locale)),
    );
    const failedMarkets = new Set<string>();
    const failedGlobal = new Set<string>();
    await realFetchAllTranslations(
      graphql as never,
      "gid://shopify/Page/1",
      locales,
      "Page",
      [{ id: "gid://shopify/Market/9", name: "CH", localeCodes: [] } as never],
      failedMarkets,
      undefined,
      failedGlobal,
    );
    expect([...failedMarkets]).toEqual(["gid://shopify/Market/9"]);
    expect(failedGlobal.size).toBe(0);
  });
});

describe("translationWriteScope", () => {
  it("keeps the global rows of a failed locale out of the delete and the insert", () => {
    const scope = translationWriteScope([], new Set(["fr"]));
    expect(scope.where).toEqual({ marketId: { in: [""] }, NOT: { marketId: "", locale: { in: ["fr"] } } });
    expect(scope.covers({ locale: "en", marketId: "" })).toBe(true);
    expect(scope.covers({ locale: "fr", marketId: "" })).toBe(false);
  });

  it("without a failure it is the plain layer scope", () => {
    const scope = translationWriteScope([{ id: "m1" } as never]);
    expect(scope.where).toEqual({ marketId: { in: ["", "m1"] } });
    expect(scope.covers({ locale: "fr", marketId: "m1" })).toBe(true);
    expect(scope.covers({ locale: "fr", marketId: "m2" })).toBe(false);
  });
});

describe("ContentSyncService — a failed locale read keeps that locale's rows", () => {
  it("syncSingleBlog: the delete spares the failed locale and the reconciliation hears it was unread", async () => {
    const admin = {
      graphql: vi.fn(async () =>
        jsonResponse({
          data: {
            blog: {
              id: "gid://shopify/Blog/1",
              title: "News",
              handle: "news",
              templateSuffix: null,
              commentPolicy: null,
              updatedAt: "2026-09-01T00:00:00Z",
            },
          },
        }),
      ),
    };
    fetchAllTranslationsMock.mockImplementation(
      async (_g, _id, _l, _t, _m, _fm, _pc, failedGlobal: Set<string>) => {
        failedGlobal.add("fr");
        return [{ key: "title", value: "News EN", locale: "en", digest: "d1", resourceType: "Blog", marketId: "" }];
      },
    );

    await new ContentSyncService(admin as never, shop).syncSingleBlog("gid://shopify/Blog/1");

    expect(tx.contentTranslation.deleteMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        resourceId: "gid://shopify/Blog/1",
        marketId: { in: [""] },
        NOT: { marketId: "", locale: { in: ["fr"] } },
      }),
    });
    expect(reconcileMock).toHaveBeenCalledWith(
      expect.objectContaining({ foreignLocales: ["en", "fr"], unreadLocales: ["fr"] }),
    );
  });

  it("syncCollection: a locale whose IMAGE read failed is kept whole — its fresh title row is not inserted", async () => {
    const service = new ContentSyncService({ graphql: vi.fn() } as never, shop);
    vi.spyOn(service as never, "fetchCollectionData").mockResolvedValue({
      id: "gid://shopify/Collection/1",
      title: "Sale",
      handle: "sale",
      descriptionHtml: "",
      updatedAt: "2026-09-01T00:00:00Z",
      image: { id: "gid://shopify/CollectionImage/5", url: "https://cdn/x.jpg", altText: "alt" },
    } as never);
    fetchAllTranslationsMock.mockImplementation(
      async (_g, resourceId: string, _l, _t, _m, _fm, _pc, failedGlobal: Set<string>) => {
        if (resourceId.includes("CollectionImage")) {
          failedGlobal.add("fr");
          return [{ key: "alt", value: "alt en", locale: "en", resourceType: "Collection", marketId: "" }];
        }
        return [
          { key: "title", value: "Sale EN", locale: "en", digest: "d1", resourceType: "Collection", marketId: "" },
          { key: "title", value: "Soldes", locale: "fr", digest: "d1", resourceType: "Collection", marketId: "" },
        ];
      },
    );

    await service.syncCollection("gid://shopify/Collection/1", true);

    expect(tx.contentTranslation.deleteMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ NOT: { marketId: "", locale: { in: ["fr"] } } }),
    });
    const inserted = tx.contentTranslation.createMany.mock.calls[0][0].data as Array<{ locale: string; key: string }>;
    expect(inserted.map((r) => `${r.locale}:${r.key}`).sort()).toEqual(["en:image_alt_text", "en:title"]);
  });
});
