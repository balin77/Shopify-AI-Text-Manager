/**
 * Bulk editor — "translate missing" AI task (the /app/bulk/translate page).
 *
 * Fills the translations the merchant selected on that page: several FIELDS ×
 * several TARGET LANGUAGES × many rows in one run. Always runs as the detached
 * Task `bulkEditorTranslate` (registered in LONG_RUNNING_TASK_TYPES,
 * task-recovery.service.js) with single-flight per shop and per-unit progress.
 *
 * Trust model — nothing about the selection is taken at face value:
 * - the row type, the columns and the locales are re-validated against the
 *   SERVER-built column universe / the published shop locales;
 * - the candidate set is RE-SCANNED here (scanMissingTranslations, the same
 *   scan the page's loader ran), and the merchant's selection is replayed over
 *   it. A cell that was filled in between silently drops out; a cell the client
 *   claims but the server does not see never enters the run.
 *
 * Writing goes through applyBulkDiff — the ONE verified write path (digest
 * rule, registerAndVerify echo check, DB mirror, markTranslationSaved). There
 * is no preview mode: only MISSING values are written, so nothing is ever
 * overwritten, and the result is reviewed in the grid afterwards.
 *
 * AI work goes through AIQueueService.enqueue() — createAIService(settings,
 * shop, taskId) wires the queue automatically (Contract §8, pattern 4).
 *
 * Market scope: GLOBAL only (marketId ""). The page has no market dimension —
 * a market-specific override stays a per-cell decision in the grid.
 *
 * Plan gate: Pro (fan-out AI work, §10.7) — checked here because this handler
 * is reachable directly via POST /api/ai.
 */

import { data as json } from "react-router";
import type { AIActionContext } from "./shared";
import { errorMessage, createAIService, isAuthError } from "./shared";
import type { AIService } from "../../../src/services/ai.service";
import { getFormString, getFormJSON } from "~/utils/form-data.utils";
import { getTaskExpirationDate } from "~/config/constants";
import { logger } from "~/utils/logger.server";
import { meetsPlan } from "~/utils/planUtils";
import { PLAN_CONFIG, type Plan } from "~/config/plans";
import { getCachedShopLocales } from "~/utils/shop-locales-cache.server";
import { GroupedFieldTranslationService } from "../../../src/services/grouped-field-translation.service";
import {
  BULK_ROW_TYPES,
  BULK_ROW_TYPE_TO_CONTENT_TYPE,
  BULK_FILTER_IDS,
  LIST_DISPLAY_SEPARATOR,
  type BulkDiffEntry,
  type BulkFilterId,
  type BulkRowType,
  type ColumnDescriptor,
} from "~/services/bulk-editor/columns.shared";
import { buildServerColumnsByType } from "~/services/bulk-editor/columns.server";
import { applyBulkDiff } from "~/services/bulk-editor/apply.server";
import {
  canonicalFieldNameForColumn,
  isSubResourceColumn,
} from "~/services/bulk-editor/translations.server";
import {
  scanMissingTranslations,
  translateCandidateColumns,
} from "~/services/bulk-editor/missing-translations.server";
import {
  MAX_TRANSLATE_UNITS,
  dedupeHandle,
  isPairSelected,
  normalizeTranslatedHandle,
  parseTranslateSelection,
  type MissingItem,
  type TranslateSelection,
} from "~/services/bulk-editor/translate-missing.shared";
import type { PrismaClient } from "@prisma/client";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import type { DataResponse } from "~/types/data-response";

/** Fields compact enough for the short-batch prompt — the subset
 * translateShortFieldsBatch accepts (productType runs its own grouped path). */
const SHORT_FIELDS = new Set(["title", "seoTitle", "handle"]);

/** The ONE column whose AI output is a URL slug. */
const HANDLE_COLUMN_ID = "field.handle";

/** One row's work: which columns to translate into which locales. */
interface TranslateJob {
  rowId: string;
  /** columnId → { column, source text, target locales }. */
  cells: {
    column: ColumnDescriptor;
    /** AI payload key: the canonical field name, or the metaobject field key. */
    fieldKey: string;
    source: string;
    locales: string[];
    /** Option-VALUES cells: per locale, the entries that are ALREADY
     * translated ("" where missing) — the AI's output is merged over these so
     * an existing entry is never replaced. */
    existingListValuesByLocale?: Record<string, string[]>;
  }[];
  /** Primary-locale handle — the duplicate-slug guard compares against it. */
  primaryHandle: string;
}

export async function handleBulkEditorTranslate(ctx: AIActionContext): Promise<DataResponse> {
  const { session, admin, db, formData, settings } = ctx;
  const shop = session.shop;

  // Pro gate (Plan §10.7): fan-out AI work — same tier as the SEO bulk fix.
  const plan = (settings?.subscriptionPlan || "free") as Plan;
  if (!meetsPlan(plan, "pro")) {
    return json({ success: false, error: "AI bulk translation requires the Pro plan or higher." }, { status: 403 });
  }

  const planContentTypes = PLAN_CONFIG[plan].contentTypes as string[];
  const rawType = getFormString(formData, "rowType");
  if (
    !(BULK_ROW_TYPES as string[]).includes(rawType) ||
    !planContentTypes.includes(BULK_ROW_TYPE_TO_CONTENT_TYPE[rawType as BulkRowType])
  ) {
    return json({ success: false, error: "Invalid row type." }, { status: 400 });
  }
  const rowType = rawType as BulkRowType;

  // Target languages: every one must be a PUBLISHED, non-primary shop locale —
  // an unknown locale silently collapsing to primary would rewrite live primary
  // content (translations.server.ts findInvalidLocaleOrMarket, same rule).
  const shopLocales = await getCachedShopLocales(admin, shop).catch(() => []);
  const primaryLocale = shopLocales.find((l) => l.primary)?.locale || "en";
  const requested = (getFormString(formData, "locales") || "")
    .split(",")
    .map((l) => l.trim())
    .filter(Boolean);
  const targetLocales = [...new Set(requested)];
  const unknown = targetLocales.find(
    (locale) => !shopLocales.some((l) => l.locale === locale && l.published && !l.primary),
  );
  if (unknown) {
    return json(
      { success: false, error: `Locale "${unknown}" is not a published foreign locale of this shop.` },
      { status: 400 },
    );
  }
  if (targetLocales.length === 0) {
    return json({ success: false, error: "No target language selected." }, { status: 400 });
  }

  const search = getFormString(formData, "search") || "";
  const filters = (getFormString(formData, "filters") || "")
    .split(",")
    .filter((f): f is BulkFilterId => (BULK_FILTER_IDS as string[]).includes(f));
  const selection = parseTranslateSelection(getFormJSON(formData, "selection"));

  const columnsByType = await buildServerColumnsByType(db, shop, plan);
  // Metaobject rows are only schema-homogeneous per definition type — an
  // unknown moType would mix schemas, so it is validated like every other param.
  let moType = "";
  if (rowType === "metaobject") {
    const rawMoType = getFormString(formData, "moType") || "";
    const definitions = await db.metaobjectDefinition.findMany({
      where: { shop },
      select: { type: true },
      orderBy: { type: "asc" },
    });
    moType = definitions.some((d) => d.type === rawMoType) ? rawMoType : definitions[0]?.type ?? "";
  }
  const columns = translateCandidateColumns(columnsByType[rowType], rowType, moType);
  if (columns.length === 0) {
    return json({ success: false, error: "This content type has no AI-translatable fields." }, { status: 400 });
  }

  // Single-flight per shop — a second run would race the same cells.
  const runningTask = await db.task.findFirst({
    where: { shop, type: "bulkEditorTranslate", status: { in: ["pending", "running"] } },
    select: { id: true },
  });
  if (runningTask) {
    return json(
      {
        success: false,
        code: "ALREADY_RUNNING",
        error: "An AI bulk translation is already running for this store. Check the Tasks tab for progress.",
        taskId: runningTask.id,
      },
      { status: 409 },
    );
  }

  // THE authority on what is missing — re-scanned here, never taken from the
  // client (§ trust model above).
  const scan = await scanMissingTranslations(db, shop, {
    type: rowType,
    search,
    filters,
    moType,
    foreignLocales: targetLocales,
    columns,
    admin,
    withSources: true,
  });

  const { jobs, units, overCap } = buildJobs(scan.items, columns, selection, targetLocales, rowType);
  if (jobs.length === 0) {
    return json({ success: true, none: true, total: 0 });
  }

  const task = await db.task.create({
    data: {
      shop,
      type: "bulkEditorTranslate",
      status: "running",
      resourceType: BULK_ROW_TYPE_TO_CONTENT_TYPE[rowType],
      fieldType: fieldTypeLabel(jobs),
      targetLocale: targetLocales.join(","),
      total: units,
      processed: 0,
      progress: 0,
      expiresAt: getTaskExpirationDate(),
    },
  });

  void runBulkEditorTranslate(task.id, {
    db,
    shop,
    admin,
    settings,
    jobs,
    units,
    rowType,
    primaryLocale,
    columnsByType,
  }).catch((err: unknown) => {
    logger.error("[API-AI] Bulk-editor translate crashed", {
      context: "AI",
      taskId: task.id,
      error: errorMessage(err),
    });
  });

  return json({
    success: true,
    taskId: task.id,
    total: units,
    // Honest truncation (same pattern as the scan window): units above the cap
    // are left for the next run and reported, never silently dropped.
    skippedOverCap: overCap,
    scanTruncated: scan.scanTruncated,
    matchedRows: scan.matchedRows,
    scannedRows: scan.scannedRows,
  });
}

// ─── Job building ──────────────────────────────────────────────────────────

/** Task.fieldType is a display label — one field name, or "multiple". */
function fieldTypeLabel(jobs: TranslateJob[]): string {
  const names = new Set<string>();
  for (const job of jobs) for (const cell of job.cells) names.add(cell.fieldKey);
  return names.size === 1 ? [...names][0] : "multiple";
}

/**
 * Server-side candidate set ∩ merchant selection, capped at
 * MAX_TRANSLATE_UNITS in scan order (the order the page listed them in, so the
 * cap cuts off the tail the merchant saw last).
 */
export function buildJobs(
  items: MissingItem[],
  columns: ColumnDescriptor[],
  selection: TranslateSelection,
  targetLocales: string[],
  rowType: BulkRowType,
): { jobs: TranslateJob[]; units: number; overCap: number } {
  const columnById = new Map(columns.map((c) => [c.id, c] as const));
  const jobs: TranslateJob[] = [];
  let units = 0;
  let overCap = 0;

  let capped = false;
  for (const item of items) {
    const cells: TranslateJob["cells"] = [];
    for (const entry of item.columns) {
      const column = columnById.get(entry.columnId);
      if (!column) continue;
      if (!isPairSelected(selection, item.rowId, entry.columnId)) continue;
      const locales = entry.locales.filter((l) => targetLocales.includes(l));
      if (locales.length === 0) continue;
      // Defensive: the scan is always run withSources here — a missing source
      // means there is nothing to translate, never "translate an empty string".
      // Checked BEFORE the cap so a blank cell is not charged as a remainder.
      if (!entry.source || entry.source.trim() === "") continue;
      // The cap cuts a contiguous TAIL: once it is hit nothing further is
      // taken, so the run is exactly the prefix the page listed first and
      // `overCap` is the honest "left for the next run" number.
      if (capped || units + locales.length > MAX_TRANSLATE_UNITS) {
        capped = true;
        overCap += locales.length;
        continue;
      }
      cells.push({
        column,
        fieldKey: aiFieldKey(column),
        source: entry.source,
        locales,
        ...(entry.existingListValuesByLocale
          ? { existingListValuesByLocale: entry.existingListValuesByLocale }
          : {}),
      });
      units += locales.length;
    }
    if (cells.length > 0) {
      jobs.push({ rowId: item.rowId, cells, primaryHandle: item.primaryHandle ?? "" });
    }
  }
  return { jobs, units, overCap };
}

/** Key the AI prompt sees: the canonical field name ("description", "title"),
 * or the metaobject field key (which is the shop's own descriptive name). */
function aiFieldKey(column: ColumnDescriptor): string {
  return column.kind === "mofield" ? column.moFieldKey ?? column.id : canonicalFieldNameForColumn(column);
}

/** The BASE product field that must run through the shop-wide
 * GroupedFieldTranslation cache — a metaobject field named "productType" is a
 * different thing entirely and must not touch that cache. */
function isGroupedProductTypeColumn(column: ColumnDescriptor): boolean {
  return column.kind === "field" && canonicalFieldNameForColumn(column) === "productType";
}

/** An option-VALUES cell: ONE cell, several ProductOptionValue resources. */
function isListValuesColumn(column: ColumnDescriptor): boolean {
  return column.kind === "option" && column.optionField === "values";
}

/**
 * Merges the AI's entries over the ones that already have a translation: the
 * write carries the WHOLE list, so without this an existing entry would be
 * replaced by a fresh AI variant — and "only missing values are filled" would
 * stop being true for option values.
 */
export function mergeExistingListValues(fresh: string[], existing: string[] | undefined): string {
  const merged = fresh.map((value, index) => {
    const keep = existing?.[index];
    return keep && keep.trim() !== "" ? keep : value.trim();
  });
  return merged.join(LIST_DISPLAY_SEPARATOR);
}

/** Base field columns translateShortFieldsBatch accepts. Metaobject fields are
 * never short: that prompt strips newlines, which would flatten a multi-line
 * metaobject text. */
function isShortFieldColumn(column: ColumnDescriptor): boolean {
  return column.kind === "field" && SHORT_FIELDS.has(canonicalFieldNameForColumn(column));
}

// ─── Runner ────────────────────────────────────────────────────────────────

interface RunArgs {
  db: PrismaClient;
  shop: string;
  admin: AdminApiContext;
  settings: AIActionContext["settings"];
  jobs: TranslateJob[];
  units: number;
  rowType: BulkRowType;
  primaryLocale: string;
  columnsByType: Record<BulkRowType, ColumnDescriptor[]>;
}

interface TranslateResultJson {
  /** All three counters are UNITS (row × field × language) — the same unit the
   * page's "{n} translations selected" uses. applyBulkDiff's own `saved` counts
   * ROW GROUPS and must never be reported as a translation count. */
  saved: number;
  failed: number;
  /** Handles that were deliberately NOT written: the translation equalled the
   * primary handle (no separate URL needed) or normalized to nothing. */
  skippedHandles: number;
  failures: { rowId: string; columnId?: string; message: string }[];
}

async function runBulkEditorTranslate(taskId: string, args: RunArgs): Promise<void> {
  const { db, shop, admin, settings, jobs, units, rowType, primaryLocale, columnsByType } = args;
  const contentType = BULK_ROW_TYPE_TO_CONTENT_TYPE[rowType];
  // createAIService(settings, shop, taskId) → every provider call goes through
  // AIQueueService.enqueue (rate limits, per-shop fairness).
  const aiService = createAIService(settings, shop, taskId);

  const diff: BulkDiffEntry[] = [];
  const failures: TranslateResultJson["failures"] = [];
  let skippedHandles = 0;
  // Translation covers 0–80 %, the verified write pass 80–100 %.
  const TRANSLATE_SPAN = 80;

  const heartbeat = async (processed: number) => {
    await db.task
      .update({
        where: { id: taskId },
        data: { processed, progress: Math.min(TRANSLATE_SPAN, Math.round((processed / units) * TRANSLATE_SPAN)) },
      })
      .catch(() => undefined);
  };

  /** Handles already produced in this run, per locale — two products whose
   * titles translate to the same slug must not fight over one URL. */
  const handlesByLocale = new Map<string, Set<string>>();
  /** productType is translated ONCE per distinct source value across the whole
   * run (shop-wide GroupedFieldTranslation cache) — otherwise one Google
   * Merchant category fans out into several AI variants across the catalog. */
  const groupedService = new GroupedFieldTranslationService(db);
  const productTypeCache = new Map<string, Record<string, string>>();

  let processed = 0;
  try {
    for (const job of jobs) {
      // Routing keys on the COLUMN, never on the AI payload key: a metaobject
      // field may legitimately be called "handle" or "productType", and it must
      // NOT be slugified or written into the shop-wide productType cache.
      const grouped = job.cells.filter((c) => isGroupedProductTypeColumn(c.column));
      // Metafield/option cells are short, standalone strings on their own
      // Shopify resource — translateBatchValues is the prompt the single-item
      // editor already uses for exactly these (sub-resources.action.ts).
      const sub = job.cells.filter((c) => isSubResourceColumn(c.column));
      const short = job.cells.filter(
        (c) =>
          !isGroupedProductTypeColumn(c.column) && !isSubResourceColumn(c.column) && isShortFieldColumn(c.column),
      );
      const long = job.cells.filter(
        (c) =>
          !isGroupedProductTypeColumn(c.column) && !isSubResourceColumn(c.column) && !isShortFieldColumn(c.column),
      );

      // One AI call per group and row, over the UNION of the locales its cells
      // need — asking per (field, locale) would multiply the call count by up
      // to 6 × 3 for the same tokens.
      const results: Record<string, Record<string, string>> = {};
      const collect = (partial: Record<string, Record<string, string>>) => {
        for (const [locale, fields] of Object.entries(partial)) {
          Object.assign((results[locale] ??= {}), fields);
        }
      };
      /** Columns whose AI call already failed as a group — their cells must not
       * be reported a second time as "no translation". */
      const failedColumnIds = new Set<string>();
      /** `${columnId}|${locale}` — the sub-resource path translates ONE locale
       * per call, so a failure there must not write off the cell's other
       * languages. */
      const failedCellLocales = new Set<string>();
      const failGroup = (cells: TranslateJob["cells"], message: string) => {
        for (const cell of cells) {
          failedColumnIds.add(cell.column.id);
          failures.push({ rowId: job.rowId, columnId: cell.column.id, message });
          processed += cell.locales.length;
        }
      };

      if (short.length > 0) {
        try {
          collect(
            await aiService.translateShortFieldsBatch(
              payloadOf(short),
              primaryLocale,
              unionLocales(short),
              contentType,
            ),
          );
        } catch (err: unknown) {
          // An invalid AI key fails every remaining row identically — abort.
          if (isAuthError(err)) throw err;
          failGroup(short, errorMessage(err));
        }
      }

      if (long.length > 0) {
        try {
          collect(
            await aiService.translateFieldsToLocalesChunked(
              payloadOf(long),
              primaryLocale,
              unionLocales(long),
              { preserveHtml: true, contextLabel: contentType },
            ),
          );
        } catch (err: unknown) {
          if (isAuthError(err)) throw err;
          failGroup(long, errorMessage(err));
        }
      }

      for (const cell of grouped) {
        try {
          const values = await translateProductTypeValue(
            cell.source,
            cell.locales,
            { grouped: groupedService, shop, aiService, primaryLocale, contentType },
            productTypeCache,
          );
          collect(
            Object.fromEntries(
              Object.entries(values).map(([locale, value]) => [locale, { productType: value }]),
            ),
          );
        } catch (err: unknown) {
          if (isAuthError(err)) throw err;
          failGroup([cell], errorMessage(err));
        }
      }

      if (sub.length > 0) {
        // One call per LOCALE over every sub-resource string of the row: an
        // option-values cell contributes one string per entry, so the numbered
        // batch prompt maps back positionally.
        for (const locale of unionLocales(sub)) {
          const cellsForLocale = sub.filter((c) => c.locales.includes(locale));
          const slices: { cell: TranslateJob["cells"][number]; start: number; length: number }[] = [];
          const values: string[] = [];
          for (const cell of cellsForLocale) {
            const parts = isListValuesColumn(cell.column)
              ? cell.source.split(LIST_DISPLAY_SEPARATOR.trim()).map((v) => v.trim())
              : [cell.source];
            slices.push({ cell, start: values.length, length: parts.length });
            values.push(...parts);
          }
          try {
            const translated = await aiService.translateBatchValues(
              values,
              primaryLocale,
              locale,
              "product options and metafield values",
            );
            for (const slice of slices) {
              const parts = translated.slice(slice.start, slice.start + slice.length);
              // Never substitute the source: a missing entry stays empty and is
              // reported as a failed cell below.
              if (parts.length !== slice.length || parts.some((v) => !v || !v.trim())) continue;
              const merged = isListValuesColumn(slice.cell.column)
                ? mergeExistingListValues(parts, slice.cell.existingListValuesByLocale?.[locale])
                : parts[0].trim();
              collect({ [locale]: { [slice.cell.fieldKey]: merged } });
            }
          } catch (err: unknown) {
            if (isAuthError(err)) throw err;
            const message = errorMessage(err);
            for (const cell of cellsForLocale) {
              failedCellLocales.add(`${cell.column.id}|${locale}`);
              failures.push({ rowId: job.rowId, columnId: cell.column.id, message });
              processed++;
            }
          }
        }
      }

      for (const cell of job.cells) {
        if (failedColumnIds.has(cell.column.id)) continue;
        for (const locale of cell.locales) {
          if (failedCellLocales.has(`${cell.column.id}|${locale}`)) continue;
          processed++;
          // Never substitute the source text — an untranslated value written
          // as a "translation" is silent corruption.
          let value = (results[locale]?.[cell.fieldKey] ?? "").trim();
          if (!value) {
            failures.push({
              rowId: job.rowId,
              columnId: cell.column.id,
              message: "AI returned no translation.",
            });
            continue;
          }
          if (cell.column.id === HANDLE_COLUMN_ID) {
            // AI output → a slug Shopify accepts; identical-to-primary handles
            // are skipped on purpose (a translated URL that equals the primary
            // one is a routing conflict, not a translation).
            const used = handlesByLocale.get(locale) ?? new Set<string>();
            handlesByLocale.set(locale, used);
            value = dedupeHandle(normalizeTranslatedHandle(value), used);
            if (!value || value === job.primaryHandle.trim()) {
              skippedHandles++;
              continue;
            }
          }
          diff.push({
            rowId: job.rowId,
            rowType,
            locale,
            // GLOBAL only — the page has no market dimension.
            marketId: "",
            columnId: cell.column.id,
            value,
          });
        }
      }
      await heartbeat(processed);
    }

    let saved = 0;
    if (diff.length > 0) {
      // The SAME verified write path as manual saving: digest rule (§6.3),
      // registerAndVerify echo check, DB mirror, markTranslationSaved. Every
      // entry is a FOREIGN write, so the primary-save invalidation never fires.
      const applyResult = await applyBulkDiff({ db, shop, admin, columnsByType }, diff, async (done, totalRows) => {
        await db.task
          .update({
            where: { id: taskId },
            data: { progress: Math.min(100, Math.round(TRANSLATE_SPAN + (done / totalRows) * 20)) },
          })
          .catch(() => undefined);
      });
      // applyResult.saved counts row GROUPS, not translations — count the diff
      // entries no failure was attributed to instead (a cell failure carries
      // its columnId + locale, a row-level one only the row).
      const failedCells = new Set<string>();
      const failedRowLocales = new Set<string>();
      for (const failure of applyResult.failures) {
        const locale = failure.locale ?? "";
        if (failure.columnId) failedCells.add(`${failure.rowId}|${locale}|${failure.columnId}`);
        else failedRowLocales.add(`${failure.rowId}|${locale}`);
      }
      saved = diff.filter(
        (entry) =>
          !failedCells.has(`${entry.rowId}|${entry.locale}|${entry.columnId}`) &&
          !failedRowLocales.has(`${entry.rowId}|${entry.locale}`),
      ).length;
      failures.push(
        ...applyResult.failures.map((f) => ({ rowId: f.rowId, columnId: f.columnId, message: f.message })),
      );
    }

    // Every selected unit ends in exactly one bucket: saved, deliberately
    // skipped, or failed — derived, so the three always add up to the run.
    const failed = Math.max(0, units - saved - skippedHandles);
    const result: TranslateResultJson = { saved, failed, skippedHandles, failures };
    const failedRows = new Set(failures.map((f) => f.rowId)).size;
    await db.task.update({
      where: { id: taskId },
      data: {
        status: saved === 0 && failedRows > 0 ? "failed" : "completed",
        progress: 100,
        processed: units,
        completedAt: new Date(),
        result: JSON.stringify(result),
        error: failedRows > 0 ? `${failedRows} row(s) failed`.substring(0, 1000) : null,
      },
    });
  } catch (err: unknown) {
    const message = errorMessage(err);
    logger.error("[API-AI] Bulk-editor translate: run failed", { context: "AI", taskId, error: message });
    await db.task
      .update({
        where: { id: taskId },
        data: { status: "failed", progress: 100, completedAt: new Date(), error: message.substring(0, 1000) },
      })
      .catch(() => undefined);
  }
}

/** { fieldKey → source } for one AI call. */
function payloadOf(cells: TranslateJob["cells"]): Record<string, string> {
  const payload: Record<string, string> = {};
  for (const cell of cells) if (!(cell.fieldKey in payload)) payload[cell.fieldKey] = cell.source;
  return payload;
}

/** Union of the locales the cells of one AI call need. */
function unionLocales(cells: TranslateJob["cells"]): string[] {
  const locales = new Set<string>();
  for (const cell of cells) for (const locale of cell.locales) locales.add(locale);
  return [...locales];
}

/**
 * productType path: one translation per DISTINCT source value, served from the
 * shop-wide GroupedFieldTranslation cache first; fresh translations are
 * persisted back so every product sharing a source value gets the SAME category
 * label. The per-run Map additionally avoids re-querying the cache per row.
 */
async function translateProductTypeValue(
  source: string,
  locales: string[],
  deps: {
    grouped: GroupedFieldTranslationService;
    shop: string;
    aiService: AIService;
    primaryLocale: string;
    contentType: string;
  },
  cache: Map<string, Record<string, string>>,
): Promise<Record<string, string>> {
  const key = source.trim();
  const known = cache.get(key) ?? {};
  const wanted = locales.filter((l) => !known[l]);
  if (wanted.length === 0) return pick(known, locales);

  const lookup = await deps.grouped.lookup({
    shop: deps.shop,
    fieldKey: "productType",
    sourceLocale: deps.primaryLocale,
    sourceValue: key,
    targetLocales: wanted,
  });
  for (const [locale, value] of Object.entries(lookup.hits)) {
    if (value && value.trim()) known[locale] = value;
  }

  const stillMissing = wanted.filter((l) => !known[l]);
  if (stillMissing.length > 0) {
    const res = await deps.aiService.translateShortFieldsBatch(
      { productType: key },
      deps.primaryLocale,
      stillMissing,
      deps.contentType,
    );
    const fresh: Record<string, string> = {};
    for (const locale of stillMissing) {
      const value = res[locale]?.productType;
      if (value && value.trim()) {
        known[locale] = value;
        fresh[locale] = value;
      }
    }
    if (Object.keys(fresh).length > 0) {
      await deps.grouped
        .upsertMany({
          shop: deps.shop,
          fieldKey: "productType",
          sourceLocale: deps.primaryLocale,
          sourceValue: key,
          entries: fresh,
          source: "ai",
        })
        .catch((err: unknown) => {
          logger.error("[API-AI] Bulk-editor translate: grouped-field persist failed", {
            context: "AI",
            error: errorMessage(err),
          });
        });
    }
  }

  cache.set(key, known);
  return pick(known, locales);
}

function pick(values: Record<string, string>, locales: string[]): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const locale of locales) if (values[locale]) picked[locale] = values[locale];
  return picked;
}
