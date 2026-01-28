-- AlterTable (only if table exists)
DO $$
BEGIN
    -- First ensure the AIInstructions table exists
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'AIInstructions') THEN
        CREATE TABLE "AIInstructions" (
            "id" TEXT NOT NULL,
            "shop" TEXT NOT NULL,
            "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" TIMESTAMP(3) NOT NULL,
            CONSTRAINT "AIInstructions_pkey" PRIMARY KEY ("id")
        );
        CREATE UNIQUE INDEX "AIInstructions_shop_key" ON "AIInstructions"("shop");
    END IF;

    -- Add altTextFormat column if it doesn't exist
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'AIInstructions' AND column_name = 'altTextFormat'
    ) THEN
        ALTER TABLE "AIInstructions" ADD COLUMN "altTextFormat" TEXT;
    END IF;

    -- Add altTextInstructions column if it doesn't exist
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'AIInstructions' AND column_name = 'altTextInstructions'
    ) THEN
        ALTER TABLE "AIInstructions" ADD COLUMN "altTextInstructions" TEXT;
    END IF;
END $$;
