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
 * - an allowance for the retry ladder (RETRY_ALLOWANCE) on requests and tokens;
 * - an unknown model is priced at the provider's ceiling (`priceCall`).
 * It never writes anything and never calls a provider.
 */

import { TRANSLATION_BATCH } from "~/config/constants";
import { priceCall } from "~/config/ai-pricing";
import type { AIProvider } from "~/utils/api-key-validation";
import { LIST_DISPLAY_SEPARATOR, type ColumnDescriptor } from "./columns.shared";
import {
  PACKAGE_PREFIX_TOKENS,
  buildPackageItems,
  itemOutputTokens,
  packageBudgetFor,
  planPackages,
  type PackageEntry,
} from "./translate-packages.shared";

/** Allowance for the retry ladder (halved / single re-asks). */
export const RETRY_ALLOWANCE = 1.1;
/** Fixed rules/skeleton of one per-row request, in tokens. */
const PER_ROW_PREFIX_TOKENS = 400;
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
  /** Managed shops only: the remaining budget the estimate is read against. */
  budget?: { remainingMicros: number; limitMicros: number; wouldExceed: boolean };
}

const inTok = (chars: number): number => Math.ceil(chars / 3);

interface Totals {
  requests: number;
  inputTokens: number;
  outputTokens: number;
}

const outTokForText = (source: string, locales: string[]): number => itemOutputTokens({ source, locales });

/** The per-row path, as the runner routes it: one short batch per row, numbered
 *  value batches (40 per request) per language signature, the long fields, and
 *  one request per productType text. Leans high (no cross-row dedup). */
function estimatePerRow(jobs: EstimateJob[], c: EstimateClassifiers): Totals {
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
      add(1, PER_ROW_PREFIX_TOKENS + inTok(cell.source.length), outTokForText(cell.source, cell.locales));
    }
    if (short.length > 0) {
      const union = [...new Set(short.flatMap((x) => x.locales))];
      const instr = c.instructionsFor(short.map((x) => x.fieldKey)) ?? "";
      add(
        1,
        PER_ROW_PREFIX_TOKENS + inTok(instr.length) + short.reduce((n, x) => n + inTok(x.source.length + 20), 0),
        short.reduce((n, x) => n + outTokForText(x.source, union), 0),
      );
    }
    // Value cells: one request per language signature and 40 parts.
    const bySignature = new Map<string, { parts: number; chars: number; out: number }>();
    for (const cell of sub) {
      const parts = c.isListValuesColumn(cell.column)
        ? cell.source.split(LIST_DISPLAY_SEPARATOR.trim()).map((v) => v.trim())
        : [cell.source];
      const sig = [...new Set(cell.locales)].sort().join(",");
      const entry = bySignature.get(sig) ?? { parts: 0, chars: 0, out: 0 };
      for (const part of parts) {
        entry.parts += 1;
        entry.chars += part.length + 20;
        entry.out += outTokForText(part, cell.locales);
      }
      bySignature.set(sig, entry);
    }
    for (const entry of bySignature.values()) {
      const requests = Math.max(1, Math.ceil(entry.parts / TRANSLATION_BATCH.VALUE_BATCH_MAX_ITEMS));
      add(requests, requests * PER_ROW_PREFIX_TOKENS + inTok(entry.chars), entry.out);
    }
    if (long.length > 0) {
      const out = long.reduce((n, x) => n + outTokForText(x.source, x.locales), 0);
      const requests = Math.max(1, Math.ceil(out / PER_ROW_OUTPUT_PER_REQUEST));
      add(
        requests,
        requests * PER_ROW_PREFIX_TOKENS + long.reduce((n, x) => n + inTok(x.source.length), 0),
        out,
      );
    }
  }
  return t;
}

/** The package path: the run's own planner over the same kind of entries. */
function estimatePackaged(jobs: EstimateJob[], c: EstimateClassifiers, limits: ModelLimitsForEstimate): Totals {
  const t: Totals = { requests: 0, inputTokens: 0, outputTokens: 0 };
  const entries: PackageEntry[] = [];
  for (const job of jobs) {
    const title = job.cells.find((x) => x.fieldKey === "title" && x.column.kind === "field");
    for (const cell of job.cells) {
      if (c.isGroupedColumn(cell.column)) {
        // One request per cell, no cross-row cache credit.
        t.requests += 1;
        t.inputTokens += PER_ROW_PREFIX_TOKENS + inTok(cell.source.length);
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
  for (const pkg of plan.packages) {
    t.requests += 1;
    t.inputTokens +=
      PACKAGE_PREFIX_TOKENS +
      inTok(pkg.instructions?.length ?? 0) +
      pkg.items.reduce((n, item) => n + inTok(item.source.length + (item.context?.length ?? 0) + 40), 0);
    t.outputTokens += pkg.items.reduce((n, item) => n + itemOutputTokens(item), 0) + 20;
  }
  // An item that fits no package alone is translated per language on the
  // per-row path: one request per language.
  for (const item of plan.oversized) {
    for (const locale of item.locales) {
      t.requests += 1;
      t.inputTokens += PER_ROW_PREFIX_TOKENS + inTok(item.source.length);
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
  /** Remaining managed budget; omitted for a shop on its own key. */
  managedBudget?: { remainingMicros: number; limitMicros: number };
}): TranslateEstimate {
  const { jobs, units, packages, classifiers, limits } = args;
  const raw = packages ? estimatePackaged(jobs, classifiers, limits) : estimatePerRow(jobs, classifiers);
  const requests = jobs.length === 0 ? 0 : Math.max(1, Math.ceil(raw.requests * RETRY_ALLOWANCE));
  const inputTokens = Math.ceil(raw.inputTokens * RETRY_ALLOWANCE);
  const outputTokens = Math.ceil(raw.outputTokens * RETRY_ALLOWANCE);
  const priced = priceCall(limits.provider, limits.model, inputTokens, outputTokens);
  const costMicros = priced.unpriced ? null : priced.costMicros;
  return {
    units,
    requests,
    inputTokens,
    outputTokens,
    costMicros,
    pricedAtCeiling: priced.pricedAtCeiling,
    packaged: packages,
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
