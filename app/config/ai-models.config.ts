import type { AIProvider } from '../utils/api-key-validation';

export interface ModelInfo {
  id: string;
  name: string;
}

/** Default model per provider (current hardcoded values as fallback) */
export const DEFAULT_MODELS: Record<AIProvider, string> = {
  huggingface: 'Qwen/Qwen2.5-72B-Instruct',
  gemini: 'gemini-2.0-flash-lite',
  claude: 'claude-sonnet-4-5-20250929',
  openai: 'gpt-4o-mini',
  grok: 'grok-3-mini',
  deepseek: 'deepseek-chat',
};

/** Curated model lists per provider (used as fallback when API listing fails) */
export const CURATED_MODELS: Record<AIProvider, ModelInfo[]> = {
  huggingface: [
    { id: 'Qwen/Qwen2.5-72B-Instruct', name: 'Qwen 2.5 72B Instruct' },
    { id: 'meta-llama/Llama-3.1-70B-Instruct', name: 'Llama 3.1 70B Instruct' },
    { id: 'mistralai/Mixtral-8x7B-Instruct-v0.1', name: 'Mixtral 8x7B Instruct' },
  ],
  gemini: [
    { id: 'gemini-2.0-flash-lite', name: 'Gemini 2.0 Flash Lite' },
    { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash' },
    { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
    { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
  ],
  claude: [
    { id: 'claude-sonnet-4-5-20250929', name: 'Claude Sonnet 4.5' },
    { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5' },
    { id: 'claude-sonnet-5', name: 'Claude Sonnet 5' },
    { id: 'claude-opus-5', name: 'Claude Opus 5' },
  ],
  openai: [
    { id: 'gpt-4o-mini', name: 'GPT-4o Mini' },
    { id: 'gpt-4o', name: 'GPT-4o' },
    { id: 'gpt-4-turbo', name: 'GPT-4 Turbo' },
    { id: 'o3-mini', name: 'o3-mini' },
  ],
  grok: [
    { id: 'grok-3-mini', name: 'Grok 3 Mini' },
    { id: 'grok-3', name: 'Grok 3' },
    { id: 'grok-4-fast-non-reasoning', name: 'Grok 4 Fast' },
    { id: 'grok-2-vision-1212', name: 'Grok 2 Vision' },
  ],
  deepseek: [
    { id: 'deepseek-chat', name: 'DeepSeek Chat' },
    { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
  ],
};

/**
 * Model ids the provider has RETIRED, mapped to the current model of the same
 * class. A merchant's stored `selectedModel` outlives a retirement: the
 * provider then answers 404 `not_found_error` on every call, and every AI
 * feature fails until somebody opens Settings and picks a new model — which
 * nothing tells them to do. Resolving here keeps the shop working on the
 * nearest successor instead. Extend it when a provider announces a
 * retirement; an id missing from it simply passes through unchanged.
 */
export const RETIRED_MODEL_REPLACEMENTS: Partial<Record<AIProvider, Record<string, string>>> = {
  gemini: {
    'gemini-1.5-flash': 'gemini-2.0-flash',
    'gemini-1.5-pro': 'gemini-2.5-pro',
  },
  claude: {
    'claude-3-5-haiku-20241022': 'claude-haiku-4-5',
    'claude-3-5-haiku-latest': 'claude-haiku-4-5',
    'claude-3-haiku-20240307': 'claude-haiku-4-5',
    'claude-3-5-sonnet-20240620': 'claude-sonnet-4-5-20250929',
    'claude-3-5-sonnet-20241022': 'claude-sonnet-4-5-20250929',
    'claude-3-5-sonnet-latest': 'claude-sonnet-4-5-20250929',
    'claude-3-7-sonnet-20250219': 'claude-sonnet-4-5-20250929',
    'claude-3-7-sonnet-latest': 'claude-sonnet-4-5-20250929',
    'claude-3-sonnet-20240229': 'claude-sonnet-4-5-20250929',
    'claude-3-opus-20240229': 'claude-opus-5',
    'claude-3-opus-latest': 'claude-opus-5',
    // Never a valid id — the app's own picker offered it until 2026-10.
    'claude-opus-4-0-20250514': 'claude-opus-5',
  },
};

/** The id to actually send: a retired one becomes its successor. */
export function resolveModelId(provider: AIProvider, model: string): string {
  return RETIRED_MODEL_REPLACEMENTS[provider]?.[model] ?? model;
}
