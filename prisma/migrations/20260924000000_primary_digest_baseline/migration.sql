-- The primary text's digest per resource: the stale-translation gate's second
-- baseline, independent of translation rows.
--
-- Until now the only proof that a primary text moved outside this app was a
-- digest stored ON a ContentTranslation row, so a resource nobody had
-- translated yet could never be proven changed and an edit in the Shopify
-- admin reached nothing. One row per (shop, resourceId), digests as a JSON map
-- over the keys this app manages.
--
-- Two new tables, nothing on an existing one: an older container never reads
-- them, so there is no deploy ordering requirement and no backfill. An empty
-- table is NO EVIDENCE by design — the first sync after the deploy only writes
-- baselines and translates nothing.
CREATE TABLE IF NOT EXISTS "PrimaryDigestBaseline" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "digests" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PrimaryDigestBaseline_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PrimaryDigestBaseline_shop_resourceId_key"
  ON "PrimaryDigestBaseline"("shop", "resourceId");
CREATE INDEX IF NOT EXISTS "PrimaryDigestBaseline_shop_resourceType_idx"
  ON "PrimaryDigestBaseline"("shop", "resourceType");

-- The brake: resources per (shop, UTC day) whose auto-translation rested on
-- the baseline above alone. Past the cap the rest are refused, reported and
-- deferred (their baseline is not advanced).
CREATE TABLE IF NOT EXISTS "AutoTranslateFillBudget" (
    "shop" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "used" INTEGER NOT NULL DEFAULT 0,
    "refusedIds" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "AutoTranslateFillBudget_pkey" PRIMARY KEY ("shop", "day")
);
