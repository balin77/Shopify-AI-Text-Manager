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
    { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro' },
    { id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash' },
  ],
  claude: [
    { id: 'claude-sonnet-4-5-20250929', name: 'Claude Sonnet 4.5' },
    { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku' },
    { id: 'claude-opus-4-0-20250514', name: 'Claude Opus 4' },
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
