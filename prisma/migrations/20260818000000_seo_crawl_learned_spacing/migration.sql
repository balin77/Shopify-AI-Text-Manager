-- Remembered crawl pace per shop. Purely additive and nullable: an existing
-- row means "never crawled since this shipped" and the crawler falls back to
-- its cautious default.
ALTER TABLE "AISettings" ADD COLUMN "seoCrawlSpacingMs" INTEGER;
