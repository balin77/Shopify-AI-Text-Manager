/**
 * Input Validation Schemas
 *
 * Uses Zod for type-safe validation of user inputs
 */

import { z } from 'zod';

/**
 * API Key validation patterns
 */
const API_KEY_PATTERNS = {
  huggingface: /^hf_[A-Za-z0-9]{40}$/,
  gemini: /^AIzaSy[A-Za-z0-9_-]{33}$/,
  claude: /^sk-ant-[A-Za-z0-9_-]{95,}$/,
  openai: /^sk-[A-Za-z0-9]{48,}$/,
  grok: /^xai-[A-Za-z0-9]{40,}$/,
  deepseek: /^sk-[A-Za-z0-9]{48,}$/,
};

/**
 * AI Settings validation schema
 */
export const AISettingsSchema = z.object({
  // API Keys - optional but must match format if provided
  huggingfaceApiKey: z.string()
    .regex(API_KEY_PATTERNS.huggingface, 'Invalid Hugging Face API key format')
    .optional()
    .or(z.literal('')),

  geminiApiKey: z.string()
    .regex(API_KEY_PATTERNS.gemini, 'Invalid Google Gemini API key format')
    .optional()
    .or(z.literal('')),

  claudeApiKey: z.string()
    .regex(API_KEY_PATTERNS.claude, 'Invalid Claude API key format')
    .optional()
    .or(z.literal('')),

  openaiApiKey: z.string()
    .regex(API_KEY_PATTERNS.openai, 'Invalid OpenAI API key format')
    .optional()
    .or(z.literal('')),

  grokApiKey: z.string()
    .regex(API_KEY_PATTERNS.grok, 'Invalid Grok API key format')
    .optional()
    .or(z.literal('')),

  deepseekApiKey: z.string()
    .regex(API_KEY_PATTERNS.deepseek, 'Invalid DeepSeek API key format')
    .optional()
    .or(z.literal('')),

  // Provider selection
  preferredProvider: z.enum(['huggingface', 'gemini', 'claude', 'openai', 'grok', 'deepseek']),

  // App language
  appLanguage: z.enum(['de', 'en']),

  // Rate limits - must be positive integers
  hfMaxTokensPerMinute: z.number().int().min(1000).max(10000000).optional(),
  hfMaxRequestsPerMinute: z.number().int().min(1).max(1000).optional(),

  geminiMaxTokensPerMinute: z.number().int().min(1000).max(10000000).optional(),
  geminiMaxRequestsPerMinute: z.number().int().min(1).max(1000).optional(),

  claudeMaxTokensPerMinute: z.number().int().min(1000).max(10000000).optional(),
  claudeMaxRequestsPerMinute: z.number().int().min(1).max(1000).optional(),

  openaiMaxTokensPerMinute: z.number().int().min(1000).max(10000000).optional(),
  openaiMaxRequestsPerMinute: z.number().int().min(1).max(1000).optional(),

  grokMaxTokensPerMinute: z.number().int().min(1000).max(10000000).optional(),
  grokMaxRequestsPerMinute: z.number().int().min(1).max(1000).optional(),

  deepseekMaxTokensPerMinute: z.number().int().min(1000).max(10000000).optional(),
  deepseekMaxRequestsPerMinute: z.number().int().min(1).max(1000).optional(),
});

/**
 * AI Instructions validation schema
 */
export const AIInstructionsSchema = z.object({
  titleFormat: z.string().max(500).optional().or(z.literal('')),
  titleInstructions: z.string().max(2000).optional().or(z.literal('')),

  descriptionFormat: z.string().max(5000).optional().or(z.literal('')),
  descriptionInstructions: z.string().max(2000).optional().or(z.literal('')),

  handleFormat: z.string().max(200).optional().or(z.literal('')),
  handleInstructions: z.string().max(2000).optional().or(z.literal('')),

  seoTitleFormat: z.string().max(200).optional().or(z.literal('')),
  seoTitleInstructions: z.string().max(2000).optional().or(z.literal('')),

  metaDescFormat: z.string().max(500).optional().or(z.literal('')),
  metaDescInstructions: z.string().max(2000).optional().or(z.literal('')),

  altTextFormat: z.string().max(300).optional().or(z.literal('')),
  altTextInstructions: z.string().max(2000).optional().or(z.literal('')),
});

/**
 * Helper function to safely parse form data
 */
export function parseFormData<T>(
  formData: FormData,
  schema: z.ZodSchema<T>
): { success: true; data: T } | { success: false; error: string } {
  try {
    // Convert FormData to object
    const obj: Record<string, any> = {};

    // Iterate through FormData entries using Array.from for TypeScript compatibility
    const entries = Array.from(formData as any);
    for (const [key, value] of entries) {
      // Handle number fields
      if (key.includes('Max') && key.includes('PerMinute')) {
        const num = parseInt(value as string, 10);
        obj[key] = isNaN(num) ? undefined : num;
      } else {
        obj[key] = value;
      }
    }

    // Validate with schema
    const validated = schema.parse(obj);

    return { success: true, data: validated };
  } catch (error) {
    if (error instanceof z.ZodError) {
      const issues = error.issues.map(issue =>
        `${issue.path.join('.')}: ${issue.message}`
      ).join(', ');

      return { success: false, error: `Validation failed: ${issues}` };
    }

    return { success: false, error: 'Unknown validation error' };
  }
}

/**
 * Validate shop domain format
 */
export function isValidShopDomain(domain: string): boolean {
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(domain);
}

/**
 * Validate locale code
 */
export function isValidLocale(locale: string): boolean {
  return /^[a-z]{2}(-[A-Z]{2})?$/.test(locale);
}

/**
 * Validate product/resource GID
 */
export function isValidShopifyGID(gid: string): boolean {
  return /^gid:\/\/shopify\/[A-Z][a-z]+\/\d+$/.test(gid);
}
