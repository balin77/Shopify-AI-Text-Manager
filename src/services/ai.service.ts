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
import {
  estimateOutputChars,
  fitsOneRequest,
  perLocaleSourceBudgetChars,
  planLocaleChunks,
} from '../../app/services/ai/translation-budget.shared';
import { ADHOC_FEATURE, type AiCredentialSource } from '../../app/services/ai/usage-dimensions.shared';

export type AIProvider = 'huggingface' | 'gemini' | 'claude' | 'openai' | 'grok' | 'deepseek';

/**
 * What one provider call consumed, as it leaves the provider branch.
 *
 * The MODEL rides out with the usage rather than being read back from the
 * instance afterwards: a failover (planned) switches the model mid-call, and a
 * cost derived from configuration that has since moved is a cost attributed to
 * the wrong model.
 */
export interface AiCallUsage {
  inputTokens: number;
  outputTokens: number;
  model: string;
  /** `provider` = the SDK reported both numbers; `estimate` = we counted characters. */
  source: 'provider' | 'estimate';
}

/**
 * Where a provider call's cost is reported the moment the provider ANSWERS.
 *
 * A side channel rather than a return value, and that is the whole point: the
 * two events are not the same one. `_executeAIRequestInner` returns once, on
 * success — but a provider that answered has already charged us, and this
 * function rejects such an answer in sixteen places (`returned empty content`,
 * `no text block`, a `finish_reason: length` truncation, a content refusal).
 * Reporting cost through the return value metered every one of those at zero,
 * and the truncation case is the MOST expensive call shape there is, so the
 * under-count was biased exactly backwards. Gemini's vision fallback makes the
 * same point from the other side: two billed provider calls inside one
 * invocation, which one return value could only express by adding them up and
 * calling it one call.
 */
export interface AiCallMeter {
  /**
   * Provider calls STARTED — incremented immediately before each request.
   *
   * `dispatched > observed.length` is the only way to know that a call is
   * still out there generating: it is what makes the timeout's worst-case
   * charge unconditional. Gating that charge on "nothing has been reported
   * yet" left the one case with two provider calls — Gemini's vision fallback,
   * where the first answers and the second hangs — charged for the cheap half
   * and nothing for the expensive one.
   */
  dispatched: number;
  /** What each provider that ANSWERED reported. */
  observed: AiCallUsage[];
}

/**
 * Tokens charged for ONE image, when the provider reported no usage and we
 * have to estimate. Deliberately above the real figures (~1,100 on a
 * gpt-4o-mini-class model for 1024x1024, ~1,290 on Gemini for a large image):
 * the estimate's whole claim is that it errs expensive, and counting only the
 * prompt's characters made it err ~90% CHEAP on exactly the vision calls that
 * are most likely to need it.
 */
const ESTIMATED_TOKENS_PER_IMAGE = 1_400;

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
export function localeName(code: string): string {
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
 * A managed AI call was REFUSED before it was made — no consent, no budget,
 * the kill switch, or a credential this deployment cannot serve.
 *
 * Its own class, and thrown rather than returned, for one reason: it has to be
 * TELLABLE APART from "the AI could not deliver this text". A detached repair
 * turns the latter into `translationsRemove` plus a local delete, so a refusal
 * mistaken for a failure deletes storefront translations because our prepaid
 * budget ran out — unrecoverably, since the digest baseline has already moved
 * (PLAN_MANAGED_AI_KEY §6a rule 1, §3a rule 5). Every caller that purges on
 * failure must check `isManagedRefusal` and ABORT instead.
 */
export class ManagedAiRefusedError extends Error {
  readonly code = 'MANAGED_AI_REFUSED' as const;
  /** "consentMissing" | "budgetExceeded" | "managedUnavailable". */
  readonly reason: string;
  readonly usedMicros?: number;
  readonly limitMicros?: number;

  constructor(reason: string, detail?: { usedMicros?: number; limitMicros?: number }) {
    super(`Managed AI refused: ${reason}`);
    this.name = 'ManagedAiRefusedError';
    this.reason = reason;
    this.usedMicros = detail?.usedMicros;
    this.limitMicros = detail?.limitMicros;
  }
}

/**
 * Is this error a managed refusal? Checked by INSTANCE and by CODE: the error
 * crosses a dynamic-import boundary on some paths, where two copies of the
 * class can exist and `instanceof` quietly answers false — which here means a
 * purge instead of an abort.
 */
export function isManagedRefusal(error: unknown): error is ManagedAiRefusedError {
  if (error instanceof ManagedAiRefusedError) return true;
  return (error as { code?: string } | null)?.code === 'MANAGED_AI_REFUSED';
}

/**
 * Thrown when an AI call is attempted but no usable key is available for the
 * selected provider.
 *
 * **The compliance statement this used to carry has changed, and saying so is
 * the point.** It read: merchant content must NEVER go to an AI provider
 * through an operator-owned key, each shop must use its own. That was this
 * app's own reading of the Shopify PPA / API Terms, written to justify the
 * BYO-only design — and the audit it cites (§B4) in fact names TWO acceptable
 * fixes, of which enforced BYO is the first. The app now also implements the
 * second: an operator key behind an explicit, logged, versioned in-app consent
 * gate (PLAN_MANAGED_AI_KEY §2).
 *
 * What that does NOT change is where a credential may come from. This class,
 * and `initializeProvider` below, still read no environment variable: the key
 * is injected by `app/services/ai/ai-credentials.server.ts`, the single module
 * that reads the operator credential AND enforces consent, the kill switch and
 * the budget. A key obtainable only together with its gate cannot be obtained
 * past it — which is the guarantee in the only form that survives review.
 *
 * So this error still means what it always meant: no usable key, block the
 * call, on every path including background tasks. It is NOT the error a
 * managed refusal produces — see `ManagedAiRefusedError`, and the reason the
 * two must stay distinguishable.
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
  /**
   * Whose key this instance is spending — the meter's `source` column
   * (PLAN_MANAGED_AI_KEY §4.4). Absent means the merchant's own key, which is
   * what every construction site resolves to until a managed subscription
   * exists; the resolver sets it, and Phase 2 makes it required once there is
   * something other than "byo" for it to be.
   */
  credentialSource?: AiCredentialSource;
  /**
   * Asked before EVERY provider call, and only installed for managed ones.
   *
   * The decision has to live per REQUEST rather than per service instance: a
   * bulk run holds one instance for hundreds of calls, and a budget checked
   * once at construction is a budget checked before the spend it is supposed
   * to bound. The HTTP gates are the early, friendly copy of this; the heaviest
   * consumers in this app never pass one (§6a).
   *
   * It is a CALLBACK rather than a lookup in here because `ai.service.ts` must
   * never learn that `process.env` exists — the whole compliance guarantee is
   * that the operator credential has one reader, and this is the seam through
   * which that reader keeps answering (and, when the failover ships, through
   * which it can answer with a different credential).
   */
  preflight?: () => Promise<
    { ok: true } | { ok: false; reason: string; usedMicros?: number; limitMicros?: number }
  >;
  /**
   * This instance was REFUSED managed AI before it was built — the reason, for
   * the error every call on it throws.
   *
   * It exists because refusing at CONSTRUCTION is not an option and refusing
   * only at call time was not enough. The resolver used to answer a managed
   * refusal with a keyless config, which made `initializeProvider` throw
   * `MissingAIKeyError` — a different error, meaning a different thing, and
   * the detached repair's purge path does not recognise it. A budget that ran
   * out would then have deleted the merchant's storefront translations through
   * a door the abort rule never covered, because the throw happens before any
   * call the rule guards.
   *
   * So the service CONSTRUCTS (no provider client, no key anywhere near it)
   * and every call on it refuses with the one error type that means "stand
   * down", whichever of the eleven paths built it and whether it built eagerly
   * or lazily.
   */
  managedRefusal?: string;
  /**
   * The ledger PERIOD a managed call is counted in — the shop's BILLING
   * period, not the calendar month (§7 rule 3).
   *
   * It has to travel with the credential because the meter and the budget must
   * key on the same string: written under `m:2026-09` and read back under
   * `b:2026-10-14`, the used figure is always zero and the cap never fires. The
   * resolver computes it (it is the only thing that has the subscription's
   * mirrored period end) and BYO leaves it unset, which keeps the calendar
   * month for traffic nobody caps.
   */
  usagePeriod?: string;
  /**
   * Which GLOBAL pool a managed call draws from (§9.3). Set by the resolver
   * beside the period, for the same reason: the meter must record against the
   * pool the preflight checked, or the cap is measured over a different number
   * than it enforces.
   */
  usagePool?: 'paid' | 'taster';
  /**
   * Swap this instance onto the OTHER managed credential — §3a rule 8.
   *
   * Where the switch lives is decided by three mechanics, not by taste.
   * `isInputTooLongError` is a private static and `executeAIRequest` REPLACES
   * that error with a merchant-facing sentence before any caller sees it, so
   * above this method the exclusion could only be applied by string-matching a
   * UI message. `askAI` latches the first auth failure and fails every later
   * call fast, so a 401 handled above it never arrives. And the queue
   * re-enqueues the same closure, which captures this instance and therefore
   * its provider, so the switch cannot live there either.
   *
   * It is a CALLBACK because `ai.service.ts` must never read `process.env`:
   * the resolver is the one module that holds the operator credential, and
   * this is how it hands over the second one without that changing.
   *
   * Returns the new `(provider, config)` pair, or null when no fallback is
   * configured — in which case the original error stands.
   */
  switchToFailover?: () => Promise<{ provider: AIProvider; config: AIServiceConfig } | null>;
  /**
   * This instance is running on the FALLBACK credential — §3a rules 1 and 3.
   *
   * It changes what the ledger records, not what the merchant is charged: the
   * budget is debited at the DEFAULT model's price whatever ran, because an
   * outage must not shrink what the merchant bought. The gap is what we
   * absorb, and it is the number the failover pool is measured against.
   */
  failoverServed?: boolean;
  /**
   * The DEFAULT managed model's id, carried onto a failover instance so the
   * meter can price the merchant's side at it (§3a rule 1). Absent on every
   * non-failover call, where the model that ran IS the model billed.
   */
  defaultModelForBilling?: string;
  /** The default credential's provider, when the failover crossed providers. */
  defaultProviderForBilling?: AIProvider;
}

/**
 * Options for {@link AIService.translateFieldsToLocalesBatch} and its chunking
 * wrapper — the LONG half of a translate-all run.
 *
 * `customInstructions` and `keywordDirectiveFor` are not decoration: they are
 * the merchant's own translate instructions, the seo_optimized length caps
 * (`buildTranslateInstructions`) and the keyword-aware clause. The per-locale
 * path this batch replaced passed both, so a batch that did not would have
 * silently switched them off for every description, body, excerpt and meta
 * description the moment it started working — exactly the asymmetry
 * `translateShortFieldsBatch` was fixed for in the other direction, where a
 * title ignored a cap its own description respected.
 *
 * The keyword clause is a BUILDER rather than a string because the chunking
 * wrapper splits by locale: a chunk must carry the clauses for the languages it
 * actually translates and no others, or the prompt names a language the answer
 * cannot contain.
 */
export interface TranslateFieldsToLocalesOptions {
  preserveHtml?: boolean;
  contextLabel?: string;
  customInstructions?: string;
  keywordDirectiveFor?: (locales: string[]) => string | undefined;
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
  /** The ledger's `feature` dimension for this instance — see resolveFeature. */
  private featurePromise?: Promise<string>;

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
    // Compliance backstop: this function never reads an environment variable.
    // The key it uses is the merchant's own, or — where the shop bought the
    // managed option, consented, and the deployment has it configured — the
    // operator's, INJECTED by `ai-credentials.server.ts`, which is the one
    // module that reads that credential and the one that gates it on consent,
    // the kill switch and the budget (PLAN_MANAGED_AI_KEY §2, §5). An empty
    // key blocks the call for EVERY AIService consumer, including background
    // tasks.
    if (this.config.managedRefusal) {
      // Managed AI was refused for this shop. Build NOTHING: no client, no key.
      // Every call on this instance throws ManagedAiRefusedError, which the
      // detached repair recognises as "stand down" rather than as a
      // translation the AI could not deliver — the difference between a stale
      // row kept and a storefront translation deleted.
      return;
    }
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
    toLang: string,
    /**
     * The merchant's translate instructions plus the seo_optimized caps and the
     * keyword clause, joined by the caller. OPTIONAL and absent by default, so
     * every existing call site is byte-identical — it exists for the ONE branch
     * that reaches this from a batched run: `translateFieldsToLocalesChunked`
     * sends a field too large to batch through here per locale, and without it
     * a 30 000-character body would be the one field of a translate-all run
     * that silently ignored the merchant's instructions.
     */
    instructions?: string,
    /**
     * WHICH field the text is, and it is required in practice whenever
     * `instructions` is passed.
     *
     * The seo_optimized block inside those instructions is a list of per-field
     * caps (`- seoTitle: maximum 60 characters — paraphrase to fit`,
     * `- metaDescription: 120-160 characters`), and a body only ever reaches
     * this branch because it is enormous. Handed an UNLABELLED wall of text
     * together with those lines, the model is invited to condense it to sixty
     * characters — and the result would be echo-verified and mirrored as the
     * translation. The batch prompt solves the same problem with its
     * `### <key>` headers; this is that, for one field.
     */
    fieldLabel?: string
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

    const prompt = `Translate the following ${fieldLabel ? `"${fieldLabel}" field` : 'text'} from ${fromLang} to ${toLang}. Keep HTML tags.
${fieldLabel ? `\nAny instruction below that names a DIFFERENT field does not apply to this text.\n` : ''}
Text: ${sanitizedContent}
${instructions ? `\n${instructions}\n` : ''}
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
    contentType: string = 'product',
    /**
     * Merchant translate-instructions (incl. the SEO-mode length caps). The
     * caller has always passed these; the parameter simply did not exist, so
     * they were silently dropped for short fields while long fields honoured
     * them — a title could ignore a cap its own description respected.
     */
    customInstructions?: string,
    /** Keyword-aware translation clause — one line per target language. */
    keywordDirective?: string
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
${customInstructions ? `\n${customInstructions}\n` : ''}
${keywordDirective ? `\n${keywordDirective}\n` : ''}
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
    context: string = "product content",
    /**
     * The merchant's translate instructions (plus the seo_optimized caps where
     * the caller built them). OPTIONAL and absent by default, so every existing
     * call site is byte-identical — but every value path SHOULD pass it: a
     * metafield, an option value and a metaobject field are merchant content
     * like a title is, and the instruction that says "keep our brand names in
     * English" has no reason to hold for the title and not for the swatch name.
     */
    instructions?: string
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
${instructions ? `\n${instructions}\n` : ''}
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
   * `translateBatchValues` for MANY target languages — the value-shaped half of
   * the hybrid batching, and the counterpart of
   * {@link translateFieldsToLocalesChunked} for text that has no field name.
   *
   * What goes through here: a metafield's `value`, a product option's `name` and
   * its values, a metaobject field, a storefront UI string. None of them has a
   * named field to hang the merchant's per-field instructions or an SEO limit
   * on, which is what separates them from the field paths — but they were also
   * the last paths translating ONE LANGUAGE PER REQUEST, because the older
   * method's signature takes a single `toLang`. A product with sixty metafields
   * on an eight-language shop paid eight requests where the same edit to its
   * title paid one.
   *
   * Three rules, each the reason a simpler version of this would be wrong.
   *
   * The answer is mapped back by **INDEX**, never by value: two option values
   * may legitimately hold the same text ("Blau", "Blau"), and a value-keyed map
   * would collapse them into one write. So the prompt numbers the values and the
   * assertion below is on LENGTH — a short answer shifts every later entry's
   * meaning, which is silent corruption rather than a missing translation.
   *
   * It chunks on **both dimensions**, through the same planner the field path
   * uses: the values are cut into groups whose own output fits one locale, and
   * each group's locales into as many per request as the budget allows. Sixty
   * short metafields into eight languages is a handful of requests; one 3 000-
   * character multi-line value into eight is one per language. Neither case
   * needs a branch at the call site.
   *
   * And a FAILED chunk costs only its own cells. Every caller of the older
   * method treats a missing value as "not translated" and falls back to its own
   * answer (a removal, or the merchant's stored deletion choice), so throwing
   * the whole run over one refused chunk would discard the ninety values that
   * did come back. The per-locale map is returned with the gaps in it.
   */
  async translateBatchValuesToLocales(
    values: string[],
    fromLang: string,
    targetLocales: string[],
    context: string = 'product content',
    options: { instructions?: string } = {},
  ): Promise<Record<string, string[]>> {
    if (values.length === 0 || targetLocales.length === 0) return {};

    // One locale is the older method verbatim — same prompt, same recovery path,
    // same 1:1 assertion. Delegating rather than re-deriving keeps the single
    // -locale behaviour (which several callers still depend on) from drifting
    // away from the batched one.
    if (targetLocales.length === 1) {
      const translated = await this.translateBatchValues(
        values,
        fromLang,
        targetLocales[0],
        context,
        options.instructions,
      );
      return { [targetLocales[0]]: translated };
    }

    const perLocaleBudget = perLocaleSourceBudgetChars();
    // Value groups whose own output fits ONE locale, AND that stay under the
    // item cap. Both limits, because they fail differently: characters decide
    // whether the answer gets truncated, while the COUNT decides whether the
    // model keeps the numbering straight — sixty short metafield values are
    // nothing in characters and exactly the list that comes back merged or
    // renumbered, which the strict length assertion then rejects whole.
    // A single value larger than the character budget becomes its own group and
    // is still sent: it is one string, the provider errors loudly if it truly
    // overflows, and splitting a value would change what it means.
    const groups: { values: string[]; start: number }[] = [];
    let current: string[] = [];
    let currentChars = 0;
    let start = 0;
    for (const [index, value] of values.entries()) {
      const length = value.length;
      const full =
        current.length > 0 &&
        (currentChars + length > perLocaleBudget ||
          current.length >= TRANSLATION_BATCH.VALUE_BATCH_MAX_ITEMS);
      if (full) {
        groups.push({ values: current, start });
        current = [];
        currentChars = 0;
        start = index;
      }
      current.push(value);
      currentChars += length;
    }
    if (current.length > 0) groups.push({ values: current, start });

    type Job = () => Promise<{ locale: string; start: number; translated: string[] }[]>;
    const jobs: Job[] = [];
    for (const group of groups) {
      const groupChars = group.values.reduce((a, v) => a + v.length, 0);
      for (const localeChunk of planLocaleChunks(targetLocales, groupChars)) {
        jobs.push(async () => {
          const partial = await this.translateValuesToLocaleChunk(
            group.values,
            fromLang,
            localeChunk,
            context,
            options.instructions,
          );
          return localeChunk
            .filter((locale) => partial[locale])
            .map((locale) => ({ locale, start: group.start, translated: partial[locale] }));
        });
      }
    }

    loggers.ai('info', '[AI-SERVICE] translateBatchValuesToLocales', {
      values: values.length,
      locales: targetLocales.length,
      chunks: jobs.length,
      fromLang,
    });

    // Pre-sized with "" so a chunk that failed leaves EMPTY entries at its own
    // indices instead of shifting the ones that succeeded — the index mapping is
    // the contract, and a compacted array would silently re-point every later
    // value at the wrong resource.
    const result: Record<string, string[]> = {};
    for (const locale of targetLocales) result[locale] = values.map(() => '');

    const errors: unknown[] = [];
    let succeeded = 0;
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < jobs.length) {
        const index = cursor++;
        try {
          for (const part of await jobs[index]()) {
            for (const [offset, value] of part.translated.entries()) {
              result[part.locale][part.start + offset] = value;
            }
          }
          succeeded++;
        } catch (error) {
          errors.push(error);
          loggers.ai('error', '[AI-SERVICE] translateBatchValuesToLocales: chunk failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(TRANSLATION_BATCH.MAX_CONCURRENCY, jobs.length) }, () => worker()),
    );

    // A managed refusal aborts regardless of how many siblings succeeded — see
    // the same rule in `translateFieldsToLocalesChunked`.
    const refusal = errors.find((e) => isManagedRefusal(e));
    if (refusal) throw refusal;

    // Every chunk failed → throw, so the caller's own fallback runs instead of
    // being handed a map of empty strings that looks like "the AI translated
    // nothing on purpose". An auth error is the first one, which is what makes a
    // rejected API key abort the run rather than emptying it.
    if (succeeded === 0 && errors.length > 0) throw errors[0];

    return result;
  }

  /**
   * One request: N numbered values × M locales, `{locale: [translated…]}`.
   *
   * The multi-locale sibling of `translateBatchValues`' prompt. Kept private
   * because the chunking above is not optional — callers go through
   * `translateBatchValuesToLocales`, which decides how many of each fit.
   */
  private async translateValuesToLocaleChunk(
    values: string[],
    fromLang: string,
    targetLocales: string[],
    context: string,
    instructions?: string,
  ): Promise<Record<string, string[]>> {
    const isAuto = fromLang === 'auto';
    const numberedValues = values
      .map((v, i) => `${i + 1}. ${sanitizePromptInput(v, { maxLength: 2000, allowNewlines: false })}`)
      .join('\n');
    const targetLanguages = targetLocales.map((loc) => `${localeName(loc)} (${loc})`).join(', ');

    const sourceClause = isAuto
      ? `For each ${context} value below, detect its source language and translate it into EACH of these languages: ${targetLanguages}. Where a value is already written in a target language, repeat it UNCHANGED for that language.`
      : `Translate these ${context} values from ${localeName(fromLang)} into EACH of these languages: ${targetLanguages}.`;

    const glossaryDirective = await this.getGlossaryDirective(values, targetLocales);

    // The skeleton is spelled out with the real locale codes and the real
    // number of slots, which is what makes the length assertion below something
    // the model was actually told to satisfy.
    const jsonStructure = Object.fromEntries(
      targetLocales.map((locale) => [locale, values.map((_, i) => `translated ${i + 1}`)]),
    );

    const prompt = `${sourceClause}

${numberedValues}

Requirements:
- Answer with EVERY language, and with exactly ${values.length} value(s) per language, in the SAME ORDER as the numbered list above.
- Keep translations concise and natural, and maintain similar character length.
- Two values may legitimately be identical; translate both, do not merge them.
- Inside translated strings, escape any straight double-quote as \\" so the JSON stays valid.
${instructions ? `\n${instructions}\n` : ''}
${glossaryDirective ? `\n${glossaryDirective}\n` : ''}
Respond with ONLY this JSON shape (keys = locale codes, each an array of translated strings):
${JSON.stringify(jsonStructure, null, 2)}`;

    const responseText = await this.askAI(prompt);

    let parsed: Record<string, unknown>;
    try {
      parsed = this.parseJSONResponse(responseText) as Record<string, unknown>;
    } catch (parseError: unknown) {
      // The single-locale prompt has `recoverMalformedStringArray` for exactly
      // this, because merchant values carry straight double quotes and the model
      // does not always escape them. That recovery reads a FLAT array and cannot
      // read this shape, so the chunk degrades to the path that has it: one call
      // per locale, with its parser, its recovery and its 1:1 assertion. It costs
      // requests only where the batched answer was unusable, and a locale that
      // fails there fails alone.
      loggers.ai('warn', '[AI-SERVICE] Multi-locale value batch did not parse — retrying per locale', {
        locales: targetLocales.length,
        values: values.length,
        error: parseError instanceof Error ? parseError.message : String(parseError),
      });
      const recovered: Record<string, string[]> = {};
      for (const locale of targetLocales) {
        try {
          recovered[locale] = await this.translateBatchValues(values, fromLang, locale, context, instructions);
        } catch (localeError: unknown) {
          if (isAuthError(localeError)) throw localeError;
          loggers.ai('error', '[AI-SERVICE] Per-locale value retry failed', { locale });
        }
      }
      if (Object.keys(recovered).length === 0) throw parseError;
      return recovered;
    }

    // A locale whose array came back the wrong LENGTH is dropped ALONE. Its
    // entries then read as untranslated and every caller falls back to its own
    // answer for them — while throwing here would have discarded the languages
    // that were perfectly well formed in the same response, which is worse than
    // what the per-locale calls this replaced ever did (there, one bad answer
    // cost one language). The length itself is non-negotiable: a short array
    // re-points every later value at the wrong resource.
    const out: Record<string, string[]> = {};
    for (const locale of targetLocales) {
      const list = parsed?.[locale];
      if (!Array.isArray(list) || list.length !== values.length) {
        // Length, never content, in the log: these are merchant values and
        // possibly PII, and the length is the whole diagnosis (R3-M10).
        loggers.ai('error', '[AI-SERVICE] translateBatchValuesToLocales: bad shape for locale', {
          locale,
          expected: values.length,
          got: Array.isArray(list) ? list.length : null,
        });
        continue;
      }
      out[locale] = list.map(String);
    }
    // Nothing usable at all IS the chunk's failure — the caller's own fallback
    // has to run rather than be handed an empty map that looks deliberate.
    if (Object.keys(out).length === 0) {
      throw new Error(
        `AI value batch returned no usable locale for ${values.length} value(s)`,
      );
    }
    return out;
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
    customInstructions?: string,
    /**
     * Keyword-aware translation clause (keyword-translation-prompt.ts). Kept
     * SEPARATE from customInstructions so the merchant's own instructions are
     * never overwritten by it — and so passing one still leaves the default
     * instructions in place when there are no custom ones.
     */
    keywordDirective?: string
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
${keywordDirective ? `\n${keywordDirective}\n` : ''}
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
    options: TranslateFieldsToLocalesOptions = {}
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

    // The merchant's own translate instructions and the SEO length caps
    // (buildTranslateInstructions), plus the keyword clause. Both are per-CALL
    // and the keyword one is built for THIS chunk's locales only — a clause
    // naming a language the chunk does not translate is an instruction about
    // nothing. Kept apart from the requirements list for the same reason
    // translateFields keeps them apart: the merchant's text must never
    // overwrite the rules this prompt depends on (the HTML rule above is what
    // makes a body survive).
    const keywordDirective = options.keywordDirectiveFor?.(targetLocales) || '';

    const prompt = `Translate the following ${contextLabel} fields from ${localeName(fromLang)} to: ${targetLanguages}.

Each field is introduced by a "### <key>" header followed by its source text.

${fieldsText}

Requirements:
- Translate EVERY field into EVERY target language.
- Keep the translation natural and faithful to the source meaning.
- Maintain a similar length to the source.${htmlRule}
- Do NOT add explanations or extra fields.
${options.customInstructions ? `\n${options.customInstructions}\n` : ''}
${keywordDirective ? `\n${keywordDirective}\n` : ''}
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
    options: TranslateFieldsToLocalesOptions = {}
  ): Promise<Record<string, Record<string, string>>> {
    const entries = Object.entries(fields).filter(([, v]) => v && v.trim().length > 0);
    if (entries.length === 0 || targetLocales.length === 0) return {};

    const { MAX_CONCURRENCY } = TRANSLATION_BATCH;
    const sourceChars = entries.reduce((a, [, v]) => a + v.length, 0);
    const estimatedOutput = estimateOutputChars(sourceChars, targetLocales.length);

    // Fast path: the whole payload fits in one call. THE hybrid decision, and it
    // is a product of both dimensions — a 6 000-character body is one call on a
    // two-language shop and eight calls' worth of output on an eight-language
    // one, which is why the locale count is in the estimate and not only the
    // text length.
    if (fitsOneRequest(sourceChars, targetLocales.length)) {
      loggers.ai('info', '[AI-SERVICE] translateFieldsToLocalesChunked: single batch', {
        fields: entries.length,
        locales: targetLocales.length,
        chunks: 1,
        estimatedOutput,
      });
      return this.translateFieldsToLocalesBatch(fields, fromLang, targetLocales, options);
    }

    // Source-char budget that keeps ONE locale's output under the threshold.
    const perLocaleBudget = perLocaleSourceBudgetChars();
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
            // Same instructions the batched branch below gets — this is still
            // one field of the SAME run, and the only thing that makes it take
            // this path is its size.
            const translated = await this.translateContent(
              src,
              fromLang,
              locale,
              [options.customInstructions, options.keywordDirectiveFor?.([locale])]
                .filter((part): part is string => !!part && part.trim() !== '')
                .join('\n') || undefined,
              key,
            );
            return { [locale]: { [key]: translated } };
          });
        }
        continue;
      }

      const groupFields: Record<string, string> = {};
      for (const k of group) groupFields[k] = byKey.get(k) || '';

      // The middle of the hybrid: however many languages of THIS field group fit
      // one response — every language for a short group, one per request for a
      // long one, two or three for the medium text on a many-language shop that
      // used to truncate silently.
      for (const localeChunk of planLocaleChunks(targetLocales, groupChars)) {
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

    // A managed REFUSAL is not a chunk that failed — it is the whole operation
    // standing down, and it has to leave here as a throw whether or not a
    // sibling chunk succeeded. Otherwise its cells come back empty, which every
    // caller reads as "the AI could not deliver" — and on the repair path that
    // answer is a deletion (§6a rule 1). The repair happened to abort anyway,
    // through two unrelated completeness checks agreeing by coincidence; a
    // defence by coincidence is not one.
    const refusal = errors.find((e) => isManagedRefusal(e));
    if (refusal) throw refusal;

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
    const outputTokens = TRANSLATION_BATCH.AI_MAX_OUTPUT_TOKENS;
    return inputTokens + outputTokens;
  }

  /**
   * `imageUrls` rather than one `imageUrl`: how many images a generation may
   * carry is a merchant setting now (AISettings.aiImagesPerRequest), and the
   * handlers have already clamped the list by the time it gets here. An empty
   * or absent list is the text-only path, byte-identical to what it was.
   */
  private async askAI(prompt: string, imageUrls?: string[]): Promise<string> {
    // Circuit breaker: a previous call on this instance already saw the
    // provider reject the key — fail fast instead of firing more 401s.
    if (this.authError) throw this.authError;

    // Save prompt to database if taskId is provided
    if (this.taskId && this.shop) {
      await this.savePromptToTask(prompt, imageUrls);
    }

    let response: string;

    try {
      // If no shop/taskId provided, execute directly (backward compatibility)
      if (!this.shop || !this.taskId) {
        response = await this.executeAIRequest(prompt, imageUrls);
      } else {
        // Use queue for rate-limited execution
        const estimatedTokens = this.estimateTokens(prompt);

        response = await this.queue.enqueue(
          this.shop,
          this.taskId,
          this.provider,
          estimatedTokens,
          () => this.executeAIRequest(prompt, imageUrls),
          // Which rate-limit bucket this call is admitted against (§9.1). It
          // travels at ENQUEUE time because `execute` is an opaque closure:
          // by the time it runs there is nothing left to ask.
          this.config.credentialSource === 'managed' ? 'managed' : 'byo'
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

  private async savePromptToTask(prompt: string, imageUrls?: string[]): Promise<void> {
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

      // Add image indicator to prompt if images are included. The COUNT is
      // named as well as the URLs: the task log is where a merchant asks why a
      // generation cost what it did, and "three images" is the answer.
      let fullPrompt = prompt;
      if (imageUrls && imageUrls.length > 0) {
        const label = imageUrls.length === 1 ? "Image attached" : `${imageUrls.length} images attached`;
        fullPrompt = `[📷 ${label}: ${imageUrls.join(", ")}]\n\n${prompt}`;
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

  /**
   * THE meter's charge point, and deliberately not `askAI`: `replayRequest`
   * (task recovery) calls this method directly, past the queue and past
   * anything askAI would carry, so a meter one level up would silently miss
   * every recovered task.
   *
   * Everything the inner call REPORTED is charged in a `finally`, so a
   * provider answer that we then reject is still paid for. Two things that
   * follows from, both of which were holes:
   *
   * - A call that loses the timeout race is charged at its WORST CASE, never
   *   at zero. `Promise.race` does not cancel the loser: the provider finishes
   *   generating and bills us, and the calls that time out are the longest and
   *   most expensive ones, so metering them at zero biased the under-count
   *   towards exactly the wrong end. The worst case is the prompt's estimate in
   *   and `max_tokens` out — what the call COULD have produced.
   * - Nothing is charged for a call that never reached a provider (a
   *   connection error, an invalid key, a dropped image fetch): `observed` is
   *   empty and there is no timeout to substitute a worst case for.
   *
   * What it still cannot see, stated rather than hidden: the provider SDKs
   * retry internally (`AI_SDK_MAX_RETRIES`), so one logical call can be up to
   * three HTTP attempts. A failed attempt generates no tokens and is normally
   * not billed, which is why this is a stated residual and not a correction.
   */
  private async executeAIRequest(prompt: string, imageUrls?: string[]): Promise<string> {
    // A refusal decided at BUILD time (no consent, kill switch, a credential
    // this deployment cannot serve) fails every call on this instance, and
    // fails it as a refusal rather than as a missing key.
    if (this.config.managedRefusal) {
      throw new ManagedAiRefusedError(this.config.managedRefusal);
    }

    // BEFORE the timer and before the queue slot does any work: a refused call
    // must cost nothing at all, and a refusal thrown from inside the race
    // would be charged a worst case by the timeout branch below.
    if (this.config.preflight) {
      const verdict = await this.config.preflight();
      if (!verdict.ok) {
        throw new ManagedAiRefusedError(verdict.reason, {
          usedMicros: verdict.usedMicros,
          limitMicros: verdict.limitMicros,
        });
      }
    }

    let timer: NodeJS.Timeout | undefined;
    const meter: AiCallMeter = { dispatched: 0, observed: [] };
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
      try {
        return await Promise.race([
          this._executeAIRequestInner(prompt, imageUrls, meter),
          timeoutPromise,
        ]);
      } catch (firstError) {
        // §3a — the failover. HERE, below askAI's auth latch and BEFORE the
        // input-too-long replacement below, which is the only place both are
        // still true.
        const retried = await this.tryFailover(firstError, prompt, imageUrls, meter);
        if (retried !== null) return retried;
        throw firstError;
      }
    } catch (error) {
      if (error instanceof AIRequestTimeoutError && meter.dispatched > meter.observed.length) {
        // A call was still generating when the clock ran out. Charged at its
        // worst case per dispatch that never answered, not merely when NOTHING
        // answered: Gemini's vision fallback can have a cheap first answer and
        // an expensive second call still in flight.
        for (let i = meter.observed.length; i < meter.dispatched; i++) {
          meter.observed.push(this.worstCaseUsage(prompt, imageUrls?.length ?? 0));
        }
      }
      if (AIService.isInputTooLongError(error)) {
        throw new Error(AIService.INPUT_TOO_LONG_MESSAGE);
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      // AWAITED rather than fired off: one upsert against a call that took
      // seconds is not worth measuring, while a detached write is one the
      // process can be killed out from under — and an under-counted ledger is
      // what a budget would later be enforced against. `recordUsage` never
      // throws, so this cannot turn a successful generation into a failed one,
      // nor replace the error a failed one is about to throw.
      for (const usage of meter.observed) {
        // Guarded here as well as inside `recordUsage`: this loop runs in a
        // `finally` that may be unwinding an error, and anything thrown from
        // it — including from the logger in that method's own catch — would
        // REPLACE the error the caller is about to see with a bookkeeping one.
        try {
          await this.recordUsage(usage);
        } catch {
          // Deliberately silent: the one thing left that could report this is
          // the logger that just failed.
        }
      }
    }
  }

  /**
   * Try the OTHER managed provider, or answer null to let the original error
   * stand — §3a.
   *
   * Never throws: a failure here must leave the caller with the FIRST error,
   * which is the one that describes what actually happened. It returns null
   * for every reason not to fail over, and the reasons are as important as
   * the mechanism:
   *
   * - not a managed call (a merchant's own key is not ours to reroute),
   * - no fallback configured,
   * - the error is one the second provider answers identically (§3a rule 7),
   * - the breaker is open on the fallback too,
   * - this SHOP has used up its failover allowance (rule 2).
   */
  private async tryFailover(
    error: unknown,
    prompt: string,
    imageUrls: string[] | undefined,
    meter: AiCallMeter,
  ): Promise<string | null> {
    if (this.config.credentialSource !== 'managed' || !this.config.switchToFailover) return null;
    // A refusal is not a provider failure — it is us declining, and retrying
    // it on the other account would spend the operator's money on a call that
    // was never allowed.
    if (isManagedRefusal(error)) return null;

    try {
      const { classifyFailover, statusOf } = await import(
        '../../app/services/ai/managed-failover.shared'
      );
      const verdict = classifyFailover({
        status: statusOf(error),
        message: error instanceof Error ? error.message : String(error),
        // The queue retries a rate limit by re-enqueueing the same closure, so
        // by the time an error reaches here that path is already spent.
        rateLimitRetriesExhausted: true,
      });
      if (!verdict.failOver) return null;

      const { breakerAllows, recordBreakerOutcome, shopFailoverExhausted } = await import(
        '../../app/services/ai/managed-failover.server'
      );
      recordBreakerOutcome(this.provider, false);

      if (this.shop && this.config.usagePeriod) {
        if (await shopFailoverExhausted(this.shop, this.config.usagePeriod)) {
          loggers.ai('warn', '[AI-SERVICE] Failover ceiling reached for this shop', {
            shop: this.shop,
          });
          return null;
        }
      }

      const swapped = await this.config.switchToFailover();
      if (!swapped) return null;
      if (!breakerAllows(swapped.provider).allow) return null;

      loggers.ai('warn', '[AI-SERVICE] Managed failover', {
        shop: this.shop,
        from: this.provider,
        to: swapped.provider,
        reason: verdict.reason,
      });

      // Re-initialise onto the other credential. `initializeProvider` builds
      // exactly one client from `this.provider`, so both have to move.
      this.provider = swapped.provider;
      this.config = { ...swapped.config, failoverServed: true };
      this.initializeProvider();

      const text = await this._executeAIRequestInner(prompt, imageUrls, meter);
      recordBreakerOutcome(swapped.provider, true);
      return text;
    } catch (failoverError) {
      // The fallback failed too. The caller gets the FIRST error, which
      // describes the outage rather than our reaction to it.
      loggers.ai('error', '[AI-SERVICE] Failover attempt failed', {
        shop: this.shop,
        error: failoverError instanceof Error ? failoverError.message : String(failoverError),
      });
      return null;
    }
  }

  /**
   * What a call that never came back might have cost: the prompt (plus its
   * images) in, and the output ceiling every provider here is configured with
   * out. Flagged as an estimate like any other counted call.
   */
  private worstCaseUsage(prompt: string, imageCount: number): AiCallUsage {
    return {
      inputTokens:
        AIService.estimateTokensFor(prompt) + imageCount * ESTIMATED_TOKENS_PER_IMAGE,
      outputTokens: TRANSLATION_BATCH.AI_MAX_OUTPUT_TOKENS,
      model: this.getModel(),
      source: 'estimate',
    };
  }

  /**
   * Hand one completed call to the meter (PLAN_MANAGED_AI_KEY §4).
   *
   * Two guards, both deliberate. Without a `shop` there is nothing to meter
   * against — unit tests and ad-hoc usage construct an AIService with no shop,
   * the same condition `loadGlossaryRules` short-circuits on. And the whole
   * body is wrapped: the generation has already succeeded by the time this
   * runs, so a bookkeeping failure must never reach the caller, who would
   * surface it as a failed save and invite a retry that pays for the same
   * tokens twice.
   */
  private async recordUsage(usage: AiCallUsage): Promise<void> {
    if (!this.shop) return;
    try {
      // Dynamic import for the same reason savePromptToTask uses one: it keeps
      // db.server out of this module's static graph.
      const { recordAiUsage } = await import('../../app/services/ai/usage-meter.server');
      await recordAiUsage({
        shop: this.shop,
        provider: this.provider,
        model: usage.model,
        feature: await this.resolveFeature(),
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        // Not a default so much as a fact: no managed credential exists in the
        // app yet, so every construction site today really is spending the
        // merchant's own key. Phase 1 introduces the resolver that sets this,
        // and makes the field REQUIRED in the same change — at that point an
        // unset field is a bug, and a default would hide it.
        source: this.config.credentialSource ?? 'byo',
        estimated: usage.source === 'estimate',
        failover: this.config.failoverServed === true,
        // §3a rule 1: the merchant is billed at the DEFAULT model's price
        // whatever ran. An outage they did not cause and cannot see must not
        // make their volume evaporate at 14x speed — we carry the difference,
        // and the ledger keeps both numbers so "what did the outage cost us"
        // stays answerable.
        ...(this.config.failoverServed && this.config.defaultModelForBilling
          ? {
              billedModel: this.config.defaultModelForBilling,
              ...(this.config.defaultProviderForBilling
                ? { billedProvider: this.config.defaultProviderForBilling }
                : {}),
            }
          : {}),
        taskId: this.taskId,
        ...(this.config.usagePeriod ? { period: this.config.usagePeriod } : {}),
        ...(this.config.usagePool ? { pool: this.config.usagePool } : {}),
      });
    } catch (error) {
      loggers.ai('error', '[AI-SERVICE] Failed to record AI usage', {
        shop: this.shop,
        provider: this.provider,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Which FEATURE this instance's calls belong to — `Task.type`, the
   * vocabulary the app already uses (bulkTranslation, aiGeneration,
   * seoBulkMeta, bulkEditorTranslate, …), or `ADHOC_FEATURE` for an
   * interactive call that has no task.
   *
   * Read ONCE per instance, not per call: one AIService is one task, and a
   * bulk run makes hundreds of calls. Memoised on the instance exactly like
   * `glossaryRulesPromise`, and a failed lookup answers `adhoc` rather than
   * throwing — the dimension is worth having and never worth a failed save.
   */
  private resolveFeature(): Promise<string> {
    if (!this.taskId) return Promise.resolve(ADHOC_FEATURE);
    if (!this.featurePromise) {
      const taskId = this.taskId;
      this.featurePromise = (async () => {
        try {
          const { db } = await import('../../app/db.server');
          const row = await db.task.findUnique({ where: { id: taskId }, select: { type: true } });
          return row?.type || ADHOC_FEATURE;
        } catch {
          return ADHOC_FEATURE;
        }
      })();
    }
    return this.featurePromise;
  }

  /**
   * What ONE provider call really consumed.
   *
   * `source` is the honest half: `provider` means the SDK reported both
   * numbers, `estimate` means it did not and we counted characters. An
   * estimate is never silently equal to a measurement — the ledger stores the
   * share of estimated calls, so "the meter says X and the invoice says Y" is
   * diagnosable instead of mysterious.
   */
  /**
   * Gemini reports usage on the RESPONSE object, which this branch obtains at
   * three separate sites. Reading it in one helper is what keeps the three
   * from drifting.
   */
  private static geminiUsage(response: unknown): { input?: number | null; output?: number | null } | null {
    const meta = (response as { usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } })
      ?.usageMetadata;
    if (!meta) return null;
    return { input: meta.promptTokenCount, output: meta.candidatesTokenCount };
  }

  private static estimateTokensFor(text: string): number {
    // Deliberately pessimistic: ~4 chars/token is the Latin-script average, and
    // an estimate that errs cheap is the one that understates a bill. Non-Latin
    // scripts run denser than 4, so 3 is the direction that cannot hide cost.
    return Math.ceil(text.length / 3);
  }

  /**
   * Build usage from an SDK that reported it, or fall back to an estimate.
   *
   * `imageCount` is not decoration: an image is ~1,100-1,300 input tokens the
   * prompt string knows nothing about, so without it the estimate on a vision
   * call came out at roughly a tenth of the truth while wearing the label
   * "rounds up". A PARTIAL report (one number present, the other not) falls
   * back wholesale rather than mixing a measurement with a guess.
   */
  private usageOf(
    prompt: string,
    output: string,
    reported: { input?: number | null; output?: number | null } | null,
    imageCount = 0,
  ): AiCallUsage {
    const model = this.getModel();
    const input = reported?.input;
    const out = reported?.output;
    // `input > 0` and not `>= 0`: a real provider call always has input tokens
    // — the prompt was sent — so a usage object reporting zero of them is a
    // gateway or a routed provider filling the field with nothing, not a
    // measurement. Accepting it stored an `estimated: false` row of 0 tokens
    // and EUR 0, which is worse than an estimate: it lands in the MEASURED
    // half of the report and drags down the per-call average §7's price ladder
    // stands on, indistinguishably from a real cheap call. `out` may
    // legitimately be 0 (an answer we then reject carries input and no
    // output), so only the input side decides.
    if (typeof input === 'number' && typeof out === 'number' && input > 0 && out >= 0) {
      return { inputTokens: input, outputTokens: out, model, source: 'provider' };
    }
    return {
      inputTokens:
        AIService.estimateTokensFor(prompt) + imageCount * ESTIMATED_TOKENS_PER_IMAGE,
      outputTokens: AIService.estimateTokensFor(output),
      model,
      source: 'estimate',
    };
  }

  /**
   * One provider call. Returns the text; reports what it COST into `meter`,
   * the moment the provider's response object is in hand — before every guard
   * below that can reject that answer, and once per provider call rather than
   * once per invocation (Gemini's vision fallback makes two). `meter.dispatched`
   * is bumped before each request so a call that never answers is still known
   * about. See `AiCallMeter` for why those are different events.
   */
  private async _executeAIRequestInner(
    prompt: string,
    imageUrls: string[] | undefined,
    meter: AiCallMeter,
  ): Promise<string> {
    // One local truth for "is this a vision call": every provider branch below
    // asks the same question, and a branch that asked it differently is how a
    // text-only provider would end up with an image in its payload.
    //
    // Filtered, not validated-or-thrown. Three of the four vision providers get
    // the URL and fetch it THEMSELVES, so nothing here ever checked it — which
    // was harmless only while the paths that carry a merchant-supplied URL had
    // vision switched off. They no longer do: the image manager offers its
    // generate button on a tile that is still uploading, whose "URL" is a local
    // `blob:` preview, and handing that to Claude fails the whole call where it
    // used to quietly write from the title. So an unusable URL is DROPPED and
    // the generation goes ahead text-only.
    //
    // The bar is `https:` rather than the CDN allowlist `fetchImageAsBase64`
    // applies: that list exists because on the Gemini path WE do the fetching,
    // and imposing it here would refuse the staged-upload URL of an image the
    // merchant attached seconds ago in the create dialog — a real picture that
    // is not on the CDN yet.
    const images = (imageUrls ?? []).filter((url) => AIService.isSendableImageUrl(url));
    const dropped = (imageUrls?.length ?? 0) - images.length;
    if (dropped > 0) {
      loggers.ai('warn', '[AI-SERVICE] Dropped image URL(s) the model cannot be given', { dropped });
    }
    const hasImages = images.length > 0;
    /**
     * One OpenAI-shaped answer: report first, then judge it.
     *
     * `sentImages` is passed per branch rather than read from `images.length`,
     * because two of the providers below are text-only and never put an image
     * in their payload — charging their estimate for images the merchant
     * happened to have attached invented tokens that were never sent.
     */
    const reportChat = (
      completion: { usage?: { prompt_tokens?: number; completion_tokens?: number } | null },
      text: string,
      sentImages: number,
    ) => {
      meter.observed.push(
        this.usageOf(
          prompt,
          text,
          {
            input: completion.usage?.prompt_tokens,
            output: completion.usage?.completion_tokens,
          },
          sentImages,
        ),
      );
    };

    if (this.provider === 'huggingface' && this.huggingface) {
      // HuggingFace: text-only (no vision support)
      meter.dispatched++;
      const response = await this.huggingface.chatCompletion({
        model: this.getModel(),
        messages: [{ role: 'user', content: prompt }],
        max_tokens: TRANSLATION_BATCH.AI_MAX_OUTPUT_TOKENS,
        temperature: 0.7,
      });
      // HuggingFace's chat-completion output declares `usage`, but whether a
      // routed provider fills it is a runtime question — absent is the
      // estimate case, never zero.
      const hfContent = response.choices[0]?.message?.content ?? '';
      reportChat(response, hfContent, 0); // text-only provider
      if (!response.choices[0]) throw new Error('HuggingFace returned empty response');
      if (!hfContent.trim()) throw new Error('HuggingFace returned empty content');
      return hfContent;
    } else if (this.provider === 'gemini' && this.gemini) {
      // Gemini: supports vision with URL
      if (hasImages) {
        try {
          // Gemini takes the BYTES, so every image is a download inside this
          // request. In PARALLEL, and that is not a micro-optimisation: each
          // fetch has its own 30s timeout while the whole call races a 120s
          // budget from OUTSIDE this function — five sequential slow images
          // would blow it, and the rejection lands past the catch below, so
          // the text-only fallback that makes a slow CDN survivable never
          // runs. Bounded by AI_IMAGES_PER_REQUEST_MAX either way.
          const encoded = await Promise.all(images.map((url) => this.fetchImageAsBase64(url)));
          meter.dispatched++;
          const result = await this.gemini.generateContent([
            { text: prompt },
            ...encoded.map((data) => ({ inlineData: { mimeType: 'image/jpeg', data } })),
          ]);
          const response = await result.response;
          // The usage is read BEFORE `response.text()`, which THROWS when the
          // candidate was blocked for safety or carries no text part — a
          // response Google has still billed for its input, images included.
          // Reading it after cost us exactly that call, every time.
          const visionReported = AIService.geminiUsage(response);
          let geminiText = '';
          try {
            geminiText = response.text();
          } finally {
            meter.observed.push(
              this.usageOf(prompt, geminiText, visionReported, images.length),
            );
          }
          if (!geminiText.trim()) throw new Error('Gemini returned empty response');
          return geminiText;
        } catch (error) {
          if (AIService.isInputTooLongError(error)) throw error;
          loggers.ai('warn', '[AI-SERVICE] Gemini vision failed, falling back to text-only', { error });
          // Fallback to text-only. This is the one branch in the app that
          // makes TWO provider calls in one invocation — and they are reported
          // as two, not summed: a sum would count one call, which is exactly
          // the per-call average Phase 0 exists to measure.
          meter.dispatched++;
          const result = await this.gemini.generateContent(prompt);
          const response = await result.response;
          const fallbackReported = AIService.geminiUsage(response);
          let geminiTextFallback = '';
          try {
            geminiTextFallback = response.text();
          } finally {
            meter.observed.push(this.usageOf(prompt, geminiTextFallback, fallbackReported));
          }
          if (!geminiTextFallback.trim()) throw new Error('Gemini returned empty response');
          return geminiTextFallback;
        }
      } else {
        meter.dispatched++;
        const result = await this.gemini.generateContent(prompt);
        const response = await result.response;
        const reported = AIService.geminiUsage(response);
        let geminiTextOnly = '';
        try {
          geminiTextOnly = response.text();
        } finally {
          meter.observed.push(this.usageOf(prompt, geminiTextOnly, reported));
        }
        if (!geminiTextOnly.trim()) throw new Error('Gemini returned empty response');
        return geminiTextOnly;
      }
    } else if (this.provider === 'claude' && this.anthropic) {
      // Claude: supports vision with URL
      meter.dispatched++;
      const message = hasImages
        ? await this.anthropic.messages.create({
            model: this.getModel(),
            max_tokens: TRANSLATION_BATCH.AI_MAX_OUTPUT_TOKENS,
            messages: [{
              role: 'user',
              content: [
                // Images FIRST, then the prompt — the order every branch here
                // uses, and the one Anthropic documents for multi-image prompts.
                ...images.map((url) => ({ type: 'image' as const, source: { type: 'url' as const, url } })),
                { type: 'text', text: prompt },
              ],
            }],
          })
        : await this.anthropic.messages.create({
            model: this.getModel(),
            max_tokens: TRANSLATION_BATCH.AI_MAX_OUTPUT_TOKENS,
            messages: [{ role: 'user', content: prompt }],
          });
      const textBlock = message.content.find((b) => b.type === 'text');
      const claudeText = textBlock?.text ?? '';
      // `input_tokens` deliberately EXCLUDES cache_creation/cache_read tokens.
      // This app uses no prompt caching; adopting it means adding them here or
      // silently under-counting.
      meter.observed.push(
        this.usageOf(
          prompt,
          claudeText,
          { input: message.usage?.input_tokens, output: message.usage?.output_tokens },
          hasImages ? images.length : 0,
        ),
      );
      if (!textBlock) throw new Error('Claude returned no text block');
      if (!claudeText.trim()) throw new Error('Claude returned empty text');
      return claudeText;
    } else if (this.provider === 'openai' && this.openai) {
      // GPT-4o: supports vision with URL
      meter.dispatched++;
      const completion = hasImages
        ? await this.openai.chat.completions.create({
            model: this.getModel(),
            messages: [{
              role: 'user',
              content: [
                ...images.map((url) => ({ type: 'image_url' as const, image_url: { url } })),
                { type: 'text' as const, text: prompt },
              ],
            }],
            max_tokens: TRANSLATION_BATCH.AI_MAX_OUTPUT_TOKENS,
          })
        : await this.openai.chat.completions.create({
            model: this.getModel(),
            messages: [{ role: 'user', content: prompt }],
            max_tokens: TRANSLATION_BATCH.AI_MAX_OUTPUT_TOKENS,
          });
      const openaiContent = completion.choices[0]?.message?.content ?? '';
      reportChat(completion, openaiContent, hasImages ? images.length : 0);
      if (!completion.choices[0]) throw new Error('OpenAI returned empty response');
      // A `finish_reason: length` truncation answers with empty content after
      // generating the FULL output allowance — the single most expensive call
      // shape there is, which is why the report above happens first.
      if (!openaiContent.trim()) throw new Error(`OpenAI returned empty content (finish_reason: ${completion.choices[0].finish_reason})`);
      return openaiContent;
    } else if (this.provider === 'grok' && this.grok) {
      // Grok: supports vision with URL (similar to GPT-4o)
      meter.dispatched++;
      const completion = hasImages
        ? await this.grok.chat.completions.create({
            model: this.getModel(),
            messages: [{
              role: 'user',
              content: [
                ...images.map((url) => ({ type: 'image_url' as const, image_url: { url } })),
                { type: 'text' as const, text: prompt },
              ],
            }],
            max_tokens: TRANSLATION_BATCH.AI_MAX_OUTPUT_TOKENS,
            temperature: 0.7,
          })
        : await this.grok.chat.completions.create({
            model: this.getModel(),
            messages: [{ role: 'user', content: prompt }],
            max_tokens: TRANSLATION_BATCH.AI_MAX_OUTPUT_TOKENS,
            temperature: 0.7,
          });
      const grokContent = completion.choices[0]?.message?.content ?? '';
      reportChat(completion, grokContent, hasImages ? images.length : 0);
      if (!completion.choices[0]) throw new Error('Grok returned empty response');
      if (!grokContent.trim()) throw new Error(`Grok returned empty content (finish_reason: ${completion.choices[0].finish_reason})`);
      return grokContent;
    } else if (this.provider === 'deepseek' && this.deepseek) {
      // DeepSeek: text-only (no vision support)
      meter.dispatched++;
      const completion = await this.deepseek.chat.completions.create({
        model: this.getModel(),
        messages: [{ role: 'user', content: prompt }],
        max_tokens: TRANSLATION_BATCH.AI_MAX_OUTPUT_TOKENS,
        temperature: 0.7,
      });
      const deepseekContent = completion.choices[0]?.message?.content ?? '';
      reportChat(completion, deepseekContent, 0); // text-only provider
      if (!completion.choices[0]) throw new Error('DeepSeek returned empty response');
      if (!deepseekContent.trim()) throw new Error(`DeepSeek returned empty content (finish_reason: ${completion.choices[0].finish_reason})`);
      return deepseekContent;
    }

    throw new Error('No AI provider configured');
  }

  /**
   * Can this URL be handed to a provider at all?
   *
   * Deliberately weaker than `validateImageUrl` (see the call site): it only
   * asks whether the string is an absolute `https:` URL, which is what rules
   * out the `blob:` and `data:` previews a client can hold, plus plain-http and
   * file URLs. It does NOT throw — a bad URL costs its image, never the
   * generation.
   */
  private static isSendableImageUrl(url: string | null | undefined): url is string {
    if (typeof url !== 'string' || !url.trim()) return false;
    try {
      return new URL(url.trim()).protocol === 'https:';
    } catch {
      return false;
    }
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

  /**
   * `imageUrls` is already the merchant's policy applied: the handler read
   * AISettings and clamped the list, so an empty array here means "no vision
   * for this shop" as much as it means "this item has no picture". This layer
   * asks no further questions about it.
   */
  async generateProductTitle(
    prompt: string,
    imageUrls?: string[],
    glossary?: { contextTexts: string[]; locale: string },
  ): Promise<string> {
    // The prompt is already built by the caller with AI Instructions
    // Just execute it directly without adding additional instructions
    return await this.askAI(
      glossary ? await this.appendGlossary(prompt, glossary.contextTexts, glossary.locale) : prompt,
      imageUrls,
    );
  }

  async generateProductDescription(
    title: string,
    prompt: string,
    imageUrls?: string[],
    glossary?: { contextTexts: string[]; locale: string },
  ): Promise<string> {
    // The prompt is already built by the caller with AI Instructions
    // Just execute it directly without adding additional instructions
    return await this.askAI(
      glossary ? await this.appendGlossary(prompt, [title, ...glossary.contextTexts], glossary.locale) : prompt,
      imageUrls,
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
  /**
   * ONE image, always — the one being described. `aiImagesPerRequest` is
   * deliberately not consulted: an alt text for image 3 that also carries
   * images 1, 2, 4 and 5 is an invitation to describe the wrong one.
   * `sendImageToAI` here is the shop's switch, resolved by the caller.
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
      sendImageToAI ? [imageUrl] : undefined,
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
