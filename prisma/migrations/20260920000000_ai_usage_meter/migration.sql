-- PLAN_MANAGED_AI_KEY Phase 0 — the meter.
--
-- Nothing about AI pricing can be decided honestly until the app knows what one
-- operation really costs, and until now it did not: the provider SDKs return a
-- `usage` object on every call and this app discarded all of them. The only
-- token figure it kept was `Task.estimatedTokens`, which the rate limiter
-- computes BEFORE the call and which charges a flat 8192 output tokens — an
-- order of magnitude above a typical completion, and useless as a cost record.
--
-- Two stores, because they answer two different questions.

-- 1. The durable per-shop ledger.
--
-- `source` splits a shop's own key ("byo") from the operator's ("managed").
-- BYO is metered too, deliberately and with no cap: it is where this app's
-- price numbers come from, and it is the "what is this costing me" answer no
-- provider API gives uniformly.
--
-- `costMicros` is what we pay the provider, `billedMicros` what is charged
-- against the merchant's budget. They are equal today and diverge only during
-- a failover, where the merchant is billed at the default model's price.
--
-- `estimatedCalls` is the honesty column: a call whose provider reported no
-- usage object is counted at an estimate, never at zero.
--
-- Money is integer micro-EUR. Int32 tops out at ~EUR 2,147 per row, far past
-- any monthly shop total; the writer clamps rather than wrapping.
CREATE TABLE "AiUsageCounter" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "calls" INTEGER NOT NULL DEFAULT 0,
    "estimatedCalls" INTEGER NOT NULL DEFAULT 0,
    "failoverCalls" INTEGER NOT NULL DEFAULT 0,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "costMicros" INTEGER NOT NULL DEFAULT 0,
    "billedMicros" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiUsageCounter_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AiUsageCounter_shop_period_source_key"
  ON "AiUsageCounter"("shop", "period", "source");

CREATE INDEX "AiUsageCounter_shop_idx" ON "AiUsageCounter"("shop");

-- 2. The per-RUN record, on Task.
--
-- Task already carries `provider` and `aiModel` and expires after three days,
-- so this is the cheapest possible answer to "what did that bulk run cost".
--
-- A 0 on a row written BEFORE this migration is the `metaRobots` / `jsonLdTypes`
-- trap in miniature: it is indistinguishable from a run that really made no AI
-- call. It is accepted here, and only here, because Task rows carry `expiresAt`
-- = createdAt + 3 days, so the ambiguity is BOUNDED by three days rather than
-- being permanent. The durable ledger above has no such column and needs none:
-- a shop with no row simply has no usage in that period. Anything that reads
-- these three columns must still treat a whole-task 0 as "nothing recorded",
-- never as a measured zero cost.
ALTER TABLE "Task" ADD COLUMN "inputTokens" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Task" ADD COLUMN "outputTokens" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Task" ADD COLUMN "costMicros" INTEGER NOT NULL DEFAULT 0;
