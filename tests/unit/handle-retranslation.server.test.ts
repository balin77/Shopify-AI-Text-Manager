/**
 * The resolver that decides whether the automatic re-translation may move a URL
 * handle at all (`AISettings.autoTranslateHandles`, Settings → KI-Anweisungen).
 *
 * Everything here is a URL that would otherwise break, so the tests are written
 * around the two rules the module exists for:
 *
 *   - **No context ⇒ no handle.** Every reason to refuse must come back as
 *     `null`, because the repair reads `null` as "leave this handle alone".
 *   - **REFRESH, never CREATE.** A locale with no handle translation is served
 *     under the primary slug and must stay there.
 *
 * The pure decision it delegates to lives in handle-redirect.shared.ts and has
 * its own tests; what is checked here is that this module asks it with the
 * right facts and refuses whenever it cannot.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const handleTakenByOtherResource = vi.fn(async () => false);
vi.mock("~/services/seo/handle-redirect.server", () => ({
  handleTakenByOtherResource: (...args: unknown[]) =>
    (handleTakenByOtherResource as (...a: unknown[]) => Promise<boolean>)(...args),
}));

import { makeHandleRedirectResolver } from "~/services/translations/handle-retranslation.server";

const SHOP = "test.myshopify.com";
const PRODUCT = "gid://shopify/Product/1";

interface Fixture {
  /** ContentTranslation rows with key "handle", global layer. */
  handleRows: Array<{ resourceId: string; locale: string; value: string }>;
  seoAutoHandleRedirect: boolean | null;
  product: { handle: string | null; status: string } | null;
  article: { handle: string; isPublished: boolean; attributesSyncedAt: Date | null; blogId: string | null } | null;
  blogHandle: string | null;
}

let fx: Fixture;

function makeDb() {
  return {
    aISettings: {
      findUnique: vi.fn(async () => ({ seoAutoHandleRedirect: fx.seoAutoHandleRedirect })),
    },
    contentTranslation: {
      findMany: vi.fn(async (args: { where: { resourceId: string } }) =>
        fx.handleRows
          .filter((row) => row.resourceId === args.where.resourceId)
          .map(({ locale, value }) => ({ locale, value })),
      ),
    },
    product: { findUnique: vi.fn(async () => fx.product) },
    page: { findUnique: vi.fn(async () => null) },
    article: { findUnique: vi.fn(async () => fx.article) },
    collection: { findUnique: vi.fn(async () => null) },
  } as never;
}

const client = {
  graphql: vi.fn(async () => ({
    json: async () => ({ data: { blog: { handle: fx.blogHandle } } }),
  })),
} as never;

function resolver() {
  return makeHandleRedirectResolver({ db: makeDb(), shop: SHOP, client });
}

beforeEach(() => {
  handleTakenByOtherResource.mockClear();
  handleTakenByOtherResource.mockResolvedValue(false);
  fx = {
    handleRows: [{ resourceId: PRODUCT, locale: "de", value: "kiste-alt" }],
    seoAutoHandleRedirect: true,
    product: { handle: "kumiko-box", status: "ACTIVE" },
    article: null,
    blogHandle: "news",
  };
});

describe("makeHandleRedirectResolver", () => {
  it("answers for a locale that already has a translated handle", async () => {
    const context = await resolver()({ resourceId: PRODUCT, resourceType: "Product" }, "de");
    expect(context).toMatchObject({
      resource: "product",
      previousTranslatedHandle: "kiste-alt",
      primaryHandle: "kumiko-box",
      previouslyLive: true,
    });
  });

  it("REFRESHES only: a locale with no handle translation gets none", async () => {
    // `fr` is served under the primary handle today, and that address stays
    // live — inventing a French URL would be a change nobody asked for, in
    // every published language at once.
    expect(await resolver()({ resourceId: PRODUCT, resourceType: "Product" }, "fr")).toBeNull();
  });

  it("refuses when the shop switched handle redirects off", async () => {
    fx.seoAutoHandleRedirect = false;
    expect(await resolver()({ resourceId: PRODUCT, resourceType: "Product" }, "de")).toBeNull();
  });

  it("refuses when the old handle is another resource's live primary handle", async () => {
    handleTakenByOtherResource.mockResolvedValue(true);
    expect(await resolver()({ resourceId: PRODUCT, resourceType: "Product" }, "de")).toBeNull();
  });

  it("refuses when the old handle is ANOTHER locale's live address", async () => {
    fx.handleRows.push({ resourceId: PRODUCT, locale: "fr", value: "kiste-alt" });
    expect(await resolver()({ resourceId: PRODUCT, resourceType: "Product" }, "de")).toBeNull();
  });

  it("refuses when the old handle IS the primary handle", async () => {
    fx.product = { handle: "kiste-alt", status: "ACTIVE" };
    expect(await resolver()({ resourceId: PRODUCT, resourceType: "Product" }, "de")).toBeNull();
  });

  it("refuses when the primary handle is unknown — the live-path check cannot be made", async () => {
    fx.product = null;
    expect(await resolver()({ resourceId: PRODUCT, resourceType: "Product" }, "de")).toBeNull();
  });

  it("refuses for a draft product, whose URL was never reachable", async () => {
    fx.product = { handle: "kumiko-box", status: "DRAFT" };
    expect(await resolver()({ resourceId: PRODUCT, resourceType: "Product" }, "de")).toBeNull();
  });

  it("refuses a BLOG handle: its articles' URLs cannot come along", async () => {
    // Shopify redirects have no wildcards, so the blog's own index page would
    // be covered and every article under it would 404 — with nobody watching
    // to be told, which is what a save-side `blogArticlesUncovered` note does
    // have.
    fx.handleRows = [{ resourceId: "gid://shopify/Blog/3", locale: "de", value: "neuigkeiten" }];
    expect(
      await resolver()({ resourceId: "gid://shopify/Blog/3", resourceType: "Blog" }, "de"),
    ).toBeNull();
  });

  it("refuses a type with no handle-derived storefront URL", async () => {
    expect(
      await resolver()({ resourceId: "gid://shopify/ShopPolicy/1", resourceType: "ShopPolicy" }, "de"),
    ).toBeNull();
  });

  it("refuses when a lookup throws — a failed read is not evidence that the move is safe", async () => {
    handleTakenByOtherResource.mockRejectedValue(new Error("connection lost"));
    expect(await resolver()({ resourceId: PRODUCT, resourceType: "Product" }, "de")).toBeNull();
  });

  describe("articles", () => {
    const ARTICLE = "gid://shopify/Article/7";
    const BLOG = "gid://shopify/Blog/3";

    beforeEach(() => {
      fx.handleRows = [{ resourceId: ARTICLE, locale: "de", value: "beitrag-alt" }];
      fx.article = { handle: "post", isPublished: true, attributesSyncedAt: new Date(), blogId: BLOG };
    });

    it("carries the blog's primary handle, which the article's path is built from", async () => {
      const context = await resolver()({ resourceId: ARTICLE, resourceType: "Article" }, "de");
      expect(context?.blogHandle).toBe("news");
    });

    it("refuses when the blog's OWN handle is translated in that locale", async () => {
      // Two translatable segments in one path and which spelling the storefront
      // serves for the outer one is unmeasured — a guessed path would redirect
      // a URL that never existed and leave the real one broken.
      fx.handleRows.push({ resourceId: BLOG, locale: "de", value: "neuigkeiten" });
      expect(await resolver()({ resourceId: ARTICLE, resourceType: "Article" }, "de")).toBeNull();
    });

    it("refuses when the blog handle cannot be read at all", async () => {
      fx.blogHandle = null;
      expect(await resolver()({ resourceId: ARTICLE, resourceType: "Article" }, "de")).toBeNull();
    });
  });
});
