/**
 * SEO Audit Dashboard — "Rescan" action.
 *
 * Runs the store-wide audit (analyzeStore, audit.service.ts) as a detached
 * Task, same shape as seo-bulk-fix.handler.ts / alt-text.handler.ts: a parent
 * Task row is created up front (single-flight guarded), then a detached
 * runner does the actual work and persists a SeoScoreSnapshot so the
 * dashboard loader can read a cached result instead of re-scanning on every
 * visit.
 *
 * IMPORTANT: this is a non-AI task — analyzeStore only reads the DB content
 * cache, no provider call is made. It must never go through AIQueueService,
 * and (see api.ai.tsx) it is exempt from the route's "shop must have an AI
 * key" gate, since a merchant with no AI key configured yet must still be
 * able to see/refresh their SEO score.
 */

import { data as json } from "react-router";
import type { AIActionContext } from "./shared";
import { errorMessage } from "./shared";
import { getTaskExpirationDate } from "~/config/constants";
import { logger } from "~/utils/logger.server";
import { analyzeStore } from "~/services/seo/audit.service";
import { saveAuditSnapshot } from "~/services/seo/audit.service";
import { seoTitleEffectiveLimit } from "~/utils/seo-score";
import { getCachedShopLocales } from "~/utils/shop-locales-cache.server";
import type { Plan } from "~/config/plans";
import type { PrismaClient } from "@prisma/client";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import type { DataResponse } from "~/types/data-response";

export async function handleSeoAudit(ctx: AIActionContext): Promise<DataResponse> {
  const { session, admin, db, settings } = ctx;

  // Single-flight: only one seoAudit run per shop at a time — a second click
  // while one is in flight would just duplicate the scan and race the
  // snapshot write below.
  const runningTask = await db.task.findFirst({
    where: { shop: session.shop, type: "seoAudit", status: "running" },
    select: { id: true },
  });
  if (runningTask) {
    return json(
      {
        success: false,
        code: "ALREADY_RUNNING",
        error: "An SEO scan is already running for this store. Check the Tasks tab for progress.",
        taskId: runningTask.id,
      },
      { status: 409 },
    );
  }

  // Same settings resolution as the dashboard loader (app.seo._index.tsx) —
  // ctx.settings is already the full AISettings row (api.ai.tsx loads it
  // before dispatch), so no extra query is needed here.
  const plan = (settings?.subscriptionPlan || "free") as Plan;
  const suffix =
    settings?.seoTitleSuffixEnabled && settings.seoTitleSuffix ? settings.seoTitleSuffix : "";
  const seoLimits = (settings?.seoLimits ?? null) as Record<string, number> | null;
  const effectiveLimit = seoTitleEffectiveLimit(suffix, seoLimits);

  const task = await db.task.create({
    data: {
      shop: session.shop,
      type: "seoAudit",
      status: "running",
      resourceType: "seo",
      total: 1,
      processed: 0,
      progress: 0,
      expiresAt: getTaskExpirationDate(),
    },
  });

  // Fire-and-forget: survives navigation, same pattern as runSeoBulkFix /
  // runBulkAltTextGeneration. Now scans primary + every published foreign
  // locale so the SEO overview language switcher has fresh data for each tab.
  void runSeoAudit(task.id, {
    db,
    admin,
    shop: session.shop,
    plan,
    seoTitleEffectiveLimit: effectiveLimit,
    seoLimits,
  }).catch((err: unknown) => {
    logger.error("[API-AI] SEO audit crashed", {
      context: "AI",
      taskId: task.id,
      error: errorMessage(err),
    });
  });

  return json({ success: true, taskId: task.id });
}

// ─── Runner ────────────────────────────────────────────────────────────────

interface RunArgs {
  db: PrismaClient;
  admin: AdminApiContext;
  shop: string;
  plan: Plan;
  seoTitleEffectiveLimit: number;
  seoLimits: Record<string, number> | null;
}

const SHOP_NAME_QUERY = `#graphql
  query seoAuditShopName {
    shop { name }
  }
`;

/** Best-effort shop display name — used only to strip the "– ShopName"
 *  suffix in the crawl-derived headDrift bucket (audit.service.ts §3.6).
 *  Never fails the whole scan on a GraphQL error. */
async function fetchShopName(admin: AdminApiContext, fallbackShop: string): Promise<string> {
  try {
    const res = await admin.graphql(SHOP_NAME_QUERY);
    const j: any = await res.json();
    return j?.data?.shop?.name || fallbackShop.replace(/\.myshopify\.com$/, "");
  } catch {
    return fallbackShop.replace(/\.myshopify\.com$/, "");
  }
}

async function runSeoAudit(taskId: string, args: RunArgs): Promise<void> {
  const { db, admin, shop, plan, seoTitleEffectiveLimit: effectiveLimit, seoLimits } = args;

  try {
    const shopName = await fetchShopName(admin, shop);
    // Enumerate every shop locale so the SEO overview language switcher has a
    // fresh snapshot per tab. Primary snapshot uses locale="" (sentinel) so
    // it stays compatible with pre-locale rows. Published-but-non-primary
    // locales get their own snapshot; unpublished locales are skipped (no
    // storefront surface = no useful signal).
    const shopLocales = await getCachedShopLocales(admin, shop).catch((err: unknown) => {
      logger.warn("[API-AI] SEO audit: failed to load shop locales, falling back to primary only", {
        context: "AI",
        taskId,
        error: errorMessage(err),
      });
      return [] as { locale: string; primary: boolean; published: boolean }[];
    });
    const foreignLocales = shopLocales
      .filter((l) => l.published && !l.primary)
      .map((l) => l.locale);

    // Locale scan list: primary first (fastest path, existing users notice
    // this run first), then every published foreign locale.
    const scanTargets: { locale: string; snapshotKey: string }[] = [
      { locale: "", snapshotKey: "" },
      ...foreignLocales.map((l) => ({ locale: l, snapshotKey: l })),
    ];

    let processed = 0;
    let succeededCount = 0;
    let lastPrimaryAudit: {
      averageScore: number;
      totalScanned: number;
      totalAvailable: number;
      capped: boolean;
    } | null = null;

    // Update total up front so the Tasks-tab progress bar shows the real
    // denominator instead of 1 for a multi-locale run.
    await db.task
      .update({ where: { id: taskId }, data: { total: scanTargets.length } })
      .catch(() => {});

    for (const target of scanTargets) {
      const localeLabel = target.locale === "" ? "<primary>" : target.locale;
      try {
        // Heartbeat per locale — TaskRecoveryService's stuck-task reaper keys
        // off updatedAt, so this proves the runner is still alive between
        // scans on multi-locale shops.
        const preProgress = Math.round((processed / scanTargets.length) * 100);
        await db.task.update({ where: { id: taskId }, data: { progress: preProgress } });

        const audit = await analyzeStore(shop, {
          db,
          seoTitleEffectiveLimit: effectiveLimit,
          seoLimits,
          plan,
          locale: target.locale || undefined,
          shopName,
        });
        await saveAuditSnapshot(db, shop, audit, target.snapshotKey);

        if (target.locale === "") {
          lastPrimaryAudit = {
            averageScore: audit.averageScore,
            totalScanned: audit.totalScanned,
            totalAvailable: audit.totalAvailable,
            capped: audit.capped,
          };
        }
        succeededCount += 1;
      } catch (err: unknown) {
        // One failing locale must not sink the whole run — a broken
        // ContentTranslation row shouldn't stop the merchant seeing their
        // primary score. Log and continue.
        logger.error("[API-AI] SEO audit: locale scan failed", {
          context: "AI",
          taskId,
          locale: localeLabel,
          error: errorMessage(err),
        });
      } finally {
        processed += 1;
      }
    }

    // Mark failed if EVERY locale threw — a "completed" status on a run that
    // produced no snapshots would mislead the merchant (dashboard would keep
    // reading the previous stale snapshot with no error surface).
    const allFailed = succeededCount === 0 && scanTargets.length > 0;
    await db.task.update({
      where: { id: taskId },
      data: {
        status: allFailed ? "failed" : "completed",
        progress: 100,
        processed,
        completedAt: new Date(),
        // A machine code, translated at render time by `taskErrorText`.
        error: allFailed ? `locale_scans_failed:${scanTargets.length}` : null,
        // Result summary keeps the primary-locale headline numbers for
        // continuity with the pre-multi-locale schema.
        result: JSON.stringify(
          lastPrimaryAudit ?? {
            averageScore: 0,
            totalScanned: 0,
            totalAvailable: 0,
            capped: false,
          },
        ),
      },
    });
  } catch (err: unknown) {
    const message = errorMessage(err);
    logger.error("[API-AI] SEO audit: scan failed", { context: "AI", taskId, error: message });
    await db.task
      .update({
        where: { id: taskId },
        data: {
          status: "failed",
          progress: 100,
          completedAt: new Date(),
          error: message.substring(0, 1000),
        },
      })
      .catch((updateErr: unknown) => {
        logger.error("[API-AI] SEO audit: failed to persist failure state", {
          context: "AI",
          taskId,
          error: errorMessage(updateErr),
        });
      });
  }
}
