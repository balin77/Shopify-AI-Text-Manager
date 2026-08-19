import { describe, it, expect } from "vitest";
import { isWebpConvertible } from "../../app/utils/mediaKind";

const POSTER = "https://cdn.shopify.com/s/files/1/0001/files/video_thumb.jpg?v=1";

describe("isWebpConvertible", () => {
  it("accepts a plain image", () => {
    expect(isWebpConvertible("https://cdn.shopify.com/x/img0.png", "image")).toBe(true);
    expect(isWebpConvertible("https://cdn.shopify.com/x/img0.jpg", "image")).toBe(true);
  });

  it("accepts an image whose kind is not known yet", () => {
    // DB-cached productImages carry no kind until /api/product-variants
    // answered — they are images by construction.
    expect(isWebpConvertible("https://cdn.shopify.com/x/img0.png")).toBe(true);
    expect(isWebpConvertible("https://cdn.shopify.com/x/img0.png", null)).toBe(true);
  });

  it("rejects an image that already is WebP", () => {
    expect(isWebpConvertible("https://cdn.shopify.com/x/img0.webp", "image")).toBe(false);
    expect(isWebpConvertible("https://cdn.shopify.com/x/img0.png?format=webp", "image")).toBe(false);
  });

  it("rejects a video, a 3D model and an external video even though their poster url is a JPG", () => {
    expect(isWebpConvertible(POSTER, "video")).toBe(false);
    expect(isWebpConvertible(POSTER, "model")).toBe(false);
    expect(isWebpConvertible(POSTER, "external_video")).toBe(false);
  });

  it("rejects a .glb url outright", () => {
    expect(isWebpConvertible("https://cdn.shopify.com/3d/models/abc.glb", "model")).toBe(false);
  });
});
