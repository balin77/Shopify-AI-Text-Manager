/**
 * Pure SEO score core (Phase 0.3 of SEO_TAB_IMPLEMENTATION_PLAN.md).
 *
 * The scoring logic used to live inline in [SeoSidebar.tsx] as a `useMemo` that
 * produced *translated* strings, so it could only run in the browser. The store-
 * wide Audit-Dashboard (Phase 1) needs the exact same scoring server-side, so the
 * logic is extracted here as a framework-free, code-based function.
 *
 * Contract:
 *  - Output carries i18n **codes**, never translated strings — the UI maps them to
 *    `t.seo.issues.*` / `t.seo.recommendations.*` (the canonical, pre-existing
 *    Finding strings). This keeps Sidebar and Dashboard byte-identical.
 *  - Weights / thresholds are a 1:1 lift from the old `useMemo`
 *    (Title 15 / SEO-Title 15 / Description 20 / Meta 20 / Alt 30; normalization
 *    `round(score / maxScore * 100)`). The ≥70 / ≥40 tone thresholds live here too,
 *    as the single source for both Sidebar and Dashboard.
 *  - `seoTitleEffectiveLimit` (the suffix-adjusted budget) is computed by the
 *    **caller** — some callers (app.seo._index.tsx, SeoSidebar.tsx) still inline
 *    `suffix ? 60 - suffix.length : 60`; new/updated callers should use the
 *    exported `seoTitleEffectiveLimit()` helper below instead, which floors the
 *    result so a long suffix can't drive it to zero/negative. computeSeoScore
 *    also clamps defensively so an un-migrated caller's raw `<= 0` value can't
 *    make every seoTitle score as "too long".
 */

export type SeoSeverity = "error" | "warning" | "success";

/** A single scored finding — `code` is an i18n key under `t.seo.issues.*`. */
export interface SeoScoreFinding {
  code: string;
  severity: SeoSeverity;
  /** Points this finding contributed to the raw score (before normalization). */
  points: number;
  /** Placeholder values for the i18n message (e.g. `{ count: 3 }`). */
  data?: Record<string, string | number>;
}

export interface SeoScoreInput {
  title: string;
  description: string;
  seoTitle: string;
  metaDescription: string;
  imagesWithAlt?: number;
  totalImages?: number;
  /** Skip description from scoring (e.g. blog containers have no body). */
  excludeDescription?: boolean;
  /** Skip image alt-text from scoring (e.g. blog containers have no images). */
  excludeImages?: boolean;
  /** Effective SEO-title limit; defaults to 60. Caller subtracts the suffix length. */
  seoTitleEffectiveLimit?: number;
}

export interface SeoScoreResult {
  /** Normalized 0–100 score. */
  score: number;
  /** Findings in evaluation order — `code` keys map to `t.seo.issues.*`. */
  findings: SeoScoreFinding[];
  /** Recommendation codes — keys map to `t.seo.recommendations.*`. */
  recommendations: string[];
}

/** Default SEO title character budget when no shop-name suffix is configured. */
export const DEFAULT_SEO_TITLE_LIMIT = 60;

/** Floor for the suffix-adjusted SEO-title budget (see seoTitleEffectiveLimit). */
const MIN_SEO_TITLE_LIMIT = 20;

/**
 * Suffix-adjusted SEO-title character budget. Callers historically inlined
 * `suffix ? 60 - suffix.length : 60` (app.seo._index.tsx, SeoSidebar.tsx) with
 * no floor, so a long enough shop-name suffix drove the limit to zero or
 * negative — which would make EVERY seoTitle "too long" (limit <= 0 means no
 * length can satisfy `0 < length <= limit`). Clamp to a sensible minimum
 * instead. Callers should switch to this helper instead of the inline formula.
 */
export function seoTitleEffectiveLimit(suffix: string | null | undefined): number {
  const suffixLength = suffix?.length ?? 0;
  return Math.max(MIN_SEO_TITLE_LIMIT, DEFAULT_SEO_TITLE_LIMIT - suffixLength);
}

// Named HTML entities stripHtml() decodes. Kept intentionally small — the
// common punctuation entities plus the German umlaut entities this app's
// merchant content regularly contains (descriptions/meta authored in German).
const NAMED_HTML_ENTITIES: Record<string, string> = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&auml;": "ä",
  "&ouml;": "ö",
  "&uuml;": "ü",
  "&Auml;": "Ä",
  "&Ouml;": "Ö",
  "&Uuml;": "Ü",
  "&szlig;": "ß",
};

/**
 * Strip HTML down to plain text for scoring/matching. Shared by seo-score.ts
 * and keywords.service.ts so "how long is the description really" and
 * "does the keyword appear in the body" never disagree.
 *
 * Tags are replaced with a SPACE (not "") so adjacent block elements don't
 * concatenate into one word (e.g. `<p>A</p><p>B</p>` → "A B", not "AB").
 * Numeric entities (decimal + hex) and the common named entities above are
 * decoded, whitespace is collapsed, and the result trimmed — so HTML that is
 * only tags/whitespace/`&nbsp;` correctly strips down to "" (empty).
 */
export function stripHtml(html: string | null | undefined): string {
  if (!html) return "";
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&[a-zA-Z]+;/g, (entity) => NAMED_HTML_ENTITIES[entity] ?? entity)
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Compute the SEO score for one resource. Pure: no i18n, no DOM, no Shopify.
 * Mirrors the former SeoSidebar `useMemo` exactly so Sidebar and Dashboard agree.
 */
export function computeSeoScore(input: SeoScoreInput): SeoScoreResult {
  const {
    title,
    description,
    seoTitle,
    metaDescription,
    imagesWithAlt = 0,
    totalImages = 0,
    excludeDescription = false,
    excludeImages = false,
    seoTitleEffectiveLimit: rawSeoTitleEffectiveLimit = DEFAULT_SEO_TITLE_LIMIT,
  } = input;

  // Defensive clamp: callers still compute the suffix-adjusted limit inline
  // (see seoTitleEffectiveLimit() above, which they should switch to) — a
  // limit <= 0 must not silently mean "any seoTitle length is fine".
  const seoTitleEffectiveLimit =
    rawSeoTitleEffectiveLimit > 0 ? rawSeoTitleEffectiveLimit : MIN_SEO_TITLE_LIMIT;

  const findings: SeoScoreFinding[] = [];
  let score = 0;
  let maxScore = 0;

  // 1. Title length (15 points max)
  maxScore += 15;
  const titleLength = title.length;
  if (titleLength >= 30 && titleLength <= 70) {
    score += 15;
    findings.push({ code: "titleLengthGood", severity: "success", points: 15 });
  } else if (titleLength < 30) {
    findings.push({ code: "titleTooShort", severity: "warning", points: 0 });
  } else {
    findings.push({ code: "titleTooLong", severity: "warning", points: 0 });
  }

  // 2. SEO Title (15 points max) — limit adjusted for shop-name suffix
  maxScore += 15;
  const seoTitleLength = seoTitle.length;
  if (seoTitleLength > 0 && seoTitleLength <= seoTitleEffectiveLimit) {
    score += 15;
    findings.push({ code: "seoTitleGood", severity: "success", points: 15 });
  } else if (seoTitleLength === 0) {
    findings.push({ code: "seoTitleMissing", severity: "error", points: 0 });
  } else {
    findings.push({ code: "seoTitleTooLong", severity: "warning", points: 0 });
  }

  // 3. Description length (20 points max) — skipped for content without body
  let descriptionLength = 0;
  if (!excludeDescription) {
    maxScore += 20;
    descriptionLength = stripHtml(description).length;
    if (descriptionLength >= 150) {
      score += 20;
      findings.push({ code: "descriptionGood", severity: "success", points: 20 });
    } else if (descriptionLength === 0) {
      findings.push({ code: "descriptionMissing", severity: "error", points: 0 });
    } else {
      findings.push({ code: "descriptionTooShort", severity: "warning", points: 0 });
    }
  }

  // 4. Meta Description (20 points max)
  maxScore += 20;
  const metaDescLength = metaDescription.length;
  if (metaDescLength >= 120 && metaDescLength <= 160) {
    score += 20;
    findings.push({ code: "metaDescriptionGood", severity: "success", points: 20 });
  } else if (metaDescLength === 0) {
    findings.push({ code: "metaDescriptionMissing", severity: "error", points: 0 });
  } else if (metaDescLength < 120) {
    findings.push({ code: "metaDescriptionTooShort", severity: "warning", points: 0 });
  } else {
    findings.push({ code: "metaDescriptionTooLong", severity: "warning", points: 0 });
  }

  // 5. Image Alt Texts (30 points max) — skipped for content without images
  if (!excludeImages && totalImages > 0) {
    maxScore += 30;
    const imageScore = Math.round((imagesWithAlt / totalImages) * 30);
    score += imageScore;
    if (imagesWithAlt === totalImages) {
      findings.push({ code: "allImagesHaveAlt", severity: "success", points: 30 });
    } else {
      findings.push({
        code: "someImagesMissingAlt",
        severity: "warning",
        points: imageScore,
        data: { count: totalImages - imagesWithAlt },
      });
    }
  }

  const normalizedScore = maxScore > 0 ? Math.round((score / maxScore) * 100) : 0;

  // Recommendations (codes under t.seo.recommendations.*)
  const recommendations: string[] = [];
  if (titleLength < 30) recommendations.push("expandTitle");
  if (titleLength > 70) recommendations.push("shortenTitle");
  if (seoTitleLength === 0) recommendations.push("addSeoTitle");
  if (seoTitleLength > seoTitleEffectiveLimit) recommendations.push("shortenSeoTitle");
  if (!excludeDescription && descriptionLength < 150) recommendations.push("expandDescription");
  if (metaDescLength === 0) recommendations.push("addMetaDescription");
  if (metaDescLength < 120) recommendations.push("expandMetaDescription");
  if (metaDescLength > 160) recommendations.push("shortenMetaDescription");
  if (!excludeImages && totalImages > 0 && imagesWithAlt < totalImages) {
    recommendations.push("addImageAlt");
  }

  return { score: normalizedScore, findings, recommendations };
}

/** Tone for a score — the single source of the ≥70 / ≥40 thresholds. */
export function scoreTone(score: number): "success" | "warning" | "critical" {
  if (score >= 70) return "success";
  if (score >= 40) return "warning";
  return "critical";
}

/** i18n key (under t.seo.scoreLabels) for a score band. */
export function scoreLabelKey(score: number): "good" | "medium" | "poor" {
  if (score >= 70) return "good";
  if (score >= 40) return "medium";
  return "poor";
}

/**
 * Tone for a Polaris <ProgressBar>, whose `tone` union is
 * `highlight | primary | success | critical` — it has NO `warning` (unlike
 * <Badge>). Mid-band maps to `highlight` so the bar still renders distinctly
 * instead of silently falling back to the default when given an invalid tone.
 */
export function progressTone(score: number): "success" | "highlight" | "critical" {
  if (score >= 70) return "success";
  if (score >= 40) return "highlight";
  return "critical";
}
