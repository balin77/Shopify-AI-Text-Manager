import { describe, it, expect } from "vitest";
import {
  plainText,
  absoluteUrl,
  buildOrganizationJsonLd,
  buildProductJsonLd,
  buildCollectionJsonLd,
  buildArticleJsonLd,
  buildBreadcrumbJsonLd,
  buildFaqJsonLd,
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

  it("aggregateRating: bestRating defaults to 5 when ratingScaleMax is absent, mirroring the Liquid block", () => {
    const ld = buildProductJsonLd(
      { title: "Mug", handle: "mug", ratingValue: 4.2, ratingCount: 3 },
      shop,
    );
    expect(ld.aggregateRating).toEqual({
      "@type": "AggregateRating",
      ratingValue: 4.2,
      bestRating: 5,
      reviewCount: 3,
    });
  });

  it("aggregateRating: uses the provided ratingScaleMax as bestRating", () => {
    const ld = buildProductJsonLd(
      { title: "Mug", handle: "mug", ratingValue: 8.5, ratingCount: 3, ratingScaleMax: 10 },
      shop,
    );
    expect((ld.aggregateRating as any).bestRating).toBe(10);
  });

  it("byte-parity: no ratingValue/ratingCount/ratingScaleMax adds no aggregateRating key at all", () => {
    const ld = buildProductJsonLd(
      { title: "Mug", handle: "mug", price: 19.9, currency: "EUR", available: true },
      shop,
    );
    expect("aggregateRating" in ld).toBe(false);
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

describe("buildFaqJsonLd", () => {
  it("builds a FAQPage with one Question/acceptedAnswer per entry", () => {
    const ld = buildFaqJsonLd([
      { question: "Does it ship internationally?", answer: "Yes, worldwide." },
      { question: "What is the warranty?", answer: "2 years." },
    ])!;
    expect(ld["@context"]).toBe("https://schema.org");
    expect(ld["@type"]).toBe("FAQPage");
    const entities = ld.mainEntity as any[];
    expect(entities).toHaveLength(2);
    expect(entities[0]).toEqual({
      "@type": "Question",
      name: "Does it ship internationally?",
      acceptedAnswer: { "@type": "Answer", text: "Yes, worldwide." },
    });
  });

  it("filters out entries with an empty/blank question or answer", () => {
    const ld = buildFaqJsonLd([
      { question: "", answer: "Yes." },
      { question: "Q?", answer: "   " },
      { question: "Real question?", answer: "Real answer." },
    ])!;
    expect((ld.mainEntity as any[]).map((e) => e.name)).toEqual(["Real question?"]);
  });

  it("returns null when no valid entries remain", () => {
    expect(buildFaqJsonLd([])).toBeNull();
    expect(buildFaqJsonLd(null)).toBeNull();
    expect(buildFaqJsonLd(undefined)).toBeNull();
    expect(buildFaqJsonLd([{ question: "", answer: "" }])).toBeNull();
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
  it("does not warn about rating when it's simply absent (rating is optional)", () => {
    const ld = buildProductJsonLd(
      { title: "X", handle: "x", descriptionHtml: "desc", featuredImageUrl: "i", price: 1, currency: "USD", available: true, mpn: "MPN-1" },
      shop,
    );
    const msgs = validateJsonLd(ld).map((w) => w.message).join(" ");
    expect(msgs).not.toMatch(/[Rr]ating/);
  });
  it("warns when aggregateRating is present but incomplete (missing ratingValue / zero reviewCount)", () => {
    const w = validateJsonLd({
      "@context": "https://schema.org",
      "@type": "Product",
      name: "X",
      image: "i",
      description: "d",
      offers: { "@type": "Offer", priceCurrency: "USD", availability: "https://schema.org/InStock" },
      mpn: "MPN-1",
      aggregateRating: { "@type": "AggregateRating", reviewCount: 0 },
    });
    const msgs = w.map((x) => x.message).join(" ");
    expect(msgs).toMatch(/ratingValue/);
    expect(msgs).toMatch(/reviewCount/);
  });

  it("flags orgNoSameAs (info) when Organization has no sameAs", () => {
    const ld = buildOrganizationJsonLd({ domain: "shop.example.com", name: "Acme" });
    const w = validateJsonLd(ld);
    const found = w.find((x) => x.code === "orgNoSameAs");
    expect(found).toBeDefined();
    expect(found?.severity).toBe("info");
  });
  it("does not flag orgNoSameAs when Organization has sameAs", () => {
    const ld = buildOrganizationJsonLd(shop); // fixture has sameAs
    const w = validateJsonLd(ld);
    expect(w.some((x) => x.code === "orgNoSameAs")).toBe(false);
  });
  it("offerNoAvailability is suppressed under previewMode (Phase 5 batch audit — DB cache has no availability column)", () => {
    const ld = buildProductJsonLd(
      { title: "X", handle: "x", price: 1, currency: "USD", mpn: "MPN-1" },
      shop,
    );
    const previewWarnings = validateJsonLd(ld, { previewMode: true });
    expect(previewWarnings.some((w) => w.code === "offerNoAvailability")).toBe(false);
    // Default (previewMode false) behavior is unchanged.
    const defaultWarnings = validateJsonLd(ld);
    expect(defaultWarnings.some((w) => w.code === "offerNoAvailability")).toBe(true);
  });
  it("offerNoCurrency still fires under previewMode (only availability is gated)", () => {
    const ld = buildProductJsonLd(
      { title: "X", handle: "x", price: 1, available: true, mpn: "MPN-1" },
      shop,
    );
    const w = validateJsonLd(ld, { previewMode: true });
    expect(w.some((x) => x.code === "offerNoCurrency")).toBe(true);
  });

  it("FAQPage with an empty mainEntity is an error", () => {
    const w = validateJsonLd({ "@context": "https://schema.org", "@type": "FAQPage", mainEntity: [] });
    expect(w.some((x) => x.severity === "error" && /FAQPage/.test(x.message))).toBe(true);
  });
  it("a populated FAQPage validates clean", () => {
    const ld = buildFaqJsonLd([{ question: "Q?", answer: "A." }]);
    expect(validateJsonLd(ld)).toEqual([]);
  });
});

describe("renderJsonLdScript", () => {
  it("escapes < so a value cannot break out of the script element", () => {
    const out = renderJsonLdScript({ x: "</script><script>alert(1)" });
    expect(out).not.toContain("</script>");
    expect(out).toContain("\\u003c/script>");
  });
});
