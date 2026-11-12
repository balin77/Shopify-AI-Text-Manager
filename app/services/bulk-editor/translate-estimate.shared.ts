/**
 * Cost PREVIEW of an "add missing translations" run
 * (PLAN_BULK_TRANSLATE_BATCHING 3.4, phase 1c).
 *
 * Pure: a function of the run's jobs, the model's limits and the price table,
 * so the handler's `estimateOnly` answer and the tests share it. It asks the
 * SAME planner the run uses (`buildPackageItems` / `planPackages`) when the
 * package switch is on, so the number of requests is the run's own.
 *
 * Every figure LEANS HIGH, on purpose -- an estimate that errs cheap is the one
 * that understates a bill:
 * - ~3 characters per input token (the pessimistic rule the AI service uses),
 *   output from the same `itemOutputTokens` the packages plan with;
 * - identical texts are NOT collapsed in the per-row estimate and the
 *   productType cache is ignored;
 * - the whole source is counted again for every locale chunk the runner makes
 *   (`planLocaleChunks`, the same budget helpers), the merchant's instructions
 *   ride on every request, and the glossary directive on every request too;
 * - an allowance for the retry ladder (RETRY_ALLOWANCE) on requests and tokens;
 * - an unknown model is priced at the provider's ceiling (`priceCall`).
 * It never writes anything and never calls a provider.
 */

import { TRANSLATION_BATCH } from "~/config/constants";
import { priceCall } from "~/config/ai-pricing";
import {
  PACKAGE_CACHE_MIN_GROUP_PACKAGES,
  PACKAGE_CACHE_MIN_PREFIX_TOKENS,
  geminiThinkingAllowanceTokens,
} from "~/config/ai-model-limits";
import type { AIProvider } from "~/utils/api-key-validation";
import { LIST_DISPLAY_SEPARATOR, type ColumnDescriptor } from "./columns.shared";
import { perLocaleSourceBudgetChars, planLocaleChunks, fitsOneRequest } from "~/services/ai/translation-budget.shared";
import {
  PACKAGE_PREFIX_TOKENS,
  buildPackageItems,
  itemOutputTokens,
  outputTokensForChars,
  packageBudgetFor,
  planPackages,
  type PackageEntry,
} from "./translate-packages.shared";

/** Allowance for the retry ladder (halved / single re-asks). */
export const RETRY_ALLOWANCE = 1.1;
/** Fixed rules/skeleton of one per-row request, in tokens. */
const PER_ROW_PREFIX_TOKENS = 400;
/**
 * The glossary directive is added to every request (per-package on the package
 * path). At most `MAX_TERMS_IN_PROMPT` terms (src/services/glossary.service.ts,
 * pinned equal by a test); a term line holds the source term and one rendering
 * per language. Used only where the real glossary is not known at estimate time
 * -- the handler passes the real directive length when it can read the rules.
 */
export const GLOSSARY_MAX_TERMS = 200;
const GLOSSARY_CHARS_BASE_PER_TERM = 30;
const GLOSSARY_CHARS_PER_TERM_PER_LOCALE = 30;
export function glossaryAllowanceChars(localeCount: number): number {
  return GLOSSARY_MAX_TERMS * (GLOSSARY_CHARS_BASE_PER_TERM + GLOSSARY_CHARS_PER_TERM_PER_LOCALE * Math.max(1, localeCount));
}

/** Planned output of one per-row request (the model ceiling, safety-margined). */
const PER_ROW_OUTPUT_PER_REQUEST = Math.floor(TRANSLATION_BATCH.AI_MAX_OUTPUT_TOKENS * 0.6);

export interface EstimateJob {
  rowId: string;
  cells: {
    column: ColumnDescriptor;
    fieldKey: string;
    source: string;
    locales: string[];
  }[];
}

export interface EstimateClassifiers {
  isGroupedColumn(column: ColumnDescriptor): boolean;
  isValueColumn(column: ColumnDescriptor): boolean;
  isShortColumn(column: ColumnDescriptor): boolean;
  isListValuesColumn(column: ColumnDescriptor): boolean;
  isHandleColumn(column: ColumnDescriptor): boolean;
  instructionsFor(fieldKeys: string[]): string | undefined;
}

export interface ModelLimitsForEstimate {
  provider: AIProvider;
  model: string;
  maxOutputTokens: number;
  bucketTpm: number | null;
}

/** What the page shows. Money in micro-euro (integers). */
export interface TranslateEstimate {
  units: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  /** null = the provider has no per-token price ("nicht schaetzbar"). */
  costMicros: number | null;
  /** The model is unknown: priced at the provider's ceiling ("bis zu"). */
  pricedAtCeiling: boolean;
  /** Cross-item packages are on for this run. */
  packaged: boolean;
  /** Units beyond MAX_TRANSLATE_UNITS that this run leaves for the next one. */
  skippedOverCap: number;
  scanTruncated: boolean;
  /** Whose key the run spends: the operator's (managed) or the merchant's own. */
  source: "managed" | "byo";
  /** Managed shops only: the remaining budget the estimate is read against. */
  budget?: { remainingMicros: number; limitMicros: number; wouldExceed: boolean };
}

const inTok = (chars: number): number => Math.ceil(chars / 3);

/**
 * What the multi-locale prompts add on top of the source: the target-language
 * list ("Portuguese (Brazil) (pt-BR), ") and the JSON skeleton the model is
 * asked to fill, both PER LOCALE. Generous on purpose; pinned against the real
 * prompt builders by bulk-translate-estimate-vs-sent.test.ts (estimate >= sent).
 */
const LANGUAGE_LIST_CHARS_PER_LOCALE = 32;
const SKELETON_CHARS_PER_LOCALE = 14;
/** `"seoTitle": "...",` on its own indented line, plus its label in the field list. */
const SHORT_SKELETON_CHARS_PER_FIELD = 28;
/** `"translated 12",` on its own indented line. */
const VALUE_SKELETON_CHARS_PER_VALUE = 24;
export const shortSkeletonChars = (localeCount: number, fieldCount: number): number =>
  localeCount * (LANGUAGE_LIST_CHARS_PER_LOCALE + SKELETON_CHARS_PER_LOCALE + fieldCount * SHORT_SKELETON_CHARS_PER_FIELD);
export const valueSkeletonChars = (localeCount: number, valueCount: number): number =>
  localeCount * (LANGUAGE_LIST_CHARS_PER_LOCALE + SKELETON_CHARS_PER_LOCALE + valueCount * VALUE_SKELETON_CHARS_PER_VALUE);

interface Totals {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  /** Part of inputTokens written to a prompt cache (Claude package groups). */
  cacheWriteTokens?: number;
}

const outTokForText = (source: string, locales: string[]): number => itemOutputTokens({ source, locales });

/** Per-request extras every request of the run carries: the glossary. */
type GlossaryTok = (localeCount: number) => number;

/**
 * `translateFieldsToLocalesChunked` as the runner calls it (long fields of one
 * row, over the UNION of their locales): ONE request when the payload fits,
 * otherwise per field group x `planLocaleChunks`, and an oversized single field
 * is translated per locale on the `translateContent` path. Every chunk sends the
 * group's whole source again, plus the instructions and the glossary.
 */
function estimateLongPayload(
  sources: string[],
  locales: string[],
  instrTok: number,
  glossaryTok: GlossaryTok,
): Totals {
  const t: Totals = { requests: 0, inputTokens: 0, outputTokens: 0 };
  const entries = sources.filter((x) => x.trim().length > 0);
  if (entries.length === 0 || locales.length === 0) return t;
  const add = (inputChars: number, localeCount: number, outputChars: number) => {
    t.requests += 1;
    t.inputTokens += PER_ROW_PREFIX_TOKENS + instrTok + glossaryTok(localeCount) + inTok(inputChars);
    t.outputTokens += outputTokensForChars(outputChars, localeCount);
  };
  const sourceChars = entries.reduce((n, x) => n + x.length, 0);
  if (fitsOneRequest(sourceChars, locales.length)) {
    add(sourceChars, locales.length, sourceChars);
    return t;
  }
  const perLocaleBudget = perLocaleSourceBudgetChars();
  const groups: number[][] = [];
  let cur: number[] = [];
  let curChars = 0;
  for (const x of entries) {
    if (x.length >= perLocaleBudget) {
      if (cur.length) { groups.push(cur); cur = []; curChars = 0; }
      groups.push([x.length]);
      continue;
    }
    if (curChars + x.length > perLocaleBudget && cur.length) { groups.push(cur); cur = []; curChars = 0; }
    cur.push(x.length);
    curChars += x.length;
  }
  if (cur.length) groups.push(cur);
  for (const group of groups) {
    const groupChars = group.reduce((n, x) => n + x, 0);
    if (group.length === 1 && groupChars >= perLocaleBudget) {
      for (let i = 0; i < locales.length; i++) add(groupChars, 1, groupChars);
      continue;
    }
    for (const chunk of planLocaleChunks(locales, groupChars)) add(groupChars, chunk.length, groupChars);
  }
  return t;
}

/**
 * `translateBatchValuesToLocales` as the runner calls it: one locale is the
 * plain batch (40 values a request); several locales are value groups under the
 * per-locale character budget and the 40-item cap, each x `planLocaleChunks`.
 */
function estimateValueBatch(
  values: string[],
  locales: string[],
  instrTok: number,
  glossaryTok: GlossaryTok,
): Totals {
  const t: Totals = { requests: 0, inputTokens: 0, outputTokens: 0 };
  if (values.length === 0 || locales.length === 0) return t;
  const add = (chars: number, count: number, localeCount: number, outputChars: number) => {
    t.requests += 1;
    t.inputTokens += PER_ROW_PREFIX_TOKENS + instrTok + glossaryTok(localeCount) + inTok(chars + 20 * count + (localeCount > 1 ? valueSkeletonChars(localeCount, count) : 0));
    t.outputTokens += outputTokensForChars(outputChars, localeCount);
  };
  if (locales.length === 1) {
    for (let i = 0; i < values.length; i += TRANSLATION_BATCH.VALUE_BATCH_MAX_ITEMS) {
      const slice = values.slice(i, i + TRANSLATION_BATCH.VALUE_BATCH_MAX_ITEMS);
      const chars = slice.reduce((n, v) => n + v.length, 0);
      add(chars, slice.length, 1, chars);
    }
    return t;
  }
  const perLocaleBudget = perLocaleSourceBudgetChars();
  const groups: { chars: number; count: number }[] = [];
  let current = { chars: 0, count: 0 };
  for (const v of values) {
    if (current.count > 0 && (current.chars + v.length > perLocaleBudget || current.count >= TRANSLATION_BATCH.VALUE_BATCH_MAX_ITEMS)) {
      groups.push(current);
      current = { chars: 0, count: 0 };
    }
    current.chars += v.length;
    current.count += 1;
  }
  if (current.count > 0) groups.push(current);
  for (const g of groups) {
    for (const chunk of planLocaleChunks(locales, g.chars)) add(g.chars, g.count, chunk.length, g.chars);
  }
  return t;
}

/** The per-row path, as the runner routes it: one short batch per row, numbered
 *  value batches (40 per request) per language signature, the long fields, and
 *  one request per productType text. Leans high (no cross-row dedup). */
function estimatePerRow(jobs: EstimateJob[], c: EstimateClassifiers, glossaryTok: GlossaryTok): Totals {
  const t: Totals = { requests: 0, inputTokens: 0, outputTokens: 0 };
  const add = (requests: number, input: number, output: number) => {
    t.requests += requests;
    t.inputTokens += input;
    t.outputTokens += output;
  };
  for (const job of jobs) {
    const grouped = job.cells.filter((x) => c.isGroupedColumn(x.column));
    const sub = job.cells.filter((x) => !c.isGroupedColumn(x.column) && c.isValueColumn(x.column));
    const short = job.cells.filter(
      (x) => !c.isGroupedColumn(x.column) && !c.isValueColumn(x.column) && c.isShortColumn(x.column),
    );
    const long = job.cells.filter(
      (x) => !c.isGroupedColumn(x.column) && !c.isValueColumn(x.column) && !c.isShortColumn(x.column),
    );
    for (const cell of grouped) {
      add(
        1,
        PER_ROW_PREFIX_TOKENS + glossaryTok(cell.locales.length) + inTok(cell.source.length),
        outTokForText(cell.source, cell.locales),
      );
    }
    if (short.length > 0) {
      const union = [...new Set(short.flatMap((x) => x.locales))];
      const instr = c.instructionsFor(short.map((x) => x.fieldKey)) ?? "";
      add(
        1,
        PER_ROW_PREFIX_TOKENS +
          inTok(instr.length) +
          glossaryTok(union.length) +
          inTok(shortSkeletonChars(union.length, short.length)) +
          short.reduce((n, x) => n + inTok(x.source.length + 20), 0),
        short.reduce((n, x) => n + outTokForText(x.source, union), 0),
      );
    }
    // Value cells: the runner groups them by language signature and sends each
    // group through translateBatchValuesToLocales (chunked on both dimensions).
    const bySignature = new Map<string, { values: string[]; locales: string[] }>();
    for (const cell of sub) {
      const parts = c.isListValuesColumn(cell.column)
        ? cell.source.split(LIST_DISPLAY_SEPARATOR.trim()).map((v) => v.trim())
        : [cell.source];
      const locales = [...new Set(cell.locales)].sort();
      const sig = locales.join(",");
      const entry = bySignature.get(sig) ?? { values: [], locales };
      entry.values.push(...parts);
      bySignature.set(sig, entry);
    }
    const valueInstrTok = inTok((c.instructionsFor([]) ?? "").length);
    for (const entry of bySignature.values()) {
      const e = estimateValueBatch(entry.values, entry.locales, valueInstrTok, glossaryTok);
      add(e.requests, e.inputTokens, e.outputTokens);
    }
    if (long.length > 0) {
      // Payload keyed by field key (the runner's payloadOf), over the UNION of
      // the cells' locales, with the merchant's instructions on every request.
      const payload = new Map<string, string>();
      for (const x of long) if (!payload.has(x.fieldKey)) payload.set(x.fieldKey, x.source);
      const union = [...new Set(long.flatMap((x) => x.locales))];
      const longInstrTok = inTok((c.instructionsFor(long.map((x) => x.fieldKey)) ?? "").length);
      const e = estimateLongPayload([...payload.values()], union, longInstrTok, glossaryTok);
      add(e.requests, e.inputTokens, e.outputTokens);
    }
  }
  return t;
}

/** The package path: the run's own planner over the same kind of entries. */
function estimatePackaged(
  jobs: EstimateJob[],
  c: EstimateClassifiers,
  limits: ModelLimitsForEstimate,
  glossaryTok: GlossaryTok,
): Totals {
  const t: Totals = { requests: 0, inputTokens: 0, outputTokens: 0 };
  const entries: PackageEntry[] = [];
  for (const job of jobs) {
    const title = job.cells.find((x) => x.fieldKey === "title" && x.column.kind === "field");
    for (const cell of job.cells) {
      if (c.isGroupedColumn(cell.column)) {
        // One request per cell, no cross-row cache credit.
        t.requests += 1;
        t.inputTokens += PER_ROW_PREFIX_TOKENS + glossaryTok(cell.locales.length) + inTok(cell.source.length);
        t.outputTokens += outTokForText(cell.source, cell.locales);
        continue;
      }
      const kind: PackageEntry["kind"] = c.isValueColumn(cell.column)
        ? "value"
        : c.isShortColumn(cell.column)
          ? c.isHandleColumn(cell.column)
            ? "handle"
            : "short"
          : "long";
      const parts =
        kind === "value" && c.isListValuesColumn(cell.column)
          ? cell.source.split(LIST_DISPLAY_SEPARATOR.trim()).map((v) => v.trim())
          : [cell.source];
      parts.forEach((text, i) => {
        entries.push({
          owner: `${job.rowId}|${cell.column.id}#${i}`,
          kind,
          fieldKey: cell.fieldKey,
          source: text,
          locales: cell.locales,
          instructions: kind === "value" ? c.instructionsFor([]) : c.instructionsFor([cell.fieldKey]),
          ...(kind === "handle" && title ? { context: title.source.slice(0, 200) } : {}),
        });
      });
    }
  }
  const budget = packageBudgetFor({ modelMaxOutput: limits.maxOutputTokens, bucketTpm: limits.bucketTpm });
  const plan = planPackages(buildPackageItems(entries), budget);
  // Prompt caching, as the runner does it (translate-package-phase): a Claude
  // group with enough packages and a long enough stable prefix sends its first
  // package ALONE (one cache write at 1.25x), the rest read the cache (priced
  // at 1.0, no discount claimed).
  const packagesPerGroup = new Map<string, number>();
  for (const pkg of plan.packages) packagesPerGroup.set(pkg.groupKey, (packagesPerGroup.get(pkg.groupKey) ?? 0) + 1);
  const cacheWritten = new Set<string>();
  const thinking = geminiThinkingAllowanceTokens(limits.provider, limits.model);
  for (const pkg of plan.packages) {
    t.requests += 1;
    // Gemini 2.5 thinking is billed as output; the package ceiling carries it.
    t.outputTokens += thinking;
    const prefixTokens = PACKAGE_PREFIX_TOKENS + Math.ceil((pkg.instructions?.length ?? 0) / 4);
    if (
      limits.provider === "claude" &&
      (packagesPerGroup.get(pkg.groupKey) ?? 0) >= PACKAGE_CACHE_MIN_GROUP_PACKAGES &&
      prefixTokens >= PACKAGE_CACHE_MIN_PREFIX_TOKENS &&
      !cacheWritten.has(pkg.groupKey)
    ) {
      cacheWritten.add(pkg.groupKey);
      t.cacheWriteTokens = (t.cacheWriteTokens ?? 0) + PACKAGE_PREFIX_TOKENS + inTok(pkg.instructions?.length ?? 0);
    }
    t.inputTokens +=
      PACKAGE_PREFIX_TOKENS +
      inTok(pkg.instructions?.length ?? 0) +
      glossaryTok(pkg.locales.length) +
      pkg.items.reduce((n, item) => n + inTok(item.source.length + (item.context?.length ?? 0) + 40), 0);
    t.outputTokens += pkg.items.reduce((n, item) => n + itemOutputTokens(item), 0) + 20;
  }
  // An item that fits no package alone is translated per language on the
  // per-row path: one request per language.
  for (const item of plan.oversized) {
    for (const locale of item.locales) {
      t.requests += 1;
      t.inputTokens +=
        PER_ROW_PREFIX_TOKENS + inTok(item.instructions?.length ?? 0) + glossaryTok(1) + inTok(item.source.length);
      t.outputTokens += outTokForText(item.source, [locale]);
    }
  }
  return t;
}

export function estimateTranslateRun(args: {
  jobs: EstimateJob[];
  units: number;
  packages: boolean;
  classifiers: EstimateClassifiers;
  limits: ModelLimitsForEstimate;
  skippedOverCap: number;
  scanTruncated: boolean;
  /**
   * Characters of the glossary directive one request carries (the handler reads
   * the real rules). Omitted = unknown: a worst-case allowance is added.
   */
  glossaryChars?: number;
  /** Whose key the run would spend; default "byo". */
  source?: "managed" | "byo";
  /** Remaining managed budget; omitted for a shop on its own key. */
  managedBudget?: { remainingMicros: number; limitMicros: number };
}): TranslateEstimate {
  const { jobs, units, packages, classifiers, limits } = args;
  const glossaryTok: GlossaryTok = (localeCount) =>
    inTok(args.glossaryChars !== undefined ? Math.max(0, args.glossaryChars) : glossaryAllowanceChars(localeCount));
  const raw = packages
    ? estimatePackaged(jobs, classifiers, limits, glossaryTok)
    : estimatePerRow(jobs, classifiers, glossaryTok);
  const requests = jobs.length === 0 ? 0 : Math.max(1, Math.ceil(raw.requests * RETRY_ALLOWANCE));
  const inputTokens = Math.ceil(raw.inputTokens * RETRY_ALLOWANCE);
  const outputTokens = Math.ceil(raw.outputTokens * RETRY_ALLOWANCE);
  const priced = priceCall(limits.provider, limits.model, inputTokens, outputTokens, {
    cacheWriteTokens: Math.min(raw.cacheWriteTokens ?? 0, inputTokens),
  });
  const costMicros = priced.unpriced ? null : priced.costMicros;
  return {
    units,
    requests,
    inputTokens,
    outputTokens,
    costMicros,
    pricedAtCeiling: priced.pricedAtCeiling,
    packaged: packages,
    source: args.source ?? "byo",
    skippedOverCap: args.skippedOverCap,
    scanTruncated: args.scanTruncated,
    ...(args.managedBudget
      ? {
          budget: {
            remainingMicros: args.managedBudget.remainingMicros,
            limitMicros: args.managedBudget.limitMicros,
            // Unpriced cannot be compared: not claimed to exceed.
            wouldExceed: costMicros !== null && costMicros > args.managedBudget.remainingMicros,
          },
        }
      : {}),
  };
}
