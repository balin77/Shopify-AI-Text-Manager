-- Mirror of the product-video upload dates written to the
-- `custom.video_upload_dates` metafield (services/seo/video-schema.*).
--
-- Nullable column on an existing table — safe to ship with the code, an older
-- container simply never selects it. NULL means "nothing written yet", which
-- the diff treats as "write if there are videos", so no backfill is needed:
-- the next product sync fills it for every product that has one.
ALTER TABLE "Product"
  ADD COLUMN IF NOT EXISTS "videoSchemaJson" TEXT;
