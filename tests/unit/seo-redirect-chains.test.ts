import { describe, it, expect } from "vitest";
import {
  findRedirectChains,
  targetToInternalPath,
  normalizeRedirectPath,
  MAX_CHAIN_HOPS,
} from "~/services/seo/redirect-chains";
import type { UrlRedirect } from "~/services/seo/redirects.service";

/**
 * PLAN_SEO_CRAWL_EXPANSION §4.6 — redirect chains are computed from Shopify's
 * own redirect list, so every rule here is testable without an HTTP request.
 */

const HOST = "shop.example.com";

function r(id: string, path: string, target: string): UrlRedirect {
  return { id: `gid://shopify/UrlRedirect/${id}`, path, target };
}

describe("normalizeRedirectPath", () => {
  it("lowercases and collapses a trailing slash — Shopify matches paths case-insensitively", () => {
    expect(normalizeRedirectPath("/Alt/")).toBe("/alt");
    expect(normalizeRedirectPath("/")).toBe("/");
    expect(normalizeRedirectPath("  /A  ")).toBe("/a");
  });
});

describe("targetToInternalPath", () => {
  it("passes a relative target through", () => {
    expect(targetToInternalPath("/neu", HOST)).toBe("/neu");
  });

  it("reduces an absolute target on the primary host to its path", () => {
    expect(targetToInternalPath(`https://${HOST}/neu?x=1`, HOST)).toBe("/neu?x=1");
  });

  it("ends the chain on a foreign host", () => {
    expect(targetToInternalPath("https://elsewhere.example/neu", HOST)).toBeNull();
  });

  it("ends the chain on a non-http target", () => {
    expect(targetToInternalPath("mailto:hi@example.com", HOST)).toBeNull();
  });

  it("ends the chain on ANY absolute target when the primary host is unknown", () => {
    // Safe direction: a missed chain, never a fix that repoints somewhere wrong.
    expect(targetToInternalPath(`https://${HOST}/neu`, null)).toBeNull();
  });
});

describe("findRedirectChains", () => {
  it("finds A→B→C and reports the FIRST redirect as the one to repoint", () => {
    const chains = findRedirectChains(
      [r("1", "/a", "/b"), r("2", "/b", "/c")],
      HOST,
    );
    expect(chains).toHaveLength(1);
    expect(chains[0].hops).toEqual(["/a", "/b", "/c"]);
    expect(chains[0].finalTarget).toBe("/c");
    expect(chains[0].isLoop).toBe(false);
    expect(chains[0].firstRedirectId).toBe("gid://shopify/UrlRedirect/1");
  });

  it("reports a longer chain once, from its head — not again from every middle hop", () => {
    const chains = findRedirectChains(
      [r("1", "/a", "/b"), r("2", "/b", "/c"), r("3", "/c", "/d")],
      HOST,
    );
    expect(chains).toHaveLength(1);
    expect(chains[0].hops).toEqual(["/a", "/b", "/c", "/d"]);
    expect(chains[0].finalTarget).toBe("/d");
  });

  it("reports a loop with no final target and no auto-fix", () => {
    const chains = findRedirectChains([r("1", "/a", "/b"), r("2", "/b", "/a")], HOST);
    expect(chains).toHaveLength(1);
    expect(chains[0].isLoop).toBe(true);
    expect(chains[0].finalTarget).toBeNull();
  });

  it("reports a loop entered from outside exactly once — as the loop itself", () => {
    const chains = findRedirectChains(
      [r("0", "/x", "/a"), r("1", "/a", "/b"), r("2", "/b", "/a")],
      HOST,
    );
    expect(chains).toHaveLength(1);
    expect(chains[0].isLoop).toBe(true);
    expect(chains.every((c) => c.finalTarget === null)).toBe(true);
  });

  it("does NOT report two redirects sharing one target — that is normal", () => {
    expect(findRedirectChains([r("1", "/a", "/b"), r("2", "/c", "/b")], HOST)).toEqual([]);
  });

  it("does not report a single redirect", () => {
    expect(findRedirectChains([r("1", "/a", "/b")], HOST)).toEqual([]);
  });

  it("follows an absolute target on the primary host, but a foreign host ends the chain", () => {
    const internal = findRedirectChains(
      [r("1", "/a", `https://${HOST}/b`), r("2", "/b", "/c")],
      HOST,
    );
    expect(internal).toHaveLength(1);
    expect(internal[0].hops).toEqual(["/a", "/b", "/c"]);

    const foreign = findRedirectChains(
      [r("1", "/a", "https://partner.example/b"), r("2", "/b", "/c")],
      HOST,
    );
    expect(foreign).toEqual([]);
  });

  it("matches case-insensitively: /Alt → /b and /b → /c is one chain", () => {
    const chains = findRedirectChains([r("1", "/Alt", "/B"), r("2", "/b", "/c")], HOST);
    expect(chains).toHaveLength(1);
    // The DISPLAYED hops keep their original casing; only matching is normalized.
    expect(chains[0].hops).toEqual(["/Alt", "/B", "/c"]);
  });

  it(`treats a chain longer than ${MAX_CHAIN_HOPS} hops as a loop — no target a fix could choose`, () => {
    const many: UrlRedirect[] = [];
    for (let i = 0; i < MAX_CHAIN_HOPS + 5; i++) {
      many.push(r(String(i), `/p${i}`, `/p${i + 1}`));
    }
    const chains = findRedirectChains(many, HOST);
    expect(chains).toHaveLength(1);
    expect(chains[0].isLoop).toBe(true);
    expect(chains[0].finalTarget).toBeNull();
  });

  it("keeps the query string of the final target — dropping it would change where the visitor lands", () => {
    const chains = findRedirectChains(
      [r("1", "/a", "/b"), r("2", "/b", `https://${HOST}/c?variant=42`)],
      HOST,
    );
    expect(chains[0].finalTarget).toBe("/c?variant=42");
  });
});
