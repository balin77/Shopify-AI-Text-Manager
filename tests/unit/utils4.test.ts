/**
 * Unit Tests — API Key Validation + Translation Timing (Task 50 coverage increase)
 *
 * Covers:
 * - api-key-validation.ts (hasApiKeyForProvider, hasPreferredProviderKey, getConfiguredProviders, hasAnyApiKey, getProviderDisplayName)
 * - translation-timing.ts (markRecentlySaved, wasRecentlySaved)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ============================================================
// api-key-validation.ts
// ============================================================
import {
  hasApiKeyForProvider,
  hasPreferredProviderKey,
  getConfiguredProviders,
  hasAnyApiKey,
  getProviderDisplayName,
  type AISettings,
} from '~/utils/api-key-validation';

const emptySettings: AISettings = {};

const fullSettings: AISettings = {
  huggingfaceApiKey: 'hf_abc123',
  geminiApiKey: 'AIzaSy_abc',
  claudeApiKey: 'sk-ant-abc',
  openaiApiKey: 'sk-abc',
  grokApiKey: 'xai-abc',
  deepseekApiKey: 'sk-dead',
  preferredProvider: 'claude',
};

describe('hasApiKeyForProvider', () => {
  it('returns true when key is set', () => {
    expect(hasApiKeyForProvider({ claudeApiKey: 'sk-ant-test' }, 'claude')).toBe(true);
    expect(hasApiKeyForProvider({ openaiApiKey: 'sk-test' }, 'openai')).toBe(true);
    expect(hasApiKeyForProvider({ huggingfaceApiKey: 'hf_test' }, 'huggingface')).toBe(true);
    expect(hasApiKeyForProvider({ geminiApiKey: 'AI-test' }, 'gemini')).toBe(true);
    expect(hasApiKeyForProvider({ grokApiKey: 'xai-test' }, 'grok')).toBe(true);
    expect(hasApiKeyForProvider({ deepseekApiKey: 'sk-abc' }, 'deepseek')).toBe(true);
  });

  it('returns false when key is null or undefined', () => {
    expect(hasApiKeyForProvider(emptySettings, 'claude')).toBe(false);
    expect(hasApiKeyForProvider({ claudeApiKey: null }, 'claude')).toBe(false);
  });

  it('returns false when key is empty string', () => {
    expect(hasApiKeyForProvider({ openaiApiKey: '' }, 'openai')).toBe(false);
    expect(hasApiKeyForProvider({ openaiApiKey: '   ' }, 'openai')).toBe(false);
  });

  it('returns false for unknown provider (default case)', () => {
    // @ts-expect-error testing runtime default case
    expect(hasApiKeyForProvider(fullSettings, 'unknown_provider')).toBe(false);
  });
});

describe('hasPreferredProviderKey', () => {
  it('returns true when preferred provider has a key', () => {
    expect(hasPreferredProviderKey(fullSettings)).toBe(true);
  });

  it('returns false when no preferred provider is set', () => {
    expect(hasPreferredProviderKey(emptySettings)).toBe(false);
  });

  it('returns false when preferred provider key is missing', () => {
    const settings: AISettings = { preferredProvider: 'openai' };
    expect(hasPreferredProviderKey(settings)).toBe(false);
  });
});

describe('getConfiguredProviders', () => {
  it('returns empty array when no keys are configured', () => {
    expect(getConfiguredProviders(emptySettings)).toEqual([]);
  });

  it('returns only configured providers', () => {
    const settings: AISettings = { claudeApiKey: 'sk-ant-test', openaiApiKey: 'sk-test' };
    const result = getConfiguredProviders(settings);
    expect(result).toContain('claude');
    expect(result).toContain('openai');
    expect(result).not.toContain('gemini');
  });

  it('returns all providers when all keys are set', () => {
    const result = getConfiguredProviders(fullSettings);
    expect(result).toHaveLength(6);
  });
});

describe('hasAnyApiKey', () => {
  it('returns false when no keys configured', () => {
    expect(hasAnyApiKey(emptySettings)).toBe(false);
  });

  it('returns true when at least one key is configured', () => {
    expect(hasAnyApiKey({ claudeApiKey: 'sk-ant-abc' })).toBe(true);
  });
});

describe('getProviderDisplayName', () => {
  it('returns human-readable names for each provider', () => {
    expect(getProviderDisplayName('huggingface')).toBe('Hugging Face');
    expect(getProviderDisplayName('gemini')).toBe('Google Gemini');
    expect(getProviderDisplayName('claude')).toBe('Anthropic Claude');
    expect(getProviderDisplayName('openai')).toBe('OpenAI GPT');
    expect(getProviderDisplayName('grok')).toBe('Grok (X.AI)');
    expect(getProviderDisplayName('deepseek')).toBe('DeepSeek');
  });
});

// ============================================================
// translation-timing.ts
// ============================================================
import { markRecentlySaved, wasRecentlySaved } from '~/utils/translation-timing';

describe('translation-timing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns false for an item that has not been marked', () => {
    expect(wasRecentlySaved('item-not-saved')).toBe(false);
  });

  it('returns true immediately after marking', () => {
    markRecentlySaved('item-1');
    expect(wasRecentlySaved('item-1')).toBe(true);
  });

  it('returns true within the default 60s TTL', () => {
    markRecentlySaved('item-2');
    vi.advanceTimersByTime(59_000);
    expect(wasRecentlySaved('item-2')).toBe(true);
  });

  it('returns false after the default TTL has expired', () => {
    markRecentlySaved('item-3');
    vi.advanceTimersByTime(61_000);
    expect(wasRecentlySaved('item-3')).toBe(false);
  });

  it('respects a custom TTL', () => {
    markRecentlySaved('item-4');
    vi.advanceTimersByTime(5_000);
    expect(wasRecentlySaved('item-4', 10_000)).toBe(true);
    vi.advanceTimersByTime(6_000);
    expect(wasRecentlySaved('item-4', 10_000)).toBe(false);
  });
});
