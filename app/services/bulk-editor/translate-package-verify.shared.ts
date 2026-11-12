/**
 * Per-entry verification of a package answer (PLAN_BULK_TRANSLATE_BATCHING
 * 3.1). A package puts many unrelated texts into one answer, which adds a
 * failure class the per-row path never had: entries swapped, merged or cut
 * off. Nothing is written unless EVERY check below passes for that entry and
 * language; a failing entry goes down the retry ladder, and the source is
 * never used as its translation.
 *
 * Pure and import-light: testable without a provider.
 */

import { TRANSLATION_BATCH } from "~/config/constants";
import type { PackageItem, PackageKind } from "./translate-packages.shared";

export type VerifyFailure =
  | "missing"
  | "empty"
  | "newline"
  | "length"
  | "protectedTokens"
  | "numbers"
  | "echo"
  | "htmlSkeleton"
  | "lineCount";

export interface VerifyOptions {
  kind: PackageKind;
  source: string;
  translation: unknown;
  /** Compare digit runs / SKU-like tokens (swap detection). Off for a single
   *  entry answered alone: with nothing to swap with, spelling a number out is
   *  a legitimate translation. */
  strictNumbers: boolean;
}

const PROTECTED_TOKEN = /\{\{[^}]*\}\}|\{%[^%]*%\}|%[sd]|%\([a-z_]+\)s|\[[a-z_]+(?:\s[^\]]*)?\]|\{\d+\}/gi;
const SKU_LIKE = /\b[A-Z0-9]{2,}(?:[-_./][A-Z0-9]+)+\b/g;
const DIGIT_RUN = /\d+/g;
const HTML_TAG = /<\/?([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>/g;
const PRESERVED_ATTRS = /\b(href|src|id|class)\s*=\s*("[^"]*"|'[^']*')/gi;

function multiset(values: string[]): string {
  return [...values].sort().join("\u0001");
}

const matchAll = (text: string, re: RegExp): string[] => {
  const out: string[] = [];
  for (const m of text.matchAll(new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`))) out.push(m[0]);
  return out;
};

export function hasHtml(text: string): boolean {
  return /<\/?[a-zA-Z][^>]*>/.test(text);
}

/** `null` = the translation passes; otherwise the first check it fails. */
export function verifyTranslation(opts: VerifyOptions): VerifyFailure | null {
  const { kind, source, translation, strictNumbers } = opts;
  if (translation === undefined || translation === null) return "missing";
  if (typeof translation !== "string") return "missing";
  const out = translation.trim();
  if (out === "") return "empty";
  const src = source.trim();

  if (kind !== "long" && /[\r\n]/.test(out)) return "newline";

  // A translation can be 4x longer for a short label and rarely more.
  if (kind !== "long" && out.length > src.length * 4 + 20) return "length";

  if (multiset(matchAll(src, PROTECTED_TOKEN)) !== multiset(matchAll(out, PROTECTED_TOKEN))) {
    return "protectedTokens";
  }

  if (strictNumbers && kind !== "handle") {
    if (multiset(matchAll(src, DIGIT_RUN)) !== multiset(matchAll(out, DIGIT_RUN))) return "numbers";
    if (multiset(matchAll(src, SKU_LIKE)) !== multiset(matchAll(out, SKU_LIKE))) return "numbers";
  }

  // A full paragraph never legitimately equals its source (N-H3).
  if (out === src && src.length >= TRANSLATION_BATCH.ECHO_FAILURE_MIN_CHARS) return "echo";

  if (kind === "long") {
    if (hasHtml(src)) {
      const tags = (text: string) =>
        [...text.matchAll(new RegExp(HTML_TAG.source, "g"))].map(
          (m) => `${m[0].startsWith("</") ? "/" : ""}${m[1].toLowerCase()}`,
        );
      if (multiset(tags(src)) !== multiset(tags(out))) return "htmlSkeleton";
      const attrs = (text: string) => matchAll(text, PRESERVED_ATTRS).map((a) => a.replace(/\s+/g, "").toLowerCase());
      if (multiset(attrs(src)) !== multiset(attrs(out))) return "htmlSkeleton";
    } else {
      const lines = (text: string) => (text.match(/\n/g) ?? []).length;
      if (lines(src) !== lines(out)) return "lineCount";
    }
  }
  return null;
}

// ── Answer parsing ──────────────────────────────────────────────────────────

export interface ItemVerdict {
  /** Locales whose translation passed. */
  accepted: Record<string, string>;
  /** Locales that did not, with the first failing check. */
  rejected: Record<string, VerifyFailure>;
}

/**
 * The parsed model answer `{ localId: { locale: text } }` judged per item and
 * per language. Unknown ids and locales in the answer are ignored (never
 * written); `idOf` maps each item to the package-local id it was sent as.
 */
export function judgePackageAnswer(
  items: PackageItem[],
  idOf: Map<string, string>,
  parsed: unknown,
): Map<string, ItemVerdict> {
  const verdicts = new Map<string, ItemVerdict>();
  const root =
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  for (const item of items) {
    const verdict: ItemVerdict = { accepted: {}, rejected: {} };
    const rawBucket = root[idOf.get(item.key) ?? ""];
    const bucket =
      rawBucket !== null && typeof rawBucket === "object" && !Array.isArray(rawBucket)
        ? (rawBucket as Record<string, unknown>)
        : null;
    for (const locale of item.locales) {
      const failure = bucket
        ? verifyTranslation({
            kind: item.kind,
            source: item.source,
            translation: bucket[locale],
            // Swaps can only happen between entries: any multi-item package.
            strictNumbers: items.length > 1,
          })
        : "missing";
      if (failure) verdict.rejected[locale] = failure;
      else verdict.accepted[locale] = (bucket![locale] as string).trim();
    }
    verdicts.set(item.key, verdict);
  }
  return verdicts;
}
