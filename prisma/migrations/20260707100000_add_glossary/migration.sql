-- Glossar/Terminologie (docs/plans/GLOSSARY_IMPLEMENTATION_PLAN.md):
-- per-shop terminology injected into AI translation prompts.
-- GlossaryEntry is shop-scoped and purged in redactShopData;
-- GlossaryEntryTranslation cascades from its entry.

-- CreateTable
CREATE TABLE "GlossaryEntry" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "sourceTerm" TEXT NOT NULL,
    "sourceLocale" TEXT NOT NULL,
    "doNotTranslate" BOOLEAN NOT NULL DEFAULT false,
    "caseSensitive" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "GlossaryEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GlossaryEntryTranslation" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    CONSTRAINT "GlossaryEntryTranslation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GlossaryEntry_shop_sourceTerm_sourceLocale_key" ON "GlossaryEntry"("shop", "sourceTerm", "sourceLocale");

-- CreateIndex
CREATE INDEX "GlossaryEntry_shop_idx" ON "GlossaryEntry"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "GlossaryEntryTranslation_entryId_locale_key" ON "GlossaryEntryTranslation"("entryId", "locale");

-- CreateIndex
CREATE INDEX "GlossaryEntryTranslation_entryId_idx" ON "GlossaryEntryTranslation"("entryId");

-- AddForeignKey
ALTER TABLE "GlossaryEntryTranslation" ADD CONSTRAINT "GlossaryEntryTranslation_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "GlossaryEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;
