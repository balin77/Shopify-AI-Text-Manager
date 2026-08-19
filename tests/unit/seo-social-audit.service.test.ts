import { describe, it, expect } from "vitest";
import * as cheerio from "cheerio";
import { extractSocialTags } from "~/services/seo/crawl.service";
import { summarizeLiveSocial, APP_SOCIAL_TAGS } from "~/services/seo/social-audit.service";

/**
 * PLAN_MARKUP_ACTIVATION Phase 2 — Open Graph / Twitter get the same
 * measurement JSON-LD already had. The interesting half is not the happy path
 * but the two ways a report like this lies: collapsing repeats (which is the
 * only thing that makes a duplicate visible) and reading an unmeasured
 * snapshot as "this shop serves nothing".
 */

describe("extractSocialTags", () => {
  it("keeps repeats, which is the whole point", () => {
    const $ = cheerio.load(`
      <meta property="og:title" content="A">
      <meta property="og:image" content="https://x/1.jpg">
      <meta property="og:image" content="https://x/2.jpg">
    `);
    expect(extractSocialTags($).og).toEqual(["og:title", "og:image", "og:image"]);
  });

  it("reads both attribute spellings and buckets by NAMESPACE", () => {
    // OG is defined on property= and Twitter on name=, but real themes mix the
    // two constantly and both work — keying off the attribute would report a
    // served tag as absent over a spelling nobody notices.
    const $ = cheerio.load(`
      <meta name="og:title" content="A">
      <meta property="twitter:card" content="summary">
    `);
    const out = extractSocialTags($);
    expect(out.og).toEqual(["og:title"]);
    expect(out.twitter).toEqual(["twitter:card"]);
  });

  it("ignores unrelated meta tags", () => {
    const $ = cheerio.load(`
      <meta name="description" content="x">
      <meta name="viewport" content="width=device-width">
      <meta property="product:price:amount" content="9">
    `);
    const out = extractSocialTags($);
    expect(out.og).toEqual([]);
    expect(out.twitter).toEqual([]);
  });

  it("does not count a tag with an empty content attribute", () => {
    // An empty og:image gives a scraper nothing; counting it would report a
    // card that never renders as covered.
    const $ = cheerio.load(`
      <meta property="og:image" content="">
      <meta property="og:title" content="   ">
      <meta property="og:url" content="https://x/">
    `);
    expect(extractSocialTags($).og).toEqual(["og:url"]);
  });

  it("marks only the tags this app emitted", () => {
    const $ = cheerio.load(`
      <meta property="og:image" content="https://theme/1.jpg">
      <meta property="og:image" content="https://app/2.jpg" data-contentpilot="og">
    `);
    const out = extractSocialTags($);
    expect(out.og).toEqual(["og:image", "og:image"]);
    expect(out.app).toEqual(["og:image"]);
  });

  it("normalizes case so a theme's OG:Image is not reported as missing", () => {
    const $ = cheerio.load(`<meta property="OG:Image" content="https://x/1.jpg">`);
    expect(extractSocialTags($).og).toEqual(["og:image"]);
  });
});

describe("summarizeLiveSocial", () => {
  function crawlDb(pages: any[] | null, status = "completed") {
    return {
      seoCrawlSnapshot: {
        findFirst: async () =>
          pages === null
            ? null
            : {
                id: "snap-1",
                startedAt: new Date("2026-08-01T10:00:00Z"),
                finishedAt: new Date("2026-08-01T10:20:00Z"),
                status,
              },
      },
      seoCrawlPage: { findMany: async () => pages ?? [] },
    } as any;
  }

  const page = (over: Partial<Record<string, any>> = {}) => ({
    url: "https://shop.example.com/products/a",
    statusCode: 200,
    resourceType: "product",
    ogTags: "",
    twitterTags: "",
    ogAppTags: "",
    socialKnown: true,
    jsonLdTypes: "",
    jsonLdAppTypes: "",
    // The shared loader drops rows whose body was never parsed; the social
    // report narrows once more on socialKnown.
    indexabilityKnown: true,
    ...over,
  });

  it("returns null when the shop has never completed a crawl", async () => {
    expect(await summarizeLiveSocial(crawlDb(null), "shop.myshopify.com")).toBeNull();
  });

  it("reports an unmeasured snapshot as unknown, not as 'no social markup'", async () => {
    // Every row written before the columns existed. Reading that as a finding
    // is the exact trap socialKnown exists for.
    const summary = await summarizeLiveSocial(
      crawlDb([page({ socialKnown: false }), page({ url: "https://s/p/2", socialKnown: false })]),
      "shop.myshopify.com",
    );
    expect(summary!.notMeasured).toBe(true);
    expect(summary!.pagesChecked).toBe(0);
    expect(summary!.tagCounts).toEqual([]);
  });

  it("reports a genuinely bare shop as a real finding", async () => {
    // Measured rows with empty columns are the OPPOSITE state and must read as
    // "nothing served", not as "we did not look".
    const summary = await summarizeLiveSocial(crawlDb([page()]), "shop.myshopify.com");
    expect(summary!.notMeasured).toBe(false);
    expect(summary!.tagCounts).toEqual([]);
    expect(summary!.typeStats.find((t) => t.type === "og:title")!.pages).toBe(0);
  });

  it("ignores rows this crawl never looked at, in either direction", async () => {
    const summary = await summarizeLiveSocial(
      crawlDb([
        page({ url: "https://s/p/1", ogTags: "og:title,og:image", socialKnown: true }),
        page({ url: "https://s/p/2", socialKnown: false }),
      ]),
      "shop.myshopify.com",
    );
    // The unmeasured page must not drag the coverage down as if it served
    // nothing — it was simply not part of the measurement.
    const products = summary!.coverage.find((c) => c.resourceType === "product")!;
    expect(products.total).toBe(1);
    expect(products.withTitle).toBe(1);
    expect(products.withImage).toBe(1);
    expect(products.missingExamples).toEqual([]);
  });

  it("finds a duplicate tag and says whether one copy is ours", async () => {
    const summary = await summarizeLiveSocial(
      crawlDb([
        page({ url: "https://s/p/1", ogTags: "og:title,og:image,og:image", ogAppTags: "og:image" }),
        // Theme + another app: our switch would not fix this one.
        page({ url: "https://s/p/2", ogTags: "og:title,og:title" }),
      ]),
      "shop.myshopify.com",
    );
    const image = summary!.duplicates.find((d) => d.tag === "og:image")!;
    expect(image.pages).toBe(1);
    expect(image.appIsOneCopy).toBe(1);
    expect(image.examples).toEqual(["https://s/p/1"]);

    const title = summary!.duplicates.find((d) => d.tag === "og:title")!;
    expect(title.pages).toBe(1);
    expect(title.appIsOneCopy).toBe(0);
  });

  it("keeps the duplicate rows and the type stats in agreement", async () => {
    const summary = await summarizeLiveSocial(
      crawlDb([page({ ogTags: "og:image,og:image", ogAppTags: "og:image" })]),
      "shop.myshopify.com",
    );
    for (const dup of summary!.duplicates) {
      const stat = summary!.typeStats.find((t) => t.type === dup.tag)!;
      expect(stat.duplicatePages).toBe(dup.pages);
      expect(stat.appIsOneCopy).toBe(dup.appIsOneCopy);
      // No social property legitimately repeats — unlike VideoObject, a second
      // og:image is a second candidate for ONE card.
      expect(stat.repeatable).toBe(false);
    }
  });

  it("carries a stat for every tag the app can emit, even at zero pages", async () => {
    // The gate looks these up by name; a missing entry would coincide with
    // "nothing serves it" only by accident.
    const summary = await summarizeLiveSocial(crawlDb([page()]), "shop.myshopify.com");
    for (const tag of APP_SOCIAL_TAGS) {
      expect(summary!.typeStats.some((t) => t.type === tag)).toBe(true);
    }
  });

  it("treats a missing marker as unknown origin, never as 'embed off'", async () => {
    const bare = await summarizeLiveSocial(
      crawlDb([page({ ogTags: "og:title" })]),
      "shop.myshopify.com",
    );
    expect(bare!.appEmbedDetected).toBeNull();

    const marked = await summarizeLiveSocial(
      crawlDb([page({ ogTags: "og:title", ogAppTags: "og:title" })]),
      "shop.myshopify.com",
    );
    expect(marked!.appEmbedDetected).toBe(true);
  });

  it("drops a row whose body this crawl never parsed", async () => {
    // Shared with the JSON-LD half: a 2xx row past the BFS depth limit or one
    // cheerio refused carries empty columns and must not read as "no tags".
    const summary = await summarizeLiveSocial(
      crawlDb([
        page({ url: "https://s/p/1", ogTags: "og:title,og:image" }),
        page({ url: "https://s/p/2", indexabilityKnown: false, socialKnown: false }),
      ]),
      "shop.myshopify.com",
    );
    expect(summary!.pagesChecked).toBe(1);
    expect(summary!.coverage.find((c) => c.resourceType === "product")!.total).toBe(1);
  });

  it("judges markup only on pages that actually served content", async () => {
    const summary = await summarizeLiveSocial(
      crawlDb([page({ statusCode: 404, ogTags: "" }), page({ url: "https://s/p/2", ogTags: "og:title" })]),
      "shop.myshopify.com",
    );
    expect(summary!.pagesChecked).toBe(1);
    expect(summary!.coverage.find((c) => c.resourceType === "product")!.total).toBe(1);
  });
});
