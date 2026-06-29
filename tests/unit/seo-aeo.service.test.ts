import { describe, it, expect } from "vitest";
import { buildLlmsTxt, auditRobotsTxt, AI_CRAWLERS } from "~/services/seo/aeo.service";

/** Phase 7 AEO pure logic: llms.txt generation + robots.txt AI-crawler audit. */

describe("buildLlmsTxt", () => {
  it("renders name, summary, products and collections with absolute URLs", () => {
    const out = buildLlmsTxt({
      shopName: "Acme",
      domain: "shop.myshopify.com",
      description: "We sell <b>great</b> things",
      products: [{ title: "Blue Shoe", handle: "blue-shoe", description: "Comfy <i>shoe</i>" }],
      collections: [{ title: "Footwear", handle: "footwear" }],
    });
    expect(out).toContain("# Acme");
    expect(out).toContain("> We sell great things");
    expect(out).toContain("## Products");
    expect(out).toContain("- [Blue Shoe](https://shop.myshopify.com/products/blue-shoe): Comfy shoe");
    expect(out).toContain("## Collections");
    expect(out).toContain("- [Footwear](https://shop.myshopify.com/collections/footwear)");
    expect(out.endsWith("\n")).toBe(true);
  });

  it("does not double-prefix an https domain and omits empty sections", () => {
    const out = buildLlmsTxt({
      shopName: "Acme",
      domain: "https://shop.com/",
      products: [{ title: "P", handle: "p" }],
      collections: [],
    });
    expect(out).toContain("(https://shop.com/products/p)");
    expect(out).not.toContain("https://https://");
    expect(out).not.toContain("## Collections");
  });
});

describe("auditRobotsTxt", () => {
  const blockedFor = (txt: string) =>
    auditRobotsTxt(txt).filter((s) => s.blocked).map((s) => s.crawler);

  it("flags a specifically blocked AI crawler", () => {
    const blocked = blockedFor("User-agent: GPTBot\nDisallow: /\n");
    expect(blocked).toContain("GPTBot");
    expect(blocked).not.toContain("PerplexityBot");
  });

  it("treats a wildcard Disallow: / as blocking every AI crawler", () => {
    const blocked = blockedFor("User-agent: *\nDisallow: /\n");
    expect(blocked.sort()).toEqual([...AI_CRAWLERS].sort());
  });

  it("an Allow: / overrides the Disallow", () => {
    const blocked = blockedFor("User-agent: GPTBot\nDisallow: /\nAllow: /\n");
    expect(blocked).not.toContain("GPTBot");
  });

  it("is case-insensitive on the user-agent and ignores comments", () => {
    const blocked = blockedFor("# block AI\nuser-agent: gptbot\ndisallow: /\n");
    expect(blocked).toContain("GPTBot");
  });

  it("returns nothing blocked for an empty/permissive robots.txt", () => {
    expect(blockedFor("")).toEqual([]);
    expect(blockedFor("User-agent: *\nDisallow: /admin\n")).toEqual([]);
  });

  it("a specific group takes precedence over the wildcard", () => {
    // Wildcard blocks everything, but GPTBot has its own allow group.
    const txt = "User-agent: *\nDisallow: /\n\nUser-agent: GPTBot\nAllow: /\n";
    const blocked = blockedFor(txt);
    expect(blocked).not.toContain("GPTBot");
    expect(blocked).toContain("PerplexityBot"); // still caught by the wildcard
  });
});
