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
 * WHICH changes it reaches follows from the purge switch, and the column's
 * name (`autoTranslateExternalChanges`) is historic rather than exact. With the
 * purge ON, an in-app primary save has already deleted the translations before
 * any sync sees them — no rows, no baseline digest, nothing stale — so the
 * re-translation is left with the changes this app did not make. With the purge
 * OFF the rows survive with their old digest, and the very same detection fires
 * for an in-app edit too: the merchant's own change is re-translated instead of
 * dropped. That was not designed, it is a consequence of keying on the digest,
 * and it is kept deliberately — it is the more useful behaviour.
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
  /**
   * The merchant-facing kind, used for BOTH the AI prompt and the Task row.
   * These four strings are the ones `AIService.translateFields` recognises AND
   * the ones the Tasks tab maps to a label and a Shopify admin link — an
   * article is a "blog" to both. Passing the Shopify resource type here (the
   * capitalised one) silently degrades the prompt to "product fields" and
   * leaves the task without a link.
   */
  contentKind: "product" | "collection" | "blog" | "page";
  /** Shown on the Task row when a re-translation runs. */
  resourceTitle?: string;
  /** Every translation row this sync fetched (all market layers). */
  translations: readonly SyncedTranslation[];
  /** `translatableContent` of the resource: key → { value, digest }. */
  primaryContent: Readonly<Record<string, PrimaryContentEntry>>;
  /**
   * key → source digest as of the PREVIOUS sync, from `loadPreviousPrimaryDigests`.
   * MUST be captured BEFORE the sync overwrites the cache, and is what proves
   * the primary text moved in THIS sync rather than at some unknown point in
   * the past. Absent ⇒ nothing is considered stale.
   */
  previousDigests: Readonly<Record<string, string | null | undefined>>;
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
 * Resources whose DETACHED re-translation run is still going, so a second
 * change event for the same resource does not start a duplicate run against
 * the same entries. Shopify emits several `products/update` webhooks for one
 * admin save, and without this each one would spawn its own AI run, its own
 * Task row, and race the others' writes. In-process only — that is enough,
 * because the runs it guards are themselves in-process.
 */
const retranslationsInFlight = new Map<string, Promise<void>>();
/** Separator for the in-flight key — written as an escape, never as a literal
 * control byte (a NUL in the source makes git treat the file as binary). */
const IN_FLIGHT_SEP = "\u0000";

/**
 * Test seam: resolve once every detached re-translation currently running has
 * finished. Production code never calls this — the runs are deliberately not
 * awaited (see the header) — but a test that cannot observe them can only
 * assert the inline half, which is how the "a confirmed write must never be
 * purged because the DB blinked" bug stayed invisible.
 */
export async function awaitDetachedRetranslations(): Promise<void> {
  await Promise.allSettled([...retranslationsInFlight.values()]);
}

/**
 * The source digests the PREVIOUS sync stored on this resource's GLOBAL
 * translation rows, keyed by translation key. Must be read BEFORE the sync
 * overwrites them; comparing them to the freshly fetched digests is what tells
 * "the primary text moved in this sync" apart from "Shopify still flags this
 * translation outdated from some edit years ago".
 *
 * Best-effort: on error we return {} , which makes the reconciliation a no-op
 * rather than acting on an unknown baseline.
 */
export async function loadPreviousPrimaryDigests(
  shop: string,
  resourceId: string,
  resourceType: string,
): Promise<Record<string, string | null>> {
  try {
    const { db } = await import("../../db.server");
    const rows = await db.contentTranslation.findMany({
      where: { shop, resourceId, resourceType, marketId: "" },
      select: { key: true, digest: true },
    });
    const out: Record<string, string | null> = {};
    // The digest is a property of the SOURCE value, so it is the same across
    // locales; the first non-null one for a key is the baseline.
    for (const row of rows) {
      if (out[row.key] == null) out[row.key] = row.digest;
    }
    return out;
  } catch (error: unknown) {
    logger.warn("[StaleTranslations] Could not read previous digests — skipping reconciliation", {
      context: "StaleTranslations",
      shop,
      resourceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return {};
  }
}

/**
 * Detect and repair stale foreign translations for ONE resource.
 *
 * BEST-EFFORT by contract: the sync it hangs off has already written the
 * cache, so every failure here is logged and swallowed. A stale row left
 * behind is the pre-existing behaviour; a thrown error would turn a working
 * webhook into a retry loop.
 */
export async function reconcileStaleTranslations(params: ReconcileParams): Promise<ReconcileResult> {
  const { client, shop, resourceId, resourceType, translations, primaryContent, previousDigests } =
    params;

  try {
    // Same guard the sync's own translation rewrite uses: right after this app
    // wrote translations for the resource, Shopify's read-back is not reliably
    // consistent yet, and acting on it could delete what the merchant just
    // saved. A genuinely stale row is caught by the next change event.
    if (isTranslationRecentlySaved(resourceId)) return NOTHING;

    const stale = findStaleTranslations(translations, primaryContent, previousDigests);
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
    const inFlightKey = `${shop}${IN_FLIGHT_SEP}${resourceId}`;
    const startRetranslation = retranslate.length > 0 && !retranslationsInFlight.has(inFlightKey);
    if (startRetranslation) {
      const run = (async () => {
        try {
          const outcome = await retranslateStaleEntries(gateway, params, retranslate);
          // Entries the AI path could not deliver still have to lose their
          // stale translation — a failed automation must never leave the old
          // text on the storefront. UNLESS the merchant edited this resource's
          // translations while the AI was working: the run took minutes, their
          // hand-written value is newer than everything decided here, and
          // deleting it would be the one unrecoverable outcome. The next change
          // event repairs whatever is genuinely still stale.
          if (
            policy.purgeOnPrimaryChange &&
            outcome.failed.length > 0 &&
            !isTranslationRecentlySaved(resourceId)
          ) {
            await purgeStaleEntries(gateway, shop, resourceId, resourceType, outcome.failed);
          }
          if (outcome.registered.length > 0) markTranslationSaved(resourceId);
        } catch (error: unknown) {
          logger.warn("[StaleTranslations] Detached re-translation run failed", {
            context: "StaleTranslations",
            shop,
            resourceId,
            error: error instanceof Error ? error.message : String(error),
          });
        } finally {
          retranslationsInFlight.delete(inFlightKey);
        }
      })();
      retranslationsInFlight.set(inFlightKey, run);
      void run;
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
        retranslating: startRetranslation ? retranslate.length : 0,
      });
    }

    return { removed, retranslating: startRetranslation ? retranslate.length : 0 };
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
  const { shop, resourceId, resourceType, contentKind, resourceTitle } = params;
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
      // The Tasks tab maps this to a label and a Shopify admin link, and it
      // speaks the merchant-facing kind, not the Shopify resource type.
      resourceType: contentKind,
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
      // The merchant edited this resource's translations while we were
      // working: their value is newer than anything this run decided. Abandon
      // the remaining locales — the untouched entries stay out of BOTH lists,
      // so nothing re-translates them and nothing purges them.
      if (isTranslationRecentlySaved(resourceId)) {
        logger.info("[StaleTranslations] Re-translation abandoned — merchant saved in the meantime", {
          context: "StaleTranslations",
          shop,
          resourceId,
        });
        break;
      }
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
          contentKind,
          instructions,
          await keywordDirectiveFor(shop, resourceId, locale, aiSettings?.keywordAwareTranslation ?? true),
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
          // Shopify has CONFIRMED this write, so the entry is registered no
          // matter what the local mirror does. A DB error here must not push it
          // into `failed` — that list is purged, and purging a translation
          // Shopify just verified because our own database blinked is the one
          // outcome that loses merchant content. The next sync re-reads it from
          // Shopify anyway.
          registered.push(entry);
          try {
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
          } catch (mirrorError: unknown) {
            logger.warn("[StaleTranslations] Registered on Shopify but not mirrored locally", {
              context: "StaleTranslations",
              shop,
              resourceId,
              locale,
              key: input.key,
              error: mirrorError instanceof Error ? mirrorError.message : String(mirrorError),
            });
          }
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
 * The keyword-aware clause for ONE target locale, or undefined when the shop
 * switched that off or tracks no keyword for it. Without this the auto
 * re-translation would be the ONE translate path in the app that ignores
 * `AISettings.keywordAwareTranslation` — and the glossary (applied inside
 * translateFields) would be honoured while the keywords silently were not.
 */
async function keywordDirectiveFor(
  shop: string,
  resourceId: string,
  locale: string,
  keywordAwareTranslation: boolean,
): Promise<string | undefined> {
  if (!keywordAwareTranslation) return undefined;
  try {
    const { db } = await import("../../db.server");
    const { getItemKeywords } = await import("../seo/keywords.service");
    const { keywordTranslationDirective } = await import("../seo/keyword-translation-prompt");
    const { localeName } = await import("../../../src/services/ai.service");
    const rows = await getItemKeywords(db, shop, resourceId, locale);
    const primary = rows.find((r) => r.role === "primary")?.keyword ?? null;
    if (!primary) return undefined;
    return (
      keywordTranslationDirective({
        locale,
        localeName: localeName(locale),
        primary,
        secondaries: rows.filter((r) => r.role === "secondary").map((r) => r.keyword),
      }) || undefined
    );
  } catch {
    // A keyword lookup must never cost the merchant the translation — worst
    // case this locale is translated the literal way (same rule as
    // shopify-content.service.ts).
    return undefined;
  }
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
