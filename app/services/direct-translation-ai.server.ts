/**
 * Direct translations — AI/Task helpers shared by the admin content type
 * (app.direct-translations) and the storefront capture endpoint
 * (proxy.direct-add).
 *
 * Kept in a server-only module so both an authenticated admin request and an
 * app-proxy request (which both carry an Admin API client + offline session)
 * can run the same Task-tracked AI translation.
 */

import type { AdminApiContext } from "@shopify/shopify-app-remix/server";

/** Build a bound AIService.translateBatchValues for this shop, plus the provider. */
export async function buildTranslateBatch(shop: string, taskId?: string) {
  const { db } = await import("../db.server");
  const { AIService, toValidProvider } = await import("../../src/services/ai.service");
  const { tryDecryptApiKey } = await import("../utils/encryption.server");
  const aiSettings = await db.aISettings.findUnique({ where: { shop } });
  const provider = toValidProvider(aiSettings?.preferredProvider);
  const config = {
    huggingfaceApiKey: tryDecryptApiKey(aiSettings?.huggingfaceApiKey, "huggingface") || undefined,
    geminiApiKey: tryDecryptApiKey(aiSettings?.geminiApiKey, "gemini") || undefined,
    claudeApiKey: tryDecryptApiKey(aiSettings?.claudeApiKey, "claude") || undefined,
    openaiApiKey: tryDecryptApiKey(aiSettings?.openaiApiKey, "openai") || undefined,
    grokApiKey: tryDecryptApiKey(aiSettings?.grokApiKey, "grok") || undefined,
    deepseekApiKey: tryDecryptApiKey(aiSettings?.deepseekApiKey, "deepseek") || undefined,
    selectedModel: aiSettings?.selectedModel || undefined,
  };
  const service = new AIService(provider, config, shop, taskId);
  const translateBatch = (values: string[], from: string, to: string, context: string) =>
    service.translateBatchValues(values, from, to, context);
  return { translateBatch, provider };
}

/**
 * The shop's primary locale + ALL published locales (incl. primary) as valid
 * translation targets. Primary is a legitimate target because the source string
 * is not assumed to be in the primary language (auto-detect handles that) —
 * e.g. an English widget label on a German-primary store still needs a German
 * translation for the German storefront.
 */
export async function resolvePrimaryAndTargets(admin: AdminApiContext) {
  const { ContentService } = await import("./content.service");
  const locales = await new ContentService(admin).getShopLocales().catch(() => []);
  const primary = (locales as Array<{ locale: string; primary: boolean }>).find((l) => l.primary)?.locale || "en";
  const targets = (locales as Array<{ locale: string; primary: boolean; published: boolean }>)
    .filter((l) => l.published)
    .map((l) => l.locale);
  return { primary, targets };
}

/**
 * Run an AI translation pass with Task tracking (same pattern as the product
 * sub-resource translator): create a queued Task, advance progress per chunk via
 * onProgress, mark it completed/failed. The TaskCountContext poller surfaces the
 * running count + completion toast in the main navigation.
 */
export async function runAiTask(
  shop: string,
  params: {
    items: Array<{ id: string; sourceText: string }>;
    locales: string[];
    targetLocaleLabel: string;
    resourceTitle: string;
    /** Market scope ("" = global). AI writes translations under this market. */
    marketId?: string;
  },
): Promise<number> {
  const { db } = await import("../db.server");
  const dt = await import("./direct-translation.server");
  const { toValidProvider } = await import("../../src/services/ai.service");
  const { getTaskExpirationDate } = await import("../config/constants");

  const total = params.items.length * params.locales.length;
  const aiSettings = await db.aISettings.findUnique({ where: { shop }, select: { preferredProvider: true } });
  const provider = toValidProvider(aiSettings?.preferredProvider);

  const task = await db.task.create({
    data: {
      shop,
      type: "translation",
      status: "queued",
      fieldType: "direct-translations",
      resourceTitle: params.resourceTitle,
      targetLocale: params.targetLocaleLabel,
      provider,
      progress: 10,
      total,
      expiresAt: getTaskExpirationDate(),
    },
  });

  // Build the AI client bound to this task so token usage is attributed to it.
  const { translateBatch } = await buildTranslateBatch(shop, task.id);

  try {
    const rows = await dt.aiAutoTranslateItems(
      db,
      shop,
      { items: params.items, locales: params.locales, marketId: params.marketId || "" },
      translateBatch,
      async (done, t) => {
        // `t` is the post-dedupe total from the service — keep the Task in sync
        // so processed never exceeds total on full success.
        await db.task.update({
          where: { id: task.id },
          data: { total: t, processed: done, progress: t > 0 ? Math.min(99, 10 + Math.round((done / t) * 89)) : 100 },
        });
      },
    );
    await db.task.update({
      where: { id: task.id },
      data: {
        status: "completed",
        progress: 100,
        processed: rows.length,
        completedAt: new Date(),
        result: JSON.stringify({ translated: rows.length, total }),
      },
    });
    return rows.length;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await db.task.update({
      where: { id: task.id },
      data: { status: "failed", completedAt: new Date(), error: msg.substring(0, 1000) },
    });
    throw err;
  }
}

/**
 * Convenience: AI-translate the given items into ALL published target locales,
 * Task-tracked. No-op (returns 0) when there are no targets or no items.
 */
export async function translateItemsIntoAllLocales(
  admin: AdminApiContext,
  shop: string,
  items: Array<{ id: string; sourceText: string }>,
  resourceTitle: string,
): Promise<number> {
  const { targets } = await resolvePrimaryAndTargets(admin);
  if (targets.length === 0 || items.length === 0) return 0;
  return runAiTask(shop, { items, locales: targets, targetLocaleLabel: "all", resourceTitle });
}
