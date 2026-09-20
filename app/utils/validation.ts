/**
 * Input Validation Schemas
 *
 * Uses Zod for type-safe validation of user inputs
 */

import { z } from 'zod';

/**
 * API Key validation patterns.
 *
 * These are intentionally permissive — they exist to catch obvious typos
 * (wrong prefix, wildly wrong length, random characters), NOT to enforce
 * exact upstream formats. Providers change key shapes frequently
 * (e.g. OpenAI added sk-proj-/sk-svcacct-, DeepSeek shifted away from
 * strict hex). The real validity check is the first AI call that uses the
 * key; a too-strict regex here just blocks valid keys at save time.
 */
const API_KEY_PATTERNS = {
  huggingface: /^hf_[A-Za-z0-9]{20,}$/,
  // Google API keys start with AIzaSy and are 39 chars total in practice,
  // but tolerate length drift.
  gemini: /^AIzaSy[A-Za-z0-9_-]{20,}$/,
  // Anthropic keys are sk-ant-… and typically 100+ chars; keep a generous floor.
  claude: /^sk-ant-[A-Za-z0-9_-]{20,}$/,
  openai: /^sk-[A-Za-z0-9_-]{20,}$/,
  // xAI keys may contain _/- in the body; was previously alphanumeric-only.
  grok: /^xai-[A-Za-z0-9_-]{20,}$/,
  // DeepSeek used to ship strict 32-hex keys but new keys are wider; accept
  // any sk-… of reasonable length so valid keys aren't rejected at save.
  deepseek: /^sk-[A-Za-z0-9_-]{20,}$/,
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

  // Model selection - free-form string since model IDs vary per provider
  selectedModel: z.string().max(200).optional().or(z.literal('')),

  // App language
  appLanguage: z.enum(['de', 'en', 'es']),

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

  // SEO title suffix (form sends "true"/"false" strings)
  // seoTitleSuffix(Enabled) are deliberately ABSENT: they belong to the
  // `saveSeoSettings` branch, which reads them off formData directly. While
  // they were declared here, `.optional().default(false)` meant a payload that
  // merely omitted them still produced `false` in the parsed data — which is
  // how the AI tab's save cleared a suffix configured in the SEO tab. A field
  // no branch may write must not be parseable here either, or the next
  // `...data` spread reintroduces the bug without naming it.
});

/**
 * AI Instructions validation schema - Entity-specific fields
 */
export const AIInstructionsSchema = z.object({
  // GENERAL (Writing Style Instructions)
  writingStyleInstructions: z.string().max(3000).optional().or(z.literal('')),
  // GENERAL (Format Instructions)
  formatPreserveInstructions: z.string().max(3000).optional().or(z.literal('')),
  // GENERAL (Translate Instructions)
  translateInstructions: z.string().max(3000).optional().or(z.literal('')),

  // PRODUCTS
  productTitleFormat: z.string().max(500).optional().or(z.literal('')),
  productTitleInstructions: z.string().max(2000).optional().or(z.literal('')),
  productDescriptionFormat: z.string().max(5000).optional().or(z.literal('')),
  productDescriptionInstructions: z.string().max(2000).optional().or(z.literal('')),
  productHandleFormat: z.string().max(200).optional().or(z.literal('')),
  productHandleInstructions: z.string().max(2000).optional().or(z.literal('')),
  productSeoTitleFormat: z.string().max(200).optional().or(z.literal('')),
  productSeoTitleInstructions: z.string().max(2000).optional().or(z.literal('')),
  productMetaDescFormat: z.string().max(500).optional().or(z.literal('')),
  productMetaDescInstructions: z.string().max(2000).optional().or(z.literal('')),
  productAltTextFormat: z.string().max(300).optional().or(z.literal('')),
  productAltTextInstructions: z.string().max(2000).optional().or(z.literal('')),

  // COLLECTIONS
  collectionTitleFormat: z.string().max(500).optional().or(z.literal('')),
  collectionTitleInstructions: z.string().max(2000).optional().or(z.literal('')),
  collectionDescriptionFormat: z.string().max(5000).optional().or(z.literal('')),
  collectionDescriptionInstructions: z.string().max(2000).optional().or(z.literal('')),
  collectionHandleFormat: z.string().max(200).optional().or(z.literal('')),
  collectionHandleInstructions: z.string().max(2000).optional().or(z.literal('')),
  collectionSeoTitleFormat: z.string().max(200).optional().or(z.literal('')),
  collectionSeoTitleInstructions: z.string().max(2000).optional().or(z.literal('')),
  collectionMetaDescFormat: z.string().max(500).optional().or(z.literal('')),
  collectionMetaDescInstructions: z.string().max(2000).optional().or(z.literal('')),

  // BLOGS
  blogTitleFormat: z.string().max(500).optional().or(z.literal('')),
  blogTitleInstructions: z.string().max(2000).optional().or(z.literal('')),
  blogDescriptionFormat: z.string().max(5000).optional().or(z.literal('')),
  blogDescriptionInstructions: z.string().max(2000).optional().or(z.literal('')),
  blogHandleFormat: z.string().max(200).optional().or(z.literal('')),
  blogHandleInstructions: z.string().max(2000).optional().or(z.literal('')),
  blogSeoTitleFormat: z.string().max(200).optional().or(z.literal('')),
  blogSeoTitleInstructions: z.string().max(2000).optional().or(z.literal('')),
  blogMetaDescFormat: z.string().max(500).optional().or(z.literal('')),
  blogMetaDescInstructions: z.string().max(2000).optional().or(z.literal('')),

  // PAGES
  pageTitleFormat: z.string().max(500).optional().or(z.literal('')),
  pageTitleInstructions: z.string().max(2000).optional().or(z.literal('')),
  pageDescriptionFormat: z.string().max(5000).optional().or(z.literal('')),
  pageDescriptionInstructions: z.string().max(2000).optional().or(z.literal('')),
  pageHandleFormat: z.string().max(200).optional().or(z.literal('')),
  pageHandleInstructions: z.string().max(2000).optional().or(z.literal('')),
  pageSeoTitleFormat: z.string().max(200).optional().or(z.literal('')),
  pageSeoTitleInstructions: z.string().max(2000).optional().or(z.literal('')),
  pageMetaDescFormat: z.string().max(500).optional().or(z.literal('')),
  pageMetaDescInstructions: z.string().max(2000).optional().or(z.literal('')),

  // POLICIES
  policyDescriptionFormat: z.string().max(5000).optional().or(z.literal('')),
  policyDescriptionInstructions: z.string().max(2000).optional().or(z.literal('')),
});

/**
 * Helper function to safely parse form data
 */
export function parseFormData<T>(
  formData: FormData,
  schema: z.ZodSchema<T>
): { success: true; data: T } | { success: false; error: string; fieldErrors: Record<string, string> } {
  try {
    // Convert FormData to object
    const obj: Record<string, any> = {};

    // Iterate through FormData entries using Array.from for TypeScript compatibility
    const entries = Array.from(formData.entries());
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
      // Build per-field map so the UI can render the message under the
      // exact TextField that failed (instead of just a toast far from
      // the input).
      const fieldErrors: Record<string, string> = {};
      for (const issue of error.issues) {
        const key = issue.path.join('.') || '_form';
        if (!fieldErrors[key]) fieldErrors[key] = issue.message;
      }
      const issues = error.issues.map(issue =>
        `${issue.path.join('.')}: ${issue.message}`
      ).join(', ');

      return { success: false, error: `Validation failed: ${issues}`, fieldErrors };
    }

    return { success: false, error: 'Unknown validation error', fieldErrors: {} };
  }
}

/**
 * Safely parse a JSON string, returning a fallback value on failure.
 */
export function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (value == null) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/**
 * Validate shop domain format
 */
export function isValidShopDomain(domain: string): boolean {
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(domain);
}

/**
 * BCP-47 as Shopify actually issues it, and nothing wider.
 *
 * The old pattern was `^[a-z]{2}(-[A-Z]{2})?$`, which accepted `de-CH` and
 * `pt-BR` but REJECTED two shapes Shopify really publishes:
 *   - `es-419`   Latin American Spanish (UN M.49 numeric region)
 *   - `zh-Hans` / `zh-Hant`   script subtag, four letters
 * A shop with either as a published locale got a hard "Invalid target locale"
 * on every translate, from every entry point, while `LOCALE_NAMES` in
 * ai.service.ts already carried the right prompt name for exactly those codes.
 *
 * Shape: language (2-3 letters) + optional script (4 letters, title case) +
 * optional region (2 letters OR 3 digits). Deliberately no further subtags
 * (variants, extensions, private use): none is reachable from a Shopify shop
 * locale, and coverage nobody can point at is surface, not safety.
 *
 * It stays a VALIDATOR and never a normalizer: casing is decided per
 * destination (templates-update.action.ts writes a theme file under the name
 * Shopify RETURNED), so rewriting `pt-BR` here would quietly compete with it.
 * Anchored and length-bounded by construction, so an empty string, a GID, a
 * path, an injection payload or arbitrary length is still refused.
 */
const LOCALE_PATTERN = /^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|[0-9]{3}))?$/;

/** Longest code the pattern can match: `xxx-Xxxx-999`. */
const LOCALE_MAX_LEN = 12;

/**
 * Validate locale code
 */
export function isValidLocale(locale: string): boolean {
  return LOCALE_PATTERN.test(locale);
}

/**
 * Validate Shopify GID format.
 * Accepts compound resource types like MediaImage, OnlineStorePage, etc.
 */
export function isValidShopifyGID(gid: string): boolean {
  return /^gid:\/\/shopify\/[A-Z][a-zA-Z]*\/\d+$/.test(gid);
}

// ---------------------------------------------------------------------------
// API Route Schemas
// ---------------------------------------------------------------------------

const LocaleSchema = z.string()
  .min(2)
  .max(LOCALE_MAX_LEN)
  .regex(LOCALE_PATTERN, 'Invalid locale format (expected: xx, xx-XX, xx-Xxxx or xx-999)');

const ShopifyGIDSchema = z.string()
  .regex(/^gid:\/\/shopify\/[A-Z][a-zA-Z]*\/\d+$/, 'Invalid Shopify GID format');

/**
 * Schema for the common fields shared by all action types in api.ai.tsx
 */
export const AIRequestBaseSchema = z.object({
  action: z.enum(['translateField', 'rewriteField', 'generateField', 'translateAll']),
  contentType: z.string().min(1).max(50),
  itemId: z.string().max(500).optional(),
});

/**
 * Schema for the request body of api.update-plan.tsx
 */
export const UpdatePlanSchema = z.object({
  plan: z.enum(['free', 'basic', 'pro', 'max']),
});

/**
 * Schema for query parameters in api.sync-content.tsx
 */
const VALID_SYNC_TYPES = [
  'collections', 'articles', 'pages', 'policies', 'themes',
  // Discovery-capable list-button targets (BackgroundSyncService.syncAll phases).
  'metaobjects', 'system', 'delivery', 'onlineStoreExtras', 'sellingPlans', 'menus',
] as const;
export const SyncContentQuerySchema = z.object({
  types: z
    .string()
    .optional()
    .transform((val) => (val ? val.split(',').map((t) => t.trim()) : [...VALID_SYNC_TYPES]))
    .pipe(
      z.array(z.enum(VALID_SYNC_TYPES))
    ),
});

/**
 * Helper to parse and validate a JSON request body with a Zod schema.
 * Returns either the typed data or a 400 Response-compatible error object.
 */
export async function parseJsonBody<T>(
  request: Request,
  schema: z.ZodSchema<T>
): Promise<{ success: true; data: T } | { success: false; error: string; status: 400 }> {
  try {
    const body = await request.json();
    const result = schema.safeParse(body);
    if (!result.success) {
      const issues = result.error.issues
        .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
        .join(', ');
      return { success: false, error: `Validation failed: ${issues}`, status: 400 };
    }
    return { success: true, data: result.data };
  } catch {
    return { success: false, error: 'Invalid JSON body', status: 400 };
  }
}
