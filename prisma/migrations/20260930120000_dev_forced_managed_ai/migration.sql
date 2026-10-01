-- Dev build only: the forced plan was chosen as its "+ AI" variant
-- (MANAGED_AI_ALLOW_DEV_BUILD testing mode). Default false grants nothing.
ALTER TABLE "AISettings" ADD COLUMN "devForcedManagedAi" BOOLEAN NOT NULL DEFAULT false;
