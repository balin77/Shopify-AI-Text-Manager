-- PLAN_KEYWORDS_UI_REWORK.md §3.1: language becomes a group dimension. Every
-- existing group keeps locale='' (primary), which matches its real use. Old
-- memberships pointing at a non-primary-locale keyword violate the new
-- invariant (membership.keyword.locale === group.locale) and are dropped
-- ersatzlos (§8.2 — keyword loss is accepted pre-launch).
ALTER TABLE "SeoKeywordGroup" ADD COLUMN "locale" TEXT NOT NULL DEFAULT '';

DROP INDEX "SeoKeywordGroup_shop_name_key";
CREATE UNIQUE INDEX "SeoKeywordGroup_shop_name_locale_key" ON "SeoKeywordGroup"("shop", "name", "locale");

DROP INDEX "SeoKeywordGroup_shop_idx";
CREATE INDEX "SeoKeywordGroup_shop_locale_idx" ON "SeoKeywordGroup"("shop", "locale");

DELETE FROM "SeoKeywordGroupMembership" m
USING "SeoKeyword" k
WHERE m."keywordId" = k."id" AND k."locale" <> '';
