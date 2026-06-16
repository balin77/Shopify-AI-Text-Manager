import { describe, it, expect, vi } from 'vitest';

// tryDecryptApiKey is the only side-effectful dependency of the gate helper.
// Identity mock: whatever is stored is treated as the decrypted value
// (null/undefined → null, mirroring the real "not set / undecryptable" case).
vi.mock('../../app/utils/encryption.server', () => ({
  decryptApiKey: (v: string | null | undefined) => v ?? null,
  tryDecryptApiKey: (v: string | null | undefined) => v ?? null,
}));

import { getMissingPreferredKey } from '../../app/routes/api-ai-handlers/shared';
import type { AISettings } from '@prisma/client';

function settings(partial: Partial<AISettings>): AISettings {
  return { preferredProvider: 'huggingface', ...partial } as AISettings;
}

describe('getMissingPreferredKey (Option A compliance gate)', () => {
  it('returns the provider info when no settings record exists', () => {
    // No settings → toValidProvider(undefined) falls back to the default 'claude'.
    const result = getMissingPreferredKey(null);
    expect(result).not.toBeNull();
    expect(result?.provider).toBe('claude');
    expect(result?.displayName).toBe('Anthropic Claude');
  });

  it('returns the provider info when the preferred provider has no key', () => {
    const result = getMissingPreferredKey(
      settings({ preferredProvider: 'openai', openaiApiKey: null })
    );
    expect(result).toEqual({ provider: 'openai', displayName: 'OpenAI GPT' });
  });

  it('treats a blank/whitespace key as missing', () => {
    const result = getMissingPreferredKey(
      settings({ preferredProvider: 'claude', claudeApiKey: '   ' })
    );
    expect(result?.provider).toBe('claude');
  });

  it('returns null when the preferred provider has a usable key', () => {
    const result = getMissingPreferredKey(
      settings({ preferredProvider: 'gemini', geminiApiKey: 'merchant-gemini-key' })
    );
    expect(result).toBeNull();
  });

  it('only checks the preferred provider, ignoring other providers keys', () => {
    // Has an OpenAI key but prefers DeepSeek (no key) → still blocked.
    const result = getMissingPreferredKey(
      settings({
        preferredProvider: 'deepseek',
        openaiApiKey: 'some-openai-key',
        deepseekApiKey: null,
      })
    );
    expect(result?.provider).toBe('deepseek');
  });
});
