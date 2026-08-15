-- IndexNow: submit on the shop's PRIMARY domain instead of *.myshopify.com.
--
-- Shopify 301-redirects the myshopify host to the primary domain, so both the
-- submitted URLs and the keyLocation ownership check used to land on a host
-- other than the one declared in `host`. The column is backfilled with the
-- shop domain (= the previous behaviour, so nothing changes until we know
-- better) and refreshed to the real primary domain by `syncIndexNowHost` the
-- next time the merchant opens the section.
ALTER TABLE "SeoIndexNowConfig" ADD COLUMN "host" TEXT;
UPDATE "SeoIndexNowConfig" SET "host" = "shop" WHERE "host" IS NULL;
ALTER TABLE "SeoIndexNowConfig" ALTER COLUMN "host" SET NOT NULL;

-- Left NULL by the backfill on purpose: "never verified against the real
-- primary domain", which is what makes the background sweep pick these rows up
-- first instead of trusting the backfilled myshopify host forever.
ALTER TABLE "SeoIndexNowConfig" ADD COLUMN "hostCheckedAt" TIMESTAMP(3);

-- Full-catalog submits get their own stamp: the shared lastSubmittedAt is
-- bumped by every queue drain (incl. the background sweep), which would keep
-- the "submit everything" cooldown permanently expired.
ALTER TABLE "SeoIndexNowConfig" ADD COLUMN "lastFullSubmitAt" TIMESTAMP(3);

-- Background auto-submit sweep bookkeeping (index-now-auto-submit.service.ts).
ALTER TABLE "SeoIndexNowConfig" ADD COLUMN "lastAutoRunAt" TIMESTAMP(3);

CREATE INDEX "SeoIndexNowConfig_enabled_lastAutoRunAt_idx"
  ON "SeoIndexNowConfig" ("enabled", "lastAutoRunAt");
