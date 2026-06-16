/**
 * AI Prompt Sanitization Utility
 *
 * Prevents prompt injection attacks by sanitizing user input
 * before including it in AI prompts.
 */

import { logger } from '~/utils/logger.server';

/**
 * List of dangerous patterns that could be used for prompt injection
 */
const DANGEROUS_PATTERNS = [
  /ignore\s+previous\s+instructions/gi,
  /ignore\s+all\s+previous/gi,
  /disregard\s+previous/gi,
  /forget\s+previous/gi,
  /system\s*:/gi,
  /assistant\s*:/gi,
  /\[system\]/gi,
  /\[assistant\]/gi,
  /<\|im_start\|>/gi,
  /<\|im_end\|>/gi,
  /\n\n\s*system:/gi,
  /\n\n\s*assistant:/gi,
  /you\s+are\s+now/gi,
  /act\s+as\s+if/gi,
  /pretend\s+you\s+are/gi,
  /roleplay\s+as/gi,
];

// No character limits are enforced here intentionally. Long content (e.g. terms & conditions,
// legal pages) must be sent to the AI untruncated. If the input exceeds the model's context
// window the AI provider returns an error, which is caught upstream and shown to the user.
export type SanitizeFieldType = 'title' | 'description' | 'handle' | 'seoTitle' | 'metaDescription' | 'altText' | 'general';

export function isValidFieldType(key: string): key is SanitizeFieldType {
  const known: SanitizeFieldType[] = ['title', 'description', 'handle', 'seoTitle', 'metaDescription', 'altText', 'general'];
  return known.includes(key as SanitizeFieldType);
}

export interface SanitizeOptions {
  maxLength?: number;
  fieldType?: SanitizeFieldType;
  allowNewlines?: boolean;
}

/**
 * Sanitize user input before including it in AI prompts.
 *
 * This function:
 * 1. Removes or escapes dangerous prompt-injection patterns
 * 2. Normalizes whitespace
 * 3. Escapes special characters that could break prompt structure
 *
 * NOTE: No truncation is applied — see comment above.
 */
export function sanitizePromptInput(
  input: string,
  options: SanitizeOptions = {}
): string {
  if (!input) return '';

  let sanitized = input;

  // 1. Remove dangerous patterns
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(sanitized)) {
      logger.warn(`[PROMPT_SANITIZER] Dangerous pattern detected and removed: ${pattern}`);
      sanitized = sanitized.replace(pattern, '[REMOVED]');
    }
  }

  // 2. Normalize newlines (optional)
  if (!options.allowNewlines) {
    sanitized = sanitized.replace(/\n+/g, ' ');
  } else {
    // Limit consecutive newlines to 2
    sanitized = sanitized.replace(/\n{3,}/g, '\n\n');
  }

  // 3. Normalize whitespace
  // NOTE: `\s` matches `\n`/`\t`, so a blanket /\s+/g -> ' ' would destroy every
  // newline even when allowNewlines is true, silently flattening multi-line
  // descriptions/policies/T&C into one run-on line. To honor the allowNewlines
  // contract we must only collapse horizontal whitespace in that branch.
  if (options.allowNewlines) {
    sanitized = sanitized
      .replace(/[^\S\r\n]+/g, ' ') // collapse spaces/tabs only, keep newlines
      .replace(/ *\n */g, '\n')    // trim spaces around line breaks
      .replace(/\n{3,}/g, '\n\n')  // re-cap blank lines after collapsing
      .trim();
  } else {
    sanitized = sanitized.replace(/\s+/g, ' ').trim();
  }

  // 4. Cap runs of backticks so a merchant code sample can't blow open a
  //    fenced block in the prompt structure.
  // R5-L4: the previous `.replace(/\${/g, '$ {')` ("prevent template literal
  // injection") was useless AND corrupting. The sanitized text is passed as
  // an interpolated VALUE into a prompt template literal
  // (`...${sanitizedContent}...`); JS does not recursively re-evaluate the
  // contents of an interpolated string, so `${` is never an injection vector
  // here. The replacement only mutated legitimate merchant content (CSS
  // custom-property usage, shell `${VAR}`, JS/TS samples) into `$ {`, which
  // the model then reproduced verbatim. Removed.
  sanitized = sanitized.replace(/`{3,}/g, '```');

  return sanitized;
}
