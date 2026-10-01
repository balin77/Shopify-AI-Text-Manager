-- PLAN_METAOBJECTS_EDITOR Phase 4 (§7.2): what a metaobject DEFINITION lets
-- this app do.
--
-- Shopify reports an access regime per definition (`access { admin }`), and a
-- definition whose admin access excludes third-party writes is one where the
-- entry editor must say so BEFORE the merchant types into it -- not after the
-- save fails.
--
-- Nullable on purpose, and NULL means UNKNOWN, never "writable" and never
-- "read-only": a row written by a sync from before this column existed has not
-- been asked the question. The reader treats NULL as "make no claim" and
-- offers a resync, exactly like `attributesSyncedAt`. An older container simply
-- never selects the column.
ALTER TABLE "MetaobjectDefinition"
  ADD COLUMN IF NOT EXISTS "adminAccess" TEXT;
