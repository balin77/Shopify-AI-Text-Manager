-- Marks ONLINE_STORE_THEME_APP_EMBED rows that belong to OUR app (block.type
-- app-handle matches contentpilot). The content editor locks our own app-embed
-- fields read-only in every locale (they are technical selectors/config), while
-- other apps' embeds stay editable. Populated from settings_data.json on the
-- next full theme sync; existing rows default to false until then.
--
-- Idempotent (IF NOT EXISTS): safe to re-run and safe on shops that already have
-- the column. Additive, non-breaking — existing rows get the false default.

ALTER TABLE "ThemeContent"
  ADD COLUMN IF NOT EXISTS "appEmbedOwned" BOOLEAN NOT NULL DEFAULT false;
