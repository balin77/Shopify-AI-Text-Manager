CREATE TABLE "OptionValueMemory" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "optionValue" TEXT NOT NULL,
    "savedAs" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OptionValueMemory_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OptionValueMemory_shop_optionValue_key" ON "OptionValueMemory"("shop", "optionValue");
CREATE INDEX "OptionValueMemory_shop_idx" ON "OptionValueMemory"("shop");
