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

/**
 * Maximum allowed length for user input in prompts
 */
const MAX_INPUT_LENGTH = {
  title: 200,
  description: 5000,
  handle: 100,
  seoTitle: 150,
  metaDescription: 300,
  altText: 200,
  general: 1000,
};

export type SanitizeFieldType = keyof typeof MAX_INPUT_LENGTH;

const VALID_FIELD_TYPES = new Set<string>(Object.keys(MAX_INPUT_LENGTH));

export function isValidFieldType(key: string): key is SanitizeFieldType {
  return VALID_FIELD_TYPES.has(key);
}

export interface SanitizeOptions {
  maxLength?: number;
  fieldType?: keyof typeof MAX_INPUT_LENGTH;
  allowNewlines?: boolean;
}

/**
 * Sanitize user input before including it in AI prompts
 *
 * This function:
 * 1. Truncates input to maximum length
 * 2. Removes or escapes dangerous patterns
 * 3. Normalizes whitespace
 * 4. Escapes special characters that could break prompt structure
 */
export function sanitizePromptInput(
  input: string,
  options: SanitizeOptions = {}
): string {
  if (!input) return '';

  let sanitized = input;

  // 1. Determine max length
  const maxLength = options.maxLength ||
    (options.fieldType ? MAX_INPUT_LENGTH[options.fieldType] : MAX_INPUT_LENGTH.general);

  // 2. Truncate to max length
  if (sanitized.length > maxLength) {
    sanitized = sanitized.substring(0, maxLength);
    logger.warn(`[PROMPT_SANITIZER] Input truncated from ${input.length} to ${maxLength} characters`);
  }

  // 3. Remove dangerous patterns
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(sanitized)) {
      logger.warn(`[PROMPT_SANITIZER] Dangerous pattern detected and removed: ${pattern}`);
      sanitized = sanitized.replace(pattern, '[REMOVED]');
    }
  }

  // 4. Normalize newlines (optional)
  if (!options.allowNewlines) {
    sanitized = sanitized.replace(/\n+/g, ' ');
  } else {
    // Limit consecutive newlines to 2
    sanitized = sanitized.replace(/\n{3,}/g, '\n\n');
  }

  // 5. Normalize whitespace
  sanitized = sanitized.replace(/\s+/g, ' ').trim();

  // 6. Escape backticks and special characters that could break JSON
  sanitized = sanitized
    .replace(/`{3,}/g, '```')  // Limit consecutive backticks
    .replace(/\${/g, '$ {');    // Prevent template literal injection

  return sanitized;
}
