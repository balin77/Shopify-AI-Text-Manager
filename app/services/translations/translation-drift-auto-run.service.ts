/**
 * The periodic sweep that stands in for the webhook Shopify does not send.
 *
 * Sibling of `SeoAuditAutoRunService` and `SeoCrawlAutoRunService`, and the tick
 * semantics are deliberately identical to theirs — hourly ticks so a restart
 * cannot make a shop miss its window, entitlement AND consent filtered IN THE
 * QUERY, a backoff STAMP written on every path (an unstamped shop wins the due
 * query forever), a per-tick cap, longest-waiting first with nulls first
 * (Postgres sorts NULLS LAST and would otherwise starve a shop that has never
 * been swept).
 *
 * What is different, and why:
 *
 * - CONSENT IS THE FEATURE'S OWN SWITCH, not a new one. `autoTranslateExternal-
 *   Changes` is exactly the merchant's answer to "notice when a text changes
 *   outside the app and do something about it", and this sweep is how that
 *   promise reaches the four types with no webhook. A second checkbox for the
 *   same decision would only be a way for the two to disagree.
 *
 * - THE PLAN GATE IS THE FEATURE'S OWN (`AUTO_TRANSLATE_MIN_PLAN`), ANDed with
 *   the switch, because the column survives a downgrade by design and every
 *   read of it is supposed to re-check the plan.
 *
 * - DAILY rather than weekly. The sweep reads digests the shop already has and
 *   only pays a Shopify round trip for types the shop actually translated, so
 *   it is far cheaper than the crawl; and a translation describing text that no
 *   longer exists is live on the storefront the whole time it goes unnoticed.
 *
 * What it deliberately does NOT do: decide anything. It hands each changed
 * resource to `reconcileStaleTranslations`, the same function a real webhook
 * reaches, and every rule about purging, re-translating, declining, the digest
 * gate and the market layer stays there.
 */

import { db } from "../../db.server";
import { createAdminClientFromShop } from "../../utils/admin-client.server";
import { logger } from "../../utils/logger.server";
import { meetsPlan } from "../../utils/planUtils";
import type { Plan } from "../../config/plans";
import { PLAN_CONFIG } from "../../config/plans";
import { AUTO_TRANSLATE_MIN_PLAN } from "./translation-change-policy.shared";

/** Disable the whole sweep without a redeploy. */
const SWEEP_DISABLED = process.env.TRANSLATION_DRIFT_SCAN_DISABLED === "true";

/** How often the sweep looks for due shops. Default 1h. */
const TICK_INTERVAL_MS = parseInt(
  process.env.TRANSLATION_DRIFT_SCAN_INTERVAL_MS || String(60 * 60 * 1000),
  10,
);

/** A shop becomes due again this long after its last sweep. Default 24h. */
const DUE_AFTER_MS = parseInt(
  process.env.TRANSLATION_DRIFT_SCAN_DUE_MS || String(24 * 60 * 60 * 1000),
  10,
);

/**
 * Shops swept per tick. Each sweep is a handful of paged queries plus, for the
 * few resources that really moved, a reconciliation that may start a detached
 * AI run — so this is a concurrency limit on those runs, not a batch size.
 */
const MAX_SHOPS_PER_TICK = Math.max(
  1,
  parseInt(process.env.TRANSLATION_DRIFT_SCAN_BATCH_SIZE || "5", 10),
);

/** Plans entitled to the auto-translation — derived, never hardcoded. */
const ENTITLED_PLANS: Plan[] = (Object.keys(PLAN_CONFIG) as Plan[]).filter((plan) =>
  meetsPlan(plan, AUTO_TRANSLATE_MIN_PLAN),
);

export interface TranslationDriftTickStats {
  candidates: number;
  /** Resources handed to the reconciliation across every shop in this tick. */
  handed: number;
  errored: number;
  /** Sweeps that could not establish silence for at least one type — a failed
   *  query, a truncated baseline or a paging ceiling. Carried out of the scan
   *  so "0 handed" is never read as "0 changed". */
  incomplete: number;
}

export class TranslationDriftAutoRunService {
  private static instance: TranslationDriftAutoRunService;
  private intervalId: NodeJS.Timeout | null = null;
  private isRunning = false;

  private constructor() {}

  static getInstance(): TranslationDriftAutoRunService {
    if (!TranslationDriftAutoRunService.instance) {
      TranslationDriftAutoRunService.instance = new TranslationDriftAutoRunService();
    }
    return TranslationDriftAutoRunService.instance;
  }

  /**
   * Start the sweep. Runs once immediately, then on TICK_INTERVAL_MS.
   * Idempotent — safe to call from every authenticated request.
   */
  start(): void {
    if (this.isRunning) return;
    if (SWEEP_DISABLED) {
      logger.info("[TranslationDrift] Disabled via TRANSLATION_DRIFT_SCAN_DISABLED - not starting");
      return;
    }
    if (ENTITLED_PLANS.length === 0) {
      logger.info("[TranslationDrift] No plan grants auto-translation - not starting");
      return;
    }

    this.isRunning = true;
    logger.info(
      `[TranslationDrift] Starting sweep (every ${Math.round(TICK_INTERVAL_MS / 60000)}min, ` +
        `due after ${Math.round(DUE_AFTER_MS / 3600000)}h, batch ${MAX_SHOPS_PER_TICK})`,
    );

    this.tick().catch((err) =>
      logger.error("[TranslationDrift] Unhandled error in initial tick", {
        error: err instanceof Error ? err.message : String(err),
      }),
    );

    this.intervalId = setInterval(() => {
      this.tick().catch((err) =>
        logger.error("[TranslationDrift] Unhandled error in scheduled tick", {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }, TICK_INTERVAL_MS);
  }

  /** Stop the sweep. */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.isRunning = false;
    logger.info("[TranslationDrift] Stopped");
  }

  /** One sweep over the due shops. Public so tests can drive it directly. */
  async tick(now: Date = new Date()): Promise<TranslationDriftTickStats> {
    const stats: TranslationDriftTickStats = { candidates: 0, handed: 0, errored: 0, incomplete: 0 };

    const shops = await this.findDueShops(now);
    stats.candidates = shops.length;
    if (shops.length === 0) return stats;

    const { scanTranslationDrift } = await import("./translation-drift-scan.server");
    const { getCachedShopLocales } = await import("../../utils/shop-locales-cache.server");
    const { ShopifyApiGateway } = await import("../shopify-api-gateway.service");

    for (const settings of shops) {
      // The stamp is a BACKOFF, and skipping it is how a shop gets retried on
      // the next tick instead of in 24 hours. Only ONE case earns that: a
      // locale lookup that failed, where the sweep never ran at all. Every
      // other path stamps, including a failure — an unstamped shop wins the due
      // query forever and would be swept on every tick.
      let stampThisShop = true;
      try {
        const admin = await createAdminClientFromShop(settings.shop);
        // CLAUDE.md's rule is "never gate on a failed lookup, and do not catch
        // around it — it re-throws 401 so the request can re-authenticate".
        // Here there is no request to re-authenticate: this is a background
        // tick, and an uncaught throw would only cost the whole shop's sweep.
        // So it is caught AND the shop is left unstamped, which is the only
        // thing that actually makes it "try again next tick": an empty locale
        // list would otherwise be indistinguishable from a single-language shop
        // and the sweep would report a clean no-op for a whole day.
        let localeLookupFailed = false;
        const locales = await getCachedShopLocales(admin as never, settings.shop).catch(() => {
          localeLookupFailed = true;
          return [];
        });
        if (localeLookupFailed) {
          stats.errored++;
          stampThisShop = false;
          logger.warn(`[TranslationDrift] Locale lookup failed for ${settings.shop} - not stamping`, {
            context: "TranslationDrift",
          });
          continue;
        }
        const foreignLocales = locales
          .filter((l: { published: boolean; primary: boolean }) => l.published && !l.primary)
          .map((l: { locale: string }) => l.locale);

        const result = await scanTranslationDrift({
          gateway: new ShopifyApiGateway(admin as never, settings.shop),
          shop: settings.shop,
          foreignLocales,
        });
        stats.handed += result.handed;
        if (result.failedTypes.length > 0 || result.truncatedTypes.length > 0) {
          stats.incomplete++;
          logger.warn(`[TranslationDrift] Sweep incomplete for ${settings.shop}`, {
            context: "TranslationDrift",
            failedTypes: result.failedTypes,
            truncatedTypes: result.truncatedTypes,
          });
        }
      } catch (err) {
        stats.errored++;
        logger.warn(`[TranslationDrift] Sweep failed for ${settings.shop}`, {
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        if (stampThisShop) await this.stamp(settings.shop, now);
      }
    }

    logger.info(
      `[TranslationDrift] Tick done: ${stats.candidates} shop(s), ${stats.handed} resource(s) ` +
        `reconciled, ${stats.incomplete} incomplete, ${stats.errored} errored`,
    );
    return stats;
  }

  /**
   * Shops entitled to the auto-translation, with the switch on, whose last
   * sweep is missing or older than the due window — longest-waiting first.
   */
  private async findDueShops(now: Date) {
    const dueBefore = new Date(now.getTime() - DUE_AFTER_MS);
    return db.aISettings.findMany({
      where: {
        subscriptionPlan: { in: ENTITLED_PLANS },
        // Entitlement AND consent, both in the query: the column survives a
        // downgrade by design, so neither half may be assumed from the other.
        autoTranslateExternalChanges: true,
        OR: [{ lastTranslationScanAt: null }, { lastTranslationScanAt: { lt: dueBefore } }],
      },
      select: { shop: true, lastTranslationScanAt: true },
      // Nulls first: a shop never swept is the longest waiting.
      orderBy: { lastTranslationScanAt: { sort: "asc", nulls: "first" } },
      take: MAX_SHOPS_PER_TICK,
    });
  }

  /** Backoff stamp — never a lock. A failed write must not abort the sweep. */
  private async stamp(shop: string, now: Date): Promise<void> {
    await db.aISettings
      .update({ where: { shop }, data: { lastTranslationScanAt: now } })
      .catch(() => {});
  }
}
