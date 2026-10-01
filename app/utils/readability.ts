/**
 * Readability analysis for merchant copy — pure, framework-free, client-safe.
 *
 * Yoast's signature feature, and the one thing the SEO leaders offer that this
 * app did not. Built the way the rest of this codebase reports: structure
 * findings that hold in EVERY language are always computed, and the single
 * number people recognise (a reading-ease score) is only produced for the
 * languages that actually have a validated formula. A Flesch value computed
 * with English coefficients over Finnish text is not a rough estimate, it is a
 * wrong number with a familiar name — so for other locales the score is `null`
 * and the UI says why instead of printing one anyway.
 *
 * This matters more here than in a single-language SEO app: the editor shows
 * every locale of an item, so the analysis runs against whichever language the
 * merchant is looking at.
 *
 * Deliberately NOT included: passive-voice and transition-word detection. Both
 * need per-language word lists to be anything but noise, and a false "too much
 * passive voice" on a German product description is exactly the kind of finding
 * that teaches merchants to ignore the panel.
 */

/** Below this many words there is nothing to judge. */
export const MIN_WORDS_FOR_ANALYSIS = 40;

/** A sentence longer than this counts as long. */
export const LONG_SENTENCE_WORDS = 25;

/** Warn once this share of sentences is long. */
export const LONG_SENTENCE_SHARE_LIMIT = 0.25;

/** A paragraph longer than this is a wall of text. */
export const LONG_PARAGRAPH_WORDS = 150;

/** Above this many words, copy without any subheading is hard to scan. */
export const SUBHEADING_EXPECTED_WORDS = 300;

export type ReadabilityFindingCode =
  | "longSentences"
  | "longParagraphs"
  | "noSubheadings";

export interface ReadabilityFinding {
  code: ReadabilityFindingCode;
  /** Placeholder values for the i18n message. */
  data?: Record<string, number>;
}

export type ReadingEaseFormula = "flesch" | "amstad" | "fernandezHuerta";

export type ReadingEaseBand = "easy" | "medium" | "hard";

export interface ReadabilityReport {
  words: number;
  sentences: number;
  paragraphs: number;
  /** Rounded to one decimal. 0 when there are no sentences. */
  avgSentenceWords: number;
  longSentences: number;
  longestParagraphWords: number;
  hasSubheadings: boolean;
  /**
   * Reading ease, 0–100, or null when this locale has no validated formula.
   * Clamped: the raw formulas can exceed the nominal range on extreme input.
   */
  readingEase: number | null;
  readingEaseFormula: ReadingEaseFormula | null;
  readingEaseBand: ReadingEaseBand | null;
  /** Fewer than MIN_WORDS_FOR_ANALYSIS words: findings are suppressed. */
  tooShort: boolean;
  findings: ReadabilityFinding[];
}

/**
 * Vowel characters per language family, for the syllable estimate. Global
 * regexes, shared: `String.match` with a global pattern ignores `lastIndex`
 * and returns every match, so one instance can be reused for the whole text.
 * Building one per word is what made this hot — the analysis runs inside a
 * memo keyed on the live editor value, i.e. on every keystroke.
 */
const VOWELS: Record<string, RegExp> = {
  en: /[aeiouy]+/g,
  de: /[aeiouyäöü]+/g,
  es: /[aeiouyáéíóúü]+/g,
};

interface FormulaDef {
  id: ReadingEaseFormula;
  vowels: RegExp;
  /** score = base - perSentence * (words/sentences) - perSyllable * (syllables/words) */
  base: number;
  perSentence: number;
  perSyllable: number;
}

/**
 * The three formulas that are actually validated for their language.
 *  - English: Flesch Reading Ease.
 *  - German: Amstad's German adaptation.
 *  - Spanish: Fernández Huerta (stated per 100 words in the original;
 *    0.60 per syllable-per-100-words is 60 per syllable-per-word).
 */
const FORMULAS: Record<string, FormulaDef> = {
  en: { id: "flesch", vowels: VOWELS.en, base: 206.835, perSentence: 1.015, perSyllable: 84.6 },
  de: { id: "amstad", vowels: VOWELS.de, base: 180, perSentence: 1, perSyllable: 58.5 },
  es: {
    id: "fernandezHuerta",
    vowels: VOWELS.es,
    base: 206.84,
    perSentence: 1.02,
    perSyllable: 60,
  },
};

/** Base language of a locale tag ("de-DE" → "de"). Empty input yields "". */
export function baseLanguage(locale: string | null | undefined): string {
  return (locale || "").trim().toLowerCase().split(/[-_]/)[0];
}

/** True when this locale has a reading-ease formula we are willing to print. */
export function hasReadingEaseFormula(locale: string | null | undefined): boolean {
  return !!FORMULAS[baseLanguage(locale)];
}

/**
 * Block-level tags whose boundaries end a paragraph. Kept explicit rather than
 * "any tag": an inline <strong> inside a sentence must not split it.
 */
const BLOCK_TAGS = /<\/?(p|div|br|li|ul|ol|h[1-6]|table|tr|blockquote|section|article)[^>]*>/gi;

const SUBHEADING_TAGS = /<h[2-6][^>]*>/i;

/** Plain-text blocks of an HTML string, one entry per block-level chunk. */
export function textBlocks(html: string | null | undefined): string[] {
  if (!html) return [];
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(BLOCK_TAGS, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .split("\n")
    .map((block) => block.replace(/\s+/g, " ").trim())
    .filter((block) => block.length > 0);
}

function words(text: string): string[] {
  // Unicode-aware: a German or Spanish word must not split on its accents.
  return text.split(/[^\p{L}\p{N}'’-]+/u).filter((w) => w.length > 0);
}

/** Sentences of a text block. A block with no terminator is one sentence. */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…])[\s"'»”)]*\s+/u)
    .map((s) => s.trim())
    .filter((s) => words(s).length > 0);
}

/**
 * Syllable estimate: count vowel groups, at least one per word. Crude by
 * design — every reading-ease implementation outside a full pronunciation
 * dictionary does this, and the formulas were calibrated on counts like it.
 */
export function estimateSyllables(word: string, vowels: RegExp): number {
  const groups = word.toLowerCase().match(vowels);
  return Math.max(1, groups ? groups.length : 0);
}

export function analyzeReadability(
  html: string | null | undefined,
  locale?: string | null,
): ReadabilityReport {
  const blocks = textBlocks(html);

  // ONE tokenization pass for the whole text: every later number is derived
  // from these arrays instead of re-splitting the block, the sentence and the
  // paragraph separately (three passes over a description on every keystroke).
  const allWords: string[] = [];
  let sentenceCount = 0;
  let longSentences = 0;
  let longestParagraphWords = 0;

  for (const block of blocks) {
    let blockWords = 0;
    for (const sentence of sentences(block)) {
      const sentenceWords = words(sentence);
      sentenceCount++;
      if (sentenceWords.length > LONG_SENTENCE_WORDS) longSentences++;
      blockWords += sentenceWords.length;
      for (const word of sentenceWords) allWords.push(word);
    }
    if (blockWords > longestParagraphWords) longestParagraphWords = blockWords;
  }

  const wordCount = allWords.length;
  const paragraphCount = blocks.length;
  const hasSubheadings = SUBHEADING_TAGS.test(html || "");

  const avgSentenceWords =
    sentenceCount > 0 ? Math.round((wordCount / sentenceCount) * 10) / 10 : 0;

  const formula = FORMULAS[baseLanguage(locale)];
  let readingEase: number | null = null;
  if (formula && sentenceCount > 0 && wordCount > 0) {
    const syllables = allWords.reduce((sum, w) => sum + estimateSyllables(w, formula.vowels), 0);
    const raw =
      formula.base -
      formula.perSentence * (wordCount / sentenceCount) -
      formula.perSyllable * (syllables / wordCount);
    readingEase = Math.round(Math.min(100, Math.max(0, raw)));
  }

  const tooShort = wordCount < MIN_WORDS_FOR_ANALYSIS;

  const findings: ReadabilityFinding[] = [];
  if (!tooShort) {
    if (sentenceCount > 0 && longSentences / sentenceCount > LONG_SENTENCE_SHARE_LIMIT) {
      findings.push({
        code: "longSentences",
        // Key names ARE the i18n placeholders — `{sentences}` in every locale.
        data: { count: longSentences, sentences: sentenceCount, limit: LONG_SENTENCE_WORDS },
      });
    }
    if (longestParagraphWords > LONG_PARAGRAPH_WORDS) {
      findings.push({
        code: "longParagraphs",
        data: { words: longestParagraphWords, limit: LONG_PARAGRAPH_WORDS },
      });
    }
    if (wordCount > SUBHEADING_EXPECTED_WORDS && !hasSubheadings) {
      findings.push({ code: "noSubheadings", data: { words: wordCount } });
    }
  }

  return {
    words: wordCount,
    sentences: sentenceCount,
    paragraphs: paragraphCount,
    avgSentenceWords,
    longSentences,
    longestParagraphWords,
    hasSubheadings,
    readingEase,
    readingEaseFormula: readingEase === null ? null : formula.id,
    readingEaseBand:
      readingEase === null ? null : readingEase >= 60 ? "easy" : readingEase >= 30 ? "medium" : "hard",
    tooShort,
    findings,
  };
}
