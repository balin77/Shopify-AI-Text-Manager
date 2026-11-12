/**
 * Per-model output ceilings (PLAN_BULK_TRANSLATE_BATCHING 3.2): an unknown
 * model gets the historic 8192, never more; every rule says where it comes from.
 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  maxOutputTokensFor,
  modelLimitRules,
} from "~/config/ai-model-limits";
import { TRANSLATION_BATCH } from "~/config/constants";
import { packageBudgetFor } from "~/services/bulk-editor/translate-packages.shared";

describe("maxOutputTokensFor", () => {
  it("the default IS the historic app-wide max_tokens", () => {
    expect(DEFAULT_MAX_OUTPUT_TOKENS).toBe(TRANSLATION_BATCH.AI_MAX_OUTPUT_TOKENS);
  });

  it("an unknown model, an unknown provider and an empty id all get 8192", () => {
    expect(maxOutputTokensFor("claude", "claude-future-9")).toBe(8192);
    expect(maxOutputTokensFor("huggingface", "any/model")).toBe(8192);
    expect(maxOutputTokensFor("openai", "")).toBe(8192);
    expect(maxOutputTokensFor(undefined, "gpt-4o")).toBe(8192);
    expect(maxOutputTokensFor("grok", "grok-4")).toBe(8192);
  });

  it("known models read their table value, case-insensitively", () => {
    expect(maxOutputTokensFor("claude", "Claude-Sonnet-4-5")).toBe(32_000);
    expect(maxOutputTokensFor("openai", "gpt-4o-mini")).toBe(16_384);
    expect(maxOutputTokensFor("openai", "gpt-4-turbo")).toBe(4096);
    expect(maxOutputTokensFor("gemini", "gemini-2.0-flash")).toBe(8192);
    expect(maxOutputTokensFor("gemini", "gemini-2.5-pro")).toBe(32_000);
  });

  it("a rule only answers for its own provider", () => {
    expect(maxOutputTokensFor("openai", "claude-sonnet-4-5")).toBe(8192);
  });

  it("every rule is positive and carries its source", () => {
    for (const rule of modelLimitRules()) {
      expect(rule.tokens).toBeGreaterThan(0);
      expect(rule.source.length).toBeGreaterThan(10);
    }
  });
});

describe("the package budget cuts the ceiling by the margin, the timeout cap and the TPM rail", () => {
  it("unknown model: 8192 x 0.6 = 4915 planned output tokens", () => {
    expect(packageBudgetFor({ modelMaxOutput: 8192, bucketTpm: null }).outputTokens).toBe(4915);
  });
  it("a big model is capped at the synchronous 5000", () => {
    expect(packageBudgetFor({ modelMaxOutput: 32_000, bucketTpm: null }).outputTokens).toBe(5000);
  });
  it("the TPM rail is 80 % of the bucket", () => {
    expect(packageBudgetFor({ modelMaxOutput: 8192, bucketTpm: 40_000 }).totalTokens).toBe(32_000);
    expect(packageBudgetFor({ modelMaxOutput: 8192, bucketTpm: null }).totalTokens).toBeNull();
  });
});
