-- One shop-wide answer to "may the AI look at the images, and at how many".
--
-- Replaces a per-session checkbox in the content editor's toolbar (off on
-- every page load), a second one in the create dialog, and a hardcoded FALSE
-- in the alt-text action the image manager posts to. Both columns are NOT NULL
-- with a default, and the defaults are the historic behaviour: vision off, and
-- one image when it is switched on.
ALTER TABLE "AISettings" ADD COLUMN "sendImagesToAI" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AISettings" ADD COLUMN "aiImagesPerRequest" INTEGER NOT NULL DEFAULT 1;
