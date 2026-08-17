/**
 * Plan-card highlighting: each Settings → Plan card bolds what it adds over the
 * tier below it. These tests pin the RULE (new row, or changed value) against
 * the real PLAN_CONFIG, so a re-tiered limit shows up here rather than as a
 * silently stale bold in the UI.
 */

import { describe, it, expect } from "vitest";
import { PLAN_CONFIG, type Plan } from "../../app/config/plans";
import { contentTypeLimit, getPlanCardHighlights } from "../../app/utils/planDiff";
import { getPreviousPlanTier } from "../../app/utils/planUtils";

describe("getPreviousPlanTier", () => {
  it("walks one tier down and stops at the lowest", () => {
    expect(getPreviousPlanTier("max")).toBe("pro");
    expect(getPreviousPlanTier("pro")).toBe("basic");
    expect(getPreviousPlanTier("basic")).toBe("free");
    expect(getPreviousPlanTier("free")).toBeNull();
  });

  it("returns null for an unknown plan string", () => {
    expect(getPreviousPlanTier("enterprise" as Plan)).toBeNull();
  });
});

describe("getPlanCardHighlights", () => {
  it("highlights nothing on the lowest tier — there is no card below it", () => {
    const { rows, contentTypes, previousPlan, webpFasterThanPrevious } =
      getPlanCardHighlights("free");
    expect(previousPlan).toBeNull();
    expect(Object.values(rows).some(Boolean)).toBe(false);
    expect(contentTypes.size).toBe(0);
    expect(webpFasterThanPrevious).toBe(false);
  });

  it("never highlights a row whose value is identical to the tier below", () => {
    // Locales are uncapped on every tier by design (BYO AI tokens), so this row
    // must stay unbolded everywhere — it is the canary for the compare rule
    // degenerating into "bold everything on paid tiers".
    for (const plan of ["basic", "pro", "max"] as Plan[]) {
      expect(getPlanCardHighlights(plan).rows.locales).toBe(false);
    }
  });

  it("highlights a row that appears for the first time", () => {
    // Keyword tracking starts on Basic, the image suite and the Search Console
    // / history / IndexNow block on Pro, the nightly audit on Max.
    expect(getPlanCardHighlights("basic").rows.seoKeywords).toBe(true);
    expect(getPlanCardHighlights("pro").rows.webpConversion).toBe(true);
    expect(getPlanCardHighlights("pro").rows.imageOperations).toBe(true);
    expect(getPlanCardHighlights("pro").rows.imageTools).toBe(true);
    expect(getPlanCardHighlights("pro").rows.seoSearchConsole).toBe(true);
    expect(getPlanCardHighlights("pro").rows.seoScoreHistory).toBe(true);
    expect(getPlanCardHighlights("pro").rows.seoIndexNow).toBe(true);
    expect(getPlanCardHighlights("max").rows.seoScheduledAudit).toBe(true);
  });

  it("highlights a row that only changed its number", () => {
    // Bulk batch size moves on every tier; the Pro→Max image quota and GSC
    // window move too, while the image TOOLS list is identical on both.
    expect(getPlanCardHighlights("basic").rows.seoBulkBatch).toBe(true);
    expect(getPlanCardHighlights("pro").rows.seoBulkBatch).toBe(true);
    expect(getPlanCardHighlights("max").rows.seoBulkBatch).toBe(true);
    expect(getPlanCardHighlights("max").rows.imageOperations).toBe(true);
    expect(getPlanCardHighlights("max").rows.seoSearchConsole).toBe(true);
    expect(getPlanCardHighlights("max").rows.imageTools).toBe(false);
  });

  it("highlights the images row exactly where the scope changes", () => {
    expect(getPlanCardHighlights("basic").rows.images).toBe(true); // featured-only → all
    expect(getPlanCardHighlights("pro").rows.images).toBe(false);
    expect(getPlanCardHighlights("max").rows.images).toBe(false);
  });

  it("claims '2× faster' WebP only where the number actually went up", () => {
    // Pro unlocks the row at Basic's concurrency: new, but not faster.
    expect(getPlanCardHighlights("pro").webpFasterThanPrevious).toBe(false);
    expect(getPlanCardHighlights("max").webpFasterThanPrevious).toBe(true);
  });

  it("highlights content types that are new on the tier", () => {
    const basic = getPlanCardHighlights("basic").contentTypes;
    expect(basic.has("pages")).toBe(true);
    expect(basic.has("policies")).toBe(true);
    // Present on Free with the same (absent) limit → not a difference.
    expect(basic.has("onlineStoreExtras")).toBe(false);

    const max = getPlanCardHighlights("max").contentTypes;
    expect(max.has("directTranslations")).toBe(true);
    expect(max.has("blogs")).toBe(false);
    expect(max.has("menus")).toBe(false);
  });

  it("highlights content types whose limit changed even though the type stays", () => {
    for (const plan of ["basic", "pro", "max"] as Plan[]) {
      const highlighted = getPlanCardHighlights(plan).contentTypes;
      expect(highlighted.has("products")).toBe(true);
      expect(highlighted.has("collections")).toBe(true);
    }
    expect(getPlanCardHighlights("max").contentTypes.has("templates")).toBe(true); // 50k → 100k
  });

  it("only ever highlights types the tier actually lists", () => {
    for (const plan of ["free", "basic", "pro", "max"] as Plan[]) {
      for (const type of getPlanCardHighlights(plan).contentTypes) {
        expect(PLAN_CONFIG[plan].contentTypes).toContain(type);
      }
    }
  });
});

describe("contentTypeLimit", () => {
  it("returns the number the card prints, and null for the types without one", () => {
    expect(contentTypeLimit(PLAN_CONFIG.pro, "products")).toBe(PLAN_CONFIG.pro.maxProducts);
    expect(contentTypeLimit(PLAN_CONFIG.pro, "collections")).toBe(PLAN_CONFIG.pro.maxCollections);
    expect(contentTypeLimit(PLAN_CONFIG.pro, "articles")).toBe(PLAN_CONFIG.pro.maxArticles);
    expect(contentTypeLimit(PLAN_CONFIG.pro, "pages")).toBe(PLAN_CONFIG.pro.maxPages);
    expect(contentTypeLimit(PLAN_CONFIG.pro, "templates")).toBe(
      PLAN_CONFIG.pro.maxThemeTranslations,
    );
    expect(contentTypeLimit(PLAN_CONFIG.pro, "menus")).toBeNull();
    expect(contentTypeLimit(PLAN_CONFIG.pro, "blogs")).toBeNull();
  });
});
