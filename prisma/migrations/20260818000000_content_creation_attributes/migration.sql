-- PLAN_CONTENT_CREATION Phase 0 — merchandising attributes + collection
-- membership. Purely additive: every new column is nullable or carries a
-- default, so there is no backfill and no table rewrite that could block boot.
-- Run explicitly via `npm run prisma:migrate` (NEVER as a package.json
-- postdeploy script — see CLAUDE.md).
--
-- READ THIS BEFORE CONSUMING ANY COLUMN BELOW: the defaults of a pre-existing
-- row are indistinguishable from "the merchant left it empty" (vendor NULL,
-- tags '{}', isPublished true). `attributesSyncedAt` is the ONLY discriminator
-- — NULL means the row predates the attribute sync and every column in its
-- block is UNKNOWN, not "missing". Same rule as SeoCrawlPage.indexabilityKnown.

-- ── Product ────────────────────────────────────────────────────────────────
ALTER TABLE "Product"
  ADD COLUMN "vendor"             TEXT,
  ADD COLUMN "tags"               TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "categoryId"         TEXT,
  ADD COLUMN "categoryName"       TEXT,
  ADD COLUMN "templateSuffix"     TEXT,
  ADD COLUMN "publishedAt"        TIMESTAMP(3),
  ADD COLUMN "hasMoreCollections" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "attributesSyncedAt" TIMESTAMP(3);

-- ── Collection ─────────────────────────────────────────────────────────────
-- `sourcesJson` holds a DISCRIMINATED envelope ({shape, apiVersion, data}),
-- not a bare rule tree: the 2025-10 `ruleSet` and the 2026-07 `sources[]`
-- models are not interchangeable and a reader must not have to guess which
-- one a row carries.
ALTER TABLE "Collection"
  ADD COLUMN "sortOrder"          TEXT,
  ADD COLUMN "templateSuffix"     TEXT,
  ADD COLUMN "isSmart"            BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "sourcesJson"        JSONB,
  ADD COLUMN "attributesSyncedAt" TIMESTAMP(3);

-- ── Article ────────────────────────────────────────────────────────────────
-- `author` is not merely a gap: ArticleCreateInput requires it (PLAN §1.4).
ALTER TABLE "Article"
  ADD COLUMN "author"             TEXT,
  ADD COLUMN "tags"               TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "templateSuffix"     TEXT,
  ADD COLUMN "isPublished"        BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "publishedAt"        TIMESTAMP(3),
  ADD COLUMN "attributesSyncedAt" TIMESTAMP(3);

-- ── Page ───────────────────────────────────────────────────────────────────
ALTER TABLE "Page"
  ADD COLUMN "templateSuffix"     TEXT,
  ADD COLUMN "isPublished"        BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "publishedAt"        TIMESTAMP(3),
  ADD COLUMN "attributesSyncedAt" TIMESTAMP(3);

-- ── ProductCollection ──────────────────────────────────────────────────────
-- New table, so its indexes are built on an empty relation — the FORWARD RULE
-- in schema.prisma (CREATE INDEX CONCURRENTLY for indexes on large hot tables)
-- does not apply here.
--
-- No foreign key to "Collection" on purpose: the collection cache is capped by
-- the merchant's plan, so a membership can legitimately point at a collection
-- this shop never cached. "collectionTitle" is mirrored for exactly that case.
CREATE TABLE "ProductCollection" (
  "id"              TEXT NOT NULL,
  "shop"            TEXT NOT NULL,
  "productId"       TEXT NOT NULL,
  "collectionId"    TEXT NOT NULL,
  "collectionTitle" TEXT NOT NULL,
  "automated"       BOOLEAN NOT NULL DEFAULT false,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ProductCollection_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProductCollection_productId_collectionId_key"
  ON "ProductCollection"("productId", "collectionId");
CREATE INDEX "ProductCollection_productId_idx" ON "ProductCollection"("productId");
CREATE INDEX "ProductCollection_shop_collectionId_idx"
  ON "ProductCollection"("shop", "collectionId");

ALTER TABLE "ProductCollection"
  ADD CONSTRAINT "ProductCollection_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
