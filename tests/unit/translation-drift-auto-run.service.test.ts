/**
 * The tick that stands in for the webhook Shopify does not send.
 *
 * Two conditions must BOTH hold before a shop is swept — the plan grants the
 * auto-translation, and the merchant left its switch on — and both are filtered
 * in the due query, so the test asserts the query rather than counting sweeps
 * afterwards. Same shape as the audit and crawl sweeps.
 *
 * The rule this one carries alone: the backoff stamp is skipped for exactly one
 * failure, the locale lookup, because there the sweep never ran and an empty
 * locale list is indistinguishable from a single-language shop — stamping would
 * report a clean no-op for a whole day.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const findMany = vi.fn<(args: any) => Promise<any>>();
const update = vi.fn<(args: any) => Promise<any>>();
const scan = vi.fn<(args: any) => Promise<any>>();
const shopLocales = vi.fn<(admin: any, shop: string) => Promise<any>>();

vi.mock("~/db.server", () => ({
  db: {
    aISettings: {
      findMany: (args: any) => findMany(args),
      update: (args: any) => update(args),
    },
  },
}));
vi.mock("~/utils/admin-client.server", () => ({
  createAdminClientFromShop: async () => ({ graphql: async () => ({ json: async () => ({}) }) }),
}));
vi.mock("~/services/translations/translation-drift-scan.server", () => ({
  scanTranslationDrift: (args: any) => scan(args),
}));
vi.mock("~/utils/shop-locales-cache.server", () => ({
  getCachedShopLocales: (admin: any, shop: string) => shopLocales(admin, shop),
}));

async function loadService() {
  const mod = await import("~/services/translations/translation-drift-auto-run.service");
  return mod.TranslationDriftAutoRunService.getInstance();
}

const DUE_SHOP = { shop: "a.myshopify.com", lastTranslationScanAt: null };

beforeEach(() => {
  findMany.mockReset();
  update.mockReset();
  scan.mockReset();
  shopLocales.mockReset();
  update.mockResolvedValue({});
  scan.mockResolvedValue({ changed: 0, handed: 0, failedTypes: [], truncatedTypes: [] });
  shopLocales.mockResolvedValue([
    { locale: "en", primary: true, published: true },
    { locale: "de", primary: false, published: true },
    { locale: "it", primary: false, published: false },
  ]);
});

describe("TranslationDriftAutoRunService.tick", () => {
  it("selects only entitled shops with the switch ON, due after the window", async () => {
    findMany.mockResolvedValue([]);
    const service = await loadService();

    await service.tick(new Date("2026-08-24T12:00:00Z"));

    const where = findMany.mock.calls[0][0].where;
    // Entitlement AND consent, both in the query: the column survives a
    // downgrade by design, so neither may be assumed from the other.
    expect(where.autoTranslateExternalChanges).toBe(true);
    expect(where.subscriptionPlan.in).toContain("max");
    expect(where.subscriptionPlan.in).not.toContain("free");
    expect(where.OR[0]).toEqual({ lastTranslationScanAt: null });
    expect(where.OR[1].lastTranslationScanAt.lt).toBeInstanceOf(Date);
    // Nulls first, or a shop never swept is starved forever by Postgres'
    // NULLS LAST default.
    expect(findMany.mock.calls[0][0].orderBy).toEqual({
      lastTranslationScanAt: { sort: "asc", nulls: "first" },
    });
  });

  it("sweeps a due shop with its PUBLISHED foreign locales and stamps it", async () => {
    findMany.mockResolvedValue([DUE_SHOP]);
    scan.mockResolvedValue({ changed: 2, handed: 2, failedTypes: [], truncatedTypes: [] });
    const service = await loadService();
    const now = new Date("2026-08-24T12:00:00Z");

    const stats = await service.tick(now);

    expect(stats).toMatchObject({ candidates: 1, handed: 2, errored: 0, incomplete: 0 });
    // The primary locale never holds a translation row, and an unpublished one
    // is not on any storefront.
    expect(scan.mock.calls[0][0].foreignLocales).toEqual(["de"]);
    expect(update).toHaveBeenCalledWith({
      where: { shop: DUE_SHOP.shop },
      data: { lastTranslationScanAt: now },
    });
  });

  it("stamps a shop whose sweep THREW — an unstamped shop is swept every tick", async () => {
    findMany.mockResolvedValue([DUE_SHOP]);
    scan.mockRejectedValue(new Error("boom"));
    const service = await loadService();

    const stats = await service.tick(new Date("2026-08-24T12:00:00Z"));

    expect(stats.errored).toBe(1);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("does NOT stamp when the locale lookup failed — that sweep never ran", async () => {
    findMany.mockResolvedValue([DUE_SHOP]);
    shopLocales.mockRejectedValue(new Error("401"));
    const service = await loadService();

    const stats = await service.tick(new Date("2026-08-24T12:00:00Z"));

    expect(stats.errored).toBe(1);
    expect(scan).not.toHaveBeenCalled();
    // Stamping here would report a clean no-op for a whole day, because an
    // empty locale list looks exactly like a single-language shop.
    expect(update).not.toHaveBeenCalled();
  });

  it("counts a sweep that could not establish silence as INCOMPLETE", async () => {
    findMany.mockResolvedValue([DUE_SHOP]);
    scan.mockResolvedValue({
      changed: 0,
      handed: 0,
      failedTypes: ["ARTICLE"],
      truncatedTypes: [],
    });
    const service = await loadService();

    const stats = await service.tick(new Date("2026-08-24T12:00:00Z"));

    // "0 handed" must never be readable as "0 changed" when a type's query
    // failed — the shop is still stamped, so nothing else would say it.
    expect(stats.incomplete).toBe(1);
    expect(update).toHaveBeenCalledTimes(1);
  });
});
