-- The subset of SeoCrawlPage.jsonLdTypes that came from THIS app's storefront
-- block, recognised by the data-contentpilot attribute it writes on every
-- <script type="application/ld+json"> tag it emits.
--
-- Purpose: duplicate structured data (the same @type served twice on one page)
-- is the most common structured-data defect on a Shopify storefront, and the
-- delivered HTML gives a merchant no way to tell which copy came from where.
-- Comparing this column against jsonLdTypes answers it: a type in both is ours
-- AND someone else's; a type only in jsonLdTypes is the theme's or another
-- app's. It also detects whether the app embed is enabled at all, which the
-- Admin API cannot report.
--
-- Empty for pages crawled before the marked block was deployed — the report
-- treats "nothing marked anywhere" as unknown, not as "the embed is off".
ALTER TABLE "SeoCrawlPage"
  ADD COLUMN "jsonLdAppTypes" TEXT NOT NULL DEFAULT '';
