/**
 * Bulk editor — "Translate missing" AI task (docs/plans/PLAN_BULK_EDITOR.md
 * §6.5): one column + one target language → translate every EMPTY cell of the
 * current filter set. Always runs as the detached Task `bulkEditorTranslate`
 * (registered in LONG_RUNNING_TASK_TYPES, task-recovery.service.js) with
 * single-flight per shop and per-row progress.
 *
 * AI work goes through AIQueueService.enqueue() — createAIService(settings,
 * shop, taskId) wires the queue automatically (Contract §8, pattern 4). This
 * is the difference to the pure write task `seoBulkMeta`, which deliberately
 * bypasses the AI queue.
 *
 * Results:
 * - mode "preview" (default): suggestions are stored in Task.result; the
 *   route polls /api/task-result and merges them into the client edit map —
 *   NOTHING is written to Shopify/DB without the merchant's review.
 * - mode "save": the suggestions become a BulkDiffEntry[] and run through
 *   applyBulkDiff — i.e. the SAME verified translation path (digest rule,
 *   registerAndVerify echo check, DB mirror, markTranslationSaved) as manual
 *   saving. No second write path exists.
 *
 * §6.6: this task is GLOBAL-only (marketId "") — the AI plumbing it reuses
 * writes marketId "" throughout; market-aware AI is Phase 4b.
 *
 * Plan gate: Pro (fan-out AI work, §10.7) — checked here because this handler
 * is reachable directly via POST /api/ai.
 */

import { json } from "@remix-run/node";
import type { AIActionContext } from "./shared";
import { errorMessage, createAIService, isAuthError } from "./shared";
import type { AIService } from "../../../src/services/ai.service";
import { getFormString } from "~/utils/form-data.utils";
import { getTaskExpirationDate } from "~/config/constants";
import { logger } from "~/utils/logger.server";
import { meetsPlan } from "~/utils/planUtils";
import { PLAN_CONFIG, type Plan } from "~/config/plans";
import { getCachedShopLocales } from "~/utils/shop-locales-cache.server";
import { GroupedFieldTranslationService } from "../../../src/services/grouped-field-translation.service";
import {
  primaryValueForColumn,
  BULK_ROW_TYPES,
  BULK_ROW_TYPE_TO_CONTENT_TYPE,
  MAX_BULK_TASK_ITEMS,
  BULK_FILTER_IDS,
  type BulkDiffEntry,
  type BulkFilterId,
  type BulkRowType,
  type ColumnDescriptor,
} from "~/services/bulk-editor/columns.shared";
import { buildServerColumnsByType, productColumnCapsForPlan, loadProductMetafieldColumnSpecs } from "~/services/bulk-editor/columns.server";
import { loadBulkRows } from "~/services/bulk-editor/load.server";
import { applyBulkDiff } from "~/services/bulk-editor/apply.server";
import {
  translationKeyForColumn,
  canonicalFieldNameForColumn,
} from "~/services/bulk-editor/translations.server";
import type { PrismaClient } from "@prisma/client";
import type { AdminApiContext } from "@shopify/shopify-app-remix/server";

/** Fields compact enough for the short-batch prompt — mirrors the
 * SHORT_FIELD_KEYS of translateAllContent (minus handle, which is excluded
 * from AI bulk translation entirely, see below). */
const SHORT_FIELDS = new Set(["title", "seoTitle", "productType"]);

export async function handleBulkEditorTranslate(ctx: AIActionContext): Promise<Response> {
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

  const columnId = getFormString(formData, "columnId");
  const columnsByType = await buildServerColumnsByType(db, shop, plan);
  const column = columnsByType[rowType].find((c) => c.id === columnId);
  const translationKey = column ? translationKeyForColumn(column, rowType) : null;
  // AI scope (Phase 4 decision): BASE field columns only. handle is
  // translatable at Shopify and may be typed manually, but bulk-AI-generating
  // hundreds of URL slugs is excluded — the single editor treats handles as a
  // special guided case (slug sanitization, duplicate guards).
  if (!column || column.kind !== "field" || !translationKey || columnId === "field.handle") {
    return json({ success: false, error: "This column cannot be AI-translated." }, { status: 400 });
  }

  const targetLocale = getFormString(formData, "targetLocale");
  const shopLocales = await getCachedShopLocales(admin, shop).catch(() => []);
  const primaryLocale = shopLocales.find((l) => l.primary)?.locale || "en";
  const localeMatch = shopLocales.find((l) => l.locale === targetLocale && l.published && !l.primary);
  if (!localeMatch) {
    // Data-integrity gate: an unknown locale must never collapse to primary.
    return json(
      { success: false, error: `Locale "${targetLocale}" is not a published foreign locale of this shop.` },
      { status: 400 },
    );
  }

  const mode = getFormString(formData, "mode") === "save" ? "save" : "preview";
  const search = getFormString(formData, "search") || "";
  const filters = (getFormString(formData, "filters") || "")
    .split(",")
    .filter((f): f is BulkFilterId => (BULK_FILTER_IDS as string[]).includes(f));

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

  // Candidate rows = the merchant's CURRENT filter set (search + filters),
  // across the whole result (not just the visible page), capped at
  // MAX_BULK_TASK_ITEMS. loadBulkRows with the target locale also attaches
  // foreignValues, so "cell is empty" needs no extra query.
  const productCaps = productColumnCapsForPlan(plan);
  const metafieldSpecs =
    rowType === "product" && productCaps.metafields ? await loadProductMetafieldColumnSpecs(db, shop) : [];
  const { rows, total } = await loadBulkRows(db, shop, {
    type: rowType,
    locale: targetLocale,
    marketId: "", // §6.6: AI path is global-only
    search,
    filters,
    sort: null,
    skip: 0,
    take: MAX_BULK_TASK_ITEMS,
    productCells: { metafieldSpecs, caps: productCaps },
    // Blog rows are live-fetched (Phase 5) — the loader needs the client.
    admin,
  });

  const jobs: { rowId: string; source: string }[] = [];
  for (const row of rows) {
    const existing = row.foreignValues?.[`${targetLocale}||${columnId}`];
    if (existing && existing.trim() !== "") continue; // already translated
    const source = primaryValueForColumn(row, column);
    if (!source || source.trim() === "") continue; // nothing to translate
    jobs.push({ rowId: row.id, source });
  }

  if (jobs.length === 0) {
    return json({ success: true, none: true, total: 0 });
  }

  const task = await db.task.create({
    data: {
      shop,
      type: "bulkEditorTranslate",
      status: "running",
      resourceType: BULK_ROW_TYPE_TO_CONTENT_TYPE[rowType],
      fieldType: canonicalFieldNameForColumn(column),
      targetLocale,
      total: jobs.length,
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
    column,
    rowType,
    targetLocale,
    primaryLocale,
    mode,
    columnsByType,
  }).catch((err: unknown) => {
    logger.error("[API-AI] Bulk-editor translate crashed", {
      context: "AI",
      taskId: task.id,
      error: errorMessage(err),
    });
  });

  return json({ success: true, taskId: task.id, total: jobs.length, truncated: total > rows.length });
}

// ─── Runner ────────────────────────────────────────────────────────────────

interface RunArgs {
  db: PrismaClient;
  shop: string;
  admin: AdminApiContext;
  settings: AIActionContext["settings"];
  jobs: { rowId: string; source: string }[];
  column: ColumnDescriptor;
  rowType: BulkRowType;
  targetLocale: string;
  primaryLocale: string;
  mode: "preview" | "save";
  columnsByType: Record<BulkRowType, ColumnDescriptor[]>;
}

interface TranslateResultJson {
  mode: "preview" | "save";
  /** preview: the suggestions for the client edit map. save: empty. */
  suggestions: BulkDiffEntry[];
  failures: { rowId: string; columnId?: string; message: string }[];
  saved?: number;
}

async function runBulkEditorTranslate(taskId: string, args: RunArgs): Promise<void> {
  const { db, shop, admin, settings, jobs, column, rowType, targetLocale, primaryLocale, mode, columnsByType } = args;
  const fieldName = canonicalFieldNameForColumn(column);
  const contentType = BULK_ROW_TYPE_TO_CONTENT_TYPE[rowType];
  // createAIService(settings, shop, taskId) → every provider call goes
  // through AIQueueService.enqueue (rate limits, per-shop fairness).
  const aiService = createAIService(settings, shop, taskId);

  const suggestions: BulkDiffEntry[] = [];
  const failures: TranslateResultJson["failures"] = [];
  // Translation covers 0–100 % in preview mode; in save mode it covers 0–80 %
  // and the verified write pass 80–100 %.
  const translateSpan = mode === "save" ? 80 : 100;

  const heartbeat = async (processed: number, progress: number) => {
    await db.task
      .update({ where: { id: taskId }, data: { processed, progress: Math.min(100, Math.round(progress)) } })
      .catch(() => undefined);
  };

  const pushSuggestion = (rowId: string, value: string) => {
    suggestions.push({
      rowId,
      rowType,
      locale: targetLocale,
      marketId: "", // §6.6 — global only
      columnId: column.id,
      value,
    });
  };

  try {
    if (rowType === "product" && fieldName === "productType") {
      // productType MUST run through the GroupedFieldTranslation cache
      // (Plan §6.5) — otherwise one Google-Merchant category fans out into
      // several AI variants across the catalog.
      await translateProductTypeGrouped(args, aiService, pushSuggestion, failures, heartbeat, translateSpan);
    } else {
      const isShort = SHORT_FIELDS.has(fieldName);
      for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i];
        try {
          let value: string | undefined;
          if (isShort) {
            const res = await aiService.translateShortFieldsBatch(
              { [fieldName]: job.source },
              primaryLocale,
              [targetLocale],
              contentType,
            );
            value = res[targetLocale]?.[fieldName];
          } else {
            // Long fields one row at a time (Plan §6.5) — HTML preserved.
            const res = await aiService.translateFieldsToLocalesChunked(
              { [fieldName]: job.source },
              primaryLocale,
              [targetLocale],
              { preserveHtml: true, contextLabel: contentType },
            );
            value = res[targetLocale]?.[fieldName];
          }
          if (!value || !value.trim()) {
            // Never substitute the source text — an untranslated value
            // written as a "translation" is silent corruption (N-H3).
            failures.push({ rowId: job.rowId, columnId: column.id, message: "AI returned no translation." });
          } else {
            pushSuggestion(job.rowId, value);
          }
        } catch (err: unknown) {
          // An invalid AI key fails every remaining row identically — abort.
          if (isAuthError(err)) throw err;
          failures.push({ rowId: job.rowId, columnId: column.id, message: errorMessage(err) });
        }
        await heartbeat(i + 1, ((i + 1) / jobs.length) * translateSpan);
      }
    }

    let saved: number | undefined;
    if (mode === "save" && suggestions.length > 0) {
      // The SAME verified write path as manual saving: digest rule (§6.3),
      // registerAndVerify echo check, DB mirror, markTranslationSaved.
      const applyResult = await applyBulkDiff({ db, shop, admin, columnsByType }, suggestions, async (done, totalRows) => {
        await heartbeat(jobs.length, 80 + (done / totalRows) * 20);
      });
      saved = applyResult.saved;
      failures.push(
        ...applyResult.failures.map((f) => ({ rowId: f.rowId, columnId: f.columnId, message: f.message })),
      );
    }

    const produced = suggestions.length;
    const result: TranslateResultJson = {
      mode,
      suggestions: mode === "preview" ? suggestions : [],
      failures,
      ...(saved !== undefined ? { saved } : {}),
    };
    const failedRows = new Set(failures.map((f) => f.rowId)).size;
    await db.task.update({
      where: { id: taskId },
      data: {
        status: produced === 0 && failedRows > 0 ? "failed" : "completed",
        progress: 100,
        processed: jobs.length,
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

/**
 * productType path: one translation per DISTINCT source value, served from
 * the shop-wide GroupedFieldTranslation cache first; fresh translations are
 * persisted back so every product sharing a source value gets the SAME
 * category label.
 */
async function translateProductTypeGrouped(
  args: RunArgs,
  aiService: AIService,
  pushSuggestion: (rowId: string, value: string) => void,
  failures: TranslateResultJson["failures"],
  heartbeat: (processed: number, progress: number) => Promise<void>,
  translateSpan: number,
): Promise<void> {
  const { db, shop, jobs, column, targetLocale, primaryLocale, rowType } = args;
  const contentType = BULK_ROW_TYPE_TO_CONTENT_TYPE[rowType];
  const groupedService = new GroupedFieldTranslationService(db);

  const rowsBySource = new Map<string, string[]>();
  for (const job of jobs) {
    const source = job.source.trim();
    const list = rowsBySource.get(source) ?? [];
    list.push(job.rowId);
    rowsBySource.set(source, list);
  }

  let processedRows = 0;
  let handledSources = 0;
  for (const [source, rowIds] of rowsBySource) {
    let value: string | null = null;
    try {
      const lookup = await groupedService.lookup({
        shop,
        fieldKey: "productType",
        sourceLocale: primaryLocale,
        sourceValue: source,
        targetLocales: [targetLocale],
      });
      value = lookup.hits[targetLocale] ?? null;
      if (!value) {
        const res = await aiService.translateShortFieldsBatch(
          { productType: source },
          primaryLocale,
          [targetLocale],
          contentType,
        );
        value = res[targetLocale]?.productType ?? null;
        if (value && value.trim()) {
          await groupedService
            .upsertMany({
              shop,
              fieldKey: "productType",
              sourceLocale: primaryLocale,
              sourceValue: source,
              entries: { [targetLocale]: value },
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
    } catch (err: unknown) {
      if (isAuthError(err)) throw err;
      const message = errorMessage(err);
      for (const rowId of rowIds) failures.push({ rowId, columnId: column.id, message });
      value = null;
    }

    if (value && value.trim()) {
      for (const rowId of rowIds) pushSuggestion(rowId, value);
    } else if (value !== null) {
      for (const rowId of rowIds) {
        failures.push({ rowId, columnId: column.id, message: "AI returned no translation." });
      }
    }

    processedRows += rowIds.length;
    handledSources++;
    await heartbeat(processedRows, (handledSources / rowsBySource.size) * translateSpan);
  }
}
