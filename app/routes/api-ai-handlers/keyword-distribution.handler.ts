/**
 * AI keyword distribution (PLAN_KEYWORDS_EXPANSION.md §5.4) — the
 * `distributeKeywords` action behind the keyword-group "Distribute" button.
 *
 * Two stages, both running as detached Tasks (type `distributeKeywords`,
 * registered in task-recovery.service.js LONG_RUNNING_TASK_TYPES; the shared
 * single-flight guard covers both so a shop never runs two at once):
 *
 *  - stage "suggest": batched LLM calls (ALL group keywords + one item chunk
 *    per call, see keyword-distribution.service.ts), deterministic
 *    cross-batch merge, suggestions stored as JSON on Task.result. NOTHING is
 *    assigned — the preview table in app.seo.keywords.tsx is the quality
 *    gate (plan §10: no auto-apply).
 *
 *  - stage "apply": merchant-accepted suggestions → assignKeyword per row
 *    (primary with fallback to secondary on conflict — a distribution must
 *    not clobber a deliberately chosen primary unless the merchant opted
 *    into demotion), heartbeat every 10 rows. On completion the suggest
 *    task's result is stamped `appliedAt` so the preview disappears.
 */

import { json } from "@remix-run/node";
import type { AIActionContext } from "./shared";
import { errorMessage, createAIService, isAuthError } from "./shared";
import { getFormString, getFormJSON } from "~/utils/form-data.utils";
import { getTaskExpirationDate } from "~/config/constants";
import { logger } from "~/utils/logger.server";
import { isValidShopifyGID } from "~/utils/validation";
import { meetsPlan } from "~/utils/planUtils";
import { sanitizePromptInput } from "~/utils/prompt-sanitizer";
import { getCachedShopLocales } from "~/utils/shop-locales-cache.server";
import type { Plan } from "~/config/plans";
import type { AISettings, PrismaClient } from "@prisma/client";
import {
  assignKeyword,
  getGroupKeywords,
  MAX_KEYWORDS_PER_ITEM,
  type KeywordResourceType,
} from "~/services/seo/keywords.service";
import {
  buildDistributionPrompt,
  buildItemSnippet,
  chunkItems,
  computeItemsPerBatch,
  mergeBatchResults,
  parseDistributionResponse,
  type DistributionItem,
  type DistributionKeyword,
  type DistributionSuggestion,
} from "~/services/seo/keyword-distribution.service";

const RESOURCE_TYPES: KeywordResourceType[] = ["Product", "Collection", "Article", "Page"];

/** Hard bound on the target item set of ONE run — keeps the worst-case cost
 *  preview honest (plan §5.5 talks ~67 calls at >1000 products; 2000 items ≈
 *  134 calls is where we cut off rather than let a call-storm build). */
const MAX_DISTRIBUTION_ITEMS = 2000;

/** What the suggest stage persists on Task.result. */
export interface DistributionSuggestResult {
  stage: "suggest";
  groupId: string;
  groupName: string;
  targetType: KeywordResourceType;
  maxSecondaries: number;
  suggestions: DistributionSuggestion[];
  /** id → title for every item referenced by a suggestion (preview labels). */
  itemTitles: Record<string, string>;
  keywordCount: number;
  itemCount: number;
  batches: number;
  /** Batches whose LLM response was unparseable — their items got no votes. */
  failedBatches: number;
  /** Set by the apply stage once the merchant applied this preview. */
  appliedAt?: string;
}

export interface DistributionApplyResult {
  stage: "apply";
  applied: number;
  demotedToSecondary: number;
  skipped: number;
  errors: number;
}

export async function handleDistributeKeywords(ctx: AIActionContext): Promise<Response> {
  const { session, db, settings, formData } = ctx;

  // Pro-gate (plan §5.5) — same gate style as GSC. /api/ai has no route-level
  // plan gate, so it must live here.
  const plan = (settings?.subscriptionPlan || "free") as Plan;
  if (!meetsPlan(plan, "pro")) {
    return json({ success: false, error: "This feature requires the Pro plan or higher." }, { status: 403 });
  }

  // Single-flight across BOTH stages: a suggest run and an apply run touch the
  // same rows; a second concurrent run of either would race it.
  const runningTask = await db.task.findFirst({
    where: { shop: session.shop, type: "distributeKeywords", status: "running" },
    select: { id: true },
  });
  if (runningTask) {
    return json(
      {
        success: false,
        code: "ALREADY_RUNNING",
        error: "A keyword distribution is already running for this store. Check the Tasks tab for progress.",
        taskId: runningTask.id,
      },
      { status: 409 },
    );
  }

  const stage = getFormString(formData, "stage") || "suggest";
  if (stage === "apply") return handleApplyStage(ctx);
  return handleSuggestStage(ctx);
}

// ─── Stage "suggest" ───────────────────────────────────────────────────────

async function handleSuggestStage(ctx: AIActionContext): Promise<Response> {
  const { session, db, settings, formData } = ctx;

  const groupId = getFormString(formData, "groupId");
  const targetType = getFormString(formData, "targetType") as KeywordResourceType;
  const rawMaxSecondaries = Number(getFormString(formData, "maxSecondaries") || "3");
  const maxSecondaries = Number.isInteger(rawMaxSecondaries)
    ? Math.min(Math.max(rawMaxSecondaries, 0), MAX_KEYWORDS_PER_ITEM - 1)
    : 3;
  // Optional product facet filter (plan §5.4 modal) — Product only.
  // productType only: the cached Product model has NO vendor column, so the
  // plan's vendor facet is not implementable from the cache.
  const filterProductType = getFormString(formData, "filterProductType");

  if (!groupId || !RESOURCE_TYPES.includes(targetType)) {
    return json({ success: false, error: "Invalid distribution parameters." }, { status: 400 });
  }

  const group = await db.seoKeywordGroup.findFirst({
    where: { id: groupId, shop: session.shop },
    select: { id: true, name: true },
  });
  if (!group) {
    return json({ success: false, error: "Keyword group not found." }, { status: 404 });
  }

  const groupKeywords = await getGroupKeywords(db, session.shop, groupId);
  if (groupKeywords.length === 0) {
    return json({ success: false, error: "This group has no keywords to distribute." }, { status: 400 });
  }

  const items = await loadTargetItems(db, session.shop, targetType, {
    productType: filterProductType,
  });
  if (items.length === 0) {
    return json({ success: false, error: "No target items found for this distribution." }, { status: 400 });
  }
  if (items.length > MAX_DISTRIBUTION_ITEMS) {
    return json(
      {
        success: false,
        error: `A single distribution is limited to ${MAX_DISTRIBUTION_ITEMS} items — narrow the target set with a filter.`,
      },
      { status: 400 },
    );
  }

  const perBatch = computeItemsPerBatch(groupKeywords.length);
  const batches = chunkItems(items, perBatch);

  const task = await db.task.create({
    data: {
      shop: session.shop,
      type: "distributeKeywords",
      status: "running",
      resourceType: "seo",
      resourceTitle: group.name,
      fieldType: "suggest",
      total: batches.length,
      processed: 0,
      progress: 0,
      expiresAt: getTaskExpirationDate(),
    },
  });

  const keywords: DistributionKeyword[] = groupKeywords.map((k) => ({
    keyword: k.keyword,
    locale: k.locale,
    priority: k.priority,
    intent: k.intent,
  }));

  void runSuggestStage(task.id, {
    db,
    settings,
    shop: session.shop,
    group: { id: group.id, name: group.name },
    targetType,
    maxSecondaries,
    keywords,
    items,
    batches,
  }).catch(async (err: unknown) => {
    logger.error("[API-AI] Keyword distribution (suggest) crashed", {
      context: "AI",
      taskId: task.id,
      error: errorMessage(err),
    });
    await db.task
      .update({
        where: { id: task.id },
        data: { status: "failed", completedAt: new Date(), error: errorMessage(err).substring(0, 1000) },
      })
      .catch(() => {});
  });

  return json({ success: true, taskId: task.id, total: batches.length });
}

interface SuggestRunArgs {
  db: PrismaClient;
  settings: AISettings | null;
  shop: string;
  group: { id: string; name: string };
  targetType: KeywordResourceType;
  maxSecondaries: number;
  keywords: DistributionKeyword[];
  items: DistributionItem[];
  batches: DistributionItem[][];
}

async function runSuggestStage(taskId: string, args: SuggestRunArgs): Promise<void> {
  const { db, settings, shop, group, targetType, maxSecondaries, keywords, items, batches } = args;

  const aiService = createAIService(settings, shop, taskId);
  // The prompt sanitizes keyword text (buildDistributionPrompt) — the model
  // echoes the SANITIZED form, so validation must match against it and map
  // back to the raw stored text afterwards (review L8). For normal keywords
  // sanitized === raw and this is a no-op.
  const sanitizedToRaw = new Map<string, string>();
  for (const k of keywords) {
    sanitizedToRaw.set(
      sanitizePromptInput(k.keyword, { fieldType: "general" }).trim().toLowerCase(),
      k.keyword,
    );
  }
  const validKeywords = new Set(sanitizedToRaw.keys());
  const validItemIds = new Set(items.map((it) => it.id));

  const perBatchResults: DistributionSuggestion[][] = [];
  let failedBatches = 0;
  let authErrorSeen = false;

  for (let i = 0; i < batches.length; i++) {
    if (authErrorSeen) {
      failedBatches += 1;
    } else {
      try {
        const prompt = buildDistributionPrompt(keywords, batches[i], { maxSecondariesPerItem: maxSecondaries });
        const raw = await aiService["askAI"](prompt);
        const parsed = parseDistributionResponse(raw, validKeywords, validItemIds).map((s) => ({
          ...s,
          keyword: sanitizedToRaw.get(s.keyword) ?? s.keyword,
        }));
        if (parsed.length === 0) {
          failedBatches += 1;
          logger.warn("[API-AI] Keyword distribution: batch response unparseable", {
            context: "AI",
            taskId,
            batch: i + 1,
          });
        } else {
          perBatchResults.push(parsed);
        }
      } catch (err: unknown) {
        failedBatches += 1;
        logger.error("[API-AI] Keyword distribution: batch failed", {
          context: "AI",
          taskId,
          batch: i + 1,
          error: errorMessage(err),
        });
        // An invalid provider key fails every remaining batch identically —
        // stop burning calls (same guard as runSeoBulkFix).
        if (isAuthError(err)) authErrorSeen = true;
      }
    }

    // Heartbeat per batch (plan §5.4: progress = processed / totalBatches).
    await db.task
      .update({
        where: { id: taskId },
        data: {
          progress: Math.round(((i + 1) / batches.length) * 100),
          processed: i + 1,
        },
      })
      .catch(() => {});
  }

  const suggestions = mergeBatchResults(perBatchResults, maxSecondaries);

  // Preview labels: only the items actually referenced by a suggestion.
  const titleById = new Map(items.map((it) => [it.id, it.title]));
  const itemTitles: Record<string, string> = {};
  for (const s of suggestions) {
    for (const id of [s.primaryItemId, ...s.secondaryItemIds]) {
      if (id && titleById.has(id)) itemTitles[id] = titleById.get(id) as string;
    }
  }

  const result: DistributionSuggestResult = {
    stage: "suggest",
    groupId: group.id,
    groupName: group.name,
    targetType,
    maxSecondaries,
    suggestions,
    itemTitles,
    keywordCount: keywords.length,
    itemCount: items.length,
    batches: batches.length,
    failedBatches,
  };

  // All batches failing (typically a rejected API key) is a failure, not an
  // empty success — otherwise the merchant sees "no suggestions" and blames
  // their keywords.
  const allFailed = failedBatches === batches.length;
  await db.task.update({
    where: { id: taskId },
    data: {
      status: allFailed ? "failed" : "completed",
      progress: 100,
      completedAt: new Date(),
      result: JSON.stringify(result),
      error: allFailed
        ? `All ${batches.length} batch call(s) failed${authErrorSeen ? " (invalid AI API key)" : ""}`
        : failedBatches > 0
          ? `${failedBatches} of ${batches.length} batch call(s) failed — their items received no votes`
          : null,
    },
  });
}

async function loadTargetItems(
  db: PrismaClient,
  shop: string,
  targetType: KeywordResourceType,
  filters: { productType?: string },
): Promise<DistributionItem[]> {
  switch (targetType) {
    case "Product": {
      const rows = await db.product.findMany({
        where: {
          shop,
          ...(filters.productType ? { productType: filters.productType } : {}),
        },
        select: { id: true, title: true, seoTitle: true, descriptionHtml: true },
        orderBy: { title: "asc" },
      });
      return rows.map((r) => ({
        id: r.id,
        title: r.seoTitle || r.title,
        snippet: buildItemSnippet(r.descriptionHtml),
      }));
    }
    case "Collection": {
      const rows = await db.collection.findMany({
        where: { shop },
        select: { id: true, title: true, seoTitle: true, descriptionHtml: true },
        orderBy: { title: "asc" },
      });
      return rows.map((r) => ({
        id: r.id,
        title: r.seoTitle || r.title,
        snippet: buildItemSnippet(r.descriptionHtml),
      }));
    }
    case "Article": {
      const rows = await db.article.findMany({
        where: { shop },
        select: { id: true, title: true, seoTitle: true, body: true },
        orderBy: { title: "asc" },
      });
      return rows.map((r) => ({
        id: r.id,
        title: r.seoTitle || r.title,
        snippet: buildItemSnippet(r.body),
      }));
    }
    case "Page": {
      const rows = await db.page.findMany({
        where: { shop },
        select: { id: true, title: true, seoTitle: true, body: true },
        orderBy: { title: "asc" },
      });
      return rows.map((r) => ({
        id: r.id,
        title: r.seoTitle || r.title,
        snippet: buildItemSnippet(r.body),
      }));
    }
  }
}

// ─── Stage "apply" ─────────────────────────────────────────────────────────

interface ApplyRow {
  keyword: string;
  locale: string;
  primaryItemId: string | null;
  secondaryItemIds: string[];
  /** "accept" applies primary + secondaries; "secondaryOnly" demotes the
   *  proposed primary to a secondary assignment. */
  decision: "accept" | "secondaryOnly";
}

function isValidApplyRow(row: unknown): row is ApplyRow {
  if (!row || typeof row !== "object") return false;
  const r = row as Record<string, unknown>;
  return (
    typeof r.keyword === "string" &&
    r.keyword.trim().length > 0 &&
    r.keyword.trim().length <= 120 && // MAX_KEYWORD_LENGTH (review L9)
    typeof r.locale === "string" &&
    (r.primaryItemId === null || (typeof r.primaryItemId === "string" && isValidShopifyGID(r.primaryItemId))) &&
    Array.isArray(r.secondaryItemIds) &&
    r.secondaryItemIds.every((id) => typeof id === "string" && isValidShopifyGID(id)) &&
    (r.decision === "accept" || r.decision === "secondaryOnly")
  );
}

async function handleApplyStage(ctx: AIActionContext): Promise<Response> {
  const { session, admin, db, formData } = ctx;

  const targetType = getFormString(formData, "targetType") as KeywordResourceType;
  const suggestTaskId = getFormString(formData, "suggestTaskId");
  // Conflict rule chosen in the preview (plan §5.4 step 5): replace existing
  // primaries (demote them) or keep them (new primary lands as secondary).
  const demoteExisting = getFormString(formData, "demoteExisting") === "true";
  const rawRows = getFormJSON<unknown[]>(formData, "rows");

  if (!RESOURCE_TYPES.includes(targetType) || !Array.isArray(rawRows) || rawRows.length === 0) {
    return json({ success: false, error: "No accepted suggestions to apply." }, { status: 400 });
  }
  if (!rawRows.every(isValidApplyRow)) {
    return json({ success: false, error: "Invalid apply payload." }, { status: 400 });
  }
  const rows = rawRows as ApplyRow[];

  // Locale integrity (review L9): every non-empty locale must be a published
  // secondary shop locale — the same rule the manual add form enforces.
  const requestedLocales = new Set(rows.map((r) => r.locale).filter((l) => l !== ""));
  if (requestedLocales.size > 0) {
    const shopLocales = await getCachedShopLocales(admin, session.shop);
    const published = new Set<string>(
      shopLocales.filter((l: any) => !l.primary && l.published).map((l: any) => String(l.locale)),
    );
    for (const locale of requestedLocales) {
      if (!published.has(locale)) {
        return json({ success: false, error: "Invalid apply payload." }, { status: 400 });
      }
    }
  }

  const task = await db.task.create({
    data: {
      shop: session.shop,
      type: "distributeKeywords",
      status: "running",
      resourceType: "seo",
      fieldType: "apply",
      total: rows.length,
      processed: 0,
      progress: 0,
      expiresAt: getTaskExpirationDate(),
    },
  });

  void runApplyStage(task.id, {
    db,
    shop: session.shop,
    targetType,
    rows,
    demoteExisting,
    suggestTaskId,
  }).catch(async (err: unknown) => {
    logger.error("[API-AI] Keyword distribution (apply) crashed", {
      context: "AI",
      taskId: task.id,
      error: errorMessage(err),
    });
    await db.task
      .update({
        where: { id: task.id },
        data: { status: "failed", completedAt: new Date(), error: errorMessage(err).substring(0, 1000) },
      })
      .catch(() => {});
  });

  return json({ success: true, taskId: task.id, total: rows.length });
}

interface ApplyRunArgs {
  db: PrismaClient;
  shop: string;
  targetType: KeywordResourceType;
  rows: ApplyRow[];
  demoteExisting: boolean;
  suggestTaskId: string;
}

async function runApplyStage(taskId: string, args: ApplyRunArgs): Promise<void> {
  const { db, shop, targetType, rows, demoteExisting, suggestTaskId } = args;

  let applied = 0;
  let demotedToSecondary = 0;
  let skipped = 0;
  let errors = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try {
      if (row.primaryItemId) {
        const role = row.decision === "secondaryOnly" ? "secondary" : "primary";
        const first = await assignKeyword(db, shop, {
          resourceType: targetType,
          resourceId: row.primaryItemId,
          keyword: row.keyword,
          locale: row.locale,
          role,
          demoteExisting: role === "primary" ? demoteExisting : false,
        });
        if (first.ok) {
          applied += 1;
        } else if (first.reason === "primaryExists") {
          // Keep-existing conflict rule: land as secondary instead.
          const second = await assignKeyword(db, shop, {
            resourceType: targetType,
            resourceId: row.primaryItemId,
            keyword: row.keyword,
            locale: row.locale,
            role: "secondary",
            keepExistingPrimary: true,
          });
          if (second.ok) demotedToSecondary += 1;
          else skipped += 1;
        } else {
          skipped += 1; // tooMany — item is at its keyword cap
        }
      }

      for (const secondaryId of row.secondaryItemIds) {
        const res = await assignKeyword(db, shop, {
          resourceType: targetType,
          resourceId: secondaryId,
          keyword: row.keyword,
          locale: row.locale,
          role: "secondary",
          // Review M3: an automated secondary write must never silently
          // demote a deliberately-set primary on that item.
          keepExistingPrimary: true,
        });
        if (res.ok) applied += 1;
        else skipped += 1;
      }
    } catch (err: unknown) {
      errors += 1;
      logger.error("[API-AI] Keyword distribution apply: row failed", {
        context: "AI",
        taskId,
        keyword: row.keyword,
        error: errorMessage(err),
      });
    }

    // Heartbeat every 10 rows (plan §5.4 step 5) + on the final row.
    if ((i + 1) % 10 === 0 || i === rows.length - 1) {
      await db.task
        .update({
          where: { id: taskId },
          data: {
            progress: Math.round(((i + 1) / rows.length) * 100),
            processed: i + 1,
          },
        })
        .catch(() => {});
    }
  }

  const result: DistributionApplyResult = { stage: "apply", applied, demotedToSecondary, skipped, errors };
  await db.task.update({
    where: { id: taskId },
    data: {
      status: errors === rows.length ? "failed" : "completed",
      progress: 100,
      completedAt: new Date(),
      result: JSON.stringify(result),
      error: errors > 0 ? `${errors} of ${rows.length} row(s) failed` : null,
    },
  });

  // Mark the source preview consumed so the UI stops offering it (shop-scoped
  // lookup — never trust a client-posted id across tenants).
  if (suggestTaskId) {
    const suggestTask = await db.task.findFirst({
      where: { id: suggestTaskId, shop, type: "distributeKeywords" },
      select: { id: true, result: true },
    });
    if (suggestTask?.result) {
      try {
        const parsed = JSON.parse(suggestTask.result) as DistributionSuggestResult;
        parsed.appliedAt = new Date().toISOString();
        await db.task.update({
          where: { id: suggestTask.id },
          data: { result: JSON.stringify(parsed) },
        });
      } catch {
        // Malformed result blob — nothing to stamp.
      }
    }
  }
}
