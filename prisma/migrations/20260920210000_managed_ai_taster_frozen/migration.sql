-- The taster's frozen worth and its spent stamp (PLAN_MANAGED_AI_KEY §10).
--
-- Both nullable and additive. `managedAiTasterMicros` freezes what the grant
-- was worth when it started, so changing the managed default model cannot
-- re-grant a spent taster or retroactively exhaust a live one;
-- `managedAiTasterSpentAt` is the synchronous signal the credential resolver
-- needs to hand a shop back to its own API key once the grant is gone.
ALTER TABLE "AISettings" ADD COLUMN "managedAiTasterMicros" INTEGER;
ALTER TABLE "AISettings" ADD COLUMN "managedAiTasterSpentAt" TIMESTAMP(3);
