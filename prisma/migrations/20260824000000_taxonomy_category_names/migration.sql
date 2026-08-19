-- Shopify's product taxonomy in the merchant's language.
--
-- The Admin API answers `taxonomy.categories` in ENGLISH and offers no way to
-- ask otherwise. Measured twice on a live shop (Settings -> Probes ->
-- Taxonomy): `@inContext` is not defined in the Admin schema at all, and an
-- `Accept-Language` header is ACCEPTED and changes nothing -- for every locale
-- of the shop, its primary one included. So a German shop's category picker
-- showed "Home & Garden > Decor > Vases" beside an admin saying "Heim & Garten
-- > Dekoration > Vasen", and a product type derived from a category would have
-- written an English word into a German shop's data.
--
-- The names exist as OPEN DATA (Shopify/product-taxonomy, dist/<locale>/
-- categories.txt), keyed by the very same GIDs the API returns. This table is
-- that file after import.
--
-- NOT scoped by shop -- the one deliberate exception to the multi-tenant rule.
-- These rows are Shopify's public taxonomy: identical for every merchant, and
-- carrying nothing a shop owns. Per-shop they would be 14 608 rows per locale
-- per shop for data that cannot differ between them.
CREATE TABLE IF NOT EXISTS "TaxonomyCategoryName" (
  "id"        TEXT NOT NULL,
  "locale"    TEXT NOT NULL,
  "gid"       TEXT NOT NULL,
  "fullName"  TEXT NOT NULL,
  "name"      TEXT NOT NULL,
  -- Derived from the GID hierarchy at import; the file does not carry it. The
  -- picker marks a non-leaf "(broad)", so a column that defaulted would state
  -- something about every category rather than nothing.
  "isLeaf"    BOOLEAN NOT NULL,
  "version"   TEXT NOT NULL DEFAULT '',
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TaxonomyCategoryName_pkey" PRIMARY KEY ("id")
);

-- The lookup the picker makes: every GID of one rendered level, in one locale.
CREATE UNIQUE INDEX IF NOT EXISTS "TaxonomyCategoryName_locale_gid_key"
  ON "TaxonomyCategoryName" ("locale", "gid");

-- The search half scans one locale, so the locale has to narrow first.
CREATE INDEX IF NOT EXISTS "TaxonomyCategoryName_locale_idx"
  ON "TaxonomyCategoryName" ("locale");
