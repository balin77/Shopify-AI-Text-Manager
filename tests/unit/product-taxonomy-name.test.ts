/**
 * The label on the closed category control — the one place the picker was
 * still English.
 *
 * The name of the category a product already carries comes from the product
 * CACHE, and the sync filled that from the Admin API, which answers in English
 * only (measured twice, Settings → Probes → Taxonomy). Everything the merchant
 * sees after OPENING the picker is localized; the field they see without
 * opening anything was not.
 *
 * What this pins is the route's contract, because each of its answers means
 * something different to the caller: a localized name replaces the label, a
 * `null` leaves the cached one standing (an English shop, or a category newer
 * than the pinned release — neither is an error), and a bad id is refused
 * rather than looked up.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const authenticate = { admin: vi.fn() };
vi.mock("~/shopify.server", () => ({ authenticate }));
vi.mock("../../app/shopify.server", () => ({ authenticate }));
vi.mock("~/db.server", () => ({ db: {} }));
vi.mock("../../app/db.server", () => ({ db: {} }));
vi.mock("~/utils/logger.server", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const getCachedShopLocales = vi.fn();
vi.mock("~/utils/shop-locales-cache.server", () => ({ getCachedShopLocales }));

const lookupLocalizedNames = vi.fn();
const scheduleTaxonomyImport = vi.fn();
const searchLocalizedNames = vi.fn();
vi.mock("~/services/taxonomy-localization.server", () => ({
  lookupLocalizedNames,
  scheduleTaxonomyImport,
  searchLocalizedNames,
}));

const { loader } = await import("~/routes/api.product-taxonomy");

const GID = "gid://shopify/TaxonomyCategory/hg-3-72";

const call = (query: string) =>
  loader({
    request: new Request(`https://example.com/api/product-taxonomy?${query}`),
    params: {},
    context: {} as any,
  } as any);

/** `data()` from react-router keeps the payload on `.data`. */
const payload = async (result: any) => (result?.data ?? result) as any;

describe("api.product-taxonomy — the name of one category", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authenticate.admin.mockResolvedValue({
      session: { shop: "test.myshopify.com" },
      admin: { graphql: vi.fn() },
    });
    getCachedShopLocales.mockResolvedValue([{ locale: "de", primary: true }]);
  });

  it("answers with the localized name and its path", async () => {
    lookupLocalizedNames.mockResolvedValue({
      byGid: new Map([[GID, { fullName: "Heim & Garten > Dekoration > Vasen", name: "Vasen" }]]),
      missing: [],
      localized: true,
    });

    const result = await payload(await call(`kind=taxonomy-name&id=${encodeURIComponent(GID)}`));

    expect(result.success).toBe(true);
    expect(result.category).toEqual({
      id: GID,
      fullName: "Heim & Garten > Dekoration > Vasen",
      name: "Vasen",
    });
    expect(scheduleTaxonomyImport).not.toHaveBeenCalled();
  });

  it("answers null — not an error — when this locale has no row for it", async () => {
    lookupLocalizedNames.mockResolvedValue({ byGid: new Map(), missing: [GID], localized: true });

    const result = await payload(await call(`kind=taxonomy-name&id=${encodeURIComponent(GID)}`));

    // The caller keeps the label it already has; a blank field would be the one
    // wrong answer.
    expect(result.success).toBe(true);
    expect(result.category).toBeNull();
  });

  it("treats a missing row as the signal that the table is behind", async () => {
    lookupLocalizedNames.mockResolvedValue({ byGid: new Map(), missing: [GID], localized: true });

    await call(`kind=taxonomy-name&id=${encodeURIComponent(GID)}`);

    // Often the FIRST lookup a shop ever makes: the control renders before
    // anybody opens the picker.
    expect(scheduleTaxonomyImport).toHaveBeenCalledWith(expect.anything(), "de");
  });

  it("does not schedule an import for a locale that is not localized at all", async () => {
    lookupLocalizedNames.mockResolvedValue({ byGid: new Map(), missing: [GID], localized: false });

    await call(`kind=taxonomy-name&id=${encodeURIComponent(GID)}`);

    expect(scheduleTaxonomyImport).not.toHaveBeenCalled();
  });

  it("looks nothing up for a shop with no primary locale", async () => {
    // `getCachedShopLocales` resolves to [] when the lookup FAILED, by
    // contract. English labels are the right answer then — never a wrong
    // language, and never a refused request.
    getCachedShopLocales.mockResolvedValue([]);

    const result = await payload(await call(`kind=taxonomy-name&id=${encodeURIComponent(GID)}`));

    expect(result.category).toBeNull();
    expect(lookupLocalizedNames).not.toHaveBeenCalled();
  });

  it("refuses anything that is not a TaxonomyCategory GID", async () => {
    const response = await call("kind=taxonomy-name&id=42");
    const result = await payload(response);

    expect(result.success).toBe(false);
    expect((response as any).init?.status ?? (response as any).status).toBe(400);
    expect(lookupLocalizedNames).not.toHaveBeenCalled();
  });
});
