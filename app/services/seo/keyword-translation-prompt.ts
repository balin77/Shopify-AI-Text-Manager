/**
 * Keyword-aware translation: the prompt clause that makes a translation carry
 * the TARGET language's own tracked keywords.
 *
 * Translation used to be rigid — `translateBatchValues` and friends carry a
 * glossary directive but nothing about keywords, so a shop that tracks
 * "jarrón de cerámica" for its Spanish edition got a literal rendering of the
 * German source and had to reach for "Formatieren" per field afterwards. The
 * generation and format paths already work the active locale's keywords in
 * (they send `keywordLocale`); only translation did not.
 *
 * Two rules this clause encodes, both deliberate:
 *
 *  - **Per language, never shared.** A keyword belongs to one (item, locale)
 *    row. Carrying the German keyword into the Spanish text would be worse
 *    than doing nothing, so a locale that tracks nothing gets no clause at all
 *    and is translated exactly as before.
 *  - **Only when it is missing.** A faithful translation often already
 *    contains the keyword; ordering the model to "work it in" regardless is
 *    how a translation turns into a rewrite. The clause is conditional, and
 *    the caller additionally skips languages whose source text already
 *    contains the keyword (see `keywordsMissingFrom`).
 *
 * Pure — no db, no Prisma, no Remix. Callers load the keywords and pass them
 * in, so this stays testable and usable from both `app/` and `src/`.
 */

import { analyzeOnPage } from "./keywords.service";

/** One target language's tracked keywords, as the directive needs them. */
export interface LocaleKeywords {
  /** Shopify locale code of the TARGET language ("" is never valid here). */
  locale: string;
  /** Human-readable language name for the prompt line. */
  localeName: string;
  /** The item's primary keyword in that language, if it tracks one. */
  primary: string | null;
  /** Secondary keywords in that language. */
  secondaries: string[];
}

/**
 * Which of a locale's keywords are NOT already present in the given source
 * text. Uses the same word-boundary matching as the keywords tab, so "tee"
 * does not count as present inside "Garantee".
 *
 * The source text is the PRIMARY-language value: a keyword that already
 * survives translation verbatim (brand names, latinate terms) needs no
 * instruction, and asking for one anyway is pure risk.
 */
export function keywordsMissingFrom(sourceText: string, keywords: string[]): string[] {
  if (!sourceText.trim()) return keywords.filter(Boolean);
  return keywords.filter((keyword) => {
    if (!keyword) return false;
    return !analyzeOnPage({ keyword, bodyHtml: sourceText }).presence.body;
  });
}

/**
 * The clause for ONE target language — used by the long-field path, which
 * translates a single locale per AI request.
 *
 * Returns "" when the language tracks no keywords, so callers can append
 * unconditionally.
 */
export function keywordTranslationDirective(entry: LocaleKeywords): string {
  if (!entry.primary) return "";
  const secondaryClause = entry.secondaries.length
    ? ` If they fit naturally you may also use: ${entry.secondaries
        .map((s) => `"${s}"`)
        .join(", ")} — never more than one per sentence, and never at the cost of the meaning.`
    : "";
  return (
    `\nTarget keyword for ${entry.localeName}: "${entry.primary}". ` +
    `Translate faithfully, but phrase the result so this exact wording appears ONCE — ` +
    `by choosing it over a synonym, not by appending a sentence. ` +
    `If it cannot be used without distorting the meaning, leave the translation as it would ` +
    `otherwise be.${secondaryClause}`
  );
}

/**
 * The clause for SEVERAL target languages at once — used by the short-field
 * path, which translates every locale in a single AI request.
 *
 * Languages without keywords are omitted rather than listed as empty, and the
 * closing rule spells out that the lists are not interchangeable: the single
 * most damaging failure mode here would be the model using the French keyword
 * in the Spanish output.
 */
export function keywordTranslationDirectiveMulti(entries: LocaleKeywords[]): string {
  const withKeywords = entries.filter((e) => e.primary);
  if (withKeywords.length === 0) return "";
  const lines = withKeywords
    .map((e) => {
      const all = [e.primary as string, ...e.secondaries].map((s) => `"${s}"`).join(", ");
      return `- ${e.localeName} (${e.locale}): ${all}`;
    })
    .join("\n");
  return (
    `\nTarget keywords per language — where a language is listed, phrase its translation so the ` +
    `FIRST keyword appears once, by choosing that wording over a synonym rather than by adding text:\n` +
    `${lines}\n` +
    `Use each language's own list only; never carry a keyword into a language it is not listed for, ` +
    `and never distort the meaning to fit one in.`
  );
}
