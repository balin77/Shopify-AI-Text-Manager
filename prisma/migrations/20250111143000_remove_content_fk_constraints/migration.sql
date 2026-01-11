-- DropForeignKey
ALTER TABLE "ContentTranslation" DROP CONSTRAINT IF EXISTS "ContentTranslation_collection_fkey";
ALTER TABLE "ContentTranslation" DROP CONSTRAINT IF EXISTS "ContentTranslation_article_fkey";
ALTER TABLE "ContentTranslation" DROP CONSTRAINT IF EXISTS "ContentTranslation_page_fkey";
