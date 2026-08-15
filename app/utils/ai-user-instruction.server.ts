/**
 * Ad-hoc merchant instruction for a single AI generation request.
 *
 * The "Improve/Generate with AI" buttons open a small input box before they
 * fire (AIInstructionPrompt). What the merchant types there is sent as the
 * `userInstruction` form field and appended to the prompt as the LAST and
 * HIGHEST-priority block: it deliberately outranks the stored AI instructions,
 * the writing style, the format example and the character-limit requirement.
 * Leaving the box empty keeps the previous behaviour byte-for-byte — no field
 * is sent and no block is appended.
 *
 * The instruction still goes through `sanitizePromptInput`, so the usual
 * prompt-injection patterns are stripped even though the text is privileged.
 */

import { AI_USER_INSTRUCTION_MAX_LENGTH } from "~/config/constants";
import { getFormString } from "~/utils/form-data.utils";
import { sanitizePromptInput } from "~/utils/prompt-sanitizer";

/**
 * Read + sanitize the per-request instruction from a submitted FormData.
 *
 * @returns the sanitized instruction, or `null` when none was sent (or it was
 *          empty / whitespace-only after sanitizing).
 */
export function readUserInstruction(formData: FormData): string | null {
  const raw = getFormString(formData, "userInstruction");
  if (!raw) return null;

  // Cap BEFORE sanitizing so a huge payload can't be run through the regex
  // passes, and cap again after in case sanitizing grew the string
  // ([REMOVED] replacements can be longer than what they replaced).
  const sanitized = sanitizePromptInput(raw.slice(0, AI_USER_INSTRUCTION_MAX_LENGTH), {
    fieldType: "general",
    allowNewlines: true,
  })
    .slice(0, AI_USER_INSTRUCTION_MAX_LENGTH)
    .trim();

  return sanitized || null;
}

/**
 * Append the merchant instruction to a finished prompt.
 *
 * Placed after everything else — including the CRITICAL LENGTH CONSTRAINT —
 * because the merchant explicitly asked for this instruction to win over every
 * other rule in the prompt. The block restates the "return only the content"
 * rule so the override can't be read as permission to add commentary.
 */
export function appendUserInstruction(prompt: string, instruction: string | null): string {
  if (!instruction) return prompt;

  return (
    `${prompt}\n\n` +
    `HIGHEST PRIORITY — INSTRUCTION FROM THE SHOP OWNER FOR THIS SPECIFIC REQUEST:\n` +
    `${instruction}\n\n` +
    `This instruction OVERRIDES every other rule, guideline, requirement, writing style, ` +
    `format example and length constraint stated above. Wherever it conflicts with anything ` +
    `else in this prompt, follow this instruction. Everything above that it does NOT ` +
    `contradict still applies. Regardless of the instruction, still return ONLY the requested ` +
    `content itself — no explanations, no alternatives, no labels, no commentary.`
  );
}

/**
 * Convenience wrapper: read the instruction from `formData` and append it.
 * Use when the handler has no other reason to hold on to the raw value.
 */
export function withUserInstruction(prompt: string, formData: FormData): string {
  return appendUserInstruction(prompt, readUserInstruction(formData));
}
