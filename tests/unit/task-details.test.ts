/**
 * PLAN_TASK_LIST_CLARITY §3.2 — turning a persisted `Task.result` into lines.
 *
 * Every runner in this app already writes a structured result blob and none of
 * it was ever shown; for `seoBulkMeta` and `bulkEditorTranslate` the per-cell
 * failure list in there is the ONLY record of what went wrong anywhere. The
 * rules under test each have a failure mode behind them:
 *
 *  1. **Per type, never a JSON dump.** `imageWebpConversion` and `pageSpeed`
 *     store the job INPUT, not an outcome, so they are absent from the registry
 *     on purpose — a generic renderer would show a merchant an internal job
 *     spec.
 *  2. **An absent key is omitted, never rendered as 0** — the
 *     `attributesSyncedAt` rule. A fabricated 0 is a wrong number, and
 *     `galleryVideos` is the named three-valued case.
 *  3. **Never throws.** These rows can only be deleted from the page that would
 *     otherwise fail to render them.
 */

import { describe, it, expect } from "vitest";
import {
  summariseTaskResult,
  hasTaskDetails,
  type TaskResultSummary,
} from "~/services/tasks/task-details.shared";

const json = (blob: unknown) => JSON.stringify(blob);

/** The labelKeys a summary emitted, in order. */
const keys = (summary: TaskResultSummary | null) => (summary?.lines ?? []).map((l) => l.labelKey);

/** The value stored under one labelKey, or `undefined` when the line is absent. */
const valueOf = (summary: TaskResultSummary | null, labelKey: string) =>
  summary?.lines.find((l) => l.labelKey === labelKey)?.value;

// ── 1. malformed input ──────────────────────────────────────────────────────

describe("summariseTaskResult — malformed input", () => {
  const BAD: (string | null | undefined)[] = [
    null,
    undefined,
    "",
    "   ",
    "not json",
    "[]", // valid JSON, but not an object
    "[1,2,3]",
    "123",
    '"a string"',
    "null",
    '{"pagesCrawled": 4, "pagesOk":', // truncated blob
  ];

  it("returns null and never throws", () => {
    for (const bad of BAD) {
      expect(() => summariseTaskResult("seoCrawl", bad)).not.toThrow();
      expect(summariseTaskResult("seoCrawl", bad)).toBeNull();
    }
  });

  it("returns null for a missing or unregistered task type", () => {
    expect(summariseTaskResult("", json({ saved: 3 }))).toBeNull();
    expect(summariseTaskResult(undefined as any, json({ saved: 3 }))).toBeNull();
    expect(summariseTaskResult("someTypeThatDoesNotExist", json({ saved: 3 }))).toBeNull();
  });

  it("returns null for an empty blob rather than opening an empty dropdown", () => {
    expect(summariseTaskResult("seoCrawl", "{}")).toBeNull();
    expect(summariseTaskResult("seoAudit", "{}")).toBeNull();
    expect(summariseTaskResult("seoBulkMeta", "{}")).toBeNull();
    // Values of the wrong TYPE are not lines either.
    expect(summariseTaskResult("seoCrawl", json({ pagesCrawled: "12", pagesOk: null }))).toBeNull();
    expect(summariseTaskResult("seoCrawl", json({ pagesCrawled: NaN }))).toBeNull();
  });
});

// ── 2. the two deliberate exclusions ────────────────────────────────────────

describe("summariseTaskResult — the job-INPUT types are excluded on purpose", () => {
  it("imageWebpConversion returns null even for a well-formed blob", () => {
    // api.convert-webp.tsx L132 — this is the job spec, not an outcome.
    const blob = json({
      sourceUrl: "https://cdn.shopify.com/s/files/1/0001/kumiko.jpg",
      mediaId: "gid://shopify/MediaImage/1234567890",
      productImageId: "img_42",
      productId: "gid://shopify/Product/999",
      altText: "Kumiko box in walnut",
      position: 2,
    });
    expect(summariseTaskResult("imageWebpConversion", blob)).toBeNull();
  });

  it("pageSpeed returns null even for a well-formed blob", () => {
    // app.seo.performance.tsx L640/L655 — written identically at start and at
    // finish; it is restore state that route's loader reads back.
    const blob = json({ url: "https://example.com/products/kumiko", strategy: "mobile" });
    expect(summariseTaskResult("pageSpeed", blob)).toBeNull();
  });
});

// ── 3. an absent key is omitted, a present 0 is shown ───────────────────────

describe("summariseTaskResult — absent is not zero", () => {
  it("seoCrawl omits every key the blob does not carry", () => {
    const summary = summariseTaskResult(
      "seoCrawl",
      json({ status: "ok", pagesCrawled: 12, pagesOk: 0 }),
    );
    expect(keys(summary)).toEqual(["pagesCrawled", "pagesOk"]);
    // A real 0 IS a number the merchant should see.
    expect(valueOf(summary, "pagesOk")).toBe("0");
    for (const absent of [
      "pagesDiscovered",
      "pagesBroken",
      "pagesServerError",
      "pagesBlocked",
      "orphanPages",
      "headDrift",
      "externalFound",
      "externalChecked",
      "externalBroken",
      "crawlCapped",
    ]) {
      expect(keys(summary)).not.toContain(absent);
    }
  });

  it("blogArticleRedirects omits absent counts and shows a present 0", () => {
    const summary = summariseTaskResult("blogArticleRedirects", json({ created: 0, failed: 2 }));
    expect(keys(summary)).toEqual(["redirectsCreated", "failed"]);
    expect(valueOf(summary, "redirectsCreated")).toBe("0");
    expect(keys(summary)).not.toContain("skippedDrafts");
    expect(keys(summary)).not.toContain("skippedOverCap");
  });

  it("a flag line appears only when the flag is really true", () => {
    expect(keys(summariseTaskResult("seoAudit", json({ totalScanned: 40, capped: false })))).toEqual(
      ["itemsScanned"],
    );
    expect(keys(summariseTaskResult("seoAudit", json({ totalScanned: 40, capped: true })))).toEqual([
      "itemsScanned",
      "capped",
    ]);
    // "capped" is a warning, and it carries no number.
    const capped = summariseTaskResult("seoAudit", json({ totalScanned: 40, capped: true }));
    expect(capped?.lines[1]).toEqual({ labelKey: "capped", value: "", tone: "warning" });
  });

  it("a positive failure count is toned, a zero one is not", () => {
    const clean = summariseTaskResult("seoCrawl", json({ pagesBroken: 0 }));
    expect(clean?.lines[0]).toEqual({ labelKey: "pagesBroken", value: "0" });
    const broken = summariseTaskResult("seoCrawl", json({ pagesBroken: 3 }));
    expect(broken?.lines[0]).toEqual({ labelKey: "pagesBroken", value: "3", tone: "critical" });
  });

  it("seoCrawl names a capped run, which is otherwise invisible", () => {
    const summary = summariseTaskResult("seoCrawl", json({ pagesCrawled: 500, status: "capped" }));
    expect(summary?.lines).toContainEqual({ labelKey: "crawlCapped", value: "", tone: "warning" });
  });
});

// ── 4. galleryVideos is three-valued ────────────────────────────────────────

describe("summariseTaskResult — seoJsonLdAudit.galleryVideos", () => {
  const GALLERY_KEYS = [
    "galleryVideoProducts",
    "galleryVideosMissingDate",
    "mediaVideosMissingDate",
    "galleryVideosVimeo",
  ];

  it("key absent = the sweep never ran — no gallery lines", () => {
    const summary = summariseTaskResult(
      "seoJsonLdAudit",
      json({ totalScanned: 30, totalAvailable: 30 }),
    );
    expect(keys(summary)).toEqual(["itemsScanned", "itemsAvailable"]);
    for (const k of GALLERY_KEYS) expect(keys(summary)).not.toContain(k);
  });

  it("null = the sweep ran and failed — still no gallery lines", () => {
    const summary = summariseTaskResult(
      "seoJsonLdAudit",
      json({ totalScanned: 30, galleryVideos: null }),
    );
    expect(keys(summary)).toEqual(["itemsScanned"]);
    for (const k of GALLERY_KEYS) expect(keys(summary)).not.toContain(k);
  });

  it("an object = a real result, so its counts appear", () => {
    const summary = summariseTaskResult(
      "seoJsonLdAudit",
      json({
        totalScanned: 30,
        capped: true,
        galleryVideos: {
          totalProducts: 7,
          missingDate: 2,
          mediaMissingDate: 0,
          withVimeo: 1,
        },
      }),
    );
    expect(keys(summary)).toEqual([
      "itemsScanned",
      "capped",
      "galleryVideoProducts",
      "galleryVideosMissingDate",
      "mediaVideosMissingDate",
      "galleryVideosVimeo",
    ]);
    expect(valueOf(summary, "galleryVideosMissingDate")).toBe("2");
    // A present 0 is shown, untoned.
    expect(summary?.lines).toContainEqual({ labelKey: "mediaVideosMissingDate", value: "0" });
  });

  it("an ARRAY is not an object result and renders no gallery lines", () => {
    const summary = summariseTaskResult(
      "seoJsonLdAudit",
      json({ totalScanned: 30, galleryVideos: [] }),
    );
    for (const k of GALLERY_KEYS) expect(keys(summary)).not.toContain(k);
  });
});

// ── 5. one type, two blobs — distributeKeywords ─────────────────────────────

describe("summariseTaskResult — distributeKeywords is discriminated by its own stage", () => {
  it("the suggest stage reports the batch counts", () => {
    const summary = summariseTaskResult(
      "distributeKeywords",
      json({
        stage: "suggest",
        groupName: "Vasen",
        keywordCount: 12,
        itemCount: 40,
        batches: 4,
        failedBatches: 1,
        suggestions: [{ id: "1" }],
        itemTitles: { "1": "Kumiko box" },
      }),
    );
    expect(keys(summary)).toEqual(["keywords", "items", "batches", "failedBatches"]);
    expect(summary?.lines).toContainEqual({
      labelKey: "failedBatches",
      value: "1",
      tone: "critical",
    });
    // The suggestions payload belongs to the SEO section, not to a task detail.
    expect(keys(summary)).not.toContain("suggestions");
  });

  it("the apply stage reports a different line set", () => {
    const summary = summariseTaskResult(
      "distributeKeywords",
      json({ stage: "apply", applied: 30, demotedToSecondary: 4, skipped: 6, errors: 0 }),
    );
    expect(keys(summary)).toEqual(["applied", "demotedToSecondary", "skipped", "errors"]);
    expect(keys(summary)).not.toContain("keywords");
  });

  it("a blob with neither stage is handled and returns null", () => {
    expect(() => summariseTaskResult("distributeKeywords", json({ applied: 3 }))).not.toThrow();
    expect(summariseTaskResult("distributeKeywords", json({ applied: 3 }))).toBeNull();
    expect(summariseTaskResult("distributeKeywords", json({ stage: "other", applied: 3 }))).toBeNull();
  });
});

// ── 6. one type, two blobs — translation ────────────────────────────────────

describe("summariseTaskResult — translation is written by two runners", () => {
  it("direct-translations: {translated, total}", () => {
    const summary = summariseTaskResult("translation", json({ translated: 12, total: 14 }));
    expect(keys(summary)).toEqual(["translated", "total"]);
    expect(valueOf(summary, "translated")).toBe("12");
  });

  it("the stale-translation sync: {retranslated, purged}", () => {
    const summary = summariseTaskResult("translation", json({ retranslated: 3, purged: 5 }));
    expect(keys(summary)).toEqual(["retranslated", "purged"]);
  });

  it("a blob matching neither shape returns null instead of guessing", () => {
    expect(summariseTaskResult("translation", json({ locale: "fr", ok: true }))).toBeNull();
    // A count of the wrong type is not a count.
    expect(summariseTaskResult("translation", json({ translated: "12" }))).toBeNull();
  });
});

// ── 7. failure lists ────────────────────────────────────────────────────────

describe("summariseTaskResult — seoBulkFix carries two failure shapes", () => {
  it("{type, id, error} — the per-item and per-job runners", () => {
    const summary = summariseTaskResult(
      "seoBulkFix",
      json({
        succeeded: [{ type: "product", id: "1" }],
        failed: [
          { type: "product", id: "gid://shopify/Product/8123", error: "Item no longer exists" },
        ],
      }),
    );
    expect(keys(summary)).toEqual(["succeeded", "failed"]);
    expect(valueOf(summary, "succeeded")).toBe("1");
    expect(summary?.lines).toContainEqual({ labelKey: "failed", value: "1", tone: "critical" });
    expect(summary?.failures).toHaveLength(1);
    expect(summary?.failures[0].subject).toBe("product gid://shopify/Product/8123");
    expect(summary?.failures[0].subject).not.toBe("");
    expect(summary?.failures[0].message).toBe("Item no longer exists");
  });

  it("{code, error} — the single-item multi-code runner", () => {
    const summary = summariseTaskResult(
      "seoBulkFix",
      json({
        succeeded: [{ code: "seoTitleMissing" }],
        failed: [{ code: "metaDescriptionMissing", error: "Not AI-fixable: metaDescriptionMissing" }],
      }),
    );
    expect(summary?.failures).toEqual([
      { subject: "metaDescriptionMissing", message: "Not AI-fixable: metaDescriptionMissing" },
    ]);
    expect(summary?.failures[0].subject).not.toBe("");
  });

  it("an empty failed list is still a reported 0, untoned", () => {
    const summary = summariseTaskResult("seoBulkFix", json({ succeeded: [], failed: [] }));
    expect(summary?.lines).toEqual([
      { labelKey: "succeeded", value: "0" },
      { labelKey: "failed", value: "0" },
    ]);
    expect(summary?.failures).toEqual([]);
  });

  it("skips entries that are not objects instead of throwing", () => {
    const summary = summariseTaskResult(
      "seoBulkFix",
      json({ succeeded: [], failed: [null, "boom", { code: "x", error: "y" }] }),
    );
    expect(summary?.failures).toEqual([{ subject: "x", message: "y" }]);
  });
});

describe("summariseTaskResult — altTextTemplateApply.errors is a string[]", () => {
  const ERRORS = [
    "Blau / M (Position 2, GID gid://shopify/MediaImage/123): Alt text could not be saved",
    "Blau / L (Position 3): No translatable digest found for GID gid://shopify/MediaImage/124",
  ];

  it("the emitted line carries the LIST LENGTH, not the array", () => {
    const summary = summariseTaskResult(
      "altTextTemplateApply",
      json({ applied: 18, attempted: 20, errors: ERRORS }),
    );
    expect(keys(summary)).toEqual(["applied", "attempted", "errors"]);
    expect(summary?.lines).toContainEqual({ labelKey: "errors", value: "2", tone: "critical" });
  });

  it("each entry becomes a failure line split at the runner's shape", () => {
    const summary = summariseTaskResult(
      "altTextTemplateApply",
      json({ applied: 18, attempted: 20, errors: ERRORS }),
    );
    expect(summary?.failures).toEqual([
      {
        subject: "Blau / M (Position 2, GID gid://shopify/MediaImage/123)",
        message: "Alt text could not be saved",
      },
      {
        subject: "Blau / L (Position 3)",
        message: "No translatable digest found for GID gid://shopify/MediaImage/124",
      },
    ]);
  });

  it("a line that does not match the shape keeps its whole text as the message", () => {
    const summary = summariseTaskResult(
      "altTextTemplateApply",
      json({ attempted: 1, errors: ["Something went wrong"] }),
    );
    // Documented edge: an empty subject means "render the message alone".
    expect(summary?.failures).toEqual([{ subject: "", message: "Something went wrong" }]);
  });

  it("blank entries are dropped and an empty list is a plain 0", () => {
    const summary = summariseTaskResult(
      "altTextTemplateApply",
      json({ applied: 20, attempted: 20, errors: [] }),
    );
    expect(summary?.lines).toContainEqual({ labelKey: "errors", value: "0" });
    expect(summary?.failures).toEqual([]);

    const blanks = summariseTaskResult(
      "altTextTemplateApply",
      json({ attempted: 2, errors: ["", "   ", 7] }),
    );
    expect(blanks?.failures).toEqual([]);
    expect(valueOf(blanks, "errors")).toBe("3");
  });

  it("a numeric `errors` is read as the count it is", () => {
    const summary = summariseTaskResult(
      "altTextTemplateApply",
      json({ applied: 18, attempted: 20, errors: 2 }),
    );
    expect(summary?.lines).toContainEqual({ labelKey: "errors", value: "2", tone: "critical" });
    expect(summary?.failures).toEqual([]);
  });
});

describe("summariseTaskResult — the bulk failure list is the only record there is", () => {
  const CELL = {
    rowId: "gid://shopify/Product/8123",
    rowType: "product",
    columnId: "seo.metaDescription",
    message: "Shopify did not echo the value back",
  };
  const ROW = {
    rowId: "gid://shopify/Page/55",
    rowType: "page",
    message: "pageUpdate failed",
  };

  it("seoBulkMeta distinguishes a cell failure from a row-level one", () => {
    const summary = summariseTaskResult("seoBulkMeta", json({ saved: 37, failures: [CELL, ROW] }));
    expect(keys(summary)).toEqual(["saved", "failed"]);
    expect(summary?.lines).toContainEqual({ labelKey: "failed", value: "2", tone: "critical" });
    expect(summary?.failures[0].subject).toBe("gid://shopify/Product/8123 · seo.metaDescription");
    expect(summary?.failures[1].subject).toBe("gid://shopify/Page/55");
    expect(summary?.failures[0].subject).not.toBe(summary?.failures[1].subject);
    expect(summary?.failures[0].message).toBe("Shopify did not echo the value back");
  });

  it("a failure in a foreign locale says which one", () => {
    const summary = summariseTaskResult(
      "seoBulkMeta",
      json({ saved: 0, failures: [{ ...CELL, locale: "fr" }, { ...ROW, locale: "" }] }),
    );
    expect(summary?.failures[0].subject).toBe(
      "gid://shopify/Product/8123 · seo.metaDescription [fr]",
    );
    // An empty locale is the primary one — no bracket.
    expect(summary?.failures[1].subject).toBe("gid://shopify/Page/55");
  });

  it("seoBulkMeta omits the failed line when the blob carries no failures key", () => {
    const summary = summariseTaskResult("seoBulkMeta", json({ saved: 40 }));
    expect(keys(summary)).toEqual(["saved"]);
    expect(summary?.failures).toEqual([]);
  });

  it("bulkEditorTranslate reports its own counts plus the same failure list", () => {
    const summary = summariseTaskResult(
      "bulkEditorTranslate",
      json({ saved: 120, failed: 2, skippedHandles: 3, failures: [CELL, ROW] }),
    );
    expect(keys(summary)).toEqual(["translationsSaved", "failed", "skippedHandles"]);
    expect(summary?.lines).toContainEqual({ labelKey: "failed", value: "2", tone: "critical" });
    // A deliberate skip that is explained nowhere else.
    expect(valueOf(summary, "skippedHandles")).toBe("3");
    expect(summary?.failures[0].subject).toBe("gid://shopify/Product/8123 · seo.metaDescription");
    expect(summary?.failures[1].subject).toBe("gid://shopify/Page/55");
  });

  it("a failure list alone is enough of a summary to render", () => {
    const summary = summariseTaskResult("bulkEditorTranslate", json({ failures: [ROW] }));
    expect(summary?.lines).toEqual([]);
    expect(summary?.failures).toHaveLength(1);
  });

  it("a non-array failures value yields no failure lines", () => {
    const summary = summariseTaskResult("seoBulkMeta", json({ saved: 1, failures: "boom" }));
    expect(summary?.failures).toEqual([]);
    expect(keys(summary)).toEqual(["saved"]);
  });
});

// ── 8. the remaining registered types ───────────────────────────────────────

describe("summariseTaskResult — the remaining registered types", () => {
  it("seoInternalLinks", () => {
    const summary = summariseTaskResult(
      "seoInternalLinks",
      json({
        targetsConsidered: 40,
        targetsWithSynonyms: 12,
        synonymRequests: 3,
        sourcesScanned: 88,
        created: 15,
        updated: 2,
        cappedByPendingLimit: true,
      }),
    );
    expect(keys(summary)).toEqual([
      "sourcesScanned",
      "targetsConsidered",
      "suggestionsCreated",
      "suggestionsUpdated",
      "synonymRequests",
      "internalLinksCapped",
    ]);
  });

  it("seoRobotsAdvice", () => {
    expect(keys(summariseTaskResult("seoRobotsAdvice", json({ advised: 4, total: 9 })))).toEqual([
      "rulesAdvised",
      "rulesTotal",
    ]);
  });

  it("aiDiscoveryIntro renders the served PATH, not the enum", () => {
    const llms = summariseTaskResult("aiDiscoveryIntro", json({ file: "llms", chars: 812 }));
    expect(llms?.lines).toEqual([
      { labelKey: "file", value: "llms.txt" },
      { labelKey: "characters", value: "812" },
    ]);
    const agents = summariseTaskResult("aiDiscoveryIntro", json({ file: "agents", chars: 640 }));
    expect(valueOf(agents, "file")).toBe("agents.md");
    // An unknown file name is passed through rather than dropped.
    expect(valueOf(summariseTaskResult("aiDiscoveryIntro", json({ file: "other" })), "file")).toBe(
      "other",
    );
  });

  it("seoAudit", () => {
    const summary = summariseTaskResult(
      "seoAudit",
      json({ averageScore: 71, totalScanned: 120, totalAvailable: 340, capped: true }),
    );
    expect(keys(summary)).toEqual(["averageScore", "itemsScanned", "itemsAvailable", "capped"]);
  });
});

// ── 9. hasTaskDetails ───────────────────────────────────────────────────────

describe("hasTaskDetails", () => {
  it("a prompt alone is enough, whatever the type", () => {
    expect(hasTaskDetails({ type: "pageSpeed", hasPrompt: true, hasResult: false })).toBe(true);
    expect(hasTaskDetails({ type: "aiGeneration", hasPrompt: true, hasResult: false })).toBe(true);
  });

  it("a result alone is enough for a registered type", () => {
    expect(hasTaskDetails({ type: "seoCrawl", hasPrompt: false, hasResult: true })).toBe(true);
    expect(hasTaskDetails({ type: "seoBulkMeta", hasPrompt: false, hasResult: true })).toBe(true);
  });

  it("a result alone is NOT enough for the two job-input types", () => {
    // This pair is what removes the dropdown that opened onto nothing.
    expect(hasTaskDetails({ type: "imageWebpConversion", hasPrompt: false, hasResult: true })).toBe(
      false,
    );
    expect(hasTaskDetails({ type: "pageSpeed", hasPrompt: false, hasResult: true })).toBe(false);
  });

  it("an unregistered type with a result has nothing to show", () => {
    expect(hasTaskDetails({ type: "somethingNew", hasPrompt: false, hasResult: true })).toBe(false);
  });

  it("neither means no arrow", () => {
    expect(hasTaskDetails({ type: "seoCrawl", hasPrompt: false, hasResult: false })).toBe(false);
    expect(() => hasTaskDetails(null as any)).not.toThrow();
    expect(hasTaskDetails(null as any)).toBe(false);
    expect(hasTaskDetails({} as any)).toBe(false);
  });
});

// ── 10. the emitted vocabulary ──────────────────────────────────────────────

/**
 * Every `labelKey` a summariser can emit, collected from a maximal blob per
 * type. The list is pinned here rather than checked against `app/i18n/en.ts`:
 * importing the bundle makes this file fail for edits that have nothing to do
 * with this module. A new labelKey therefore has to be added HERE and to the
 * three i18n files — this test is the reminder, not the proof.
 */
describe("the emitted label vocabulary", () => {
  const MAXIMAL: [string, unknown][] = [
    [
      "seoCrawl",
      {
        status: "capped",
        pagesCrawled: 1,
        totalDiscovered: 1,
        pagesOk: 1,
        pagesBroken: 1,
        pagesServerError: 1,
        pagesBlocked: 1,
        orphanCount: 1,
        headDriftCount: 1,
        externalFound: 1,
        externalChecked: 1,
        externalBroken: 1,
      },
    ],
    ["seoAudit", { averageScore: 1, totalScanned: 1, totalAvailable: 1, capped: true }],
    [
      "seoJsonLdAudit",
      {
        totalScanned: 1,
        totalAvailable: 1,
        capped: true,
        galleryVideos: { totalProducts: 1, missingDate: 1, mediaMissingDate: 1, withVimeo: 1 },
      },
    ],
    ["seoBulkMeta", { saved: 1, failures: [] }],
    ["bulkEditorTranslate", { saved: 1, failed: 1, skippedHandles: 1, failures: [] }],
    ["seoBulkFix", { succeeded: [], failed: [] }],
    ["blogArticleRedirects", { created: 1, failed: 1, skippedDrafts: 1, skippedOverCap: 1 }],
    ["altTextTemplateApply", { applied: 1, attempted: 1, errors: [] }],
    [
      "seoInternalLinks",
      {
        sourcesScanned: 1,
        targetsConsidered: 1,
        created: 1,
        updated: 1,
        synonymRequests: 1,
        cappedByPendingLimit: true,
      },
    ],
    [
      "distributeKeywords",
      { stage: "suggest", keywordCount: 1, itemCount: 1, batches: 1, failedBatches: 1 },
    ],
    [
      "distributeKeywords",
      { stage: "apply", applied: 1, demotedToSecondary: 1, skipped: 1, errors: 1 },
    ],
    ["seoRobotsAdvice", { advised: 1, total: 1 }],
    ["aiDiscoveryIntro", { file: "llms", chars: 1 }],
    ["translation", { translated: 1, total: 1 }],
    ["translation", { retranslated: 1, purged: 1 }],
  ];

  const EXPECTED = [
    "applied",
    "attempted",
    "averageScore",
    "batches",
    "capped",
    "characters",
    "crawlCapped",
    "demotedToSecondary",
    "errors",
    "externalBroken",
    "externalChecked",
    "externalFound",
    "failed",
    "failedBatches",
    "file",
    "galleryVideoProducts",
    "galleryVideosMissingDate",
    "galleryVideosVimeo",
    "headDrift",
    "internalLinksCapped",
    "items",
    "itemsAvailable",
    "itemsScanned",
    "keywords",
    "mediaVideosMissingDate",
    "orphanPages",
    "pagesBlocked",
    "pagesBroken",
    "pagesCrawled",
    "pagesDiscovered",
    "pagesOk",
    "pagesServerError",
    "purged",
    "redirectsCreated",
    "retranslated",
    "rulesAdvised",
    "rulesTotal",
    "saved",
    "skipped",
    "skippedDrafts",
    "skippedHandles",
    "skippedOverCap",
    "sourcesScanned",
    "succeeded",
    "suggestionsCreated",
    "suggestionsUpdated",
    "synonymRequests",
    "targetsConsidered",
    "total",
    "translated",
    "translationsSaved",
  ];

  it("is exactly the pinned list", () => {
    const emitted = new Set<string>();
    for (const [type, blob] of MAXIMAL) {
      for (const key of keys(summariseTaskResult(type, json(blob)))) emitted.add(key);
    }
    expect([...emitted].sort()).toEqual(EXPECTED);
  });

  it("no labelKey is empty or non-camelCase", () => {
    for (const key of EXPECTED) expect(key).toMatch(/^[a-z][A-Za-z0-9]*$/);
  });
});
