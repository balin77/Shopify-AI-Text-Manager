-- Additive: the poller stamps the start of a collect (evidence for the 48 h expiry).
ALTER TABLE "BulkTranslateBatch" ADD COLUMN "collectStartedAt" TIMESTAMP(3);
