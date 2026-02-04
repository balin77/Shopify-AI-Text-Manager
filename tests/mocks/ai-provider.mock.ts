/**
 * Mock AI Provider Responses
 *
 * Verwendung in Tests:
 * - Keine echten API-Keys nötig
 * - Deterministisches Verhalten
 * - Schnelle Ausführung (<10ms statt 2-5s)
 */

import { vi } from 'vitest';
import type { AIProvider } from '~/../../src/services/ai.service';

export const mockAIResponses = {
  seo: {
    seoTitle: 'Premium Leather Wallet - RFID Protection',
    metaDescription: 'Handcrafted genuine leather wallet with RFID blocking technology. Perfect gift for men and women. Shop now!',
    reasoning: 'Optimized for search with key features and call-to-action'
  },
  translation: {
    en: 'Premium Leather Wallet',
    de: 'Premium Leder Geldbörse',
    fr: 'Portefeuille en Cuir Premium',
  },
  description: `<p>Discover our <strong>handcrafted leather wallet</strong> made from premium materials.</p>
<ul>
  <li>RFID blocking technology</li>
  <li>Multiple card slots</li>
  <li>Slim design</li>
</ul>`,
};

/**
 * Mock für HuggingFace Inference API
 */
export const createMockHuggingFace = () => ({
  chatCompletion: vi.fn().mockResolvedValue({
    choices: [{
      message: {
        content: JSON.stringify(mockAIResponses.seo)
      }
    }]
  })
});

/**
 * Mock für Google Gemini API
 */
export const createMockGemini = () => ({
  generateContent: vi.fn().mockResolvedValue({
    response: {
      text: () => JSON.stringify(mockAIResponses.seo)
    }
  })
});

/**
 * Mock für Anthropic Claude API
 */
export const createMockClaude = () => ({
  messages: {
    create: vi.fn().mockResolvedValue({
      content: [{
        type: 'text',
        text: JSON.stringify(mockAIResponses.seo)
      }]
    })
  }
});

/**
 * Mock für OpenAI API
 */
export const createMockOpenAI = () => ({
  chat: {
    completions: {
      create: vi.fn().mockResolvedValue({
        choices: [{
          message: {
            content: JSON.stringify(mockAIResponses.seo)
          }
        }]
      })
    }
  }
});

/**
 * Factory für AI Provider Mocks
 */
export const mockAIProvider = (provider: AIProvider) => {
  switch (provider) {
    case 'huggingface':
      return createMockHuggingFace();
    case 'gemini':
      return createMockGemini();
    case 'claude':
      return createMockClaude();
    case 'openai':
    case 'grok':
    case 'deepseek':
      return createMockOpenAI();
  }
};

/**
 * Mock für den gesamten AIService
 * Nützlich für Tests von Actions/Routes
 */
export const createMockAIService = () => ({
  generateSEO: vi.fn().mockResolvedValue(mockAIResponses.seo),
  translateContent: vi.fn().mockImplementation((content, from, to) =>
    Promise.resolve(mockAIResponses.translation[to as keyof typeof mockAIResponses.translation] || content)
  ),
  translateSlug: vi.fn().mockImplementation((slug, from, to) =>
    Promise.resolve(slug.replace(/\s+/g, '-').toLowerCase())
  ),
  generateContent: vi.fn().mockResolvedValue({
    content: mockAIResponses.description,
    reasoning: 'Generated with AI best practices'
  }),
});
