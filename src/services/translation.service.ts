import { AIService, type AIProvider, type AIServiceConfig } from './ai.service';

export class TranslationService {
  private aiService: AIService;

  constructor(aiProvider: AIProvider = 'claude', config: AIServiceConfig = {}, shop?: string, taskId?: string) {
    this.aiService = new AIService(aiProvider, config, shop, taskId);
  }

  async translateProduct(
    fields: Record<string, string>,
    targetLocales?: string[],
    contentType: string = 'product',
    customInstructions?: string,
    /** Keyword-aware translation clause for THIS call's target language(s). */
    keywordDirective?: string
  ): Promise<Record<string, Record<string, string>>> {
    const locales = targetLocales || ['en', 'fr', 'es', 'it'];
    return await this.aiService.translateFields(
      fields,
      locales,
      contentType,
      customInstructions,
      keywordDirective,
    );
  }

  /**
   * Translate a list of BARE VALUES — no field semantics, no length limits.
   *
   * What a metafield value, a product option name, a metaobject field or a
   * theme string has in common: its translation key is `value` / `name` / an
   * arbitrary theme key, so there is no named field to hang the merchant's
   * per-field instructions or an SEO character limit on. `context` is what the
   * model gets instead — say what the values ARE.
   *
   * Order-preserving and 1:1 with the input, which is what lets the caller map
   * the answer back by INDEX: two option values may legitimately hold the same
   * text, and a value-keyed map would collapse them.
   */
  async translateValues(
    values: string[],
    fromLang: string,
    toLang: string,
    context: string,
  ): Promise<string[]> {
    return await this.aiService.translateBatchValues(values, fromLang, toLang, context);
  }

  /**
   * Translate a URL slug to multiple locales in a single AI request
   * More efficient than translating one locale at a time
   */
  async translateSlugBatch(
    slug: string,
    fromLang: string,
    targetLocales: string[]
  ): Promise<Record<string, string>> {
    return await this.aiService.translateSlugBatch(slug, fromLang, targetLocales);
  }

  /**
   * Translate short fields (title, seoTitle, handle) to all locales in a single AI request
   * More efficient for compact fields that don't need extensive context
   */
  async translateShortFieldsBatch(
    fields: Record<string, string>,
    fromLang: string,
    targetLocales: string[],
    contentType: string = 'product',
    customInstructions?: string,
    /** Keyword-aware translation clause — one line per target language. */
    keywordDirective?: string
  ): Promise<Record<string, Record<string, string>>> {
    return await this.aiService.translateShortFieldsBatch(
      fields,
      fromLang,
      targetLocales,
      contentType,
      customInstructions,
      keywordDirective,
    );
  }
}
