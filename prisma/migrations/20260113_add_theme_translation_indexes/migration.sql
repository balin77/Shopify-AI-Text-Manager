-- CreateTable and Index (only if not exists)
DO $$
BEGIN
    -- First ensure the ThemeTranslation table exists
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'ThemeTranslation') THEN
        CREATE TABLE "ThemeTranslation" (
            "id" TEXT NOT NULL,
            "shop" TEXT NOT NULL,
            "resourceId" TEXT NOT NULL,
            "groupId" TEXT NOT NULL,
            "key" TEXT NOT NULL,
            "value" TEXT NOT NULL,
            "locale" TEXT NOT NULL,
            "outdated" BOOLEAN NOT NULL DEFAULT false,
            "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" TIMESTAMP(3) NOT NULL,
            CONSTRAINT "ThemeTranslation_pkey" PRIMARY KEY ("id")
        );
        CREATE UNIQUE INDEX "ThemeTranslation_shop_resourceId_groupId_key_locale_key" ON "ThemeTranslation"("shop", "resourceId", "groupId", "key", "locale");
        CREATE INDEX "ThemeTranslation_shop_resourceId_groupId_idx" ON "ThemeTranslation"("shop", "resourceId", "groupId");
        CREATE INDEX "ThemeTranslation_locale_idx" ON "ThemeTranslation"("locale");
    END IF;

    -- Add index if it doesn't exist
    IF NOT EXISTS (
        SELECT 1 FROM pg_indexes WHERE indexname = 'ThemeTranslation_shop_groupId_locale_idx'
    ) THEN
        CREATE INDEX "ThemeTranslation_shop_groupId_locale_idx" ON "ThemeTranslation"("shop", "groupId", "locale");
    END IF;
END $$;
