/**
 * Character limit requirements for AI-generated content fields.
 *
 * Two shapes:
 *   - Human-readable string (e.g. "30-70 characters") injected into AI prompts
 *     so the model self-enforces the length.
 *   - Numeric per-field caps used by the SEO-optimized translation mode to
 *     paraphrase overflowing translations.
 *
 * Defaults live here; merchants on Pro+ can override via
 * `AISettings.seoLimits` (SEO tab). Callers pass the resolved override object
 * through — never read `AISettings` inside utility fns to keep this pure.
 */
export interface SeoLimits {
  titleMin: number;
  titleMax: number;
  seoTitleMin: number;
  seoTitleMax: number;
  metaDescMin: number;
  metaDescMax: number;
  handleMin: number;
  handleMax: number;
  altTextMin: number;
  altTextMax: number;
  descriptionMin: number;
}

export const DEFAULT_SEO_LIMITS: SeoLimits = {
  titleMin: 30,
  titleMax: 70,
  // Google flags very short SEO titles as "not descriptive" and often
  // rewrites them itself. 30 char is the widely-quoted lower bound (matches
  // the general titleMin) — a merchant can drop it to 1 in the SEO tab to
  // effectively disable the floor.
  seoTitleMin: 30,
  seoTitleMax: 60,
  metaDescMin: 120,
  metaDescMax: 160,
  handleMin: 50,
  handleMax: 70,
  altTextMin: 100,
  altTextMax: 125,
  descriptionMin: 150,
};

/**
 * Merge a stored `seoLimits` JSON blob against the defaults, dropping any
 * non-positive/non-finite values so a corrupt row can never widen limits past
 * what the merchant sees in the UI.
 */
export function resolveSeoLimits(
  stored: Partial<Record<keyof SeoLimits, unknown>> | null | undefined,
): SeoLimits {
  if (!stored || typeof stored !== "object") return { ...DEFAULT_SEO_LIMITS };
  const out: SeoLimits = { ...DEFAULT_SEO_LIMITS };
  for (const key of Object.keys(DEFAULT_SEO_LIMITS) as Array<keyof SeoLimits>) {
    const raw = stored[key];
    if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
      out[key] = Math.floor(raw);
    }
  }
  return out;
}

export interface CharacterLimitOptions {
  /**
   * Effective max for SEO title after subtracting Shopify's shop-name suffix.
   * When provided, wins over `limits.seoTitleMax` for the returned string
   * (matches the existing seoTitleSuffix behaviour).
   */
  seoTitleMaxChars?: number;
  /** Merchant overrides; defaults are applied for missing keys. */
  limits?: Partial<SeoLimits> | null;
}

/**
 * Returns a human-readable character limit requirement for a given field key,
 * or null if no limit applies. Backward-compatible: called with just a key,
 * returns the default limits. Pass `seoTitleMaxChars` (number, legacy) or an
 * options object to customise.
 */
export function getCharacterLimitRequirement(
  aiInstructionsKey: string,
  seoTitleMaxCharsOrOptions?: number | CharacterLimitOptions,
): string | null {
  const opts: CharacterLimitOptions =
    typeof seoTitleMaxCharsOrOptions === "number"
      ? { seoTitleMaxChars: seoTitleMaxCharsOrOptions }
      : seoTitleMaxCharsOrOptions ?? {};
  const l = resolveSeoLimits(opts.limits ?? null);
  const seoTitleMax = opts.seoTitleMaxChars ?? l.seoTitleMax;

  const limits: Record<string, string> = {
    // Titles
    productTitle: `${l.titleMin}-${l.titleMax} characters`,
    collectionTitle: `${l.titleMin}-${l.titleMax} characters`,
    blogTitle: `${l.titleMin}-${l.titleMax} characters`,
    pageTitle: `${l.titleMin}-${l.titleMax} characters`,

    // Descriptions
    productDescription: `minimum ${l.descriptionMin} characters`,
    collectionDescription: `minimum ${l.descriptionMin} characters`,
    blogDescription: `minimum ${l.descriptionMin} characters`,
    pageDescription: `minimum ${l.descriptionMin} characters`,
    policyDescription: `minimum ${l.descriptionMin} characters`,

    // SEO Titles (upper bound adjusted for shop-name suffix when applicable).
    // Skip the min in the human-readable hint when it's 1 (merchant disabled it)
    // so the prompt stays clean.
    productSeoTitle: l.seoTitleMin > 1
      ? `${l.seoTitleMin}-${seoTitleMax} characters`
      : `maximum ${seoTitleMax} characters`,
    collectionSeoTitle: l.seoTitleMin > 1
      ? `${l.seoTitleMin}-${seoTitleMax} characters`
      : `maximum ${seoTitleMax} characters`,
    blogSeoTitle: l.seoTitleMin > 1
      ? `${l.seoTitleMin}-${seoTitleMax} characters`
      : `maximum ${seoTitleMax} characters`,
    pageSeoTitle: l.seoTitleMin > 1
      ? `${l.seoTitleMin}-${seoTitleMax} characters`
      : `maximum ${seoTitleMax} characters`,

    // Meta Descriptions
    productMetaDesc: `${l.metaDescMin}-${l.metaDescMax} characters`,
    collectionMetaDesc: `${l.metaDescMin}-${l.metaDescMax} characters`,
    blogMetaDesc: `${l.metaDescMin}-${l.metaDescMax} characters`,
    pageMetaDesc: `${l.metaDescMin}-${l.metaDescMax} characters`,

    // URL Handles
    productHandle: `${l.handleMin}-${l.handleMax} characters`,
    collectionHandle: `${l.handleMin}-${l.handleMax} characters`,
    blogHandle: `${l.handleMin}-${l.handleMax} characters`,
    pageHandle: `${l.handleMin}-${l.handleMax} characters`,

    // Alt Text
    productAltText: `${l.altTextMin}-${l.altTextMax} characters`,
  };

  return limits[aiInstructionsKey] || null;
}

/**
 * Compose the final `customInstructions` string passed to the AI translation
 * service. In `"exact"` mode the base instructions pass through unchanged
 * (legal texts must not shrink). In `"seo_optimized"` mode a length-constraint
 * block is appended for the SEO-critical fields present in `fieldKeys`
 * (title / seoTitle / metaDescription / altText), so the AI paraphrases the
 * translation instead of overflowing the length cap.
 *
 * `fieldKeys` uses the raw keys `translateFields` / `translateBatchValues`
 * see (`title`, `seoTitle`, `metaDescription`, `body_html`, …).
 */
export function buildTranslateInstructions(
  baseInstructions: string | undefined | null,
  mode: "exact" | "seo_optimized",
  fieldKeys: string[],
  opts: CharacterLimitOptions = {},
): string | undefined {
  const base = baseInstructions?.trim() || undefined;
  if (mode !== "seo_optimized" || fieldKeys.length === 0) return base;

  const hints: string[] = [];
  const seen = new Set<string>();
  for (const key of fieldKeys) {
    if (seen.has(key)) continue;
    seen.add(key);
    const hint = getTranslationLengthHint(key, opts);
    if (hint) hints.push(`- ${key}: ${hint}`);
  }
  if (hints.length === 0) return base;

  const constraintsBlock =
    "SEO length constraints (paraphrase or condense wherever needed to stay within the cap — do not just cut):\n" +
    hints.join("\n");
  return base ? `${base}\n\n${constraintsBlock}` : constraintsBlock;
}

/**
 * Translation-side helper: map the raw field key used inside `translateFields`
 * (title, seoTitle, metaDescription, body_html, …) to a "max N characters"
 * hint appropriate for the SEO-optimized translation mode. Returns null for
 * fields with no length policy (bodies, URL slugs — slugs get their own path).
 *
 * `seoTitleMaxChars` mirrors the effective SEO-title cap after Shopify's shop
 * suffix has been subtracted.
 */
export function getTranslationLengthHint(
  fieldKey: string,
  opts: CharacterLimitOptions = {},
): string | null {
  const l = resolveSeoLimits(opts.limits ?? null);
  const seoTitleMax = opts.seoTitleMaxChars ?? l.seoTitleMax;
  switch (fieldKey) {
    case "title":
      return `keep under ${l.titleMax} characters`;
    case "seoTitle":
      return l.seoTitleMin > 1
        ? `${l.seoTitleMin}-${seoTitleMax} characters — paraphrase to fit`
        : `maximum ${seoTitleMax} characters — paraphrase to fit`;
    case "metaDescription":
      return `${l.metaDescMin}-${l.metaDescMax} characters — paraphrase to fit`;
    case "altText":
    case "alt":
      return `${l.altTextMin}-${l.altTextMax} characters`;
    default:
      return null;
  }
}
