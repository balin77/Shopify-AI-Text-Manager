-- Bulk editor Phase 3 (variants & prices, Plan §5.1/§5.2): the regular
-- product sync now mirrors variant pricing, so the bulk editor's variant rows
-- are reliably filled instead of depending on the merchant having opened the
-- image manager. Purely additive and nullable — no backfill; the next full or
-- per-product sync populates the columns.
--
-- Product.hasMoreVariants: explicit flag (from variants(first:100)
-- pageInfo.hasNextPage) marking products whose variant remainder was NOT
-- fetched — "count === 100" would be ambiguous for products with exactly 100
-- variants. Default false keeps existing rows truthful until their next sync.

-- AlterTable
ALTER TABLE "ProductVariant" ADD COLUMN "price" DECIMAL(12,2),
ADD COLUMN "compareAtPrice" DECIMAL(12,2),
ADD COLUMN "barcode" TEXT;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN "hasMoreVariants" BOOLEAN NOT NULL DEFAULT false;
