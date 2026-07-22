-- SEO tab Performance section, accessibility plan: denormalized Lighthouse
-- accessibility / best-practices category scores next to the existing
-- performance `score`, so the history list never has to parse the result JSON.
-- Purely additive and nullable — old rows keep NULL (no backfill) and trigger
-- the "stored before the quality check" empty state in the UI.

-- AlterTable
ALTER TABLE "SeoPageSpeedAudit" ADD COLUMN "a11yScore" INTEGER,
ADD COLUMN "bestPracticesScore" INTEGER;
