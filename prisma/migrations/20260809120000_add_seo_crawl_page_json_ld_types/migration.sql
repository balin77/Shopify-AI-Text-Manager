-- schema.org @type values the crawler found in the page's
-- <script type="application/ld+json"> blocks, comma-separated with repeats
-- preserved ("Product,Product" = two blocks — that is how duplicate markup,
-- e.g. a theme AND the app both emitting Product, becomes visible).
--
-- Written by app/services/seo/crawl.service.ts (the crawler already has the
-- parsed HTML in hand, so this costs no extra request) and read by
-- summarizeLiveJsonLd in app/services/seo/json-ld-audit.service.ts, which
-- backs the "live on the storefront" card of the JSON-LD section. Until the
-- next crawl runs, existing rows report "" — the UI treats that as "not
-- measured yet", not as "no markup".
ALTER TABLE "SeoCrawlPage"
  ADD COLUMN "jsonLdTypes" TEXT NOT NULL DEFAULT '';
