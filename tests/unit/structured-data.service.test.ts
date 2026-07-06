import { describe, it, expect } from "vitest";
import {
  plainText,
  absoluteUrl,
  buildOrganizationJsonLd,
  buildProductJsonLd,
  buildCollectionJsonLd,
  buildArticleJsonLd,
  buildBreadcrumbJsonLd,
  validateJsonLd,
  renderJsonLdScript,
  gtinProps,
} from "~/services/structured-data.service";

const shop = {
  domain: "shop.example.com",
  name: "Acme",
  logoUrl: "https://cdn/logo.png",
  sameAs: ["https://instagram.com/acme"],
};

describe("plainText", () => {
  it("strips tags + decodes basic entities + collapses whitespace", () => {
    expect(plainText("<p>Hi&amp;  <b>there</b></p>\n\n x")).toBe(
      "Hi& there x",
    );
  });
  it("truncates with an ellipsis", () => {
    expect(plainText("a".repeat(20), 10)).toHaveLength(10);
    expect(plainText("a".repeat(20), 10).endsWith("…")).toBe(true);
  });
  it("handles null/undefined", () => {
    expect(plainText(null)).toBe("");
    expect(plainText(undefined)).toBe("");
  });
});

describe("absoluteUrl", () => {
  it("prefixes https and joins paths", () => {
    expect(absoluteUrl("shop.com", "products/x")).toBe(
      "https://shop.com/products/x",
    );
    expect(absoluteUrl("https://shop.com/", "/a")).toBe("https://shop.com/a");
  });
  it("returns '' for an empty domain", () => {
    expect(absoluteUrl("", "/a")).toBe("");
  });
});

describe("buildProductJsonLd", () => {
  it("emits Offer with availability + aggregateRating", () => {
    const ld = buildProductJsonLd(
      {
        title: "Mug",
        descriptionHtml: "<p>Nice mug</p>",
        handle: "mug",
        featuredImageUrl: "https://cdn/mug.jpg",
        sku: "MUG-1",
        price: 19.9,
        currency: "EUR",
        available: true,
        ratingValue: 4.5,
        ratingCount: 12,
      },
      shop,
    );
    expect(ld["@type"]).toBe("Product");
    expect(ld.url).toBe("https://shop.example.com/products/mug");
    expect((ld.offers as any).price).toBe("19.90");
    expect((ld.offers as any).availability).toBe(
      "https://schema.org/InStock",
    );
    expect((ld.aggregateRating as any).reviewCount).toBe(12);
    expect((ld.brand as any).name).toBe("Acme"); // vendor fallback to shop
  });

  it("omits offers when no price; OutOfStock when unavailable", () => {
    const ld = buildProductJsonLd(
      { title: "X", handle: "x", available: false },
      shop,
    );
    expect(ld.offers).toBeUndefined();
    expect(ld.image).toBeUndefined();
  });

  it("drops a zero/empty rating", () => {
    const ld = buildProductJsonLd(
      { title: "X", handle: "x", price: 1, currency: "USD", ratingValue: 0, ratingCount: 0 },
      shop,
    );
    expect(ld.aggregateRating).toBeUndefined();
  });

  it("byte-parity: gtin/mpn/brandUrl/priceValidUntil absent add no new keys", () => {
    const ld = buildProductJsonLd(
      { title: "Mug", handle: "mug", price: 19.9, currency: "EUR", available: true },
      shop,
    );
    expect(ld.gtin).toBeUndefined();
    expect(ld.gtin8).toBeUndefined();
    expect(ld.gtin12).toBeUndefined();
    expect(ld.gtin13).toBeUndefined();
    expect(ld.gtin14).toBeUndefined();
    expect(ld.mpn).toBeUndefined();
    expect((ld.brand as any).url).toBeUndefined();
    expect(Object.keys(ld.brand as any)).toEqual(["@type", "name"]);
    expect((ld.offers as any).priceValidUntil).toBeUndefined();
    // itemCondition always defaults once an Offer exists (plan §C1).
    expect((ld.offers as any).itemCondition).toBe(
      "https://schema.org/NewCondition",
    );
  });

  it("emits gtin*/mpn/brand.url/itemCondition/priceValidUntil when provided", () => {
    const ld = buildProductJsonLd(
      {
        title: "Mug",
        handle: "mug",
        price: 19.9,
        currency: "EUR",
        available: true,
        gtin: "614-141-000-012", // 12 digits once stripped
        mpn: "MPN-1",
        brandUrl: "https://acme.example.com",
        itemCondition: "https://schema.org/UsedCondition",
        priceValidUntil: "2027-01-01",
      },
      shop,
    );
    expect(ld.gtin12).toBe("614141000012");
    expect(ld.gtin).toBeUndefined();
    expect(ld.mpn).toBe("MPN-1");
    expect((ld.brand as any).url).toBe("https://acme.example.com");
    expect((ld.offers as any).itemCondition).toBe(
      "https://schema.org/UsedCondition",
    );
    expect((ld.offers as any).priceValidUntil).toBe("2027-01-01");
  });
});

describe("gtinProps", () => {
  it("maps 8/12/13/14-digit barcodes to gtin8/12/13/14", () => {
    expect(gtinProps("12345678")).toEqual({ gtin8: "12345678" });
    expect(gtinProps("123456789012")).toEqual({ gtin12: "123456789012" });
    expect(gtinProps("1234567890123")).toEqual({ gtin13: "1234567890123" });
    expect(gtinProps("12345678901234")).toEqual({ gtin14: "12345678901234" });
  });
  it("falls back to a generic gtin for any other non-empty length", () => {
    expect(gtinProps("123456789")).toEqual({ gtin: "123456789" });
    expect(gtinProps("123")).toEqual({ gtin: "123" });
  });
  it("strips non-digit characters before measuring length", () => {
    expect(gtinProps("1234-5678")).toEqual({ gtin8: "12345678" });
    expect(gtinProps("614 141 000 012")).toEqual({ gtin12: "614141000012" });
  });
  it("returns {} for empty/null/undefined/non-digit-only input", () => {
    expect(gtinProps("")).toEqual({});
    expect(gtinProps(null)).toEqual({});
    expect(gtinProps(undefined)).toEqual({});
    expect(gtinProps("abc")).toEqual({});
    expect(gtinProps("--  --")).toEqual({});
  });
});

describe("buildCollectionJsonLd / Organization", () => {
  it("CollectionPage carries name + url", () => {
    const ld = buildCollectionJsonLd(
      { title: "Sale", handle: "sale", seoDescription: "Big sale" },
      shop,
    );
    expect(ld["@type"]).toBe("CollectionPage");
    expect(ld.description).toBe("Big sale");
    expect(ld.url).toBe("https://shop.example.com/collections/sale");
  });
  it("Organization includes sameAs + logo", () => {
    const ld = buildOrganizationJsonLd(shop);
    expect(ld.sameAs).toEqual(["https://instagram.com/acme"]);
    expect(ld.logo).toBe("https://cdn/logo.png");
    expect(ld.url).toBe("https://shop.example.com");
  });
});

describe("buildArticleJsonLd", () => {
  it("normalizes dates to ISO and sets publisher", () => {
    const ld = buildArticleJsonLd(
      {
        title: "Post",
        body: "<p>Body</p>",
        handle: "post",
        blogHandle: "news",
        publishedAt: "2026-01-02T03:04:05Z",
      },
      shop,
    );
    expect(ld["@type"]).toBe("BlogPosting");
    expect(ld.datePublished).toBe("2026-01-02T03:04:05.000Z");
    expect(ld.dateModified).toBe("2026-01-02T03:04:05.000Z");
    expect((ld.publisher as any).name).toBe("Acme");
    expect(ld.url).toBe("https://shop.example.com/blogs/news/post");
  });
  it("drops invalid dates", () => {
    const ld = buildArticleJsonLd(
      { title: "P", handle: "p", blogHandle: "b", publishedAt: "not-a-date" },
      shop,
    );
    expect(ld.datePublished).toBeUndefined();
  });
});

describe("buildBreadcrumbJsonLd", () => {
  it("numbers positions and absolutizes relative urls", () => {
    const ld = buildBreadcrumbJsonLd(
      [
        { name: "Home", url: "/" },
        { name: "Mug", url: "https://shop.example.com/products/mug" },
      ],
      shop,
    )!;
    const items = ld.itemListElement as any[];
    expect(items[0]).toMatchObject({ position: 1, item: "https://shop.example.com/" });
    expect(items[1].item).toBe("https://shop.example.com/products/mug");
  });
  it("returns null when no valid items", () => {
    expect(buildBreadcrumbJsonLd([{ name: "", url: "" }], shop)).toBeNull();
  });
});

describe("validateJsonLd", () => {
  it("flags missing product image/offers", () => {
    const w = validateJsonLd(
      buildProductJsonLd({ title: "X", handle: "x" }, shop),
    );
    const msgs = w.map((x) => x.message).join(" ");
    expect(msgs).toMatch(/image/);
    expect(msgs).toMatch(/Offer/);
  });
  it("returns an error for null", () => {
    expect(validateJsonLd(null)[0].severity).toBe("error");
  });
  it("a complete product validates clean", () => {
    const w = validateJsonLd(
      buildProductJsonLd(
        {
          title: "X",
          handle: "x",
          descriptionHtml: "desc",
          featuredImageUrl: "i",
          price: 1,
          currency: "USD",
          available: true,
          // C1: "complete" now also requires a GTIN or MPN (AEO/shopping-feed
          // matchability) — see the noGtin warning below.
          mpn: "MPN-1",
        },
        shop,
      ),
    );
    expect(w).toEqual([]);
  });
  it("flags noGtin when a Product has no gtin*/mpn", () => {
    const ld = buildProductJsonLd(
      {
        title: "X",
        handle: "x",
        descriptionHtml: "desc",
        featuredImageUrl: "i",
        price: 1,
        currency: "USD",
        available: true,
      },
      shop,
    );
    const msgs = validateJsonLd(ld).map((w) => w.message).join(" ");
    expect(msgs).toMatch(/GTIN\/MPN/);
  });
  it("flags offerNoAvailability when an Offer has no availability", () => {
    const ld = buildProductJsonLd(
      { title: "X", handle: "x", price: 1, currency: "USD", mpn: "MPN-1" },
      shop,
    );
    const msgs = validateJsonLd(ld).map((w) => w.message).join(" ");
    expect(msgs).toMatch(/availability/);
  });
});

describe("renderJsonLdScript", () => {
  it("escapes < so a value cannot break out of the script element", () => {
    const out = renderJsonLdScript({ x: "</script><script>alert(1)" });
    expect(out).not.toContain("</script>");
    expect(out).toContain("\\u003c/script>");
  });
});
