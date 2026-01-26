-- AlterTable
ALTER TABLE "Task" ADD COLUMN "provider" TEXT;

-- Add comment explaining valid values
COMMENT ON COLUMN "Task"."provider" IS 'AI provider used for this task (huggingface, gemini, claude, openai, grok, deepseek) - used for recovery after server restart';
