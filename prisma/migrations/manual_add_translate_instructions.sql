-- Add translateInstructions column to AIInstructions table
-- This column stores custom instructions for the "Translate" function

ALTER TABLE "AIInstructions"
ADD COLUMN IF NOT EXISTS "translateInstructions" TEXT;
