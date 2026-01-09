import { AIService, type AIProvider } from './ai.service';

export class TranslationService {
  private aiService: AIService;

  constructor(aiProvider: AIProvider = 'huggingface') {
    this.aiService = new AIService(aiProvider);
  }

  async translateProduct(fields: Record<string, string>): Promise<Record<string, Record<string, string>>> {
    const targetLocales = ['en', 'fr', 'es', 'it'];
    return await this.aiService.translateFields(fields, targetLocales);
  }
}
