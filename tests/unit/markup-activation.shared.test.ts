import { describe, it, expect } from "vitest";
import {
  activationGate,
  activationTone,
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
});
