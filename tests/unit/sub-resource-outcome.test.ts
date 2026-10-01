import { describe, it, expect } from 'vitest';
import { subResourceOutcome } from '../../app/services/editor/sub-resource-outcome.shared';
import { unconfirmedClearedFieldSet, unconfirmedClearedOnlyKeys } from '../../app/services/editor/unconfirmed-cleared.shared';

const strings = {
  translateSubResourcesFailed: 'FAILED {count}',
  translatePartialLocales: 'PARTIAL {successCount}/{totalCount} {failedLocales}',
  subResourceNotTranslatable: 'NOT TRANSLATABLE',
};

describe('subResourceOutcome', () => {
  it('is null for a clean answer', () => {
    expect(subResourceOutcome({ failedResources: [], failedLocales: [], notTranslatable: [] }, strings)).toBeNull();
    expect(subResourceOutcome(undefined, strings)).toBeNull();
  });

  it('every locale failed is critical, never a success', () => {
    const out = subResourceOutcome({ failedLocales: ['fr', 'it'], translatedLocales: [] }, strings);
    expect(out).toEqual({ text: 'PARTIAL 0/2 fr, it', tone: 'critical' });
  });

  it('some locales failed is a warning naming them', () => {
    const out = subResourceOutcome({ failedLocales: ['it'], translatedLocales: ['fr', 'it'] }, strings);
    expect(out).toEqual({ text: 'PARTIAL 1/2 it', tone: 'warning' });
  });

  it('single-locale failure is critical with the count', () => {
    expect(subResourceOutcome({ failedResources: ['a', 'b'] }, strings)).toEqual({ text: 'FAILED 2', tone: 'critical' });
  });

  it('notTranslatable alone is a warning with its own text', () => {
    expect(subResourceOutcome({ notTranslatable: ['a'] }, strings)).toEqual({ text: 'NOT TRANSLATABLE', tone: 'warning' });
  });
});

describe('unconfirmed cleared fields', () => {
  it('reads the field keys defensively', () => {
    expect([...unconfirmedClearedFieldSet({ unconfirmedClearedFields: ['title', 3, ''] })]).toEqual(['title']);
    expect(unconfirmedClearedFieldSet(null).size).toBe(0);
  });

  it('leaves an ordinary save untouched', () => {
    expect(unconfirmedClearedOnlyKeys(null, ['a', 'b'], new Set())).toBeNull();
  });

  it('excludes the unconfirmed field from a full or a partial save', () => {
    expect([...unconfirmedClearedOnlyKeys(null, ['a', 'b'], new Set(['a']))!]).toEqual(['b']);
    expect([...unconfirmedClearedOnlyKeys(new Set(['a', 'b']), ['a', 'b', 'c'], new Set(['b']))!]).toEqual(['a']);
  });
});
