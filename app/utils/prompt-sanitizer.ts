/**
 * AI Prompt Sanitization Utility
 *
 * Prevents prompt injection attacks by sanitizing user input
 * before including it in AI prompts.
 */

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
    console.warn(`[PROMPT_SANITIZER] Input truncated from ${input.length} to ${maxLength} characters`);
  }

  // 3. Remove dangerous patterns
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(sanitized)) {
      console.warn(`[PROMPT_SANITIZER] Dangerous pattern detected and removed: ${pattern}`);
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

/**
 * Sanitize multiple fields for batch operations
 */
export function sanitizePromptFields(
  fields: Record<string, string>
): Record<string, string> {
  const sanitized: Record<string, string> = {};

  for (const [key, value] of Object.entries(fields)) {
    sanitized[key] = sanitizePromptInput(value, {
      fieldType: key as keyof typeof MAX_INPUT_LENGTH,
      allowNewlines: key === 'description' || key === 'body',
    });
  }

  return sanitized;
}

/**
 * Validate that prompt input doesn't contain suspicious patterns
 * Returns true if input is safe, false otherwise
 */
export function validatePromptInput(input: string): {
  isValid: boolean;
  issues: string[];
} {
  const issues: string[] = [];

  // Check for dangerous patterns
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(input)) {
      issues.push(`Contains suspicious pattern: ${pattern.source}`);
    }
  }

  // Check for excessive length
  if (input.length > MAX_INPUT_LENGTH.general * 2) {
    issues.push(`Input too long: ${input.length} characters`);
  }

  // Check for unusual character sequences
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(input)) {
    issues.push('Contains control characters');
  }

  return {
    isValid: issues.length === 0,
    issues,
  };
}
