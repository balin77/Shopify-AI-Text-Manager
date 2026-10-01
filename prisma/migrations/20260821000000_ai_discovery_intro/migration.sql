-- Merchant-authored intro for the two AI-discovery files (agents.md, llms.txt).
--
-- Nullable columns on an existing table — safe to ship with the code, an older
-- container simply never selects them. NULL means "use the generated default",
-- which is the state every shop starts in, so there is nothing to backfill.
ALTER TABLE "AISettings"
  ADD COLUMN IF NOT EXISTS "aiDiscoveryIntroAgents" TEXT;

ALTER TABLE "AISettings"
  ADD COLUMN IF NOT EXISTS "aiDiscoveryIntroLlms" TEXT;
