-- PLAN_MANAGED_AI_KEY §9.3 — the global monthly cap on managed AI spend.
--
-- Its own table, deliberately NOT a sentinel row in the shop-scoped
-- AiUsageCounter. Not because the GDPR guard would fail (that guard checks
-- every shop-scoped MODEL is purged, and a shop: "__global__" row would simply
-- survive redactShopData's exact-match delete) but because a global counter
-- has no tenant and therefore no business in a per-shop unique key — and a
-- surviving row that LOOKS like a shop is worse than a separate table in every
-- later audit.
--
-- TWO POOLS, not one. A paid pool sized from the subscriptions actually sold,
-- and a smaller taster pool. With one pool a listing spike of free installs
-- spending their tasters trips the cap on the 18th and 503s every PAYING
-- merchant for the rest of the month — free shops are the least accountable
-- population here and must not be able to refuse the revenue.
--
-- When a pool is exhausted, managed mode answers 503 managedUnavailable and
-- alerts. A bug in the meter can then cost one configured month's budget
-- rather than an unbounded invoice.
CREATE TABLE "ManagedAiGlobalCounter" (
    "id" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "pool" TEXT NOT NULL,
    "costMicros" BIGINT NOT NULL DEFAULT 0,
    "failoverMicros" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ManagedAiGlobalCounter_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ManagedAiGlobalCounter_period_pool_key"
  ON "ManagedAiGlobalCounter"("period", "pool");
