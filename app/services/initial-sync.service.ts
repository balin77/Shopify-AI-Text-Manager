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

import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { Prisma } from "@prisma/client";
import { db } from "../db.server";
import { getPlanLimits, getSyncScope, canAccessContentType, type Plan } from "../utils/planUtils";
import { ProductSyncService } from "./product-sync.service";
import { ContentSyncService } from "./content-sync.service";
import { BackgroundSyncService } from "./background-sync.service";
import { logger } from "~/utils/logger.server";
import type { SyncPhase, SyncPhaseMarker } from "./sync-phases.shared";
import { getTranslation, DEFAULT_LOCALE, type Locale } from "~/i18n";

export interface InitialSyncProgress {
  phase: SyncPhase | SyncPhaseMarker;
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
    menus: 0,
    system: 0,
    delivery: 0,
    onlineStoreExtras: 0,
    sellingPlans: 0,
    cookieBanner: 0,
  };

  // Track per-phase failures. A swallowed (non-abort) phase error must NOT
  // count as a successful onboarding: if any ENABLED phase failed we leave
  // initialSyncCompletedAt unset so the scheduler retries on the next cycle
  // (otherwise e.g. a transient collections error would mark setup "done" and
  // pre-existing collections — which have no create/update webhook — would
  // stay permanently uncached).
  let phaseFailed = false;
  let firstPhaseError: string | null = null;
  const recordPhaseFailure = (phase: string, err: unknown): string => {
    const msg = getSyncErrorMessage(phase, err);
    phaseFailed = true;
    if (!firstPhaseError) firstPhaseError = msg;
    return msg;
  };

  // Typed against the shared phase list: a new phase must be registered in
  // sync-phases.shared.ts, otherwise the nav banner cannot place it and its
  // total collapses to the phase's own percent (how `onlineStoreExtras` came
  // to report a stuck 0% on an upgrade re-sync).
  const emit = (
    phase: SyncPhase | SyncPhaseMarker,
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
  // Single source of truth for which phases this plan may sync. A disabled
  // phase is skipped (not fetched) — pruning already-cached, now-disallowed
  // data stays the job of planCacheCleanup (downgrade path), never this sync.
  const scope = getSyncScope(plan);
  const appLocale = (settings?.appLanguage || DEFAULT_LOCALE) as Locale;
  const t = getTranslation(appLocale);

  /** Map a sync phase to its translated outage-protection message */
  const syncEmptyResponseKey: Record<string, keyof typeof t.errors> = {
    collections: 'syncEmptyResponseCollections',
    articles: 'syncEmptyResponseArticles',
    pages: 'syncEmptyResponsePages',
    policies: 'syncEmptyResponsePolicies',
    themes: 'syncEmptyResponseThemes',
    metaobjects: 'syncEmptyResponseMetaobjects',
    menus: 'syncEmptyResponseMenus',
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
        maxProducts: scope.products.max ?? planLimits.maxProducts,
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
  if (!scope.collections.enabled) {
    emit('collections', 100, 'Collections not included in this plan, skipping...');
  } else {
    emit('collections', 0, 'Syncing collections...');
    try {
      const syncService = new ContentSyncService(admin, shop);
      stats.collections = await syncService.syncAllCollections(scope.collections.max, (current, total, message) => {
        assertNotAborted();
        emit('collections', total > 0 ? Math.round((current / total) * 100) : 0, 'Syncing collections...', {
          detailCurrent: current, detailTotal: total, detailMessage: message,
        });
      });
      emit('collections', 100, `Synced ${stats.collections} collections`);
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") throw err;
      emit('collections', 100, recordPhaseFailure('collections', err));
    }
  }

  // ==========================================
  // PHASE 3: Sync Articles
  // ==========================================
  assertNotAborted();
  if (!scope.articles.enabled) {
    emit('articles', 100, 'Articles not included in this plan, skipping...');
  } else {
    emit('articles', 0, 'Syncing articles...');
    try {
      const syncService = new ContentSyncService(admin, shop);
      stats.articles = await syncService.syncAllArticles(scope.articles.max, (current, total, message) => {
        assertNotAborted();
        emit('articles', total > 0 ? Math.round((current / total) * 100) : 0, 'Syncing articles...', {
          detailCurrent: current, detailTotal: total, detailMessage: message,
        });
      });
      emit('articles', 100, `Synced ${stats.articles} articles`);
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") throw err;
      emit('articles', 100, recordPhaseFailure('articles', err));
    }
  }

  // ==========================================
  // PHASE 4: Sync Pages
  // ==========================================
  assertNotAborted();
  if (!scope.pages.enabled) {
    emit('pages', 100, 'Pages not included in this plan, skipping...');
  } else {
    emit('pages', 0, 'Syncing pages...');
    try {
      const bgSyncService = new BackgroundSyncService(admin, shop);
      stats.pages = await bgSyncService.syncAllPages(scope.pages.max, (current, total, message) => {
        assertNotAborted();
        emit('pages', total > 0 ? Math.round((current / total) * 100) : 0, 'Syncing pages...', {
          detailCurrent: current, detailTotal: total, detailMessage: message,
        });
      });
      emit('pages', 100, `Synced ${stats.pages} pages`);
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") throw err;
      emit('pages', 100, recordPhaseFailure('pages', err));
    }
  }

  // ==========================================
  // PHASE 5: Sync Policies
  // ==========================================
  assertNotAborted();
  if (!scope.policies.enabled) {
    emit('policies', 100, 'Policies not included in this plan, skipping...');
  } else {
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
      emit('policies', 100, recordPhaseFailure('policies', err));
    }
  }

  // ==========================================
  // PHASE 6: Sync Themes
  // ==========================================
  assertNotAborted();
  if (!scope.themes.enabled) {
    emit('themes', 100, 'Themes not included in this plan, skipping...');
  } else {
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
      emit('themes', 100, recordPhaseFailure('themes', err));
    }
  }

  // ==========================================
  // PHASE 6b: Sync System content (notifications, payment, packing).
  // Pro+ entitlement — gated directly off the entitlement source so it can't
  // drift from canAccessContentType. (Delivery is a separate Basic+ phase below.)
  // ==========================================
  assertNotAborted();
  if (!canAccessContentType(plan, 'system')) {
    emit('system', 100, 'System content not included in this plan, skipping...');
  } else {
    emit('system', 0, 'Syncing system content...');
    try {
      const bgSyncService = new BackgroundSyncService(admin, shop);
      stats.system = await bgSyncService.syncSystemContent((current, total, message) => {
        assertNotAborted();
        emit('system', current, 'Syncing system content...', {
          detailCurrent: current, detailTotal: total, detailMessage: message,
        });
      });
      emit('system', 100, `Synced ${stats.system} system groups`);
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") throw err;
      emit('system', 100, recordPhaseFailure('system', err));
    }
  }

  // ==========================================
  // PHASE 6b2: Sync Delivery (checkout shipping method names). Entitled Basic+.
  // ==========================================
  assertNotAborted();
  if (!canAccessContentType(plan, 'delivery')) {
    emit('delivery', 100, 'Delivery content not included in this plan, skipping...');
  } else {
    emit('delivery', 0, 'Syncing delivery content...');
    try {
      const bgSyncService = new BackgroundSyncService(admin, shop);
      stats.delivery = await bgSyncService.syncDeliveryContent((current, total, message) => {
        assertNotAborted();
        emit('delivery', current, 'Syncing delivery content...', {
          detailCurrent: current, detailTotal: total, detailMessage: message,
        });
      });
      emit('delivery', 100, `Synced ${stats.delivery} delivery groups`);
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") throw err;
      emit('delivery', 100, recordPhaseFailure('delivery', err));
    }
  }

  // ==========================================
  // PHASE 6c: Sync Online-Store extras (Filter + Shop-Metadaten).
  // Entitled on EVERY tier (small + high value).
  // ==========================================
  assertNotAborted();
  {
    emit('onlineStoreExtras', 0, 'Syncing online-store extras...');
    try {
      const bgSyncService = new BackgroundSyncService(admin, shop);
      stats.onlineStoreExtras = await bgSyncService.syncOnlineStoreExtras((current, total, message) => {
        assertNotAborted();
        emit('onlineStoreExtras', current, 'Syncing online-store extras...', {
          detailCurrent: current, detailTotal: total, detailMessage: message,
        });
      });
      emit('onlineStoreExtras', 100, `Synced ${stats.onlineStoreExtras} extras groups`);
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") throw err;
      emit('onlineStoreExtras', 100, recordPhaseFailure('onlineStoreExtras', err));
    }
  }

  // ==========================================
  // PHASE 6c2: Sync Cookie-Banner (Online-Store rubric, every tier).
  // Mirrors the onlineStoreExtras entitlement and degrades silently when the
  // unstable endpoint is unreachable — no Coming-Soon UI needed; the rubric
  // simply renders an empty list (handled by ThemeContentDomainPage).
  // ==========================================
  assertNotAborted();
  {
    emit('cookieBanner', 0, 'Syncing cookie banner...');
    try {
      const bgSyncService = new BackgroundSyncService(admin, shop);
      stats.cookieBanner = await bgSyncService.syncCookieBanner((current, total, message) => {
        assertNotAborted();
        emit('cookieBanner', current, 'Syncing cookie banner...', {
          detailCurrent: current, detailTotal: total, detailMessage: message,
        });
      });
      emit('cookieBanner', 100, `Synced ${stats.cookieBanner} cookie-banner groups`);
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") throw err;
      emit('cookieBanner', 100, recordPhaseFailure('cookieBanner', err));
    }
  }

  // ==========================================
  // PHASE 6d: Sync Selling Plans (subscriptions). Pro+ entitlement — gated
  // directly off the entitlement source so it can't drift from
  // canAccessContentType. Empty on shops without subscriptions.
  // ==========================================
  assertNotAborted();
  if (!canAccessContentType(plan, 'sellingPlans')) {
    emit('sellingPlans', 100, 'Selling plans not included in this plan, skipping...');
  } else {
    emit('sellingPlans', 0, 'Syncing selling plans...');
    try {
      const bgSyncService = new BackgroundSyncService(admin, shop);
      stats.sellingPlans = await bgSyncService.syncSellingPlans((current, total, message) => {
        assertNotAborted();
        emit('sellingPlans', current, 'Syncing selling plans...', {
          detailCurrent: current, detailTotal: total, detailMessage: message,
        });
      });
      emit('sellingPlans', 100, `Synced ${stats.sellingPlans} selling-plan groups`);
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") throw err;
      emit('sellingPlans', 100, recordPhaseFailure('sellingPlans', err));
    }
  }

  // ==========================================
  // PHASE 7: Sync Metaobjects
  // ==========================================
  assertNotAborted();
  if (!scope.metaobjects.enabled) {
    emit('metaobjects', 100, 'Metaobjects not included in this plan, skipping...');
  } else {
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
      emit('metaobjects', 100, recordPhaseFailure('metaobjects', err));
    }
  }

  // ==========================================
  // PHASE 8: Sync Menus
  // ==========================================
  // Menus have no Shopify webhook and were previously not synced at all — only
  // entitled on pro/max via contentTypes. syncAllMenus has no cap/progress.
  assertNotAborted();
  if (!scope.menus.enabled) {
    emit('menus', 100, 'Menus not included in this plan, skipping...');
  } else {
    emit('menus', 0, 'Syncing menus...');
    try {
      const syncService = new ContentSyncService(admin, shop);
      stats.menus = await syncService.syncAllMenus();
      emit('menus', 100, `Synced ${stats.menus} menus`);
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") throw err;
      emit('menus', 100, recordPhaseFailure('menus', err));
    }
  }

  // Catch an abort that landed during the last (callback-less) menus phase
  // before we persist the success marker.
  assertNotAborted();

  // ==========================================
  // COMPLETE
  // ==========================================
  // If any ENABLED phase failed (swallowed, non-abort), do NOT set the
  // completion marker — record the error and return completed:false so the
  // scheduler retries next cycle. Otherwise a single transient phase error
  // would mark setup "done" and leave that content type permanently uncached
  // (collections/articles/menus have no create/update webhook).
  if (phaseFailed) {
    try {
      await db.shopInstallState.upsert({
        where: { shop },
        create: { shop, initialSyncError: firstPhaseError ?? "Sync failed" },
        update: { initialSyncError: firstPhaseError ?? "Sync failed" },
      });
    } catch (e) {
      logger.warn("[INITIAL-SYNC] Failed to persist initialSyncError", {
        shop, error: e instanceof Error ? e.message : String(e),
      });
    }
    emit('error', 100, firstPhaseError ?? 'Sync failed');
    return { stats, completed: false };
  }

  // Set the success marker ONLY here, after a fully successful run. An abort
  // throws AbortError before this point, leaving the marker unset (the safe
  // state → scheduler finishes it next cycle).
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

/**
 * Requests a fresh initial sync by resetting the ShopInstallState markers.
 * The scheduler's initial-sync branch picks this up on its next cycle and runs
 * runInitialFullSync (force = whether to delete+re-pull products first).
 *
 * Shared by the Settings force re-sync (force:true) and the plan-upgrade auto
 * re-sync (force:false, non-destructive fill — cleanup already pruned). The
 * caller is responsible for ensuring the scheduler is running
 * (syncScheduler.startSyncForShop) — kept out of here to avoid an import cycle
 * with sync-scheduler.service.
 */
export async function requestInitialResync(
  shop: string,
  opts: { force: boolean },
): Promise<void> {
  await db.shopInstallState.upsert({
    where: { shop },
    create: {
      shop,
      initialSyncCompletedAt: null,
      initialSyncStartedAt: new Date(),
      initialSyncForceRequested: opts.force,
      initialSyncPhase: null,
      initialSyncPercent: 0,
      // Prisma.JsonNull writes a real SQL NULL; `undefined` would leave the
      // previous run's stats in place (Prisma treats undefined as "no change"),
      // making /api/sync-status briefly report stale counts at 0%.
      initialSyncStats: Prisma.JsonNull,
      initialSyncError: null,
    },
    update: {
      initialSyncCompletedAt: null,
      initialSyncStartedAt: new Date(),
      initialSyncForceRequested: opts.force,
      initialSyncPhase: null,
      initialSyncPercent: 0,
      initialSyncStats: Prisma.JsonNull,
      initialSyncError: null,
    },
  });
}
