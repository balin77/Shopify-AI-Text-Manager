-- Add formatPreserveInstructions column to AIInstructions table
-- This column stores custom instructions for the "Format" function

ALTER TABLE "AIInstructions"
ADD COLUMN IF NOT EXISTS "formatPreserveInstructions" TEXT;
