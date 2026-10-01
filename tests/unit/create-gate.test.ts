/**
 * PLAN_CONTENT_CREATION §7 (Phase 1) — the two-stage plan gate.
 *
 * The property under test is not "does it refuse" but WHICH refusal it gives.
 * `plans.ts` has two genuinely different locks and the merchant's remedy
 * differs: a missing content TYPE needs an upgrade, a reached QUANTITY needs
 * headroom or a deletion. Showing "limit reached" to someone whose plan simply
 * lacks the type sends them hunting for items to delete that would not help —
 * which is the entire reason these are not one boolean (§1.2).
 */

import { describe, it, expect } from "vitest";
import { evaluateCreateGate, evaluateCreateGates, gateTooltipKey } from "~/utils/create-gate";

describe("evaluateCreateGate", () => {
  it("allows what the plan covers", () => {
    expect(evaluateCreateGate("max", "product", 3)).toEqual({ allowed: true });
    expect(evaluateCreateGate("free", "product", 0)).toEqual({ allowed: true });
  });

  it("refuses a content type the plan does not include — with THAT reason", () => {
    // Free has no pages, Basic no articles (plans.ts). The message is
    // "your plan does not include this", never "limit reached".
    const page = evaluateCreateGate("free", "page", 0);
    expect(page).toMatchObject({ allowed: false, reason: "planContentType" });

    const article = evaluateCreateGate("basic", "article", 0);
    expect(article).toMatchObject({ allowed: false, reason: "planContentType" });
  });

  it("refuses a reached quantity limit — with the OTHER reason", () => {
    const gate = evaluateCreateGate("free", "product", 100_000);
    expect(gate).toMatchObject({ allowed: false, reason: "planLimit", limitResource: "products" });
  });

  it("does NOT refuse when the count is unknown", () => {
    // An unknown count is not evidence of being at the limit, and the server
    // checks anyway. Same rule as attributesSyncedAt: absence is not a
    // negative — refusing here would block creation on a slow loader.
    expect(evaluateCreateGate("free", "product", undefined)).toEqual({ allowed: true });
  });

  it("gives the two refusals DIFFERENT tooltip keys", () => {
    const typeGate = evaluateCreateGate("free", "page", 0);
    const limitGate = evaluateCreateGate("free", "product", 100_000);
    expect(gateTooltipKey(typeGate)).not.toBe(gateTooltipKey(limitGate));
    expect(gateTooltipKey({ allowed: true })).toBeNull();
  });

  it("reports an unknown resource rather than pretending it is allowed", () => {
    expect(evaluateCreateGate("max", "policy" as never, 0)).toEqual({ allowed: false, reason: "unknownResource" });
  });
});

describe("evaluateCreateGates", () => {
  it("keeps a tab open while ANY of its resources is allowed", () => {
    // The blogs tab offers an article AND the blog it lives in. A shop that has
    // used up its article quota must still be able to create a BLOG — blogs
    // have no quota of their own, and the blog is exactly what a merchant needs
    // before the next article can exist at all.
    //
    // (An earlier version of this test assumed Basic has blogs but not
    // articles. It does not — Basic has neither — and the test caught that the
    // premise, not the code, was wrong.)
    const result = evaluateCreateGates("pro", ["article", "blog"], { articles: 100 });
    expect(result.anyAllowed).toBe(true);

    const article = result.byResource.find((r) => r.resource === "article")!;
    const blog = result.byResource.find((r) => r.resource === "blog")!;
    expect(article.gate).toMatchObject({ allowed: false, reason: "planLimit" });
    expect(blog.gate.allowed).toBe(true);
  });

  it("refuses BOTH blog resources on a plan that has neither", () => {
    // Free and Basic have no "articles" and no "blogs" content type at all, so
    // the whole tab is out — a different situation from a used-up quota.
    for (const plan of ["free", "basic"] as const) {
      const result = evaluateCreateGates(plan, ["article", "blog"], {});
      expect(result.anyAllowed).toBe(false);
      for (const { gate } of result.byResource) {
        expect(gate).toMatchObject({ allowed: false, reason: "planContentType" });
      }
    }
  });

  it("closes the tab only when every resource is refused", () => {
    const result = evaluateCreateGates("free", ["page"], { pages: 0 });
    expect(result.anyAllowed).toBe(false);
  });

  it("reports one verdict per requested resource", () => {
    const result = evaluateCreateGates("max", ["article", "blog"], {});
    expect(result.byResource.map((r) => r.resource)).toEqual(["article", "blog"]);
  });
});
