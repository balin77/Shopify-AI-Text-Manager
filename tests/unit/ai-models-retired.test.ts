import { describe, it, expect } from 'vitest';
import { CURATED_MODELS, DEFAULT_MODELS, RETIRED_MODEL_REPLACEMENTS, resolveModelId } from '~/config/ai-models.config';
import { MODEL_PRICING } from '~/config/ai-pricing';

describe('retired model ids', () => {
  it('a retired stored model resolves to its successor', () => {
    expect(resolveModelId('claude', 'claude-3-5-haiku-20241022')).toBe('claude-haiku-4-5');
  });

  it('an unknown id passes through unchanged', () => {
    expect(resolveModelId('claude', 'claude-sonnet-5')).toBe('claude-sonnet-5');
    expect(resolveModelId('openai', 'gpt-4o-mini')).toBe('gpt-4o-mini');
  });

  it('the picker never offers a retired id, and every successor is priced', () => {
    for (const [provider, map] of Object.entries(RETIRED_MODEL_REPLACEMENTS)) {
      const retired = Object.keys(map ?? {});
      const offered = (CURATED_MODELS as Record<string, { id: string }[]>)[provider].map((m) => m.id);
      expect(offered.filter((id) => retired.includes(id))).toEqual([]);
      expect(retired).not.toContain((DEFAULT_MODELS as Record<string, string>)[provider]);
      for (const successor of Object.values(map ?? {})) {
        expect((MODEL_PRICING as Record<string, Record<string, unknown>>)[provider][successor]).toBeDefined();
      }
    }
  });
});
