import { describe, it, expect } from "vitest";
import {
  SETTLING_POLL_DELAYS_MS,
  settlingPollDelayMs,
  unsettledMediaEntries,
  resolvedMediaIds,
  type SettlingMediaEntry,
} from "../../app/components/image-manager/settling-media";

const PRODUCT = "gid://shopify/Product/1";
const OTHER_PRODUCT = "gid://shopify/Product/2";

function entry(overrides: Partial<SettlingMediaEntry> = {}): SettlingMediaEntry {
  return {
    productId: PRODUCT,
    mediaId: "gid://shopify/MediaImage/100",
    kind: "image",
    previewUrl: "blob:https://app/abc",
    ...overrides,
  };
}

describe("settling media", () => {
  it("treats a GID missing from the media map as still processing", () => {
    // The exact reason /api/product-variants reports nothing for it: a
    // MediaImage whose `image` is null is skipped when the map is built.
    const result = unsettledMediaEntries([entry()], PRODUCT, {});
    expect(result).toHaveLength(1);
  });

  it("treats a GID present in the media map as done", () => {
    const result = unsettledMediaEntries([entry()], PRODUCT, {
      "gid://shopify/MediaImage/100": "https://cdn.shopify.com/x.jpg",
    });
    expect(result).toEqual([]);
  });

  it("never renders another product's settling media", () => {
    const entries = [entry(), entry({ productId: OTHER_PRODUCT, mediaId: "gid://shopify/MediaImage/200" })];
    expect(unsettledMediaEntries(entries, PRODUCT, {}).map(e => e.mediaId)).toEqual([
      "gid://shopify/MediaImage/100",
    ]);
  });

  it("applies the same rule to video and model entries", () => {
    // A Video / Model3d whose poster has not rendered yet is absent from the
    // media map for the same reason — the readiness signal is uniform.
    const entries = [
      entry({ mediaId: "gid://shopify/Video/1", kind: "video" }),
      entry({ mediaId: "gid://shopify/Model3d/1", kind: "model", previewUrl: undefined }),
    ];
    expect(unsettledMediaEntries(entries, PRODUCT, {})).toHaveLength(2);
    expect(
      unsettledMediaEntries(entries, PRODUCT, { "gid://shopify/Video/1": "https://cdn/poster.jpg" }),
    ).toHaveLength(1);
  });

  it("reports an arrived entry as resolved so the hook can drop it", () => {
    const entries = [entry(), entry({ mediaId: "gid://shopify/MediaImage/101" })];
    expect(
      resolvedMediaIds(entries, PRODUCT, { "gid://shopify/MediaImage/101": "https://cdn/y.jpg" }),
    ).toEqual(["gid://shopify/MediaImage/101"]);
  });

  it("reports entries of a product we left as resolved", () => {
    const entries = [entry({ productId: OTHER_PRODUCT })];
    expect(resolvedMediaIds(entries, PRODUCT, {})).toEqual([entries[0].mediaId]);
  });

  it("reports nothing while everything is still processing, so the poll keeps running", () => {
    expect(resolvedMediaIds([entry()], PRODUCT, {})).toEqual([]);
  });

  it("hands out an increasing back-off and then gives up", () => {
    expect(settlingPollDelayMs(0)).toBe(SETTLING_POLL_DELAYS_MS[0]);
    expect(settlingPollDelayMs(SETTLING_POLL_DELAYS_MS.length - 1)).toBe(
      SETTLING_POLL_DELAYS_MS[SETTLING_POLL_DELAYS_MS.length - 1],
    );
    // Giving up stops the polling — it must NOT be read as "drop the tiles".
    expect(settlingPollDelayMs(SETTLING_POLL_DELAYS_MS.length)).toBeNull();
    expect(settlingPollDelayMs(-1)).toBeNull();
  });

  it("backs off monotonically", () => {
    for (let i = 1; i < SETTLING_POLL_DELAYS_MS.length; i++) {
      expect(SETTLING_POLL_DELAYS_MS[i]).toBeGreaterThanOrEqual(SETTLING_POLL_DELAYS_MS[i - 1]);
    }
  });
});
