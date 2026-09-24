/**
 * Settings → Shop-Sprachen: the one writer of a locale's `published` switch.
 * A change counts only when Shopify ECHOES it; the primary locale and unknown
 * locales are refused before anything is sent.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("~/utils/logger.server", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
const clearShopLocalesCache = vi.fn();
vi.mock("~/utils/shop-locales-cache.server", () => ({ clearShopLocalesCache }));

const { planLocalePublication, setShopLocalesPublished } = await import("~/services/shop-locale-publish.server");

const current = [
  { locale: "de", primary: true, published: true },
  { locale: "en", primary: false, published: true },
  { locale: "fr", primary: false, published: false },
];

function adminAnswering(bodies: Record<string, unknown>) {
  return {
    graphql: vi.fn(async (_q: string, opts?: { variables?: Record<string, unknown> }) => {
      const locale = String(opts?.variables?.locale);
      return { json: async () => bodies[locale] } as unknown as Response;
    }),
  };
}

beforeEach(() => vi.clearAllMocks());

describe("planLocalePublication", () => {
  it("keeps real changes, drops no-ops and refuses the primary and unknown locales", () => {
    const plan = planLocalePublication(current, [
      { locale: "fr", published: true },
      { locale: "en", published: true },
      { locale: "de", published: false },
      { locale: "xx", published: true },
    ]);
    expect(plan.changes).toEqual([{ locale: "fr", published: true }]);
    expect(plan.refused).toEqual([
      { locale: "de", error: "primaryLocale" },
      { locale: "xx", error: "unknownLocale" },
    ]);
  });
});

describe("setShopLocalesPublished", () => {
  it("confirms a change only on Shopify's echo, and clears the locale cache", async () => {
    const admin = adminAnswering({
      fr: { data: { shopLocaleUpdate: { shopLocale: { locale: "fr", published: true }, userErrors: [] } } },
    });
    const result = await setShopLocalesPublished(admin, "s.myshopify.com", [{ locale: "fr", published: true }]);
    expect(result).toEqual({ confirmed: [{ locale: "fr", published: true }], failed: [] });
    expect(admin.graphql.mock.calls[0][1]).toEqual({ variables: { locale: "fr", shopLocale: { published: true } } });
    expect(clearShopLocalesCache).toHaveBeenCalledWith("s.myshopify.com");
  });

  it("an empty userErrors WITHOUT the echoed state is not a success", async () => {
    const admin = adminAnswering({ fr: { data: { shopLocaleUpdate: { shopLocale: null, userErrors: [] } } } });
    const result = await setShopLocalesPublished(admin, "s", [{ locale: "fr", published: true }]);
    expect(result.confirmed).toEqual([]);
    expect(result.failed).toEqual([{ locale: "fr", error: "notConfirmed" }]);
    expect(clearShopLocalesCache).not.toHaveBeenCalled();
  });

  it("reports a schema-level refusal (e.g. the missing scope) in Shopify's words", async () => {
    const admin = adminAnswering({ en: { errors: [{ message: "Access denied for shopLocaleUpdate field." }] } });
    const result = await setShopLocalesPublished(admin, "s", [{ locale: "en", published: false }]);
    expect(result.failed).toEqual([{ locale: "en", error: "Access denied for shopLocaleUpdate field." }]);
  });

  it("reports userErrors per locale and still applies the others", async () => {
    const admin = adminAnswering({
      en: { data: { shopLocaleUpdate: { shopLocale: null, userErrors: [{ message: "nope" }] } } },
      fr: { data: { shopLocaleUpdate: { shopLocale: { locale: "fr", published: true }, userErrors: [] } } },
    });
    const result = await setShopLocalesPublished(admin, "s", [
      { locale: "en", published: false },
      { locale: "fr", published: true },
    ]);
    expect(result.failed).toEqual([{ locale: "en", error: "nope" }]);
    expect(result.confirmed).toEqual([{ locale: "fr", published: true }]);
  });
});
