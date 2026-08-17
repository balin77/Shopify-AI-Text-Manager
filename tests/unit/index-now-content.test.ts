/**
 * PLAN_CONTENT_CREATION §Phase 3.4 / §A2 — IndexNow for the types Shopify does
 * not emit a webhook for.
 *
 * Products and collections have `products/update` and `collections/update`.
 * Pages, articles and blogs have NOTHING, so the editor's own save is the only
 * moment anything can tell a search engine that a URL went live, went away, or
 * moved. Every rule below decides what a shop's index is told, and the failure
 * modes point in opposite directions: too little and a published page stays
 * uncrawled, too much and the app asks engines to fetch drafts and 404s.
 */

import { describe, it, expect } from "vitest";
import { shouldEnqueuePublishChange } from "~/services/seo/index-now.service";
import { indexNowUrlsForPublishChange } from "~/services/seo/index-now-content.server";

describe("shouldEnqueuePublishChange", () => {
  it("submits anything that is live now", () => {
    expect(shouldEnqueuePublishChange(false, true)).toBe(true);
    expect(shouldEnqueuePublishChange(true, true)).toBe(true);
  });

  it("submits a URL that just BECAME a 404", () => {
    // Reporting removals is half of what IndexNow is for — an unpublished page
    // that stays in the index is a dead result with the shop's name on it.
    expect(shouldEnqueuePublishChange(true, false)).toBe(true);
  });

  it("stays silent about something that was never live", () => {
    // A draft's URL is a 404 no engine ever knew about. Submitting it is noise
    // at best and publishes a link the merchant chose not to publish at worst.
    expect(shouldEnqueuePublishChange(false, false)).toBe(false);
    expect(shouldEnqueuePublishChange(null, false)).toBe(false);
    expect(shouldEnqueuePublishChange(undefined, false)).toBe(false);
  });
});

describe("indexNowUrlsForPublishChange", () => {
  const host = "shop.example";

  it("builds the URL of a page that just went live", () => {
    expect(
      indexNowUrlsForPublishChange(host, {
        resource: "page",
        previousPublished: false,
        nextPublished: true,
        previousHandle: "about",
        nextHandle: "about",
      }),
    ).toEqual(["https://shop.example/pages/about"]);
  });

  it("puts an article under its blog", () => {
    expect(
      indexNowUrlsForPublishChange(host, {
        resource: "article",
        previousPublished: false,
        nextPublished: true,
        previousHandle: "hello",
        nextHandle: "hello",
        blogHandle: "news",
      }),
    ).toEqual(["https://shop.example/blogs/news/hello"]);
  });

  it("says nothing about an article whose blog it does not know", () => {
    // A guessed path would ask an engine to crawl an address that never
    // existed — the same rule the handle redirect applies.
    expect(
      indexNowUrlsForPublishChange(host, {
        resource: "article",
        previousPublished: false,
        nextPublished: true,
        previousHandle: "hello",
        nextHandle: "hello",
      }),
    ).toEqual([]);
  });

  it("reports BOTH URLs when a live page is renamed", () => {
    // The new one to be crawled, the old one because it is now a 404 or a
    // redirect. Same pair the product webhook submits.
    expect(
      indexNowUrlsForPublishChange(host, {
        resource: "page",
        previousPublished: true,
        nextPublished: true,
        previousHandle: "old",
        nextHandle: "new",
      }),
    ).toEqual(["https://shop.example/pages/new", "https://shop.example/pages/old"]);
  });

  it("does NOT report the old URL of a renamed DRAFT", () => {
    // It was never live, so no engine holds it — and the new one is a draft
    // too, so there is nothing to submit at all.
    expect(
      indexNowUrlsForPublishChange(host, {
        resource: "page",
        previousPublished: false,
        nextPublished: false,
        previousHandle: "old",
        nextHandle: "new",
      }),
    ).toEqual([]);
  });

  it("reports an unpublished page ONCE, not twice", () => {
    // Live at /about, now hidden. One URL, whether or not the handle moved.
    expect(
      indexNowUrlsForPublishChange(host, {
        resource: "page",
        previousPublished: true,
        nextPublished: false,
        previousHandle: "about",
        nextHandle: "about",
      }),
    ).toEqual(["https://shop.example/pages/about"]);
  });

  it("treats an unknown previous state as 'was never live'", () => {
    // §2.4 — before the attribute sync, `isPublished` on a cached row is the
    // migration's default, not the merchant's data. Read as "was visible" it
    // would make the first save of every draft ping IndexNow.
    expect(
      indexNowUrlsForPublishChange(host, {
        resource: "page",
        previousPublished: null,
        nextPublished: false,
        previousHandle: "old",
        nextHandle: "new",
      }),
    ).toEqual([]);
  });
});
