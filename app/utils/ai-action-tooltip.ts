/**
 * Tooltip copy for the two AI text buttons (✨ generate/improve, 🎨 format).
 *
 * Both AIEditableField and AIEditableHTMLField render the same pair, and the ✨
 * button relabels itself between "generate" and "improve" from the same two
 * inputs. Resolving the string here keeps the two components from drifting apart
 * — and keeps the label/tooltip pair in sync, which is the failure that would
 * actually confuse a merchant (a button saying "improve" explained as "writes a
 * new text").
 *
 * `disableGeneration` is set for theme content, which has no product context to
 * write from: there the ✨ button can only ever improve what is already there.
 */

interface TooltipStrings {
  products?: {
    aiGenerateTooltip?: string;
    aiImproveTooltip?: string;
    aiImproveEmptyTooltip?: string;
    formatWithAITooltip?: string;
    formatWithAIEmptyTooltip?: string;
  };
}

export function aiActionTooltip(
  t: TooltipStrings,
  action: "generate" | "format",
  ctx: { hasValue: boolean; disableGeneration?: boolean },
): string | undefined {
  const p = t.products;
  const { hasValue, disableGeneration = false } = ctx;

  if (action === "format") {
    return hasValue
      ? p?.formatWithAITooltip
      : p?.formatWithAIEmptyTooltip;
  }

  // Generation is blocked and the field is empty → nothing to improve yet.
  if (disableGeneration && !hasValue) return p?.aiImproveEmptyTooltip;

  // Same condition the button label uses, so the two can never disagree.
  return disableGeneration || hasValue ? p?.aiImproveTooltip : p?.aiGenerateTooltip;
}
