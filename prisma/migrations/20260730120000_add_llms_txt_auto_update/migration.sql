-- Merchant-facing switch for the periodic llms.txt refresh (SEO → AI search,
-- step 2). The background pass in app/services/seo/aeo.service.ts
-- (refreshLlmsTxtIfStale, driven by the sync scheduler) only ever UPDATES a
-- file the merchant already generated and writes only on a real content
-- difference — so it defaults to on, matching the behaviour that shipped
-- before the switch existed. Theme writes additionally require the
-- AEO_THEME_WRITES env gate.
ALTER TABLE "AISettings"
  ADD COLUMN "llmsTxtAutoUpdate" BOOLEAN NOT NULL DEFAULT true;
