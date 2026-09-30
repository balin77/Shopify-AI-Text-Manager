import { afterEach, describe, expect, it } from "vitest";
import { marketingOrigin, redirectTrailingSlash } from "../../app/utils/marketing-route.server";
import { faqLd, guideArticleLd } from "../../app/utils/marketing-jsonld";
import { getMarketingTranslation } from "../../app/i18n/marketing";

const original = process.env.PUBLIC_SITE_URL;
afterEach(() => {
  if (original === undefined) delete process.env.PUBLIC_SITE_URL;
  else process.env.PUBLIC_SITE_URL = original;
});

describe("marketingOrigin", () => {
  it("uses the request origin when no public URL is configured", () => {
    delete process.env.PUBLIC_SITE_URL;
    expect(marketingOrigin(new URL("https://x.up.railway.app/de"))).toBe("https://x.up.railway.app");
  });

  it("prefers PUBLIC_SITE_URL and drops any path on it", () => {
    process.env.PUBLIC_SITE_URL = "https://contentpilot.example/";
    expect(marketingOrigin(new URL("https://x.up.railway.app/de"))).toBe("https://contentpilot.example");
  });

  it("ignores a value that is not an http(s) URL", () => {
    process.env.PUBLIC_SITE_URL = "contentpilot.example";
    expect(marketingOrigin(new URL("https://x.up.railway.app/"))).toBe("https://x.up.railway.app");
  });
});

describe("redirectTrailingSlash", () => {
  function thrown(href: string): Response | undefined {
    try {
      redirectTrailingSlash(new URL(href));
      return undefined;
    } catch (error) {
      return error as Response;
    }
  }

  it("301s a trailing slash to the bare path, keeping the query", () => {
    const response = thrown("https://x.test/de/features/?utm_source=a");
    expect(response?.status).toBe(301);
    expect(response?.headers.get("Location")).toBe("/de/features?utm_source=a");
  });

  it("leaves the root and bare paths alone", () => {
    expect(thrown("https://x.test/")).toBeUndefined();
    expect(thrown("https://x.test/features")).toBeUndefined();
  });
});

describe("marketing JSON-LD", () => {
  it("mirrors the landing page FAQ exactly", () => {
    const t = getMarketingTranslation("de");
    const node = faqLd(t) as { mainEntity: Array<{ name: string }> };
    expect(node.mainEntity.map((q) => q.name)).toEqual(t.faq.items.map((item) => item.q));
  });

  it("ties a guide article to the site and the organization by @id", () => {
    const node = guideArticleLd({
      origin: "https://o.test",
      locale: "en",
      url: "https://o.test/guide/glossary",
      headline: "Glossary",
      description: "d",
      section: "Translations",
    }) as Record<string, { "@id"?: string }>;
    expect(node.isPartOf["@id"]).toBe("https://o.test/#website");
    expect(node.publisher["@id"]).toBe("https://o.test/#organization");
  });
});
