/**
 * The glossary editor and the prompt builders must give the SAME answer to
 * "which rule applies to this locale".
 *
 * Before the base-language fallback, an empty `de-CH` field truthfully meant
 * "no rule, the AI translates freely". After it, a stored `de` rule applies -
 * so the same empty field means the opposite, and the editor has to say which.
 * `inheritedGlossaryValue` is what it asks; it resolves through the same walk
 * the builders use, because two copies disagreeing is the state this removes.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveGlossaryValue,
  glossaryValueForLocale,
  inheritedGlossaryValue,
} from '~/services/glossary-locale.shared';

describe('resolveGlossaryValue', () => {
  it('reports the locale a rendering is STORED under, not the one asked for', () => {
    expect(resolveGlossaryValue({ de: 'Kapuzenpulli' }, 'de-CH')).toEqual({
      locale: 'de',
      value: 'Kapuzenpulli',
    });
    expect(resolveGlossaryValue({ 'de-CH': 'Kapuzepulli' }, 'de-CH')).toEqual({
      locale: 'de-CH',
      value: 'Kapuzepulli',
    });
  });

  it('drops one subtag at a time, so the most specific rule wins', () => {
    const t = { zh: 'base', 'zh-Hant': 'traditional' };
    expect(resolveGlossaryValue(t, 'zh-Hant-TW')?.locale).toBe('zh-Hant');
    expect(resolveGlossaryValue({ zh: 'base' }, 'zh-Hant-TW')?.locale).toBe('zh');
  });

  it('never widens upwards, and an unrelated locale gets nothing', () => {
    expect(resolveGlossaryValue({ 'de-CH': 'x' }, 'de')).toBeUndefined();
    expect(resolveGlossaryValue({ de: 'x' }, 'fr-CA')).toBeUndefined();
  });

  it('glossaryValueForLocale is the same walk without the source locale', () => {
    expect(glossaryValueForLocale({ es: 'sudadera' }, 'es-419')).toBe('sudadera');
    expect(glossaryValueForLocale({ es: 'sudadera' }, 'fr')).toBeUndefined();
  });
});

describe('inheritedGlossaryValue', () => {
  // The editor only needs a hint where the empty field would otherwise lie.
  it('reports a rule that applies but is stored elsewhere', () => {
    expect(inheritedGlossaryValue({ de: 'Kapuzenpulli' }, 'de-CH')).toEqual({
      locale: 'de',
      value: 'Kapuzenpulli',
    });
  });

  it('is silent where the locale has its OWN rule - the field shows it already', () => {
    expect(inheritedGlossaryValue({ 'de-CH': 'Kapuzepulli' }, 'de-CH')).toBeUndefined();
    expect(
      inheritedGlossaryValue({ de: 'Kapuzenpulli', 'de-CH': 'Kapuzepulli' }, 'de-CH'),
    ).toBeUndefined();
  });

  it('is silent where nothing applies - the empty field is already truthful', () => {
    expect(inheritedGlossaryValue({}, 'de-CH')).toBeUndefined();
    expect(inheritedGlossaryValue({ fr: 'x' }, 'de-CH')).toBeUndefined();
    expect(inheritedGlossaryValue({ de: 'x' }, 'de')).toBeUndefined();
  });

  it('an empty stored value is no rule, so the base one is inherited and named', () => {
    expect(inheritedGlossaryValue({ de: 'Kapuzenpulli', 'de-CH': '  ' }, 'de-CH')).toEqual({
      locale: 'de',
      value: 'Kapuzenpulli',
    });
  });
});
