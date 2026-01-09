import { HfInference } from '@huggingface/inference';
import { GoogleGenerativeAI } from '@google/generative-ai';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

export type AIProvider = 'huggingface' | 'gemini' | 'claude' | 'openai';

export class AIService {
  private huggingface?: HfInference;
  private gemini?: any;
  private anthropic?: Anthropic;
  private openai?: OpenAI;
  private provider: AIProvider;

  constructor(provider: AIProvider = 'huggingface') {
    this.provider = provider;
    this.initializeProvider();
  }

  private initializeProvider() {
    if (this.provider === 'huggingface') {
      this.huggingface = new HfInference(process.env.HUGGINGFACE_API_KEY || '');
      console.log('🤖 AI Provider: Hugging Face (FREE)');
    } else if (this.provider === 'gemini') {
      const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY || '');
      this.gemini = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-lite' });
      console.log('🤖 AI Provider: Google Gemini (FREE)');
    } else if (this.provider === 'claude') {
      this.anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || '' });
      console.log('🤖 AI Provider: Claude');
    } else if (this.provider === 'openai') {
      this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });
      console.log('🤖 AI Provider: OpenAI');
    }
  }

  async generateSEO(productTitle: string, productDescription: string): Promise<{
    seoTitle: string;
    metaDescription: string;
    reasoning: string;
  }> {
    const prompt = `Du bist ein SEO-Experte für E-Commerce. Optimiere die folgenden Produktinformationen für Suchmaschinen.

Produkttitel: ${productTitle}
Produktbeschreibung: ${productDescription}

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
    const prompt = `Übersetze den folgenden Text von ${fromLang} nach ${toLang}. Behalte HTML-Tags bei.

Text: ${content}

Gib nur die Übersetzung zurück, ohne zusätzliche Erklärungen.`;

    return await this.askAI(prompt);
  }

  async translateSEO(
    seoTitle: string,
    metaDescription: string,
    targetLocales: string[]
  ): Promise<Record<string, { seoTitle: string; metaDescription: string }>> {
    const localeNames: Record<string, string> = {
      en: 'Englisch',
      fr: 'Französisch',
      es: 'Spanisch',
      it: 'Italienisch',
    };

    const targetLanguages = targetLocales.map((loc) => localeNames[loc] || loc).join(', ');

    const prompt = `Übersetze diese SEO-Texte von Deutsch in ${targetLanguages}.

SEO-Titel (DE): ${seoTitle}
Meta-Description (DE): ${metaDescription}

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
    const localeNames: Record<string, string> = {
      de: 'Deutsch',
      en: 'Englisch',
      fr: 'Französisch',
      es: 'Spanisch',
      it: 'Italienisch',
    };

    const language = localeNames[context.locale] || 'Deutsch';
    const isTitle = fieldType === 'title';
    const fieldLabel = isTitle ? 'Titel' : 'Beschreibung';

    let prompt = '';

    if (!currentValue || currentValue.trim().length === 0) {
      // Generate new content from scratch
      prompt = `Du bist ein E-Commerce-Experte und Content-Writer. Generiere einen ${fieldLabel} für ein Produkt.

Produktkontext:
- Titel: ${context.productTitle}
- Produkttyp: ${context.productType}
${!isTitle ? `- Beschreibung: ${context.productDescription}` : ''}

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

Aktueller ${fieldLabel}: ${currentValue}

Produktkontext:
- Titel: ${context.productTitle}
- Produkttyp: ${context.productType}

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
    const fieldsText = Object.entries(fields)
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

  private async askAI(prompt: string): Promise<string> {
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
    }

    throw new Error('No AI provider configured');
  }

  async generateProductTitle(description: string): Promise<string> {
    const prompt = `Du bist ein E-Commerce-Experte. Erstelle einen prägnanten, verkaufsstarken Produkttitel basierend auf dieser Beschreibung:

${description}

Der Titel sollte:
- Max. 80 Zeichen lang sein
- Das Hauptprodukt und wichtigste Vorteile enthalten
- SEO-freundlich sein
- Aufmerksamkeit erregen

Gib nur den Titel zurück, ohne zusätzliche Erklärungen.`;

    return await this.askAI(prompt);
  }

  async generateProductDescription(title: string, currentDescription: string): Promise<string> {
    const prompt = `Du bist ein E-Commerce-Experte. ${currentDescription ? 'Verbessere' : 'Erstelle'} eine detaillierte Produktbeschreibung für: ${title}

${currentDescription ? `Aktuelle Beschreibung: ${currentDescription}` : ''}

Die Beschreibung sollte:
- 200-400 Wörter umfassen
- HTML-Formatierung verwenden (<p>, <strong>, <ul>, <li>)
- Produktmerkmale und Vorteile hervorheben
- Emotionalen Mehrwert bieten
- Überzeugende Gründe zum Kauf liefern

Gib nur die HTML-formatierte Beschreibung zurück, ohne zusätzliche Erklärungen.`;

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
