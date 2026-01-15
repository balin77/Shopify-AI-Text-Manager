import { AIService, type AIProvider, type AIServiceConfig } from './ai.service';

export class TranslationService {
  private aiService: AIService;

  constructor(aiProvider: AIProvider = 'huggingface', config: AIServiceConfig = {}, shop?: string, taskId?: string) {
    this.aiService = new AIService(aiProvider, config, shop, taskId);
  }

  async translateProduct(
    fields: Record<string, string>,
    targetLocales?: string[],
    aiInstructions?: any,
    contentType: string = 'product'
  ): Promise<Record<string, Record<string, string>>> {
    const locales = targetLocales || ['en', 'fr', 'es', 'it'];
    return await this.aiService.translateFields(fields, locales, aiInstructions, contentType);
  }
}
