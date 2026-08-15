import { describe, it, expect, vi } from "vitest";
import {
  findStuffedKeyword,
  isKeywordAwareField,
  keywordPreservationLine,
  keywordRequirementLines,
  loadTrackedKeywords,
  loadTrackedKeywordsUnfiltered,
  resolveKeywordLocale,
  stuffingRetryWarning,
} from "~/routes/api-ai-handlers/keyword-prompt";

/**
 * The keywords→AI bridge (PLAN_KEYWORDS_EXPANSION.md §2.2/§3.2). The locale
 * contract is the part worth pinning: before this module the lookup hardcoded
 * "" (primary), so generating French copy injected the German keyword.
 */

/** Minimal PrismaClient stub — only seoKeywordAssignment.findMany is reached. */
function dbWith(rows: any[]) {
  const findMany = vi.fn().mockResolvedValue(rows);
  return { db: { seoKeywordAssignment: { findMany } } as any, findMany };
}

/** Shaped like the `include: { keyword: true }` row `toRow` maps — note that
 *  `intent` and `priority` hang off the KEYWORD, not the assignment. */
function assignment(
  keyword: string,
  role: "primary" | "secondary",
  keywordExtra: Record<string, unknown> = {},
) {
  return {
    id: `a-${keyword}`,
    resourceType: "Product",
    resourceId: "gid://shopify/Product/1",
    role,
    gscPosition: null,
    gscClicks: null,
    gscImpressions: null,
    gscCtr: null,
    keyword: {
      id: `k-${keyword}`,
      keyword,
      locale: "",
      priority: 2,
      intent: null,
      updatedAt: new Date(0),
      ...keywordExtra,
    },
  };
}

describe("resolveKeywordLocale", () => {
  it("defaults to the primary locale when the client sends nothing", () => {
    expect(resolveKeywordLocale(new FormData())).toBe("");
  });

  it("passes a secondary locale through", () => {
    const fd = new FormData();
    fd.set("keywordLocale", "fr");
    expect(resolveKeywordLocale(fd)).toBe("fr");
  });
});

describe("isKeywordAwareField", () => {
  it("covers the content fields a keyword can land in", () => {
    for (const f of ["title", "seoTitle", "metaDescription", "description", "body", "handle"]) {
      expect(isKeywordAwareField(f)).toBe(true);
    }
  });

  it("excludes unrelated field keys", () => {
    expect(isKeywordAwareField("vendor")).toBe(false);
    expect(isKeywordAwareField("")).toBe(false);
  });
});

describe("loadTrackedKeywords", () => {
  it("queries the locale it is given, not the primary one", async () => {
    const { db, findMany } = dbWith([]);
    await loadTrackedKeywords(db, "s.myshopify.com", "gid://shopify/Product/1", "fr", "title");
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0][0].where).toMatchObject({
      shop: "s.myshopify.com",
      resourceId: "gid://shopify/Product/1",
      keyword: { locale: "fr" },
    });
  });

  it("skips the query entirely for a field that takes no keywords", async () => {
    const { db, findMany } = dbWith([assignment("blue shoes", "primary")]);
    const kw = await loadTrackedKeywords(db, "s", "gid://shopify/Product/1", "", "vendor");
    expect(findMany).not.toHaveBeenCalled();
    expect(kw.all).toEqual([]);
  });

  it("skips the query when there is no resource id", async () => {
    const { db, findMany } = dbWith([assignment("blue shoes", "primary")]);
    const kw = await loadTrackedKeywords(db, "s", "", "", "title");
    expect(findMany).not.toHaveBeenCalled();
    expect(kw.primary).toBeNull();
  });

  it("splits roles and exposes the primary intent", async () => {
    const { db } = dbWith([
      assignment("blue shoes", "primary", { intent: "transactional" }),
      assignment("running shoes", "secondary"),
      assignment("sneakers", "secondary"),
    ]);
    const kw = await loadTrackedKeywordsUnfiltered(db, "s", "gid://shopify/Product/1", "");
    expect(kw.primary).toBe("blue shoes");
    expect(kw.secondaries).toEqual(["running shoes", "sneakers"]);
    expect(kw.primaryIntent).toBe("transactional");
    expect(kw.all).toEqual(["blue shoes", "running shoes", "sneakers"]);
  });

  it("returns the empty set when the item tracks nothing", async () => {
    const { db } = dbWith([]);
    const kw = await loadTrackedKeywordsUnfiltered(db, "s", "gid://shopify/Product/1", "");
    expect(kw).toEqual({ primary: null, secondaries: [], primaryIntent: null, all: [] });
  });
});

describe("keywordRequirementLines", () => {
  const kw = {
    primary: "blue shoes",
    secondaries: ["running shoes"],
    primaryIntent: "transactional",
    all: ["blue shoes", "running shoes"],
  };

  it("asks for the primary, offers the secondaries and adds the intent hint", () => {
    const out = keywordRequirementLines(kw);
    expect(out).toContain('target keyword "blue shoes"');
    expect(out).toContain('"running shoes"');
    expect(out).toContain("transactional");
  });

  it("phrases slugs differently and drops the secondaries", () => {
    const out = keywordRequirementLines(kw, true);
    expect(out).toContain("slug around the target keyword");
    expect(out).not.toContain('"running shoes"');
  });

  it("keeps the prose intent hint out of a slug prompt", () => {
    // The output is restricted to a-z0-9- — "emphasize purchase, benefit,
    // availability" is nothing a slug can act on.
    expect(keywordRequirementLines(kw, true)).not.toContain("Search intent");
    expect(keywordRequirementLines(kw, false)).toContain("Search intent");
  });

  it("is empty when nothing is tracked, so callers can append blindly", () => {
    expect(
      keywordRequirementLines({ primary: null, secondaries: [], primaryIntent: null, all: [] }),
    ).toBe("");
  });

  it("omits the intent hint for an unclassified keyword", () => {
    const out = keywordRequirementLines({ ...kw, primaryIntent: null });
    expect(out).not.toContain("Search intent");
  });
});

describe("keywordPreservationLine", () => {
  const kw = {
    primary: "blue shoes",
    secondaries: ["sneakers"],
    primaryIntent: null,
    all: ["blue shoes", "sneakers"],
  };

  it("defaults to keep — never add — the tracked keywords", () => {
    const out = keywordPreservationLine(kw);
    expect(out).toContain('"blue shoes"');
    expect(out).toContain('"sneakers"');
    expect(out).toContain("Do NOT add keywords");
  });

  it("lets the field-level format pass work a MISSING primary in", () => {
    const out = keywordPreservationLine(kw, { mayAddPrimary: true });
    expect(out).toContain('If the target keyword "blue shoes" does not appear');
    expect(out).toContain("work it in ONCE");
    expect(out).not.toContain("Do NOT add keywords");
  });

  it("never offers the secondaries for insertion, even with mayAddPrimary", () => {
    const out = keywordPreservationLine(kw, { mayAddPrimary: true });
    expect(out).toContain("Do not add any of the other keywords");
  });

  it("falls back to preserve-only when there is no primary to add", () => {
    const out = keywordPreservationLine(
      { primary: null, secondaries: ["sneakers"], primaryIntent: null, all: ["sneakers"] },
      { mayAddPrimary: true },
    );
    expect(out).toContain("Do NOT add keywords");
    expect(out).not.toContain("work it in ONCE");
  });

  it("is empty when nothing is tracked", () => {
    const empty = { primary: null, secondaries: [], primaryIntent: null, all: [] };
    expect(keywordPreservationLine(empty)).toBe("");
    expect(keywordPreservationLine(empty, { mayAddPrimary: true })).toBe("");
  });
});

describe("findStuffedKeyword", () => {
  it("flags a repeated keyword in a short field", () => {
    expect(findStuffedKeyword("Blue shoes — the best blue shoes", ["blue shoes"], false)).toBe(
      "blue shoes",
    );
  });

  it("accepts a single mention in a short field", () => {
    expect(findStuffedKeyword("Blue shoes for everyday wear", ["blue shoes"], false)).toBeNull();
  });

  it("uses a density threshold for long content instead of an occurrence count", () => {
    // Two mentions of a 2-word keyword in ~300 words is ~1.3 % — fine for long
    // content, but would trip the short-field rule.
    const body = `<p>blue shoes ${"filler ".repeat(300)} blue shoes</p>`;
    expect(findStuffedKeyword(body, ["blue shoes"], true)).toBeNull();
    expect(findStuffedKeyword(body, ["blue shoes"], false)).toBe("blue shoes");
  });

  it("returns null for an empty keyword set", () => {
    expect(findStuffedKeyword("anything", [], false)).toBeNull();
  });
});

describe("stuffingRetryWarning", () => {
  it("asks for lower density on long content and a single mention on short fields", () => {
    expect(stuffingRetryWarning("blue shoes", true)).toContain("lower keyword density");
    expect(stuffingRetryWarning("blue shoes", false)).toContain("at most once");
  });
});
