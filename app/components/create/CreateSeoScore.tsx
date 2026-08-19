/**
 * PLAN_CONTENT_CREATION §2.5b — the SEO score, live, while the item is being
 * created rather than after.
 *
 * ── Its inputs are not assumption-free ──────────────────────────────────────
 * `computeSeoScore` is a pure function, but feeding it defaults produces a
 * number that DISAGREES with the sidebar the merchant will see thirty seconds
 * later — and a score that changes on its own, without the text changing, is
 * worse than no score. Three inputs carry that:
 *
 *   - `limits` — the shop's merchant-editable caps. Read from the same
 *     context the sidebar reads, not re-fetched.
 *   - `seoTitleEffectiveLimit` — the budget MINUS the shop-name suffix Shopify
 *     appends. The shared helper floors it, so a long suffix cannot drive it
 *     to zero.
 *   - `excludeImages` — while no image is attached, the "images without alt
 *     text" finding is a permanent red mark on a form where the merchant may
 *     have deliberately chosen not to add one. It is excluded until there IS
 *     an image, and then it is a finding they can actually resolve.
 *
 * `excludeDescription` follows the same rule for a resource whose create form
 * has no long-text field at all (a blog): scoring a field that does not exist
 * measures nothing.
 */

import { useMemo } from "react";
import { BlockStack, Badge, Box, InlineStack, Text } from "@shopify/polaris";
import { useSeoSettings } from "../../contexts/SeoSettingsContext";
import {
  computeSeoScore,
  scoreTone,
  seoTitleEffectiveLimit,
  stripHtml,
} from "../../utils/seo-score";

export interface CreateSeoScoreProps {
  title: string;
  /** Raw create-form value; may be HTML. */
  description: string;
  seoTitle: string;
  metaDescription: string;
  /** True once an image is attached — see the header. */
  hasImage: boolean;
  /** True when the merchant filled the image's alt text (or the AI did). */
  imageHasAlt: boolean;
  /** False for a resource whose form has no long text at all. */
  hasDescriptionField: boolean;
  t: {
    heading?: string;
    /** Sentence with a `{n}` placeholder, e.g. "{n} of 100". */
    outOf?: string;
    issues?: Record<string, string>;
  };
}

function interpolate(template: string, data?: Record<string, unknown>): string {
  if (!data) return template;
  let out = template;
  for (const [key, value] of Object.entries(data)) out = out.replace(`{${key}}`, String(value));
  return out;
}

export function CreateSeoScore({
  title,
  description,
  seoTitle,
  metaDescription,
  hasImage,
  imageHasAlt,
  hasDescriptionField,
  t,
}: CreateSeoScoreProps) {
  const { seoTitleSuffix, seoLimits } = useSeoSettings();

  const result = useMemo(
    () =>
      computeSeoScore({
        title,
        // The create form's long text is HTML. The scorer counts characters,
        // so tag soup would inflate every length finding.
        description: stripHtml(description),
        seoTitle,
        metaDescription,
        totalImages: hasImage ? 1 : 0,
        imagesWithAlt: hasImage && imageHasAlt ? 1 : 0,
        excludeImages: !hasImage,
        excludeDescription: !hasDescriptionField,
        seoTitleEffectiveLimit: seoTitleEffectiveLimit(seoTitleSuffix, seoLimits ?? null),
        limits: seoLimits ?? null,
      }),
    [title, description, seoTitle, metaDescription, hasImage, imageHasAlt, hasDescriptionField, seoTitleSuffix, seoLimits],
  );

  // Nothing typed yet — a score of 0 on an untouched form reads as a
  // judgement rather than a measurement.
  if (!title.trim()) return null;

  // Only what the merchant can still act on IN this dialog. Successes belong
  // in the sidebar, where there is room for them.
  const problems = result.findings.filter((f) => f.severity !== "success");

  return (
    <Box background="bg-surface-secondary" padding="300" borderRadius="200">
      <BlockStack gap="200">
        <InlineStack gap="200" blockAlign="center">
          <Text as="h3" variant="headingSm">{t.heading || "SEO score"}</Text>
          <Badge tone={scoreTone(result.score)}>
            {interpolate(t.outOf || "{n} of 100", { n: result.score })}
          </Badge>
        </InlineStack>
        {problems.length > 0 && (
          <BlockStack gap="100">
            {problems.map((finding, index) => (
              <Text
                key={`${finding.code}-${index}`}
                as="p"
                variant="bodySm"
                tone={finding.severity === "error" ? "critical" : "subdued"}
              >
                {interpolate(t.issues?.[finding.code] ?? finding.code, finding.data)}
              </Text>
            ))}
          </BlockStack>
        )}
      </BlockStack>
    </Box>
  );
}
