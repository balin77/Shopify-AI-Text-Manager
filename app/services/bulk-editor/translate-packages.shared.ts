/**
 * Cross-item PACKAGES for the "add missing translations" run
 * (PLAN_BULK_TRANSLATE_BATCHING 3.1 / 3.2 / 19).
 *
 * Pure and import-light on purpose: the planning is a function of the entries,
 * the model's output ceiling and the rate-limit bucket, so it is testable
 * without a provider and shareable with a later cost preview.
 *
 * The rules that carry it:
 * - A package only ever holds entries of ONE group: (kind, the instruction text
 *   the merchant's wording + SEO caps produce for that field, locale
 *   signature). Two fields with a different cap never share a package -- an
 *   instruction would then hold for a field it does not mean. A package never
 *   translates into a language no entry of it needs.
 * - The size is bounded three ways and the SMALLEST wins: the planned OUTPUT
 *   (the model ceiling times a safety margin, capped at what a request can
 *   deliver inside its timeout), the TPM rail (a package whose estimate exceeds
 *   the bucket's per-minute allowance would never be admitted), and a plain item
 *   count (numbered lists drift past a few dozen entries).
 * - An entry that does not fit a package ALONE is returned as `oversized` and
 *   stays on the pre-existing per-row path, which chunks by language and field.
 * - Identical texts in one group are sent ONCE and the answer fans out to every
 *   owner.
 */

import { TRANSLATION_BATCH } from "~/config/constants";
import { estimateOutputChars } from "~/services/ai/translation-budget.shared";

export type PackageKind = "short" | "value" | "long" | "handle";

/** One thing to translate, before dedup: an owner (a cell or one part of an
 *  option-values cell) wants `source` in `locales`. */
export interface PackageEntry {
  /** Opaque owner key the caller maps the answer back with. */
  owner: string;
  kind: PackageKind;
  /** AI payload field key of the owner (title, seoTitle, a metaobject key ...). */
  fieldKey: string;
  /** Already passed through sanitizePromptInput by the caller. */
  source: string;
  locales: string[];
  /** The merchant's instruction text for THIS field (incl. the SEO caps). */
  instructions?: string;
  /** Extra context, never translated (a handle's title). */
  context?: string;
}

export interface PackageItem {
  /** Stable within the run; the package-local id the model sees is assigned at call time. */
  key: string;
  kind: PackageKind;
  fieldKey: string;
  source: string;
  /** Sorted. */
  locales: string[];
  instructions?: string;
  context?: string;
  /** Every owner this answer is delivered to. */
  owners: string[];
}

export interface TranslatePackage {
  id: string;
  kind: PackageKind;
  /** (kind, instructions, locale signature) -- the unit retry rates are counted per. */
  groupKey: string;
  groupLabel: string;
  instructions?: string;
  locales: string[];
  items: PackageItem[];
}

// ── Sizing constants ────────────────────────────────────────────────────────

/** A request must deliver its answer inside its timeout: ~5 000 output tokens
 *  is ~120-180 s at a pessimistic generation speed (NOT measured). */
export const PACKAGE_OUTPUT_CAP_SYNC = 5000;
/** A BATCH request has no timeout to fit inside (the provider works through it
 *  within its own window), so its packages may be much larger. 32 000 is the
 *  plan's figure; the QUALITY of such large packages is not measured, which is
 *  why the per-entry verification and the retry cap exist. */
export const PACKAGE_OUTPUT_CAP_BATCH = 32000;
/** Share of a model's output ceiling a package may plan to use. */
export const PACKAGE_OUTPUT_SAFETY = 0.6;
/** Share of a bucket's per-minute token allowance one package may estimate to. */
export const PACKAGE_TPM_SHARE = 0.8;
/** Numbered lists past this many entries get merged or mis-numbered. The
 *  existing value path's experience, not re-measured. */
export const PACKAGE_MAX_ITEMS = TRANSLATION_BATCH.VALUE_BATCH_MAX_ITEMS;
/** Estimated tokens of the fixed rules/skeleton of a package prompt. */
export const PACKAGE_PREFIX_TOKENS = 250;
/** Sent max_tokens = planned x this (bounded by the model's ceiling). */
export const PACKAGE_MAX_TOKENS_HEADROOM = 1.5;
/** Pessimistic generation speed the request timeout is sized with. */
const TOKENS_PER_SECOND = 30;

export interface PackageBudget {
  /** Planned OUTPUT tokens per package. */
  outputTokens: number;
  /** Ceiling for input + planned output (the TPM rail); null = no bucket known. */
  totalTokens: number | null;
  maxItems: number;
}

/** The budget for a model and a bucket. `modelMaxOutput` from maxOutputTokensFor. */
export function packageBudgetFor(opts: {
  modelMaxOutput: number;
  bucketTpm: number | null;
  outputCap?: number;
  maxItems?: number;
}): PackageBudget {
  const cap = opts.outputCap ?? PACKAGE_OUTPUT_CAP_SYNC;
  return {
    outputTokens: Math.max(256, Math.min(Math.floor(opts.modelMaxOutput * PACKAGE_OUTPUT_SAFETY), cap)),
    totalTokens:
      opts.bucketTpm && opts.bucketTpm > 0 ? Math.floor(opts.bucketTpm * PACKAGE_TPM_SHARE) : null,
    maxItems: opts.maxItems ?? PACKAGE_MAX_ITEMS,
  };
}

/** Planned output tokens of one item (pessimistic, JSON skeleton included). */
export function outputTokensForChars(sourceChars: number, localeCount: number): number {
  const chars = estimateOutputChars(sourceChars, localeCount);
  const text = Math.ceil((chars / TRANSLATION_BATCH.CHARS_PER_OUTPUT_TOKEN) * (1 + TRANSLATION_BATCH.JSON_STRUCTURE_RESERVE));
  return text + 12 * Math.max(1, localeCount) + 12;
}

export function itemOutputTokens(item: Pick<PackageItem, "source" | "locales">): number {
  return outputTokensForChars(item.source.length, item.locales.length);
}

/** Estimated input tokens of one item (~4 characters per token, like the queue). */
export function itemInputTokens(item: Pick<PackageItem, "source" | "context">): number {
  return Math.ceil(((item.source?.length ?? 0) + (item.context?.length ?? 0) + 40) / 4);
}

export function packagePlannedOutputTokens(pkg: Pick<TranslatePackage, "items">): number {
  return pkg.items.reduce((sum, item) => sum + itemOutputTokens(item), 0);
}

export function packageInputTokens(pkg: Pick<TranslatePackage, "items" | "instructions">): number {
  return (
    PACKAGE_PREFIX_TOKENS +
    Math.ceil((pkg.instructions?.length ?? 0) / 4) +
    pkg.items.reduce((sum, item) => sum + itemInputTokens(item), 0)
  );
}

/** The `max_tokens` a package request is sent with. */
export function packageMaxTokens(planned: number, modelMaxOutput: number): number {
  return Math.max(256, Math.min(modelMaxOutput, Math.ceil(planned * PACKAGE_MAX_TOKENS_HEADROOM)));
}

/** Request timeout sized to the planned output: 120-240 s. */
export function packageTimeoutMs(plannedOutputTokens: number): number {
  const ms = Math.ceil(plannedOutputTokens / TOKENS_PER_SECOND) * 1000 + 30_000;
  return Math.min(240_000, Math.max(120_000, ms));
}

// ── Grouping and dedup ──────────────────────────────────────────────────────

export const localeSignature = (locales: string[]): string => [...new Set(locales)].sort().join(",");

/** Tiny stable hash for labels and keys -- not for security. */
function shortHash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export function groupKeyOf(entry: Pick<PackageEntry, "kind" | "instructions" | "locales">): string {
  return `${entry.kind}|${entry.instructions ?? ""}|${localeSignature(entry.locales)}`;
}

function groupLabelOf(entry: Pick<PackageEntry, "kind" | "instructions" | "locales">): string {
  return `${entry.kind}/${localeSignature(entry.locales)}/${shortHash(entry.instructions ?? "")}`;
}

/**
 * Entries -> items: identical (group, context, source) collapse into ONE item
 * with every owner, in first-seen order.
 */
export function buildPackageItems(entries: PackageEntry[]): PackageItem[] {
  const byKey = new Map<string, PackageItem>();
  const items: PackageItem[] = [];
  for (const entry of entries) {
    const dedupKey = `${groupKeyOf(entry)}\u0000${entry.context ?? ""}\u0000${entry.source}`;
    const existing = byKey.get(dedupKey);
    if (existing) {
      existing.owners.push(entry.owner);
      continue;
    }
    const item: PackageItem = {
      key: `i${items.length}`,
      kind: entry.kind,
      fieldKey: entry.fieldKey,
      source: entry.source,
      locales: [...new Set(entry.locales)].sort(),
      ...(entry.instructions ? { instructions: entry.instructions } : {}),
      ...(entry.context ? { context: entry.context } : {}),
      owners: [entry.owner],
    };
    byKey.set(dedupKey, item);
    items.push(item);
  }
  return items;
}

export interface PackagePlan {
  packages: TranslatePackage[];
  /** Items that do not fit a package ALONE (output or TPM rail). */
  oversized: PackageItem[];
}

/**
 * Items -> packages. Greedy, in item order within each group; groups keep their
 * first-seen order. `idPrefix` makes package ids unique across plans.
 */
export function planPackages(items: PackageItem[], budget: PackageBudget, idPrefix = "p"): PackagePlan {
  const groups = new Map<string, PackageItem[]>();
  for (const item of items) {
    const key = groupKeyOf(item);
    const list = groups.get(key);
    if (list) list.push(item);
    else groups.set(key, [item]);
  }

  const packages: TranslatePackage[] = [];
  const oversized: PackageItem[] = [];
  const fits = (output: number, input: number): boolean =>
    output <= budget.outputTokens &&
    (budget.totalTokens === null || input + Math.ceil(output * 1.1) <= budget.totalTokens);

  for (const [groupKey, list] of groups) {
    const first = list[0];
    const instructionTokens = PACKAGE_PREFIX_TOKENS + Math.ceil((first.instructions?.length ?? 0) / 4);
    let current: PackageItem[] = [];
    let curOut = 0;
    let curIn = instructionTokens;
    const close = () => {
      if (current.length === 0) return;
      packages.push({
        id: `${idPrefix}${packages.length}`,
        kind: first.kind,
        groupKey,
        groupLabel: groupLabelOf(first),
        ...(first.instructions ? { instructions: first.instructions } : {}),
        locales: [...first.locales],
        items: current,
      });
      current = [];
      curOut = 0;
      curIn = instructionTokens;
    };
    for (const item of list) {
      const out = itemOutputTokens(item);
      const inp = itemInputTokens(item);
      if (!fits(out, instructionTokens + inp)) {
        oversized.push(item);
        continue;
      }
      if (current.length >= budget.maxItems || !fits(curOut + out, curIn + inp)) close();
      current.push(item);
      curOut += out;
      curIn += inp;
    }
    close();
  }
  return { packages, oversized };
}

/** Two packages of (about) half the items each; one item stays one. */
export function halvePackage(pkg: TranslatePackage): TranslatePackage[] {
  if (pkg.items.length <= 1) return [pkg];
  const mid = Math.ceil(pkg.items.length / 2);
  return [
    { ...pkg, id: `${pkg.id}a`, items: pkg.items.slice(0, mid) },
    { ...pkg, id: `${pkg.id}b`, items: pkg.items.slice(mid) },
  ];
}

/** One package per item. */
export function singlePackages(pkg: TranslatePackage): TranslatePackage[] {
  return pkg.items.map((item, i) => ({ ...pkg, id: `${pkg.id}s${i}`, items: [item] }));
}
