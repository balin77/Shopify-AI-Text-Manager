import { HfInference } from '@huggingface/inference';
import { GoogleGenerativeAI, type GenerativeModel } from '@google/generative-ai';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { AIQueueService } from './ai-queue.service';
import { sanitizePromptInput, isValidFieldType } from '../../app/utils/prompt-sanitizer';
import { loggers } from '../../app/utils/logger.server';
import { DEFAULT_MODELS } from '../../app/config/ai-models.config';

export type AIProvider = 'huggingface' | 'gemini' | 'claude' | 'openai' | 'grok' | 'deepseek';

const LOCALE_NAMES: Record<string, string> = {
  en: 'English', fr: 'French', es: 'Spanish', it: 'Italian',
  de: 'German', pt: 'Portuguese', nl: 'Dutch', ja: 'Japanese',
  ko: 'Korean', zh: 'Chinese', ru: 'Russian', ar: 'Arabic',
  sv: 'Swedish', da: 'Danish', no: 'Norwegian', fi: 'Finnish',
  pl: 'Polish', cs: 'Czech', tr: 'Turkish', th: 'Thai',
  vi: 'Vietnamese', id: 'Indonesian', ms: 'Malay', hi: 'Hindi',
};

const VALID_PROVIDERS: readonly AIProvider[] = ['huggingface', 'gemini', 'claude', 'openai', 'grok', 'deepseek'];

/** Validate and return a safe AIProvider, falling back to 'huggingface'. */
export function toValidProvider(value: string | null | undefined): AIProvider {
  return VALID_PROVIDERS.includes(value as AIProvider) ? (value as AIProvider) : 'huggingface';
}

export interface AIServiceConfig {
  huggingfaceApiKey?: string;
  geminiApiKey?: string;
  claudeApiKey?: string;
  openaiApiKey?: string;
  grokApiKey?: string;
  deepseekApiKey?: string;
  selectedModel?: string;
}

export class AIService {
  private huggingface?: HfInference;
  private gemini?: GenerativeModel;
  private anthropic?: Anthropic;
  private openai?: OpenAI;
  private grok?: OpenAI;
  private deepseek?: OpenAI;
  private provider: AIProvider;
  private config: AIServiceConfig;
  private queue: AIQueueService;
  private shop?: string;
  private taskId?: string;

  constructor(provider: AIProvider = 'huggingface', config: AIServiceConfig = {}, shop?: string, taskId?: string) {
    this.provider = provider;
    this.config = config;
    this.shop = shop;
    this.taskId = taskId;
    this.queue = AIQueueService.getInstance();
    this.initializeProvider();
  }

  private getModel(): string {
    return this.config.selectedModel || DEFAULT_MODELS[this.provider];
  }

  private initializeProvider() {
    if (this.provider === 'huggingface') {
      const apiKey = this.config.huggingfaceApiKey || process.env.HUGGINGFACE_API_KEY || '';
      this.huggingface = new HfInference(apiKey);
      loggers.ai('info', 'AI Provider: Hugging Face (FREE)');
    } else if (this.provider === 'gemini') {
      const apiKey = this.config.geminiApiKey || process.env.GOOGLE_API_KEY || '';
      const genAI = new GoogleGenerativeAI(apiKey);
      this.gemini = genAI.getGenerativeModel({ model: this.getModel() });
      loggers.ai('info', 'AI Provider: Google Gemini (FREE)');
    } else if (this.provider === 'claude') {
      const apiKey = this.config.claudeApiKey || process.env.ANTHROPIC_API_KEY || '';
      this.anthropic = new Anthropic({ apiKey });
      loggers.ai('info', 'AI Provider: Claude');
    } else if (this.provider === 'openai') {
      const apiKey = this.config.openaiApiKey || process.env.OPENAI_API_KEY || '';
      this.openai = new OpenAI({ apiKey });
      loggers.ai('info', 'AI Provider: OpenAI');
    } else if (this.provider === 'grok') {
      const apiKey = this.config.grokApiKey || process.env.GROK_API_KEY || '';
      this.grok = new OpenAI({
        apiKey,
        baseURL: 'https://api.x.ai/v1',
      });
      loggers.ai('info', 'AI Provider: Grok (X.AI)');
    } else if (this.provider === 'deepseek') {
      const apiKey = this.config.deepseekApiKey || process.env.DEEPSEEK_API_KEY || '';
      this.deepseek = new OpenAI({
        apiKey,
        baseURL: 'https://api.deepseek.com',
      });
      loggers.ai('info', 'AI Provider: DeepSeek');
    }
  }

  async generateSEO(productTitle: string, productDescription: string, language?: string): Promise<{
    seoTitle: string;
    metaDescription: string;
    reasoning: string;
  }> {
    // Sanitize inputs to prevent prompt injection
    const sanitizedTitle = sanitizePromptInput(productTitle, { fieldType: 'title' });
    const sanitizedDescription = sanitizePromptInput(productDescription, {
      fieldType: 'description',
      allowNewlines: true
    });

    const languageInstruction = language ? `Output the result in ${language}.` : 'Output the result in the same language as the product title.';

    const prompt = `You are an SEO expert for e-commerce. Optimize the following product information for search engines.

Product Title: ${sanitizedTitle}
Product Description: ${sanitizedDescription}

Create:
1. An optimized SEO title (max. 60 characters)
2. A meta description (120-160 characters)
3. A brief explanation of your optimizations

Respond in the following JSON format:
{
  "seoTitle": "...",
  "metaDescription": "...",
  "reasoning": "..."
}

${languageInstruction}`;

    const responseText = await this.askAI(prompt);
    return this.parseJSONResponse(responseText);
  }

  async translateContent(
    content: string,
    fromLang: string,
    toLang: string
  ): Promise<string> {
    // Sanitize content before translation
    const sanitizedContent = sanitizePromptInput(content, {
      maxLength: 5000,
      allowNewlines: true
    });

    const prompt = `Translate the following text from ${fromLang} to ${toLang}. Keep HTML tags.

Text: ${sanitizedContent}

Return ONLY the translated text. Do NOT wrap it in XML tags, quotes, or any other formatting. No explanations.`;

    const response = await this.askAI(prompt);
    return AIService.stripXmlWrapper(response);
  }

  /** Strips single-root XML wrapper tags that some models add (e.g. <translation>…</translation>). */
  private static stripXmlWrapper(text: string): string {
    const trimmed = text.trim();
    const match = trimmed.match(/^<([a-zA-Z][a-zA-Z0-9-]*)>([\s\S]*)<\/\1>$/);
    return match ? match[2].trim() : trimmed;
  }

  /**
   * Strips leading/trailing markdown code fences (``` or ```html / ```json etc.)
   * that some models add around their entire response. Idempotent and safe on
   * already-clean text — returns the trimmed original if no fence is found.
   */
  private static stripMarkdownFence(text: string): string {
    const trimmed = text.trim();
    const match = trimmed.match(/^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?```$/);
    return match ? match[1].trim() : trimmed;
  }

  async translateTemplate(template: string, fromLang: string, toLang: string): Promise<string> {
    const sanitized = sanitizePromptInput(template, { maxLength: 500, allowNewlines: false });

    // Replace every {VarName} with a unique opaque token before sending to the AI.
    // This prevents the AI from "absorbing" the variable into the surrounding translation.
    const varNames: string[] = [];
    const tokenized = sanitized.replace(/\{([^}]+)\}/g, (_, name: string) => {
      const idx = varNames.length;
      varNames.push(name);
      return `TPLVAR${idx}`;
    });

    // If there are no variables, fall back to generic translateContent.
    if (varNames.length === 0) {
      return this.translateContent(sanitized, fromLang, toLang);
    }

    const fromName = LOCALE_NAMES[fromLang] || fromLang;
    const toName = LOCALE_NAMES[toLang] || toLang;
    const tokenList = varNames.map((n, i) => `TPLVAR${i} = {${n}}`).join(', ');

    // Dedicated prompt that explicitly requires all TPLVAR tokens to be preserved.
    const prompt = `Translate the following product image alt-text template from ${fromName} to ${toName}.

Template: ${tokenized}

Rules:
- The tokens ${varNames.map((_, i) => `TPLVAR${i}`).join(', ')} are placeholders for product attributes (${tokenList}). You MUST keep ALL of them exactly as written — do not translate, omit, or reorder them.
- Return ONLY the translated template. No XML tags, no quotes, no explanations.`;

    const response = AIService.stripXmlWrapper(await this.askAI(prompt));

    // Find which TPLVAR tokens the AI dropped (before restoring, so regex is still intact).
    const dropped = varNames
      .map((name, i) => ({ name, token: `TPLVAR${i}` }))
      .filter(({ token }) => !response.includes(token));

    // Restore surviving tokens.
    let restored = response.replace(/TPLVAR(\d+)/g, (_, idx) => `{${varNames[parseInt(idx, 10)]}}`);

    // Append any dropped variables so they are never silently lost.
    if (dropped.length > 0) {
      loggers.ai('warn', '[AI-SERVICE] translateTemplate: AI dropped TPLVAR tokens, appending them', {
        dropped: dropped.map(d => d.name),
        fromLang,
        toLang,
      });
      restored = restored.trimEnd() + ' ' + dropped.map(d => `{${d.name}}`).join(' ');
    }

    return restored;
  }

  /**
   * Translate multiple alt-texts to multiple locales in a single AI request.
   * Much more efficient than calling translateContent() per image per locale.
   */
  async translateAltTextsBatch(
    altTexts: Record<string, string>,
    fromLang: string,
    targetLocales: string[],
    contentType: string = 'product'
  ): Promise<Record<string, Record<string, string>>> {
    const sanitizedAltTexts: Record<string, string> = {};
    for (const [key, value] of Object.entries(altTexts)) {
      if (value) {
        sanitizedAltTexts[key] = sanitizePromptInput(value, {
          maxLength: 1000,
          allowNewlines: false
        });
      }
    }

    if (Object.keys(sanitizedAltTexts).length === 0) {
      return {};
    }

    const localeNames = LOCALE_NAMES;

    const targetLanguages = targetLocales
      .map((loc) => `${localeNames[loc] || loc} (${loc})`)
      .join(', ');

    const altTextsText = Object.entries(sanitizedAltTexts)
      .map(([key, value]) => `Image ${key}: ${value}`)
      .join('\n');

    // Build expected JSON structure
    const jsonStructure: Record<string, Record<string, string>> = {};
    for (const key of Object.keys(sanitizedAltTexts)) {
      jsonStructure[key] = {};
      for (const locale of targetLocales) {
        jsonStructure[key][locale] = '...';
      }
    }

    const prompt = `Translate these ${contentType} image alt-texts from ${localeNames[fromLang] || fromLang} to: ${targetLanguages}.

${altTextsText}

Requirements:
- Keep translations concise and descriptive
- Maintain similar character length
- Preserve any product-specific terminology

Respond in JSON format:
${JSON.stringify(jsonStructure, null, 2)}`;

    const responseText = await this.askAI(prompt);
    return this.parseJSONResponse(responseText);
  }

  async translateSlug(
    slug: string,
    fromLang: string,
    toLang: string
  ): Promise<string> {
    // Sanitize slug before translation
    const sanitizedSlug = sanitizePromptInput(slug, {
      maxLength: 200,
      allowNewlines: false
    });

    const prompt = `Translate the following URL slug/handle from ${fromLang} to ${toLang}.

IMPORTANT: The result MUST be a valid URL slug:
- Use only lowercase letters (a-z), numbers (0-9), and hyphens (-)
- Replace spaces with hyphens
- No special characters, no umlauts, no accents
- No spaces, no underscores
- Examples: "storage-boxes", "wooden-chair", "blue-t-shirt"

Source slug: ${sanitizedSlug}

Return only the translated URL slug, nothing else.`;

    return await this.askAI(prompt);
  }

  /**
   * Translate a URL slug to multiple locales in a single AI request
   * More efficient than calling translateSlug multiple times
   */
  async translateSlugBatch(
    slug: string,
    fromLang: string,
    targetLocales: string[]
  ): Promise<Record<string, string>> {
    const sanitizedSlug = sanitizePromptInput(slug, {
      maxLength: 200,
      allowNewlines: false
    });

    const localeNames = LOCALE_NAMES;

    const targetLanguages = targetLocales
      .map((loc) => `${localeNames[loc] || loc} (${loc})`)
      .join(', ');

    // Build expected JSON structure
    const jsonStructure: Record<string, string> = {};
    for (const locale of targetLocales) {
      jsonStructure[locale] = 'translated-slug';
    }

    const prompt = `Translate the following URL slug/handle from ${localeNames[fromLang] || fromLang} to: ${targetLanguages}.

IMPORTANT: Each result MUST be a valid URL slug:
- Use only lowercase letters (a-z), numbers (0-9), and hyphens (-)
- Replace spaces with hyphens
- No special characters, no umlauts, no accents
- No spaces, no underscores
- Examples: "storage-boxes", "wooden-chair", "blue-t-shirt"

Source slug: ${sanitizedSlug}

Respond in JSON format:
${JSON.stringify(jsonStructure, null, 2)}`;

    const responseText = await this.askAI(prompt);
    return this.parseJSONResponse(responseText);
  }

  /**
   * Translate short fields (title, seoTitle) to multiple locales in a single AI request
   * More efficient for fields that don't require extensive context
   */
  async translateShortFieldsBatch(
    fields: Record<string, string>,
    fromLang: string,
    targetLocales: string[],
    contentType: string = 'product'
  ): Promise<Record<string, Record<string, string>>> {
    // Only allow short fields
    const shortFieldKeys = ['title', 'seoTitle', 'handle', 'productType'];
    const filteredFields: Record<string, string> = {};

    for (const [key, value] of Object.entries(fields)) {
      if (shortFieldKeys.includes(key) && value) {
        filteredFields[key] = sanitizePromptInput(value, {
          fieldType: isValidFieldType(key) ? key : undefined,
          maxLength: key === 'handle' ? 200 : 500,
          allowNewlines: false
        });
      }
    }

    if (Object.keys(filteredFields).length === 0) {
      return {};
    }

    const localeNames = LOCALE_NAMES;

    const fieldNames: Record<string, string> = {
      title: 'Title',
      seoTitle: 'SEO Title',
      handle: 'URL Slug',
      productType: 'Product Type',
    };

    const targetLanguages = targetLocales
      .map((loc) => `${localeNames[loc] || loc} (${loc})`)
      .join(', ');

    // Build the fields section for the prompt
    const fieldsText = Object.entries(filteredFields)
      .map(([key, value]) => `${fieldNames[key] || key}: ${value}`)
      .join('\n');

    // Build expected JSON structure
    const jsonStructure: Record<string, Record<string, string>> = {};
    for (const locale of targetLocales) {
      jsonStructure[locale] = {};
      for (const key of Object.keys(filteredFields)) {
        jsonStructure[locale][key] = '...';
      }
    }

    const hasHandle = 'handle' in filteredFields;
    const handleInstructions = hasHandle
      ? `\n- URL slugs (handle) must be valid: only lowercase a-z, 0-9, hyphens. No special characters, umlauts, or accents.`
      : '';

    const prompt = `Translate these ${contentType} fields from ${localeNames[fromLang] || fromLang} to: ${targetLanguages}.

${fieldsText}

Requirements:
- Keep translations concise and natural
- Maintain similar character length${handleInstructions}

Respond in JSON format:
${JSON.stringify(jsonStructure, null, 2)}`;

    const responseText = await this.askAI(prompt);
    return this.parseJSONResponse(responseText);
  }

  /**
   * Translate an array of string values to a target locale in a single AI request.
   * Returns translated values in the same order as input.
   */
  async translateBatchValues(
    values: string[],
    fromLang: string,
    toLang: string,
    context: string = "product content"
  ): Promise<string[]> {
    if (values.length === 0) return [];

    const localeNames = LOCALE_NAMES;
    const fromName = localeNames[fromLang] || fromLang;
    const toName = localeNames[toLang] || toLang;

    loggers.ai('info', `[AI-SERVICE] Translating batch of ${values.length} values`, {
      fromLang,
      toLang,
      context,
      values: values.slice(0, 3), // Log first 3 values for debugging
    });

    // Build numbered list for clear mapping
    const numberedValues = values.map((v, i) => `${i + 1}. ${sanitizePromptInput(v, { maxLength: 500, allowNewlines: false })}`).join('\n');

    const prompt = `Translate these ${context} values from ${fromName} to ${toName} (${toLang}).

${numberedValues}

Requirements:
- Keep translations concise and natural
- Maintain similar character length
- Return ONLY a JSON array of translated strings in the same order

Respond in JSON format: ["translated1", "translated2", ...]`;

    loggers.ai('debug', '[AI-SERVICE] Batch translation prompt', { prompt: prompt.substring(0, 500) });

    const responseText = await this.askAI(prompt);

    loggers.ai('debug', '[AI-SERVICE] Batch translation response', { response: responseText.substring(0, 500) });

    const parsed = this.parseJSONResponse(responseText);

    // Handle both array and object responses
    if (Array.isArray(parsed)) {
      loggers.ai('info', `[AI-SERVICE] Batch translation successful: ${parsed.length} values translated`);
      return parsed.map(String);
    }

    // Fallback: return original values if parsing fails
    loggers.ai('warn', '[AI-SERVICE] Batch translation response was not an array, returning original values');
    return values;
  }

  async translateSEO(
    seoTitle: string,
    metaDescription: string,
    targetLocales: string[]
  ): Promise<Record<string, { seoTitle: string; metaDescription: string }>> {
    // Sanitize SEO fields
    const sanitizedTitle = sanitizePromptInput(seoTitle, { fieldType: 'seoTitle' });
    const sanitizedDescription = sanitizePromptInput(metaDescription, { fieldType: 'metaDescription' });

    const localeNames = LOCALE_NAMES;

    const targetLanguages = targetLocales.map((loc) => localeNames[loc] || loc).join(', ');

    const prompt = `Translate these SEO texts from the source language to ${targetLanguages}.

SEO Title: ${sanitizedTitle}
Meta Description: ${sanitizedDescription}

Make sure that the character lengths remain similar and the translations sound natural.

Respond in JSON format:
{
  "en": {
    "seoTitle": "...",
    "metaDescription": "..."
  },
  "fr": {
    "seoTitle": "...",
    "metaDescription": "..."
  },
  "es": {
    "seoTitle": "...",
    "metaDescription": "..."
  },
  "it": {
    "seoTitle": "...",
    "metaDescription": "..."
  }
}`;

    const responseText = await this.askAI(prompt);
    return this.parseJSONResponse(responseText);
  }

  async generateContent(
    fieldType: string,
    currentValue: string,
    context: {
      productTitle: string;
      productDescription: string;
      productType: string;
      locale: string;
    }
  ): Promise<{ content: string; reasoning: string }> {
    // Sanitize all context fields
    const sanitizedContext = {
      productTitle: sanitizePromptInput(context.productTitle, { fieldType: 'title' }),
      productDescription: sanitizePromptInput(context.productDescription, {
        fieldType: 'description',
        allowNewlines: true
      }),
      productType: sanitizePromptInput(context.productType, { maxLength: 100 }),
      locale: context.locale,
    };

    const sanitizedCurrentValue = currentValue
      ? sanitizePromptInput(currentValue, {
          fieldType: isValidFieldType(fieldType) ? fieldType : undefined,
          allowNewlines: true
        })
      : '';

    const localeNames = LOCALE_NAMES;

    const language = localeNames[sanitizedContext.locale] || 'German';
    const isTitle = fieldType === 'title';
    const fieldLabel = isTitle ? 'Title' : 'Description';

    let prompt = '';

    if (!sanitizedCurrentValue || sanitizedCurrentValue.trim().length === 0) {
      // Generate new content from scratch
      prompt = `You are an e-commerce expert and content writer. Generate a ${fieldLabel} for a product.

Product Context:
- Title: ${sanitizedContext.productTitle}
- Product Type: ${sanitizedContext.productType}
${!isTitle ? `- Description: ${sanitizedContext.productDescription}` : ''}

Task: Create a ${isTitle ? 'concise, sales-oriented product title (max. 80 characters)' : 'detailed, appealing product description (200-400 words) with HTML formatting (<p>, <strong>, <ul>, <li>)'} in ${language}.

${isTitle ? 'The title should:' : 'The description should:'}
${isTitle ?
  `- Contain the main product and its key benefits
- Be SEO-friendly
- Grab attention` :
  `- Highlight the key product features and benefits
- Provide emotional value
- Deliver convincing reasons to buy
- Be well-structured and easy to read`}

Respond in the following JSON format:
{
  "content": "${isTitle ? 'Generated Title' : 'Generated Description'}",
  "reasoning": "Brief explanation of the strategy"
}

Output the result in ${language}.`;
    } else {
      // Improve existing content
      prompt = `You are an e-commerce expert and content writer. Improve the following ${fieldLabel}.

Current ${fieldLabel}: ${sanitizedCurrentValue}

Product Context:
- Title: ${sanitizedContext.productTitle}
- Product Type: ${sanitizedContext.productType}

Task: Improve and optimize the ${fieldLabel} in ${language}.

The improved ${fieldLabel} should:
${isTitle ?
  `- Be more concise and sales-oriented
- Contain SEO-friendly keywords
- Be max. 80 characters long
- Highlight the main product and its key benefits` :
  `- Be more convincing and appealing
- Emphasize important product features and benefits
- Be well-structured with HTML formatting (<p>, <strong>, <ul>, <li>)
- Be 200-400 words
- Provide emotional value`}

Respond in the following JSON format:
{
  "content": "Improved ${fieldLabel}",
  "reasoning": "Brief explanation of the improvements made"
}

Output the result in ${language}.`;
    }

    const responseText = await this.askAI(prompt);
    return this.parseJSONResponse(responseText);
  }

  async translateFields(
    fields: Record<string, string>,
    targetLocales: string[],
    contentType: string = 'product',
    customInstructions?: string
  ): Promise<Record<string, Record<string, string>>> {
    // Sanitize all field values
    const sanitizedFields: Record<string, string> = {};
    for (const [key, value] of Object.entries(fields)) {
      sanitizedFields[key] = sanitizePromptInput(value, {
        fieldType: isValidFieldType(key) ? key : undefined,
        allowNewlines: key === 'description',
      });
    }

    const localeNames = LOCALE_NAMES;

    const fieldNames: Record<string, string> = {
      title: 'Title',
      description: 'Description',
      handle: 'URL Slug',
      productType: 'Product Type',
      seoTitle: 'SEO Title',
      metaDescription: 'Meta Description',
      body: 'Body',
      body_html: 'Description',
    };

    const targetLanguages = targetLocales.map((loc) => localeNames[loc] || loc).join(', ');

    // Build the fields section for the prompt
    const fieldsText = Object.entries(sanitizedFields)
      .map(([key, value]) => `${fieldNames[key] || key}: ${value}`)
      .join('\n');

    // Build the expected JSON structure
    const jsonStructure: Record<string, any> = {};
    for (const locale of targetLocales) {
      jsonStructure[locale] = {};
      for (const key of Object.keys(fields)) {
        jsonStructure[locale][key] = '...';
      }
    }

    // Default translation instructions
    const defaultInstructions = `Make sure that:
- HTML tags are preserved
- Character lengths remain similar
- Translations sound natural
- URL slugs (handle) contain no special characters`;

    // Use custom instructions if provided
    const instructions = customInstructions || defaultInstructions;

    const prompt = `Translate these ${contentType === 'product' ? 'product' : contentType === 'collection' ? 'collection' : contentType === 'blog' ? 'blog' : contentType === 'page' ? 'page' : contentType === 'policy' ? 'policy' : 'product'} fields from the source language to ${targetLanguages}.

${fieldsText}

${instructions}

Respond in JSON format:
${JSON.stringify(jsonStructure, null, 2)}`;

    const responseText = await this.askAI(prompt);
    return this.parseJSONResponse(responseText);
  }

  private estimateTokens(prompt: string): number {
    // Rough estimate: ~4 characters per token
    // Add output tokens estimate (2000 max_tokens)
    const inputTokens = Math.ceil(prompt.length / 4);
    const outputTokens = 8192;
    return inputTokens + outputTokens;
  }

  private async askAI(prompt: string, imageUrl?: string): Promise<string> {
    // Save prompt to database if taskId is provided
    if (this.taskId && this.shop) {
      await this.savePromptToTask(prompt, imageUrl);
    }

    let response: string;

    // If no shop/taskId provided, execute directly (backward compatibility)
    if (!this.shop || !this.taskId) {
      response = await this.executeAIRequest(prompt, imageUrl);
    } else {
      // Use queue for rate-limited execution
      const estimatedTokens = this.estimateTokens(prompt);

      response = await this.queue.enqueue(
        this.shop,
        this.taskId,
        this.provider,
        estimatedTokens,
        () => this.executeAIRequest(prompt, imageUrl)
      );
    }

    // Save AI response to the corresponding prompt entry (raw, for debugging)
    if (this.taskId && this.shop) {
      await this.saveResponseToTask(response);
    }

    return AIService.stripMarkdownFence(response);
  }

  private async savePromptToTask(prompt: string, imageUrl?: string): Promise<void> {
    try {
      const { db } = await import('../../app/db.server');

      // Get existing task to append to prompt history
      const existingTask = await db.task.findUnique({
        where: { id: this.taskId },
        select: { prompt: true },
      });

      // Parse existing prompts or start with empty array
      let promptHistory: { timestamp: string; prompt: string }[] = [];
      if (existingTask?.prompt) {
        try {
          const parsed = JSON.parse(existingTask.prompt);
          if (Array.isArray(parsed)) {
            promptHistory = parsed;
          } else {
            // Legacy: single prompt string, convert to array
            promptHistory = [{ timestamp: new Date().toISOString(), prompt: existingTask.prompt }];
          }
        } catch {
          // Legacy: not JSON, convert old prompt to array
          promptHistory = [{ timestamp: new Date().toISOString(), prompt: existingTask.prompt }];
        }
      }

      // Add image indicator to prompt if image is included
      let fullPrompt = prompt;
      if (imageUrl) {
        fullPrompt = `[📷 Image attached: ${imageUrl}]\n\n${prompt}`;
      }

      // Add new prompt with timestamp (store full prompt, no truncation)
      promptHistory.push({
        timestamp: new Date().toISOString(),
        prompt: fullPrompt,
      });

      await db.task.update({
        where: { id: this.taskId },
        data: {
          prompt: JSON.stringify(promptHistory),
          provider: this.provider, // Save provider for recovery after server restart
          aiModel: this.getModel(),
        },
      });
    } catch (error) {
      loggers.ai('error', 'Failed to save prompt to task', { error: error instanceof Error ? error.message : String(error) });
      // Don't throw - we don't want to fail the task if prompt saving fails
    }
  }

  private async saveResponseToTask(response: string): Promise<void> {
    try {
      const { db } = await import('../../app/db.server');

      const existingTask = await db.task.findUnique({
        where: { id: this.taskId },
        select: { prompt: true },
      });

      if (existingTask?.prompt) {
        try {
          const parsed = JSON.parse(existingTask.prompt);
          if (Array.isArray(parsed) && parsed.length > 0) {
            // Add response to the last prompt entry (store full response, no truncation)
            parsed[parsed.length - 1].response = response;

            await db.task.update({
              where: { id: this.taskId },
              data: {
                prompt: JSON.stringify(parsed),
              },
            });
          }
        } catch {
          // Not valid JSON, skip
        }
      }
    } catch (error) {
      loggers.ai('error', 'Failed to save response to task', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Re-execute a stored prompt during task recovery (bypasses prompt saving & queuing). */
  async replayRequest(prompt: string): Promise<string> {
    return this.executeAIRequest(prompt);
  }

  /**
   * Returns true if the error indicates the input prompt exceeded the model's context window.
   * Each provider signals this differently; we normalise to a single user-facing message.
   */
  private static isInputTooLongError(error: unknown): boolean {
    const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
    const code = (error as { code?: string; status?: number })?.code ?? '';
    const status = (error as { status?: number })?.status ?? 0;

    // OpenAI / Grok / DeepSeek (OpenAI-compatible SDK)
    if (code === 'context_length_exceeded') return true;
    if (msg.includes('maximum context length') || msg.includes('context_length_exceeded')) return true;
    // Claude (Anthropic SDK) — 400 with prompt-too-long message
    if (status === 400 && (msg.includes('prompt is too long') || (msg.includes('token') && msg.includes('maximum')))) return true;
    // Gemini
    if (msg.includes('request payload size exceeds') || msg.includes('input is too long')) return true;
    // Generic fallbacks
    if (msg.includes('too many tokens') || msg.includes('exceeds the limit')) return true;

    return false;
  }

  private static readonly INPUT_TOO_LONG_MESSAGE =
    'The text is too long for the AI model to process. Please shorten the content and try again.';

  private async executeAIRequest(prompt: string, imageUrl?: string): Promise<string> {
    try {
      return await this._executeAIRequestInner(prompt, imageUrl);
    } catch (error) {
      if (AIService.isInputTooLongError(error)) {
        throw new Error(AIService.INPUT_TOO_LONG_MESSAGE);
      }
      throw error;
    }
  }

  private async _executeAIRequestInner(prompt: string, imageUrl?: string): Promise<string> {
    if (this.provider === 'huggingface' && this.huggingface) {
      // HuggingFace: text-only (no vision support)
      const response = await this.huggingface.chatCompletion({
        model: this.getModel(),
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 8192,
        temperature: 0.7,
      });
      if (!response.choices[0]) throw new Error('HuggingFace returned empty response');
      const hfContent = response.choices[0].message.content;
      if (!hfContent || !hfContent.trim()) throw new Error('HuggingFace returned empty content');
      return hfContent;
    } else if (this.provider === 'gemini' && this.gemini) {
      // Gemini: supports vision with URL
      if (imageUrl) {
        try {
          const result = await this.gemini.generateContent([
            { text: prompt },
            {
              inlineData: {
                mimeType: 'image/jpeg',
                data: await this.fetchImageAsBase64(imageUrl),
              },
            },
          ]);
          const response = await result.response;
          const geminiText = response.text();
          if (!geminiText || !geminiText.trim()) throw new Error('Gemini returned empty response');
          return geminiText;
        } catch (error) {
          if (AIService.isInputTooLongError(error)) throw error;
          loggers.ai('warn', '[AI-SERVICE] Gemini vision failed, falling back to text-only', { error });
          // Fallback to text-only
          const result = await this.gemini.generateContent(prompt);
          const response = await result.response;
          const geminiTextFallback = response.text();
          if (!geminiTextFallback || !geminiTextFallback.trim()) throw new Error('Gemini returned empty response');
          return geminiTextFallback;
        }
      } else {
        const result = await this.gemini.generateContent(prompt);
        const response = await result.response;
        const geminiTextOnly = response.text();
        if (!geminiTextOnly || !geminiTextOnly.trim()) throw new Error('Gemini returned empty response');
        return geminiTextOnly;
      }
    } else if (this.provider === 'claude' && this.anthropic) {
      // Claude: supports vision with URL
      if (imageUrl) {
        const message = await this.anthropic.messages.create({
          model: this.getModel(),
          max_tokens: 8192,
          messages: [{
            role: 'user',
            content: [
              { type: 'image', source: { type: 'url', url: imageUrl } },
              { type: 'text', text: prompt },
            ],
          }],
        });
        const content = message.content[0];
        if (!content) throw new Error('Claude returned empty response');
        if (content.type !== 'text') throw new Error(`Claude returned non-text content type: ${content.type}`);
        if (!content.text.trim()) throw new Error('Claude returned empty text');
        return content.text;
      } else {
        const message = await this.anthropic.messages.create({
          model: this.getModel(),
          max_tokens: 8192,
          messages: [{ role: 'user', content: prompt }],
        });
        const content = message.content[0];
        if (!content) throw new Error('Claude returned empty response');
        if (content.type !== 'text') throw new Error(`Claude returned non-text content type: ${content.type}`);
        if (!content.text.trim()) throw new Error('Claude returned empty text');
        return content.text;
      }
    } else if (this.provider === 'openai' && this.openai) {
      // GPT-4o: supports vision with URL
      if (imageUrl) {
        const completion = await this.openai.chat.completions.create({
          model: this.getModel(),
          messages: [{
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: imageUrl } },
              { type: 'text', text: prompt },
            ],
          }],
          max_tokens: 8192,
        });
        if (!completion.choices[0]) throw new Error('OpenAI returned empty response');
        const openaiVisionContent = completion.choices[0].message.content;
        if (!openaiVisionContent || !openaiVisionContent.trim()) throw new Error(`OpenAI returned empty content (finish_reason: ${completion.choices[0].finish_reason})`);
        return openaiVisionContent;
      } else {
        const completion = await this.openai.chat.completions.create({
          model: this.getModel(),
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 8192,
        });
        if (!completion.choices[0]) throw new Error('OpenAI returned empty response');
        const openaiContent = completion.choices[0].message.content;
        if (!openaiContent || !openaiContent.trim()) throw new Error(`OpenAI returned empty content (finish_reason: ${completion.choices[0].finish_reason})`);
        return openaiContent;
      }
    } else if (this.provider === 'grok' && this.grok) {
      // Grok: supports vision with URL (similar to GPT-4o)
      if (imageUrl) {
        const completion = await this.grok.chat.completions.create({
          model: this.getModel(),
          messages: [{
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: imageUrl } },
              { type: 'text', text: prompt },
            ],
          }],
          max_tokens: 8192,
          temperature: 0.7,
        });
        if (!completion.choices[0]) throw new Error('Grok returned empty response');
        const grokVisionContent = completion.choices[0].message.content;
        if (!grokVisionContent || !grokVisionContent.trim()) throw new Error(`Grok returned empty content (finish_reason: ${completion.choices[0].finish_reason})`);
        return grokVisionContent;
      } else {
        const completion = await this.grok.chat.completions.create({
          model: this.getModel(),
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 8192,
          temperature: 0.7,
        });
        if (!completion.choices[0]) throw new Error('Grok returned empty response');
        const grokContent = completion.choices[0].message.content;
        if (!grokContent || !grokContent.trim()) throw new Error(`Grok returned empty content (finish_reason: ${completion.choices[0].finish_reason})`);
        return grokContent;
      }
    } else if (this.provider === 'deepseek' && this.deepseek) {
      // DeepSeek: text-only (no vision support)
      const completion = await this.deepseek.chat.completions.create({
        model: this.getModel(),
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 8192,
        temperature: 0.7,
      });
      if (!completion.choices[0]) throw new Error('DeepSeek returned empty response');
      const deepseekContent = completion.choices[0].message.content;
      if (!deepseekContent || !deepseekContent.trim()) throw new Error(`DeepSeek returned empty content (finish_reason: ${completion.choices[0].finish_reason})`);
      return deepseekContent;
    }

    throw new Error('No AI provider configured');
  }

  /** Allowed Shopify CDN hostnames for image fetching. */
  private static readonly ALLOWED_IMAGE_HOSTS = [
    'cdn.shopify.com',
    'cdn.shopifycdn.net',
  ];

  /**
   * Validate an image URL to prevent SSRF attacks.
   * Only HTTPS URLs pointing to whitelisted Shopify CDN domains are allowed.
   */
  private validateImageUrl(imageUrl: string): void {
    let parsed: URL;
    try {
      parsed = new URL(imageUrl);
    } catch {
      throw new Error('Invalid image URL');
    }

    // Only allow HTTPS
    if (parsed.protocol !== 'https:') {
      throw new Error('Only HTTPS image URLs are allowed');
    }

    // Whitelist Shopify CDN domains
    const hostname = parsed.hostname.toLowerCase();
    if (!AIService.ALLOWED_IMAGE_HOSTS.includes(hostname)) {
      throw new Error(
        `Image host not allowed: ${hostname}. Only Shopify CDN domains are permitted.`,
      );
    }

    // Block private/internal IP ranges even if hostname somehow resolves to one
    // (defense-in-depth: covers cases where DNS rebinding or hosts file tricks apply)
    const ipPatterns = [
      /^127\./, // loopback
      /^10\./, // 10.0.0.0/8
      /^172\.(1[6-9]|2\d|3[01])\./, // 172.16.0.0/12
      /^192\.168\./, // 192.168.0.0/16
      /^169\.254\./, // link-local
      /^0\./, // 0.0.0.0/8
      /^\[?::1\]?$/, // IPv6 loopback
      /^\[?fc/, // IPv6 unique-local fc00::/7
      /^\[?fe80/i, // IPv6 link-local
    ];
    if (ipPatterns.some((p) => p.test(hostname))) {
      throw new Error('Private/internal IP addresses are not allowed');
    }
  }

  /**
   * Fetch image from URL and convert to base64 (for Gemini)
   */
  private async fetchImageAsBase64(imageUrl: string): Promise<string> {
    this.validateImageUrl(imageUrl);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(imageUrl, { signal: controller.signal });
      if (!response.ok) {
        throw new Error(`Failed to fetch image: HTTP ${response.status}`);
      }
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      return buffer.toString('base64');
    } catch (error) {
      loggers.ai('error', '[AI-SERVICE] Failed to fetch image', { imageUrl, error });
      throw new Error('Failed to fetch image for vision AI');
    } finally {
      clearTimeout(timeout);
    }
  }

  async generateProductTitle(prompt: string, imageUrl?: string): Promise<string> {
    // The prompt is already built by the caller with AI Instructions
    // Just execute it directly without adding additional instructions
    return await this.askAI(prompt, imageUrl);
  }

  async generateProductDescription(title: string, prompt: string, imageUrl?: string): Promise<string> {
    // The prompt is already built by the caller with AI Instructions
    // Just execute it directly without adding additional instructions
    return await this.askAI(prompt, imageUrl);
  }

  async generateImageAltText(imageUrl: string, productTitle?: string, customPrompt?: string, sendImageToAI: boolean = false): Promise<string> {
    // Sanitize product title if provided
    const sanitizedTitle = productTitle
      ? sanitizePromptInput(productTitle, { fieldType: 'title' })
      : '';

    const prompt = customPrompt || `You are an SEO expert for e-commerce. Create an optimized alt text for a product image.

${sanitizedTitle ? `Product: ${sanitizedTitle}` : ''}
${!sendImageToAI ? `Image URL: ${imageUrl}` : ''}

The alt text should:
- Precisely describe what is visible in the image
- Be SEO-friendly (60-125 characters)
- Be relevant to the product
- Contain no filler words
- Be formulated in an accessible way

Return only the alt text, without additional explanations. Output the result in the same language as the product title.`;

    // Send image to vision-capable AI models if sendImageToAI is enabled
    return await this.askAI(prompt, sendImageToAI ? imageUrl : undefined);
  }

  private parseJSONResponse(text: string): any {
    // Try to extract JSON from markdown code blocks (supports both objects and arrays)
    const jsonBlockMatch = text.match(/```(?:json)?\s*([\[\{][\s\S]*?[\]\}])\s*```/);
    if (jsonBlockMatch) {
      try {
        return JSON.parse(jsonBlockMatch[1]);
      } catch (error) {
        loggers.ai('warn', '[AI-SERVICE] Failed to parse JSON from code block', { error: error instanceof Error ? error.message : String(error) });
      }
    }

    // Try to find JSON array in text
    const arrayMatch = text.match(/\[[\s\S]*?\]/);
    if (arrayMatch) {
      try {
        return JSON.parse(arrayMatch[0]);
      } catch (error) {
        loggers.ai('warn', '[AI-SERVICE] Failed to parse JSON array', { error: error instanceof Error ? error.message : String(error) });
      }
    }

    // Try to find JSON object in text
    const objectMatch = text.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      try {
        return JSON.parse(objectMatch[0]);
      } catch (error) {
        loggers.ai('warn', '[AI-SERVICE] Failed to parse JSON object', { error: error instanceof Error ? error.message : String(error) });
      }
    }

    loggers.ai('error', '[AI-SERVICE] Could not parse JSON from AI response', { response: text.substring(0, 500) });
    throw new Error('Could not parse JSON from AI response');
  }
}
