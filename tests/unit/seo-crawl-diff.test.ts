import { describe, it, expect } from "vitest";
import { diffCrawls, hasDiffContent, type DiffRow } from "~/services/seo/crawl-diff";

/** PLAN_SEO_CRAWL_EXPANSION §7.2 — "what changed since the last crawl". */

function r(url: string, overrides: Partial<DiffRow> = {}): DiffRow {
  return {
    url,
    statusCode: 200,
    title: "Title",
    metaRobots: "",
    xRobotsTag: "",
    indexabilityKnown: true,
    ...overrides,
  };
}

describe("diffCrawls", () => {
  it("reports new and gone URLs", () => {
    const diff = diffCrawls([r("/a"), r("/b")], [r("/b"), r("/c")]);
    expect(diff.newUrls).toEqual(["/c"]);
    expect(diff.goneUrls).toEqual(["/a"]);
  });

  it("reports a status change with both sides", () => {
    const diff = diffCrawls([r("/a")], [r("/a", { statusCode: 404 })]);
    expect(diff.statusChanged).toEqual([{ url: "/a", from: 200, to: 404 }]);
    expect(diff.counts.broken).toEqual([0, 1]);
  });

  it("reports a title change", () => {
    const diff = diffCrawls([r("/a", { title: "Old" })], [r("/a", { title: "New" })]);
    expect(diff.titleChanged).toEqual([{ url: "/a", from: "Old", to: "New" }]);
  });

  it("reports a page that jumped to noindex — the message one has an SEO tool for", () => {
    const diff = diffCrawls([r("/a")], [r("/a", { metaRobots: "noindex" })]);
    expect(diff.indexabilityChanged).toEqual([{ url: "/a", from: "indexable", to: "noindex" }]);
    expect(diff.counts.nonIndexable).toEqual([0, 1]);
  });

  it("does NOT compare indexability when the previous snapshot predates the columns", () => {
    // Otherwise the first crawl after the deploy reports the entire shop as
    // changed, because unknown → indexable is a change in the DATA (§1.1).
    const previous = [r("/a", { indexabilityKnown: false }), r("/b", { indexabilityKnown: false })];
    const diff = diffCrawls(previous, [r("/a"), r("/b")]);
    expect(diff.indexabilityComparable).toBe(false);
    expect(diff.indexabilityChanged).toEqual([]);
  });

  it("still compares when only individual rows are unknown (a 404 has no answer)", () => {
    const previous = [r("/a"), r("/gone", { statusCode: 404, indexabilityKnown: false })];
    const current = [r("/a", { metaRobots: "noindex" }), r("/gone", { statusCode: 404, indexabilityKnown: false })];
    const diff = diffCrawls(previous, current);
    expect(diff.indexabilityComparable).toBe(true);
    expect(diff.indexabilityChanged).toEqual([{ url: "/a", from: "indexable", to: "noindex" }]);
  });

  it("shares the ONE verdict rule — `max-image-preview:none` is not a noindex here either", () => {
    // This module used to carry a hand-copied duplicate of the rule, which is
    // how one parsing bug lived in two places.
    const diff = diffCrawls(
      [r("/a")],
      [r("/a", { metaRobots: "index, max-image-preview:none" })],
    );
    expect(diff.indexabilityChanged).toEqual([]);
    expect(diff.counts.nonIndexable).toEqual([0, 0]);
  });

  it("does not count a firewall block as broken", () => {
    const diff = diffCrawls([r("/a")], [r("/a", { statusCode: 403 })]);
    expect(diff.counts.broken).toEqual([0, 0]);
    expect(diff.statusChanged).toHaveLength(1);
  });

  it("counts pages on both sides", () => {
    const diff = diffCrawls([r("/a")], [r("/a"), r("/b")]);
    expect(diff.counts.pages).toEqual([1, 2]);
  });
});

describe("hasDiffContent", () => {
  it("is false for two identical crawls", () => {
    expect(hasDiffContent(diffCrawls([r("/a")], [r("/a")]))).toBe(false);
  });

  it("is true as soon as anything moved", () => {
    expect(hasDiffContent(diffCrawls([r("/a")], [r("/a"), r("/b")]))).toBe(true);
  });
});
