import { describe, it, expect } from "vitest";
import { normalizeShopDomain } from "../../app/services/marketing-shop-domain.shared";

describe("normalizeShopDomain", () => {
  it("accepts a bare store handle", () => {
    expect(normalizeShopDomain("my-shop")).toEqual({ ok: true, shop: "my-shop.myshopify.com" });
  });

  it("accepts a myshopify host unchanged", () => {
    expect(normalizeShopDomain("my-shop.myshopify.com")).toEqual({
      ok: true,
      shop: "my-shop.myshopify.com",
    });
  });

  it("strips protocol, path and query", () => {
    for (const input of [
      "https://my-shop.myshopify.com",
      "https://my-shop.myshopify.com/admin",
      "http://my-shop.myshopify.com/admin/products?x=1",
      "my-shop.myshopify.com/admin#top",
    ]) {
      expect(normalizeShopDomain(input)).toEqual({ ok: true, shop: "my-shop.myshopify.com" });
    }
  });

  it("reads the handle out of a new-admin URL", () => {
    for (const input of [
      "admin.shopify.com/store/my-shop",
      "https://admin.shopify.com/store/my-shop",
      "https://admin.shopify.com/store/my-shop/apps",
      "  HTTPS://Admin.Shopify.com/store/My-Shop/products  ",
    ]) {
      expect(normalizeShopDomain(input)).toEqual({ ok: true, shop: "my-shop.myshopify.com" });
    }
  });

  it("refuses a custom domain instead of inventing a handle from it", () => {
    // `myshop.com` carries no store handle; appending .myshopify.com to it
    // would start an install for a store that does not exist.
    expect(normalizeShopDomain("myshop.com")).toEqual({ ok: false, reason: "custom-domain" });
    expect(normalizeShopDomain("https://www.myshop.de/collections/all")).toEqual({
      ok: false,
      reason: "custom-domain",
    });
  });

  it("refuses empty and malformed input", () => {
    expect(normalizeShopDomain("")).toEqual({ ok: false, reason: "empty" });
    expect(normalizeShopDomain("   ")).toEqual({ ok: false, reason: "empty" });
    expect(normalizeShopDomain("https://")).toEqual({ ok: false, reason: "empty" });
    expect(normalizeShopDomain("my shop")).toEqual({ ok: false, reason: "invalid" });
    expect(normalizeShopDomain("-bad")).toEqual({ ok: false, reason: "invalid" });
  });

  it("produces only hosts auth.$.tsx would accept", () => {
    const pattern = /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/;
    for (const input of ["shop", "shop.myshopify.com", "admin.shopify.com/store/shop"]) {
      const result = normalizeShopDomain(input);
      expect(result.ok).toBe(true);
      if (result.ok) expect(pattern.test(result.shop)).toBe(true);
    }
  });
});
