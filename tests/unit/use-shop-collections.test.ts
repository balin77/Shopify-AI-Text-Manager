import { describe, it, expect, vi, beforeEach } from "vitest";
import { loadShopCollections, resetShopCollectionsForTests } from "~/hooks/useShopCollections";

/**
 * The collection list is COALESCED, not remembered.
 *
 * A session-long memo was the first cut, and it changed the single editor's
 * behaviour without saying so: `CollectionsField` used to fetch on every mount,
 * so a collection created a minute ago — or one the sync had just measured as
 * rule-based — appeared the next time the merchant opened a product. Under the
 * memo it did not until a full reload, and a stale "manual" flag is exactly the
 * unlocked row whose join Shopify refuses.
 */
describe("loadShopCollections", () => {
  beforeEach(() => {
    resetShopCollectionsForTests();
    globalThis.fetch = vi.fn(async () => ({
      json: async () => ({ success: true, collections: [], truncated: false }),
    })) as unknown as typeof fetch;
  });

  it("shares ONE request between pickers that mount together", async () => {
    // A grid page's fifty collection cells mount within milliseconds.
    const a = loadShopCollections(1_000);
    const b = loadShopCollections(1_050);
    expect(a).toBe(b);
    await a;
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("asks AGAIN for a picker that mounts later", async () => {
    await loadShopCollections(1_000);
    await loadShopCollections(1_000 + 60_000);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it("does not keep a FAILED answer for the next picker", async () => {
    globalThis.fetch = vi.fn(async () => ({ json: async () => ({ success: false }) })) as unknown as typeof fetch;
    expect(await loadShopCollections(1_000)).toEqual({ ok: false });
    // Within the window, but a failure must not be served twice.
    await loadShopCollections(1_100);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });
});
