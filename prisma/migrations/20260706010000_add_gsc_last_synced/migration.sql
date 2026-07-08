-- GSC auto-sync (daily keyword-ranking sync, app/services/seo/gsc-auto-sync.service.ts):
-- tracks when a shop's GoogleSearchConsoleConnection was last enriched, so the
-- sweep can find due connections and back off shops that can't be synced.
-- Additive, nullable — existing rows read as "never synced".

-- AlterTable
ALTER TABLE "GoogleSearchConsoleConnection" ADD COLUMN "lastKeywordSyncAt" TIMESTAMP(3);
