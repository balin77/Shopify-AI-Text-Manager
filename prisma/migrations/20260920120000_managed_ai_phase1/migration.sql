-- PLAN_MANAGED_AI_KEY Phase 1 — the credential resolver's state.
--
-- The key source is a SECOND AXIS beside the plan, not a fifth plan value, so
-- every plan-keyed record in the app keeps working unchanged.

-- The merchant's stored CHOICE. Defaults to "byo", which is what every
-- existing shop is: managed mode does not migrate anybody, and a column that
-- defaulted the other way would switch live shops onto an operator key on
-- deploy.
ALTER TABLE "AISettings" ADD COLUMN "aiKeySource" TEXT NOT NULL DEFAULT 'byo';

-- Mirrored from the Shopify-VERIFIED subscription, like subscriptionPlan —
-- never from a form field. Defaults false: entitlement is granted by a
-- verified purchase, never by the absence of evidence.
ALTER TABLE "AISettings" ADD COLUMN "managedAiActive" BOOLEAN NOT NULL DEFAULT false;

-- Explicit, logged, versioned consent to processing content through the
-- OPERATOR's AI account. NULL means never given, which is the only correct
-- starting state: a pre-ticked box is not consent, and neither is a default.
ALTER TABLE "AISettings" ADD COLUMN "aiProcessingConsentAt" TIMESTAMP(3);
ALTER TABLE "AISettings" ADD COLUMN "aiProcessingConsentVersion" TEXT;

-- THREE-VALUED, and nullable for that reason alone: `isDevStore`'s catch
-- returns false, so "we could not tell" and "not a dev store" are otherwise
-- the same value — and the cheap direction there is the one that hands a free
-- store an uncapped operator budget. NULL = never determined.
ALTER TABLE "AISettings" ADD COLUMN "partnerDevelopment" BOOLEAN;
