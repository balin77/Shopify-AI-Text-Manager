import { describe, it, expect, afterEach } from "vitest";
import {
  buildLlmsTxt,
  auditRobotsTxt,
  classifyDisallowPath,
  groupCrawlerStatuses,
  llmsTxtMatches,
  themeWritesEnabled,
  buildRobotsLiquid,
  parseManagedRobotsLiquid,
  isRemovableRobotsPath,
  robotsLooksSane,
  parseRobotsAdviceResponse,
  adviseableRules,
  ROBOTS_MANAGED_MARKER,
  AI_CRAWLERS,
  wrapLlmsTxtForTheme,
  unwrapLlmsTxtFromTheme,
  buildAgentsMd,
  policyPath,
  AI_DISCOVERY_TEMPLATES,
  AI_DISCOVERY_PATHS,
} from "~/services/seo/aeo.service";

/** Phase 7 AEO pure logic: llms.txt generation + robots.txt AI-crawler audit. */

/**
 * Abridged stock Shopify robots.txt. Every line here is a correct exclusion —
 * the audit must NOT report any of it as a problem, which is exactly what the
 * old "any Disallow ⇒ partially blocked" logic got wrong.
 */
const SHOPIFY_DEFAULT_ROBOTS = `User-agent: *
Disallow: /admin
Disallow: /cart
Disallow: /orders
Disallow: /checkouts/
Disallow: /checkout
Disallow: /:id/checkouts
Disallow: /:id/orders
Disallow: /carts
Disallow: /account
Disallow: /collections/*sort_by*
Disallow: /*/collections/*sort_by*
Disallow: /collections/*+*
Disallow: /collections/*%2B*
Disallow: /blogs/*+*
Disallow: /*/blogs/*+*
Disallow: /*design_theme_id*
Disallow: /*preview_theme_id*
Disallow: /*preview_script_id*
Disallow: /apple-app-site-association
Disallow: /.well-known/shopify/monitoring
Disallow: /cdn/wpm/*.js
Disallow: /recommendations/products
Disallow: /*/recommendations/products
Disallow: /search
`;

/**
 * The rules a real 2026 store additionally ships that the first version of the
 * classifier mis-filed as "real content" — app-proxy endpoints, tracking
 * params, hash-suffixed duplicate product URLs, `*filter*&*filter*` facets.
 * Verbatim from a live store, so the regression is pinned to reality.
 */
const SHOPIFY_2026_EXTRA_RULES = `User-agent: *
Disallow: /a/downloads/-/*
Disallow: */collections/*filter*&*filter*
Disallow: /*/*?*ls=*&ls=*
Disallow: /*/*?*ls%3D*%3Fls%3D*
Disallow: /*/*?*ls%3d*%3fls%3d*
Disallow: /sf_private_access_tokens
Disallow: /products/*-[a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9]-remote
Disallow: /*/products/*-[a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9]-remote
Disallow: /collections/*/products/*-[a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9]-remote
Disallow: /*/collections/*/products/*-[a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9]-remote
Disallow: /*?*oseid=*
Disallow: /password
`;

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

  it("escapes Markdown special characters and newlines in titles (link-injection)", () => {
    const out = buildLlmsTxt({
      shopName: "Acme",
      domain: "shop.com",
      products: [{ title: "Shoe [Red] (40% off)\nNEW", handle: "shoe" }],
      collections: [],
    });
    expect(out).toContain("- [Shoe \\[Red\\] (40% off) NEW](https://shop.com/products/shoe)");
    // the raw, unescaped bracket form must NOT appear
    expect(out).not.toContain("[Shoe [Red]");
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

  describe("partial blocks", () => {
    const partialFor = (txt: string) =>
      auditRobotsTxt(txt).filter((s) => s.partiallyBlocked).map((s) => s.crawler);

    it("flags a crawler-specific partial block (e.g. Disallow: /products/)", () => {
      const txt = "User-agent: GPTBot\nDisallow: /products/\n";
      const statuses = auditRobotsTxt(txt);
      const gptbot = statuses.find((s) => s.crawler === "GPTBot")!;
      expect(gptbot.blocked).toBe(false);
      expect(gptbot.partiallyBlocked).toBe(true);
      // not fully blocked, so it must not show up in the legacy `blocked` list
      expect(statuses.filter((s) => s.blocked).map((s) => s.crawler)).not.toContain("GPTBot");
    });

    it("flags a wildcard partial block for every AI crawler", () => {
      const partial = partialFor("User-agent: *\nDisallow: /collections/\n");
      expect(partial.sort()).toEqual([...AI_CRAWLERS].sort());
    });

    it("a fully-blocked crawler is not also reported as partially blocked", () => {
      const statuses = auditRobotsTxt("User-agent: GPTBot\nDisallow: /\n");
      const gptbot = statuses.find((s) => s.crawler === "GPTBot")!;
      expect(gptbot.blocked).toBe(true);
      expect(gptbot.partiallyBlocked).toBe(false);
    });

    it("an empty Disallow value (allow-all) is not a partial block", () => {
      expect(partialFor("User-agent: *\nDisallow:\n")).toEqual([]);
    });

    it("stays empty for a fully permissive robots.txt", () => {
      expect(partialFor("")).toEqual([]);
      expect(partialFor("User-agent: *\nAllow: /\n")).toEqual([]);
    });
  });

  describe("rule classification", () => {
    const gptbot = (txt: string) => auditRobotsTxt(txt).find((s) => s.crawler === "GPTBot")!;

    it("treats Shopify's stock exclusions as standard, not a content restriction", () => {
      const s = gptbot(SHOPIFY_DEFAULT_ROBOTS);
      expect(s.blocked).toBe(false);
      expect(s.contentRestricted).toBe(false);
      expect(s.verdict).toBe("standard");
      // still "partially blocked" in the legacy sense — that's why the new
      // field exists: the legacy flag alone produced a false alarm here.
      expect(s.partiallyBlocked).toBe(true);
      expect(s.rules.every((r) => r.impact !== "content")).toBe(true);
    });

    it("flags a disallowed storefront path as a content restriction", () => {
      const s = gptbot(`${SHOPIFY_DEFAULT_ROBOTS}Disallow: /products\n`);
      expect(s.contentRestricted).toBe(true);
      expect(s.verdict).toBe("restricted");
      expect(s.rules.find((r) => r.path === "/products")).toEqual({
        path: "/products",
        impact: "content",
        reason: "storefront",
      });
    });

    it("classifies an unrecognised plain path as content (a real custom route)", () => {
      const s = gptbot("User-agent: *\nDisallow: /lookbook\n");
      expect(s.verdict).toBe("restricted");
      expect(s.rules[0].reason).toBe("unknown");
    });

    it("files an unrecognised wildcard pattern under unknown, without raising the verdict", () => {
      const s = gptbot("User-agent: *\nDisallow: /*_shopify_weird*\n");
      expect(s.rules[0]).toMatchObject({ impact: "unknown", reason: "technicalPattern" });
      expect(s.contentRestricted).toBe(false);
      expect(s.verdict).toBe("standard");
    });

    it("does not flag any of a real 2026 store's extra default rules as content", () => {
      const s = gptbot(SHOPIFY_2026_EXTRA_RULES);
      const content = s.rules.filter((r) => r.impact === "content");
      expect(content).toEqual([]);
      expect(s.verdict).toBe("standard");
    });

    it.each([
      ["/a/downloads/-/*", "operational", "appProxy"],
      ["*/collections/*filter*&*filter*", "duplicate", "faceted"],
      ["/*/*?*ls=*&ls=*", "operational", "tracking"],
      ["/*/*?*ls%3D*%3Fls%3D*", "operational", "tracking"],
      ["/sf_private_access_tokens", "operational", "internal"],
      ["/*?*oseid=*", "operational", "tracking"],
      ["/password", "operational", "password"],
      [
        "/collections/*/products/*-[a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9]-remote",
        "duplicate",
        "hashedDuplicate",
      ],
    ])("classifies %s as %s/%s", (path, impact, reason) => {
      expect(classifyDisallowPath(path)).toEqual({ path, impact, reason });
    });

    // Review finding: the operational/duplicate patterns matched ANY segment,
    // so a storefront page whose last segment happened to be an operational
    // keyword was filed as "technical" and shown with a green verdict. False
    // negatives are the dangerous direction — these must stay content.
    it.each([
      "/pages/services",
      "/pages/apps",
      "/pages/localization",
      "/pages/filter_guide",
      "/collections/tools",
      "/collections/orders",
      "/collections/carts",
      "/collections/challenge",
      "/collections/recommendations",
      "/collections/cdn",
      "/blogs/account",
    ])("keeps %s in the content bucket", (path) => {
      expect(classifyDisallowPath(path).impact).toBe("content");
    });

    it("still anchors the real Shopify prefixed rules as operational", () => {
      for (const [path, reason] of [
        ["/:id/checkouts", "checkout"],
        ["/84724678988/orders", "account"],
        ["/*/recommendations/products", "internal"],
        ["/*/orders", "account"],
      ] as const) {
        expect(classifyDisallowPath(path)).toMatchObject({ impact: "operational", reason });
      }
    });

    it("still treats a genuinely blocked collection as content", () => {
      // Guard against the loosened `filter` matcher swallowing real collections.
      expect(classifyDisallowPath("/collections/water-filters")).toMatchObject({
        impact: "content",
        reason: "storefront",
      });
    });

    it("keeps faceted collection URLs out of the content bucket", () => {
      const s = gptbot("User-agent: *\nDisallow: /collections/*sort_by*\nDisallow: /collections/*+*\n");
      expect(s.contentRestricted).toBe(false);
      expect(s.rules.map((r) => r.impact)).toEqual(["duplicate", "duplicate"]);
    });

    it("records whether the crawler matched its own group or the wildcard", () => {
      const txt = "User-agent: *\nDisallow: /cart\n\nUser-agent: GPTBot\nDisallow: /products\n";
      const statuses = auditRobotsTxt(txt);
      expect(statuses.find((s) => s.crawler === "GPTBot")!.matchedBy).toBe("explicit");
      expect(statuses.find((s) => s.crawler === "ClaudeBot")!.matchedBy).toBe("wildcard");
      expect(auditRobotsTxt("")[0].matchedBy).toBe("none");
    });

    it("drops a Disallow that an exact-path Allow overrides", () => {
      const s = gptbot("User-agent: *\nDisallow: /blogs\nAllow: /blogs\n");
      expect(s.rules).toEqual([]);
      expect(s.verdict).toBe("allowed");
    });

    it("a full block classifies as sitewide and is not content-restricted", () => {
      const s = gptbot("User-agent: GPTBot\nDisallow: /\n");
      expect(s.verdict).toBe("blocked");
      expect(s.contentRestricted).toBe(false);
    });

    // Review finding: only `/` counted as site-wide, so `Disallow: *` — which
    // matches every URL per RFC 9309 — was reported green AND offered as a
    // prunable path, i.e. the app would have unblocked a whole site through
    // the "prune one path" flow.
    it.each(["/", "/*", "*"])("treats Disallow: %s as a full block", (path) => {
      const s = gptbot(`User-agent: *\nDisallow: ${path}\n`);
      expect(s.blocked).toBe(true);
      expect(s.verdict).toBe("blocked");
      expect(isRemovableRobotsPath(path)).toBe(false);
    });

    it.each(["/", "/*", "*"])("never offers Disallow: %s for removal", (path) => {
      const groups = groupCrawlerStatuses(auditRobotsTxt(`User-agent: *\nDisallow: ${path}\n`));
      expect(adviseableRules(groups)).toEqual([]);
    });
  });
});

describe("buildLlmsTxt summary line", () => {
  const base = { shopName: "Shop", domain: "x.test", products: [], collections: [] };

  it("emits the `>` summary from the shop description", () => {
    const out = buildLlmsTxt({ ...base, description: "Handmade 3D-printed desk objects." });
    expect(out).toContain("> Handmade 3D-printed desk objects.");
  });

  it("omits the line entirely when there is no description", () => {
    // Better no summary than an invented one — the merchant is asked for it.
    for (const description of ["", "   ", null, undefined]) {
      expect(buildLlmsTxt({ ...base, description })).not.toContain(">");
    }
  });

  it("flattens and caps a long description", () => {
    const out = buildLlmsTxt({ ...base, description: "a\nb  c " + "x".repeat(400) });
    const summary = out.split("\n").find((l) => l.startsWith("> "))!;
    expect(summary).not.toContain("\n");
    expect(summary.length).toBeLessThanOrEqual(252);
    expect(summary).toContain("a b c");
  });
});

describe("llmsTxtMatches", () => {
  const fresh = "# Shop\n\n## Products\n- [A](https://x.test/products/a)\n";

  it("matches the file it just wrote (round-trip through the theme wrapper)", () => {
    expect(llmsTxtMatches(wrapLlmsTxtForTheme(fresh), fresh)).toBe(true);
  });

  it("reports a difference once the catalog changed", () => {
    const stored = wrapLlmsTxtForTheme(fresh);
    expect(llmsTxtMatches(stored, fresh + "- [B](https://x.test/products/b)\n")).toBe(false);
  });

  it("still matches when the content carries Liquid that gets defanged on write", () => {
    // The stored form is defanged, the fresh form is not — comparing them raw
    // would report "stale" forever and rewrite the theme file on every cycle.
    const liquidish = "# Shop {{ evil }}\n\n## Products\n- [A](https://x.test/products/a)\n";
    expect(llmsTxtMatches(wrapLlmsTxtForTheme(liquidish), liquidish)).toBe(true);
  });

  it("tolerates trailing-whitespace drift", () => {
    expect(llmsTxtMatches(wrapLlmsTxtForTheme(fresh), fresh + "\n\n")).toBe(true);
  });

  it("treats a file written before the wrapper existed as comparable", () => {
    expect(llmsTxtMatches(fresh, fresh)).toBe(true);
  });
});

describe("themeWritesEnabled", () => {
  const original = process.env.AEO_THEME_WRITES;
  afterEach(() => {
    if (original === undefined) delete process.env.AEO_THEME_WRITES;
    else process.env.AEO_THEME_WRITES = original;
  });

  it("defaults to off when unset — an unset variable must never write", () => {
    delete process.env.AEO_THEME_WRITES;
    expect(themeWritesEnabled()).toBe(false);
  });

  it.each(["on", "true", "1", "ON", " On "])("enables on %s", (v) => {
    process.env.AEO_THEME_WRITES = v;
    expect(themeWritesEnabled()).toBe(true);
  });

  it.each(["off", "false", "0", "", "yes"])("stays off on %s", (v) => {
    process.env.AEO_THEME_WRITES = v;
    expect(themeWritesEnabled()).toBe(false);
  });
});

describe("robots.txt override generation", () => {
  it("reproduces Shopify's defaults and drops only the listed paths", () => {
    const out = buildRobotsLiquid(["/lookbook", "/collections/archive"]);
    expect(out).toContain(ROBOTS_MANAGED_MARKER);
    // Iterating default_groups is what keeps every stock rule (and future
    // additions) intact — a hand-written rule list would freeze them.
    expect(out).toContain("robots.default_groups");
    expect(out).toContain("group.sitemap");
    expect(out).toContain("cp-removed: /lookbook");
    expect(out).toContain("cp-removed: /collections/archive");
    expect(out).toContain("cp_removed contains rule.value");
    // Only Disallow lines may be dropped.
    expect(out).toContain("rule.directive == 'Disallow'");
  });

  it("round-trips through parseManagedRobotsLiquid", () => {
    const paths = ["/lookbook", "/collections/archive"];
    expect(parseManagedRobotsLiquid(buildRobotsLiquid(paths))).toEqual(paths);
  });

  it("returns null for a file we didn't write, so it is never overwritten", () => {
    expect(parseManagedRobotsLiquid("User-agent: *\nDisallow: /secret\n")).toBeNull();
    expect(parseManagedRobotsLiquid(null)).toBeNull();
    expect(parseManagedRobotsLiquid("")).toBeNull();
  });

  it("drops unsafe paths instead of writing them into the Liquid", () => {
    const out = buildRobotsLiquid(['/ok', '/bad"quote', "/bad'quote", "/a~|~b", "/", "", "/x\ny"]);
    expect(parseManagedRobotsLiquid(out)).toEqual(["/ok"]);
  });

  it("de-duplicates", () => {
    expect(parseManagedRobotsLiquid(buildRobotsLiquid(["/a", "/a", " /a "]))).toEqual(["/a"]);
  });

  describe("isRemovableRobotsPath", () => {
    it.each(["/lookbook", "/collections/x", "*/collections/y"])("accepts %s", (p) => {
      expect(isRemovableRobotsPath(p)).toBe(true);
    });

    it("refuses `/` — unblocking a full block is a different decision", () => {
      expect(isRemovableRobotsPath("/")).toBe(false);
    });

    it.each(['/a"b', "/a'b", "/a~|~b", "/a\nb", "/a{b}", "relative", "", "/" + "x".repeat(300)])(
      "refuses %s",
      (p) => {
        expect(isRemovableRobotsPath(p)).toBe(false);
      },
    );
  });
});

describe("robotsLooksSane", () => {
  const before = "User-agent: *\nDisallow: /cart\nDisallow: /lookbook\n";

  it("accepts exactly the requested removal", () => {
    const after = "User-agent: *\nDisallow: /cart\n";
    expect(robotsLooksSane(before, after, ["/lookbook"])).toBe(true);
  });

  it("rejects an empty or unparseable result", () => {
    expect(robotsLooksSane(before, "", ["/lookbook"])).toBe(false);
  });

  it("rejects losing the wildcard record", () => {
    const after = "User-agent: GPTBot\nDisallow: /cart\n";
    expect(robotsLooksSane(before, after, ["/lookbook"])).toBe(false);
  });

  it("rejects a Disallow that appeared out of nowhere", () => {
    const after = "User-agent: *\nDisallow: /cart\nDisallow: /products\n";
    expect(robotsLooksSane(before, after, ["/lookbook"])).toBe(false);
  });

  it("rejects a removal nobody asked for", () => {
    const after = "User-agent: *\n";
    expect(robotsLooksSane(before, after, ["/lookbook"])).toBe(false);
  });

  // Review finding: the other checks all pass trivially when nothing changed,
  // so an unpropagated (or unrendered) robots.txt was reported as a successful
  // removal and the rollback never fired.
  it("rejects an unchanged robots.txt — the removal must have happened", () => {
    expect(robotsLooksSane(before, before, ["/lookbook"])).toBe(false);
  });

  it("rejects a partial removal", () => {
    const after = "User-agent: *\nDisallow: /lookbook\n";
    expect(robotsLooksSane(before, after, ["/cart", "/lookbook"])).toBe(false);
  });

  it("accepts a path that was already absent alongside a real removal", () => {
    // `/never-there` was never in the file, so it can't be "still present".
    const after = "User-agent: *\nDisallow: /cart\n";
    expect(robotsLooksSane(before, after, ["/lookbook", "/never-there"])).toBe(true);
  });
});

describe("parseRobotsAdviceResponse", () => {
  const known = new Set(["/lookbook", "/collections/archive"]);

  it("keeps only paths we asked about", () => {
    const raw = JSON.stringify([
      { path: "/lookbook", recommendation: "remove", reason: "Echte Inhalte." },
      { path: "/evil", recommendation: "remove", reason: "Nicht gefragt." },
    ]);
    expect(parseRobotsAdviceResponse(raw, known)).toEqual([
      { path: "/lookbook", recommendation: "remove", reason: "Echte Inhalte." },
    ]);
  });

  it("treats anything that isn't an explicit remove as keep", () => {
    const raw = JSON.stringify([
      { path: "/lookbook", recommendation: "REMOVE", reason: "x" },
      { path: "/collections/archive", reason: "y" },
    ]);
    expect(parseRobotsAdviceResponse(raw, known).map((a) => a.recommendation)).toEqual([
      "keep",
      "keep",
    ]);
  });

  it("survives code fences and surrounding prose", () => {
    const raw = 'Sure!\n```json\n[{"path":"/lookbook","recommendation":"remove","reason":"ok"}]\n```';
    expect(parseRobotsAdviceResponse(raw, known)).toHaveLength(1);
  });

  it("returns nothing for garbage instead of throwing", () => {
    expect(parseRobotsAdviceResponse("not json", known)).toEqual([]);
    expect(parseRobotsAdviceResponse('{"path":"/lookbook"}', known)).toEqual([]);
  });

  it("de-duplicates repeated paths", () => {
    const raw = JSON.stringify([
      { path: "/lookbook", recommendation: "remove", reason: "first" },
      { path: "/lookbook", recommendation: "keep", reason: "second" },
    ]);
    expect(parseRobotsAdviceResponse(raw, known)).toEqual([
      { path: "/lookbook", recommendation: "remove", reason: "first" },
    ]);
  });
});

describe("adviseableRules", () => {
  it("offers only the rules our classifier couldn't settle", () => {
    const groups = groupCrawlerStatuses(
      auditRobotsTxt(`${SHOPIFY_DEFAULT_ROBOTS}Disallow: /lookbook\nDisallow: /*_weird*\n`),
    );
    expect(adviseableRules(groups).map((r) => r.path).sort()).toEqual(["/*_weird*", "/lookbook"]);
  });

  it("is empty on a stock robots.txt", () => {
    expect(adviseableRules(groupCrawlerStatuses(auditRobotsTxt(SHOPIFY_DEFAULT_ROBOTS)))).toEqual([]);
  });

  it("never offers a full block as a prunable path", () => {
    const groups = groupCrawlerStatuses(auditRobotsTxt("User-agent: *\nDisallow: /\n"));
    expect(adviseableRules(groups)).toEqual([]);
  });
});

describe("groupCrawlerStatuses", () => {
  it("collapses crawlers that share a rule set into one group", () => {
    const groups = groupCrawlerStatuses(auditRobotsTxt(SHOPIFY_DEFAULT_ROBOTS));
    expect(groups).toHaveLength(1);
    expect(groups[0].crawlers.sort()).toEqual([...AI_CRAWLERS].sort());
    expect(groups[0].matchedBy).toBe("wildcard");
  });

  it("splits a crawler with its own rules and sorts the worst verdict first", () => {
    const txt = "User-agent: *\nDisallow: /cart\n\nUser-agent: GPTBot\nDisallow: /\n";
    const groups = groupCrawlerStatuses(auditRobotsTxt(txt));
    expect(groups).toHaveLength(2);
    expect(groups[0].verdict).toBe("blocked");
    expect(groups[0].crawlers).toEqual(["GPTBot"]);
    expect(groups[1].verdict).toBe("standard");
  });
});

describe("llms.txt {% raw %} wrapping (Liquid injection guard)", () => {
  it("wraps content in a {% raw %} / {% endraw %} block", () => {
    const wrapped = wrapLlmsTxtForTheme("# Shop\n\n- [A](https://x/products/a)\n");
    expect(wrapped.startsWith("{% raw %}\n")).toBe(true);
    expect(wrapped.trimEnd().endsWith("{% endraw %}")).toBe(true);
  });

  it("defangs Liquid openers in the content so nothing inside can parse as a tag", () => {
    const malicious = "- [{{ product.title }} {% if true %}oops{% endif %}](https://x/products/a)\n";
    const wrapped = wrapLlmsTxtForTheme(malicious);
    expect(wrapped.startsWith("{% raw %}\n")).toBe(true);
    expect(wrapped.trimEnd().endsWith("{% endraw %}")).toBe(true);
    // No Liquid opener from the CONTENT survives — only the wrapper's own
    // raw/endraw tags remain parseable.
    const body = unwrapLlmsTxtFromTheme(wrapped);
    expect(body).not.toContain("{{");
    expect(body).not.toContain("{%");
    // The defanged forms keep the text human/LLM-readable.
    expect(body).toContain("{ { product.title }}");
    expect(body).toContain("{ % if true %}");
  });

  it("a literal {% endraw %} in the content cannot terminate the raw block early (escape-proof)", () => {
    const breakout = "before {% endraw %}{{ 1 | plus: 1 }}{% raw %} after\n";
    const wrapped = wrapLlmsTxtForTheme(breakout);
    // Exactly ONE parseable endraw remains: the wrapper's own closing tag at
    // the very end. The content's copy was defanged to "{ % endraw % }".
    const parseableEndraws = wrapped.match(/\{%\s*endraw\s*%\}/g) ?? [];
    expect(parseableEndraws).toHaveLength(1);
    expect(wrapped.trimEnd().endsWith("{% endraw %}")).toBe(true);
    expect(wrapped).not.toContain("{{ 1 | plus: 1 }}");
  });

  it("unwrap is a no-op on content that was never wrapped (pre-existing assets)", () => {
    const plain = "# Shop\n\n- [A](https://x/products/a)\n";
    expect(unwrapLlmsTxtFromTheme(plain)).toBe(plain);
  });
});

describe("buildAgentsMd", () => {
  const base = {
    shopName: "Acme",
    domain: "shop.com",
    description: "We sell great things",
    products: [{ title: "Blue Shoe", handle: "blue-shoe", description: "Comfy shoe" }],
    collections: [{ title: "Footwear", handle: "footwear" }],
    policies: [{ title: "Refund policy", url: "https://shop.com/policies/refund-policy" }],
  };

  it("renders summary, collections, products, policies and the agent notes", () => {
    const out = buildAgentsMd(base);
    expect(out).toContain("# Acme");
    expect(out).toContain("> We sell great things");
    expect(out).toContain("## Collections");
    expect(out).toContain("- [Footwear](https://shop.com/collections/footwear)");
    expect(out).toContain("- [Blue Shoe](https://shop.com/products/blue-shoe): Comfy shoe");
    expect(out).toContain("## Policies");
    expect(out).toContain("- [Refund policy](https://shop.com/policies/refund-policy)");
    expect(out).toContain("## Notes for agents");
    expect(out).toContain("https://shop.com/sitemap.xml");
    expect(out.endsWith("\n")).toBe(true);
  });

  it("puts collections before products — an agent orients by category first", () => {
    const out = buildAgentsMd(base);
    expect(out.indexOf("## Collections")).toBeLessThan(out.indexOf("## Products"));
  });

  it("omits empty sections rather than printing bare headings", () => {
    const out = buildAgentsMd({ ...base, collections: [], policies: [], products: [] });
    expect(out).not.toContain("## Collections");
    expect(out).not.toContain("## Products");
    expect(out).not.toContain("## Policies");
    // The agent notes always stay: they are what makes the file safe to act on.
    expect(out).toContain("## Notes for agents");
  });

  it("escapes Markdown special characters in titles, like the llms.txt builder", () => {
    const out = buildAgentsMd({
      ...base,
      products: [{ title: "Shoe [Red]\nNEW", handle: "shoe" }],
    });
    expect(out).toContain("- [Shoe \\[Red\\] NEW](https://shop.com/products/shoe)");
  });

  it("is defanged and unwrappable through the same theme wrapper as llms.txt", () => {
    const out = buildAgentsMd({
      ...base,
      products: [{ title: "{{ product.title }}", handle: "p" }],
    });
    const wrapped = wrapLlmsTxtForTheme(out);
    expect(wrapped).toContain("{ { product.title }}");
    expect(llmsTxtMatches(wrapped, out)).toBe(true);
  });

  it("differs from the llms.txt built from the same catalog (not one file twice)", () => {
    expect(buildAgentsMd(base)).not.toBe(buildLlmsTxt(base));
  });
});

describe("policyPath", () => {
  it("turns a policy type into its storefront path", () => {
    expect(policyPath("REFUND_POLICY")).toBe("/policies/refund-policy");
    expect(policyPath("TERMS_OF_SERVICE")).toBe("/policies/terms-of-service");
  });

  it("tolerates the lowercase and padded forms a cache row can hold", () => {
    expect(policyPath(" shipping_policy ")).toBe("/policies/shipping-policy");
  });
});

describe("AI_DISCOVERY_TEMPLATES / AI_DISCOVERY_PATHS", () => {
  it("maps each file to its theme template and its public path", () => {
    expect(AI_DISCOVERY_TEMPLATES.agents).toBe("templates/agents.md.liquid");
    expect(AI_DISCOVERY_TEMPLATES.llms).toBe("templates/llms.txt.liquid");
    expect(AI_DISCOVERY_PATHS.agents).toBe("/agents.md");
    expect(AI_DISCOVERY_PATHS.llms).toBe("/llms.txt");
  });
});
