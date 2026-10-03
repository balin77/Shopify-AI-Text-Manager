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

import { purgeMarketOverrides, marketOverrideKey, purgePairKey } from "~/services/translations/market-layer-purge.server";

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

const REF_B = { resourceId: "gid://shopify/Product/2", resourceType: "Product" };

describe("purgeMarketOverrides outcome per resource", () => {
  const rowOf = (r: { resourceId: string }, key: string) => ({ resourceId: r.resourceId, locale: "fr", key, marketId: "gid://shopify/Market/1" });
  const runPairs = async (m: any, extra: Record<string, unknown> = {}) => {
    const outcome = { failedKeys: new Set<string>(), failedPairs: new Set<string>() };
    await purgeMarketOverrides({ gateway: {} as any, mirror: m, refs: [REF, REF_B], locales: ["fr"], keys: ["title"], outcome, ...extra } as any);
    return outcome;
  };

  it("two resources share a key: A confirmed, B not -> only B is failed (A is not masked)", async () => {
    remove.mockImplementation(async (_g: unknown, resourceId: string) => ({
      confirmedPairs: new Set(resourceId === REF.resourceId ? ["fr\u0001title"] : []),
    }));
    const outcome = await runPairs(mirror([rowOf(REF, "title"), rowOf(REF_B, "title")]));
    expect([...outcome.failedKeys]).toEqual(["title"]);
    expect([...outcome.failedPairs]).toEqual([purgePairKey(REF_B.resourceId, "title")]);
  });

  it("keysByResource: a resource is purged only for the keys it changed", async () => {
    remove.mockReset();
    remove.mockResolvedValue({ confirmedPairs: new Set(["fr\u0001title", "fr\u0001label"]) });
    const m = mirror([rowOf(REF, "title"), rowOf(REF, "label")]);
    await runPairs(m, { keys: ["title", "label"], keysByResource: new Map([[REF.resourceId, new Set(["label"])]]) });
    // Only `label` was asked for A; its `title` override was never touched.
    expect(remove.mock.calls.every((c: any[]) => c[2].length === 1 && c[2][0] === "label")).toBe(true);
    expect(m.removeMarket.mock.calls.map((c: any[]) => c[2])).toEqual([["label"]]);
  });
});

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
