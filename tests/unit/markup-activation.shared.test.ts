import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  activationGate,
  activationTone,
  statForSwitch,
  worstActivationVerdict,
  JSON_LD_SWITCHES,
  type MarkupTypeStat,
} from "~/services/seo/markup-activation.shared";

/**
 * PLAN_MARKUP_ACTIVATION §1.2 — the gate that keeps a merchant from switching
 * on a type their theme already serves. The four rows of the plan's table plus
 * the two states that are easy to get wrong: "the crawl could not tell whose
 * copy that is" and "several per page are normal here".
 */

const stat = (over: Partial<MarkupTypeStat> = {}): MarkupTypeStat => ({
  type: "Product",
  resourceType: "product",
  pages: 0,
  appPages: 0,
  duplicatePages: 0,
  appIsOneCopy: 0,
  repeatable: false,
  ...over,
});

const measured = { measured: true, originKnown: true };

describe("activationGate", () => {
  it("never returns a green light without a measurement", () => {
    // Even a stat that would read as "free" must stay unknown — the whole
    // point of the flag is that a missing crawl is not evidence.
    for (const originKnown of [true, false]) {
      const g = activationGate(stat({ pages: 0 }), { measured: false, originKnown });
      expect(g.verdict).toBe("unknown");
      expect(g.pages).toBe(0);
    }
  });

  it("treats a type nobody serves as safe to switch on", () => {
    expect(activationGate(stat({ pages: 0 }), measured).verdict).toBe("free");
    // A type absent from the stat list at all is the same state, not a crash.
    expect(activationGate(undefined, measured).verdict).toBe("free");
  });

  it("warns when only the theme serves the type", () => {
    const g = activationGate(stat({ pages: 12, appPages: 0 }), measured);
    expect(g.verdict).toBe("foreignOnly");
    expect(g.pages).toBe(12);
  });

  it("reports the intended end state when every copy is ours", () => {
    expect(activationGate(stat({ pages: 12, appPages: 12 }), measured).verdict).toBe("appOnly");
  });

  it("reports a split delivery as mixed rather than clean", () => {
    expect(activationGate(stat({ pages: 12, appPages: 5 }), measured).verdict).toBe("mixed");
  });

  it("offers the actionable fix only where one copy is actually ours", () => {
    const ours = activationGate(
      stat({ pages: 12, appPages: 12, duplicatePages: 12, appIsOneCopy: 12 }),
      measured,
    );
    expect(ours.verdict).toBe("duplicateApp");
    expect(ours.appIsOneCopy).toBe(12);

    // Theme + another app: turning OUR switch off would be the wrong advice.
    const theirs = activationGate(
      stat({ pages: 12, appPages: 0, duplicatePages: 12, appIsOneCopy: 0 }),
      measured,
    );
    expect(theirs.verdict).toBe("duplicateForeign");
  });

  it("does not claim a copy is not ours when the crawl could not tell", () => {
    // A snapshot predating the data-contentpilot marker reports appPages: 0 for
    // everything, which is indistinguishable from "the embed is off".
    const unknownOrigin = { measured: true, originKnown: false };
    expect(activationGate(stat({ pages: 12 }), unknownOrigin).verdict).toBe("originUnknown");
    expect(
      activationGate(stat({ pages: 12, duplicatePages: 3 }), unknownOrigin).verdict,
    ).toBe("originUnknown");
    // …but a marker on THIS type still resolves it, marker-blind crawl or not.
    expect(
      activationGate(
        stat({ pages: 12, appPages: 12, duplicatePages: 3, appIsOneCopy: 3 }),
        unknownOrigin,
      ).verdict,
    ).toBe("duplicateApp");
  });

  it("refuses to judge a repeatable type it co-delivers", () => {
    // Three product videos are three VideoObjects, so the duplicate rule is off
    // — `appPages === pages` proves we are on every page, never that we are the
    // only source. Claiming "appOnly" there would be a verified-looking guess.
    const g = activationGate(
      stat({ type: "VideoObject", pages: 4, appPages: 4, repeatable: true }),
      measured,
    );
    expect(g.verdict).toBe("repeatableUnjudged");
    expect(g.repeatable).toBe(true);

    // Nobody serving it is still plainly free, repeatable or not.
    expect(
      activationGate(stat({ type: "VideoObject", pages: 0, repeatable: true }), measured).verdict,
    ).toBe("free");
    // And "only the theme" is still concludable.
    expect(
      activationGate(
        stat({ type: "VideoObject", pages: 4, appPages: 0, repeatable: true }),
        measured,
      ).verdict,
    ).toBe("foreignOnly");
  });
});

describe("activationTone", () => {
  it("leaves the unmeasured verdict without a tone", () => {
    expect(activationTone("unknown")).toBeUndefined();
  });
  it("marks both duplicate verdicts critical", () => {
    expect(activationTone("duplicateApp")).toBe("critical");
    expect(activationTone("duplicateForeign")).toBe("critical");
  });
});

describe("JSON_LD_SWITCHES", () => {
  it("matches the switches the storefront block actually has", () => {
    expect(JSON_LD_SWITCHES.map((s) => s.settingId)).toEqual([
      "enable_organization",
      "enable_product",
      "enable_collection",
      "enable_article",
      "enable_breadcrumb",
      "enable_video",
      "enable_faq",
    ]);
  });

  it("uses the CANONICAL type for articles", () => {
    // The block emits BlogPosting and Dawn emits Article; canonicalJsonLdType
    // folds the two, and the stats are keyed by the folded name — matching on
    // "BlogPosting" would walk straight past the collision.
    expect(JSON_LD_SWITCHES.find((s) => s.settingId === "enable_article")?.type).toBe("Article");
  });

  it("is the only switch shipped off", () => {
    expect(JSON_LD_SWITCHES.filter((s) => !s.defaultOn).map((s) => s.settingId)).toEqual([
      "enable_faq",
    ]);
  });

  it("scopes every page-guarded switch to the pages its block emits on", () => {
    // Mirrors the `request.page_type` guards in structured-data.liquid. Only
    // Organization has none.
    const scopeOf = (id: string) => JSON_LD_SWITCHES.find((s) => s.settingId === id)!.scopes;
    expect(scopeOf("enable_organization")).toBeNull();
    expect(scopeOf("enable_product")).toEqual(["product"]);
    expect(scopeOf("enable_faq")).toEqual(["product"]);
    expect(scopeOf("enable_breadcrumb")).toEqual(["product", "collection", "article"]);
  });
});

describe("statForSwitch", () => {
  const s = (over: Partial<MarkupTypeStat>): MarkupTypeStat => stat(over);

  it("ignores buckets outside the switch's scope", () => {
    // The FAQ case: our block emits FAQPage on PRODUCT pages only, so a theme's
    // FAQPage on /pages/faq is not a collision. Judging shop-wide told the
    // merchant "your theme already serves this, leave the switch off" about two
    // markups that never meet.
    const stats = [
      s({ type: "FAQPage", resourceType: "page", pages: 1 }),
      s({ type: "FAQPage", resourceType: "product", pages: 0 }),
    ];
    expect(statForSwitch(stats, "FAQPage", ["product"])!.pages).toBe(0);
    // …and shop-wide (scopes: null) still sees it.
    expect(statForSwitch(stats, "FAQPage", null)!.pages).toBe(1);
  });

  it("sums the buckets a multi-scope switch emits on", () => {
    const stats = [
      s({ type: "BreadcrumbList", resourceType: "product", pages: 10, appPages: 10 }),
      s({ type: "BreadcrumbList", resourceType: "collection", pages: 3, appPages: 1, duplicatePages: 2, appIsOneCopy: 1 }),
      // Not in scope — our block emits no breadcrumb on a policy page.
      s({ type: "BreadcrumbList", resourceType: "policy", pages: 4 }),
    ];
    const sum = statForSwitch(stats, "BreadcrumbList", ["product", "collection", "article"])!;
    expect(sum.pages).toBe(13);
    expect(sum.appPages).toBe(11);
    expect(sum.duplicatePages).toBe(2);
    expect(sum.appIsOneCopy).toBe(1);
  });

  it("returns undefined when nothing matches, which the gate reads as 'free'", () => {
    expect(statForSwitch([], "Product", ["product"])).toBeUndefined();
    expect(statForSwitch(undefined, "Product", ["product"])).toBeUndefined();
    expect(
      activationGate(statForSwitch([], "Product", ["product"]), measured).verdict,
    ).toBe("free");
  });
});

describe("verdict severity", () => {
  it("does not let an unresolvable origin read as milder than a real warning", () => {
    // With the embed OFF no page can carry the marker, so `originUnknown` is
    // the PERMANENT state of exactly the merchant this section exists for:
    // theme serving the type, about to tick the box. Ranking it below `unknown`
    // (as the first cut did) put an `info` badge on the one screen that has to
    // say "stop".
    expect(worstActivationVerdict(["free", "originUnknown"])).toBe("originUnknown");
    expect(worstActivationVerdict(["unknown", "originUnknown"])).toBe("originUnknown");
    expect(activationTone("originUnknown")).toBe("warning");
    // A real duplicate still outranks it.
    expect(worstActivationVerdict(["originUnknown", "duplicateApp"])).toBe("duplicateApp");
  });

  it("keeps the repeatable non-verdict mild — there is nothing to act on", () => {
    expect(worstActivationVerdict(["repeatableUnjudged", "unknown"])).toBe("unknown");
    expect(activationTone("repeatableUnjudged")).toBe("info");
  });
});

describe("client-safety of the shared module", () => {
  // The activation section renders APP_SOCIAL_TAGS and JSON_LD_SWITCHES in
  // COMPONENT scope. Importing either from the audit services drags those — and
  // through them crawl-markup-rows.server.ts — into the client bundle, which
  // the build refuses with "Server-only module referenced by client". It broke
  // exactly that way once; typecheck and vitest both stayed green, so the rule
  // is pinned here rather than left to the next `npm run build`.
  const shared = readFileSync(
    join(__dirname, "../../app/services/seo/markup-activation.shared.ts"),
    "utf8",
  );

  it("imports nothing at all — the values the UI needs must reach it unencumbered", () => {
    expect(shared).not.toMatch(/^\s*import\s/m);
  });

  it("owns the two lists the section renders in component scope", () => {
    expect(shared).toContain("export const APP_SOCIAL_TAGS");
    expect(shared).toContain("export const JSON_LD_SWITCHES");
  });

  it("keeps the route off the audit services for anything but the loader", () => {
    const route = readFileSync(
      join(__dirname, "../../app/routes/app.seo.structured-data.tsx"),
      "utf8",
    );
    // The only runtime imports from either audit service are the two summarize
    // functions, which the loader calls; everything else is a type (erased) or
    // comes from the shared module.
    expect(route).toContain(
      'import { summarizeLiveSocial } from "../services/seo/social-audit.service"',
    );
    expect(route).not.toMatch(/APP_SOCIAL_TAGS[^\n]*social-audit\.service/);
  });
});
