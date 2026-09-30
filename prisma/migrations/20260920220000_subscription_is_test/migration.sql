-- §7a signal 2, mirrored: the verified subscription charges nothing.
--
-- Nullable and additive, three-valued like `partnerDevelopment` beside it —
-- null means no sync has established it, and an unknown answer must not cost
-- a paying merchant their managed budget.
ALTER TABLE "AISettings" ADD COLUMN "subscriptionIsTest" BOOLEAN;
