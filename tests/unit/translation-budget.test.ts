import { describe, it, expect } from "vitest";
import { TRANSLATION_BATCH } from "~/config/constants";
import {
  estimateOutputChars,
  fitsOneRequest,
  localesPerRequest,
  outputBudgetChars,
  perLocaleSourceBudgetChars,
  planLocaleChunks,
} from "~/services/ai/translation-budget.shared";

/**
 * The hybrid batching rule: how much translation fits in ONE AI request.
 *
 * Pinned as RELATIONSHIPS, not as numbers — the constants are meant to be tuned
 * (a provider cap rises, the expansion factor is re-measured) and a test that
 * asserted "30 520" would fail on every tuning while catching none of the things
 * that actually break: an estimate that promises more than the model can emit,
 * a chunker that returns no chunks, or a locale count that stops mattering.
 */
describe("translation output budget", () => {
  it("never promises more output than the provider cap can emit", () => {
    // The bug this replaces: a hand-rounded 40 000-character threshold against a
    // 8 192-token cap, i.e. ~13 000 tokens of text asked of a model that can
    // emit 8 192. The estimate said "fits" for payloads that truncated, and a
    // truncated response is rejected wholesale by every caller.
    const capInChars =
      TRANSLATION_BATCH.AI_MAX_OUTPUT_TOKENS * TRANSLATION_BATCH.CHARS_PER_OUTPUT_TOKEN;
    expect(outputBudgetChars()).toBeLessThan(capInChars);
    expect(outputBudgetChars()).toBeGreaterThan(0);
  });

  it("counts the LOCALES, not just the length", () => {
    // One request returns every requested language, so the estimate is a
    // product. A rule that read only the text length would split a short field
    // across eight requests and let a medium one truncate.
    const source = 5_000;
    expect(estimateOutputChars(source, 4)).toBeGreaterThan(estimateOutputChars(source, 2));
    expect(estimateOutputChars(source, 1)).toBeGreaterThanOrEqual(source);
  });

  it("puts a short text into ONE request for every language", () => {
    const chunks = planLocaleChunks(["en", "es", "fr", "it"], 400);
    expect(chunks).toEqual([["en", "es", "fr", "it"]]);
  });

  it("falls back to one request PER LANGUAGE for a long text", () => {
    const long = perLocaleSourceBudgetChars();
    const chunks = planLocaleChunks(["en", "es", "fr", "it"], long);
    expect(chunks).toEqual([["en"], ["es"], ["fr"], ["it"]]);
  });

  it("groups the MIDDLE case — a medium text on a many-language shop", () => {
    // The case that silently truncated: not long enough to look dangerous, and
    // multiplied past the ceiling by the number of languages.
    const medium = Math.floor(perLocaleSourceBudgetChars() / 3);
    const chunks = planLocaleChunks(["en", "es", "fr", "it", "nl", "pt", "pl", "sv"], medium);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.length).toBeLessThan(8);
    // Nothing is lost or duplicated by the split.
    expect(chunks.flat()).toEqual(["en", "es", "fr", "it", "nl", "pt", "pl", "sv"]);
  });

  it("never plans ZERO locales per request, however long the text", () => {
    // `0` would make the chunk loop produce no chunks at all and translate
    // nothing while reporting success. A single locale that does not fit is the
    // caller's problem to solve by splitting FIELDS.
    expect(localesPerRequest(10_000_000)).toBe(1);
    expect(planLocaleChunks(["de"], 10_000_000)).toEqual([["de"]]);
  });

  it("has no chunk to plan for no locales", () => {
    expect(planLocaleChunks([], 100)).toEqual([]);
  });

  it("agrees with itself: what fits in one request is one chunk", () => {
    for (const [source, locales] of [[100, 2], [5_000, 4], [20_000, 8], [1, 12]] as const) {
      const list = Array.from({ length: locales }, (_, i) => `l${i}`);
      expect(planLocaleChunks(list, source).length === 1).toBe(fitsOneRequest(source, locales));
    }
  });
});
