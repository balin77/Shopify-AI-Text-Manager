-- Sales channels, markets and B2B catalogs are three different questions that
-- Shopify answers with ONE mechanism: every one of them is a `Publication`,
-- and only its `Catalog` type says which. Without this column the app read all
-- three as sales channels, so a shop with markets saw its regions listed as
-- channels it had never installed -- and a product published only to a market
-- catalog counted as "on a channel" for the invisibility alarm.
--
-- '' is UNKNOWN, not 'app'. Every row that exists before this migration
-- carries it, and so does a publication whose catalog Shopify did not deliver.
-- Unknown keeps rendering with the sales channels (where it always was) but is
-- never taken as evidence: raising "on no channel -- invisible" for a product
-- that is in fact on the online store, because one row arrived without its
-- catalog, is worse than not raising it.
ALTER TABLE "ProductPublication"
  ADD COLUMN IF NOT EXISTS "catalogType" TEXT NOT NULL DEFAULT '';
