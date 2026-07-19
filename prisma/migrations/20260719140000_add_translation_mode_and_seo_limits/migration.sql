-- Translation mode: "exact" (default) or "seo_optimized". Controls whether
-- the translate prompt appends per-field character caps (title, seoTitle,
-- metaDescription, altText) so translations respect SEO length limits.
ALTER TABLE "AISettings"
  ADD COLUMN "translationMode" TEXT NOT NULL DEFAULT 'exact';

-- Merchant-editable SEO character limits (Pro+). null = fall back to the
-- built-in defaults in app/utils/character-limits.ts.
ALTER TABLE "AISettings"
  ADD COLUMN "seoLimits" JSONB;
