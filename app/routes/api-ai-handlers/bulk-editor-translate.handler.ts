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
import { errorMessage, createAIService, isManagedRefusal, isRunAbortingAIError } from "./shared";
import { isAIQueueShuttingDown } from "../../../src/services/ai-queue.service";
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
  aiFieldKey,
  BULK_FILTER_IDS,
  LIST_DISPLAY_SEPARATOR,
  METAFIELD_TYPE_MULTI_LINE,
  MAX_TASK_CALLS,
  type BulkDiffEntry,
  type BulkFilterId,
  type BulkRowType,
  type ColumnDescriptor,
} from "~/services/bulk-editor/columns.shared";
import { buildServerColumnsByType } from "~/services/bulk-editor/columns.server";
import { applyBulkDiff } from "~/services/bulk-editor/apply.server";
import { chunkImportDiff } from "~/services/bulk-editor/diff-chunks.server";
import {
  runPackagePhase,
  type PackagePhaseAI,
  type PackagePhaseResult,
} from "~/services/bulk-editor/translate-package-phase.server";
import { estimateTranslateRun, type TranslateEstimate } from "~/services/bulk-editor/translate-estimate.shared";
import { PACKAGE_OUTPUT_CAP_BATCH } from "~/services/bulk-editor/translate-packages.shared";
import { aiServiceFor } from "~/services/ai/ai-credentials.server";
import { batchEligibility } from "~/services/bulk-editor/translate-batch-eligibility.server";
import { submitBulkTranslateBatch } from "~/services/bulk-editor/translate-batch-submit.server";
import { planTranslateRead, planCellKey } from "~/services/bulk-editor/translate-plan-read.server";
import { ShopifyApiGateway } from "~/services/shopify-api-gateway.service";
import {
  CONTENT_RESOURCE_TYPE_BY_ROW_TYPE,
  canonicalFieldNameForColumn,
  isSubResourceColumn,
} from "~/services/bulk-editor/translations.server";
import {
  recheckMissingDetailed,
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
import { buildTranslateInstructions } from "~/utils/character-limits";
import { getInstructionWithDefault } from "~/utils/ai-instructions.utils";
import type { DataResponse } from "~/types/data-response";
import { backgroundAdmin } from "~/utils/offline-admin.server";
import { RUN_OCCUPYING_TASK_STATUSES } from "~/config/task-statuses.js";

/** Fields compact enough for the short-batch prompt — the subset
 * translateShortFieldsBatch accepts (productType runs its own grouped path). */
const SHORT_FIELDS = new Set(["title", "seoTitle", "handle"]);

/** The ONE column whose AI output is a URL slug. */
const HANDLE_COLUMN_ID = "field.handle";

/** One row's work: which columns to translate into which locales. */
export interface TranslateJob {
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
  const { session, admin, db, formData, settings, seoLimits, translationMode } = ctx;
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
    (locale) => !shopLocales.some((l) => l.locale === locale && !l.primary),
  );
  if (unknown) {
    return json(
      { success: false, error: `Locale "${unknown}" is not a foreign locale of this shop.` },
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

  // PREVIEW MODE (phase 1c): the same validation as the run, the same scan and
  // the same job building -- but no Task row, no AI call, no Shopify write.
  // It sits behind the same plan gate (above) and, through /api/ai, behind
  // aiRefusalFor: a shop without a key gets the refusal, not a number.
  const estimateOnly = getFormString(formData, "estimateOnly") === "true";
  // "batch" = the Anthropic Message Batches mode ("cheaper, result within 24 hours"); anything else is the
  // live run. The choice is only a request: whether this shop MAY use it is decided below, server-side.
  const wantsBatch = getFormString(formData, "mode") === "batch";

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

  // Single-flight per shop — a second run would race the same cells. This
  // check is the cheap early exit (before the scan is paid for); the ATOMIC
  // claim is claimBulkTranslateRun below.
  const runningTask = estimateOnly
    ? null
    : await db.task.findFirst({
        where: activeRunWhere(shop),
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

  if (estimateOnly) {
    const instructionRow = await db.aIInstructions.findUnique({ where: { shop } }).catch(() => null);
    const estimate = await buildEstimate({
      shop,
      settings,
      plan,
      batchAvailable: (await batchEligibility(settings, shop, plan)).available,
      jobs,
      units,
      overCap,
      scanTruncated: scan.scanTruncated,
      instructionsFor: (fieldKeys) =>
        buildTranslateInstructions(
          getInstructionWithDefault(instructionRow, "translateInstructions"),
          translationMode,
          fieldKeys,
          { limits: seoLimits as unknown as Record<string, number> | null },
        ),
    });
    if (!estimate) {
      // Not an error of the merchant's: the page still lets them start.
      return json({ success: false, code: "ESTIMATE_UNAVAILABLE", error: "The estimate is not available." });
    }
    return json({ success: true, estimate });
  }

  // The batch choice is re-decided HERE (this route takes a direct POST): a shop whose provider has no
  // batch API, a taster, or a refused shop gets an answer, never a silent downgrade to a live run.
  if (wantsBatch) {
    const eligibility = await batchEligibility(settings, shop, plan);
    if (!eligibility.available) {
      return json(
        {
          success: false,
          code: "BATCH_NOT_AVAILABLE",
          reason: eligibility.reason,
          error: "The cheaper batch mode is not available for this store. Run it immediately instead.",
        },
        { status: 409 },
      );
    }
  }

  const claim = await claimBulkTranslateRun(db, {
    shop,
    type: "bulkEditorTranslate",
    resourceType: BULK_ROW_TYPE_TO_CONTENT_TYPE[rowType],
    fieldType: fieldTypeLabel(jobs),
    targetLocale: targetLocales.join(","),
    total: units,
    processed: 0,
    progress: 0,
    expiresAt: getTaskExpirationDate(),
  });
  if (!claim.ok && claim.cancelled) {
    return json(
      { success: false, code: "CANCELLED", error: "The run was cancelled before it started.", taskId: claim.taskId },
      { status: 409 },
    );
  }
  if (!claim.ok) {
    return json(
      {
        success: false,
        code: "ALREADY_RUNNING",
        error: "An AI bulk translation is already running for this store. Check the Tasks tab for progress.",
        taskId: claim.taskId,
      },
      { status: 409 },
    );
  }
  const task = claim.task;

  if (wantsBatch) {
    // The merchant's translate instructions, exactly as the live run builds them per request.
    const instructionRow = await db.aIInstructions.findUnique({ where: { shop } }).catch(() => null);
    const instructionsFor = (fieldKeys: string[]): string | undefined =>
      buildTranslateInstructions(
        getInstructionWithDefault(instructionRow, "translateInstructions"),
        translationMode,
        fieldKeys,
        { limits: seoLimits as unknown as Record<string, number> | null },
      );
    // Submitting is slow (plan-time read, prompt building, the provider call): detached, like the live run.
    // The Task is `submitting` from its first step; its terminal state is the submit path's.
    void submitBulkTranslateBatch(task.id, {
      db,
      shop,
      admin: backgroundAdmin(shop, admin),
      settings,
      plan,
      jobs,
      units,
      rowType,
      moType,
      primaryLocale,
      contentType: BULK_ROW_TYPE_TO_CONTENT_TYPE[rowType],
      targetLocales,
      instructionsFor,
      classifiers: {
        isGroupedColumn: isGroupedProductTypeColumn,
        isValueColumn: isBatchSubResourceColumn,
        isShortColumn: isShortFieldColumn,
        isListValuesColumn,
        isHandleColumn: (column) => column.id === HANDLE_COLUMN_ID,
        isTitleColumn: (column) => column.kind === "field" && canonicalFieldNameForColumn(column) === "title",
      },
    }).catch((err: unknown) => {
      logger.error("[API-AI] Bulk-editor translate batch submit crashed", {
        context: "AI",
        taskId: task.id,
        error: errorMessage(err),
      });
    });
    return json({
      success: true,
      taskId: task.id,
      total: units,
      mode: "batch",
      skippedOverCap: overCap,
      scanTruncated: scan.scanTruncated,
      matchedRows: scan.matchedRows,
      scannedRows: scan.scannedRows,
    });
  }

  void runBulkEditorTranslate(task.id, {
    db,
    shop,
    // Outlives the request — see offline-admin.server.ts.
    admin: backgroundAdmin(shop, admin),
    settings,
    jobs,
    units,
    rowType,
    primaryLocale,
    columnsByType,
    // The merchant's translate instructions. This handler never read them, so
    // the grid's AI translations ignored the glossary-adjacent wording rules,
    // the tone and — in `seo_optimized` mode — the per-field length caps that
    // the SAME fields honour when translated one item at a time. One switch,
    // two behaviours out of one app.
    aiInstructions: await db.aIInstructions.findUnique({ where: { shop } }).catch(() => null),
    seoLimits,
    translationMode,
    recheck: { columns, moType, locales: targetLocales },
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

// ─── Cost preview ──────────────────────────────────────────────────────────

/**
 * The estimate of a run, or null when it cannot be made (the service could not
 * be built). READ-ONLY: it builds an AI service only to read its limits (no
 * request is sent) and reads the managed budget without writing it.
 */
async function buildEstimate(args: {
  shop: string;
  settings: AIActionContext["settings"];
  plan: Plan;
  jobs: TranslateJob[];
  units: number;
  overCap: number;
  scanTruncated: boolean;
  /** The server's own answer (translate-batch-eligibility): is the batch alternative offered? */
  batchAvailable: boolean;
  instructionsFor: (fieldKeys: string[]) => string | undefined;
}): Promise<TranslateEstimate | null> {
  try {
    const { service, decision } = aiServiceFor(args.settings, args.shop);
    const limits = service.packageLimits();
    let managedBudget: { remainingMicros: number; limitMicros: number } | undefined;
    const source: "managed" | "byo" = decision.ok && decision.source === "managed" ? "managed" : "byo";
    if (source === "managed") {
      const { managedBudgetStatus } = await import("~/services/ai/managed-budget.server");
      const status = await managedBudgetStatus(args.shop, args.settings, args.plan as never);
      // A budget that could not be read is left out: no claim either way.
      if (!status.readFailed) {
        managedBudget = { remainingMicros: status.remainingMicros, limitMicros: status.limitMicros };
      }
    }
    // The run injects the shop glossary into every request. The real rules are
    // read here (read-only); a failed read is "unknown" and the estimate then
    // adds its worst-case allowance instead of assuming none.
    let glossaryChars: number | undefined;
    try {
      const { loadGlossaryRules, buildGlossaryDirective } = await import("../../../src/services/glossary.service");
      const rules = await loadGlossaryRules(args.shop);
      glossaryChars = buildGlossaryDirective(
        rules,
        args.jobs.flatMap((job) => job.cells.map((cell) => cell.source)),
        [...new Set(args.jobs.flatMap((job) => job.cells.flatMap((cell) => cell.locales)))],
      ).length;
    } catch {
      glossaryChars = undefined;
    }
    return estimateTranslateRun({
      jobs: args.jobs,
      units: args.units,
      packages: bulkTranslatePackagesEnabled(),
      classifiers: {
        isGroupedColumn: isGroupedProductTypeColumn,
        isValueColumn: isBatchSubResourceColumn,
        isShortColumn: isShortFieldColumn,
        isListValuesColumn,
        isHandleColumn: (column) => column.id === HANDLE_COLUMN_ID,
        instructionsFor: args.instructionsFor,
      },
      limits,
      skippedOverCap: args.overCap,
      scanTruncated: args.scanTruncated,
      glossaryChars,
      source,
      managedBudget,
      batchAvailable: args.batchAvailable,
    });
  } catch (err: unknown) {
    logger.warn("[API-AI] Bulk-editor translate estimate failed", { context: "AI", error: errorMessage(err) });
    return null;
  }
}

// ─── Single-flight ─────────────────────────────────────────────────────────

/** A `pending` row nobody has touched for this long is a crash leftover (a
 * claim that never became `running`), not a run: it must not block the shop
 * for ever. */
export const PENDING_CLAIM_STALE_MS = 10 * 60 * 1000;

/** Rows that count as "a translate run is active for this shop". A run waiting
 * for its provider batch (submitting / waiting_batch / cancel_requested) holds
 * the single-flight exactly like a running one: two runs on the same cells is
 * what the flight exists to prevent, and a batch waits up to 24 hours. */
function activeRunWhere(shop: string, now: number = Date.now()) {
  return {
    shop,
    type: "bulkEditorTranslate",
    OR: [
      { status: { in: [...RUN_OCCUPYING_TASK_STATUSES] } },
      { status: "pending", updatedAt: { gte: new Date(now - PENDING_CLAIM_STALE_MS) } },
    ],
  };
}

type RunTaskData = Parameters<PrismaClient["task"]["create"]>[0]["data"];

/**
 * ATOMIC single-flight: insert the row as `pending`, THEN ask whether anything
 * older stands in the way — a check-then-insert lets two requests both pass the
 * check. The row loses when another run is already `running`, or when an older
 * (createdAt, then id) live `pending` row exists; the loser deletes its own
 * row, the winner flips to `running`. Both directions of the race are covered:
 * whichever request's row is committed second sees the other's (each commits
 * its own row before it looks), and a request that decided before the other's
 * row existed is `running` by the time that one looks. A stale `pending` row
 * (PENDING_CLAIM_STALE_MS) is a crash leftover and does not count.
 */
export async function claimBulkTranslateRun(
  db: PrismaClient,
  data: Omit<RunTaskData, "status">,
): Promise<{ ok: true; task: { id: string } } | { ok: false; taskId: string; cancelled?: boolean }> {
  const task = await db.task.create({ data: { ...data, status: "pending" } });
  const blocker = await db.task.findFirst({
    where: {
      shop: data.shop as string,
      type: "bulkEditorTranslate",
      id: { not: task.id },
      OR: [
        { status: { in: [...RUN_OCCUPYING_TASK_STATUSES] } },
        {
          status: "pending",
          updatedAt: { gte: new Date(Date.now() - PENDING_CLAIM_STALE_MS) },
          OR: [{ createdAt: { lt: task.createdAt } }, { createdAt: task.createdAt, id: { lt: task.id } }],
        },
      ],
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true },
  });
  if (blocker) {
    await db.task.deleteMany({ where: { id: task.id, status: "pending" } }).catch(() => undefined);
    return { ok: false, taskId: blocker.id };
  }
  const started = await db.task.updateMany({ where: { id: task.id, status: "pending" }, data: { status: "running" } });
  if (started.count === 0) {
    // Somebody (a cancel, the reaper) took the row between insert and start.
    // A cancel is the merchant's own act and must not be answered with
    // "already running" (there is nothing else running).
    const own = await db.task.findUnique({ where: { id: task.id }, select: { status: true } }).catch(() => null);
    return { ok: false, taskId: task.id, ...(own?.status === "cancelled" ? { cancelled: true } : {}) };
  }
  return { ok: true, task: { id: task.id } };
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
  // Second budget, in SHOPIFY CALLS: an option-values cell is one unit per
  // language but one translationsRegister per value, so a run that stays under
  // the unit cap can still fan out into tens of thousands of calls.
  let calls = 0;

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
      const callsForCell = locales.length * shopifyTargetsPerLocale(column, entry.source);
      if (capped || units + locales.length > MAX_TRANSLATE_UNITS || calls + callsForCell > MAX_TASK_CALLS) {
        capped = true;
        overCap += locales.length;
        continue;
      }
      calls += callsForCell;
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

/** How many Shopify translation calls ONE cell costs per language: a
 * sub-resource cell writes one register per target resource, and an option's
 * values are one target each. */
function shopifyTargetsPerLocale(column: ColumnDescriptor, source: string): number {
  if (!isListValuesColumn(column)) return 1;
  return Math.max(1, source.split(LIST_DISPLAY_SEPARATOR.trim()).length);
}

/** The BASE product field that must run through the shop-wide
 * GroupedFieldTranslation cache — a metaobject field named "productType" is a
 * different thing entirely and must not touch that cache. */
function isGroupedProductTypeColumn(column: ColumnDescriptor): boolean {
  return column.kind === "field" && canonicalFieldNameForColumn(column) === "productType";
}

/** Sub-resource cells that go through the numbered batch prompt: everything
 * except multi-line metafields, whose newlines that prompt would collapse. */
function isBatchSubResourceColumn(column: ColumnDescriptor): boolean {
  if (!isSubResourceColumn(column)) return false;
  return !(column.kind === "metafield" && column.metafieldType === METAFIELD_TYPE_MULTI_LINE);
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

export interface RunArgs {
  db: PrismaClient;
  shop: string;
  admin: AdminApiContext;
  settings: AIActionContext["settings"];
  jobs: TranslateJob[];
  units: number;
  rowType: BulkRowType;
  primaryLocale: string;
  columnsByType: Record<BulkRowType, ColumnDescriptor[]>;
  aiInstructions: { translateInstructions?: string | null } | null;
  seoLimits: AIActionContext["seoLimits"];
  translationMode: AIActionContext["translationMode"];
  /** The candidate columns, metaobject type and target languages of the run:
   * what the local re-check before each write block (recheckMissing) needs.
   * Omitted ⇒ that cheap local re-check is skipped (the live fill-only check
   * inside applyBulkDiff still runs). */
  recheck?: { columns: ColumnDescriptor[]; moType: string; locales: string[] };
  /** Cross-item packages on/off. Omitted = the deployment switch
   *  (BULK_TRANSLATE_PACKAGES, exactly "true"). A TEST SEAM. */
  packages?: boolean;
  /**
   * BATCH COLLECT mode (PLAN_BULK_TRANSLATE_BATCHING 5.5): the same run, with
   * the model's answers coming from a collected provider batch instead of live
   * requests. Everything that makes the live run safe is reused unchanged -- the
   * plan-time read, the per-entry verification (the package ladder), the handle
   * rules, the block re-check and the FILL-ONLY write -- and only four things
   * differ: where the answers come from (`ai`), which Task statuses the run owns
   * (the Task waits as `waiting_batch` / `cancel_requested`, never `running`),
   * the digests the write is held to (the ones recorded at SUBMIT, a stronger
   * promise than a fresh read), and what was settled before the run started.
   */
  batch?: {
    ai: PackagePhaseAI;
    ownStatuses: string[];
    /** `rowId|columnId` -> targetResourceId -> digest, from the manifest. */
    expected: Map<string, Record<string, string>>;
    /** Outcomes already known at collect time (cells that moved or were filled since submit, plan-time results). */
    preAccounted: {
      skippedChanged: number;
      skippedFilled: number;
      mismatchesByKey: Record<string, number>;
      failures: { rowId: string; columnId?: string; locale?: string; message: string }[];
      /** Units of those outcomes (they count as settled). */
      settledUnits: number;
      /** Units the submit never started (productType, fits no package): not failures. */
      notStarted: number;
    };
    /** Provider-side figures for the result JSON (`result.batch`), read when the result is BUILT (the retry count is only final then). */
    summary: () => Record<string, unknown>;
    /**
     * Does the poller still hold the row's lease? A collect writes for minutes; a holder that lost its lease
     * (a stalled renew, a restart race) must stop WRITING before a second holder collects the same batch.
     * Asked wherever the run asks whether it is cancelled -- before every row's AI work and every write block.
     */
    leaseHeld?: () => Promise<boolean>;
  };
}

/**
 * Cross-item packaging (PLAN_BULK_TRANSLATE_BATCHING phase 1b) is OFF unless
 * the deployment says exactly "true". With it off the run is the per-row run it
 * always was, byte for byte (pinned by the "OFF (the default)" test in tests/unit/bulk-translate-packages-run.test.ts).
 */
export function bulkTranslatePackagesEnabled(): boolean {
  return process.env.BULK_TRANSLATE_PACKAGES === "true";
}

/** A write block is flushed once this many cells are buffered … */
export const BULK_TRANSLATE_BLOCK_CELLS = 250;
/** … or this long after the previous write — whichever comes first, so a
 * restart loses at most one block of work and a slow AI phase still saves
 * what it has. Each block is further split by chunkImportDiff to fit one
 * grid save's two caps (cells, estimated Shopify calls). */
export const BULK_TRANSLATE_BLOCK_MS = 60_000;

/** Handles are only unique within one resource type AND one language: a
 * product's /es/ handle and a page's /es/ handle never compete for a URL. */
export function handleScopeKey(resourceType: string, locale: string): string {
  return `${resourceType}|${locale}`;
}

/**
 * The handle translations the shop ALREADY has (the mirror), per resource type
 * and target language, so a handle this run produces is de-duplicated against
 * them and not only against the other handles of the same run. A handle set in
 * Shopify's own editor and not yet mirrored is unknown here — it collides only
 * at write time, as a cell failure.
 */
export async function loadExistingHandles(
  db: PrismaClient,
  shop: string,
  rowType: BulkRowType,
  locales: string[],
): Promise<Map<string, Set<string>>> {
  const byScope = new Map<string, Set<string>>();
  // Metaobjects and images carry no `handle` translation of their own.
  if (rowType === "metaobject" || rowType === "image" || locales.length === 0) return byScope;
  const resourceType = CONTENT_RESOURCE_TYPE_BY_ROW_TYPE[rowType];
  const records = await db.contentTranslation.findMany({
    where: { shop, resourceType, key: "handle", marketId: "", locale: { in: locales } },
    select: { locale: true, value: true },
  });
  for (const record of records) {
    const value = (record.value ?? "").trim();
    if (!value) continue;
    const scope = handleScopeKey(resourceType, record.locale);
    const used = byScope.get(scope) ?? new Set<string>();
    used.add(value);
    byScope.set(scope, used);
  }
  return byScope;
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
  /** Units NOT written because the primary text changed since it was read
   * (plan time or write time) — the page showed a text that is not there any
   * more; the next run takes the cell once the cache has caught up. */
  skippedChanged: number;
  /** Units NOT written because the language got a translation in the
   * meantime (found at a block's re-check, or by the live read before the
   * write). Nothing was overwritten. */
  skippedFilled: number;
  /** Units NOT written because their row is gone or its primary text is empty
   * now (found at a block's re-check): nothing to fill, which is not the same
   * as "already translated". */
  skippedGone: number;
  /** Units that were never processed because the run was stopped (cancelled,
   * reaped) before their turn, including translated cells still buffered.
   * Only present on a stopped run. Not failures. */
  notProcessed?: number;
  /** Units dropped for a source-text mismatch at plan time, per translation
   * key -- a key that is skipped on (nearly) every run points at a systematic
   * representation difference between the cache and Shopify. */
  mismatchesByKey?: Record<string, number>;
  /** "batch" when the answers came from a collected provider batch. */
  mode: "sync" | "batch";
  /** Units the Batch-API submit never started (they fit no package): left for a later "Sofort" run, not failures. */
  notStarted?: number;
  /** Batch mode only: what the provider did with the requests, and what the collect cost. */
  batch?: Record<string, unknown>;
  /** Only present when the run used cross-item packages: how many packages
   *  were planned, how many provider requests and retries they cost, and the
   *  retry rate per group (kind / languages / instruction set). */
  packaging?: {
    packages: number;
    requests: number;
    retries: number;
    oversizedCells: number;
    groups: PackagePhaseResult["stats"]["groups"];
  };
  /** Write blocks that went through applyBulkDiff. */
  blocks: number;
  /** The Task was cancelled: the run stopped before the next step and what was
   * written before that stays written. */
  cancelled?: boolean;
  /**
   * FAILURE BOOKKEEPING, not a write record: `locale` (and `marketId` where
   * the write path recorded one) travel with every entry they are known for.
   * Without them one cell that failed in three languages produced three
   * byte-identical lines on the one screen where "which language" is the whole
   * question — and `applyBulkDiff` had recorded the locale all along.
   */
  failures: {
    rowId: string;
    columnId?: string;
    locale?: string;
    marketId?: string;
    message: string;
  }[];
}

/** How often the run proves it is alive (Task.updatedAt). Well under the boot silence threshold. */
export const BULK_TRANSLATE_HEARTBEAT_MS = 15_000;

/** Exported as a TEST SEAM only — the handler above is the one caller. */
export async function runBulkEditorTranslate(taskId: string, args: RunArgs): Promise<void> {
  const { db, shop, admin, settings, jobs: plannedJobs, units, rowType, primaryLocale, columnsByType } = args;
  const { aiInstructions, seoLimits, translationMode } = args;
  /** The merchant's instructions, with the SEO caps for the fields of ONE call.
   * Built per call because the caps are per field key: a cap for a field this
   * request does not carry is an instruction about nothing. */
  const instructionsFor = (fieldKeys: string[]): string | undefined =>
    buildTranslateInstructions(
      getInstructionWithDefault(aiInstructions, "translateInstructions"),
      translationMode,
      fieldKeys,
      { limits: seoLimits as unknown as Record<string, number> | null },
    );
  const contentType = BULK_ROW_TYPE_TO_CONTENT_TYPE[rowType];
  // createAIService(settings, shop, taskId) → every provider call goes through
  // AIQueueService.enqueue (rate limits, per-shop fairness).
  const batch = args.batch;
  // In batch mode the answers come from the collected batch; the live service is not built here (a live
  // retry, when allowed, is the wrapper's own business and goes through the normal gate).
  const aiService = batch ? (null as unknown as AIService) : createAIService(settings, shop, taskId);
  /** The Task statuses this run owns: `running` live, `waiting_batch` / `cancel_requested` while collecting. */
  const ownStatuses = batch?.ownStatuses ?? ["running"];
  /** The `where.status` of a conditional Task update: byte-for-byte `"running"` on the live run. */
  const ownStatusWhere = batch ? { in: ownStatuses } : ("running" as const);
  const notStartedUnits = batch?.preAccounted.notStarted ?? 0;

  /** Translated, verified-so-far entries waiting for their write block. */
  let buffer: BulkDiffEntry[] = [];
  const failures: TranslateResultJson["failures"] = [...(batch?.preAccounted.failures ?? [])];
  let skippedHandles = 0;
  let skippedChanged = batch?.preAccounted.skippedChanged ?? 0;
  let skippedFilled = batch?.preAccounted.skippedFilled ?? 0;
  let skippedGone = 0;
  let mismatchesByKey: Record<string, number> = { ...(batch?.preAccounted.mismatchesByKey ?? {}) };
  let saved = 0;
  let blocks = 0;
  let packaging: TranslateResultJson["packaging"] | undefined;
  /** Units whose outcome is FINAL: written, skipped on purpose or failed. The
   * progress bar counts these, so it never runs ahead of what is stored. */
  let settled = batch?.preAccounted.settledUnits ?? 0;
  let lastWriteAt = Date.now();

  const heartbeat = async () => {
    await db.task
      .update({
        where: { id: taskId },
        // 99, not 100: only the terminal update below says "done".
        data: { processed: settled, progress: Math.min(99, Math.round((settled / Math.max(1, units)) * 99)) },
      })
      .catch(() => undefined);
  };

  /** Handles already produced in this run PLUS the ones the shop already has,
   * per (resource type, language) — two products whose titles translate to the
   * same slug must not fight over one URL, and neither may a new one collide
   * with a handle the mirror already holds. Filled by the prefill below. */
  const handlesByScope = new Map<string, Set<string>>();
  /** productType is translated ONCE per distinct source value across the whole
   * run (shop-wide GroupedFieldTranslation cache) — otherwise one Google
   * Merchant category fans out into several AI variants across the catalog. */
  const groupedService = new GroupedFieldTranslationService(db);
  const productTypeCache = new Map<string, Record<string, string>>();

  // A managed-AI refusal (budget spent, pool closed, consent withdrawn) stops
  // the run like a rejected key would — every further call would be refused
  // too — but, unlike a rejected key, it must not throw away what the run
  // already translated: the loops stop, the diff collected so far is still
  // written through applyBulkDiff, and the machine code
  // (`managed_ai_refused:<reason>`) becomes the Task error, which the Tasks
  // tab renders as a stand-down. A rejected PROVIDER key still aborts the run
  // as before.
  // Widened on purpose: it is set inside `standsDown`, which TS's narrowing of
  // a `let` initialised to null does not see.
  let managedRefusal = null as string | null;
  /** True when the error stopped the run on a managed refusal (recorded);
   * re-throws a rejected provider key; false for an ordinary failure. */
  const standsDown = (err: unknown): boolean => {
    if (isManagedRefusal(err)) {
      managedRefusal ??= managedRefusalCode(err);
      return true;
    }
    // The AI queue was stopped for a deploy / restart: every further call would
    // be rejected the same way, but what the run ALREADY translated is real work
    // and is still written through applyBulkDiff (a throw here used to skip it,
    // the outer catch only failing the task). Recorded under its own machine
    // code, which the Tasks tab renders as "stopped by a server restart".
    if (isAIQueueShuttingDown(err)) {
      managedRefusal ??= "server_shutting_down";
      return true;
    }
    if (isRunAbortingAIError(err)) throw err;
    return false;
  };

  // Cancellation (Tasks tab → "cancelled"): checked before every row's AI work
  // and before every write block. Anything but "running" ends the run — a
  // cancelled, deleted or reaped Task must not keep spending the merchant's
  // AI budget or keep writing. A failed status read is transient and does not
  // stop a run.
  let stoppedBy = null as string | null;
  const shouldStop = async (): Promise<boolean> => {
    if (stoppedBy) return true;
    try {
      if (batch?.leaseHeld && !(await batch.leaseHeld())) {
        // Not a Task status: the final update matches nothing, so a lost lease never settles the Task.
        stoppedBy = "lease_lost";
        return true;
      }
      const row = await db.task.findUnique({ where: { id: taskId }, select: { status: true } });
      if (!row) stoppedBy = "deleted";
      else if (!ownStatuses.includes(row.status)) stoppedBy = row.status;
    } catch {
      // transient — keep going
    }
    return stoppedBy !== null;
  };

  /** One write block: local re-check, then applyBulkDiff in FILL-ONLY mode in
   * pieces that each fit a grid save's two caps. */
  const flush = async (): Promise<void> => {
    if (buffer.length === 0) return;
    let entries = buffer;
    buffer = [];
    lastWriteAt = Date.now();

    // Cheap local second barrier (the live Shopify read inside applyBulkDiff is
    // the strong one): a cell the mirror already has since the scan is dropped.
    if (args.recheck) {
      try {
        const rechecked = await recheckMissingDetailed(db, shop, {
          type: rowType,
          moType: args.recheck.moType,
          admin: admin as never,
          rowIds: entries.map((e) => e.rowId),
          columns: args.recheck.columns,
          locales: args.recheck.locales,
        });
        const kept = entries.filter((e) => rechecked.missing.has(`${e.rowId}|${e.columnId}|${e.locale}`));
        const dropped = entries.filter((e) => !rechecked.missing.has(`${e.rowId}|${e.columnId}|${e.locale}`));
        if (dropped.length > 0) {
          // WHY a cell left matters: "already translated" is reassuring, a
          // row that is gone or a source that is empty now is not.
          const gone = dropped.filter(
            (e) => rechecked.goneRows.has(e.rowId) || rechecked.emptySources.has(`${e.rowId}|${e.columnId}`),
          ).length;
          skippedGone += gone;
          skippedFilled += dropped.length - gone;
          settled += dropped.length;
          entries = kept;
        }
      } catch (err: unknown) {
        logger.warn("[API-AI] Bulk-editor translate: block re-check failed, relying on the live check", {
          context: "AI",
          taskId,
          error: errorMessage(err),
        });
      }
    }

    const pieces = chunkImportDiff(entries, columnsByType[rowType] ?? [], { fillOnly: true });
    for (const piece of pieces) {
      if (await shouldStop()) return;
      blocks++;
      const blockStartedAt = Date.now();
      try {
        // The SAME verified write path as manual saving: digest rule (§6.3),
        // registerAndVerify echo check, DB mirror, markTranslationSaved — in
        // fill-only mode, so a value that is there now is never overwritten
        // and a text that moved since the plan is never registered against.
        const applyResult = await applyBulkDiff({ db, shop, admin, columnsByType, fillOnly: true }, piece);
        // Block timing (PLAN_BULK_TRANSLATE_BATCHING 7 / 11 step 1c): the
        // measurement the MAX_TRANSLATE_UNITS decision waits for. Counts only,
        // no merchant text.
        logger.info("[BulkTranslate] write block timing", {
          context: "AI",
          taskId,
          block: blocks,
          cells: piece.length,
          durationMs: Date.now() - blockStartedAt,
        });
        // applyResult.saved counts row GROUPS, not translations — count the
        // entries no failure was attributed to instead (a cell failure carries
        // its columnId + locale, a row-level one only the row), minus the
        // cells that were deliberately skipped (both counted per cell).
        const failedCells = new Set<string>();
        const failedRowLocales = new Set<string>();
        for (const failure of applyResult.failures) {
          const locale = failure.locale ?? "";
          if (failure.columnId) failedCells.add(`${failure.rowId}|${locale}|${failure.columnId}`);
          else failedRowLocales.add(`${failure.rowId}|${locale}`);
        }
        const notFailed = piece.filter(
          (entry) =>
            !failedCells.has(`${entry.rowId}|${entry.locale}|${entry.columnId}`) &&
            !failedRowLocales.has(`${entry.rowId}|${entry.locale}`),
        ).length;
        const changed = applyResult.skippedChanged ?? 0;
        const filled = applyResult.skippedFilled ?? 0;
        skippedChanged += changed;
        skippedFilled += filled;
        saved += Math.max(0, notFailed - changed - filled);
        // The verified write path records `locale`/`marketId` per failed cell
        // (BulkFailure, columns.shared.ts) and stripping them here threw away
        // the only thing that told two of its lines apart.
        failures.push(
          ...applyResult.failures.map((f) => ({
            rowId: f.rowId,
            columnId: f.columnId,
            locale: f.locale,
            marketId: f.marketId,
            message: f.message,
          })),
        );
      } catch (err: unknown) {
        // A block that throws loses ITS cells only; the blocks before it are
        // written, the ones after it still run.
        const message = errorMessage(err);
        logger.error("[API-AI] Bulk-editor translate: write block failed", { context: "AI", taskId, error: message });
        for (const entry of piece) {
          failures.push({ rowId: entry.rowId, columnId: entry.columnId, locale: entry.locale, message });
        }
      }
      settled += piece.length;
      await heartbeat();
    }
  };

  // Package workers run concurrently and each may find a block due: flushes are
  // chained so only one write block is in flight (the per-row path calls
  // flush() sequentially and is unaffected).
  let flushChain: Promise<void> = Promise.resolve();
  const flushSerial = (): Promise<void> => {
    flushChain = flushChain.then(flush, flush);
    return flushChain;
  };
  const blockDue = (): boolean =>
    buffer.length >= BULK_TRANSLATE_BLOCK_CELLS || Date.now() - lastWriteAt >= BULK_TRANSLATE_BLOCK_MS;

  // A bounded-interval HEARTBEAT, independent of the job loop (one AI call may take minutes): boot recovery and
  // the reaper treat this type as orphaned only after a silence (orphan-run-recovery.js), so a run that is alive
  // in another container during a deploy overlap is never failed under its own feet.
  const beat = setInterval(() => {
    void db.task
      .updateMany({ where: { id: taskId, status: ownStatusWhere }, data: { updatedAt: new Date() } })
      .catch(() => undefined);
  }, BULK_TRANSLATE_HEARTBEAT_MS);
  try {
    // ── Plan: what is the primary text NOW? ────────────────────────────────
    // One batched Shopify read before any AI money is spent; see
    // translate-plan-read.server.ts. Drops cells whose text moved, records the
    // digests the write will be held to, fails the cells it cannot verify.
    const plan = await planTranslateRead(
      { db, shop, gateway: new ShopifyApiGateway(admin, shop), rowType },
      plannedJobs,
    );
    const jobs = plan.jobs;
    skippedChanged += plan.skippedChanged;
    settled += plan.skippedChanged;
    // Merged, not replaced: a batch collect carries the submit-time mismatches in already.
    for (const [key, n] of Object.entries(plan.mismatchesByKey ?? {})) mismatchesByKey[key] = (mismatchesByKey[key] ?? 0) + n;
    for (const failure of plan.failures) {
      failures.push({ rowId: failure.rowId, columnId: failure.columnId, message: failure.message });
      settled += failure.units;
    }
    // Handles the shop already holds, so a fresh one never takes their URL.
    if (jobs.some((job) => job.cells.some((c) => c.column.id === HANDLE_COLUMN_ID))) {
      const targetLocales = [...new Set(jobs.flatMap((job) => job.cells.flatMap((c) => c.locales)))];
      try {
        for (const [scope, used] of await loadExistingHandles(db, shop, rowType, targetLocales)) {
          handlesByScope.set(scope, used);
        }
      } catch (err: unknown) {
        // Not fatal: the in-run set still guards duplicates inside this run,
        // and a collision with an existing handle surfaces as a cell failure.
        logger.warn("[API-AI] Bulk-editor translate: could not preload existing handles", {
          context: "AI",
          taskId,
          error: errorMessage(err),
        });
      }
    }
    await heartbeat();

    /**
     * ONE finished cell: per language, its verified text (or none) becomes a
     * write-buffer entry, a skipped handle or a failure. Shared by the per-row
     * loop below and the package phase, so a handle, a stand-down or a missing
     * answer means the same thing on both.
     */
    const emitCell = (
      job: TranslateJob,
      cell: TranslateJob["cells"][number],
      valueFor: (locale: string) => string | undefined,
      skipLocale?: (locale: string) => boolean,
    ) => {
      // Batch collect: the digests recorded at SUBMIT (the text the model was asked about) win over the
      // fresh ones -- a text that moved while the batch waited must be refused, not translated-over.
      const cellKey = planCellKey(job.rowId, cell.column.id);
      const expected = batch?.expected.get(cellKey) ?? plan.expected.get(cellKey);
      for (const locale of cell.locales) {
        if (skipLocale?.(locale)) continue;
        // Never substitute the source text — an untranslated value written
        // as a "translation" is silent corruption.
        let value = (valueFor(locale) ?? "").trim();
        if (!value && managedRefusal) {
          // Not attempted (or refused) after the stand-down: it is counted
          // as not saved and explained by the Task error, not reported as
          // an AI that answered nothing.
          settled++;
          continue;
        }
        if (!value) {
          settled++;
          failures.push({
            rowId: job.rowId,
            columnId: cell.column.id,
            locale,
            message: "AI returned no translation.",
          });
          continue;
        }
        if (cell.column.id === HANDLE_COLUMN_ID) {
          // AI output → a slug Shopify accepts; identical-to-primary handles
          // are skipped on purpose (a translated URL that equals the primary
          // one is a routing conflict, not a translation).
          const scope = handleScopeKey(CONTENT_RESOURCE_TYPE_BY_ROW_TYPE[rowType], locale);
          const used = handlesByScope.get(scope) ?? new Set<string>();
          handlesByScope.set(scope, used);
          value = dedupeHandle(normalizeTranslatedHandle(value), used);
          if (!value || value === job.primaryHandle.trim()) {
            skippedHandles++;
            settled++;
            continue;
          }
        }
        buffer.push({
          rowId: job.rowId,
          rowType,
          locale,
          // GLOBAL only — the page has no market dimension.
          marketId: "",
          columnId: cell.column.id,
          value,
          // The digests the plan read, which the fill-only write holds the
          // registration to (text moved since ⇒ skipped, not registered).
          ...(expected ? { expected } : {}),
        });
      }
    };

    // Cross-item packages (BULK_TRANSLATE_PACKAGES, off by default): carry the
    // cells they can; whatever they leave runs through the per-row loop below.
    let loopJobs = jobs;
    if ((batch || (args.packages ?? bulkTranslatePackagesEnabled())) && !managedRefusal && !(await shouldStop())) {
      const phase = await runPackagePhase({
        jobs,
        ai: (batch ? batch.ai : aiService) as never,
        primaryLocale,
        contentType,
        instructionsFor,
        isGroupedColumn: isGroupedProductTypeColumn,
        isValueColumn: isBatchSubResourceColumn,
        isShortColumn: isShortFieldColumn,
        isListValuesColumn,
        isHandleColumn: (column) => column.id === HANDLE_COLUMN_ID,
        isTitleColumn: (column) => column.kind === "field" && canonicalFieldNameForColumn(column) === "title",
        mergeList: mergeExistingListValues,
        emitCell: (job, cell, valueFor) => emitCell(job, cell, valueFor),
        standsDown,
        shouldStop,
        managedRefusal: () => managedRefusal,
        ...(batch ? { outputCap: PACKAGE_OUTPUT_CAP_BATCH } : {}),
        afterPackage: async () => {
          await heartbeat();
          if (!managedRefusal && blockDue()) await flushSerial();
        },
        log: (level, message, meta) => logger[level](message, { context: "AI", taskId, ...meta }),
      });
      // A batch collect has no per-row path: what the packages did not carry was never submitted.
      loopJobs = batch ? [] : phase.remainingJobs;
      packaging = {
        packages: phase.stats.packages,
        requests: phase.stats.requests,
        retries: phase.stats.retries,
        oversizedCells: phase.stats.oversizedCells,
        groups: phase.stats.groups,
      };
    }

    for (const job of loopJobs) {
      if (managedRefusal) break;
      if (await shouldStop()) break;
      // Routing keys on the COLUMN, never on the AI payload key: a metaobject
      // field may legitimately be called "handle" or "productType", and it must
      // NOT be slugified or written into the shop-wide productType cache.
      const grouped = job.cells.filter((c) => isGroupedProductTypeColumn(c.column));
      // Metafield/option cells are short, standalone strings on their own
      // Shopify resource — translateBatchValues is the prompt the single-item
      // editor already uses for exactly these (sub-resources.action.ts). Its
      // sanitizer strips newlines, so MULTI-LINE metafields take the long path
      // instead (same hazard as the metaobject text fields).
      const sub = job.cells.filter((c) => isBatchSubResourceColumn(c.column));
      const short = job.cells.filter(
        (c) =>
          !isGroupedProductTypeColumn(c.column) && !isBatchSubResourceColumn(c.column) && isShortFieldColumn(c.column),
      );
      const long = job.cells.filter(
        (c) =>
          !isGroupedProductTypeColumn(c.column) && !isBatchSubResourceColumn(c.column) && !isShortFieldColumn(c.column),
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
      // Deliberately carries NO locale: the short/long batch call covers every
      // target language of the cell at once, so its failure is the cell's, in
      // all of them. Naming one would be a claim the run cannot make.
      const failGroup = (cells: TranslateJob["cells"], message: string) => {
        for (const cell of cells) {
          failedColumnIds.add(cell.column.id);
          failures.push({ rowId: job.rowId, columnId: cell.column.id, message });
          settled += cell.locales.length;
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
              instructionsFor(short.map((c) => c.fieldKey)),
            ),
          );
        } catch (err: unknown) {
          // An invalid AI key fails every remaining row identically — abort;
          // a managed refusal stops the run but keeps what it collected.
          if (!standsDown(err)) failGroup(short, errorMessage(err));
        }
      }

      if (long.length > 0 && !managedRefusal) {
        try {
          collect(
            await aiService.translateFieldsToLocalesChunked(
              payloadOf(long),
              primaryLocale,
              unionLocales(long),
              {
                preserveHtml: true,
                contextLabel: contentType,
                customInstructions: instructionsFor(long.map((c) => c.fieldKey)),
              },
            ),
          );
        } catch (err: unknown) {
          if (!standsDown(err)) failGroup(long, errorMessage(err));
        }
      }

      for (const cell of grouped) {
        if (managedRefusal) break;
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
          if (!standsDown(err)) failGroup([cell], errorMessage(err));
        }
      }

      if (sub.length > 0 && !managedRefusal) {
        // The sub-resource strings of the row, over EVERY language they need at
        // once. This was one call per locale, not by design but because
        // `translateBatchValues` takes a single `toLang`: a product with sixty
        // metafields on an eight-language shop paid eight requests where the
        // same edit to its title paid one. `translateBatchValuesToLocales`
        // chunks on both dimensions, so a short set of values still goes in one
        // request and a long one still splits.
        //
        // Grouped by LOCALE SET rather than batched over the union, because the
        // scan answers per cell: two cells of one row can be missing different
        // languages, and translating a value into a language no cell asked for
        // is output paid for and thrown away. Most rows have exactly one group.
        const byLocaleSet = new Map<string, TranslateJob["cells"]>();
        for (const cell of sub) {
          const signature = [...cell.locales].sort().join(",");
          byLocaleSet.set(signature, [...(byLocaleSet.get(signature) ?? []), cell]);
        }

        for (const [signature, cellsForSet] of byLocaleSet) {
          if (managedRefusal) break;
          const localesForSet = signature.split(",").filter(Boolean);
          const slices: { cell: TranslateJob["cells"][number]; start: number; length: number }[] = [];
          const values: string[] = [];
          for (const cell of cellsForSet) {
            const parts = isListValuesColumn(cell.column)
              ? cell.source.split(LIST_DISPLAY_SEPARATOR.trim()).map((v) => v.trim())
              : [cell.source];
            slices.push({ cell, start: values.length, length: parts.length });
            values.push(...parts);
          }
          try {
            const perLocale = await aiService.translateBatchValuesToLocales(
              values,
              primaryLocale,
              localesForSet,
              "product options and metafield values",
              // A metafield value and an option name are merchant content like a
              // title is; the instruction that says how to word things has no
              // reason to hold for one and not the other. No field keys: these
              // values have no named field, so no SEO cap applies to them.
              { instructions: instructionsFor([]) },
            );
            for (const locale of localesForSet) {
              const translated = perLocale[locale] ?? [];
              for (const slice of slices) {
                const parts = translated.slice(slice.start, slice.start + slice.length);
                // Never substitute the source: a missing entry stays empty and is
                // reported as a failed cell below. An entry a CHUNK could not
                // deliver comes back as "" at its own index, which lands here.
                if (parts.length !== slice.length || parts.some((v) => !v || !v.trim())) continue;
                const merged = isListValuesColumn(slice.cell.column)
                  ? mergeExistingListValues(parts, slice.cell.existingListValuesByLocale?.[locale])
                  : parts[0].trim();
                collect({ [locale]: { [slice.cell.fieldKey]: merged } });
              }
            }
          } catch (err: unknown) {
            // Only a run whose EVERY chunk failed throws; a single bad chunk
            // leaves its own entries empty instead. So this is the whole group's
            // failure, in every language it covered.
            if (standsDown(err)) continue;
            const message = errorMessage(err);
            for (const cell of cellsForSet) {
              for (const locale of localesForSet) {
                failedCellLocales.add(`${cell.column.id}|${locale}`);
                failures.push({ rowId: job.rowId, columnId: cell.column.id, locale, message });
                settled++;
              }
            }
          }
        }
      }

      for (const cell of job.cells) {
        if (failedColumnIds.has(cell.column.id)) continue;
        emitCell(
          job,
          cell,
          (locale) => results[locale]?.[cell.fieldKey],
          (locale) => failedCellLocales.has(`${cell.column.id}|${locale}`),
        );
      }
      await heartbeat();
      // Write in BLOCKS as the run goes, not once at the end: a restart then
      // loses at most the block in flight (re-running is resuming — only what
      // is still missing is found), and a long run shows its result as it goes.
      if (!managedRefusal && blockDue()) {
        await flushSerial();
      }
    }

    // The tail block — also after a managed stand-down (what was translated
    // before it is real work), never after a cancellation.
    if (!(await shouldStop())) await flushSerial();

    // Every selected unit ends in exactly one bucket: saved, deliberately
    // skipped, or failed — derived, so the buckets always add up to the run.
    const accounted = saved + skippedHandles + skippedChanged + skippedFilled + skippedGone;
    // A stopped run did not process everything: only what reached a final
    // outcome (settled) and is not written/skipped is a failure; the rest was
    // never processed and is NOT a failure.
    const failed = stoppedBy
      ? Math.max(0, settled - accounted)
      : Math.max(0, units - accounted - notStartedUnits);
    const notProcessed = stoppedBy ? Math.max(0, units - settled - notStartedUnits) : 0;
    const result: TranslateResultJson = {
      saved,
      failed,
      skippedHandles,
      skippedChanged,
      skippedFilled,
      skippedGone,
      ...(notProcessed > 0 ? { notProcessed } : {}),
      ...(Object.keys(mismatchesByKey).length > 0 ? { mismatchesByKey } : {}),
      mode: batch ? "batch" : "sync",
      ...(notStartedUnits > 0 ? { notStarted: notStartedUnits } : {}),
      ...(batch ? { batch: batch.summary() } : {}),
      blocks,
      ...(packaging ? { packaging } : {}),
      ...(stoppedBy === "cancelled" ? { cancelled: true } : {}),
      failures,
    };
    const failedRows = new Set(failures.map((f) => f.rowId)).size;
    if (stoppedBy) {
      // Cancelled (or reaped, or deleted) under the run: the Task already has
      // its terminal state and keeps it. A row that still exists gets what the
      // run did write (cancelled, or failed by the reaper), so the Tasks tab
      // does not report "nothing happened". CONDITIONAL on the status we
      // observed: a deleted row matches nothing and is never resurrected, and
      // the status itself is never touched.
      logger.warn("[API-AI] Bulk-editor translate: stopped", { context: "AI", taskId, status: stoppedBy, saved });
      if (stoppedBy !== "deleted") {
        await db.task
          .updateMany({
            where: { id: taskId, status: stoppedBy },
            data: { processed: settled, result: JSON.stringify(result) },
          })
          .catch(() => undefined);
      }
      return;
    }
    if (managedRefusal) {
      // A managed-AI refusal OR a queue shutdown (`server_shutting_down`): the
      // code says which.
      logger.warn("[API-AI] Bulk-editor translate: stood down", {
        context: "AI", taskId, refusal: managedRefusal, saved,
      });
    }
    // CONDITIONAL on still being "running": a row somebody else already settled (boot recovery of a genuinely
    // dead run) keeps its terminal state instead of flipping back.
    const terminal = {
      status: saved === 0 && (failedRows > 0 || managedRefusal) ? "failed" : "completed",
      progress: 100,
      processed: units,
      completedAt: new Date(),
      result: JSON.stringify(result),
      // A machine code, translated at render time by `taskErrorText` — this
      // runner has no merchant locale. No total: `units` counts translated
      // CELLS, not rows, so it is not the denominator of `failedRows`.
      // A managed stand-down outranks the row count: it is the reason the
      // rest was not translated.
      error: managedRefusal
        ? managedRefusal.substring(0, 1000)
        : failedRows > 0
          ? `rows_failed:${failedRows}`.substring(0, 1000)
          : null,
    };
    if (batch) {
      // One conditional update per owned status: a run the merchant asked to cancel
      // (`cancel_requested`) ends as `cancelled` -- its partial results are written, and
      // saying "completed" over a cancel would be the wrong word.
      for (const status of ownStatuses) {
        await db.task.updateMany({
          where: { id: taskId, status },
          data: { ...terminal, status: status === "cancel_requested" ? "cancelled" : terminal.status },
        });
      }
    } else {
      await db.task.updateMany({ where: { id: taskId, status: "running" }, data: terminal });
    }
  } catch (err: unknown) {
    const message = errorMessage(err);
    logger.error("[API-AI] Bulk-editor translate: run failed", { context: "AI", taskId, error: message });
    await db.task
      .updateMany({
        where: { id: taskId, status: ownStatusWhere },
        data: {
          status: "failed",
          progress: 100,
          completedAt: new Date(),
          error: message.substring(0, 1000),
          // Blocks written before the failure are written: keep their result,
          // so the Tasks tab does not report a half-written run as "nothing
          // happened".
          ...(saved > 0
            ? {
                result: JSON.stringify({
                  saved,
                  failed: Math.max(0, units - saved - skippedHandles - skippedChanged - skippedFilled - skippedGone),
                  skippedHandles,
                  skippedChanged,
                  skippedFilled,
                  skippedGone,
                  mode: batch ? "batch" : "sync",
                  blocks,
                  ...(packaging ? { packaging } : {}),
                  failures,
                }),
              }
            : {}),
        },
      })
      .catch(() => undefined);
  } finally {
    clearInterval(beat);
  }
}

/** The Task-error code of a managed refusal: `managed_ai_refused:<reason>`
 * (ManagedAiRefusedError's own message; built from `reason` otherwise). */
function managedRefusalCode(err: unknown): string {
  const message = errorMessage(err);
  if (/^managed_ai_refused:/.test(message)) return message;
  const reason = (err as { reason?: unknown } | null)?.reason;
  return `managed_ai_refused:${typeof reason === "string" && reason ? reason : "unknown"}`;
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
