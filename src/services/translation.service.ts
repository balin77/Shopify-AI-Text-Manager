import { AIService, type AIProvider, type AIServiceConfig } from './ai.service';

export class TranslationService {
  private aiService: AIService;

  constructor(aiProvider: AIProvider = 'huggingface', config: AIServiceConfig = {}, shop?: string, taskId?: string) {
    this.aiService = new AIService(aiProvider, config, shop, taskId);
  }

  async translateProduct(
    fields: Record<string, string>,
    targetLocales?: string[],
    contentType: string = 'product',
    customInstructions?: string
  ): Promise<Record<string, Record<string, string>>> {
    const locales = targetLocales || ['en', 'fr', 'es', 'it'];
    return await this.aiService.translateFields(fields, locales, contentType, customInstructions);
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
    contentType: string = 'product'
  ): Promise<Record<string, Record<string, string>>> {
    return await this.aiService.translateShortFieldsBatch(fields, fromLang, targetLocales, contentType);
  }
}
