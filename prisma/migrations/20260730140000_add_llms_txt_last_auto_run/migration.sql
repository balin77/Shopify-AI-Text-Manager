-- When the llms.txt auto-refresh last ran for a shop (stamped even when the run
-- found no difference, or skipped the shop on plan/opt-out grounds). Read and
-- written by app/services/seo/llms-auto-refresh.service.ts, the daily
-- shop-independent sweep that keeps llms.txt fresh for merchants who don't open
-- the app — the in-session refresh in sync-scheduler.service.ts only runs while
-- someone is working in the app.
--
-- Also the idempotency guard: the sweep picks shops whose stamp is null or
-- older than the stale window, so a second Railway replica or a redeploy cannot
-- make it run twice for the same shop.
ALTER TABLE "AISettings"
  ADD COLUMN "llmsTxtLastAutoRunAt" TIMESTAMP(3);
