CREATE TABLE "GroupedFieldTranslation" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "fieldKey" TEXT NOT NULL,
    "sourceLocale" TEXT NOT NULL,
    "sourceValueNorm" TEXT NOT NULL,
    "sourceValue" TEXT NOT NULL,
    "targetLocale" TEXT NOT NULL,
    "translatedValue" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'ai',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "GroupedFieldTranslation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GroupedFieldTranslation_shop_fieldKey_sourceLocale_sourceValueNorm_targetLocale_key"
    ON "GroupedFieldTranslation"("shop", "fieldKey", "sourceLocale", "sourceValueNorm", "targetLocale");

CREATE INDEX "GroupedFieldTranslation_shop_fieldKey_sourceLocale_idx"
    ON "GroupedFieldTranslation"("shop", "fieldKey", "sourceLocale");
