/**
 * Initial Full Sync Service
 *
 * The single source of truth for the full 7-phase content sync
 * (products+translations, collections, articles, pages, policies, themes,
 * metaobjects). Extracted from the former browser-driven SSE route so that
 * BOTH the onboarding path and the Settings force-re-sync run server-side via
 * the sync scheduler — no open browser connection required, survives tab close.
 *
 * On full success this sets `ShopInstallState.initialSyncCompletedAt` (the
 * marker onboarding + the products gate key off) and clears the progress /
 * force-request fields. An aborted run (AbortError) does NOT set the marker —
 * the safe state, so the scheduler simply finishes it on a later cycle.
 */

import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import { db } from "../db.server";
import { getPlanLimits, type Plan } from "../utils/planUtils";
import { ProductSyncService } from "./product-sync.service";
import { ContentSyncService } from "./content-sync.service";
import { BackgroundSyncService } from "./background-sync.service";
import { logger } from "~/utils/logger.server";
import { getTranslation, DEFAULT_LOCALE, type Locale } from "~/i18n";

export interface InitialSyncProgress {
  phase: string;
  overallPercent: number;
  message: string;
  detailCurrent?: number;
  detailTotal?: number;
  detailMessage?: string;
  stats: Record<string, number>;
}

export interface RunInitialFullSyncOptions {
  /** Force a clean re-pull (deletes existing products+children first). */
  force?: boolean;
  /** Aborts the run cleanly (scheduler stop / uninstall). */
  signal?: AbortSignal;
  /** Progress callback — drives the persisted progress / banner. */
  onProgress?: (p: InitialSyncProgress) => void;
}

/**
 * Runs the full initial sync for a shop. Resolves `{ stats, completed:true }`
 * once all phases finished and the marker was set. Throws AbortError if the
 * signal aborts (marker left unset on purpose). Other phase errors are
 * swallowed per-phase (reported via onProgress message) so one failing phase
 * does not abort the whole onboarding.
 */
export async function runInitialFullSync(
  admin: AdminApiContext,
  shop: string,
  opts: RunInitialFullSyncOptions = {},
): Promise<{ stats: Record<string, number>; completed: boolean }> {
  const { force = false, signal, onProgress } = opts;

  const assertNotAborted = () => {
    if (signal?.aborted) {
      throw new DOMException("Client disconnected", "AbortError");
    }
  };

  const stats = {
    products: 0,
    collections: 0,
    articles: 0,
    pages: 0,
    policies: 0,
    themes: 0,
    metaobjects: 0,
  };

  const emit = (
    phase: string,
    overallPercent: number,
    message: string,
    detail?: { detailCurrent?: number; detailTotal?: number; detailMessage?: string },
  ) => {
    onProgress?.({
      phase,
      overallPercent,
      message,
      detailCurrent: detail?.detailCurrent,
      detailTotal: detail?.detailTotal,
      detailMessage: detail?.detailMessage,
      stats: { ...stats },
    });
  };

  // Plan limits + localized error messages (identical to the old SSE route).
  const settings = await db.aISettings.findUnique({ where: { shop } });
  const plan = (settings?.subscriptionPlan || "free") as Plan;
  const planLimits = getPlanLimits(plan);
  const appLocale = (settings?.appLanguage || DEFAULT_LOCALE) as Locale;
  const t = getTranslation(appLocale);

  /** Map a sync phase to its translated outage-protection message */
  const syncEmptyResponseKey: Record<string, keyof typeof t.errors> = {
    collections: 'syncEmptyResponseCollections',
    articles: 'syncEmptyResponseArticles',
    pages: 'syncEmptyResponsePages',
    policies: 'syncEmptyResponsePolicies',
    themes: 'syncEmptyResponseThemes',
    metaobjects: 'syncEmptyResponseMetaobjects' as any,
  };

  function getSyncErrorMessage(phase: string, err: unknown): string {
    const msg = (err instanceof Error ? err.message : String(err)) || '';
    if (msg.includes('aborting to prevent data loss')) {
      return t.errors[syncEmptyResponseKey[phase]] || t.errors.syncApiError;
    }
    if (msg.includes('API error')) {
      return t.errors.syncApiError;
    }
    return t.errors.syncFailed
      .replace('{phase}', phase.charAt(0).toUpperCase() + phase.slice(1))
      .replace('{details}', msg);
  }

  // ==========================================
  // PHASE 1: Sync Products
  // ==========================================
  assertNotAborted();
  emit('products', 0, 'Checking existing products...');

  // Gate the products+translations phase on the explicit "initial full sync
  // completed" marker — NOT on db.product.count. A Remix prefetch of the
  // products loader populates db.product before this runs, so a count-based
  // gate would skip the only bulk-translation fetch forever.
  if (!force) {
    const installState = await db.shopInstallState.findUnique({
      where: { shop },
      select: { initialSyncCompletedAt: true },
    });
    if (installState?.initialSyncCompletedAt) {
      emit('products', 100, 'Initial sync already completed, skipping products...');
      stats.products = 0;
    } else {
      const productSyncService = new ProductSyncService(admin, shop);
      stats.products = await productSyncService.syncAllProducts({
        maxProducts: planLimits.maxProducts === Infinity ? 10000 : planLimits.maxProducts,
        cacheProductImages: planLimits.cacheEnabled.productImages,
        signal,
        onProgress: (info) => {
          assertNotAborted();
          emit('products', info.overallPercent, 'Syncing products...', {
            detailCurrent: info.detailCurrent,
            detailTotal: info.detailTotal,
            detailMessage: info.message,
          });
        },
      });
    }
  } else {
    // Force re-sync: delete existing products first
    emit('products', 0, 'Deleting existing products for re-sync...');

    const existingProducts = await db.product.findMany({
      where: { shop },
      select: { id: true },
    });

    if (existingProducts.length > 0) {
      const productIds = existingProducts.map(p => p.id);
      await db.$transaction([
        db.contentTranslation.deleteMany({
          where: { resourceId: { in: productIds }, resourceType: "Product" },
        }),
        db.productImage.deleteMany({
          where: { productId: { in: productIds } },
        }),
        db.productOption.deleteMany({
          where: { productId: { in: productIds } },
        }),
        db.productMetafield.deleteMany({
          where: { productId: { in: productIds } },
        }),
        db.product.deleteMany({
          where: { shop },
        }),
      ]);
    }

    assertNotAborted();
    const productSyncService = new ProductSyncService(admin, shop);
    stats.products = await productSyncService.syncAllProducts({
      maxProducts: planLimits.maxProducts === Infinity ? 10000 : planLimits.maxProducts,
      cacheProductImages: planLimits.cacheEnabled.productImages,
      signal,
      onProgress: (info) => {
        assertNotAborted();
        emit('products', info.overallPercent, 'Syncing products...', {
          detailCurrent: info.detailCurrent,
          detailTotal: info.detailTotal,
          detailMessage: info.message,
        });
      },
    });
  }

  // ==========================================
  // PHASE 2: Sync Collections
  // ==========================================
  assertNotAborted();
  emit('collections', 0, 'Syncing collections...');
  try {
    const syncService = new ContentSyncService(admin, shop);
    stats.collections = await syncService.syncAllCollections(planLimits.maxCollections, (current, total, message) => {
      assertNotAborted();
      emit('collections', total > 0 ? Math.round((current / total) * 100) : 0, 'Syncing collections...', {
        detailCurrent: current, detailTotal: total, detailMessage: message,
      });
    });
    emit('collections', 100, `Synced ${stats.collections} collections`);
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") throw err;
    emit('collections', 100, getSyncErrorMessage('collections', err));
  }

  // ==========================================
  // PHASE 3: Sync Articles
  // ==========================================
  assertNotAborted();
  emit('articles', 0, 'Syncing articles...');
  try {
    const syncService = new ContentSyncService(admin, shop);
    stats.articles = await syncService.syncAllArticles(planLimits.maxArticles, (current, total, message) => {
      assertNotAborted();
      emit('articles', total > 0 ? Math.round((current / total) * 100) : 0, 'Syncing articles...', {
        detailCurrent: current, detailTotal: total, detailMessage: message,
      });
    });
    emit('articles', 100, `Synced ${stats.articles} articles`);
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") throw err;
    emit('articles', 100, getSyncErrorMessage('articles', err));
  }

  // ==========================================
  // PHASE 4: Sync Pages
  // ==========================================
  assertNotAborted();
  emit('pages', 0, 'Syncing pages...');
  try {
    const bgSyncService = new BackgroundSyncService(admin, shop);
    stats.pages = await bgSyncService.syncAllPages(planLimits.maxPages, (current, total, message) => {
      assertNotAborted();
      emit('pages', total > 0 ? Math.round((current / total) * 100) : 0, 'Syncing pages...', {
        detailCurrent: current, detailTotal: total, detailMessage: message,
      });
    });
    emit('pages', 100, `Synced ${stats.pages} pages`);
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") throw err;
    emit('pages', 100, getSyncErrorMessage('pages', err));
  }

  // ==========================================
  // PHASE 5: Sync Policies
  // ==========================================
  assertNotAborted();
  emit('policies', 0, 'Syncing policies...');
  try {
    const bgSyncService = new BackgroundSyncService(admin, shop);
    stats.policies = await bgSyncService.syncAllPolicies((current, total, message) => {
      assertNotAborted();
      emit('policies', total > 0 ? Math.round((current / total) * 100) : 0, 'Syncing policies...', {
        detailCurrent: current, detailTotal: total, detailMessage: message,
      });
    });
    emit('policies', 100, `Synced ${stats.policies} policies`);
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") throw err;
    emit('policies', 100, getSyncErrorMessage('policies', err));
  }

  // ==========================================
  // PHASE 6: Sync Themes
  // ==========================================
  assertNotAborted();
  emit('themes', 0, 'Syncing themes...');
  try {
    const bgSyncService = new BackgroundSyncService(admin, shop);
    stats.themes = await bgSyncService.syncAllThemes((current, total, message) => {
      assertNotAborted();
      emit('themes', current, 'Syncing themes...', {
        detailCurrent: current, detailTotal: total, detailMessage: message,
      });
    });
    emit('themes', 100, `Synced ${stats.themes} themes`);
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") throw err;
    emit('themes', 100, getSyncErrorMessage('themes', err));
  }

  // ==========================================
  // PHASE 7: Sync Metaobjects
  // ==========================================
  assertNotAborted();
  emit('metaobjects', 0, 'Syncing metaobjects...');
  try {
    const { MetaobjectSyncService } = await import("./metaobject-sync.service");
    const metaobjectSync = new MetaobjectSyncService(admin, shop);
    const metaResult = await metaobjectSync.syncAll((current, total, message) => {
      assertNotAborted();
      emit('metaobjects', total > 0 ? Math.round((current / total) * 100) : 0, 'Syncing metaobjects...', {
        detailCurrent: current, detailTotal: total, detailMessage: message,
      });
    });
    stats.metaobjects = metaResult.metaobjects;
    emit('metaobjects', 100, `Synced ${metaResult.definitions} definitions, ${metaResult.metaobjects} metaobjects`);
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") throw err;
    emit('metaobjects', 100, getSyncErrorMessage('metaobjects', err));
  }

  // ==========================================
  // COMPLETE — set the marker, clear progress + force-request.
  // ==========================================
  // Set ONLY here, after a fully successful run. An abort throws AbortError
  // before reaching this point, leaving the marker unset (the safe state →
  // scheduler finishes it next cycle).
  try {
    await db.shopInstallState.upsert({
      where: { shop },
      create: { shop, initialSyncCompletedAt: new Date() },
      update: {
        initialSyncCompletedAt: new Date(),
        initialSyncPhase: null,
        initialSyncPercent: 100,
        initialSyncError: null,
        initialSyncForceRequested: false,
      },
    });
  } catch (e) {
    logger.warn("[INITIAL-SYNC] Failed to set initialSyncCompletedAt", {
      shop, error: e instanceof Error ? e.message : String(e),
    });
  }

  emit('done', 100, 'Sync complete!');
  return { stats, completed: true };
}
