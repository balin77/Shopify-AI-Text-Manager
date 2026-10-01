-- PLAN_CONTENT_CREATION §Phase 3.3 / §A1 — automatic redirect on handle change.
--
-- Default TRUE on purpose. Changing a handle silently 404s every existing link
-- to the old address, and this app has been changing handles in three places
-- while creating a redirect in none of them. Existing shops therefore get the
-- protective behaviour without having to discover a setting; a merchant who is
-- still shaping their handles can switch it off.
ALTER TABLE "AISettings"
  ADD COLUMN IF NOT EXISTS "seoAutoHandleRedirect" BOOLEAN NOT NULL DEFAULT true;
