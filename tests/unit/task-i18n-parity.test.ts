/**
 * PLAN_TASK_LIST_CLARITY §5 P5 — the cross-check between the task modules and
 * the three language bundles.
 *
 * `task-details.shared.ts` emits a `labelKey`, and `TaskDetailsPanel` looks it
 * up under `t.tasks.resultLabels`. A key that exists in the summariser and not
 * in the bundle renders as NOTHING beside a number — a merchant reads "7" with
 * no word in front of it. That failure is invisible to `typecheck` (the bundle
 * is `any` at every call site), invisible to the summariser's own tests (they
 * never open a bundle), and it appears in ONE language at a time, which is the
 * one nobody developing this app is reading.
 *
 * So this file imports the three REAL bundles and pins both directions:
 *
 *  1. Every labelKey any summariser can emit is translated in en, de AND es.
 *  2. `taskType`, `resourceType`, `fieldType` and `resultLabels` carry
 *     IDENTICAL key sets in the three bundles — the drift that hides a missing
 *     German label behind a present English one.
 *
 * The maximal blobs below are deliberately a second, compact copy of the ones
 * in `task-details.test.ts`: that file pins the exact emitted VOCABULARY (a new
 * labelKey has to be added there on purpose), this one pins that whatever is
 * emitted is translated. Neither file may import the other — a test file
 * imported by a test file runs its whole suite twice.
 */

import { describe, it, expect } from "vitest";
import { de } from "~/i18n/de";
import { en } from "~/i18n/en";
import { es } from "~/i18n/es";
import { summariseTaskResult } from "~/services/tasks/task-details.shared";

const BUNDLES: [string, any][] = [
  ["en", en],
  ["de", de],
  ["es", es],
];

/** One maximal blob per registered summariser branch. */
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
  ["seoCrawl", { status: "failed", error: "invalid_domain" }],
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
  ["altTextTemplateApply", { applied: 1, attempted: 1, errors: ["x (Position 1): boom"] }],
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
  ["distributeKeywords", { stage: "apply", applied: 1, demotedToSecondary: 1, skipped: 1, errors: 1 }],
  ["seoRobotsAdvice", { advised: 1, total: 1 }],
  ["aiDiscoveryIntro", { file: "llms", chars: 1 }],
  // Both runners under the one type (the second spelling resolves through
  // TASK_TYPE_ALIASES, which is the point of listing it as it is created).
  ["bulkAiGeneration", { generated: 1, failed: 1 }],
  ["bulkAIGeneration", { generatedAltTexts: { "0": "x" }, failedIndices: [1] }],
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
  // The countable locale shapes: a map whose entries hold something, and a
  // per-locale translation map that says its keys are locales. A bare `locales`
  // key list emits no count at all — it substantiates none.
  ["bulkTranslation", { translations: { fr: "x" }, fieldType: "title" }],
];

const EMITTED_LABEL_KEYS = (() => {
  const out = new Set<string>();
  for (const [type, blob] of MAXIMAL) {
    const summary = summariseTaskResult(type, JSON.stringify(blob));
    for (const line of summary?.lines ?? []) out.add(line.labelKey);
  }
  return [...out].sort();
})();

const keysOf = (bundle: any, section: string): string[] =>
  Object.keys(bundle?.tasks?.[section] ?? {}).sort();

describe("task result labels are translated everywhere", () => {
  it("the maximal blobs really emit something (otherwise this file proves nothing)", () => {
    // A summariser rename would otherwise turn every assertion below into a
    // vacuous pass over an empty set.
    expect(EMITTED_LABEL_KEYS.length).toBeGreaterThan(50);
  });

  for (const [name, bundle] of BUNDLES) {
    it(`${name} carries every labelKey a summariser can emit`, () => {
      const labels = bundle?.tasks?.resultLabels ?? {};
      const missing = EMITTED_LABEL_KEYS.filter(
        (key) => typeof labels[key] !== "string" || labels[key].trim() === "",
      );
      expect(missing).toEqual([]);
    });
  }

  it("no bundle carries a resultLabel no summariser emits", () => {
    // The other direction: a key left behind by a renamed summariser is dead
    // weight in three files, and the next reader cannot tell it from a live
    // one.
    for (const [name, bundle] of BUNDLES) {
      const unused = keysOf(bundle, "resultLabels").filter(
        (key) => !EMITTED_LABEL_KEYS.includes(key),
      );
      expect(unused, `${name} has unused resultLabels`).toEqual([]);
    }
  });
});

describe("the three bundles carry identical task vocabularies", () => {
  // A key present in en and absent in de renders as an empty string in German
  // — a card heading that is simply not there, in the language most of this
  // app's merchants read.
  for (const section of ["taskType", "resourceType", "fieldType", "resultLabels"]) {
    it(`tasks.${section} has the same keys in en, de and es`, () => {
      const reference = keysOf(en, section);
      expect(reference.length).toBeGreaterThan(0);
      expect(keysOf(de, section)).toEqual(reference);
      expect(keysOf(es, section)).toEqual(reference);
    });
  }

  it("every entry in those sections is a non-empty string", () => {
    for (const [name, bundle] of BUNDLES) {
      for (const section of ["taskType", "resourceType", "fieldType", "resultLabels"]) {
        for (const [key, value] of Object.entries(bundle?.tasks?.[section] ?? {})) {
          expect(typeof value, `${name}.tasks.${section}.${key}`).toBe("string");
          expect(String(value).trim(), `${name}.tasks.${section}.${key}`).not.toBe("");
        }
      }
    }
  });
});
