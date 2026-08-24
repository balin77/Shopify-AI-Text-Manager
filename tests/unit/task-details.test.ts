/**
 * PLAN_TASK_LIST_CLARITY §3.2 — turning a persisted `Task.result` into lines.
 *
 * Every runner in this app already writes a structured result blob and none of
 * it was ever shown; for `seoBulkMeta` and `bulkEditorTranslate` the per-cell
 * failure list in there is the ONLY record of what went wrong anywhere. The
 * rules under test each have a failure mode behind them:
 *
 *  1. **Per type, never a JSON dump.** `imageWebpConversionItem` and
 *     `pageSpeed` store the job INPUT, not an outcome, so they are absent from
 *     the registry on purpose — a generic renderer would show a merchant an
 *     internal job spec. `imageWebpConversion` is the aggregate row ABOVE those
 *     items and holds a real outcome, so it is registered; the split between
 *     the two is pinned below.
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
    // The bulk editor's auto-translation block: absent means NOT REPORTED (a
    // result stored before the field existed, or a shop without the feature),
    // never "nothing was re-translated and nothing was deleted".
    const withoutBlock = summariseTaskResult("seoBulkMeta", json({ saved: 1, failures: [] }));
    expect(withoutBlock?.lines.map((l) => l.labelKey)).not.toContain("retranslationsStarted");
    expect(withoutBlock?.lines.map((l) => l.labelKey)).not.toContain("retranslationsCapped");
    const withBlock = summariseTaskResult(
      "seoBulkMeta",
      json({ saved: 1, failures: [], retranslation: { started: 3, skipped: 0, capped: 2 } }),
    );
    expect(withBlock?.lines).toEqual(
      expect.arrayContaining([
        { labelKey: "retranslationsStarted", value: "3" },
        // A cap that BIT is a warning: those rows lost their translations.
        { labelKey: "retranslationsCapped", value: "2", tone: "warning" },
      ]),
    );
    // Values of the wrong TYPE are not lines either.
    expect(summariseTaskResult("seoCrawl", json({ pagesCrawled: "12", pagesOk: null }))).toBeNull();
    expect(summariseTaskResult("seoCrawl", json({ pagesCrawled: NaN }))).toBeNull();
  });
});

// ── 2. the two deliberate exclusions ────────────────────────────────────────

describe("summariseTaskResult — the job-INPUT types are excluded on purpose", () => {
  it("imageWebpConversionItem returns null even for a well-formed blob", () => {
    // api.convert-webp.tsx — this is the job spec of ONE image, not an outcome.
    const blob = json({
      sourceUrl: "https://cdn.shopify.com/s/files/1/0001/kumiko.jpg",
      mediaId: "gid://shopify/MediaImage/1234567890",
      productImageId: "img_42",
      productId: "gid://shopify/Product/999",
      altText: "Kumiko box in walnut",
      position: 2,
      parentTaskId: "ckparent",
    });
    expect(summariseTaskResult("imageWebpConversionItem", blob)).toBeNull();
  });

  it("a legacy pre-split row under the PARENT type shows no job spec either", () => {
    // Rows created before the parent/child split carry the job input under
    // `imageWebpConversion`. That type is registered now, so the guard is the
    // summariser's own: none of those keys is a count, so it answers null and
    // the merchant is not shown an internal job spec.
    const blob = json({
      sourceUrl: "https://cdn.shopify.com/s/files/1/0001/kumiko.jpg",
      mediaId: "gid://shopify/MediaImage/1234567890",
      productImageId: "img_42",
      productId: "gid://shopify/Product/999",
      altText: "Kumiko box in walnut",
      position: 2,
      webpUrl: "https://cdn.shopify.com/s/files/1/0001/kumiko.webp",
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

// ── 6. the translation family — twenty call sites, one summariser ───────────

/**
 * `translation` (nine call sites) and `bulkTranslation` (eleven) are the
 * biggest task family in the app and the only one whose partial failure was
 * already a STATUS (`completed_with_errors`) with nothing behind it. Every
 * blob below was read off a real `task.update` in the repo.
 */
describe("summariseTaskResult — the translation family", () => {
  it("direct-translations: {translated, total}", () => {
    const summary = summariseTaskResult("translation", json({ translated: 12, total: 14 }));
    expect(keys(summary)).toEqual(["translated", "total"]);
    expect(valueOf(summary, "translated")).toBe("12");
  });

  it("the stale-translation sync: {retranslated, purged}", () => {
    const summary = summariseTaskResult("translation", json({ retranslated: 3, purged: 5 }));
    expect(keys(summary)).toEqual(["retranslated", "purged"]);
  });

  it("the grouped-field sync: {synced, failed, total}", () => {
    // api.grouped-field-translations.tsx L204 — a fourth blob under
    // `bulkTranslation`, and the one that sets completed_with_errors.
    const summary = summariseTaskResult(
      "bulkTranslation",
      json({ synced: 18, failed: 2, total: 20 }),
    );
    expect(keys(summary)).toEqual(["synced", "total", "failed"]);
    expect(summary?.lines).toContainEqual({ labelKey: "failed", value: "2", tone: "critical" });
  });

  it("sub-resources, one locale: {translatedCount, failedCount, targetLocale}", () => {
    // sub-resources.action.ts L488. `targetLocale` alone is not a line — the
    // task row already names the locale, and a lone locale is not a summary.
    const summary = summariseTaskResult(
      "translation",
      json({ translatedCount: 6, failedCount: 0, targetLocale: "fr" }),
    );
    expect(keys(summary)).toEqual(["translated", "failed"]);
    expect(valueOf(summary, "translated")).toBe("6");
    expect(summary?.lines).toContainEqual({ labelKey: "failed", value: "0" });
  });

  it("sub-resources, all locales: {translatedLocales[], failedLocales[]}", () => {
    // sub-resources.action.ts L689.
    const summary = summariseTaskResult(
      "bulkTranslation",
      json({ translatedLocales: ["fr", "de"], failedLocales: ["it"] }),
    );
    expect(keys(summary)).toEqual(["localesTranslated", "localesFailed"]);
    expect(valueOf(summary, "localesTranslated")).toBe("2");
    expect(summary?.lines).toContainEqual({
      labelKey: "localesFailed",
      value: "1",
      tone: "critical",
    });
    // The point of the exercise: the merchant reads the code itself.
    expect(summary?.failures).toEqual([{ subject: "", message: "it" }]);
  });

  it("translateAll: the failed locales are named, and NO number is invented", () => {
    // translation.action.ts L416 — the shape behind completed_with_errors.
    const summary = summariseTaskResult(
      "bulkTranslation",
      json({
        success: true,
        locales: ["fr", "de", "it"],
        failedLocales: ["it", "nl"],
        rejectedFields: {},
        skippedFields: {},
      }),
    );
    // `locales` is `Object.keys(allTranslations)`: the map is SEEDED with one
    // empty entry per target locale (shopify-content.service.ts L1381) and
    // filled only from `allSaved` (L1818-1819), where `savePerLocaleBatch`'s
    // own failures are discarded — while `failedLocales` is pushed to from the
    // AI stages ALONE (L1733/L1753/L1759). A locale whose every field Shopify
    // refused is therefore in neither list, and no arithmetic over key NAMES
    // can find it: "3 translated / 0 failed" for a run that reached one third.
    // A number that is wrong is worse than a number that is absent.
    expect(keys(summary)).toEqual(["localesFailed", "fieldsRejected", "fieldsSkipped"]);
    expect(keys(summary)).not.toContain("localesTranslated");
    expect(summary?.failures).toEqual([
      { subject: "", message: "it" },
      { subject: "", message: "nl" },
    ]);
    // Present-but-empty records are a real 0, untoned.
    expect(summary?.lines).toContainEqual({ labelKey: "fieldsRejected", value: "0" });
    expect(summary?.lines).toContainEqual({ labelKey: "fieldsSkipped", value: "0" });
  });

  it("a `locales` MAP is countable where the bare key list is not", () => {
    // The same key, carrying the entries themselves: a locale that holds
    // something was really translated, a seeded `{}` was not. No runner writes
    // this shape today; the rule is "count what is substantiated", so it must
    // count when the substance is there.
    const summary = summariseTaskResult(
      "bulkTranslation",
      json({
        locales: { fr: { title: "Boîte" }, de: {}, it: { title: "Scatola" } },
        failedLocales: ["it"],
      }),
    );
    expect(valueOf(summary, "localesTranslated")).toBe("1");
  });

  it("a runner-filtered locale LIST is still counted", () => {
    // sub-resources.action.ts L689 writes `translatedLocales` pre-filtered, so
    // that key means what it says.
    const summary = summariseTaskResult(
      "translation",
      json({ translatedLocales: ["fr", "de"], failedLocales: ["it"] }),
    );
    expect(valueOf(summary, "localesTranslated")).toBe("2");
  });

  it("rejected and skipped fields name the FIELDS, per locale", () => {
    const summary = summariseTaskResult(
      "bulkTranslation",
      json({
        success: true,
        locales: ["fr", "de"],
        failedLocales: [],
        rejectedFields: { fr: ["seoTitle", "body_html"], de: ["body_html"] },
        skippedFields: { fr: ["handle"] },
      }),
    );
    // The count is the number of (locale, field) PAIRS.
    expect(summary?.lines).toContainEqual({
      labelKey: "fieldsRejected",
      value: "3",
      tone: "critical",
    });
    // A deliberate skip is a warning, not an error.
    expect(summary?.lines).toContainEqual({
      labelKey: "fieldsSkipped",
      value: "1",
      tone: "warning",
    });
    // Only the REJECTED fields are listed. The panel renders `failures` as a
    // red "failed items" box, and a skipped handle is a deliberate outcome on
    // a task that finished `completed` — its warning count line says it
    // happened without dressing a success up as a failure.
    expect(summary?.failures).toEqual([
      { subject: "fr", message: "seoTitle, body_html" },
      { subject: "de", message: "body_html" },
    ]);
  });

  it("a locale that only SKIPPED a field is still listed when it failed", () => {
    // The bare-code entry is suppressed by a REJECTED group, never by a
    // skipped one — nothing else would name that locale.
    const summary = summariseTaskResult(
      "bulkTranslation",
      json({ failedLocales: ["fr"], skippedFields: { fr: ["handle"] } }),
    );
    expect(summary?.failures).toEqual([{ subject: "", message: "fr" }]);
    expect(summary?.lines).toContainEqual({
      labelKey: "fieldsSkipped",
      value: "1",
      tone: "warning",
    });
  });

  it("a locale whose fields are named is not listed a second time as a bare code", () => {
    const summary = summariseTaskResult(
      "bulkTranslation",
      json({
        failedLocales: ["fr", "it"],
        rejectedFields: { fr: ["seoTitle"] },
      }),
    );
    // "fr" is covered by the field entry; only "it" has nothing more to say.
    expect(summary?.failures).toEqual([
      { subject: "", message: "it" },
      { subject: "fr", message: "seoTitle" },
    ]);
  });

  it("translateFieldToAllLocales counts the translations map as LOCALES", () => {
    // translation.action.ts L706: `{translations: Record<locale, string>,
    // fieldType, …}` — `fieldType` is what says the keys are locales.
    const summary = summariseTaskResult(
      "bulkTranslation",
      json({
        translations: { fr: "Boîte", de: "Kiste", it: "Scatola" },
        fieldType: "title",
        failedLocales: [],
        rejectedFields: {},
        skippedFields: {},
      }),
    );
    expect(valueOf(summary, "localesTranslated")).toBe("3");
    expect(keys(summary)).not.toContain("fieldsTranslated");

    // L695 fills the map for EVERY locale of the seeded set, failures with an
    // empty string — so neither an empty value nor a failed locale counts.
    const partial = summariseTaskResult(
      "bulkTranslation",
      json({
        translations: { fr: "Boîte", de: "", it: "Scatola" },
        fieldType: "title",
        failedLocales: ["it"],
      }),
    );
    expect(valueOf(partial, "localesTranslated")).toBe("1");
  });

  it("translateAllForLocale counts the same map as FIELDS", () => {
    // translation.action.ts L578: one locale, `{fieldKey: value}`. Counting
    // those keys as locales would report "4 languages" for a one-locale run.
    const summary = summariseTaskResult(
      "bulkTranslation",
      json({
        success: true,
        targetLocale: "fr",
        translations: { title: "Boîte", body_html: "…", seoTitle: "…", handle: "boite" },
        failedLocales: [],
        rejectedFields: {},
        skippedFields: {},
      }),
    );
    expect(valueOf(summary, "fieldsTranslated")).toBe("4");
    expect(keys(summary)).not.toContain("localesTranslated");
  });

  it("an empty value is not a translated field, and a failed locale has none", () => {
    const partial = summariseTaskResult(
      "bulkTranslation",
      json({ targetLocale: "fr", translations: { title: "Boîte", body_html: "", seoTitle: "  " } }),
    );
    expect(valueOf(partial, "fieldsTranslated")).toBe("1");

    // The one locale of the run failed: nothing was saved, so a field count
    // would describe an AI answer nobody received.
    const failed = summariseTaskResult(
      "bulkTranslation",
      json({
        targetLocale: "fr",
        translations: { title: "Boîte" },
        failedLocales: ["fr"],
      }),
    );
    expect(keys(failed)).toEqual(["localesFailed"]);
  });

  it("a translations map with neither discriminator is not counted at all", () => {
    // Rather than guess whether its keys are locales or fields.
    const summary = summariseTaskResult(
      "bulkTranslation",
      json({ translations: { fr: "x" }, failedLocales: ["it"] }),
    );
    expect(keys(summary)).toEqual(["localesFailed"]);
  });

  it("the alt-text bulk blob reports its locale counts and drops the payload", () => {
    // alt-text.action.ts L514/L662.
    const summary = summariseTaskResult(
      "bulkTranslation",
      json({
        translatedAltTexts: { fr: "Boîte kumiko", it: "Scatola kumiko" },
        imageIndex: 2,
        targetLocales: ["fr", "it"],
        savedLocales: ["fr"],
        failedLocales: ["it"],
      }),
    );
    expect(keys(summary)).toEqual(["localesSaved", "localesTargeted", "localesFailed"]);
    expect(valueOf(summary, "localesSaved")).toBe("1");
    expect(valueOf(summary, "localesTargeted")).toBe("2");
    expect(summary?.failures).toEqual([{ subject: "", message: "it" }]);
    // The translated text itself is content, not a summary.
    expect(JSON.stringify(summary)).not.toContain("Boîte kumiko");
  });

  it("a payload-only blob returns null instead of dumping it", () => {
    // alt-text.action.ts L391 — the single alt-text translation: nothing but
    // the translated string, an image index and the locale.
    expect(
      summariseTaskResult(
        "translation",
        json({ translatedAltText: "Boîte kumiko", imageIndex: 2, targetLocale: "fr" }),
      ),
    ).toBeNull();
    // alt-text.handler.ts L1278 — `{<imageIndex>: <alt text>}`.
    expect(summariseTaskResult("translation", json({ "0": "Boîte", "1": "Scatola" }))).toBeNull();
  });

  it("the results that are not JSON objects at all return null", () => {
    // These are real stored values, and a registered type answering null is a
    // state the consumer has to tolerate (module rule 4).
    const NON_JSON = [
      // templates-translate-field.action.ts L144 — the translated value itself,
      // truncated to 1000 characters.
      '"Eine Vase aus Walnussholz"',
      "Eine Vase aus Walnussholz",
      // templates-translate-field.action.ts L316 / templates-translate-all L230.
      "Translated to 4 locales",
      "Translated 12 fields to 4 locales",
      // alt-text.handler.ts L730 / text-translation.handler.ts L1512 — an
      // ARRAY of per-locale AI responses.
      json([{ locale: "fr", response: "Boîte" }]),
      // ai-queue.service.ts L700 truncates any recovered result to 500 chars.
      '{"locales":["fr","de"],"failedLoc',
    ];
    for (const stored of NON_JSON) {
      for (const type of ["translation", "bulkTranslation"]) {
        expect(() => summariseTaskResult(type, stored)).not.toThrow();
        expect(summariseTaskResult(type, stored)).toBeNull();
      }
    }
  });

  it("a blob matching no shape returns null instead of guessing", () => {
    expect(summariseTaskResult("translation", json({ locale: "fr", ok: true }))).toBeNull();
    expect(summariseTaskResult("bulkTranslation", json({ success: true }))).toBeNull();
    // A count of the wrong type is not a count.
    expect(summariseTaskResult("translation", json({ translated: "12" }))).toBeNull();
    // Neither is a locale list of the wrong type.
    expect(summariseTaskResult("bulkTranslation", json({ failedLocales: "fr" }))).toBeNull();
    expect(summariseTaskResult("bulkTranslation", json({ rejectedFields: [] }))).toBeNull();
  });

  it("both type spellings resolve to the same summary", () => {
    const blob = json({ locales: ["fr"], failedLocales: ["it"] });
    expect(summariseTaskResult("translation", blob)).toEqual(
      summariseTaskResult("bulkTranslation", blob),
    );
  });

  it("garbage entries inside the lists are dropped, not rendered", () => {
    const summary = summariseTaskResult(
      "bulkTranslation",
      json({
        locales: ["fr", 7, "", "   ", null],
        failedLocales: ["it", 9],
        rejectedFields: { fr: "not-an-array", de: [], it: ["title", 3] },
      }),
    );
    // A bare `locales` LIST substantiates no count at all (see above), garbage
    // or not — so there is nothing here for the garbage to reach.
    expect(keys(summary)).not.toContain("localesTranslated");
    expect(valueOf(summary, "localesFailed")).toBe("1");
    // `fr` has no array and `de` an empty one — neither is a named field.
    expect(valueOf(summary, "fieldsRejected")).toBe("1");
    expect(summary?.failures).toEqual([{ subject: "it", message: "title" }]);
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
    // P5: the raw GID is a machine string — the subject names what a merchant
    // can act on, and the numeric tail is what the admin URL carries.
    expect(summary?.failures[0].subject).toBe("Product 8123");
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
    // A `{code}` entry has no row identity at all, so it carries no `parts`.
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

  it("a variant title with brackets keeps its whole name in the subject", () => {
    // The runner's shape is `${variant.title} (Position n, GID …): ${message}`
    // and a title may contain brackets of its own. Split at the FIRST ")", the
    // subject was "Blau (matt" and the rest of the title, the position and the
    // GID were prepended to the merchant's error message.
    const summary = summariseTaskResult(
      "altTextTemplateApply",
      json({
        attempted: 1,
        errors: [
          "Blau (matt) / M (Position 3, GID gid://shopify/MediaImage/123): Alt text could not be saved",
        ],
      }),
    );
    expect(summary?.failures).toEqual([
      {
        subject: "Blau (matt) / M (Position 3, GID gid://shopify/MediaImage/123)",
        message: "Alt text could not be saved",
      },
    ]);
  });

  it("a message that itself ends in a bracket is not eaten by the split", () => {
    const summary = summariseTaskResult(
      "altTextTemplateApply",
      json({ attempted: 1, errors: ["Blau / M (Position 2): boom (see logs)"] }),
    );
    expect(summary?.failures[0].subject).toBe("Blau / M (Position 2)");
    expect(summary?.failures[0].message).toBe("boom (see logs)");
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

    // P5: the count is the LENGTH OF THE LIST, not of the raw array — a "3"
    // above an empty list is a number the merchant cannot reconcile.
    const blanks = summariseTaskResult(
      "altTextTemplateApply",
      json({ attempted: 2, errors: ["", "   ", 7] }),
    );
    expect(blanks?.failures).toEqual([]);
    expect(valueOf(blanks, "errors")).toBe("0");
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
    // The two counts are in DIFFERENT units — rows saved, cells failed — so
    // each line names its own. Unlabelled, a 40-row save reads as 49 of 40.
    expect(keys(summary)).toEqual(["savedRows", "failedFields"]);
    expect(summary?.lines).toContainEqual({ labelKey: "failedFields", value: "2", tone: "critical" });
    expect(summary?.failures[0].subject).toBe("Product 8123 · seo.metaDescription");
    expect(summary?.failures[1].subject).toBe("Page 55");
    expect(summary?.failures[0].subject).not.toBe(summary?.failures[1].subject);
    expect(summary?.failures[0].message).toBe("Shopify did not echo the value back");
  });

  it("a failure in a foreign locale says which one", () => {
    const summary = summariseTaskResult(
      "seoBulkMeta",
      json({ saved: 0, failures: [{ ...CELL, locale: "fr" }, { ...ROW, locale: "" }] }),
    );
    expect(summary?.failures[0].subject).toBe("Product 8123 · seo.metaDescription [fr]");
    // An empty locale is the primary one — no bracket.
    expect(summary?.failures[1].subject).toBe("Page 55");
  });

  it("seoBulkMeta omits the failed line when the blob carries no failures key", () => {
    const summary = summariseTaskResult("seoBulkMeta", json({ saved: 40 }));
    expect(keys(summary)).toEqual(["savedRows"]);
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
    expect(summary?.failures[0].subject).toBe("Product 8123 · seo.metaDescription");
    expect(summary?.failures[1].subject).toBe("Page 55");
  });

  it("a failure list alone is enough of a summary to render", () => {
    const summary = summariseTaskResult("bulkEditorTranslate", json({ failures: [ROW] }));
    expect(summary?.lines).toEqual([]);
    expect(summary?.failures).toHaveLength(1);
  });

  it("a non-array failures value yields no failure lines", () => {
    const summary = summariseTaskResult("seoBulkMeta", json({ saved: 1, failures: "boom" }));
    expect(summary?.failures).toEqual([]);
    expect(keys(summary)).toEqual(["savedRows"]);
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

// ── 8b. the WebP conversion AGGREGATE ───────────────────────────────────────

describe("summariseTaskResult — the WebP conversion batch", () => {
  it("reports the three counts and names the failed images by gallery position", () => {
    const summary = summariseTaskResult(
      "imageWebpConversion",
      json({
        total: 3,
        converted: 2,
        failed: 1,
        failures: [
          {
            mediaId: "gid://shopify/MediaImage/1234567890",
            position: 2,
            message: "Failed to download image: 404",
          },
        ],
      }),
    );
    expect(keys(summary)).toEqual(["imagesConverted", "imagesFailed", "imagesTotal"]);
    expect(valueOf(summary, "imagesConverted")).toBe("2");
    expect(valueOf(summary, "imagesTotal")).toBe("3");
    // The count is the merchant's warning that something is still a PNG.
    expect(summary?.lines.find((l) => l.labelKey === "imagesFailed")?.tone).toBe("critical");
    // Stored zero-based, counted from one — the same +1 as `altText_<n>`.
    expect(summary?.failures).toEqual([
      {
        subject: "Image 3",
        message: "Failed to download image: 404",
        parts: { rowType: "image", rowId: "3" },
      },
    ]);
  });

  it("falls back to the media id when the run recorded no position", () => {
    const summary = summariseTaskResult(
      "imageWebpConversion",
      json({
        total: 1,
        converted: 0,
        failed: 1,
        failures: [{ mediaId: "gid://shopify/MediaImage/42", position: null, message: "boom" }],
      }),
    );
    expect(summary?.failures).toEqual([
      { subject: "Image 42", message: "boom", parts: { rowType: "image", rowId: "42" } },
    ]);
  });

  it("a still-running batch shows only what is already true", () => {
    // The route writes `{total}` alone at creation: a `converted: 0` before
    // anything ran would be a fabricated measurement (the absent-is-not-zero
    // rule), so the two counts appear only once the processor has recounted.
    const summary = summariseTaskResult("imageWebpConversion", json({ total: 20 }));
    expect(keys(summary)).toEqual(["imagesTotal"]);
    expect(summary?.failures).toEqual([]);
  });

  it("a zero failure count is still shown, and quietly", () => {
    const summary = summariseTaskResult(
      "imageWebpConversion",
      json({ total: 2, converted: 2, failed: 0, failures: [] }),
    );
    expect(valueOf(summary, "imagesFailed")).toBe("0");
    expect(summary?.lines.find((l) => l.labelKey === "imagesFailed")?.tone).toBeUndefined();
  });

  it("a failure entry with neither identity nor message is dropped, not rendered blank", () => {
    const summary = summariseTaskResult(
      "imageWebpConversion",
      json({
        total: 2,
        converted: 1,
        failed: 1,
        failures: [{}, { message: "no id, but a reason" }, null, "nonsense"],
      }),
    );
    expect(summary?.failures).toEqual([{ subject: "", message: "no id, but a reason" }]);
  });
});

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
    expect(
      hasTaskDetails({ type: "imageWebpConversionItem", hasPrompt: false, hasResult: true }),
    ).toBe(false);
    expect(hasTaskDetails({ type: "pageSpeed", hasPrompt: false, hasResult: true })).toBe(false);
  });

  it("the WebP AGGREGATE row does have details", () => {
    // The arrow the item type must not draw is exactly the one the parent
    // must: its result is the only place the per-image failures are readable.
    expect(hasTaskDetails({ type: "imageWebpConversion", hasPrompt: false, hasResult: true })).toBe(
      true,
    );
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

// ── 9b. the alias — one type, two spellings ─────────────────────────────────

/**
 * The one-letter split this whole feature exists to kill (PLAN §B2), one layer
 * below where it was found: the registry is keyed by task type, so a RAW
 * lookup would silently never fire for the spelling the runners really create.
 * `TASK_TYPE_ALIASES` is imported from `task-labels.shared.ts` — one map, not
 * two — and BOTH entry points resolve through it.
 */
describe("the summariser registry resolves the task-type alias", () => {
  const ALT_TEXT_BLOB = json({ generatedAltTexts: { "0": "Blue mug" }, failedIndices: [1] });

  it("bulkAIGeneration reaches the summariser registered as bulkAiGeneration", () => {
    const aliased = summariseTaskResult("bulkAIGeneration", ALT_TEXT_BLOB);
    expect(aliased).not.toBeNull();
    expect(keys(aliased)).toEqual(["altTextsGenerated", "imagesFailed"]);
    // Both spellings answer identically — that is what "one entry" means.
    expect(summariseTaskResult("bulkAiGeneration", ALT_TEXT_BLOB)).toEqual(aliased);
  });

  it("hasTaskDetails answers about the same type the summary does", () => {
    expect(hasTaskDetails({ type: "bulkAIGeneration", hasPrompt: false, hasResult: true })).toBe(
      true,
    );
    expect(hasTaskDetails({ type: "bulkAiGeneration", hasPrompt: false, hasResult: true })).toBe(
      true,
    );
  });
});

// ── 9c. bulkAiGeneration: two runners under one type ────────────────────────

describe("summariseTaskResult — bulkAiGeneration carries two blobs", () => {
  it("the notification-title generator: {generated, failed}", () => {
    const summary = summariseTaskResult("bulkAiGeneration", json({ generated: 18, failed: 2 }));
    expect(summary?.lines).toEqual([
      { labelKey: "generated", value: "18" },
      { labelKey: "failed", value: "2", tone: "critical" },
    ]);
    expect(summary?.failures).toEqual([]);
  });

  it("the bulk alt-text generator counts the payload and drops it", () => {
    const summary = summariseTaskResult(
      "bulkAIGeneration",
      json({
        generatedAltTexts: { "0": "Blue mug", "1": "  ", "2": "Red mug" },
        failedIndices: [],
      }),
    );
    // The generated TEXTS are a payload, never a summary — only how many
    // landed, and a blank one did not.
    expect(summary?.lines).toEqual([
      { labelKey: "altTextsGenerated", value: "2" },
      { labelKey: "imagesFailed", value: "0" },
    ]);
    expect(JSON.stringify(summary)).not.toContain("Blue mug");
  });

  it("failedIndices are the only record of WHICH images failed, and count from 1", () => {
    const summary = summariseTaskResult(
      "bulkAIGeneration",
      json({ generatedAltTexts: { "0": "Blue mug" }, failedIndices: [1, 3] }),
    );
    expect(summary?.lines).toContainEqual({
      labelKey: "imagesFailed",
      value: "2",
      tone: "critical",
    });
    // Stored zero-based, read one-based — the `altText_<n>` rule.
    expect(summary?.failures).toEqual([
      { subject: "Image 2", message: "", parts: { rowType: "image", rowId: "2" } },
      { subject: "Image 4", message: "", parts: { rowType: "image", rowId: "4" } },
    ]);
  });

  it("the second alt-text writer carries no failedIndices, and none is invented", () => {
    // alt-text.action.ts L316 writes the map alone.
    const summary = summariseTaskResult(
      "bulkAIGeneration",
      json({ generatedAltTexts: { "0": "Blue mug", "1": "Red mug" } }),
    );
    expect(summary?.lines).toEqual([{ labelKey: "altTextsGenerated", value: "2" }]);
    expect(keys(summary)).not.toContain("imagesFailed");
    expect(summary?.failures).toEqual([]);
  });

  it("garbage in either key is dropped rather than rendered", () => {
    const summary = summariseTaskResult(
      "bulkAIGeneration",
      json({ generatedAltTexts: ["a"], failedIndices: [0, "x", null] }),
    );
    // An ARRAY is not the runner's map, so it is not counted at all.
    expect(keys(summary)).toEqual(["imagesFailed"]);
    expect(summary?.failures).toHaveLength(1);
    expect(summariseTaskResult("bulkAiGeneration", json({ other: 1 }))).toBeNull();
  });
});

// ── 9d. the crawl's external-link pass and its failed runs ──────────────────

describe("summariseTaskResult — seoCrawl external links", () => {
  it("omits all three lines when every one of them is 0", () => {
    // `AISettings.seoCrawlExternalLinks` off writes honest zeros, and the blob
    // carries no flag saying so — "found 0 / checked 0 / dead 0" then reads as
    // "your shop links nowhere and nothing is broken".
    const summary = summariseTaskResult(
      "seoCrawl",
      json({
        status: "ok",
        pagesCrawled: 12,
        externalFound: 0,
        externalChecked: 0,
        externalBroken: 0,
      }),
    );
    expect(keys(summary)).toEqual(["pagesCrawled"]);
  });

  it("reports them as before as soon as one of them is not 0", () => {
    const summary = summariseTaskResult(
      "seoCrawl",
      json({ status: "ok", externalFound: 44, externalChecked: 40, externalBroken: 0 }),
    );
    expect(keys(summary)).toEqual(["externalFound", "externalChecked", "externalBroken"]);
    // A real 0 among real numbers is a measurement and stays.
    expect(valueOf(summary, "externalBroken")).toBe("0");
  });

  it("a dead-link count with unreached targets says so", () => {
    const summary = summariseTaskResult(
      "seoCrawl",
      json({
        status: "ok",
        externalFound: 500,
        externalChecked: 60,
        externalBroken: 1,
        externalUnchecked: 440,
        externalTimedOut: true,
      }),
    );
    expect(summary?.lines).toContainEqual({
      labelKey: "externalUnchecked",
      value: "440",
      tone: "warning",
    });
    expect(summary?.lines).toContainEqual({
      labelKey: "externalTimedOut",
      value: "",
      tone: "warning",
    });
  });

  it("neither qualifier appears when it says nothing", () => {
    const summary = summariseTaskResult(
      "seoCrawl",
      json({ externalFound: 4, externalUnchecked: 0, externalTimedOut: false }),
    );
    expect(keys(summary)).not.toContain("externalUnchecked");
    expect(keys(summary)).not.toContain("externalTimedOut");
  });
});

describe("summariseTaskResult — a run that failed measured nothing", () => {
  it("a failed crawl shows its reason and none of its eleven zeros", () => {
    const summary = summariseTaskResult(
      "seoCrawl",
      json({
        status: "failed",
        error: "invalid_domain",
        pagesCrawled: 0,
        totalDiscovered: 0,
        pagesOk: 0,
        pagesBroken: 0,
        pagesServerError: 0,
        pagesBlocked: 0,
        orphanCount: 0,
        headDriftCount: 0,
        externalFound: 0,
        externalChecked: 0,
        externalBroken: 0,
      }),
    );
    expect(summary?.lines).toEqual([
      { labelKey: "crawlFailedReason", value: "invalid_domain", tone: "critical" },
    ]);
  });

  it("a failed crawl without a stored reason still says it failed", () => {
    const summary = summariseTaskResult("seoCrawl", json({ status: "failed", pagesCrawled: 0 }));
    expect(summary?.lines).toEqual([
      { labelKey: "crawlFailedReason", value: "", tone: "critical" },
    ]);
  });

  it("seoAudit suppresses a score nothing was measured for", () => {
    // Every locale scan failed — seo-audit.handler.ts L230-236 writes zeros.
    const summary = summariseTaskResult(
      "seoAudit",
      json({ averageScore: 0, totalScanned: 0, totalAvailable: 0, capped: false }),
    );
    expect(keys(summary)).toEqual(["itemsScanned", "itemsAvailable"]);
    expect(valueOf(summary, "itemsScanned")).toBe("0");
  });

  it("a real score over a real scan is untouched", () => {
    expect(
      keys(summariseTaskResult("seoAudit", json({ averageScore: 0, totalScanned: 12 }))),
    ).toEqual(["averageScore", "itemsScanned"]);
  });
});

// ── 9e. failure identity in pieces ──────────────────────────────────────────

describe("failure lines carry their identity in parts as well as in subject", () => {
  it("a bulk cell hands the renderer every piece it has", () => {
    const summary = summariseTaskResult(
      "seoBulkMeta",
      json({
        saved: 0,
        failures: [
          {
            rowId: "gid://shopify/Product/8123",
            rowType: "product",
            columnId: "field.seoTitle",
            locale: "fr",
            marketId: "gid://shopify/Market/42",
            message: "boom",
          },
        ],
      }),
    );
    // The subject is UNCHANGED — a consumer that ignores `parts` renders
    // exactly what it rendered before.
    expect(summary?.failures[0].subject).toBe(
      "Product 8123 · field.seoTitle [fr · Market 42]",
    );
    expect(summary?.failures[0].parts).toEqual({
      rowType: "product",
      rowId: "8123",
      columnId: "field.seoTitle",
      locale: "fr",
      marketId: "42",
    });
  });

  it("a piece the blob does not carry is absent, never asserted", () => {
    const summary = summariseTaskResult(
      "bulkEditorTranslate",
      json({ failures: [{ rowId: "gid://shopify/Page/55", message: "pageUpdate failed" }] }),
    );
    // No rowType travelled: the GID's own type segment names the row.
    expect(summary?.failures[0].parts).toEqual({ rowType: "Page", rowId: "55" });
  });

  it("a non-GID row id is passed through as it stands", () => {
    const summary = summariseTaskResult(
      "seoBulkMeta",
      json({ failures: [{ rowId: "refund-policy", rowType: "policy", message: "x" }] }),
    );
    expect(summary?.failures[0].parts).toEqual({ rowType: "policy", rowId: "refund-policy" });
  });

  it("seoBulkFix hands over its {type, id} too", () => {
    const summary = summariseTaskResult(
      "seoBulkFix",
      json({
        failed: [{ type: "product", id: "gid://shopify/Product/8123", error: "gone" }],
      }),
    );
    expect(summary?.failures[0].subject).toBe("Product 8123");
    expect(summary?.failures[0].parts).toEqual({ rowType: "product", rowId: "8123" });
  });
});

// ── 9f. the registry is not an ordinary object ──────────────────────────────

describe("the registry has no prototype", () => {
  it("an inherited property is not a task type", () => {
    for (const inherited of ["constructor", "toString", "hasOwnProperty", "valueOf"]) {
      expect(hasTaskDetails({ type: inherited, hasPrompt: false, hasResult: true })).toBe(false);
      expect(summariseTaskResult(inherited, json({ saved: 1 }))).toBeNull();
    }
  });
});

// ── 10. the emitted vocabulary ──────────────────────────────────────────────

/**
 * Every `labelKey` a summariser can emit, collected from a maximal blob per
 * type. The list is pinned here rather than checked against `app/i18n/en.ts`:
 * importing the bundle makes this file fail for edits that have nothing to do
 * with this module. A new labelKey therefore has to be added HERE and to the
 * three i18n files — which is what makes adding one a deliberate act.
 * `task-i18n-parity.test.ts` is the other half: it imports the three real
 * bundles and proves every emitted key is really translated in all of them.
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
        externalUnchecked: 1,
        externalTimedOut: true,
      },
    ],
    // A failed run reports its reason and nothing else.
    ["seoCrawl", { status: "failed", error: "invalid_domain", pagesCrawled: 0 }],
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
    ["bulkAiGeneration", { generated: 1, failed: 1 }],
    ["bulkAIGeneration", { generatedAltTexts: { "0": "x" }, failedIndices: [1] }],
    ["aiDiscoveryIntro", { file: "llms", chars: 1 }],
    ["imageWebpConversion", { total: 1, converted: 1, failed: 1, failures: [] }],
    ["translation", { translated: 1, total: 1 }],
    ["translation", { retranslated: 1, purged: 1 }],
    ["translation", { translatedCount: 1, failedCount: 1 }],
    ["bulkTranslation", { synced: 1, failed: 1, total: 1 }],
    [
      "bulkTranslation",
      {
        locales: ["fr"],
        savedLocales: ["fr"],
        targetLocales: ["fr"],
        failedLocales: ["it"],
        rejectedFields: { fr: ["seoTitle"] },
        skippedFields: { fr: ["handle"] },
      },
    ],
    ["bulkTranslation", { translations: { title: "x" }, targetLocale: "fr" }],
    ["bulkTranslation", { translations: { fr: "x" }, fieldType: "title" }],
  ];

  const EXPECTED = [
    "altTextsGenerated",
    "applied",
    "attempted",
    "averageScore",
    "batches",
    "capped",
    "characters",
    "crawlCapped",
    "crawlFailedReason",
    "demotedToSecondary",
    "errors",
    "externalBroken",
    "externalChecked",
    "externalFound",
    "externalTimedOut",
    "externalUnchecked",
    "failed",
    "failedBatches",
    "failedFields",
    "fieldsRejected",
    "fieldsSkipped",
    "fieldsTranslated",
    "file",
    "galleryVideoProducts",
    "galleryVideosMissingDate",
    "galleryVideosVimeo",
    "generated",
    "headDrift",
    "imagesConverted",
    "imagesFailed",
    "imagesTotal",
    "internalLinksCapped",
    "items",
    "itemsAvailable",
    "itemsScanned",
    "keywords",
    "localesFailed",
    "localesSaved",
    "localesTargeted",
    "localesTranslated",
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
    "savedRows",
    "skipped",
    "skippedDrafts",
    "skippedHandles",
    "skippedOverCap",
    "sourcesScanned",
    "succeeded",
    "suggestionsCreated",
    "suggestionsUpdated",
    "synced",
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
