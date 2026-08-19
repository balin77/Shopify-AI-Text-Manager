/**
 * Sync-side reconciliation of stale foreign translations.
 *
 * The editors in this app already purge a field's foreign translations when
 * the merchant changes its primary value here. Nothing did when the primary
 * text changed ANYWHERE ELSE — the Shopify admin, another app, a CSV import —
 * so the storefront kept serving a translation of a text that no longer
 * exists, invisibly, until someone re-opened that item. This module closes
 * that gap: every sync that represents a CHANGE EVENT for one resource
 * (webhook, webhook retry/reconcile, an explicit single-item reload) hands its
 * freshly fetched translations here, and stale ones are removed on Shopify AND
 * locally right away.
 *
 * Three rules keep it safe:
 *
 *  - **It costs no extra API call to DETECT.** The staleness signals
 *    (`translations.outdated`, and a key missing from `translatableContent`)
 *    both ride on the query the sync already makes. Shopify is only called
 *    when something actually IS stale.
 *  - **Removal is echo-verified.** `translationsRemove` can silently no-op
 *    (CLAUDE.md), so a local row is deleted ONLY for a (locale, key) pair
 *    Shopify confirms. An unconfirmed removal keeps the row — a DB that
 *    disagrees with Shopify is worse than a stale row.
 *  - **It never runs on a FULL sync.** Callers opt in per resource. A shop's
 *    first full sync would otherwise mass-delete every translation Shopify has
 *    ever flagged outdated — including hand-written ones the merchant has not
 *    looked at yet. Change events are what the merchant asked to react to.
 *
 * Max plan (`autoTranslateExternalChanges`): instead of leaving the field
 * untranslated, the NEW primary value is re-translated into that locale and
 * registered. Anything that cannot be re-translated (cleared field, missing
 * digest, `handle`, AI error, no API key) falls back to the purge, so the
 * storefront never keeps the stale text because automation failed. That AI run
 * is DETACHED and Task-tracked — two callers await this sync inside an HTTP
 * request, and one AI request per locale does not fit in one. The purge stays
 * inline (one GraphQL call), so the storefront is corrected immediately.
 *
 * With the purge ON (the default) an in-app primary save has already removed
 * the translations before the webhook arrives, so nothing is outdated by then:
 * the re-translation is reached by changes made OUTSIDE the app, which is
 * exactly what it is for.
 */

import { logger } from "../../utils/logger.server";
import {
  markTranslationSaved,
  isTranslationRecentlySaved,
} from "../../utils/translation-save-lock.server";
import { ShopifyApiGateway } from "../shopify-api-gateway.service";
import type { ShopifyGraphQLClient } from "../sync-types";
import { registerAndVerify, removeAndVerify } from "../bulk-editor/translations.server";
import { loadTranslationChangePolicy } from "./translation-change-policy.server";
import {
  findStaleTranslations,
  partitionStaleTranslations,
  type PrimaryContentEntry,
  type StaleTranslation,
  type SyncedTranslation,
} from "./stale-translations.shared";

export type { PrimaryContentEntry, SyncedTranslation } from "./stale-translations.shared";

export interface ReconcileParams {
  /** Anything with `.graphql` — `admin` or an existing gateway. */
  client: ShopifyGraphQLClient;
  shop: string;
  resourceId: string;
  /** `ContentTranslation.resourceType` — "Product" | "Collection" | "Article" | "Page" | "Blog". */
  resourceType: string;
  /** Content type for the AI prompt ("product" | "collection" | "article" | "page"). */
  contentType: string;
  /** Shown on the Task row when a re-translation runs. */
  resourceTitle?: string;
  /** Every translation row this sync fetched (all market layers). */
  translations: readonly SyncedTranslation[];
  /** `translatableContent` of the resource: key → { value, digest }. */
  primaryContent: Readonly<Record<string, PrimaryContentEntry>>;
}

export interface ReconcileResult {
  /** (locale, key) pairs removed on Shopify AND locally, inline. */
  removed: number;
  /**
   * (locale, key) pairs handed to the DETACHED re-translation run (Max). They
   * are not finished when this resolves — the run is Task-tracked and the
   * merchant follows it in the Tasks tab, exactly like every other AI
   * operation in this app.
   */
  retranslating: number;
}

const NOTHING: ReconcileResult = { removed: 0, retranslating: 0 };

/**
 * Detect and repair stale foreign translations for ONE resource.
 *
 * BEST-EFFORT by contract: the sync it hangs off has already written the
 * cache, so every failure here is logged and swallowed. A stale row left
 * behind is the pre-existing behaviour; a thrown error would turn a working
 * webhook into a retry loop.
 */
export async function reconcileStaleTranslations(params: ReconcileParams): Promise<ReconcileResult> {
  const { client, shop, resourceId, resourceType, translations, primaryContent } = params;

  try {
    // Same guard the sync's own translation rewrite uses: right after this app
    // wrote translations for the resource, Shopify's read-back is not reliably
    // consistent yet, and acting on it could delete what the merchant just
    // saved. A genuinely stale row is caught by the next change event.
    if (isTranslationRecentlySaved(resourceId)) return NOTHING;

    const stale = findStaleTranslations(translations, primaryContent);
    if (stale.length === 0) return NOTHING;

    const policy = await loadTranslationChangePolicy(shop);
    if (!policy.purgeOnPrimaryChange && !policy.autoTranslateExternalChanges) return NOTHING;

    logger.info("[StaleTranslations] Primary text changed outside the editor — reconciling", {
      context: "StaleTranslations",
      shop,
      resourceId,
      resourceType,
      stale: stale.length,
      purge: policy.purgeOnPrimaryChange,
      autoTranslate: policy.autoTranslateExternalChanges,
    });

    const gateway = new ShopifyApiGateway(client, shop);
    const { retranslate, purge } = partitionStaleTranslations(
      stale,
      policy.autoTranslateExternalChanges,
    );

    // The AI re-translation is DETACHED. Two of the callers (the single-item
    // reload routes) await this sync inside an HTTP request, and one AI
    // request per locale does not fit in a request the browser abandons after
    // 30 seconds. It is Task-tracked, so nothing is lost by not waiting —
    // while the purge below is one GraphQL call and stays inline, so the
    // storefront is corrected immediately either way.
    if (retranslate.length > 0) {
      void (async () => {
        try {
          const outcome = await retranslateStaleEntries(gateway, params, retranslate);
          // Entries the AI path could not deliver still have to lose their
          // stale translation — a failed automation must never leave the old
          // text on the storefront.
          if (policy.purgeOnPrimaryChange && outcome.failed.length > 0) {
            await purgeStaleEntries(gateway, shop, resourceId, resourceType, outcome.failed);
          }
          if (outcome.registered.length > 0 || outcome.failed.length > 0) markTranslationSaved(resourceId);
        } catch (error: unknown) {
          logger.warn("[StaleTranslations] Detached re-translation run failed", {
            context: "StaleTranslations",
            shop,
            resourceId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })();
    }

    let removed = 0;
    if (policy.purgeOnPrimaryChange && purge.length > 0) {
      removed = await purgeStaleEntries(gateway, shop, resourceId, resourceType, purge);
    }

    if (removed > 0) {
      // Protect what we just changed from a racing webhook sync that re-fetches
      // Shopify before it is consistent again.
      markTranslationSaved(resourceId);
      logger.info("[StaleTranslations] Reconciled", {
        context: "StaleTranslations",
        shop,
        resourceId,
        removed,
        retranslating: retranslate.length,
      });
    }

    return { removed, retranslating: retranslate.length };
  } catch (error: unknown) {
    logger.warn("[StaleTranslations] Reconciliation failed — stale rows kept", {
      context: "StaleTranslations",
      shop,
      resourceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return NOTHING;
  }
}

// ─── Purge ────────────────────────────────────────────────────────────────

/**
 * Echo-verified removal on Shopify, then the local mirror for CONFIRMED pairs
 * only. Global layer (`marketId ""`) exclusively — a market override is a
 * deliberate separate value and survives, exactly as in both editors.
 *
 * ONE call PER LOCALE with exactly that locale's stale keys. `translationsRemove`
 * takes keys × locales as a cross product, and this set is genuinely per
 * (locale, key): a locale that was re-translated after the primary change is
 * not stale, and a key can be stale in one locale while another holds a
 * current translation of it. Sending the union would delete a translation
 * nobody flagged — on Shopify, where the local row we kept could no longer
 * mirror it.
 */
async function purgeStaleEntries(
  gateway: ShopifyApiGateway,
  shop: string,
  resourceId: string,
  resourceType: string,
  entries: readonly StaleTranslation[],
): Promise<number> {
  const keysByLocale = new Map<string, string[]>();
  for (const entry of entries) {
    const list = keysByLocale.get(entry.locale) ?? [];
    if (!list.includes(entry.key)) list.push(entry.key);
    keysByLocale.set(entry.locale, list);
  }
  if (keysByLocale.size === 0) return 0;

  const { db } = await import("../../db.server");
  let removed = 0;
  for (const [locale, localeKeys] of keysByLocale) {
    const { confirmedKeys } = await removeAndVerify(gateway, resourceId, localeKeys, locale, "");
    if (confirmedKeys.size === 0) continue;
    const confirmed = localeKeys.filter((key) => confirmedKeys.has(key));
    await db.contentTranslation.deleteMany({
      where: { shop, resourceId, resourceType, locale, marketId: "", key: { in: confirmed } },
    });
    // Counted from Shopify's confirmations, not from the DB result: a row the
    // cache never held (or already dropped) is still a translation that is
    // gone from the storefront, and that is what this number reports.
    removed += confirmed.length;
  }
  return removed;
}

// ─── Re-translate (Max) ───────────────────────────────────────────────────

interface RetranslateOutcome {
  registered: StaleTranslation[];
  /** Entries that could not be re-translated — they must still be purged. */
  failed: StaleTranslation[];
}

/**
 * Re-translate the NEW primary values into every affected locale and register
 * them, Task-tracked so the run shows up in the Tasks tab like every other AI
 * operation. One AI request per locale (the same granularity the editor's
 * "translate all fields" uses).
 */
async function retranslateStaleEntries(
  gateway: ShopifyApiGateway,
  params: ReconcileParams,
  entries: readonly StaleTranslation[],
): Promise<RetranslateOutcome> {
  const { shop, resourceId, resourceType, contentType, resourceTitle } = params;
  const { db } = await import("../../db.server");

  const byLocale = new Map<string, StaleTranslation[]>();
  for (const entry of entries) {
    const list = byLocale.get(entry.locale) ?? [];
    list.push(entry);
    byLocale.set(entry.locale, list);
  }

  const registered: StaleTranslation[] = [];
  const failed: StaleTranslation[] = [];

  const { fieldTranslationKeyMap } = await import("../../../src/services/shopify-content.service");
  const keyToField = invertFieldMap(fieldTranslationKeyMap(resourceType));

  const { getTaskExpirationDate } = await import("../../config/constants");
  const { toValidProvider } = await import("../../../src/services/ai.service");
  const { TranslationService } = await import("../../../src/services/translation.service");
  const { tryDecryptApiKey } = await import("../../utils/encryption.server");
  const { getInstructionWithDefault } = await import("../../utils/ai-instructions.utils");
  const { buildTranslateInstructions } = await import("../../utils/character-limits");

  const aiSettings = await db.aISettings.findUnique({ where: { shop } });
  const provider = toValidProvider(aiSettings?.preferredProvider);
  const aiConfig = {
    huggingfaceApiKey: tryDecryptApiKey(aiSettings?.huggingfaceApiKey, "huggingface") || undefined,
    geminiApiKey: tryDecryptApiKey(aiSettings?.geminiApiKey, "gemini") || undefined,
    claudeApiKey: tryDecryptApiKey(aiSettings?.claudeApiKey, "claude") || undefined,
    openaiApiKey: tryDecryptApiKey(aiSettings?.openaiApiKey, "openai") || undefined,
    grokApiKey: tryDecryptApiKey(aiSettings?.grokApiKey, "grok") || undefined,
    deepseekApiKey: tryDecryptApiKey(aiSettings?.deepseekApiKey, "deepseek") || undefined,
    selectedModel: aiSettings?.selectedModel || undefined,
  };

  const task = await db.task.create({
    data: {
      shop,
      type: "translation",
      status: "running",
      resourceType,
      resourceId,
      resourceTitle: resourceTitle || resourceId,
      fieldType: "autoTranslateExternalChange",
      targetLocale: [...byLocale.keys()].join(", "),
      provider,
      progress: 10,
      total: entries.length,
      expiresAt: getTaskExpirationDate(),
    },
  });

  try {
    const aiInstructions = await db.aIInstructions.findUnique({ where: { shop } });
    const translationMode: "exact" | "seo_optimized" =
      aiSettings?.translationMode === "seo_optimized" ? "seo_optimized" : "exact";
    const translationService = new TranslationService(provider, aiConfig, shop, task.id);

    let processed = 0;
    for (const [locale, localeEntries] of byLocale) {
      const fields: Record<string, string> = {};
      const fieldToEntry = new Map<string, StaleTranslation>();
      for (const entry of localeEntries) {
        const fieldName = keyToField[entry.key];
        if (!fieldName) {
          failed.push(entry);
          continue;
        }
        fields[fieldName] = entry.primaryValue;
        fieldToEntry.set(fieldName, entry);
      }
      if (Object.keys(fields).length === 0) continue;

      try {
        const instructions = buildTranslateInstructions(
          getInstructionWithDefault(aiInstructions, "translateInstructions"),
          translationMode,
          Object.keys(fields),
          { limits: (aiSettings?.seoLimits ?? null) as Record<string, number> | null },
        );
        const result = await translationService.translateProduct(
          fields,
          [locale],
          contentType,
          instructions,
        );
        const translated = result[locale] || {};

        const writes: Array<{
          entry: StaleTranslation;
          input: { key: string; value: string; locale: string; translatableContentDigest: string };
        }> = [];
        for (const [fieldName, entry] of fieldToEntry) {
          const value = translated[fieldName];
          if (!value || !value.trim() || !entry.digest) {
            failed.push(entry);
            continue;
          }
          writes.push({
            entry,
            input: {
              key: entry.key,
              value,
              locale,
              translatableContentDigest: entry.digest,
            },
          });
        }
        if (writes.length === 0) continue;

        const { confirmedKeys } = await registerAndVerify(
          gateway,
          resourceId,
          writes.map((w) => w.input),
        );
        for (const { entry, input } of writes) {
          if (!confirmedKeys.has(input.key)) {
            // Shopify did not echo it back — treat it exactly like a failed
            // translation so the stale row is purged instead of being left
            // behind on the strength of an unverified write.
            failed.push(entry);
            continue;
          }
          await db.contentTranslation.upsert({
            where: {
              shop_resourceId_key_locale_marketId: {
                shop,
                resourceId,
                key: input.key,
                locale,
                marketId: "",
              },
            },
            create: {
              shop,
              resourceId,
              resourceType,
              key: input.key,
              value: input.value,
              locale,
              digest: input.translatableContentDigest,
              marketId: "",
            },
            update: { value: input.value, digest: input.translatableContentDigest },
          });
          registered.push(entry);
        }
      } catch (error: unknown) {
        logger.warn("[StaleTranslations] Auto-translation failed — falling back to removal", {
          context: "StaleTranslations",
          shop,
          resourceId,
          locale,
          error: error instanceof Error ? error.message : String(error),
        });
        for (const entry of localeEntries) {
          if (!registered.includes(entry) && !failed.includes(entry)) failed.push(entry);
        }
      }

      processed += localeEntries.length;
      await db.task
        .update({
          where: { id: task.id },
          data: {
            processed,
            progress: Math.min(99, 10 + Math.round((processed / entries.length) * 89)),
          },
        })
        .catch(() => undefined);
    }

    // A run that could not register a single translation (no API key, provider
    // down, nothing echoed back) is a FAILED run — reporting it as completed
    // would hide the reason the merchant's fields came back untranslated. The
    // entries themselves are already queued for the purge either way.
    await db.task.update({
      where: { id: task.id },
      data: {
        status: registered.length > 0 ? "completed" : "failed",
        progress: 100,
        processed: entries.length,
        completedAt: new Date(),
        ...(registered.length === 0
          ? { error: "Automatic re-translation produced no usable translation." }
          : {}),
        result: JSON.stringify({ retranslated: registered.length, purged: failed.length }),
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    await db.task
      .update({
        where: { id: task.id },
        data: { status: "failed", completedAt: new Date(), error: message.substring(0, 1000) },
      })
      .catch(() => undefined);
    logger.warn("[StaleTranslations] Auto-translation run failed", {
      context: "StaleTranslations",
      shop,
      resourceId,
      error: message,
    });
    for (const entry of entries) {
      if (!registered.includes(entry) && !failed.includes(entry)) failed.push(entry);
    }
  }

  return { registered, failed };
}

/**
 * translation key → UI field name, first field wins. `body_html` maps back to
 * `description` (and ShopPolicy's `body` likewise) because the AI prompt
 * labels fields by that name and `sanitizePromptInput` allows newlines for it.
 */
function invertFieldMap(map: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [field, key] of Object.entries(map)) {
    if (out[key] === undefined) out[key] = field;
  }
  return out;
}
