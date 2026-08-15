import { describe, it, expect } from "vitest";
import { aiActionTooltip } from "~/utils/ai-action-tooltip";
import { en } from "~/i18n/en";

/**
 * The ✨ button relabels itself between "generate" and "improve"; the tooltip
 * must follow the SAME condition, or a merchant reads "improve" explained as
 * "writes a new text".
 */

const t = en as unknown as Parameters<typeof aiActionTooltip>[0];

describe("aiActionTooltip", () => {
  it("explains writing from scratch on an empty field", () => {
    expect(aiActionTooltip(t, "generate", { hasValue: false })).toBe(
      en.products.aiGenerateTooltip,
    );
  });

  it("explains rewriting once the field has content", () => {
    expect(aiActionTooltip(t, "generate", { hasValue: true })).toBe(en.products.aiImproveTooltip);
  });

  it("follows the label when generation is disabled but content exists", () => {
    // Theme content: the button reads "improve" even though the field is filled
    // through a different path — the tooltip must not claim it writes anew.
    expect(aiActionTooltip(t, "generate", { hasValue: true, disableGeneration: true })).toBe(
      en.products.aiImproveTooltip,
    );
  });

  it("says why the button is dead for empty theme content", () => {
    expect(aiActionTooltip(t, "generate", { hasValue: false, disableGeneration: true })).toBe(
      en.products.aiImproveEmptyTooltip,
    );
  });

  it("describes formatting, and why it is unavailable without text", () => {
    expect(aiActionTooltip(t, "format", { hasValue: true })).toBe(en.products.formatWithAITooltip);
    expect(aiActionTooltip(t, "format", { hasValue: false })).toBe(
      en.products.formatWithAIEmptyTooltip,
    );
  });

  it("returns undefined rather than a placeholder when a string is missing", () => {
    expect(aiActionTooltip({}, "format", { hasValue: true })).toBeUndefined();
  });
});
