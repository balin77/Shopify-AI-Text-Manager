import { describe, it, expect } from 'vitest';
import {
  unconfirmedClearedFieldSet,
  unconfirmedClearedOnlyKeys,
  unconfirmedFieldsMessage,
  keepFailedAltsDirty,
} from '../../app/services/editor/unconfirmed-cleared.shared';

describe('the fields a foreign save did not store stay dirty', () => {
  it('unions cleared-unconfirmed, written-unconfirmed and skipped fields', () => {
    const set = unconfirmedClearedFieldSet({
      unconfirmedClearedFields: ['seoTitle'],
      unconfirmedFields: ['title', 'seoTitle'],
      skippedFields: ['handle'],
    });
    expect([...set].sort()).toEqual(['handle', 'seoTitle', 'title']);
  });

  it('is empty for an ordinary save and for junk', () => {
    expect(unconfirmedClearedFieldSet({ success: true }).size).toBe(0);
    expect(unconfirmedClearedFieldSet(null).size).toBe(0);
    expect(unconfirmedClearedFieldSet({ unconfirmedFields: 'title' }).size).toBe(0);
  });

  it('keeps the unconfirmed fields out of the cache overlay', () => {
    const only = unconfirmedClearedOnlyKeys(null, ['title', 'handle', 'description'], new Set(['handle']));
    expect([...only!].sort()).toEqual(['description', 'title']);
  });
});

describe('unconfirmedFieldsMessage names LABELS in the merchant\'s language', () => {
  const templates = { unconfirmed: 'Not confirmed: {fields}.', skipped: 'Not saved: {fields} equals the main language.' };
  const labelOf = (k: string) => ({ title: 'Titel', seoTitle: 'SEO-Titel', handle: 'URL-Handle' }[k] ?? k);

  it('lists labels, never translation keys', () => {
    const text = unconfirmedFieldsMessage({ unconfirmedFields: ['title', 'seoTitle'] }, labelOf, templates);
    expect(text).toBe('Not confirmed: Titel, SEO-Titel.');
    expect(text).not.toContain('meta_title');
  });

  it('says why a skipped handle was not written', () => {
    expect(unconfirmedFieldsMessage({ skippedFields: ['handle'] }, labelOf, templates)).toBe(
      'Not saved: URL-Handle equals the main language.',
    );
  });

  it('is empty when the response names nothing', () => {
    expect(unconfirmedFieldsMessage({ success: true }, labelOf, templates)).toBe('');
  });
});

describe('keepFailedAltsDirty', () => {
  it('a failed alt keeps the baseline it had before the save; the others take the saved value', () => {
    const base = { 0: 'neu0', 1: 'neu1' };
    const typed = { 0: 'neu0', 1: 'neu1' };
    const prev = { 0: 'alt0', 1: 'alt1' };
    expect(keepFailedAltsDirty(base, [1], typed)(prev)).toEqual({ 0: 'neu0', 1: 'alt1' });
  });

  it('a failed alt with no previous baseline is dropped (it was empty before)', () => {
    expect(keepFailedAltsDirty({ 0: 'x' }, [0], { 0: 'x' })({})).toEqual({});
  });

  it('leaves an index the base already rolled back (a failed copy) alone', () => {
    // base[0] was restored to the pre-copy value by altBaselineSnapshot.
    expect(keepFailedAltsDirty({ 0: 'vorher' }, [0], { 0: 'kopiert' })({ 0: 'kopiert' })).toEqual({ 0: 'vorher' });
  });

  it('is idempotent: applying it to its own result changes nothing', () => {
    const fn = keepFailedAltsDirty({ 0: 'neu' }, [0], { 0: 'neu' });
    const once = fn({ 0: 'alt' });
    expect(fn(once)).toEqual(once);
  });

  it('is the base itself when nothing failed', () => {
    const base = { 0: 'a' };
    expect(keepFailedAltsDirty(base, [], base)({ 0: 'zzz' })).toBe(base);
  });
});
