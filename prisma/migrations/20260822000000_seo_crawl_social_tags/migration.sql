-- PLAN_MARKUP_ACTIVATION Phase 2 (§2.1): Open Graph / Twitter Cards get the
-- same measurement JSON-LD already has.
--
-- Until now `SeoCrawlPage` had no column for og:* or twitter:* at all, so
-- social-meta had neither a delivery report nor a duplicate check -- while
-- social-meta.liquid sets exactly the same trap: most themes emit og:title and
-- og:image themselves, and two og:image tags on one page are for Facebook and
-- LinkedIn what two Product nodes are for Google.
--
-- REPEATS ARE PRESERVED in these columns, same as `jsonLdTypes`: "og:image,
-- og:image" is what makes a duplicate detectable at all. Collapsing them would
-- throw away the only thing the columns exist for.
--
-- `socialKnown` is not optional, and it is the same discriminator as
-- `indexabilityKnown` next to it: "" means TWO indistinguishable things -- the
-- page served no social tags, OR the row was written before these columns
-- existed. It is set only when a body was actually parsed, so a pre-existing
-- snapshot reports "unknown" instead of "this shop has no social markup".
ALTER TABLE "SeoCrawlPage"
  ADD COLUMN IF NOT EXISTS "ogTags" TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "twitterTags" TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "ogAppTags" TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "socialKnown" BOOLEAN NOT NULL DEFAULT false;
