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
-- The KEY is the design. Everything the cost of a call depends on is IN it:
-- whose key paid ("byo" / "managed"), the provider and model (which also make
-- "priced at the unknown-model ceiling" and "not priced at all" derivable at
-- read time, so no column has to say so), the FEATURE (Task.type, or "adhoc"),
-- and whether the token counts were REPORTED or estimated — the last one as a
-- key column rather than a counter, so the measured average can be computed
-- without the estimates mixed into it.
--
-- `costMicros` is what we pay the provider, `billedMicros` what is charged
-- against the merchant's budget. Equal today; they diverge on a failover.
--
-- The volume columns are BIGINT. Int32 holds 2.1e9 tokens, which is about
-- EUR 99 of input spend on the pinned managed default — and Postgres RAISES on
-- an integer overflow rather than clamping, so an INTEGER column here would
-- simply stop advancing mid-period, silently, including the column enforcement
-- reads.
CREATE TABLE "AiUsageCounter" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "estimated" BOOLEAN NOT NULL,
    "calls" INTEGER NOT NULL DEFAULT 0,
    "failoverCalls" INTEGER NOT NULL DEFAULT 0,
    "inputTokens" BIGINT NOT NULL DEFAULT 0,
    "outputTokens" BIGINT NOT NULL DEFAULT 0,
    "costMicros" BIGINT NOT NULL DEFAULT 0,
    "billedMicros" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiUsageCounter_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AiUsageCounter_shop_period_source_provider_model_feature_es_key"
  ON "AiUsageCounter"("shop", "period", "source", "provider", "model", "feature", "estimated");

CREATE INDEX "AiUsageCounter_shop_period_idx" ON "AiUsageCounter"("shop", "period");

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
