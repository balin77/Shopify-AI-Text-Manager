/**
 * `purgeMarketOverrides` reports, through `outcome.failedKeys`, the keys whose
 * market layer it did NOT clear for sure -- the page hides market values only
 * for the others (`marketPurgedFields`).
 */
import { describe, it, expect, vi } from "vitest";

const { remove } = vi.hoisted(() => ({ remove: vi.fn() }));
vi.mock("~/services/translations/verified-translations.server", () => ({
  removeAndVerifyAcrossLocales: remove,
  LOCALE_KEY_SEP: "\u0001",
}));
vi.mock("~/utils/logger.server", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { purgeMarketOverrides, marketOverrideKey } from "~/services/translations/market-layer-purge.server";

const REF = { resourceId: "gid://shopify/Product/1", resourceType: "Product" };
const row = (key: string, locale = "fr", marketId = "gid://shopify/Market/1") => ({ resourceId: REF.resourceId, locale, key, marketId });
const mirror = (rows: any[], reads = true) =>
  ({
    marketRows: reads ? vi.fn(async () => rows) : vi.fn(async () => { throw new Error("db"); }),
    removeMarket: vi.fn(async () => undefined),
  }) as any;
const run = async (m: any, extra: Record<string, unknown> = {}) => {
  const outcome = { failedKeys: new Set<string>() };
  await purgeMarketOverrides({ gateway: {} as any, mirror: m, refs: [REF], locales: ["fr"], keys: ["title", "body_html"], outcome, ...extra } as any);
  return outcome.failedKeys;
};

describe("purgeMarketOverrides outcome", () => {
  it("a confirmed removal is not a failed key", async () => {
    remove.mockResolvedValue({ confirmedPairs: new Set(["fr\u0001title"]) });
    expect([...(await run(mirror([row("title")])))]).toEqual([]);
  });

  it("an unconfirmed removal names its key; a confirmed one beside it does not", async () => {
    remove.mockResolvedValue({ confirmedPairs: new Set(["fr\u0001title"]) });
    expect([...(await run(mirror([row("title"), row("body_html")])))]).toEqual(["body_html"]);
  });

  it("an override it walked past (current) counts as not cleared", async () => {
    remove.mockResolvedValue({ confirmedPairs: new Set() });
    const current = new Set([marketOverrideKey(REF.resourceId, "gid://shopify/Market/1", "fr", "title")]);
    expect([...(await run(mirror([row("title")]), { currentOverrides: current }))]).toEqual(["title"]);
  });

  it("an unreadable mirror fails every key", async () => {
    expect([...(await run(mirror([], false)))].sort()).toEqual(["body_html", "title"]);
  });

  it("a key with no override anywhere is not failed (nothing to hide)", async () => {
    expect([...(await run(mirror([])))]).toEqual([]);
  });
});
