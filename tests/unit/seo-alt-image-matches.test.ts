import { describe, it, expect } from "vitest";
import { buildAltImageMatches } from "~/services/seo/alt-image-matches";

/**
 * Alt-text bridge, matching step (accessibility plan §7, phase 5): the
 * `url → match` map behind the accessibility tab's "generate alt text"
 * buttons. Filename-stem normalization itself is pinned down in
 * seo-image-alt-match.test.ts — these tests cover the map-building rules:
 * every requested URL answered, no-mediaId and ambiguity resolve to null.
 */

const images = [
  {
    id: "img-1",
    productId: "gid://shopify/Product/10",
    url: "https://cdn.shopify.com/s/files/1/0001/2345/products/hero.jpg?v=111",
    mediaId: "gid://shopify/MediaImage/100",
    productTitle: "Hero Chair",
  },
  {
    id: "img-2",
    productId: "gid://shopify/Product/20",
    url: "https://cdn.shopify.com/s/files/1/0001/2345/products/badge_800x.png?v=222",
    mediaId: null, // no Shopify media GID → no save target
    productTitle: "Badge Pin",
  },
];

describe("buildAltImageMatches", () => {
  it("maps a transformed audit URL to mediaId, productId and product title", () => {
    const auditUrl = "https://cdn.shopify.com/s/files/1/0001/2345/products/hero_1024x1024.jpg?v=999";
    expect(buildAltImageMatches([auditUrl], images)).toEqual({
      [auditUrl]: {
        mediaId: "gid://shopify/MediaImage/100",
        productId: "gid://shopify/Product/10",
        productTitle: "Hero Chair",
      },
    });
  });

  it("answers every requested URL, null for unmatched ones (theme assets etc.)", () => {
    const matched = "https://cdn.shopify.com/s/files/1/0001/2345/products/hero_600x.jpg";
    const unmatched = "https://cdn.shopify.com/s/files/1/0001/2345/files/logo.png";
    const result = buildAltImageMatches([matched, unmatched], images);
    expect(Object.keys(result).sort()).toEqual([matched, unmatched].sort());
    expect(result[matched]).not.toBeNull();
    expect(result[unmatched]).toBeNull();
  });

  it("returns null when the matched row has no mediaId — no dead button", () => {
    const auditUrl = "https://cdn.shopify.com/s/files/1/0001/2345/products/badge_600x600_crop_center.png";
    expect(buildAltImageMatches([auditUrl], images)).toEqual({ [auditUrl]: null });
  });

  it("returns null on an ambiguous stem (two different images share it)", () => {
    const ambiguous = [
      ...images,
      {
        id: "img-3",
        productId: "gid://shopify/Product/30",
        url: "https://cdn.shopify.com/s/files/1/0002/9999/products/hero_grande.jpg",
        mediaId: "gid://shopify/MediaImage/300",
        productTitle: "Other Hero",
      },
    ];
    const auditUrl = "https://cdn.shopify.com/s/files/1/0001/2345/products/hero.jpg";
    expect(buildAltImageMatches([auditUrl], ambiguous)).toEqual({ [auditUrl]: null });
  });

  it("collapses duplicate URLs into a single entry", () => {
    const auditUrl = "https://cdn.shopify.com/s/files/1/0001/2345/products/hero.jpg";
    const result = buildAltImageMatches([auditUrl, auditUrl], images);
    expect(Object.keys(result)).toEqual([auditUrl]);
  });

  it("answers null for unparsable URLs and skips non-string entries", () => {
    const bogus = ["https://", 42 as unknown as string];
    expect(buildAltImageMatches(bogus, images)).toEqual({ "https://": null });
  });

  it("returns an empty map for an empty URL list", () => {
    expect(buildAltImageMatches([], images)).toEqual({});
  });
});
