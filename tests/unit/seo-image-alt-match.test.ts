import { describe, it, expect } from "vitest";
import {
  normalizeShopifyImageUrl,
  matchImageUrlToProductImages,
} from "~/services/seo/image-alt-match";

/**
 * Image-alt bridge (accessibility plan §7): mapping Lighthouse-reported image
 * URLs back to ProductImage rows. Shopify's CDN serves the same source image
 * under many transformed URLs (`_1024x1024`, `_600x`, `@2x`, `_crop_center`,
 * legacy named sizes, `?v=` cache busters), so matching runs on the normalized
 * filename stem — these tests pin that normalization down.
 */

describe("normalizeShopifyImageUrl", () => {
  it("returns the lowercase basename for a plain CDN URL", () => {
    expect(
      normalizeShopifyImageUrl("https://cdn.shopify.com/s/files/1/0001/2345/products/hero.jpg"),
    ).toBe("hero.jpg");
  });

  it("drops the ?v= version query string", () => {
    expect(
      normalizeShopifyImageUrl("https://cdn.shopify.com/s/files/1/0001/2345/products/hero.jpg?v=1699999999"),
    ).toBe("hero.jpg");
  });

  it("strips WxH size suffixes", () => {
    expect(
      normalizeShopifyImageUrl("https://cdn.shopify.com/s/files/1/0001/products/hero_1024x1024.jpg"),
    ).toBe("hero.jpg");
  });

  it("strips width-only and height-only size suffixes", () => {
    expect(normalizeShopifyImageUrl("https://cdn.shopify.com/s/files/1/p/hero_600x.jpg")).toBe("hero.jpg");
    expect(normalizeShopifyImageUrl("https://cdn.shopify.com/s/files/1/p/hero_x600.jpg")).toBe("hero.jpg");
  });

  it("strips crop suffixes", () => {
    expect(
      normalizeShopifyImageUrl("https://cdn.shopify.com/s/files/1/p/hero_600x600_crop_center.jpg"),
    ).toBe("hero.jpg");
  });

  it("strips pixel-density suffixes (@2x)", () => {
    expect(normalizeShopifyImageUrl("https://cdn.shopify.com/s/files/1/p/hero@2x.jpg")).toBe("hero.jpg");
  });

  it("strips legacy named sizes (grande, master, …)", () => {
    expect(normalizeShopifyImageUrl("https://cdn.shopify.com/s/files/1/p/hero_grande.jpg")).toBe("hero.jpg");
    expect(normalizeShopifyImageUrl("https://cdn.shopify.com/s/files/1/p/hero_master.png")).toBe("hero.png");
  });

  it("strips combined suffix chains plus query string", () => {
    expect(
      normalizeShopifyImageUrl(
        "https://cdn.shopify.com/s/files/1/0001/2345/products/hero_600x600_crop_center@2x.jpg?v=42",
      ),
    ).toBe("hero.jpg");
  });

  it("lowercases the result", () => {
    expect(normalizeShopifyImageUrl("https://cdn.shopify.com/s/files/1/p/Hero_1024X1024.JPG")).toBe("hero.jpg");
  });

  it("handles basenames without a file extension", () => {
    expect(normalizeShopifyImageUrl("https://cdn.shopify.com/s/files/1/xyz")).toBe("xyz");
    expect(normalizeShopifyImageUrl("https://cdn.shopify.com/s/files/1/xyz_600x")).toBe("xyz");
  });

  it("does not mangle underscored names that carry no transformation suffix", () => {
    expect(
      normalizeShopifyImageUrl("https://cdn.shopify.com/s/files/1/p/red_shirt_front.jpg"),
    ).toBe("red_shirt_front.jpg");
  });

  it("normalizes foreign CDN URLs by the same rules (matching simply won't find a row)", () => {
    expect(normalizeShopifyImageUrl("https://images.example.com/img/photo_600x.png")).toBe("photo.png");
  });

  it("resolves protocol-relative and root-relative URLs as they appear in snippets", () => {
    expect(normalizeShopifyImageUrl("//cdn.shopify.com/s/files/1/p/hero_600x.jpg")).toBe("hero.jpg");
    expect(normalizeShopifyImageUrl("/cdn/shop/products/hero_1024x1024.jpg?v=1")).toBe("hero.jpg");
  });

  it("decodes percent-encoded basenames", () => {
    expect(
      normalizeShopifyImageUrl("https://cdn.shopify.com/s/files/1/p/caf%C3%A9-chair_600x.jpg"),
    ).toBe("café-chair.jpg");
  });

  it("returns null for unparsable or basename-less input", () => {
    expect(normalizeShopifyImageUrl("")).toBeNull();
    expect(normalizeShopifyImageUrl("   ")).toBeNull();
    expect(normalizeShopifyImageUrl("https://")).toBeNull();
    expect(normalizeShopifyImageUrl("https://cdn.shopify.com/s/files/1/p/")).toBeNull();
  });
});

describe("matchImageUrlToProductImages", () => {
  const images = [
    {
      id: "gid://shopify/ProductImage/1",
      productId: "gid://shopify/Product/10",
      url: "https://cdn.shopify.com/s/files/1/0001/2345/products/hero.jpg?v=111",
    },
    {
      id: "gid://shopify/ProductImage/2",
      productId: "gid://shopify/Product/20",
      url: "https://cdn.shopify.com/s/files/1/0001/2345/products/badge_800x.png?v=222",
    },
  ];

  it("matches a transformed audit URL to the stored original", () => {
    expect(
      matchImageUrlToProductImages(
        "https://cdn.shopify.com/s/files/1/0001/2345/products/hero_1024x1024.jpg?v=999",
        images,
      ),
    ).toEqual({ id: "gid://shopify/ProductImage/1", productId: "gid://shopify/Product/10" });
  });

  it("matches when both sides carry (different) transformations", () => {
    expect(
      matchImageUrlToProductImages(
        "https://cdn.shopify.com/s/files/1/0001/2345/products/badge_600x600_crop_center@2x.png",
        images,
      ),
    ).toEqual({ id: "gid://shopify/ProductImage/2", productId: "gid://shopify/Product/20" });
  });

  it("returns null when nothing matches (e.g. a theme-asset image)", () => {
    expect(
      matchImageUrlToProductImages("https://cdn.shopify.com/s/files/1/0001/2345/files/logo.png", images),
    ).toBeNull();
  });

  it("returns null on an ambiguous stem — two different images, no wrong button", () => {
    const ambiguous = [
      ...images,
      {
        id: "gid://shopify/ProductImage/3",
        productId: "gid://shopify/Product/30",
        url: "https://cdn.shopify.com/s/files/1/0002/9999/products/hero_grande.jpg",
      },
    ];
    expect(
      matchImageUrlToProductImages("https://cdn.shopify.com/s/files/1/0001/2345/products/hero.jpg", ambiguous),
    ).toBeNull();
  });

  it("tolerates the same image row appearing twice", () => {
    const duplicated = [images[0], { ...images[0], url: "https://cdn.shopify.com/s/files/1/p/hero_600x.jpg" }];
    expect(
      matchImageUrlToProductImages("https://cdn.shopify.com/s/files/1/p/hero_1024x1024.jpg", duplicated),
    ).toEqual({ id: "gid://shopify/ProductImage/1", productId: "gid://shopify/Product/10" });
  });

  it("returns null for an unparsable audit URL or an empty image list", () => {
    expect(matchImageUrlToProductImages("", images)).toBeNull();
    expect(matchImageUrlToProductImages("https://", images)).toBeNull();
    expect(matchImageUrlToProductImages("https://cdn.shopify.com/s/files/1/p/hero.jpg", [])).toBeNull();
  });
});
