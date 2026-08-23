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
 * The column's name (`autoTranslateExternalChanges`) is historic rather than
 * exact: switching it on switches the PURGE off (the policy module resolves the
 * pair), so the translations survive an in-app save with their old digest and
 * the very same detection re-translates that change too — an edit made here is
 * treated exactly like one made in the Shopify admin. Deleting the rows a
 * re-translation is about to refresh is the combination that means nothing,
 * which is why it cannot be configured.
 */

import { logger } from "../../utils/logger.server";
import {
  markTranslationSaved,
  isTranslationRecentlySaved,
  translationSavedAt,
} from "../../utils/translation-save-lock.server";
import { ShopifyApiGateway } from "../shopify-api-gateway.service";
import type { ShopifyGraphQLClient } from "../sync-types";
import { registerAndVerify, removeAndVerify } from "../bulk-editor/translations.server";
import {
  loadTranslationChangePolicy,
  type TranslationChangePolicy,
} from "./translation-change-policy.server";
import {
  digestBaselineKey,
  findStaleTranslations,
  partitionStaleTranslations,
  type PrimaryContentEntry,
  type StaleTranslation,
  type SyncedTranslation,
} from "./stale-translations.shared";

export type { PrimaryContentEntry, SyncedTranslation } from "./stale-translations.shared";

/**
 * WHO is being repaired — the part both entry points share. `ReconcileParams`
 * adds the EVIDENCE the sync-side detection needs on top of it; the in-app save
 * carries none of that, because it is the change event itself.
 */
export interface RepairTarget {
  /** Anything with `.graphql` — `admin` or an existing gateway. */
  client: ShopifyGraphQLClient;
  shop: string;
  resourceId: string;
  /** `ContentTranslation.resourceType` — "Product" | "Collection" | "Article" | "Page" | "Blog" | "ShopPolicy". */
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
}

export interface ReconcileParams extends RepairTarget {
  /** Every translation row this sync fetched (all market layers). */
  translations: readonly SyncedTranslation[];
  /** `translatableContent` of the resource: key → { value, digest }. */
  primaryContent: Readonly<Record<string, PrimaryContentEntry>>;
  /**
   * `digestBaselineKey(locale, key)` → the source digest that row was written
   * against, from `loadPreviousTranslationDigests`. MUST be captured BEFORE the
   * sync overwrites the cache, and is what proves the primary text moved in
   * THIS sync rather than at some unknown point in the past. Absent ⇒ nothing
   * is considered stale.
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
 * The source digest each of this resource's GLOBAL translation rows was last
 * written against, keyed by `digestBaselineKey(locale, key)`. Must be read
 * BEFORE the sync overwrites them; comparing them to the freshly fetched
 * digests is what tells "the primary text moved in this sync" apart from
 * "Shopify still flags this translation outdated from some edit years ago".
 *
 * PER ROW, not per key: a digest describes the source a PARTICULAR translation
 * was written against, and two locales legitimately hold different ones
 * (translate DE, the merchant edits the source, translate FR). One baseline per
 * key made which row got repaired depend on the order Postgres returned them
 * in.
 *
 * Best-effort: on error we return {} , which makes the reconciliation a no-op
 * rather than acting on an unknown baseline.
 */
export async function loadPreviousTranslationDigests(
  shop: string,
  resourceId: string,
  resourceType: string,
): Promise<Record<string, string | null>> {
  try {
    const { db } = await import("../../db.server");
    const rows = await db.contentTranslation.findMany({
      where: { shop, resourceId, resourceType, marketId: "" },
      select: { key: true, locale: true, digest: true },
    });
    const out: Record<string, string | null> = {};
    for (const row of rows) out[digestBaselineKey(row.locale, row.key)] = row.digest;
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
  const { shop, resourceId, resourceType, translations, primaryContent, previousDigests } = params;

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

    return await repairStaleTranslations(params, stale, policy);
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

/**
 * Resource types whose primary text this app can edit but NO automatic event
 * re-translates: pages, articles, blogs and policies have no Shopify webhook,
 * so the only moment anything knows they changed is the save that changed them
 * (CLAUDE.md). Until `reconcileAfterPrimarySave` existed they were therefore
 * "unreconciled" in the strict sense — their translations were DELETED and
 * nothing ever refreshed them, so on a Max shop the same edit produced the new
 * text on a product and a blank field on a page.
 *
 * Product and Collection are deliberately ABSENT: their update webhook already
 * runs the sync-side reconciliation, and starting a second run from the save
 * would queue a duplicate AI run behind it (the in-flight map never drops one)
 * for a repair that has already happened.
 */
export const IN_APP_RETRANSLATED_RESOURCE_TYPES: ReadonlySet<string> = new Set([
  "Page",
  "Article",
  "Blog",
  "ShopPolicy",
]);

/** Separator of a `${locale}\u0000${key}` pair — the same shape
 * `digestBaselineKey` produces, so the two can be mixed in one set. */
const PAIR_SEP = "\u0000";

/**
 * The (locale, key) pairs Shopify actually holds a GLOBAL translation for,
 * restricted to the keys the caller changed.
 *
 * One query PER LOCALE, because `translations(locale:)` takes exactly one and
 * there is no batched form. That is the price of not being blind: the mirror
 * cannot see a translation written in the Shopify admin or by another app, and
 * these resource types have no webhook that would notice later.
 *
 * `marketId` is deliberately omitted, which returns the GLOBAL layer only
 * (CLAUDE.md) — a market override is a separate deliberate value and survives.
 *
 * A locale whose query fails contributes NOTHING rather than throwing: the
 * caller unions this with the local mirror, so a failed read degrades to the
 * old mirror-only reach instead of losing the whole repair. It goes through the
 * GATEWAY, not the raw admin client: this runs inside the merchant's save
 * request, once per published locale, and an unthrottled burst there would
 * answer a rate limit with exactly that silent degradation.
 */
async function foreignTranslationPairs(
  gateway: ShopifyApiGateway,
  resourceId: string,
  foreignLocales: readonly string[],
  changedKeys: readonly string[],
): Promise<Set<string>> {
  const wanted = new Set(changedKeys);
  const pairs = new Set<string>();
  for (const locale of foreignLocales) {
    try {
      const response = await gateway.graphql(
        `#graphql
          query staleTranslationTargets($resourceId: ID!, $locale: String!) {
            translatableResource(resourceId: $resourceId) {
              translations(locale: $locale) {
                key
                locale
              }
            }
          }`,
        { variables: { resourceId, locale } },
      );
      const data = (await response.json()) as {
        data?: {
          translatableResource?: {
            translations?: Array<{ key: string; locale: string }> | null;
          } | null;
        };
        errors?: Array<{ message: string }>;
      };
      if (data.errors?.length) throw new Error(data.errors[0].message);
      for (const row of data.data?.translatableResource?.translations ?? []) {
        // Shopify answers with the requested locale, but trust the row's own —
        // it is what the removal and the register will be addressed by.
        if (wanted.has(row.key)) pairs.add(`${row.locale}${PAIR_SEP}${row.key}`);
      }
    } catch (error: unknown) {
      logger.warn("[StaleTranslations] Could not read translations for a locale — mirror only", {
        context: "StaleTranslations",
        resourceId,
        locale,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return pairs;
}

/**
 * The in-app counterpart of `reconcileStaleTranslations`: the merchant just
 * rewrote a resource's PRIMARY text in this app, and this is the only event
 * that will ever notice for the types above.
 *
 * It does NO detection, and that is the point. The sync-side entry point must
 * prove the primary text moved — it did not author the change and Shopify's
 * `outdated` flag alone says nothing about WHEN. Here the caller performed the
 * write, and `changedKeys` is the list it computed against the baseline the
 * editor loaded from. Running the digest gate over that would only ADD a way to
 * miss: a row whose local mirror carries no digest (a DB-only write, an older
 * cache) would pass no gate, and the translation would then be neither
 * re-translated nor removed — live on the storefront, describing text that no
 * longer exists.
 *
 * AUTO-TRANSLATE ONLY, re-checked here on the policy the caller HANDS IN (never
 * a second read of its own — see `policy`). Without that switch the caller's own
 * purge loop is the repair; running this one as well would send a second
 * `translationsRemove` for rows that are already gone, which echoes nothing back
 * and logs as an unconfirmed removal. The two paths are mutually exclusive at
 * BOTH ends on purpose.
 *
 * BEST-EFFORT: the primary write has already happened, so every failure is
 * logged and swallowed. The merchant's text is saved either way.
 */
export async function reconcileAfterPrimarySave(params: RepairTarget & {
  /**
   * `translatableContent` read back AFTER the primary write — the NEW values
   * and their NEW digests, which is what a re-registration needs. A key Shopify
   * no longer lists (or lists with an empty value) is a CLEARED field: there is
   * nothing to translate, so it falls through to the removal.
   */
  primaryContent: Readonly<Record<string, PrimaryContentEntry>>;
  /** Shopify translation keys whose primary value this save changed. */
  changedKeys: readonly string[];
  /** Published foreign locales — the primary locale never holds a translation row. */
  foreignLocales: readonly string[];
  /**
   * The policy the CALLER already read to decide it was skipping its own purge.
   * Passing it is not an optimisation: a second read fails OPEN to
   * "auto-translate off", which returns NOTHING — and the caller has by then
   * already stood its deletion down, so a transient DB error would leave the
   * resource with neither the purge nor the repair, on a type nothing else
   * notices. One read, one decision.
   */
  policy: TranslationChangePolicy;
}): Promise<ReconcileResult> {
  const { shop, resourceId, resourceType, changedKeys, foreignLocales, primaryContent, policy } =
    params;

  try {
    if (changedKeys.length === 0 || foreignLocales.length === 0) return NOTHING;
    if (!policy.autoTranslateExternalChanges) return NOTHING;

    // Which (locale, key) pairs actually HAVE a translation to repair — the
    // UNION of what Shopify reports and what the local mirror holds, and both
    // halves are load-bearing.
    //
    // Shopify is the one that knows: a translation written in the Shopify admin
    // or by another app has no mirror row here, and the code this path replaces
    // reached it anyway because it removed BLINDLY across every foreign locale.
    // Asking only the mirror would have traded "deleted" for "left live on the
    // storefront" for exactly those rows — the direction this project never
    // errs in, and on types with no webhook to catch it later.
    //
    // The mirror is the fallback: a locale whose read failed answers nothing,
    // and dropping it would silently do less than before. A pair we once wrote
    // is evidence enough to repair it.
    const gateway = new ShopifyApiGateway(params.client, shop);
    const pairs = await foreignTranslationPairs(gateway, resourceId, foreignLocales, changedKeys);
    const { db } = await import("../../db.server");
    const rows = await db.contentTranslation.findMany({
      where: {
        shop,
        resourceId,
        resourceType,
        // GLOBAL layer only — a market override is a deliberate separate value
        // and survives a primary change, the same rule as everywhere else.
        marketId: "",
        key: { in: [...changedKeys] },
        locale: { in: [...foreignLocales] },
      },
      select: { key: true, locale: true },
    });
    for (const row of rows) pairs.add(digestBaselineKey(row.locale, row.key));
    if (pairs.size === 0) return NOTHING;

    const stale: StaleTranslation[] = [];
    for (const pair of pairs) {
      const [locale, key] = pair.split(PAIR_SEP);
      const entry = primaryContent[key];
      const primaryValue = entry?.value ?? "";
      stale.push({
        key,
        locale,
        // The two reasons this module already knows, decided from the value we
        // just wrote: text there ⇒ the translation is out of date, nothing
        // there ⇒ the merchant cleared the field. `partitionStaleTranslations`
        // routes the second one to the removal by itself (no source, no
        // translation), so this is a label rather than a second decision.
        reason: primaryValue.trim() ? "outdated" : "primary-empty",
        primaryValue,
        digest: entry?.digest ?? null,
      });
    }

    logger.info("[StaleTranslations] Primary text changed in the editor — re-translating", {
      context: "StaleTranslations",
      shop,
      resourceId,
      resourceType,
      stale: stale.length,
    });

    return await repairStaleTranslations(params, stale, policy);
  } catch (error: unknown) {
    logger.warn("[StaleTranslations] Post-save re-translation failed — translations kept", {
      context: "StaleTranslations",
      shop,
      resourceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return NOTHING;
  }
}

/**
 * Repair entries ALREADY established as stale: purge them, re-translate them,
 * or both. Both entry points share it, because everything delicate lives here
 * — the in-flight queue, the "did the merchant write while we worked"
 * timestamp, the "a confirmed write is never taken back" rule and the fallback
 * purge for what the AI could not deliver. A second copy of that would drift
 * within one release.
 *
 * What each caller does to ESTABLISH staleness is its own business, and the two
 * differ on purpose: the sync above has to PROVE the primary text moved (digest
 * baseline plus Shopify's `outdated` flag, neither of which it authored), while
 * the in-app save below IS the change event and knows exactly which keys it
 * just rewrote.
 *
 * NOTHING escapes it either — both callers wrap it, and the sync's contract
 * is that a stale row left behind must never fail the save or the webhook.
 */
async function repairStaleTranslations(
  target: RepairTarget,
  stale: readonly StaleTranslation[],
  policy: TranslationChangePolicy,
): Promise<ReconcileResult> {
  const { client, shop, resourceId, resourceType } = target;
  const gateway = new ShopifyApiGateway(client, shop);
  const { retranslate, purge } = partitionStaleTranslations(
    stale,
    policy.autoTranslateExternalChanges,
  );

  // May a stale translation be REMOVED here? Not the same question as the
  // merchant's purge switch, which auto-translate forces off (the two are
  // alternatives — translation-change-policy.server.ts). A shop that asked
  // for "always give it the new text" is asking for the opposite of stale,
  // so whatever the AI cannot deliver — a CLEARED source with nothing to
  // translate, a `handle`, a provider error — is removed rather than left
  // describing text that no longer exists. Only with BOTH switches off does
  // nothing get touched, and that case never reaches this line.
  const mayPurge = policy.purgeOnPrimaryChange || policy.autoTranslateExternalChanges;

  // The INLINE purge runs FIRST: one GraphQL call, so the storefront is
  // corrected immediately — and its `markTranslationSaved` then lands BEFORE
  // the detached run captures its baseline below. The other order made the
  // run read our own mark as "the merchant saved" and abandon itself.
  let removed = 0;
  if (mayPurge && purge.length > 0) {
    removed = await purgeStaleEntries(gateway, shop, resourceId, resourceType, purge);
    // Protect what we just changed from a racing webhook sync that re-fetches
    // Shopify before it is consistent again.
    markTranslationSaved(resourceId);
  }

  // The AI re-translation is DETACHED. Two of the callers (the single-item
  // reload routes) await this sync inside an HTTP request, and one AI request
  // per locale does not fit in a request the browser abandons after 30
  // seconds. It is Task-tracked, so nothing is lost by not waiting.
  const inFlightKey = `${shop}${IN_FLIGHT_SEP}${resourceId}`;
  const startRetranslation = retranslate.length > 0;
  if (startRetranslation) {
    const runWork = async () => {
      // "Has someone written since I started?" — a TIMESTAMP, not the
      // boolean, and captured HERE rather than at spawn. The boolean cannot
      // tell a merchant save from this module's own mark (the purge above
      // marks the resource, and so does a finishing run), and a snapshot
      // taken at spawn is already minutes stale for a run that was QUEUED
      // behind another — the run it waited for marks the resource on its way
      // out, and the queued one then abandons itself before touching a
      // single locale. Its entries end up in neither list, so nothing
      // re-translates and nothing removes them, permanently, because the
      // sync has already advanced their digest baseline.
      const savedAtStart = translationSavedAt(resourceId);
      const supersededByMerchant = () => {
        const now = translationSavedAt(resourceId);
        return now !== null && now !== savedAtStart;
      };
      try {
        const outcome = await retranslateStaleEntries(
          gateway,
          target,
          retranslate,
          supersededByMerchant,
        );
        // Entries the AI path could not deliver still have to lose their
        // stale translation — a failed automation must never leave the old
        // text on the storefront. UNLESS the merchant edited this resource's
        // translations while the AI was working: the run took minutes, their
        // hand-written value is newer than everything decided here, and
        // deleting it would be the one unrecoverable outcome. The next change
        // event repairs whatever is genuinely still stale.
        if (
          mayPurge &&
          !outcome.startFailed &&
          outcome.failed.length > 0 &&
          !supersededByMerchant()
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
      }
    };

    // A run already going for this resource is WAITED FOR, never a reason to
    // drop this one: these entries were detected against a baseline this sync
    // has already overwritten, so discarding them loses them for good. Two
    // admin edits a minute apart are exactly that case. The several webhooks
    // of ONE save never reach here — by then the digests match and
    // `retranslate` is empty.
    const previous = retranslationsInFlight.get(inFlightKey);
    const run: Promise<void> = (previous ? previous.then(runWork, runWork) : runWork()).finally(
      () => {
        if (retranslationsInFlight.get(inFlightKey) === run) {
          retranslationsInFlight.delete(inFlightKey);
        }
      },
    );
    retranslationsInFlight.set(inFlightKey, run);
    void run;
  }

  if (removed > 0 || startRetranslation) {
    logger.info("[StaleTranslations] Reconciled", {
      context: "StaleTranslations",
      shop,
      resourceId,
      removed,
      retranslating: startRetranslation ? retranslate.length : 0,
    });
  }

  return { removed, retranslating: startRetranslation ? retranslate.length : 0 };
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
  /** Entries the AI could not deliver — they must still be purged. */
  failed: StaleTranslation[];
  /**
   * The run could not START (a DB error on the settings read or the Task row).
   * NOT the same as "the AI failed": the entries are untouched and the fallback
   * purge must be skipped — see the wrapper.
   */
  startFailed?: boolean;
}

/**
 * Re-translate the NEW primary values into every affected locale and register
 * them, Task-tracked so the run shows up in the Tasks tab like every other AI
 * operation. One AI request per locale (the same granularity the editor's
 * "translate all fields" uses).
 *
 * NOTHING may escape this function. Its SETUP — the dynamic imports, the AI
 * settings read, creating the Task row — sits outside the inner try, and a
 * throw there used to travel up as an unhandled run failure.
 *
 * It comes back as `startFailed`, deliberately NOT as `failed`. The realistic
 * trigger is a DATABASE error (`task.create`), and answering it with the purge
 * would remove the translations on Shopify while the local mirror delete fails
 * for the very same reason — storefront content gone because our own database
 * blinked, which is the exact rule the mirror-write below is built on, in
 * reverse. A stale text left standing is visible and repairable on the next
 * change event; a deleted one is neither.
 */
async function retranslateStaleEntries(
  gateway: ShopifyApiGateway,
  params: RepairTarget,
  entries: readonly StaleTranslation[],
  /** "Did a save land after this run started?" — see the caller. */
  supersededByMerchant: () => boolean,
): Promise<RetranslateOutcome> {
  try {
    return await runRetranslation(gateway, params, entries, supersededByMerchant);
  } catch (error: unknown) {
    logger.warn("[StaleTranslations] Re-translation could not start — stale rows kept", {
      context: "StaleTranslations",
      shop: params.shop,
      resourceId: params.resourceId,
      entries: entries.length,
      error: error instanceof Error ? error.message : String(error),
    });
    return { registered: [], failed: [], startFailed: true };
  }
}

async function runRetranslation(
  gateway: ShopifyApiGateway,
  params: RepairTarget,
  entries: readonly StaleTranslation[],
  supersededByMerchant: () => boolean,
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
      if (supersededByMerchant()) {
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
