/**
 * API Route: AI Model Listing
 *
 * Returns available AI models for a given provider.
 * Tries dynamic fetching via provider APIs, falls back to curated lists.
 */

import type { LoaderFunctionArgs } from "react-router";
import { data as json } from "react-router";
import { authenticate } from '~/shopify.server';
import { db } from '~/db.server';
import { tryDecryptApiKey } from '~/utils/encryption.server';
import { logger } from '~/utils/logger.server';
import { CURATED_MODELS, DEFAULT_MODELS, type ModelInfo } from '~/config/ai-models.config';
import type { AIProvider } from '~/utils/api-key-validation';

// In-memory cache: key = "shop:provider", value = { models, timestamp }
const modelCache = new Map<string, { models: ModelInfo[]; timestamp: number }>();
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_CACHE_ENTRIES = 500;

function getCachedModels(cacheKey: string): ModelInfo[] | null {
  const cached = modelCache.get(cacheKey);
  if (!cached) return null;
  if (Date.now() - cached.timestamp >= CACHE_TTL_MS) {
    modelCache.delete(cacheKey);
    return null;
  }
  return cached.models;
}

function setCachedModels(cacheKey: string, models: ModelInfo[]) {
  // Evict expired entries when approaching the size limit
  if (modelCache.size >= MAX_CACHE_ENTRIES) {
    const now = Date.now();
    for (const [key, value] of modelCache) {
      if (now - value.timestamp >= CACHE_TTL_MS) {
        modelCache.delete(key);
      }
    }
    // If still at limit after sweeping expired, drop oldest entries
    if (modelCache.size >= MAX_CACHE_ENTRIES) {
      const excess = modelCache.size - MAX_CACHE_ENTRIES + 1;
      const keys = modelCache.keys();
      for (let i = 0; i < excess; i++) {
        modelCache.delete(keys.next().value!);
      }
    }
  }
  modelCache.set(cacheKey, { models, timestamp: Date.now() });
}

/** Fetch models from OpenAI-compatible API */
async function fetchOpenAICompatibleModels(
  apiKey: string,
  baseURL?: string,
  filterFn?: (id: string) => boolean
): Promise<ModelInfo[]> {
  const OpenAI = (await import('openai')).default;
  const client = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
  const response = await client.models.list();
  const models: ModelInfo[] = [];
  for await (const model of response) {
    if (!filterFn || filterFn(model.id)) {
      models.push({ id: model.id, name: model.id });
    }
  }
  // Sort alphabetically
  models.sort((a, b) => a.id.localeCompare(b.id));
  return models;
}

/** Fetch models from Anthropic REST API */
async function fetchClaudeModels(apiKey: string): Promise<ModelInfo[]> {
  const response = await fetch('https://api.anthropic.com/v1/models', {
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
  });
  if (!response.ok) {
    throw new Error(`Anthropic API returned ${response.status}`);
  }
  const data = await response.json();
  if (!data.data || !Array.isArray(data.data)) {
    throw new Error('Unexpected Anthropic API response format');
  }
  return data.data
    .map((m: any) => ({ id: m.id, name: m.display_name || m.id }))
    .sort((a: ModelInfo, b: ModelInfo) => a.id.localeCompare(b.id));
}

/** Get API key for a provider from DB settings */
function getApiKeyForProvider(settings: any, provider: AIProvider): string | null {
  const keyMap: Record<AIProvider, string> = {
    huggingface: 'huggingfaceApiKey',
    gemini: 'geminiApiKey',
    claude: 'claudeApiKey',
    openai: 'openaiApiKey',
    grok: 'grokApiKey',
    deepseek: 'deepseekApiKey',
  };
  const encrypted = settings?.[keyMap[provider]];
  return encrypted ? tryDecryptApiKey(encrypted, provider) : null;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  if (!session) {
    return json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(request.url);
  const provider = url.searchParams.get('provider') as AIProvider | null;

  if (!provider || !CURATED_MODELS[provider]) {
    return json({ success: false, error: 'Invalid provider' }, { status: 400 });
  }

  const cacheKey = `${session.shop}:${provider}`;
  const defaultModel = DEFAULT_MODELS[provider];

  // Check cache first
  const cached = getCachedModels(cacheKey);
  if (cached) {
    return json({ success: true, models: cached, defaultModel, fromCache: true }, { headers: { "Cache-Control": "no-store" } });
  }

  // Load API key from DB
  const settings = await db.aISettings.findUnique({
    where: { shop: session.shop },
  });

  const apiKey = getApiKeyForProvider(settings, provider);

  // No API key → return curated list
  if (!apiKey) {
    return json({
      success: true,
      models: CURATED_MODELS[provider],
      defaultModel,
      fromFallback: true,
      reason: 'no_api_key',
    }, { headers: { "Cache-Control": "no-store" } });
  }

  try {
    let models: ModelInfo[] = [];

    switch (provider) {
      case 'openai':
        models = await fetchOpenAICompatibleModels(apiKey, undefined, (id) =>
          id.includes('gpt') || id.startsWith('o1') || id.startsWith('o3') || id.startsWith('o4')
        );
        break;

      case 'grok':
        models = await fetchOpenAICompatibleModels(apiKey, 'https://api.x.ai/v1');
        break;

      case 'deepseek':
        models = await fetchOpenAICompatibleModels(apiKey, 'https://api.deepseek.com');
        break;

      case 'claude':
        models = await fetchClaudeModels(apiKey);
        break;

      case 'gemini':
        // Google Generative AI SDK listModels is not reliable, use curated list
        models = CURATED_MODELS[provider];
        break;

      case 'huggingface':
        // HuggingFace Inference API has no straightforward model listing
        models = CURATED_MODELS[provider];
        break;
    }

    // If API returned empty, use curated fallback
    if (models.length === 0) {
      models = CURATED_MODELS[provider];
    }

    // Cache the result
    setCachedModels(cacheKey, models);

    return json({ success: true, models, defaultModel }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    logger.warn('Failed to fetch models from provider API, using fallback', {
      provider,
      error: error instanceof Error ? error.message : String(error),
    });

    return json({
      success: true,
      models: CURATED_MODELS[provider],
      defaultModel,
      fromFallback: true,
      reason: 'api_error',
    }, { headers: { "Cache-Control": "no-store" } });
  }
};
