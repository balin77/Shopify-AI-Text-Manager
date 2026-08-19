-- Shopify's `MetaobjectDefinition.capabilities.translatable.enabled`.
--
-- NULL means UNKNOWN — the row predates the column, or the sync could not read
-- it — and is NEVER read as "does not translate". Only a KNOWN false takes a
-- type out of the "this locale still needs work" count; unknown behaves as it
-- always did and counts. Same discriminator rule as `adminAccess` next to it
-- and `attributesSyncedAt` elsewhere.
ALTER TABLE "MetaobjectDefinition" ADD COLUMN "translatableCapability" BOOLEAN;
