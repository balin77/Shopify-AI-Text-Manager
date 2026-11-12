/**
 * The PACKAGE phase of the "add missing translations" run
 * (PLAN_BULK_TRANSLATE_BATCHING 3.1, behind BULK_TRANSLATE_PACKAGES).
 *
 * It takes the run's planned jobs, turns every cell the packages can carry into
 * entries, plans cross-row packages, sends them through a small worker pool and
 * hands every FINISHED cell back to the runner (`emitCell`) -- which owns
 * everything about what a finished cell means (handle rules, the write buffer,
 * counters), exactly as it does for the per-row path. What this module does NOT
 * own: writing, cancellation state, the managed stand-down record. It asks.
 *
 * What stays on the per-row path (returned as `remainingJobs`): productType
 * (its shop-wide cache), and any cell with an entry that does not fit a package
 * alone (the per-row chunker splits by language and field).
 *
 * Failure semantics:
 * - a package or entry that fails is NOT a run failure; it walks the ladder
 *   (halves, single entry, failed cell) and the source text is never written;
 * - a fatal error (rejected key) propagates after the other workers stopped;
 * - a managed refusal / queue shutdown (deps.standsDown true) ends the phase:
 *   cells with unresolved entries are emitted with no value, which the runner
 *   counts as "not attempted", not as an AI failure;
 * - a cancelled run (deps.shouldStop) leaves unresolved cells UNSETTLED.
 */

import { isAIRequestStarved, isAIRequestTooLarge } from "../../../src/services/ai-queue.service";
import { PACKAGE_CACHE_MIN_GROUP_PACKAGES } from "~/config/ai-model-limits";
import { sanitizePromptInput } from "~/utils/prompt-sanitizer";
import type { ColumnDescriptor } from "~/services/bulk-editor/columns.shared";
import { LIST_DISPLAY_SEPARATOR } from "~/services/bulk-editor/columns.shared";
import {
  buildPackageItems,
  packageBudgetFor,
  packagePlannedOutputTokens,
  packageTimeoutMs,
  planPackages,
  type PackageEntry,
  type PackageItem,
  type TranslatePackage,
} from "./translate-packages.shared";
import {
  isTransientProviderError,
  runPackageLadder,
  type ItemOutcome,
  type LadderDeps,
  type PackageCallResult,
} from "./translate-package-run.shared";
import type { TranslateJob } from "~/routes/api-ai-handlers/bulk-editor-translate.handler";

type Cell = TranslateJob["cells"][number];

export interface PackagePhaseAI {
  translatePackage(req: {
    kind: "short" | "value" | "long" | "handle";
    fromLang: string;
    locales: string[];
    items: { id: string; text: string; context?: string }[];
    contentType: string;
    instructions?: string;
    plannedOutputTokens: number;
    timeoutMs: number;
    cacheable?: boolean;
  }): Promise<{ parsed: unknown; invalid?: "truncated" | "unparseable" }>;
  packageLimits(): { maxOutputTokens: number; bucketTpm: number | null };
  translateShortFieldsBatch(
    fields: Record<string, string>,
    fromLang: string,
    targetLocales: string[],
    contentType?: string,
    customInstructions?: string,
  ): Promise<Record<string, Record<string, string>>>;
  translateBatchValuesToLocales(
    values: string[],
    fromLang: string,
    targetLocales: string[],
    context?: string,
    options?: { instructions?: string },
  ): Promise<Record<string, string[]>>;
  translateFieldsToLocalesChunked(
    fields: Record<string, string>,
    fromLang: string,
    targetLocales: string[],
    options?: { preserveHtml?: boolean; contextLabel?: string; customInstructions?: string },
  ): Promise<Record<string, Record<string, string>>>;
}

export interface PackagePhaseDeps {
  jobs: TranslateJob[];
  ai: PackagePhaseAI;
  primaryLocale: string;
  contentType: string;
  /** The merchant's instructions with the caps of the given field keys. */
  instructionsFor(fieldKeys: string[]): string | undefined;
  /** The runner's own classifiers -- one source of truth for routing. */
  isGroupedColumn(column: ColumnDescriptor): boolean;
  isValueColumn(column: ColumnDescriptor): boolean;
  isShortColumn(column: ColumnDescriptor): boolean;
  isListValuesColumn(column: ColumnDescriptor): boolean;
  isHandleColumn(column: ColumnDescriptor): boolean;
  isTitleColumn(column: ColumnDescriptor): boolean;
  /** Existing option-value entries are kept (never replaced by a fresh variant). */
  mergeList(fresh: string[], existing: string[] | undefined): string;
  /** A cell is finished: `valueFor(locale)` is its verified text or undefined. */
  emitCell(job: TranslateJob, cell: Cell, valueFor: (locale: string) => string | undefined): void;
  /** True when the error means the run stands down (state recorded by the caller);
   *  throws for a run-aborting error; false for an ordinary failure. */
  standsDown(err: unknown): boolean;
  shouldStop(): Promise<boolean>;
  /** The managed stand-down code, if one was recorded. */
  managedRefusal(): string | null;
  /** After each package: heartbeat and write-if-due. */
  afterPackage(): Promise<void>;
  log(level: "info" | "warn", message: string, meta?: Record<string, unknown>): void;
}

export interface PackageGroupStats {
  packages: number;
  requests: number;
  retries: number;
}

export interface PackagePhaseResult {
  remainingJobs: TranslateJob[];
  stats: {
    packages: number;
    requests: number;
    retries: number;
    /** Cells left to the per-row path because an entry did not fit a package. */
    oversizedCells: number;
    groups: Record<string, PackageGroupStats>;
  };
}

/** Thrown inside a worker to end it after a stand-down. */
class PhaseStop extends Error {}

const cellKeyOf = (job: TranslateJob, cell: Cell): string => `${job.rowId}|${cell.column.id}`;

interface CellState {
  job: TranslateJob;
  cell: Cell;
  /** Item keys still unresolved for this cell. */
  pending: Set<string>;
  /** Item key per part (a plain cell has one part). */
  partItems: string[];
  /** locale -> text per part */
  texts: Record<string, (string | undefined)[]>;
  failed: Set<string>;
  done: boolean;
}

export async function runPackagePhase(deps: PackagePhaseDeps): Promise<PackagePhaseResult> {
  const { jobs, ai } = deps;
  const stats: PackagePhaseResult["stats"] = { packages: 0, requests: 0, retries: 0, oversizedCells: 0, groups: {} };

  // ── 1. Entries ────────────────────────────────────────────────────────────
  const excluded = new Set<string>();
  for (const job of jobs) {
    for (const cell of job.cells) if (deps.isGroupedColumn(cell.column)) excluded.add(cellKeyOf(job, cell));
  }

  const buildEntries = (): { entries: PackageEntry[]; partsOf: Map<string, string[]> } => {
    const entries: PackageEntry[] = [];
    const partsOf = new Map<string, string[]>();
    for (const job of jobs) {
      const titleCell = job.cells.find((c) => deps.isTitleColumn(c.column));
      const context = titleCell
        ? sanitizePromptInput(titleCell.source, { maxLength: 200, allowNewlines: false }).trim()
        : "";
      for (const cell of job.cells) {
        const cellKey = cellKeyOf(job, cell);
        if (excluded.has(cellKey)) continue;
        const kind: PackageEntry["kind"] = deps.isValueColumn(cell.column)
          ? "value"
          : deps.isShortColumn(cell.column)
            ? deps.isHandleColumn(cell.column)
              ? "handle"
              : "short"
            : "long";
        const parts =
          kind === "value" && deps.isListValuesColumn(cell.column)
            ? cell.source.split(LIST_DISPLAY_SEPARATOR.trim()).map((v) => v.trim())
            : [cell.source];
        const sanitized = parts.map((part) =>
          kind === "long"
            ? sanitizePromptInput(part, { allowNewlines: true }).trim()
            : sanitizePromptInput(part, {
                maxLength: kind === "handle" ? 200 : kind === "value" ? 2000 : 500,
                allowNewlines: false,
              }).trim(),
        );
        // A part that sanitizes to nothing cannot be asked: the per-row path
        // words that case, the cell stays there.
        if (sanitized.some((text) => text === "")) {
          excluded.add(cellKey);
          continue;
        }
        const owners = sanitized.map((_, i) => `${cellKey}#${i}`);
        partsOf.set(cellKey, owners);
        sanitized.forEach((text, i) => {
          entries.push({
            owner: owners[i],
            kind,
            fieldKey: cell.fieldKey,
            source: text,
            locales: cell.locales,
            instructions: kind === "value" ? deps.instructionsFor([]) : deps.instructionsFor([cell.fieldKey]),
            ...(kind === "handle" && context ? { context } : {}),
          });
        });
      }
    }
    return { entries, partsOf };
  };

  const limits = ai.packageLimits();
  const budget = packageBudgetFor({ modelMaxOutput: limits.maxOutputTokens, bucketTpm: limits.bucketTpm });

  let built = buildEntries();
  let plan = planPackages(buildPackageItems(built.entries), budget);
  // A cell with ONE entry that cannot ride in a package goes to the per-row
  // path as a whole -- translating its other parts here would be paid twice.
  // (Oversized depends on the entry alone, so one more pass settles it; the
  // loop is a guard, not an expectation.)
  for (let pass = 0; plan.oversized.length > 0 && pass < 3; pass++) {
    const oversizedOwners = new Set(plan.oversized.flatMap((item) => item.owners));
    for (const [cellKey, owners] of built.partsOf) {
      if (!excluded.has(cellKey) && owners.some((owner) => oversizedOwners.has(owner))) {
        excluded.add(cellKey);
        stats.oversizedCells++;
      }
    }
    built = buildEntries();
    plan = planPackages(buildPackageItems(built.entries), budget);
  }
  const itemByKey = new Map<string, PackageItem>();
  for (const pkg of plan.packages) for (const item of pkg.items) itemByKey.set(item.key, item);
  stats.packages = plan.packages.length;
  // Prompt caching pays only for a group with enough packages (the first one
  // writes the cache, the rest read it); retries of the group's packages
  // (halves) share its prefix and keep the flag.
  const packagesPerGroup = new Map<string, number>();
  for (const pkg of plan.packages) packagesPerGroup.set(pkg.groupKey, (packagesPerGroup.get(pkg.groupKey) ?? 0) + 1);

  // ── 2. Cell bookkeeping ───────────────────────────────────────────────────
  const ownerToItem = new Map<string, string>();
  for (const item of itemByKey.values()) for (const owner of item.owners) ownerToItem.set(owner, item.key);
  const cells = new Map<string, CellState>();
  for (const job of jobs) {
    for (const cell of job.cells) {
      const cellKey = cellKeyOf(job, cell);
      const owners = built.partsOf.get(cellKey);
      if (!owners || excluded.has(cellKey)) continue;
      const partItems = owners.map((owner) => ownerToItem.get(owner)!);
      cells.set(cellKey, {
        job,
        cell,
        pending: new Set(partItems),
        partItems,
        texts: Object.fromEntries(cell.locales.map((l) => [l, partItems.map(() => undefined)])),
        failed: new Set(),
        done: false,
      });
    }
  }
  const cellsOfItem = new Map<string, { cellKey: string; part: number }[]>();
  for (const [cellKey, state] of cells) {
    state.partItems.forEach((itemKey, part) => {
      const list = cellsOfItem.get(itemKey) ?? [];
      list.push({ cellKey, part });
      cellsOfItem.set(itemKey, list);
    });
  }

  const finishCell = (state: CellState) => {
    if (state.done) return;
    state.done = true;
    const { job, cell } = state;
    deps.emitCell(job, cell, (locale) => {
      if (state.failed.has(locale)) return undefined;
      const parts = state.texts[locale];
      if (!parts || parts.some((t) => t === undefined)) return undefined;
      return deps.isListValuesColumn(cell.column)
        ? deps.mergeList(parts as string[], cell.existingListValuesByLocale?.[locale])
        : (parts[0] as string);
    });
  };

  const settleItem = (itemKey: string, outcome: ItemOutcome | undefined) => {
    for (const { cellKey, part } of cellsOfItem.get(itemKey) ?? []) {
      const state = cells.get(cellKey)!;
      if (state.done) continue;
      for (const [locale, text] of Object.entries(outcome?.accepted ?? {})) {
        if (state.texts[locale]) state.texts[locale][part] = text;
      }
      for (const locale of Object.keys(outcome?.failed ?? {})) state.failed.add(locale);
      state.pending.delete(itemKey);
      if (state.pending.size === 0) finishCell(state);
    }
  };

  // ── 3. Calls ──────────────────────────────────────────────────────────────
  const callPackage: LadderDeps["callPackage"] = async (pkg): Promise<PackageCallResult> => {
    const idOf = new Map(pkg.items.map((item, i) => [item.key, `k${i + 1}`] as const));
    const planned = packagePlannedOutputTokens(pkg);
    try {
      const result = await ai.translatePackage({
        kind: pkg.kind,
        fromLang: deps.primaryLocale,
        locales: pkg.items[0]?.locales ?? pkg.locales,
        items: pkg.items.map((item) => ({
          id: idOf.get(item.key)!,
          text: item.source,
          ...(item.context ? { context: item.context } : {}),
        })),
        contentType: deps.contentType,
        instructions: pkg.instructions,
        plannedOutputTokens: planned,
        timeoutMs: packageTimeoutMs(planned),
        ...((packagesPerGroup.get(pkg.groupKey) ?? 0) >= PACKAGE_CACHE_MIN_GROUP_PACKAGES ? { cacheable: true } : {}),
      });
      if (result.invalid) return { answer: null, invalid: result.invalid };
      return { answer: { parsed: result.parsed, idOf } };
    } catch (err: unknown) {
      if (deps.standsDown(err)) throw new PhaseStop();
      deps.log("warn", "[BulkTranslate] Package request failed", {
        group: pkg.groupLabel,
        items: pkg.items.length,
        reason: isAIRequestTooLarge(err) ? "too_large" : isAIRequestStarved(err) ? "starved" : isTransientProviderError(err) ? "transient" : "error",
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        answer: null,
        invalid: isAIRequestStarved(err) ? "starved" : isTransientProviderError(err) ? "transient" : "error",
      };
    }
  };

  const callSingle: LadderDeps["callSingle"] = async (item) => {
    try {
      if (item.kind === "value") {
        const perLocale = await ai.translateBatchValuesToLocales(
          [item.source],
          deps.primaryLocale,
          item.locales,
          "product options and metafield values",
          { instructions: item.instructions },
        );
        return Object.fromEntries(item.locales.map((l) => [l, perLocale[l]?.[0] ?? ""]));
      }
      const fields = { [item.fieldKey]: item.source };
      const res =
        item.kind === "long"
          ? await ai.translateFieldsToLocalesChunked(fields, deps.primaryLocale, item.locales, {
              preserveHtml: true,
              contextLabel: deps.contentType,
              customInstructions: item.instructions,
            })
          : await ai.translateShortFieldsBatch(fields, deps.primaryLocale, item.locales, deps.contentType, item.instructions);
      return Object.fromEntries(item.locales.map((l) => [l, res[l]?.[item.fieldKey] ?? ""]));
    } catch (err: unknown) {
      if (deps.standsDown(err)) throw new PhaseStop();
      return null;
    }
  };

  // ── 4. Workers ────────────────────────────────────────────────────────────
  const pending: TranslatePackage[] = [...plan.packages];
  let longRunning = 0;
  let aborted: unknown = null;
  let hasAborted = false;
  const take = (): TranslatePackage | undefined => {
    // At most ONE long package in flight per shop (the queue enforces it too).
    const index = pending.findIndex((p) => p.kind !== "long" || longRunning === 0);
    if (index < 0) return undefined;
    const [pkg] = pending.splice(index, 1);
    if (pkg.kind === "long") longRunning++;
    return pkg;
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      if (hasAborted || deps.managedRefusal() || (await deps.shouldStop())) return;
      const pkg = take();
      if (!pkg) return;
      try {
        const { outcomes, stats: pkgStats, stopped } = await runPackageLadder(pkg, {
          callPackage,
          callSingle,
          shouldStop: async () => hasAborted || !!deps.managedRefusal() || (await deps.shouldStop()),
        });
        stats.requests += pkgStats.requests;
        stats.retries += pkgStats.retries;
        const group = (stats.groups[pkg.groupLabel] ??= { packages: 0, requests: 0, retries: 0 });
        group.packages++;
        group.requests += pkgStats.requests;
        group.retries += pkgStats.retries;
        // Only an entry whose every language is DECIDED (delivered or failed) is
        // settled. One the ladder never finished -- the run was cancelled or
        // stood down under it -- stays pending: a cancelled run leaves it
        // unsettled, a stand-down emits it as "not attempted" below.
        for (const item of pkg.items) {
          const outcome = outcomes.get(item.key);
          if (outcome && item.locales.every((l) => l in outcome.accepted || l in outcome.failed)) {
            settleItem(item.key, outcome);
          }
        }
        // The ladder stopped on a fatal error AFTER the decided entries above
        // were settled (their answers were paid for): now stand down / abort.
        if (stopped) throw stopped.error;
        await deps.afterPackage();
      } catch (err: unknown) {
        if (err instanceof PhaseStop) return;
        // A run-aborting error (rejected key): stop the others, rethrow later.
        hasAborted = true;
        aborted ??= err;
        return;
      } finally {
        if (pkg.kind === "long") longRunning--;
      }
    }
  };

  const workerCount = Math.min(3, Math.max(1, plan.packages.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  if (hasAborted) throw aborted;

  // ── 5. Leftovers ──────────────────────────────────────────────────────────
  // A managed stand-down: what is unresolved was never attempted -- emitted
  // without a value, which the runner counts as "not attempted". A cancelled
  // run leaves its cells unsettled on purpose.
  if (deps.managedRefusal()) {
    for (const state of cells.values()) if (!state.done) finishCell(state);
  }

  for (const [groupLabel, group] of Object.entries(stats.groups)) {
    deps.log("info", "[BulkTranslate] Package group finished", {
      group: groupLabel,
      packages: group.packages,
      requests: group.requests,
      retryRate: group.requests > 0 ? Number((group.retries / group.requests).toFixed(2)) : 0,
    });
  }

  const remainingJobs: TranslateJob[] = [];
  for (const job of jobs) {
    const rest = job.cells.filter((cell) => !cells.has(cellKeyOf(job, cell)));
    if (rest.length > 0) remainingJobs.push(rest.length === job.cells.length ? job : { ...job, cells: rest });
  }
  return { remainingJobs, stats };
}
