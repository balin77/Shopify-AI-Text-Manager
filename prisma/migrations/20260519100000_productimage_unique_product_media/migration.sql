-- Enforce one ProductImage row per (productId, mediaId).
--
-- Concurrent "apply alt text" requests used a non-atomic check-then-create
-- (getOrCreateProductImage), so duplicate ProductImage rows for the same
-- Shopify media GID could accumulate. Before adding the unique index we must
-- collapse those duplicates and repoint their alt-text translations onto a
-- single surviving row. Rows with NULL mediaId are left untouched (Postgres
-- treats NULLs as distinct, so they never collide).
--
-- Deterministic keeper per (productId, mediaId): the row whose alt-text was
-- modified most recently, breaking ties by id. ProductImage is a re-syncable
-- cache, so the exact keeper only matters for not losing a fresh local edit.
--
-- CAVEAT 1 (acceptable, by design): step 2a drops a duplicate's translations
-- when the keeper already has the same locale. The keeper is chosen by
-- ProductImage.altTextModifiedAt, NOT by the translation's own recency
-- (ProductImageAltTranslation has no comparable trust signal), so a discarded
-- foreign-locale translation could in theory be newer than the kept one.
-- Tolerated because Shopify is the source of truth and the next product sync
-- repopulates ProductImageAltTranslation from it.
--
-- CAVEAT 2 (operational): the unique index is built non-CONCURRENTLY inside
-- Prisma's migration transaction. If a parallel "apply alt text" commits a new
-- duplicate between the dedup steps and the index build, the build fails and
-- the migration aborts. Run this during a short maintenance pause (or expect
-- to re-run it) — it is otherwise safe to re-run from a clean state.

-- 1. Map every duplicate row to its surviving keeper.
CREATE TEMP TABLE _pi_dedup ON COMMIT DROP AS
SELECT
  pi.id AS dup_id,
  first_value(pi.id) OVER (
    PARTITION BY pi."productId", pi."mediaId"
    ORDER BY pi."altTextModifiedAt" DESC NULLS LAST, pi.id DESC
  ) AS keep_id
FROM "ProductImage" pi
WHERE pi."mediaId" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM "ProductImage" p2
    WHERE p2."productId" = pi."productId"
      AND p2."mediaId" = pi."mediaId"
      AND p2.id <> pi.id
  );

-- 2a. Drop translations on a duplicate whose locale already exists on the
--     keeper (would violate ProductImageAltTranslation_imageId_locale unique).
DELETE FROM "ProductImageAltTranslation" t
USING _pi_dedup d
WHERE t."imageId" = d.dup_id
  AND d.dup_id <> d.keep_id
  AND EXISTS (
    SELECT 1 FROM "ProductImageAltTranslation" k
    WHERE k."imageId" = d.keep_id
      AND k.locale = t.locale
  );

-- 2b. Repoint the remaining (non-colliding) translations onto the keeper.
UPDATE "ProductImageAltTranslation" t
SET "imageId" = d.keep_id
FROM _pi_dedup d
WHERE t."imageId" = d.dup_id
  AND d.dup_id <> d.keep_id;

-- 3. Delete the now-orphaned duplicate ProductImage rows.
DELETE FROM "ProductImage" pi
USING _pi_dedup d
WHERE pi.id = d.dup_id
  AND d.dup_id <> d.keep_id;

-- 4. Add the unique constraint backing the atomic upsert.
CREATE UNIQUE INDEX "ProductImage_productId_mediaId_key"
  ON "ProductImage"("productId", "mediaId");
