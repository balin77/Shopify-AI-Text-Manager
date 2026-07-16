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
// for the full code list).
type FixableField = "seoTitle" | "metaDescription" | "title" | "description" | "altText";

const FIXABLE_CODE_TO_FIELD: Record<string, FixableField> = {
  seoTitleMissing: "seoTitle",
  seoTitleTooLong: "seoTitle",
  metaDescriptionMissing: "metaDescription",
  metaDescriptionLength: "metaDescription",
  // Duplicate SEO buckets regenerate the SAME field (title / description) but
  // trigger sibling-context injection in the prompt (see buildFixPrompt) so
  // the AI doesn't just produce another duplicate. The bucket's `items` list
  // IS the sibling group — the runner iterates it and each item gets the
  // OTHER items' current values as an "avoid these" hint.
  duplicateSeoTitle: "seoTitle",
  duplicateSeoDescription: "metaDescription",
  // Storefront-visible content title (product/collection/page/article name).
  // Merchant-triggered from the SEO dashboard only — never a passive
  // regeneration, since it changes public-facing copy.
  titleLength: "title",
  // Storefront-visible content BODY (descriptionHtml / body). Uses the
  // dedicated description-generation AI path (generateProductDescription)
  // and receives the current description as context so tone/keywords carry
  // over — not a blank-slate rewrite.
  descriptionTooShort: "description",
  // Handled by a separate runner (runAltTextBulkFix) because alt text is
  // per-image, not per-item, and needs productUpdateMedia instead of the
  // regular content mutations.
  imagesMissingAlt: "altText",
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
    return json(
      { success: false, error: `SEO bulk-fix isn't available for "${problemCode}" yet.` },
      { status: 400 },
    );
  }

  // Optional single-item mode: the dashboard's per-row KI button POSTs
  // itemId + itemType so only ONE item runs, instead of the whole bucket.
  // Still validated against the server-side audit below (never trust the
  // client — a stale/foreign GID must not slip through).
  const singleItemId = getFormString(formData, "itemId");
  const singleItemType = getFormString(formData, "itemType") as AuditType | "";

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
  const bucketItems = bucket?.items ?? [];

  // Single-item mode filters the bucket down; verifying against the
  // server-derived bucket is what makes a POSTed GID safe to trust.
  const items = singleItemId
    ? bucketItems.filter((it) => it.id === singleItemId && it.type === singleItemType).slice(0, 1)
    : bucketItems.slice(0, MAX_BULK_FIX_ITEMS);

  if (items.length === 0) {
    return json(
      {
        success: false,
        error: singleItemId
          ? "This item is no longer affected by this problem — reload the dashboard."
          : "No affected items found — the audit may already be clean. Reload the dashboard.",
      },
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
  //
  // altText fans out per image inside the runner and reports its own
  // progress differently — see runAltTextBulkFix.
  const runner =
    field === "altText"
      ? runAltTextBulkFix(task.id, { db, settings, shop: session.shop, admin, items })
      : runSeoBulkFix(task.id, {
          db,
          settings,
          shop: session.shop,
          admin,
          field,
          problemCode,
          items,
          seoTitleMaxChars,
        });
  void runner.catch(async (err: unknown) => {
    logger.error("[API-AI] SEO bulk-fix crashed", {
      context: "AI",
      taskId: task.id,
      error: errorMessage(err),
    });
    // A crash BEFORE the per-item loop (e.g. loadRows failing) would otherwise
    // leave the task on "running" and the single-flight guard blocking new
    // runs until task-recovery reaps it (review N3). Best-effort mark failed.
    await db.task
      .update({
        where: { id: task.id },
        data: { status: "failed", completedAt: new Date(), error: errorMessage(err).substring(0, 1000) },
      })
      .catch(() => {});
  });

  return json({ success: true, taskId: task.id, total: items.length });
}

// ─── Runner ────────────────────────────────────────────────────────────────

/** Fields runSeoBulkFix knows how to prompt + persist. altText has its own
 * runner (runAltTextBulkFix) because it's per-image, not per-item. */
type TextField = Exclude<FixableField, "altText">;

interface RunArgs {
  db: PrismaClient;
  settings: AISettings | null;
  shop: string;
  admin: AdminApiContext;
  field: TextField;
  /** Original bucket code — used to detect the duplicate-SEO buckets, where
   * every item must receive its siblings' current values as an "avoid these
   * values" hint so the regen doesn't just produce another duplicate. */
  problemCode: string;
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
  const { db, settings, shop, admin, field, problemCode, items, seoTitleMaxChars } = args;
  const isDuplicateBucket =
    problemCode === "duplicateSeoTitle" || problemCode === "duplicateSeoDescription";

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

  // Duplicate-bucket siblings: for each item, the OTHER items sharing the same
  // (normalized) current value. That value is passed to the prompt as an
  // "avoid these" hint so the AI produces something distinct instead of
  // regenerating another duplicate. Cheap map lookup, computed once.
  //
  // A duplicate SEO title / description also DOES apply to items with a fully
  // empty value (two items both missing a meta description technically share
  // "" — but that would already be flagged as `metaDescriptionMissing` and is
  // out of scope here). Empty-normalized keys are skipped.
  const siblingHintById = new Map<string, string[]>();
  if (isDuplicateBucket) {
    // Normalization contract MUST match audit.service.ts's
    // normalizeForDuplicateCheck (trim + lowercase, seoTitle falls back to
    // title, no fallback for metaDescription). If the audit's algorithm ever
    // changes (e.g. smart-quote normalization), mirror the change here or
    // the "avoid" list will silently miss real duplicates.
    const readField = (row: FixableRow): string =>
      problemCode === "duplicateSeoTitle"
        ? (row.seoTitle || row.title || "").trim()
        : (row.metaDescription || "").trim();
    const groups = new Map<string, string[]>();
    for (const it of items) {
      const row = rows.get(it.id);
      if (!row) continue;
      const key = readField(row).toLowerCase();
      if (!key) continue;
      const group = groups.get(key) ?? [];
      group.push(it.id);
      groups.set(key, group);
    }
    for (const [, group] of groups.entries()) {
      if (group.length < 2) continue;
      for (const id of group) {
        const siblings = group
          .filter((sid) => sid !== id)
          .map((sid) => {
            const r = rows.get(sid);
            return r ? readField(r) : "";
          })
          .filter((v) => v.length > 0);
        if (siblings.length > 0) siblingHintById.set(id, siblings);
      }
    }
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
            avoidValues: siblingHintById.get(id),
          });

          // description is long-form HTML; every other TextField is short
          // plain text. generateProductDescription is the shared long-form
          // path, generateProductTitle the shared short-text one — matches
          // how text-generation.handler.ts routes single-item generation.
          const generated = (
            field === "description"
              ? await aiService.generateProductDescription(row.title, prompt)
              : await aiService.generateProductTitle(prompt)
          ).trim();

          // Guard against a silent clobber: a provider glitch that returns
          // an empty string would otherwise overwrite the storefront body
          // (or title / seo field) with "" and the "fix" would strictly
          // regress the item's SEO score. Skip and mark failed instead;
          // the merchant can retry from the dashboard.
          if (generated.length === 0) {
            throw new Error("AI returned an empty value — nothing was saved.");
          }

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

// ─── Alt-text runner ──────────────────────────────────────────────────────
//
// imagesMissingAlt is per-image, not per-item: one product can contribute
// several missing-alt images. We still use `items` (the affected content rows)
// as the outer loop, then fan out to each item's images that lack alt text
// inside. Uses the same AI-alt-text pipeline as the product-editor bulk
// action (aiService.generateImageAltText), but persistence is the caller's
// own responsibility (productUpdateMedia for gallery images, updateCollection
// / updateArticle for their single featured image).

interface AltTextRunArgs {
  db: PrismaClient;
  settings: AISettings | null;
  shop: string;
  admin: AdminApiContext;
  items: { type: AuditType; id: string }[];
}

async function runAltTextBulkFix(taskId: string, args: AltTextRunArgs): Promise<void> {
  const { db, settings, shop, admin, items } = args;

  const gateway = new ShopifyApiGateway(admin, shop);
  const contentService = new ShopifyContentService(gateway as any);
  const aiService = createAIService(settings, shop, taskId);

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
    logger.warn("[API-AI] SEO alt-text bulk-fix: failed to load shop locales, defaulting", {
      context: "AI",
      taskId,
      error: errorMessage(err),
    });
  }

  const succeeded: { type: AuditType; id: string }[] = [];
  const failed: { type: AuditType; id: string; error: string }[] = [];
  let authErrorSeen = false;

  // First pass: enumerate every missing-alt image across every affected
  // content row so total/progress reflect IMAGES, not items — the same
  // reason handleGenerateAllAltTexts uses a per-image heartbeat.
  interface AltJob {
    type: AuditType;
    id: string;
    productTitle: string;
    imageUrl: string;
    mediaId?: string | null;
    productImageId?: string; // for db.productImage.update
    isFeatured?: boolean; // product featured-image fallback
  }
  const jobs: AltJob[] = [];

  for (const it of items) {
    if (it.type === "product") {
      const product = await db.product.findUnique({
        where: { shop_id: { shop, id: it.id } },
        select: {
          id: true,
          title: true,
          featuredImageUrl: true,
          featuredImageAlt: true,
          images: {
            select: { id: true, url: true, altText: true, mediaId: true, position: true },
            orderBy: { position: "asc" },
          },
        },
      });
      if (!product) continue;
      const missing = product.images.filter((img) => !img.altText || img.altText.trim() === "");
      if (missing.length > 0) {
        for (const img of missing) {
          jobs.push({
            type: "product",
            id: it.id,
            productTitle: product.title,
            imageUrl: img.url,
            mediaId: img.mediaId,
            productImageId: img.id,
          });
        }
      } else if (
        product.images.length === 0 &&
        product.featuredImageUrl &&
        (!product.featuredImageAlt || product.featuredImageAlt.trim() === "")
      ) {
        // Featured-image fallback (audit uses the same rule). No mediaId
        // available for a bare featuredImageUrl — persistImageAltText will
        // resolve it via the Product.media query at write time.
        jobs.push({
          type: "product",
          id: it.id,
          productTitle: product.title,
          imageUrl: product.featuredImageUrl,
          isFeatured: true,
        });
      }
    } else if (it.type === "collection") {
      const c = await db.collection.findUnique({
        where: { shop_id: { shop, id: it.id } },
        select: { id: true, title: true, imageUrl: true, imageAltText: true },
      });
      if (c?.imageUrl && (!c.imageAltText || c.imageAltText.trim() === "")) {
        jobs.push({ type: "collection", id: it.id, productTitle: c.title, imageUrl: c.imageUrl });
      }
    } else if (it.type === "article") {
      const a = await db.article.findUnique({
        where: { shop_id: { shop, id: it.id } },
        select: { id: true, title: true, imageUrl: true, imageAltText: true },
      });
      if (a?.imageUrl && (!a.imageAltText || a.imageAltText.trim() === "")) {
        jobs.push({ type: "article", id: it.id, productTitle: a.title, imageUrl: a.imageUrl });
      }
    }
    // page has no images (audit passes totalImages: 0)
  }

  const total = jobs.length;
  if (total === 0) {
    await db.task.update({
      where: { id: taskId },
      data: {
        status: "completed",
        progress: 100,
        completedAt: new Date(),
        result: JSON.stringify({ succeeded, failed }),
      },
    });
    return;
  }

  // Update the task's total now that we know the true image count
  // (differs from `items.length` used at task create time).
  await db.task
    .update({ where: { id: taskId }, data: { total } })
    .catch(() => {});

  // Dedupe succeeded items so the per-image loop below doesn't push the same
  // content row multiple times when it has several images.
  const succeededSeen = new Set<string>();

  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];

    if (!authErrorSeen) {
      try {
        const sanitizedTitle = sanitizePromptInput(job.productTitle || "", { fieldType: "title" });
        let prompt = `Create an optimized alt text for a product image.\nProduct: ${sanitizedTitle}\nImage URL: ${job.imageUrl}`;
        if (aiInstructions?.productAltTextFormat) {
          prompt += `\n\nFormat Example:\n${aiInstructions.productAltTextFormat}`;
        }
        if (aiInstructions?.productAltTextInstructions) {
          prompt += `\n\nInstructions:\n${aiInstructions.productAltTextInstructions}`;
        }
        prompt += `\n\nReturn ONLY the alt text, without explanations. Output the result in ${mainLanguage}.`;

        const altText = (
          await aiService.generateImageAltText(job.imageUrl, sanitizedTitle, prompt)
        ).trim();

        await persistImageAltText({
          db,
          shop,
          job,
          altText,
          contentService,
          gateway,
        });

        const key = `${job.type}:${job.id}`;
        if (!succeededSeen.has(key)) {
          succeeded.push({ type: job.type, id: job.id });
          succeededSeen.add(key);
        }
      } catch (err: unknown) {
        const message = errorMessage(err);
        failed.push({ type: job.type, id: job.id, error: message });
        logger.error("[API-AI] SEO alt-text bulk-fix: image failed", {
          context: "AI",
          taskId,
          type: job.type,
          id: job.id,
          error: message,
        });
        if (isAuthError(err)) authErrorSeen = true;
      }
    } else {
      failed.push({
        type: job.type,
        id: job.id,
        error: "Skipped after provider API key was rejected",
      });
    }

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
        logger.error("[API-AI] SEO alt-text bulk-fix: progress persist failed", {
          context: "AI",
          taskId,
          error: errorMessage(err),
        });
      });
  }

  const finalStatus = succeeded.length === 0 ? "failed" : "completed";
  const failureSummary =
    failed.length > 0
      ? `${failed.length} of ${total} image(s) failed${authErrorSeen ? " (invalid AI API key)" : ""}`
      : null;

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

interface PersistImageAltTextArgs {
  db: PrismaClient;
  shop: string;
  job: {
    type: AuditType;
    id: string;
    imageUrl: string;
    mediaId?: string | null;
    productImageId?: string;
    isFeatured?: boolean;
  };
  altText: string;
  contentService: ShopifyContentService;
  gateway: ShopifyApiGateway;
}

async function persistImageAltText(params: PersistImageAltTextArgs): Promise<void> {
  const { db, shop, job, altText, contentService, gateway } = params;

  if (job.type === "product") {
    // Resolve mediaId if we don't have one cached (bare featuredImageUrl case).
    let mediaId = job.mediaId;
    if (!mediaId) {
      const productResponse = await gateway.graphql(
        `#graphql
          query seoAltFixProductMedia($id: ID!) {
            product(id: $id) {
              media(first: 1) { edges { node { ... on MediaImage { id } } } }
            }
          }`,
        { variables: { id: job.id } },
      );
      const productData = (await productResponse.json()) as {
        data?: { product?: { media?: { edges?: { node?: { id?: string } }[] } } };
      };
      mediaId = productData.data?.product?.media?.edges?.[0]?.node?.id ?? null;
    }
    if (!mediaId) throw new Error("No Shopify MediaImage found for this product image");

    const response = await gateway.graphql(
      `#graphql
        mutation seoAltFixProductUpdateMedia($media: [UpdateMediaInput!]!, $productId: ID!) {
          productUpdateMedia(media: $media, productId: $productId) {
            media { alt }
            mediaUserErrors { field message }
          }
        }`,
      { variables: { productId: job.id, media: [{ id: mediaId, alt: altText }] } },
    );
    const data = (await response.json()) as {
      data?: {
        productUpdateMedia?: {
          media?: { alt: string }[];
          mediaUserErrors?: { field?: string[]; message: string }[];
        };
      };
    };
    const mediaUserErrors = data.data?.productUpdateMedia?.mediaUserErrors ?? [];
    if (mediaUserErrors.length > 0) throw new Error(mediaUserErrors[0].message);

    if (job.productImageId) {
      await db.productImage.update({
        where: { id: job.productImageId },
        data: { altText, altTextModifiedAt: new Date() },
      });
    } else if (job.isFeatured) {
      await db.product.update({
        where: { shop_id: { shop, id: job.id } },
        data: { featuredImageAlt: altText, lastSyncedAt: new Date() },
      });
    }
    return;
  }

  if (job.type === "collection") {
    await contentService.updateCollection(job.id, { image: { altText } });
    await db.collection.update({
      where: { shop_id: { shop, id: job.id } },
      data: { imageAltText: altText, lastSyncedAt: new Date() },
    });
    return;
  }

  if (job.type === "article") {
    await contentService.updateArticle(job.id, { image: { altText } });
    await db.article.update({
      where: { shop_id: { shop, id: job.id } },
      data: { imageAltText: altText, lastSyncedAt: new Date() },
    });
    return;
  }
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
  /** Sibling values to steer the AI away from — populated for the duplicate
   * SEO buckets so a regen doesn't just produce another duplicate. */
  avoidValues?: string[];
}

/** Mirrors handleGenerateAIText's prompt shape (text-generation.handler.ts) so
 * bulk-generated SEO titles/meta descriptions read the same as ones a
 * merchant generated one-by-one in the editor. */
function buildFixPrompt(field: TextField, ctx: PromptContext): string {
  const sanitizedTitle = sanitizePromptInput(ctx.title, { fieldType: "title" });
  const sanitizedDescription = sanitizePromptInput(ctx.description, {
    fieldType: "description",
    allowNewlines: true,
  });

  let prompt = `Create an improved ${ctx.fieldLabel} for the following content.`;
  if (field === "title") {
    // Title rewrite: the CURRENT title is what we're replacing, so lead with
    // the description as the primary signal — quoting the old title first
    // would anchor the model to it.
    if (sanitizedDescription) prompt += `\n\nContext - Description: ${sanitizedDescription}`;
    prompt += `\nContext - Current Title (to be rewritten): ${sanitizedTitle}`;
  } else if (field === "description") {
    // Description rewrite: pass the old description as a "carry the tone /
    // key points, but expand it" seed, not as the thing being replaced —
    // otherwise a too-short description gets padded with filler.
    prompt += `\n\nContext - Title: ${sanitizedTitle}`;
    if (sanitizedDescription) {
      prompt += `\nContext - Current Description (too short — extend, don't just repeat): ${sanitizedDescription}`;
    }
  } else {
    prompt += `\n\nContext - Title: ${sanitizedTitle}`;
    if (field === "metaDescription" && sanitizedDescription) {
      prompt += `\nContext - Description: ${sanitizedDescription}`;
    }
  }
  prompt += `\nLanguage: ${ctx.mainLanguage}`;

  // Duplicate-SEO buckets: explicit "avoid these values" hint. Placed BEFORE
  // Requirements so the model treats it as a hard constraint, not a stylistic
  // one. Sanitize each sibling value to prevent prompt-control tokens.
  if (ctx.avoidValues && ctx.avoidValues.length > 0) {
    const sanitizedAvoid = ctx.avoidValues
      .map((v) => sanitizePromptInput(v, { fieldType: field === "metaDescription" ? "metaDescription" : "seoTitle" }))
      .filter((v) => v.length > 0);
    if (sanitizedAvoid.length > 0) {
      prompt += `\n\nAvoid values (already used by other items — produce something clearly distinct):`;
      for (const v of sanitizedAvoid) prompt += `\n- ${v}`;
    }
  }

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
  field: TextField;
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
      // Minimal partial productUpdate — only the field that changed is sent,
      // so every omitted input is left untouched by Shopify.
      let inputPayload: Record<string, unknown>;
      if (field === "title") {
        inputPayload = { id, title: value };
      } else if (field === "description") {
        inputPayload = { id, descriptionHtml: value };
      } else {
        const seoInput: Record<string, string> = {};
        seoInput[field === "seoTitle" ? "title" : "description"] = value;
        inputPayload = { id, seo: seoInput };
      }
      const response = await gateway.graphql(
        `#graphql
          mutation seoBulkFixProductUpdate($input: ProductInput!) {
            productUpdate(input: $input) {
              userErrors { field message }
            }
          }`,
        { variables: { input: inputPayload } },
      );
      const data = (await response.json()) as {
        data?: { productUpdate?: { userErrors?: { field?: string; message: string }[] } };
      };
      const userErrors = data.data?.productUpdate?.userErrors ?? [];
      if (userErrors.length > 0) throw new Error(userErrors[0].message);

      const dbData =
        field === "seoTitle"
          ? { seoTitle: value, lastSyncedAt: new Date() }
          : field === "metaDescription"
            ? { seoDescription: value, lastSyncedAt: new Date() }
            : field === "description"
              ? { descriptionHtml: value, lastSyncedAt: new Date() }
              : { title: value, lastSyncedAt: new Date() };
      await db.product.update({ where: { shop_id: { shop, id } }, data: dbData });
      break;
    }
    case "collection": {
      if (field === "title") {
        await contentService.updateCollection(id, { title: value });
        await db.collection.update({
          where: { shop_id: { shop, id } },
          data: { title: value, lastSyncedAt: new Date() },
        });
      } else if (field === "description") {
        await contentService.updateCollection(id, { descriptionHtml: value });
        await db.collection.update({
          where: { shop_id: { shop, id } },
          data: { descriptionHtml: value, lastSyncedAt: new Date() },
        });
      } else {
        const seo = field === "seoTitle" ? { title: value } : { description: value };
        await contentService.updateCollection(id, { seo });
        await db.collection.update({
          where: { shop_id: { shop, id } },
          data:
            field === "seoTitle"
              ? { seoTitle: value, lastSyncedAt: new Date() }
              : { seoDescription: value, lastSyncedAt: new Date() },
        });
      }
      break;
    }
    case "page": {
      // Page body lives in `body` (not descriptionHtml); everything else
      // maps 1:1 to the updatePage signature.
      const pageInput =
        field === "seoTitle"
          ? { seoTitle: value }
          : field === "metaDescription"
            ? { seoDescription: value }
            : field === "description"
              ? { body: value }
              : { title: value };
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
      // updateArticle() (see ShopifyContentService.updateArticle). Body
      // uses `body`, matching Page.
      const articleInput =
        field === "seoTitle"
          ? { seoTitle: value }
          : field === "metaDescription"
            ? { seoDescription: value }
            : field === "description"
              ? { body: value }
              : { title: value };
      await contentService.updateArticle(id, articleInput);
      const articleDbData =
        field === "seoTitle"
          ? { seoTitle: value, lastSyncedAt: new Date() }
          : field === "metaDescription"
            ? { seoDescription: value, lastSyncedAt: new Date() }
            : field === "description"
              ? { body: value, lastSyncedAt: new Date() }
              : { title: value, lastSyncedAt: new Date() };
      await db.article.update({ where: { shop_id: { shop, id } }, data: articleDbData });
      break;
    }
  }
}
