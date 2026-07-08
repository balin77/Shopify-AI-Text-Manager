-- Phase 4 split: DELIVERY_METHOD_DEFINITION moved out of the "system" domain into
-- its own "delivery" domain (Basic+). Existing shops already have these rows under
-- domain='system' with a 'delivery_<id>' groupId (the old syncSystemContent
-- groupPrefix). Re-tag them in place BEFORE any sync runs, so the new
-- syncDeliveryContent / syncSystemContent paths never collide on the
-- domain-less unique keys (@@unique([shop, resourceId, groupId]) and
-- @@unique([shop, resourceId, groupId, key, locale])) and the system
-- orphan-cleanup has nothing stale to delete.
--
-- Idempotent: re-running matches nothing (rows are already domain='delivery').
-- The '\_' escapes the LIKE single-char wildcard so only the literal
-- 'delivery_' prefix matches (never e.g. 'deliveryX...').

UPDATE "ThemeContent"
  SET "domain" = 'delivery'
  WHERE "domain" = 'system' AND "groupId" LIKE 'delivery\_%';

UPDATE "ThemeTranslation"
  SET "domain" = 'delivery'
  WHERE "domain" = 'system' AND "groupId" LIKE 'delivery\_%';
