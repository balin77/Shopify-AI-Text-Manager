import { data as json } from "react-router";
import type { AIActionContext } from "./shared";
import { errorMessage, createAIService } from "./shared";
import { getTaskExpirationDate } from "~/config/constants";
import { getCachedShopLocales } from "~/utils/shop-locales-cache.server";
import { logger } from "~/utils/logger.server";
import { stripLiquidAndHtml } from "~/utils/liquid-strip";
import type { TranslatableField } from "~/actions/templates/shared";
import type { DataResponse } from "~/types/data-response";

/** Number of template excerpts sent to the AI per call. */
const BATCH_SIZE = 5;
/** How many batches run concurrently (the AI queue rate-limits globally anyway). */
const MAX_CONCURRENCY = 3;
/** Chars of the (cleaned) email body used to disambiguate similar subjects. */
const BODY_EXCERPT_CHARS = 200;
/** Keys that may hold the notification's subject/name, in preference order. */
const SUBJECT_KEYS = ["title", "subject", "name", "label"];

/** Build the excerpt (subject + short body snippet) sent to the AI for one row. */
function buildExcerpt(content: TranslatableField[]): string {
  const subjectRaw = SUBJECT_KEYS.map((k) => content.find((c) => c.key === k)?.value).find((v) => v && v.trim()) ?? "";
  const title = stripLiquidAndHtml(subjectRaw);
  const body = stripLiquidAndHtml(content.find((c) => c.key === "body_html")?.value ?? "");
  const bodySnippet = body.slice(0, BODY_EXCERPT_CHARS);
  return [title ? `Subject: ${title}` : "", bodySnippet].filter(Boolean).join("\n");
}

interface PendingRow {
  id: string;
  excerpt: string;
}

/**
 * Backfill AI-generated short nav titles for the shop's Shopify email
 * notification templates (EMAIL_TEMPLATE rows in the "system" domain). Shopify
 * only exposes the full localized subject line as a name, which is far too long
 * for the item list — so we distill each into a 2-4 word notification name in
 * the shop's main language, batched (BATCH_SIZE per AI call) through the normal
 * task/queue path. Only rows with a NULL aiShortTitle are processed, so this is
 * idempotent: it runs on first sync and backfills any newly-synced templates,
 * and is a no-op once every template has a title.
 *
 * Fired lazily by the System page when it detects untitled templates.
 */
export async function handleGenerateTemplateTitles(ctx: AIActionContext): Promise<DataResponse> {
  const { session, db, settings, admin } = ctx;
  const shop = session.shop;

  // Rows still missing a title. Scoped to EMAIL_TEMPLATE — the only type whose
  // raw groupName (the email subject) is unusable as a nav label.
  const rows = await db.themeContent.findMany({
    where: { shop, domain: "system", resourceType: "EMAIL_TEMPLATE", aiShortTitle: null },
    select: { id: true, translatableContent: true },
  });

  if (rows.length === 0) {
    return json({ success: true, generated: 0, pending: 0 });
  }

  // Concurrency guard: a single run handles every pending row, so if one is
  // already in flight (a second page-load raced), don't start a duplicate that
  // would regenerate the same rows and burn the merchant's AI tokens twice.
  const inFlight = await db.task.findFirst({
    where: { shop, resourceType: "templateTitles", status: { in: ["pending", "queued", "running"] } },
    select: { id: true },
  });
  if (inFlight) {
    return json({ success: true, generated: 0, pending: rows.length, alreadyRunning: true });
  }

  const shopLocales = await getCachedShopLocales(admin, shop);
  const primaryLocale = shopLocales.find((l) => l.primary)?.locale || "en";

  const pending: PendingRow[] = rows.map((r) => ({
    id: r.id,
    excerpt: buildExcerpt(Array.isArray(r.translatableContent) ? (r.translatableContent as unknown as TranslatableField[]) : []),
  }));

  // Chunk into batches of BATCH_SIZE.
  const batches: PendingRow[][] = [];
  for (let i = 0; i < pending.length; i += BATCH_SIZE) {
    batches.push(pending.slice(i, i + BATCH_SIZE));
  }

  const task = await db.task.create({
    data: {
      shop,
      type: "bulkAiGeneration",
      status: "running",
      resourceType: "templateTitles",
      resourceId: "system",
      resourceTitle: "Notification titles",
      progress: 5,
      total: pending.length,
      processed: 0,
      expiresAt: getTaskExpirationDate(),
    },
  });

  const aiService = createAIService(settings, shop, task.id);

  let generated = 0;
  let processed = 0;
  const errors: string[] = [];

  // Run batches with bounded concurrency. Each batch is one AI call; a failing
  // batch is logged and skipped (its rows stay NULL and get retried next visit)
  // — a single bad batch never blocks the rest.
  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= batches.length) return;
      const batch = batches[index];
      try {
        const titles = await aiService.generateTitlesBatch(batch.map((b) => b.excerpt), primaryLocale);
        // Persist ONLY non-empty titles. An empty result must stay NULL so it is
        // reprocessed on the next visit — writing "" would make the row invisible
        // to the `aiShortTitle: null` requery yet still `aiTitlePending` in the
        // loader (`!""` is true), stranding it forever and re-firing the backfill
        // on every page load.
        const updates = batch.flatMap((row, i) => {
          const title = (titles[i] ?? "").trim();
          return title ? [db.themeContent.update({ where: { id: row.id }, data: { aiShortTitle: title } })] : [];
        });
        if (updates.length > 0) await db.$transaction(updates);
        generated += updates.length;
      } catch (err) {
        errors.push(errorMessage(err));
        logger.warn("[API-AI] Template-title batch failed — rows left untitled for retry", {
          context: "AI",
          shop,
          batchSize: batch.length,
          error: errorMessage(err),
        });
      } finally {
        processed += batch.length;
        await db.task.update({
          where: { id: task.id },
          data: {
            processed,
            progress: Math.min(99, Math.round((processed / pending.length) * 100)),
          },
        });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENCY, batches.length) }, () => worker()));

  // Fail the task only if NOTHING landed; otherwise it's a (partial) success —
  // untitled rows are retried on the next page visit.
  if (generated === 0) {
    await db.task.update({
      where: { id: task.id },
      data: { status: "failed", completedAt: new Date(), error: errors.join("; ").substring(0, 1000) || "No titles generated" },
    });
    return json({ success: false, error: "Could not generate notification titles.", generated: 0 }, { status: 500 });
  }

  await db.task.update({
    where: { id: task.id },
    data: {
      status: "completed",
      progress: 100,
      processed,
      completedAt: new Date(),
      result: JSON.stringify({ generated, failed: pending.length - generated }),
    },
  });

  return json({ success: true, generated, pending: pending.length - generated });
}
