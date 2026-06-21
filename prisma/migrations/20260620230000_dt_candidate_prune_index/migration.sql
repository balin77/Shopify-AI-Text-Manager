-- Backs the FIFO-prune query in recordCandidates: when a shop exceeds
-- MAX_CANDIDATES_PER_SHOP we delete the oldest entries by lastSeenAt.
-- Without this index Postgres table-scans + sorts once a shop has a few
-- hundred candidates.
CREATE INDEX IF NOT EXISTS "DirectTranslationCandidate_shop_lastSeenAt_idx"
  ON "DirectTranslationCandidate" ("shop", "lastSeenAt");
