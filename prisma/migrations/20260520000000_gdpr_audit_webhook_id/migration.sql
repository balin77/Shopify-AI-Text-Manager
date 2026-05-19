-- R5-G4: correlate redelivered compliance webhook attempts.
-- Shopify retries a non-2xx compliance webhook for up to ~48h; without a
-- correlation id the append-only (3-year-retained) GdprAuditLog showed
-- duplicate/contradictory rows with no link between attempts. Store the
-- X-Shopify-Webhook-Id. Nullable (legacy rows have none); plain index
-- (not unique) — a redelivery legitimately produces a second attempt row
-- with the SAME webhook id, we want them correlatable, not rejected.
-- Idempotent so it is safe on every environment.

ALTER TABLE "GdprAuditLog" ADD COLUMN IF NOT EXISTS "webhookId" TEXT;

CREATE INDEX IF NOT EXISTS "GdprAuditLog_webhookId_idx" ON "GdprAuditLog"("webhookId");
