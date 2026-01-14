import { HfInference } from '@huggingface/inference';
import { GoogleGenerativeAI } from '@google/generative-ai';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { AIQueueService } from './ai-queue.service';
import { sanitizePromptInput } from '../../app/utils/prompt-sanitizer';

export type AIProvider = 'huggingface' | 'gemini' | 'claude' | 'openai' | 'grok' | 'deepseek';

export interface AIServiceConfig {
  huggingfaceApiKey?: string;
  geminiApiKey?: string;
  claudeApiKey?: string;
  openaiApiKey?: string;
  grokApiKey?: string;
  deepseekApiKey?: string;
}

export class AIService {
  private huggingface?: HfInference;
  private gemini?: any;
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

  private initializeProvider() {
    if (this.provider === 'huggingface') {
      const apiKey = this.config.huggingfaceApiKey || process.env.HUGGINGFACE_API_KEY || '';
      this.huggingface = new HfInference(apiKey);
      console.log('🤖 AI Provider: Hugging Face (FREE)');
    } else if (this.provider === 'gemini') {
      const apiKey = this.config.geminiApiKey || process.env.GOOGLE_API_KEY || '';
      const genAI = new GoogleGenerativeAI(apiKey);
      this.gemini = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-lite' });
      console.log('🤖 AI Provider: Google Gemini (FREE)');
    } else if (this.provider === 'claude') {
      const apiKey = this.config.claudeApiKey || process.env.ANTHROPIC_API_KEY || '';
      this.anthropic = new Anthropic({ apiKey });
      console.log('🤖 AI Provider: Claude');
    } else if (this.provider === 'openai') {
      const apiKey = this.config.openaiApiKey || process.env.OPENAI_API_KEY || '';
      this.openai = new OpenAI({ apiKey });
      console.log('🤖 AI Provider: OpenAI');
    } else if (this.provider === 'grok') {
      const apiKey = this.config.grokApiKey || process.env.GROK_API_KEY || '';
      this.grok = new OpenAI({
        apiKey,
        baseURL: 'https://api.x.ai/v1',
      });
      console.log('🤖 AI Provider: Grok (X.AI)');
    } else if (this.provider === 'deepseek') {
      const apiKey = this.config.deepseekApiKey || process.env.DEEPSEEK_API_KEY || '';
      this.deepseek = new OpenAI({
        apiKey,
        baseURL: 'https://api.deepseek.com',
      });
      console.log('🤖 AI Provider: DeepSeek');
    }
  }

  async generateSEO(productTitle: string, productDescription: string): Promise<{
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

    const prompt = `Du bist ein SEO-Experte für E-Commerce. Optimiere die folgenden Produktinformationen für Suchmaschinen.

Produkttitel: ${sanitizedTitle}
Produktbeschreibung: ${sanitizedDescription}

Erstelle:
1. Einen optimierten SEO-Titel (max. 60 Zeichen)
2. Eine Meta-Description (120-160 Zeichen)
3. Eine kurze Begründung für deine Optimierungen

Antworte im folgenden JSON-Format:
{
  "seoTitle": "...",
  "metaDescription": "...",
  "reasoning": "..."
}`;

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

    const prompt = `Übersetze den folgenden Text von ${fromLang} nach ${toLang}. Behalte HTML-Tags bei.

Text: ${sanitizedContent}

Gib nur die Übersetzung zurück, ohne zusätzliche Erklärungen.`;

    return await this.askAI(prompt);
  }

  async translateSEO(
    seoTitle: string,
    metaDescription: string,
    targetLocales: string[]
  ): Promise<Record<string, { seoTitle: string; metaDescription: string }>> {
    // Sanitize SEO fields
    const sanitizedTitle = sanitizePromptInput(seoTitle, { fieldType: 'seoTitle' });
    const sanitizedDescription = sanitizePromptInput(metaDescription, { fieldType: 'metaDescription' });

    const localeNames: Record<string, string> = {
      en: 'Englisch',
      fr: 'Französisch',
      es: 'Spanisch',
      it: 'Italienisch',
    };

    const targetLanguages = targetLocales.map((loc) => localeNames[loc] || loc).join(', ');

    const prompt = `Übersetze diese SEO-Texte von Deutsch in ${targetLanguages}.

SEO-Titel (DE): ${sanitizedTitle}
Meta-Description (DE): ${sanitizedDescription}

Achte darauf, dass die Zeichenlängen ähnlich bleiben und die Übersetzungen natürlich klingen.

Antworte im JSON-Format:
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
          fieldType: fieldType as any,
          allowNewlines: true
        })
      : '';

    const localeNames: Record<string, string> = {
      de: 'Deutsch',
      en: 'Englisch',
      fr: 'Französisch',
      es: 'Spanisch',
      it: 'Italienisch',
    };

    const language = localeNames[sanitizedContext.locale] || 'Deutsch';
    const isTitle = fieldType === 'title';
    const fieldLabel = isTitle ? 'Titel' : 'Beschreibung';

    let prompt = '';

    if (!sanitizedCurrentValue || sanitizedCurrentValue.trim().length === 0) {
      // Generate new content from scratch
      prompt = `Du bist ein E-Commerce-Experte und Content-Writer. Generiere einen ${fieldLabel} für ein Produkt.

Produktkontext:
- Titel: ${sanitizedContext.productTitle}
- Produkttyp: ${sanitizedContext.productType}
${!isTitle ? `- Beschreibung: ${sanitizedContext.productDescription}` : ''}

Aufgabe: Erstelle einen ${isTitle ? 'prägnanten, verkaufsstarken Produkttitel (max. 80 Zeichen)' : 'detaillierten, ansprechenden Produktbeschreibung (200-400 Wörter) mit HTML-Formatierung (<p>, <strong>, <ul>, <li>)'} in ${language}.

${isTitle ? 'Der Titel sollte:' : 'Die Beschreibung sollte:'}
${isTitle ?
  `- Das Hauptprodukt und seine wichtigsten Vorteile enthalten
- SEO-freundlich sein
- Aufmerksamkeit erregen` :
  `- Die wichtigsten Produktmerkmale und Vorteile hervorheben
- Emotionalen Mehrwert bieten
- Überzeugende Gründe zum Kauf liefern
- Gut strukturiert und leicht lesbar sein`}

Antworte im folgenden JSON-Format:
{
  "content": "${isTitle ? 'Generierter Titel' : 'Generierte Beschreibung'}",
  "reasoning": "Kurze Erklärung der Strategie"
}`;
    } else {
      // Improve existing content
      prompt = `Du bist ein E-Commerce-Experte und Content-Writer. Verbessere den folgenden ${fieldLabel}.

Aktueller ${fieldLabel}: ${sanitizedCurrentValue}

Produktkontext:
- Titel: ${sanitizedContext.productTitle}
- Produkttyp: ${sanitizedContext.productType}

Aufgabe: Verbessere und optimiere den ${fieldLabel} in ${language}.

Der verbesserte ${fieldLabel} sollte:
${isTitle ?
  `- Prägnanter und verkaufsstärker sein
- SEO-freundliche Keywords enthalten
- Max. 80 Zeichen lang sein
- Das Hauptprodukt und seine wichtigsten Vorteile hervorheben` :
  `- Überzeugender und ansprechender formuliert sein
- Wichtige Produktmerkmale und Vorteile betonen
- Gut strukturiert sein mit HTML-Formatierung (<p>, <strong>, <ul>, <li>)
- 200-400 Wörter umfassen
- Emotionalen Mehrwert bieten`}

Antworte im folgenden JSON-Format:
{
  "content": "Verbesserter ${fieldLabel}",
  "reasoning": "Kurze Erklärung der vorgenommenen Verbesserungen"
}`;
    }

    const responseText = await this.askAI(prompt);
    return this.parseJSONResponse(responseText);
  }

  async translateFields(
    fields: Record<string, string>,
    targetLocales: string[]
  ): Promise<Record<string, Record<string, string>>> {
    // Sanitize all field values
    const sanitizedFields: Record<string, string> = {};
    for (const [key, value] of Object.entries(fields)) {
      sanitizedFields[key] = sanitizePromptInput(value, {
        fieldType: key as any,
        allowNewlines: key === 'description',
      });
    }

    const localeNames: Record<string, string> = {
      en: 'Englisch',
      fr: 'Französisch',
      es: 'Spanisch',
      it: 'Italienisch',
    };

    const fieldNames: Record<string, string> = {
      title: 'Titel',
      description: 'Beschreibung',
      handle: 'URL-Slug',
      seoTitle: 'SEO-Titel',
      metaDescription: 'Meta-Description',
    };

    const targetLanguages = targetLocales.map((loc) => localeNames[loc] || loc).join(', ');

    // Build the fields section for the prompt
    const fieldsText = Object.entries(sanitizedFields)
      .map(([key, value]) => `${fieldNames[key] || key} (DE): ${value}`)
      .join('\n');

    // Build the expected JSON structure
    const jsonStructure: Record<string, any> = {};
    for (const locale of targetLocales) {
      jsonStructure[locale] = {};
      for (const key of Object.keys(fields)) {
        jsonStructure[locale][key] = '...';
      }
    }

    const prompt = `Übersetze diese Produktfelder von Deutsch in ${targetLanguages}.

${fieldsText}

Achte darauf, dass:
- HTML-Tags beibehalten werden
- Die Zeichenlängen ähnlich bleiben
- Die Übersetzungen natürlich klingen
- Bei URL-Slugs (handle) keine Sonderzeichen verwendet werden

Antworte im JSON-Format:
${JSON.stringify(jsonStructure, null, 2)}`;

    const responseText = await this.askAI(prompt);
    return this.parseJSONResponse(responseText);
  }

  private estimateTokens(prompt: string): number {
    // Rough estimate: ~4 characters per token
    // Add output tokens estimate (2000 max_tokens)
    const inputTokens = Math.ceil(prompt.length / 4);
    const outputTokens = 2000;
    return inputTokens + outputTokens;
  }

  private async askAI(prompt: string): Promise<string> {
    // Save prompt to database if taskId is provided
    if (this.taskId && this.shop) {
      await this.savePromptToTask(prompt);
    }

    // If no shop/taskId provided, execute directly (backward compatibility)
    if (!this.shop || !this.taskId) {
      return this.executeAIRequest(prompt);
    }

    // Use queue for rate-limited execution
    const estimatedTokens = this.estimateTokens(prompt);

    return this.queue.enqueue(
      this.shop,
      this.taskId,
      this.provider,
      estimatedTokens,
      () => this.executeAIRequest(prompt)
    );
  }

  private async savePromptToTask(prompt: string): Promise<void> {
    try {
      const { db } = await import('../../app/db.server');
      await db.task.update({
        where: { id: this.taskId },
        data: { prompt },
      });
    } catch (error) {
      console.error('Failed to save prompt to task:', error);
      // Don't throw - we don't want to fail the task if prompt saving fails
    }
  }

  private async executeAIRequest(prompt: string): Promise<string> {
    if (this.provider === 'huggingface' && this.huggingface) {
      const response = await this.huggingface.chatCompletion({
        model: 'Qwen/Qwen2.5-72B-Instruct',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 2000,
        temperature: 0.7,
      });
      return response.choices[0].message.content || '';
    } else if (this.provider === 'gemini' && this.gemini) {
      const result = await this.gemini.generateContent(prompt);
      const response = await result.response;
      return response.text();
    } else if (this.provider === 'claude' && this.anthropic) {
      const message = await this.anthropic.messages.create({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }],
      });
      const content = message.content[0];
      return content.type === 'text' ? content.text : '';
    } else if (this.provider === 'openai' && this.openai) {
      const completion = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 2000,
      });
      return completion.choices[0].message.content || '';
    } else if (this.provider === 'grok' && this.grok) {
      const completion = await this.grok.chat.completions.create({
        model: 'grok-beta',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 2000,
        temperature: 0.7,
      });
      return completion.choices[0].message.content || '';
    } else if (this.provider === 'deepseek' && this.deepseek) {
      const completion = await this.deepseek.chat.completions.create({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 2000,
        temperature: 0.7,
      });
      return completion.choices[0].message.content || '';
    }

    throw new Error('No AI provider configured');
  }

  async generateProductTitle(description: string): Promise<string> {
    // Sanitize description input
    const sanitizedDescription = sanitizePromptInput(description, {
      fieldType: 'description',
      allowNewlines: true
    });

    const prompt = `Du bist ein E-Commerce-Experte. Erstelle einen prägnanten, verkaufsstarken Produkttitel basierend auf dieser Beschreibung:

${sanitizedDescription}

Der Titel sollte:
- Max. 80 Zeichen lang sein
- Das Hauptprodukt und wichtigste Vorteile enthalten
- SEO-freundlich sein
- Aufmerksamkeit erregen

Gib nur den Titel zurück, ohne zusätzliche Erklärungen.`;

    return await this.askAI(prompt);
  }

  async generateProductDescription(title: string, currentDescription: string): Promise<string> {
    // Sanitize inputs
    const sanitizedTitle = sanitizePromptInput(title, { fieldType: 'title' });
    const sanitizedCurrentDescription = currentDescription
      ? sanitizePromptInput(currentDescription, {
          fieldType: 'description',
          allowNewlines: true
        })
      : '';

    const prompt = `Du bist ein E-Commerce-Experte. ${sanitizedCurrentDescription ? 'Verbessere' : 'Erstelle'} eine detaillierte Produktbeschreibung für: ${sanitizedTitle}

${sanitizedCurrentDescription ? `Aktuelle Beschreibung: ${sanitizedCurrentDescription}` : ''}

Die Beschreibung sollte:
- 200-400 Wörter umfassen
- HTML-Formatierung verwenden (<p>, <strong>, <ul>, <li>)
- Produktmerkmale und Vorteile hervorheben
- Emotionalen Mehrwert bieten
- Überzeugende Gründe zum Kauf liefern

Gib nur die HTML-formatierte Beschreibung zurück, ohne zusätzliche Erklärungen.`;

    return await this.askAI(prompt);
  }

  async generateImageAltText(imageUrl: string, productTitle?: string, customPrompt?: string): Promise<string> {
    // Sanitize product title if provided
    const sanitizedTitle = productTitle
      ? sanitizePromptInput(productTitle, { fieldType: 'title' })
      : '';

    const prompt = customPrompt || `Du bist ein SEO-Experte für E-Commerce. Erstelle einen optimierten Alt-Text für ein Produktbild.

${sanitizedTitle ? `Produkt: ${sanitizedTitle}` : ''}
Bild-URL: ${imageUrl}

Der Alt-Text sollte:
- Präzise beschreiben, was auf dem Bild zu sehen ist
- SEO-freundlich sein (60-125 Zeichen)
- Relevant für das Produkt sein
- Keine Füllwörter enthalten
- Barrierefrei formuliert sein

Gib nur den Alt-Text zurück, ohne zusätzliche Erklärungen.`;

    return await this.askAI(prompt);
  }

  private parseJSONResponse(text: string): any {
    // Try to extract JSON from markdown code blocks
    const jsonMatch = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[1]);
    }

    // Try to find JSON object in text
    const objectMatch = text.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      return JSON.parse(objectMatch[0]);
    }

    throw new Error('Could not parse JSON from AI response');
  }
}
