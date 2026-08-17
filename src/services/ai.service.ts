import { HfInference } from '@huggingface/inference';
import { GoogleGenerativeAI, type GenerativeModel } from '@google/generative-ai';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { AIQueueService } from './ai-queue.service';
import { sanitizePromptInput, isValidFieldType } from '../../app/utils/prompt-sanitizer';
import type { GlossaryRule } from './glossary.service';
import { loggers } from '../../app/utils/logger.server';
import { DEFAULT_MODELS } from '../../app/config/ai-models.config';
import { TRANSLATION_BATCH } from '../../app/config/constants';

export type AIProvider = 'huggingface' | 'gemini' | 'claude' | 'openai' | 'grok' | 'deepseek';

const LOCALE_NAMES: Record<string, string> = {
  en: 'English', fr: 'French', es: 'Spanish', it: 'Italian',
  de: 'German', pt: 'Portuguese', nl: 'Dutch', ja: 'Japanese',
  ko: 'Korean', zh: 'Chinese', ru: 'Russian', ar: 'Arabic',
  sv: 'Swedish', da: 'Danish', no: 'Norwegian', fi: 'Finnish',
  pl: 'Polish', cs: 'Czech', tr: 'Turkish', th: 'Thai',
  vi: 'Vietnamese', id: 'Indonesian', ms: 'Malay', hi: 'Hindi',
  he: 'Hebrew', el: 'Greek', uk: 'Ukrainian', ro: 'Romanian',
  hu: 'Hungarian', sk: 'Slovak', bg: 'Bulgarian', hr: 'Croatian',
  // R5-H2(a): Shopify ships region/script-qualified BCP-47 codes (the market
  // selector emits these). Without precise names the prompt would send an
  // opaque raw code and the model would guess the wrong regional variant.
  'pt-BR': 'Brazilian Portuguese', 'pt-PT': 'European Portuguese',
  'zh-Hans': 'Simplified Chinese', 'zh-CN': 'Simplified Chinese',
  'zh-Hant': 'Traditional Chinese', 'zh-TW': 'Traditional Chinese',
  'zh-HK': 'Traditional Chinese (Hong Kong)',
  'en-GB': 'British English', 'en-AU': 'Australian English',
  'en-US': 'American English', 'en-CA': 'Canadian English',
  'fr-CA': 'Canadian French', 'fr-FR': 'European French',
  'es-419': 'Latin American Spanish', 'es-ES': 'European Spanish',
  'es-MX': 'Mexican Spanish', 'de-AT': 'Austrian German',
  'de-CH': 'Swiss German', 'nl-BE': 'Flemish',
};

/**
 * Resolve a BCP-47 locale code to a precise human language name for prompts.
 *
 * R5-H2(a): tolerant lookup — an exact match (e.g. `pt-BR`) wins, but for an
 * unmapped region/script variant (e.g. `pt-AO`) we fall back to the BASE
 * language name (`pt` -> "Portuguese") BEFORE falling back to the raw code, so
 * a prompt never ships an opaque code like "pt-AO" when a usable name exists.
 * English is the conceptual default fallback locale; we never default to German.
 */
function localeName(code: string): string {
  if (!code) return code;
  if (LOCALE_NAMES[code]) return LOCALE_NAMES[code];
  const base = code.split('-')[0];
  return LOCALE_NAMES[base] || code;
}

// Hard ceiling for a single AI provider call. Without this, a hung provider
// socket blocks the shared AI queue indefinitely for ALL shops. Generous
// enough for long-content generation, but bounded.
const AI_REQUEST_TIMEOUT_MS = 120_000;
const AI_SDK_MAX_RETRIES = 2;

class AIRequestTimeoutError extends Error {
  constructor(ms: number) {
    super(`AI request timed out after ${ms}ms`);
    this.name = 'AIRequestTimeoutError';
  }
}

const VALID_PROVIDERS: readonly AIProvider[] = ['huggingface', 'gemini', 'claude', 'openai', 'grok', 'deepseek'];

/** Validate and return a safe AIProvider, falling back to 'claude' (Anthropic). */
export function toValidProvider(value: string | null | undefined): AIProvider {
  return VALID_PROVIDERS.includes(value as AIProvider) ? (value as AIProvider) : 'claude';
}

/**
 * Thrown when an AI call is attempted but the merchant has not configured
 * their own API key for the selected provider.
 *
 * IMPORTANT (Shopify PPA / API Terms compliance): ContentPilot must NOT send
 * merchant content to any third-party AI service through an operator-owned
 * (shared) key. Each shop must use its own key. This error is the guaranteed
 * backstop that blocks every AI call path — including background tasks — when
 * no merchant key is present.
 */
export class MissingAIKeyError extends Error {
  readonly code = 'NO_AI_KEY' as const;
  readonly provider: AIProvider;

  constructor(provider: AIProvider) {
    super(
      `No API key configured for AI provider "${provider}". ` +
      `The merchant must add their own API key in Settings before AI features can be used.`
    );
    this.name = 'MissingAIKeyError';
    this.provider = provider;
  }
}

/**
 * Thrown when a provider rejects the merchant's API key at call time (HTTP 401
 * / "authentication" / "invalid api key"). Distinct from {@link MissingAIKeyError}
 * (no key configured at all): here a key IS present but the provider says it is
 * invalid/unauthorized. Carries the provider's original message so the UI can
 * show an actionable hint pointing to Settings → AI API Access Codes.
 */
export class InvalidAIKeyError extends Error {
  readonly code = 'INVALID_AI_KEY' as const;
  constructor(message: string) {
    super(message);
    this.name = 'InvalidAIKeyError';
  }
}

/**
 * Returns true when an unknown thrown value looks like a provider authentication
 * failure (invalid/expired/unauthorized API key). Covers the OpenAI/Grok/DeepSeek
 * (OpenAI-compatible), Anthropic, Gemini and HuggingFace SDK shapes plus the
 * HuggingFace router string ("401 Authentication Fails, Your api key ... is invalid").
 *
 * Deliberately conservative: it matches 401/explicit auth codes and unambiguous
 * auth phrases, but NOT bare 403 (which providers also use for content-policy /
 * quota blocks) so a non-auth 403 is never misclassified as a bad key.
 */
export function isAuthError(error: unknown): boolean {
  const e = error as { status?: number; statusCode?: number; code?: string; message?: string } | null;
  if (e && typeof e === 'object') {
    if (e.status === 401 || e.statusCode === 401) return true;
    const code = String(e.code ?? '').toLowerCase();
    if (
      code === 'invalid_api_key' ||
      code === 'invalid_ai_key' ||
      code === 'unauthenticated' ||
      code === 'invalid_authentication'
    ) return true;
  }
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    /\b401\b/.test(msg) ||
    msg.includes('unauthorized') ||
    msg.includes('authentication fails') ||
    msg.includes('authentication error') ||
    msg.includes('invalid api key') ||
    msg.includes('incorrect api key') ||
    msg.includes('invalid_api_key') ||
    msg.includes('api key not valid') ||
    msg.includes('api key is invalid') ||
    msg.includes('no auth credentials') ||
    (msg.includes('api key') && msg.includes('invalid'))
  );
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
  /**
   * Circuit breaker: once the provider rejects this instance's key, every later
   * askAI() call fails immediately with the same error instead of firing more
   * doomed requests. A bulk translate (many fields × many locales) shares one
   * AIService instance, so without this an invalid key produced one 401 per
   * cell, hammering the provider and the queue.
   */
  private authError: InvalidAIKeyError | null = null;
  /**
   * Shop glossary (Glossar/Terminologie), lazily loaded ONCE per instance —
   * one AIService instance = one request/task, so a bulk translate reads the
   * glossary a single time. Injection happens here (not at the call sites) so
   * EVERY translation path — editors, theme content, direct translations,
   * alt-texts, SEO — is covered automatically.
   */
  private glossaryRulesPromise?: Promise<GlossaryRule[]>;

  constructor(provider: AIProvider = 'claude', config: AIServiceConfig = {}, shop?: string, taskId?: string) {
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

  private loadGlossaryRules(): Promise<GlossaryRule[]> {
    // No shop context (unit tests, ad-hoc usage) -> no glossary.
    if (!this.shop) return Promise.resolve([]);
    if (!this.glossaryRulesPromise) {
      const shop = this.shop;
      this.glossaryRulesPromise = (async () => {
        try {
          // Dynamic import: keeps db.server out of this module's static graph
          // (same pattern as savePromptToTask).
          const { loadGlossaryRules } = await import('./glossary.service');
          return await loadGlossaryRules(shop);
        } catch (error) {
          // A broken glossary must never block translations — warn and proceed.
          loggers.ai('warn', '[AI-SERVICE] Failed to load glossary; translating without it', {
            shop,
            error: error instanceof Error ? error.message : String(error),
          });
          return [];
        }
      })();
    }
    return this.glossaryRulesPromise;
  }

  /**
   * The sanitized glossary directive block for this shop, filtered to terms
   * that actually occur in `sourceTexts`, or '' when nothing applies. Appended
   * to translation prompts between the requirements and the response-format
   * section. Empty `targetLocales` = all locales in play.
   */
  private async getGlossaryDirective(sourceTexts: string[], targetLocales: string[]): Promise<string> {
    const rules = await this.loadGlossaryRules();
    if (rules.length === 0) return '';
    const { buildGlossaryDirective } = await import('./glossary.service');
    return buildGlossaryDirective(rules, sourceTexts, targetLocales);
  }

  /**
   * The glossary directive for GENERATING primary text (PLAN §2.5e).
   *
   * The bug this closes: the translation paths have consulted the glossary
   * since it existed, the generation paths never did. A merchant who forces
   * "Sneaker" over "Turnschuh" got "Sneaker" in every translation and
   * "Turnschuh" in the German original — the glossary working on exactly the
   * half where the merchant is least likely to look.
   *
   * `locale` is the language being WRITTEN, not a translation target.
   */
  private async getGlossaryGenerationDirective(contextTexts: string[], locale: string): Promise<string> {
    const rules = await this.loadGlossaryRules();
    if (rules.length === 0) return '';
    const { buildGlossaryGenerationDirective } = await import('./glossary.service');
    return buildGlossaryGenerationDirective(rules, contextTexts, locale);
  }

  /**
   * True when the whole trimmed text IS a doNotTranslate glossary term (e.g. a
   * title that is exactly the brand name). Callers then skip the AI call and
   * keep the source verbatim — both because that is the correct result and
   * because the echo guard would otherwise reject the unchanged output.
   */
  private async isVerbatimGlossaryTerm(text: string): Promise<boolean> {
    const rules = await this.loadGlossaryRules();
    if (rules.length === 0) return false;
    const { matchesVerbatimDoNotTranslate } = await import('./glossary.service');
    return matchesVerbatimDoNotTranslate(rules, text);
  }

  private initializeProvider() {
    // Compliance backstop: only the merchant's own key is ever used. No
    // operator-owned process.env.*_API_KEY fallback. An empty key blocks the
    // call for EVERY AIService consumer, including background tasks.
    if (this.provider === 'huggingface') {
      const apiKey = this.config.huggingfaceApiKey || '';
      if (!apiKey) throw new MissingAIKeyError('huggingface');
      this.huggingface = new HfInference(apiKey);
      loggers.ai('info', 'AI Provider: Hugging Face');
    } else if (this.provider === 'gemini') {
      const apiKey = this.config.geminiApiKey || '';
      if (!apiKey) throw new MissingAIKeyError('gemini');
      const genAI = new GoogleGenerativeAI(apiKey);
      this.gemini = genAI.getGenerativeModel({ model: this.getModel() });
      loggers.ai('info', 'AI Provider: Google Gemini');
    } else if (this.provider === 'claude') {
      const apiKey = this.config.claudeApiKey || '';
      if (!apiKey) throw new MissingAIKeyError('claude');
      this.anthropic = new Anthropic({ apiKey, timeout: AI_REQUEST_TIMEOUT_MS, maxRetries: AI_SDK_MAX_RETRIES });
      loggers.ai('info', 'AI Provider: Claude');
    } else if (this.provider === 'openai') {
      const apiKey = this.config.openaiApiKey || '';
      if (!apiKey) throw new MissingAIKeyError('openai');
      this.openai = new OpenAI({ apiKey, timeout: AI_REQUEST_TIMEOUT_MS, maxRetries: AI_SDK_MAX_RETRIES });
      loggers.ai('info', 'AI Provider: OpenAI');
    } else if (this.provider === 'grok') {
      const apiKey = this.config.grokApiKey || '';
      if (!apiKey) throw new MissingAIKeyError('grok');
      this.grok = new OpenAI({
        apiKey,
        baseURL: 'https://api.x.ai/v1',
        timeout: AI_REQUEST_TIMEOUT_MS,
        maxRetries: AI_SDK_MAX_RETRIES,
      });
      loggers.ai('info', 'AI Provider: Grok (X.AI)');
    } else if (this.provider === 'deepseek') {
      const apiKey = this.config.deepseekApiKey || '';
      if (!apiKey) throw new MissingAIKeyError('deepseek');
      this.deepseek = new OpenAI({
        apiKey,
        baseURL: 'https://api.deepseek.com',
        timeout: AI_REQUEST_TIMEOUT_MS,
        maxRetries: AI_SDK_MAX_RETRIES,
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
    // Sanitize content before translation.
    // NOTE (review MEDIUM "5000-char truncation"): this is intentionally NOT a
    // bug. `maxLength` is a no-op in sanitizePromptInput by design — see the
    // explicit "No character limits are enforced here" contract in
    // app/utils/prompt-sanitizer.ts. Long content (legal pages, T&Cs) must be
    // sent untruncated; if it exceeds the model context the provider errors
    // and that surfaces to the user instead of silently writing a partial
    // translation. The option is left in place only to document intended size.
    const sanitizedContent = sanitizePromptInput(content, {
      maxLength: 5000,
      allowNewlines: true
    });

    // Glossary short-circuit: a field that IS a doNotTranslate term (e.g.
    // title = brand name) must stay verbatim — skip the AI call entirely
    // (correct result, zero tokens, and the echo guard below would otherwise
    // reject the unchanged output).
    if (fromLang !== toLang && await this.isVerbatimGlossaryTerm(sanitizedContent)) {
      return sanitizedContent.trim();
    }

    const glossaryDirective = await this.getGlossaryDirective([sanitizedContent], [toLang]);

    const prompt = `Translate the following text from ${fromLang} to ${toLang}. Keep HTML tags.

Text: ${sanitizedContent}
${glossaryDirective ? `\n${glossaryDirective}\n` : ''}
Return ONLY the translated text. Do NOT wrap it in XML tags, quotes, or any other formatting. No explanations.`;

    const response = await this.askAI(prompt);
    const result = AIService.stripXmlWrapper(response);

    // R5-H2(b): post-response echo guard. N-H3 only covered the *error* case
    // (parse/format failure) — it never caught the model echoing the SOURCE
    // verbatim on apparent success, which silently persists untranslated text
    // as a "translation". Per the codebase fail-loud convention, throw so the
    // caller marks the task failed and writes nothing.
    //
    // BUT many SHORT values are legitimately identical across languages
    // (loanwords, proper nouns, brand names — "Schadenfreude", "Hotel",
    // "Information"), so an echo is only treated as a failure when the input is
    // LONG (>= ECHO_FAILURE_MIN_CHARS): a full paragraph never legitimately
    // equals its source. Short echoes are returned and used.
    const trimmedIn = sanitizedContent.trim();
    const trimmedOut = result.trim();
    if (
      fromLang !== toLang &&
      trimmedIn.length >= TRANSLATION_BATCH.ECHO_FAILURE_MIN_CHARS &&
      trimmedOut === trimmedIn
    ) {
      throw new Error(
        `translateContent: model returned the source unchanged (${fromLang} -> ${toLang}); ` +
        `treating as a failed translation rather than persisting untranslated source`
      );
    }

    return result;
  }

  /**
   * Non-content wrapper tag names that some models emit around their answer
   * (e.g. `<translation>…</translation>`). These are NEVER legitimate HTML
   * content elements, so stripping them is safe.
   */
  private static readonly XML_WRAPPER_TAGS = new Set([
    'translation', 'translated', 'output', 'result', 'text', 'response', 'xml',
  ]);

  /**
   * Strips a single-root XML *wrapper* tag that some models add around their
   * answer (e.g. `<translation>…</translation>`).
   *
   * R5-H4: the previous regex stripped ANY single outer tag. A legitimate
   * single-paragraph `translateContent` result like `<p>…</p>` was therefore
   * silently unwrapped, producing unstyled run-on text on the storefront on
   * SUCCESS. We now use an allow-list of known non-content wrapper tag names
   * (case-insensitive) and refuse to strip semantic HTML (`p`, `div`, `span`,
   * `ul`, `li`, `strong`, `a`, `h1`-`h6`, `table`, …). We also refuse to strip
   * when a nested same-name tag exists, because then the outer tag is real
   * structural content, not a wrapper artifact.
   */
  private static stripXmlWrapper(text: string): string {
    const trimmed = text.trim();
    const match = trimmed.match(/^<([a-zA-Z][a-zA-Z0-9-]*)>([\s\S]*)<\/\1>$/);
    if (!match) return trimmed;

    const tagName = match[1].toLowerCase();
    if (!AIService.XML_WRAPPER_TAGS.has(tagName)) return trimmed;

    // A nested same-name tag means the outer tag is genuine structure (the
    // model returned real `<text>` markup), not a one-off wrapper artifact.
    const inner = match[2];
    const nested = new RegExp(`<${tagName}[\\s>]`, 'i');
    if (nested.test(inner)) return trimmed;

    return inner.trim();
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
    //
    // R5-M1: the token base used to be the fixed string `TPLVAR`. If a
    // merchant's template literally contained `TPLVAR0` (outside a {…}
    // placeholder) the restore regex below would rewrite that literal text to
    // `{<someVar>}` — or `{undefined}` when the index was out of range —
    // corrupting the alt text. Use a per-call random base so it cannot
    // collide with anything the merchant actually typed (kept uppercase
    // alnum so models preserve it verbatim).
    const TOK = `CPVAR${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
    const tokRe = new RegExp(`${TOK}(\\d+)`, 'g');
    const varNames: string[] = [];
    const tokenized = sanitized.replace(/\{([^}]+)\}/g, (_, name: string) => {
      const idx = varNames.length;
      varNames.push(name);
      return `${TOK}${idx}`;
    });

    // If there are no variables, fall back to generic translateContent.
    if (varNames.length === 0) {
      return this.translateContent(sanitized, fromLang, toLang);
    }

    const fromName = localeName(fromLang);
    const toName = localeName(toLang);
    const tokenList = varNames.map((n, i) => `${TOK}${i} = {${n}}`).join(', ');

    // Dedicated prompt that explicitly requires all placeholder tokens to be preserved.
    const prompt = `Translate the following product image alt-text template from ${fromName} to ${toName}.

Template: ${tokenized}

Rules:
- The tokens ${varNames.map((_, i) => `${TOK}${i}`).join(', ')} are placeholders for product attributes (${tokenList}). You MUST keep ALL of them exactly as written — do not translate, omit, or reorder them.
- Return ONLY the translated template. No XML tags, no quotes, no explanations.`;

    const response = AIService.stripXmlWrapper(await this.askAI(prompt));

    // Find which placeholder tokens the AI dropped (before restoring, so regex is still intact).
    const dropped = varNames
      .map((name, i) => ({ name, token: `${TOK}${i}` }))
      .filter(({ token }) => !response.includes(token));

    // Restore surviving tokens. R5-M1: guard the index — an out-of-range
    // token (model invented one) must NOT become `{undefined}`; leave the
    // raw token text untouched in that case.
    let restored = response.replace(tokRe, (m, idx) => {
      const name = varNames[parseInt(idx, 10)];
      return name === undefined ? m : `{${name}}`;
    });

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
   * Translate many alt-text TEMPLATES into many locales in ONE AI request.
   *
   * Replaces the old N-positions × M-locales nested loop (16 round-trips for
   * 4 positions × 4 languages) with a single call. Keeps translateTemplate's
   * {Variable} → opaque-token protection so placeholders survive, and
   * restores / repairs them per cell.
   *
   * Returns { [locale]: { [position]: translatedTemplate } }. Any cell the AI
   * omits or returns unusable is simply absent — the caller decides the
   * fallback (re-translate just that cell, or keep the source).
   */
  async translateTemplatesBatch(
    templates: Array<{ position: number; template: string }>,
    fromLang: string,
    toLocales: string[]
  ): Promise<Record<string, Record<number, string>>> {
    // Tokenize each template independently; remember its variable names so we
    // can restore them after the model returns. Tokens are made globally
    // unique (position + index) so one big JSON blob can't cross-contaminate.
    const prepared = templates
      .filter((t) => t.template && t.template.trim().length > 0)
      .map((t) => {
        const sanitized = sanitizePromptInput(t.template, { maxLength: 500, allowNewlines: false });
        const varNames: string[] = [];
        const tokenized = sanitized.replace(/\{([^}]+)\}/g, (_, name: string) => {
          const idx = varNames.length;
          varNames.push(name);
          return `TPLVAR${t.position}_${idx}`;
        });
        return { position: t.position, tokenized, varNames };
      });

    if (prepared.length === 0) return {};

    const fromName = localeName(fromLang);
    const targetLanguages = toLocales
      .map((loc) => `${localeName(loc)} (${loc})`)
      .join(', ');

    const templatesBlock = prepared
      .map((p) => `Position ${p.position}: ${p.tokenized}`)
      .join('\n');

    const allTokens = prepared.flatMap((p) => p.varNames.map((_, i) => `TPLVAR${p.position}_${i}`));

    const jsonStructure: Record<string, Record<string, string>> = {};
    for (const p of prepared) {
      jsonStructure[String(p.position)] = {};
      for (const loc of toLocales) jsonStructure[String(p.position)][loc] = '...';
    }

    const prompt = `Translate these product image alt-text templates from ${fromName} to: ${targetLanguages}.

${templatesBlock}

Rules:
- Tokens like ${allTokens.slice(0, 6).join(', ')}${allTokens.length > 6 ? ', …' : ''} are placeholders for product attributes. In EVERY translation you MUST keep ALL tokens that appear in that position's template exactly as written — do not translate, omit, reorder, or alter them.
- Keep translations concise and descriptive, similar length to the source.
- Return ONLY JSON, no explanations.

Respond in exactly this JSON shape (keys = position numbers, inner keys = locale codes):
${JSON.stringify(jsonStructure, null, 2)}`;

    const parsed = this.parseJSONResponse(await this.askAI(prompt)) as Record<string, Record<string, string>>;

    const out: Record<string, Record<number, string>> = {};
    for (const p of prepared) {
      const cell = parsed?.[String(p.position)];
      if (!cell || typeof cell !== 'object') continue;
      for (const loc of toLocales) {
        const raw = cell[loc];
        if (typeof raw !== 'string' || raw.trim().length === 0) continue;

        const text = AIService.stripXmlWrapper(raw);
        const dropped = p.varNames
          .map((name, i) => ({ name, token: `TPLVAR${p.position}_${i}` }))
          .filter(({ token }) => !text.includes(token));

        // R5-M1 (assessed — already safe here): unlike the singular
        // translateTemplate(), this batch restore is BOTH position- and
        // index-guarded and falls back to the original matched text, so a
        // merchant literal like `TPLVAR12_3` can never become `{undefined}`
        // or a wrong variable (it would have to exactly match an in-range
        // position_idx of THIS batch). No per-call nonce needed; left as-is
        // to avoid churning the freshly-refactored batch path.
        let restored = text.replace(
          /TPLVAR(\d+)_(\d+)/g,
          (_, pos: string, idx: string) =>
            Number(pos) === p.position && p.varNames[Number(idx)] !== undefined
              ? `{${p.varNames[Number(idx)]}}`
              : _
        );
        if (dropped.length > 0) {
          loggers.ai('warn', '[AI-SERVICE] translateTemplatesBatch: AI dropped TPLVAR tokens, appending them', {
            dropped: dropped.map((d) => d.name),
            position: p.position,
            toLang: loc,
          });
          restored = restored.trimEnd() + ' ' + dropped.map((d) => `{${d.name}}`).join(' ');
        }

        (out[loc] ??= {})[p.position] = restored;
      }
    }
    return out;
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

    const targetLanguages = targetLocales
      .map((loc) => `${localeName(loc)} (${loc})`)
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

    const glossaryDirective = await this.getGlossaryDirective(
      Object.values(sanitizedAltTexts),
      targetLocales,
    );

    const prompt = `Translate these ${contentType} image alt-texts from ${localeName(fromLang)} to: ${targetLanguages}.

${altTextsText}

Requirements:
- Keep translations concise and descriptive
- Maintain similar character length
- Preserve any product-specific terminology
${glossaryDirective ? `\n${glossaryDirective}\n` : ''}
Respond in JSON format:
${JSON.stringify(jsonStructure, null, 2)}`;

    const responseText = await this.askAI(prompt);
    const parsed = this.parseJSONResponse(responseText);
    // R5-H1: outer = image keys, inner = requested target locales.
    AIService.assertNestedComplete(
      'translateAltTextsBatch',
      parsed,
      Object.keys(sanitizedAltTexts),
      targetLocales,
    );
    return parsed;
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

    const prompt = `Translate the following URL slug/handle from ${localeName(fromLang)} to ${localeName(toLang)}.

IMPORTANT: The result MUST be a valid ASCII URL slug:
- Output ONLY lowercase ASCII letters (a-z), digits (0-9), and hyphens (-)
- Transliterate / romanize any non-Latin script (Chinese, Japanese, Korean, Cyrillic, Arabic, Greek, Thai, Hebrew, etc.) into Latin letters — do NOT output the original script
- Replace spaces with hyphens
- No umlauts, accents, diacritics, special characters, spaces, or underscores
- Examples: "storage-boxes", "wooden-chair", "blue-t-shirt", "beijing-fan-dian"

Source slug: ${sanitizedSlug}

Return only the translated ASCII URL slug, nothing else.`;

    const result = await this.askAI(prompt);

    // R5-H3: guarantee the slug is usable. For non-Latin titles the model can
    // still return CJK/Cyrillic/Arabic text which `sanitizeSlug` (elsewhere)
    // later strips to '' — silently producing an empty handle. If there is not
    // a single ASCII alphanumeric to build a slug from, fail loudly here
    // instead of returning something that sanitizes to nothing.
    if (!/[a-z0-9]/i.test(result)) {
      throw new Error(
        `translateSlug: model returned no ASCII alphanumerics (${fromLang} -> ${toLang}); ` +
        `result would sanitize to an empty slug`
      );
    }

    return result;
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

    const targetLanguages = targetLocales
      .map((loc) => `${localeName(loc)} (${loc})`)
      .join(', ');

    // Build expected JSON structure
    const jsonStructure: Record<string, string> = {};
    for (const locale of targetLocales) {
      jsonStructure[locale] = 'translated-slug';
    }

    const prompt = `Translate the following URL slug/handle from ${localeName(fromLang)} to: ${targetLanguages}.

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
    const parsed = this.parseJSONResponse(responseText);
    // R5-H1: every requested target locale must map to a non-empty slug.
    AIService.assertFlatComplete('translateSlugBatch', parsed, targetLocales);
    return parsed;
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
      .map((loc) => `${localeName(loc)} (${loc})`)
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

    const glossaryDirective = await this.getGlossaryDirective(
      Object.values(filteredFields),
      targetLocales,
    );

    const prompt = `Translate these ${contentType} fields from ${localeName(fromLang)} to: ${targetLanguages}.

${fieldsText}

Requirements:
- Keep translations concise and natural
- Maintain similar character length${handleInstructions}
${glossaryDirective ? `\n${glossaryDirective}\n` : ''}
Respond in JSON format:
${JSON.stringify(jsonStructure, null, 2)}`;

    const responseText = await this.askAI(prompt);
    const parsed = this.parseJSONResponse(responseText);
    // R5-H1: outer = requested locales, inner = the filtered field keys.
    AIService.assertNestedComplete(
      'translateShortFieldsBatch',
      parsed,
      targetLocales,
      Object.keys(filteredFields),
    );
    return parsed;
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

    // `fromLang === "auto"` lets the model detect each value's language
    // independently — needed when the source isn't necessarily in the shop's
    // primary locale (e.g. a 3rd-party widget label written in English on a
    // German-primary store). When the detected source matches `toLang`, the
    // value is returned unchanged so the caller gets a deterministic 1:1 copy.
    const isAuto = fromLang === "auto";
    const fromName = isAuto ? "" : localeName(fromLang);
    const toName = localeName(toLang);

    loggers.ai('info', `[AI-SERVICE] Translating batch of ${values.length} values`, {
      fromLang,
      toLang,
      context,
      values: values.slice(0, 3), // Log first 3 values for debugging
    });

    // Build numbered list for clear mapping. maxLength 2000 leaves headroom for
    // the longer paragraphs we now collect (direct-translation candidates can
    // be up to 1500 chars); 500 silently truncated those before reaching the AI.
    const numberedValues = values.map((v, i) => `${i + 1}. ${sanitizePromptInput(v, { maxLength: 2000, allowNewlines: false })}`).join('\n');

    const sourceClause = isAuto
      ? `For each ${context} value, detect its source language and translate it to ${toName} (${toLang}). If a value is already written in ${toName}, return it UNCHANGED (1:1 copy).`
      : `Translate these ${context} values from ${fromName} to ${toName} (${toLang}).`;

    const glossaryDirective = await this.getGlossaryDirective(values, [toLang]);

    const prompt = `${sourceClause}

${numberedValues}

Requirements:
- Keep translations concise and natural
- Maintain similar character length
- Inside translated strings, escape any straight double-quote as \\" so the JSON array stays valid
- Return ONLY a JSON array of translated strings in the same order
${glossaryDirective ? `\n${glossaryDirective}\n` : ''}
Respond in JSON format: ["translated1", "translated2", ...]`;

    // R3-M10 scope note: these two are DEBUG level (not error). The winston
    // logger level is 'info' in production, so debug breadcrumbs with raw
    // content are never emitted/persisted there; they exist only for local
    // troubleshooting. Intentionally kept (the finding was error-level logs).
    loggers.ai('debug', '[AI-SERVICE] Batch translation prompt', { prompt: prompt.substring(0, 500) });

    const responseText = await this.askAI(prompt);

    loggers.ai('debug', '[AI-SERVICE] Batch translation response', { response: responseText.substring(0, 500) });

    // Strict parse first; on failure, attempt a permissive recovery for the
    // common case where the model emitted an unescaped " inside a value
    // (typographic content with mixed straight + curly quotes).
    let parsed: unknown;
    try {
      parsed = this.parseJSONResponse(responseText);
    } catch (err) {
      const recovered = AIService.recoverMalformedStringArray(responseText, values.length);
      if (recovered) {
        loggers.ai('info', `[AI-SERVICE] Batch translation: recovered ${recovered.length} values after JSON parse failure`);
        return recovered;
      }
      throw err;
    }

    // Handle both array and object responses
    if (Array.isArray(parsed)) {
      // The numbered prompt maps 1:1 to the input order. A different length
      // means the model dropped or merged items — returning it would silently
      // misalign every translation after the gap and still be reported as
      // "success". Fail loudly so the task is retried/failed instead.
      if (parsed.length !== values.length) {
        // R3-M10: never log raw model output at error level — it is BYO
        // merchant content / possible PII, winston persists error logs to
        // file + console, and there is no server-side scrub. Length is
        // enough to diagnose a truncation/format problem.
        loggers.ai('error', `[AI-SERVICE] Batch translation length mismatch: expected ${values.length}, got ${parsed.length}`, { responseLength: responseText.length });
        throw new Error(`AI batch translation returned ${parsed.length} values, expected ${values.length}`);
      }
      loggers.ai('info', `[AI-SERVICE] Batch translation successful: ${parsed.length} values translated`);
      return parsed.map(String);
    }

    // Never fall back to the untranslated source: returning `values` here
    // caused source-language text to be written to Shopify/DB as if it were a
    // translation (silent, hard-to-detect corruption). Fail loudly so the
    // caller marks the task failed and writes nothing (N-H3).
    loggers.ai('error', '[AI-SERVICE] Batch translation response was not a JSON array', { responseLength: responseText.length });
    throw new Error('AI batch translation did not return a JSON array');
  }

  /**
   * Generate short, concise menu-style titles for a batch of content excerpts in
   * one AI call. Built for Shopify email-notification templates, whose only
   * human-readable field is the localized subject line (e.g. "Bestellung
   * {{name}} bestätigt") — far too long/noisy for a nav list. We ask the model
   * to distill each excerpt into a 2-4 word notification name in the shop's main
   * language ("Bestellbestätigung", "Versandbestätigung", …), mirroring what
   * Shopify's own Translate & Adapt shows (those are private Shopify i18n
   * strings, not exposed by the API — see the EMAIL_TEMPLATE probe findings).
   *
   * Mirrors translateBatchValues: numbered list in, JSON array out, 1:1 length
   * assertion (fail loud on drift so a partial/misaligned result is never
   * persisted as success).
   */
  async generateTitlesBatch(excerpts: string[], targetLocale: string): Promise<string[]> {
    if (excerpts.length === 0) return [];

    const toName = localeName(targetLocale);

    loggers.ai('info', `[AI-SERVICE] Generating batch of ${excerpts.length} short titles`, {
      targetLocale,
      count: excerpts.length,
    });

    const numbered = excerpts
      .map((v, i) => `${i + 1}. ${sanitizePromptInput(v, { maxLength: 800, allowNewlines: true })}`)
      .join('\n\n');

    const prompt = `You are labelling Shopify email notification templates for a navigation list. For each numbered template excerpt below, return a SHORT, concise title in ${toName} (${targetLocale}) that names the KIND of notification — like a menu label, not the literal subject line. Style examples (German): "Bestellbestätigung", "Versandbestätigung", "Zahlungserinnerung".

Templates:
${numbered}

Requirements:
- Output language: ${toName} (${targetLocale})
- 2-4 words per title, describing the notification TYPE (not the raw subject)
- No Liquid variables ({{ }} or {% %}), no shop/customer names, no order numbers, no trailing punctuation
- Return ONLY a JSON array of strings, in the same order, with exactly ${excerpts.length} items

Respond in JSON format: ["title1", "title2", ...]`;

    loggers.ai('debug', '[AI-SERVICE] Batch title prompt', { prompt: prompt.substring(0, 500) });

    const responseText = await this.askAI(prompt);

    loggers.ai('debug', '[AI-SERVICE] Batch title response', { response: responseText.substring(0, 500) });

    const parsed = this.parseJSONResponse(responseText);
    if (!Array.isArray(parsed)) {
      loggers.ai('error', '[AI-SERVICE] Batch title response was not a JSON array', { responseLength: responseText.length });
      throw new Error('AI batch title generation did not return a JSON array');
    }
    if (parsed.length !== excerpts.length) {
      loggers.ai('error', `[AI-SERVICE] Batch title length mismatch: expected ${excerpts.length}, got ${parsed.length}`, { responseLength: responseText.length });
      throw new Error(`AI batch title generation returned ${parsed.length} titles, expected ${excerpts.length}`);
    }
    loggers.ai('info', `[AI-SERVICE] Batch title generation successful: ${parsed.length} titles`);
    return parsed.map((s) => String(s).trim());
  }

  /**
   * Up to `maxCount` synonyms / close alternative phrases per term for a batch
   * of product/collection titles or primary keywords — extra anchor candidates
   * for the internal-linking matcher (PLAN_SEO_SUITE_COMPLETION.md §4.1/§4.3,
   * internal-links.service.ts).
   *
   * BATCHED ON PURPOSE: the first implementation issued one request per target
   * item, so a single "Vorschläge generieren" click cost up to
   * MAX_SYNONYM_TARGETS (200) tiny AI requests. The matcher only needs a short
   * word list per term, so N terms fit in ONE prompt — the caller chunks its
   * targets (SYNONYM_BATCH_SIZE) and this returns one synonym list per term,
   * positionally aligned with `terms`.
   *
   * `avoid[i]` are anchor texts the merchant already rejected for `terms[i]`
   * (dismissed SeoInternalLinkSuggestion rows) — passed into the prompt so the
   * model stops re-proposing wordings that were turned down. The caller ALSO
   * filters them out of the result, so this is a cost/quality hint, not the
   * guarantee (the guarantee is the caller's + the DB's, never the model's).
   *
   * Results are used once and never persisted (§4.4 "ephemeral-per-run"
   * decision — see internal-links.service.ts's header). Never throws, and
   * never returns a mis-aligned array: any provider/parse/length problem
   * degrades to empty lists for that batch (matching still works on
   * title/keyword anchors) instead of failing the whole run or silently
   * pairing synonyms with the wrong target.
   */
  async generateSynonymsBatch(
    terms: string[],
    locale: string,
    options: { maxCount?: number; avoid?: string[][] } = {},
  ): Promise<string[][]> {
    const { maxCount = 3, avoid = [] } = options;
    const empty = terms.map(() => [] as string[]);
    if (terms.length === 0) return [];

    const sanitizedTerms = terms.map((term) => sanitizePromptInput(term, { maxLength: 200 }));
    if (sanitizedTerms.every((t) => !t)) return empty;

    const language = localeName(locale) || 'English';
    const numbered = sanitizedTerms
      .map((term, i) => {
        const rejected = (avoid[i] ?? [])
          .map((a) => sanitizePromptInput(a, { maxLength: 200 }))
          .filter(Boolean)
          .slice(0, 10);
        const suffix = rejected.length > 0 ? ` — already rejected, do not repeat: ${rejected.map((r) => `"${r}"`).join(', ')}` : '';
        return `${i + 1}. "${term || '(empty)'}"${suffix}`;
      })
      .join('\n');

    const prompt = `For each numbered term below, list up to ${maxCount} short synonyms or close alternative phrases a shopper might realistically use instead of it in ${language}, for finding mentions of that same product/topic in other text (blog articles, page content). Single words or short phrases only — no full sentences.

Terms:
${numbered}

Requirements:
- Output language: ${language}
- Return ONLY a JSON array of arrays of strings, in the same order, with exactly ${terms.length} entries — one inner array per numbered term
- Use an empty inner array [] for a term you have no good synonym for
- Never repeat a term's own wording, and never repeat a wording listed as already rejected for that term

Respond in JSON format: [["synonym one", "synonym two"], [], ...]`;

    try {
      const responseText = await this.askAI(prompt);
      const parsed: unknown = this.parseJSONResponse(responseText);
      if (!Array.isArray(parsed) || parsed.length !== terms.length) {
        loggers.ai('warn', '[AI-SERVICE] generateSynonymsBatch: unexpected response shape — continuing with zero synonyms', {
          expected: terms.length,
          got: Array.isArray(parsed) ? parsed.length : typeof parsed,
        });
        return empty;
      }
      return parsed.map((entry) =>
        (Array.isArray(entry) ? entry : [])
          .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
          .map((s) => s.trim())
          .slice(0, maxCount),
      );
    } catch (err) {
      loggers.ai('warn', '[AI-SERVICE] generateSynonymsBatch failed — continuing with zero synonyms', {
        error: err instanceof Error ? err.message : String(err),
      });
      return empty;
    }
  }

  /**
   * The wording each TRANSLATED text actually uses for `anchor` — the internal
   * linking "carry translations" step
   * (app/services/seo/internal-links-translate.server.ts).
   *
   * Deliberately NOT a plain translation of the anchor. A context-free
   * translation of "Stifthalter" is "portalápiz", while the Spanish text most
   * likely says "portalápices" (or "lapicero") — close enough for a human,
   * useless for the exact whole-word insertion that follows, which would then
   * find nothing and leave that language unlinked. So the model gets the
   * translated text itself and must copy a substring OUT of it.
   *
   * That also makes the answer verifiable: the caller inserts the returned
   * phrase with the same matcher used everywhere else, so a hallucinated or
   * inflected wording simply fails to insert — it can never end up in the
   * merchant's content.
   *
   * One request for ALL locales. Never throws, never returns a locale it was
   * not asked about: any provider/parse problem degrades to "no wording for
   * that language", which costs a link, not a translation.
   */
  async findLocalizedAnchors(
    anchor: string,
    fromLocale: string,
    samples: { locale: string; text: string }[],
    options: { maxTextChars?: number } = {},
  ): Promise<Record<string, string>> {
    const { maxTextChars = 3000 } = options;
    const cleanAnchor = sanitizePromptInput(anchor, { maxLength: 200 });
    if (!cleanAnchor || samples.length === 0) return {};

    const blocks = samples
      .map((sample) => {
        // Truncated per locale: only the wording matters, and a long body would
        // push several languages past the context window in one request.
        const text = sanitizePromptInput(sample.text, { allowNewlines: true }).slice(0, maxTextChars);
        return `### ${sample.locale}\n${text || '(empty)'}`;
      })
      .join('\n\n');

    const jsonStructure: Record<string, string> = {};
    for (const sample of samples) jsonStructure[sample.locale] = '...';

    const prompt = `A phrase from a ${localeName(fromLocale) || fromLocale} text is going to be turned into a link. Below are translations of that same text in other languages. For each one, find the wording IT uses for that phrase.

Phrase: "${cleanAnchor}"

${blocks}

Requirements:
- Copy the wording EXACTLY as it appears in that language's text, character for character, including its inflection, capitalization and any accents. Do not translate the phrase yourself and do not normalize it to a dictionary form.
- Pick the shortest wording that clearly refers to the same thing, and prefer its first occurrence.
- If a text does not mention the thing at all, return an empty string "" for that language. An empty string is the correct answer — never guess.
- One entry per language code below, no extra keys.

Respond with ONLY this JSON shape:
${JSON.stringify(jsonStructure, null, 2)}`;

    try {
      const responseText = await this.askAI(prompt);
      const parsed: unknown = this.parseJSONResponse(responseText);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        loggers.ai('warn', '[AI-SERVICE] findLocalizedAnchors: unexpected response shape — no localized anchors', {
          got: Array.isArray(parsed) ? 'array' : typeof parsed,
        });
        return {};
      }
      const out: Record<string, string> = {};
      for (const sample of samples) {
        const value = (parsed as Record<string, unknown>)[sample.locale];
        if (typeof value === 'string' && value.trim().length > 0) out[sample.locale] = value.trim();
      }
      return out;
    } catch (err) {
      loggers.ai('warn', '[AI-SERVICE] findLocalizedAnchors failed — translations keep their text without a link', {
        error: err instanceof Error ? err.message : String(err),
      });
      return {};
    }
  }

  /**
   * Permissive recovery for a malformed `["a", "b", ...]` response when the
   * model forgot to escape a straight " inside one of the values (common with
   * typographic content like German „Foo"). Strict JSON.parse rejects the
   * payload; we fall back to splitting on the `","` boundary, which is stable
   * even when individual values contain stray ASCII quotes. Returns null when
   * the response shape is anything else — we then keep the original error
   * (better than persisting a wrong split silently).
   */
  private static recoverMalformedStringArray(text: string, expectedLength: number): string[] | null {
    // Strip code fence if any.
    const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    const body = (fenced ? fenced[1] : text).trim();
    // Must look like an array (allow whitespace + leading/trailing junk that
    // happens occasionally).
    const arrMatch = body.match(/\[\s*"([\s\S]*)"\s*\]\s*$/);
    if (!arrMatch) return null;
    const inner = arrMatch[1];
    // Single-element case: nothing to split — the whole inner IS the value.
    if (expectedLength === 1) return [inner];
    // Multi-element: split on `","` boundary (potentially with whitespace).
    const parts = inner.split(/"\s*,\s*"/);
    if (parts.length !== expectedLength) return null;
    return parts;
  }

  async translateSEO(
    seoTitle: string,
    metaDescription: string,
    targetLocales: string[]
  ): Promise<Record<string, { seoTitle: string; metaDescription: string }>> {
    // Sanitize SEO fields
    const sanitizedTitle = sanitizePromptInput(seoTitle, { fieldType: 'seoTitle' });
    const sanitizedDescription = sanitizePromptInput(metaDescription, { fieldType: 'metaDescription' });

    const targetLanguages = targetLocales.map((loc) => `${localeName(loc)} (${loc})`).join(', ');

    // Build the expected JSON structure from the actual requested locales (the
    // old hardcoded en/fr/es/it example did not reflect targetLocales).
    const jsonStructure: Record<string, { seoTitle: string; metaDescription: string }> = {};
    for (const locale of targetLocales) {
      jsonStructure[locale] = { seoTitle: '...', metaDescription: '...' };
    }

    const glossaryDirective = await this.getGlossaryDirective(
      [sanitizedTitle, sanitizedDescription],
      targetLocales,
    );

    const prompt = `Translate these SEO texts from the source language to ${targetLanguages}.

SEO Title: ${sanitizedTitle}
Meta Description: ${sanitizedDescription}

Make sure that the character lengths remain similar and the translations sound natural.
${glossaryDirective ? `\n${glossaryDirective}\n` : ''}
Respond in JSON format:
${JSON.stringify(jsonStructure, null, 2)}`;

    const responseText = await this.askAI(prompt);
    const parsed = this.parseJSONResponse(responseText);
    // R5-H1: every requested locale must carry both SEO sub-fields.
    AIService.assertNestedComplete(
      'translateSEO',
      parsed,
      targetLocales,
      ['seoTitle', 'metaDescription'],
    );
    return parsed;
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

    // Resolve via the tolerant localeName() (exact -> base language -> raw
    // code) rather than a hardcoded 'German': an unknown locale defaulting to
    // German produced confidently wrong-language content. English is the
    // conceptual default when no code at all is supplied.
    const language = localeName(sanitizedContext.locale) || 'English';
    const isTitle = fieldType === 'title';
    const fieldLabel = isTitle ? 'Title' : 'Description';

    // §2.5e — the glossary applies to the ORIGINAL too, not only to its
    // translations. Filtered by the context the model is writing about, so a
    // 200-term glossary does not dilute the instructions.
    const glossaryDirective = await this.getGlossaryGenerationDirective(
      [sanitizedContext.productTitle, sanitizedContext.productDescription, sanitizedContext.productType, sanitizedCurrentValue],
      sanitizedContext.locale,
    );

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

Output the result in ${language}.${glossaryDirective ? `\n\n${glossaryDirective}` : ''}`;
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

Output the result in ${language}.${glossaryDirective ? `\n\n${glossaryDirective}` : ''}`;
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

    const targetLanguages = targetLocales.map((loc) => localeName(loc)).join(', ');

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

    const glossaryDirective = await this.getGlossaryDirective(
      Object.values(sanitizedFields),
      targetLocales,
    );

    const prompt = `Translate these ${contentType === 'product' ? 'product' : contentType === 'collection' ? 'collection' : contentType === 'blog' ? 'blog' : contentType === 'page' ? 'page' : contentType === 'policy' ? 'policy' : 'product'} fields from the source language to ${targetLanguages}.

${fieldsText}

${instructions}
${glossaryDirective ? `\n${glossaryDirective}\n` : ''}
Respond in JSON format:
${JSON.stringify(jsonStructure, null, 2)}`;

    const responseText = await this.askAI(prompt);
    const parsed = this.parseJSONResponse(responseText);
    // R5-H1: a description value containing `}` or `"seoTitle":` could
    // truncate matchBalancedJSON, silently dropping later fields/locales while
    // the task reported success. Assert outer = every requested locale, inner
    // = every requested field key, each a non-empty string; else throw.
    AIService.assertNestedComplete(
      'translateFields',
      parsed,
      targetLocales,
      Object.keys(fields),
    );
    return parsed;
  }

  /**
   * Translate an arbitrary set of fields (key -> source text) into many locales
   * in a SINGLE AI request, returning `{ locale: { key: translated } }`.
   *
   * Unlike translateShortFieldsBatch this imposes NO field-key allow-list and
   * NO maxLength cap, so long HTML bodies (descriptions, legal pages, theme
   * template content) pass through untruncated — mirroring translateContent's
   * contract that long content must reach the model intact (the provider errors
   * loudly if it overflows the context window rather than silently truncating).
   *
   * Use {@link translateFieldsToLocalesChunked} when the combined payload may be
   * large; it splits the work across calls and falls back here for each chunk.
   */
  async translateFieldsToLocalesBatch(
    fields: Record<string, string>,
    fromLang: string,
    targetLocales: string[],
    options: { preserveHtml?: boolean; contextLabel?: string } = {}
  ): Promise<Record<string, Record<string, string>>> {
    const preserveHtml = options.preserveHtml ?? true;
    const contextLabel = options.contextLabel || 'content';

    const sanitizedFields: Record<string, string> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (value && value.trim().length > 0) {
        // No maxLength: long content must pass through untruncated (see the
        // contract note on translateContent). allowNewlines so HTML/multiline
        // bodies survive sanitization.
        sanitizedFields[key] = sanitizePromptInput(value, { allowNewlines: true });
      }
    }

    const fieldKeys = Object.keys(sanitizedFields);
    if (fieldKeys.length === 0 || targetLocales.length === 0) return {};

    const targetLanguages = targetLocales
      .map((loc) => `${localeName(loc)} (${loc})`)
      .join(', ');

    // Each field gets a "### <key>" header so the model can map source ->
    // output unambiguously even for long multi-paragraph bodies.
    const fieldsText = Object.entries(sanitizedFields)
      .map(([key, value]) => `### ${key}\n${value}`)
      .join('\n\n');

    // Expected JSON skeleton: outer = locale code, inner = field key.
    const jsonStructure: Record<string, Record<string, string>> = {};
    for (const locale of targetLocales) {
      jsonStructure[locale] = {};
      for (const key of fieldKeys) jsonStructure[locale][key] = '...';
    }

    const htmlRule = preserveHtml
      ? '\n- Keep ALL HTML tags, attributes, and structure exactly as in the source; translate only the human-readable text between the tags.'
      : '';

    const glossaryDirective = await this.getGlossaryDirective(
      Object.values(sanitizedFields),
      targetLocales,
    );

    const prompt = `Translate the following ${contextLabel} fields from ${localeName(fromLang)} to: ${targetLanguages}.

Each field is introduced by a "### <key>" header followed by its source text.

${fieldsText}

Requirements:
- Translate EVERY field into EVERY target language.
- Keep the translation natural and faithful to the source meaning.
- Maintain a similar length to the source.${htmlRule}
- Do NOT add explanations or extra fields.
${glossaryDirective ? `\n${glossaryDirective}\n` : ''}
Respond with ONLY this JSON shape (outer keys = locale codes, inner keys = field keys):
${JSON.stringify(jsonStructure, null, 2)}`;

    const responseText = await this.askAI(prompt);
    const parsed = this.parseJSONResponse(responseText);

    // R5-H1: fail loud if any requested locale/field cell is missing or
    // non-string (a stray `}` in a long body can truncate the JSON and silently
    // drop later cells while the task still reports success).
    AIService.assertNestedComplete(
      'translateFieldsToLocalesBatch',
      parsed,
      targetLocales,
      fieldKeys,
    );

    // Echo handling: a cell equal to its source is normally fine — many short
    // words and proper nouns are spelled identically across languages (e.g.
    // "Schadenfreude", "Hotel", "Information", brand names), so they are KEPT
    // and used. Only a LONG field returned byte-identical is a failed
    // translation (a full paragraph never legitimately equals its source); drop
    // just that cell so it is not persisted as source-as-translation (N-H3) —
    // the caller's "missing cell → skip" handling keeps the rest usable.
    const result = parsed as Record<string, Record<string, string>>;
    const { ECHO_FAILURE_MIN_CHARS } = TRANSLATION_BATCH;
    let droppedLongEchoes = 0;
    for (const locale of targetLocales) {
      if (locale === fromLang) continue;
      for (const key of fieldKeys) {
        const src = sanitizedFields[key].trim();
        const out = result[locale][key].trim();
        if (out === src && src.length >= ECHO_FAILURE_MIN_CHARS) {
          delete result[locale][key];
          droppedLongEchoes++;
        }
      }
    }
    if (droppedLongEchoes > 0) {
      loggers.ai('warn', '[AI-SERVICE] translateFieldsToLocalesBatch: dropped long echoed (untranslated) cells', {
        dropped: droppedLongEchoes,
        fromLang,
      });
    }

    return result;
  }

  /**
   * Chunking wrapper around {@link translateFieldsToLocalesBatch}. Estimates the
   * output size and, only when it would exceed CHUNK_THRESHOLD_CHARS, splits the
   * work across multiple batch calls — locale-chunking first, then
   * field-chunking, and finally per-field translateContent for a single field
   * too large on its own — run with bounded concurrency. Partial results are
   * merged back into one `{ locale: { key: translated } }` map.
   *
   * Resilience: a single failed chunk omits only its own cells (the caller
   * skips the missing ones — N-H3, never source-as-translation). Only when
   * EVERY chunk fails does it throw, so the caller's outer catch can fall back
   * to the sequential path.
   */
  async translateFieldsToLocalesChunked(
    fields: Record<string, string>,
    fromLang: string,
    targetLocales: string[],
    options: { preserveHtml?: boolean; contextLabel?: string } = {}
  ): Promise<Record<string, Record<string, string>>> {
    const entries = Object.entries(fields).filter(([, v]) => v && v.trim().length > 0);
    if (entries.length === 0 || targetLocales.length === 0) return {};

    const { CHUNK_THRESHOLD_CHARS, OUTPUT_EXPANSION_FACTOR, MAX_CONCURRENCY } = TRANSLATION_BATCH;
    const sourceChars = entries.reduce((a, [, v]) => a + v.length, 0);
    const estimatedOutput = sourceChars * targetLocales.length * OUTPUT_EXPANSION_FACTOR;

    // Fast path: the whole payload fits in one call.
    if (estimatedOutput <= CHUNK_THRESHOLD_CHARS) {
      loggers.ai('info', '[AI-SERVICE] translateFieldsToLocalesChunked: single batch', {
        fields: entries.length,
        locales: targetLocales.length,
        chunks: 1,
        estimatedOutput,
      });
      return this.translateFieldsToLocalesBatch(fields, fromLang, targetLocales, options);
    }

    // Source-char budget that keeps ONE locale's output under the threshold.
    const perLocaleBudget = CHUNK_THRESHOLD_CHARS / OUTPUT_EXPANSION_FACTOR;
    const byKey = new Map(entries);

    // Split fields into groups that each fit one locale under budget. A single
    // field larger than the budget becomes its own (oversized) group, handled
    // via the translateContent fallback below.
    const fieldGroups: string[][] = [];
    let cur: string[] = [];
    let curChars = 0;
    for (const [key, val] of entries) {
      if (val.length >= perLocaleBudget) {
        if (cur.length) { fieldGroups.push(cur); cur = []; curChars = 0; }
        fieldGroups.push([key]);
        continue;
      }
      if (curChars + val.length > perLocaleBudget && cur.length) {
        fieldGroups.push(cur); cur = []; curChars = 0;
      }
      cur.push(key);
      curChars += val.length;
    }
    if (cur.length) fieldGroups.push(cur);

    // Build the list of chunk jobs. Each resolves to a partial result map.
    type Job = () => Promise<Record<string, Record<string, string>>>;
    const jobs: Job[] = [];

    for (const group of fieldGroups) {
      const groupChars = group.reduce((a, k) => a + (byKey.get(k)?.length || 0), 0);

      // Oversized single field: even one locale exceeds the threshold. There is
      // no JSON-batching benefit, so fall back to translateContent per locale
      // (per plan step 3). translateContent returns plain text — safer than
      // JSON-wrapping a very large HTML body — and its own prompt already
      // instructs "Keep HTML tags", so options.preserveHtml is honored in
      // spirit even though the batch prompt's stronger wording isn't reused.
      if (group.length === 1 && groupChars >= perLocaleBudget) {
        const key = group[0];
        const src = byKey.get(key) || '';
        for (const locale of targetLocales) {
          jobs.push(async () => {
            const translated = await this.translateContent(src, fromLang, locale);
            return { [locale]: { [key]: translated } };
          });
        }
        continue;
      }

      const groupFields: Record<string, string> = {};
      for (const k of group) groupFields[k] = byKey.get(k) || '';

      const localesPerChunk = Math.max(1, Math.floor(perLocaleBudget / groupChars));
      for (let i = 0; i < targetLocales.length; i += localesPerChunk) {
        const localeChunk = targetLocales.slice(i, i + localesPerChunk);
        jobs.push(() =>
          this.translateFieldsToLocalesBatch(groupFields, fromLang, localeChunk, options)
        );
      }
    }

    loggers.ai('info', '[AI-SERVICE] translateFieldsToLocalesChunked: chunked', {
      fields: entries.length,
      locales: targetLocales.length,
      chunks: jobs.length,
      estimatedOutput,
    });

    // Run with bounded concurrency; collect partials and errors.
    const merged: Record<string, Record<string, string>> = {};
    const errors: unknown[] = [];
    let succeeded = 0;
    let cursor = 0;

    const worker = async (): Promise<void> => {
      while (cursor < jobs.length) {
        const idx = cursor++;
        try {
          const partial = await jobs[idx]();
          for (const [locale, cells] of Object.entries(partial)) {
            Object.assign((merged[locale] ??= {}), cells);
          }
          succeeded++;
        } catch (err) {
          errors.push(err);
          loggers.ai('error', '[AI-SERVICE] translateFieldsToLocalesChunked: chunk failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(MAX_CONCURRENCY, jobs.length) }, () => worker())
    );

    // Every chunk failed → throw so the caller can fall back to sequential.
    if (succeeded === 0 && errors.length > 0) {
      throw errors[0];
    }

    return merged;
  }

  private estimateTokens(prompt: string): number {
    // Rough estimate: ~4 characters per token
    // Add output tokens estimate (2000 max_tokens)
    const inputTokens = Math.ceil(prompt.length / 4);
    const outputTokens = 8192;
    return inputTokens + outputTokens;
  }

  private async askAI(prompt: string, imageUrl?: string): Promise<string> {
    // Circuit breaker: a previous call on this instance already saw the
    // provider reject the key — fail fast instead of firing more 401s.
    if (this.authError) throw this.authError;

    // Save prompt to database if taskId is provided
    if (this.taskId && this.shop) {
      await this.savePromptToTask(prompt, imageUrl);
    }

    let response: string;

    try {
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
    } catch (error) {
      // Normalise provider auth failures (invalid/expired key) into a single
      // typed error and trip the breaker. Callers that loop over locales must
      // re-throw this rather than swallowing it (see isAuthError usages), so an
      // invalid key always surfaces instead of silently producing no output.
      if (isAuthError(error)) {
        this.authError = new InvalidAIKeyError(error instanceof Error ? error.message : String(error));
        throw this.authError;
      }
      throw error;
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
    let timer: NodeJS.Timeout | undefined;
    try {
      // Backstop timeout: even if a provider SDK ignores its own timeout
      // (e.g. Gemini/HF have no constructor timeout), this guarantees the
      // shared queue slot is released so other shops are not blocked.
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new AIRequestTimeoutError(AI_REQUEST_TIMEOUT_MS)),
          AI_REQUEST_TIMEOUT_MS,
        );
      });
      return await Promise.race([
        this._executeAIRequestInner(prompt, imageUrl),
        timeoutPromise,
      ]);
    } catch (error) {
      if (AIService.isInputTooLongError(error)) {
        throw new Error(AIService.INPUT_TOO_LONG_MESSAGE);
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
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
        const textBlock = message.content.find((b) => b.type === 'text');
        if (!textBlock) throw new Error('Claude returned no text block');
        if (!textBlock.text.trim()) throw new Error('Claude returned empty text');
        return textBlock.text;
      } else {
        const message = await this.anthropic.messages.create({
          model: this.getModel(),
          max_tokens: 8192,
          messages: [{ role: 'user', content: prompt }],
        });
        const textBlock = message.content.find((b) => b.type === 'text');
        if (!textBlock) throw new Error('Claude returned no text block');
        if (!textBlock.text.trim()) throw new Error('Claude returned empty text');
        return textBlock.text;
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

  /**
   * §2.5e — the glossary block for a caller-built prompt.
   *
   * `generateProductTitle`/`Description` take a prompt the CALLER assembled
   * (AI instructions, keywords, context), so the glossary cannot be woven in
   * the way `generateContent` does it. It is appended instead — after the
   * caller's instructions, which is where a terminology rule belongs: it
   * constrains the wording, it does not describe the task.
   *
   * Silent when the shop has no glossary, so the prompt is byte-identical for
   * everyone who does not use one.
   */
  private async appendGlossary(prompt: string, contextTexts: string[], locale?: string): Promise<string> {
    // NOT `if (!locale) return prompt`. An empty locale means the shop-locale
    // lookup failed (getCachedShopLocales resolves with [] on a swallowed
    // error), and short-circuiting here turned one throttled query into
    // "the merchant's brand-name protection is silently off". The builder
    // already degrades correctly: it drops the half that needs a locale and
    // keeps the do-not-translate names, which hold in every language.
    const directive = await this.getGlossaryGenerationDirective(contextTexts, locale ?? '');
    return directive ? `${prompt}\n\n${directive}` : prompt;
  }

  async generateProductTitle(
    prompt: string,
    imageUrl?: string,
    glossary?: { contextTexts: string[]; locale: string },
  ): Promise<string> {
    // The prompt is already built by the caller with AI Instructions
    // Just execute it directly without adding additional instructions
    return await this.askAI(
      glossary ? await this.appendGlossary(prompt, glossary.contextTexts, glossary.locale) : prompt,
      imageUrl,
    );
  }

  async generateProductDescription(
    title: string,
    prompt: string,
    imageUrl?: string,
    glossary?: { contextTexts: string[]; locale: string },
  ): Promise<string> {
    // The prompt is already built by the caller with AI Instructions
    // Just execute it directly without adding additional instructions
    return await this.askAI(
      glossary ? await this.appendGlossary(prompt, [title, ...glossary.contextTexts], glossary.locale) : prompt,
      imageUrl,
    );
  }

  /**
   * §2.5e — alt text is short, and a product name is most of it. A shop that
   * forces "Kumiko" as a do-not-translate term gets it spelled that way in
   * every translation and paraphrased in the original alt text without this.
   *
   * `glossary` is optional so the many call sites that have no locale to hand
   * stay byte-identical rather than guessing one.
   */
  async generateImageAltText(imageUrl: string, productTitle?: string, customPrompt?: string, sendImageToAI: boolean = false, glossary?: { contextTexts: string[]; locale: string }): Promise<string> {
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
    return await this.askAI(
      glossary ? await this.appendGlossary(prompt, [sanitizedTitle, ...glossary.contextTexts], glossary.locale) : prompt,
      sendImageToAI ? imageUrl : undefined,
    );
  }

  /**
   * Scan `text` from `start` (which must be '{' or '[') and return the index
   * just past the matching close bracket, honoring nesting and JSON string
   * literals (so brackets inside strings don't count). Returns -1 if no
   * balanced span exists. This replaces the previous lazy/greedy regexes,
   * which truncated nested arrays/objects (`[{"a":[1]}]` → `[{"a":[1]`) or
   * over-captured trailing prose, spuriously failing valid responses.
   */
  private static matchBalancedJSON(text: string, start: number): number {
    const open = text[start];
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) return i + 1;
      }
    }
    return -1;
  }

  /**
   * R5-H1: assert that a parsed `{ outerKey: { innerKey: string } }` response
   * contains every requested outer key, every requested inner key per outer
   * key, and that each leaf is a non-empty string.
   *
   * `matchBalancedJSON` can terminate early when a long description value
   * contains a stray `}` or `"someKey":` — leaving later fields/locales
   * silently missing while the task still reports success. Mirroring
   * `translateBatchValues`'s strictness, we throw on any missing/non-string
   * key so the task is marked failed and nothing partial is persisted.
   */
  private static assertNestedComplete(
    method: string,
    parsed: unknown,
    outerKeys: string[],
    innerKeys: string[],
  ): void {
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${method}: AI response was not a JSON object`);
    }
    const obj = parsed as Record<string, unknown>;
    for (const outer of outerKeys) {
      const bucket = obj[outer];
      if (bucket === null || typeof bucket !== 'object' || Array.isArray(bucket)) {
        throw new Error(`${method}: AI response missing or invalid entry for "${outer}"`);
      }
      const inner = bucket as Record<string, unknown>;
      for (const key of innerKeys) {
        const value = inner[key];
        if (typeof value !== 'string' || value.trim().length === 0) {
          throw new Error(`${method}: AI response missing or non-string "${key}" for "${outer}"`);
        }
      }
    }
  }

  /**
   * R5-H1: flat-map variant of {@link assertNestedComplete} for responses
   * shaped `{ key: string }` (e.g. translateSlugBatch).
   */
  private static assertFlatComplete(
    method: string,
    parsed: unknown,
    keys: string[],
  ): void {
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${method}: AI response was not a JSON object`);
    }
    const obj = parsed as Record<string, unknown>;
    for (const key of keys) {
      const value = obj[key];
      if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error(`${method}: AI response missing or non-string value for "${key}"`);
      }
    }
  }

  private parseJSONResponse(text: string): any {
    // 1. Strip a single surrounding markdown code fence, if present.
    const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    const candidate = (fenced ? fenced[1] : text).trim();

    // 2. Fast path: the whole candidate is already valid JSON.
    try {
      return JSON.parse(candidate);
    } catch {
      // fall through to bracket extraction
    }

    // 3. Extract the first balanced JSON object/array embedded in prose.
    for (let i = 0; i < candidate.length; i++) {
      const ch = candidate[i];
      if (ch !== '{' && ch !== '[') continue;
      const end = AIService.matchBalancedJSON(candidate, i);
      // R5-M3: a stray/unbalanced `{` or `[` in prose before the real JSON
      // (placeholder text, an example, a `{note}` token) used to `break` the
      // whole scan → a perfectly valid JSON object later in the response was
      // discarded as unparseable (false failure + wasted API cost). Skip this
      // opener and keep scanning for the next balanced span instead.
      if (end === -1) continue;
      try {
        return JSON.parse(candidate.slice(i, end));
      } catch {
        // Not valid JSON starting here; keep scanning for the next opener.
      }
    }

    // R3-M10: log only the length, not raw model output (BYO merchant
    // content / possible PII; winston error logs hit file + console with no
    // server-side scrub).
    loggers.ai('error', '[AI-SERVICE] Could not parse JSON from AI response', { responseLength: text.length });
    throw new Error('Could not parse JSON from AI response');
  }
}
