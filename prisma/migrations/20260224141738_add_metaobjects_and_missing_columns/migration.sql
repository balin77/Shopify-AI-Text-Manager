-- Add missing columns to existing tables (idempotent — safe if already exists)

-- ProductOption: Add linkedMetafieldKey for metaobject-linked options
ALTER TABLE "ProductOption" ADD COLUMN IF NOT EXISTS "linkedMetafieldKey" TEXT;

-- AIInstructions: Add writingStyleInstructions for general AI writing style
ALTER TABLE "AIInstructions" ADD COLUMN IF NOT EXISTS "writingStyleInstructions" TEXT;

-- Article: Add summary field for article excerpt
ALTER TABLE "Article" ADD COLUMN IF NOT EXISTS "summary" TEXT;

-- Create MetaobjectDefinition table
CREATE TABLE IF NOT EXISTS "MetaobjectDefinition" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "fieldDefinitions" JSONB NOT NULL,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MetaobjectDefinition_pkey" PRIMARY KEY ("id")
);

-- Create Metaobject table
CREATE TABLE IF NOT EXISTS "Metaobject" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "fields" JSONB NOT NULL,
    "shopifyUpdatedAt" TIMESTAMP(3) NOT NULL,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Metaobject_pkey" PRIMARY KEY ("id")
);

-- Create MetaobjectTranslation table
CREATE TABLE IF NOT EXISTS "MetaobjectTranslation" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "metaobjectId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "outdated" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MetaobjectTranslation_pkey" PRIMARY KEY ("id")
);

-- Indexes for MetaobjectDefinition (IF NOT EXISTS)
CREATE UNIQUE INDEX IF NOT EXISTS "MetaobjectDefinition_shop_id_key" ON "MetaobjectDefinition"("shop", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "MetaobjectDefinition_shop_type_key" ON "MetaobjectDefinition"("shop", "type");
CREATE INDEX IF NOT EXISTS "MetaobjectDefinition_shop_idx" ON "MetaobjectDefinition"("shop");
CREATE INDEX IF NOT EXISTS "MetaobjectDefinition_lastSyncedAt_idx" ON "MetaobjectDefinition"("lastSyncedAt");

-- Indexes for Metaobject
CREATE UNIQUE INDEX IF NOT EXISTS "Metaobject_shop_id_key" ON "Metaobject"("shop", "id");
CREATE INDEX IF NOT EXISTS "Metaobject_shop_idx" ON "Metaobject"("shop");
CREATE INDEX IF NOT EXISTS "Metaobject_shop_type_idx" ON "Metaobject"("shop", "type");
CREATE INDEX IF NOT EXISTS "Metaobject_lastSyncedAt_idx" ON "Metaobject"("lastSyncedAt");

-- Indexes for MetaobjectTranslation
CREATE UNIQUE INDEX IF NOT EXISTS "MetaobjectTranslation_shop_metaobjectId_key_locale_key" ON "MetaobjectTranslation"("shop", "metaobjectId", "key", "locale");
CREATE INDEX IF NOT EXISTS "MetaobjectTranslation_shop_metaobjectId_idx" ON "MetaobjectTranslation"("shop", "metaobjectId");
CREATE INDEX IF NOT EXISTS "MetaobjectTranslation_shop_type_locale_idx" ON "MetaobjectTranslation"("shop", "type", "locale");
CREATE INDEX IF NOT EXISTS "MetaobjectTranslation_locale_idx" ON "MetaobjectTranslation"("locale");
