/**
 * SEO Audit Dashboard — "Fix with AI" bulk action.
 *
 * Reuses the app's existing bulk-AI pipeline end to end (no new job runner, no
 * new AI logic): a parent Task is created up front (mirrors
 * alt-text.handler.ts's handleGenerateAllAltTexts), a DETACHED runner then
 * walks the affected items one at a time, generating each field the same way
 * text-generation.handler.ts's handleGenerateAIText builds its prompt
 * (character limits, writing-style/format/instructions injection,
 * sanitizePromptInput), persisting through the SAME Shopify mutation paths the
 * single-item editor uses (ShopifyContentService for Collection/Page/Article, a
 * minimal partial productUpdate for Product), and updating the DB content
 * cache so the audit immediately reflects the fix on the next reload.
 */

import { json } from "@remix-run/node";
import type { AIActionContext } from "./shared";
import { errorMessage, createAIService, isAuthError, CONTENT_CONFIGS } from "./shared";
import { getFormString } from "~/utils/form-data.utils";
import { getTaskExpirationDate } from "~/config/constants";
import { logger } from "~/utils/logger.server";
import { sanitizePromptInput } from "~/utils/prompt-sanitizer";
import { getInstructionWithDefault, getWritingStyleInstructions } from "~/utils/ai-instructions.utils";
import { getCharacterLimitRequirement } from "~/utils/character-limits";
import { analyzeStore, type AuditType, type AuditProblemBucket } from "~/services/seo/audit.service";
import { seoTitleEffectiveLimit } from "~/utils/seo-score";
import type { Plan } from "~/config/plans";
import { ShopifyApiGateway } from "~/services/shopify-api-gateway.service";
import { ShopifyContentService } from "../../../src/services/shopify-content.service";
import type { AISettings, PrismaClient } from "@prisma/client";
import type { AdminApiContext } from "@shopify/shopify-app-remix/server";

// Cap how many items ONE run touches. The audit's own MAX_PROBLEM_BUCKET_ITEMS
// (100) already bounds this at the source, but re-asserting it here keeps this
// handler safe even if that cap ever changes independently.
const MAX_BULK_FIX_ITEMS = 100;

// Allowlist of AI-fixable problem buckets (see audit.service.ts FINDING_TO_BUCKET
// for the full code list). Length/duplicate/alt-text buckets are intentionally
// NOT included here yet:
//  - imagesMissingAlt already has a dedicated, more mature bulk feature
//    (handleGenerateAllAltTexts) — point the merchant at it instead of
//    reimplementing image handling here.
//  - titleLength / descriptionTooShort / duplicateSeoTitle / duplicateSeoDescription
//    need either a different field (title/description) or cross-item
//    dedup logic that's out of scope for this first cut.
const FIXABLE_CODE_TO_FIELD: Record<string, "seoTitle" | "metaDescription"> = {
  seoTitleMissing: "seoTitle",
  seoTitleTooLong: "seoTitle",
  metaDescriptionMissing: "metaDescription",
  metaDescriptionLength: "metaDescription",
};

/** AuditType -> the api-ai-handlers/content-fields.config.tsx contentType key. */
const AUDIT_TYPE_TO_CONTENT_TYPE: Record<AuditType, string> = {
  product: "products",
  collection: "collections",
  article: "blogs",
  page: "pages",
};

export async function handleSeoBulkFix(ctx: AIActionContext): Promise<Response> {
  const { session, admin, db, settings, formData, seoTitleMaxChars } = ctx;
  const problemCode = getFormString(formData, "problemCode");

  const field = FIXABLE_CODE_TO_FIELD[problemCode];
  if (!field) {
    if (problemCode === "imagesMissingAlt") {
      // Redirect to the existing, more capable bulk feature instead of
      // duplicating image-alt-text handling here.
      return json(
        {
          success: false,
          code: "USE_ALT_TEXT_BULK",
          error: "Use \"Generate all alt texts\" in the product editor to fix missing image alt text in bulk.",
        },
        { status: 400 },
      );
    }
    return json(
      { success: false, error: `SEO bulk-fix isn't available for "${problemCode}" yet.` },
      { status: 400 },
    );
  }

  // Single-flight: only one seoBulkFix run per shop at a time — a second click
  // (or a second bucket) while one is in flight would double-spend AI calls
  // on the same items and race the DB/Shopify writes below.
  const runningTask = await db.task.findFirst({
    where: { shop: session.shop, type: "seoBulkFix", status: "running" },
    select: { id: true },
  });
  if (runningTask) {
    return json(
      {
        success: false,
        code: "ALREADY_RUNNING",
        error: "An SEO bulk-fix is already running for this store. Check the Tasks tab for progress.",
        taskId: runningTask.id,
      },
      { status: 409 },
    );
  }

  // Re-run the audit server-side — never trust client-supplied ids, which may
  // be stale (edited/deleted) by the time this POST arrives.
  const aiSettingsRow = await db.aISettings.findUnique({
    where: { shop: session.shop },
    select: { subscriptionPlan: true, seoTitleSuffixEnabled: true, seoTitleSuffix: true },
  });
  const plan = (aiSettingsRow?.subscriptionPlan || "free") as Plan;
  const suffix =
    aiSettingsRow?.seoTitleSuffixEnabled && aiSettingsRow.seoTitleSuffix ? aiSettingsRow.seoTitleSuffix : "";
  const audit = await analyzeStore(session.shop, {
    db,
    seoTitleEffectiveLimit: seoTitleEffectiveLimit(suffix),
    plan,
  });

  const bucket: AuditProblemBucket | undefined = audit.problems.find((p) => p.code === problemCode);
  const items = (bucket?.items ?? []).slice(0, MAX_BULK_FIX_ITEMS);

  if (items.length === 0) {
    return json(
      { success: false, error: "No affected items found — the audit may already be clean. Reload the dashboard." },
      { status: 400 },
    );
  }

  const task = await db.task.create({
    data: {
      shop: session.shop,
      type: "seoBulkFix",
      status: "running",
      resourceType: "seo",
      resourceTitle: problemCode,
      fieldType: field,
      total: items.length,
      processed: 0,
      progress: 0,
      expiresAt: getTaskExpirationDate(),
    },
  });

  // Fire-and-forget: survives navigation, same pattern as
  // runBulkAltTextGeneration in alt-text.handler.ts. Progress/results are
  // persisted to Task after every item (heartbeat), so a crash only loses the
  // in-flight item and TaskRecoveryService reaps a truly stalled run.
  void runSeoBulkFix(task.id, {
    db,
    settings,
    shop: session.shop,
    admin,
    field,
    items,
    seoTitleMaxChars,
  }).catch((err: unknown) => {
    logger.error("[API-AI] SEO bulk-fix crashed", {
      context: "AI",
      taskId: task.id,
      error: errorMessage(err),
    });
  });

  return json({ success: true, taskId: task.id, total: items.length });
}

// ─── Runner ────────────────────────────────────────────────────────────────

interface RunArgs {
  db: PrismaClient;
  settings: AISettings | null;
  shop: string;
  admin: AdminApiContext;
  field: "seoTitle" | "metaDescription";
  items: { type: AuditType; id: string }[];
  seoTitleMaxChars: number;
}

/** Uniform row shape regardless of which content-cache table it came from. */
interface FixableRow {
  id: string;
  title: string;
  description: string;
  seoTitle: string;
  metaDescription: string;
}

async function runSeoBulkFix(taskId: string, args: RunArgs): Promise<void> {
  const { db, settings, shop, admin, field, items, seoTitleMaxChars } = args;

  const gateway = new ShopifyApiGateway(admin, shop);
  const contentService = new ShopifyContentService(gateway as any);
  const aiService = createAIService(settings, shop, taskId);

  // One shared AI-instructions row + primary-locale name for the whole run —
  // these are per-shop, not per-item, so fetching them once avoids N redundant
  // DB/Shopify round-trips.
  const aiInstructions = (await db.aIInstructions.findUnique({ where: { shop } })) as Record<
    string,
    string | null
  > | null;
  let mainLanguage = "English";
  try {
    const { shopLocales } = await contentService.loadShopLocales();
    const primary = shopLocales.find((l: { primary: boolean; name?: string }) => l.primary);
    if (primary?.name) mainLanguage = primary.name;
  } catch (err: unknown) {
    // Non-fatal — fall back to the default and keep going.
    logger.warn("[API-AI] SEO bulk-fix: failed to load shop locales, defaulting language", {
      context: "AI",
      taskId,
      error: errorMessage(err),
    });
  }

  // Batch-load the current field values per content type (no N+1 — one
  // findMany per type, mirroring audit.service.ts's own query shape).
  const byType = new Map<AuditType, string[]>();
  for (const item of items) {
    const ids = byType.get(item.type) ?? [];
    ids.push(item.id);
    byType.set(item.type, ids);
  }
  const rows = new Map<string, FixableRow>();
  for (const [type, ids] of byType.entries()) {
    const loaded = await loadRows(db, shop, type, ids);
    for (const [id, row] of loaded.entries()) rows.set(id, row);
  }

  const succeeded: { type: AuditType; id: string }[] = [];
  const failed: { type: AuditType; id: string; error: string }[] = [];
  const total = items.length;
  let authErrorSeen = false;

  for (let i = 0; i < items.length; i++) {
    const { type, id } = items[i];

    if (!authErrorSeen) {
      const row = rows.get(id);
      if (!row) {
        failed.push({ type, id, error: "Item no longer exists in the content cache" });
      } else {
        try {
          const contentType = AUDIT_TYPE_TO_CONTENT_TYPE[type];
          const fieldDef = CONTENT_CONFIGS[contentType]?.fieldDefinitions.find((f) => f.key === field);
          const aiInstructionsKey = fieldDef?.aiInstructionsKey || field;
          const fieldLabel = fieldDef?.label || field;

          const prompt = buildFixPrompt(field, {
            fieldLabel,
            aiInstructionsKey,
            title: row.title,
            description: row.description,
            seoTitleMaxChars,
            mainLanguage,
            aiInstructions,
          });

          // Neither seoTitle nor metaDescription is an "html" field, so this
          // mirrors handleGenerateAIText's non-html branch (generateProductTitle
          // is the shared short-text generation path for both).
          const generated = (await aiService.generateProductTitle(prompt)).trim();

          await persistField({ db, shop, type, id, field, value: generated, contentService, gateway });

          succeeded.push({ type, id });
        } catch (err: unknown) {
          const message = errorMessage(err);
          failed.push({ type, id, error: message });
          logger.error("[API-AI] SEO bulk-fix: item failed", {
            context: "AI",
            taskId,
            type,
            id,
            error: message,
          });
          // An invalid/expired provider key fails every remaining item
          // identically — stop burning AI-queue attempts and mark the rest
          // failed immediately instead of retrying item-by-item.
          if (isAuthError(err)) authErrorSeen = true;
        }
      }
    } else {
      failed.push({ type, id, error: "Skipped after provider API key was rejected" });
    }

    // Persist after every item so a crash only loses the current one — same
    // heartbeat contract as runBulkAltTextGeneration.
    const progressPercent = Math.round(((i + 1) / total) * 100);
    await db.task
      .update({
        where: { id: taskId },
        data: {
          progress: progressPercent,
          processed: i + 1,
          result: JSON.stringify({ succeeded, failed }),
        },
      })
      .catch((err: unknown) => {
        logger.error("[API-AI] SEO bulk-fix: failed to persist progress", {
          context: "AI",
          taskId,
          error: errorMessage(err),
        });
      });
  }

  const finalStatus = succeeded.length === 0 ? "failed" : "completed";
  const failureSummary =
    failed.length > 0 ? `${failed.length} of ${total} item(s) failed${authErrorSeen ? " (invalid AI API key)" : ""}` : null;

  await db.task.update({
    where: { id: taskId },
    data: {
      status: finalStatus,
      progress: 100,
      completedAt: new Date(),
      result: JSON.stringify({ succeeded, failed }),
      error: failureSummary ? failureSummary.substring(0, 1000) : null,
    },
  });
}

async function loadRows(
  db: PrismaClient,
  shop: string,
  type: AuditType,
  ids: string[],
): Promise<Map<string, FixableRow>> {
  const map = new Map<string, FixableRow>();
  if (ids.length === 0) return map;

  switch (type) {
    case "product": {
      const products = await db.product.findMany({
        where: { shop, id: { in: ids } },
        select: { id: true, title: true, descriptionHtml: true, seoTitle: true, seoDescription: true },
      });
      for (const p of products) {
        map.set(p.id, {
          id: p.id,
          title: p.title,
          description: p.descriptionHtml ?? "",
          seoTitle: p.seoTitle ?? "",
          metaDescription: p.seoDescription ?? "",
        });
      }
      break;
    }
    case "collection": {
      const collections = await db.collection.findMany({
        where: { shop, id: { in: ids } },
        select: { id: true, title: true, descriptionHtml: true, seoTitle: true, seoDescription: true },
      });
      for (const c of collections) {
        map.set(c.id, {
          id: c.id,
          title: c.title,
          description: c.descriptionHtml ?? "",
          seoTitle: c.seoTitle ?? "",
          metaDescription: c.seoDescription ?? "",
        });
      }
      break;
    }
    case "article": {
      const articles = await db.article.findMany({
        where: { shop, id: { in: ids } },
        select: { id: true, title: true, body: true, seoTitle: true, seoDescription: true },
      });
      for (const a of articles) {
        map.set(a.id, {
          id: a.id,
          title: a.title,
          description: a.body ?? "",
          seoTitle: a.seoTitle ?? "",
          metaDescription: a.seoDescription ?? "",
        });
      }
      break;
    }
    case "page": {
      const pages = await db.page.findMany({
        where: { shop, id: { in: ids } },
        select: { id: true, title: true, body: true, seoTitle: true, seoDescription: true },
      });
      for (const pg of pages) {
        map.set(pg.id, {
          id: pg.id,
          title: pg.title,
          description: pg.body ?? "",
          seoTitle: pg.seoTitle ?? "",
          metaDescription: pg.seoDescription ?? "",
        });
      }
      break;
    }
  }
  return map;
}

interface PromptContext {
  fieldLabel: string;
  aiInstructionsKey: string;
  title: string;
  description: string;
  seoTitleMaxChars: number;
  mainLanguage: string;
  aiInstructions: Record<string, string | null> | null;
}

/** Mirrors handleGenerateAIText's prompt shape (text-generation.handler.ts) so
 * bulk-generated SEO titles/meta descriptions read the same as ones a
 * merchant generated one-by-one in the editor. */
function buildFixPrompt(field: "seoTitle" | "metaDescription", ctx: PromptContext): string {
  const sanitizedTitle = sanitizePromptInput(ctx.title, { fieldType: "title" });
  const sanitizedDescription = sanitizePromptInput(ctx.description, {
    fieldType: "description",
    allowNewlines: true,
  });

  let prompt = `Create an improved ${ctx.fieldLabel} for the following content.`;
  prompt += `\n\nContext - Title: ${sanitizedTitle}`;
  if (field === "metaDescription" && sanitizedDescription) {
    prompt += `\nContext - Description: ${sanitizedDescription}`;
  }
  prompt += `\nLanguage: ${ctx.mainLanguage}`;

  prompt += `\n\nRequirements:`;
  const charLimit = getCharacterLimitRequirement(ctx.aiInstructionsKey, ctx.seoTitleMaxChars);
  if (charLimit) prompt += `\n- Length: ${charLimit}`;
  prompt += `\n- Clear and concise`;
  prompt += `\n- SEO-friendly where applicable`;
  prompt += `\n- Customer-focused language`;

  const writingStyle = getWritingStyleInstructions(ctx.aiInstructions);
  if (writingStyle) prompt += `\n\nWriting Style:\n${writingStyle}`;

  const formatExample = getInstructionWithDefault(ctx.aiInstructions, `${ctx.aiInstructionsKey}Format`);
  if (formatExample) prompt += `\n\nFormat Example (adapt to actual content):\n${formatExample}`;

  const fieldInstructions = getInstructionWithDefault(ctx.aiInstructions, `${ctx.aiInstructionsKey}Instructions`);
  if (fieldInstructions) prompt += `\n\nGuidelines:\n${fieldInstructions}`;

  // Hard length override — placed last so it wins over any conflicting
  // instruction above, same as handleGenerateAIText.
  if (charLimit) {
    prompt += `\n\nCRITICAL LENGTH CONSTRAINT: The output MUST be ${charLimit}. This overrides any other length or character count instruction in this prompt.`;
  }

  prompt += `\n\nIMPORTANT: Return ONLY the ${ctx.fieldLabel}, nothing else. Output in ${ctx.mainLanguage}.`;
  return prompt;
}

interface PersistArgs {
  db: PrismaClient;
  shop: string;
  type: AuditType;
  id: string;
  field: "seoTitle" | "metaDescription";
  value: string;
  contentService: ShopifyContentService;
  gateway: ShopifyApiGateway;
}

/**
 * Save the generated value to Shopify (where supported) and the DB content
 * cache, mirroring how the single-item editor persists the same field.
 */
async function persistField(params: PersistArgs): Promise<void> {
  const { db, shop, type, id, field, value, contentService, gateway } = params;

  switch (type) {
    case "product": {
      // Minimal partial productUpdate — only the seo.{title|description} sub-field
      // that changed is sent, so the other one (and title/handle/description) is
      // left untouched by Shopify (omitted GraphQL input fields = "no change").
      const seoInput: Record<string, string> = {};
      seoInput[field === "seoTitle" ? "title" : "description"] = value;
      const response = await gateway.graphql(
        `#graphql
          mutation seoBulkFixProductUpdate($input: ProductInput!) {
            productUpdate(input: $input) {
              userErrors { field message }
            }
          }`,
        { variables: { input: { id, seo: seoInput } } },
      );
      const data = (await response.json()) as {
        data?: { productUpdate?: { userErrors?: { field?: string; message: string }[] } };
      };
      const userErrors = data.data?.productUpdate?.userErrors ?? [];
      if (userErrors.length > 0) throw new Error(userErrors[0].message);

      await db.product.update({
        where: { shop_id: { shop, id } },
        data:
          field === "seoTitle"
            ? { seoTitle: value, lastSyncedAt: new Date() }
            : { seoDescription: value, lastSyncedAt: new Date() },
      });
      break;
    }
    case "collection": {
      const seo = field === "seoTitle" ? { title: value } : { description: value };
      await contentService.updateCollection(id, { seo });
      await db.collection.update({
        where: { shop_id: { shop, id } },
        data:
          field === "seoTitle"
            ? { seoTitle: value, lastSyncedAt: new Date() }
            : { seoDescription: value, lastSyncedAt: new Date() },
      });
      break;
    }
    case "page": {
      const pageInput = field === "seoTitle" ? { seoTitle: value } : { seoDescription: value };
      await contentService.updatePage(id, pageInput);
      await db.page.update({
        where: { shop_id: { shop, id } },
        data: { ...pageInput, lastSyncedAt: new Date() },
      });
      break;
    }
    case "article": {
      // Article SEO title/description are stored the same way as Page/Blog —
      // as global.title_tag/description_tag metafields, written inline by
      // updateArticle() (see ShopifyContentService.updateArticle).
      const articleInput = field === "seoTitle" ? { seoTitle: value } : { seoDescription: value };
      await contentService.updateArticle(id, articleInput);
      await db.article.update({
        where: { shop_id: { shop, id } },
        data:
          field === "seoTitle"
            ? { seoTitle: value, lastSyncedAt: new Date() }
            : { seoDescription: value, lastSyncedAt: new Date() },
      });
      break;
    }
  }
}
