-- AlterTable
ALTER TABLE "AISettings" ADD COLUMN "subscriptionPlan" TEXT NOT NULL DEFAULT 'basic';

-- Add comment explaining valid values
COMMENT ON COLUMN "AISettings"."subscriptionPlan" IS 'Valid values: free, basic, pro, max';
