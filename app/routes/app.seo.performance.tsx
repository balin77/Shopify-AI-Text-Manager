/**
 * Performance section (page-speed audit) — SEO tab.
 *
 * Runs a Google PageSpeed Insights audit for a merchant-picked storefront page
 * (homepage / product / collection / page, or a custom path/URL) on mobile or
 * desktop and renders it the way PSI itself does: real-user (CrUX) data with a
 * threshold bar per metric on top, then the lab result (score gauge, page
 * screenshot, measured metrics), then the findings as an accordion whose rows
 * carry Lighthouse's own details table — including element thumbnails cropped
 * out of the full-page screenshot — and finally the history of past runs.
 *
 * The heavy lifting (PSI fetch, Prisma cache, screenshot annotation mapping)
 * lives in services/seo/pagespeed.service.ts — this route only orchestrates
 * the picker, submits the audit, and renders the result contract defined in
 * services/seo/pagespeed.types.ts.
 */

import { data as json, type LoaderFunctionArgs, type ActionFunctionArgs } from "react-router";
import { useLoaderData, useFetcher, useRevalidator } from "react-router";
import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  Card,
  BlockStack,
  InlineStack,
  Text,
  Badge,
  Button,
  ButtonGroup,
  TextField,
  Select,
  Banner,
  IndexTable,
  Divider,
  Collapsible,
  Modal,
  Tooltip,
} from "@shopify/polaris";
import { DeleteIcon } from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server";
import { useI18n } from "../contexts/I18nContext";
import { useHydrated } from "../hooks/useHydrated";
import { formatNumber, formatDate, formatDateTime } from "../utils/format";
import { useAppNavigation } from "../hooks/useAppNavigation";
import { useTaskCount } from "../contexts/TaskCountContext";
import { SeoSectionLayout } from "../components/seo/SeoSectionLayout";
import { SeoHelpBanner } from "../components/seo/SeoHelpBanner";
import { HelpTooltip } from "../components/HelpTooltip";
import { getFormString } from "../utils/form-data.utils";
import {
  isAllowedAuditUrl,
  runPageSpeedAudit,
  fetchRawPageSpeedInsights,
  listPageSpeedHistory,
  findLatestPageSpeedAudit,
  findPageSpeedAuditById,
  deletePageSpeedAudit,
  countPageSpeedRunsToday,
  PageSpeedQuotaExceededError,
  PageSpeedDailyLimitError,
} from "../services/seo/pagespeed.service";
import { getDailyPageSpeedRunsLimit } from "../utils/planUtils";
import type { Plan } from "../config/plans";
import type {
  PageSpeedStrategy,
  PageSpeedAuditResult,
  PageSpeedMetric,
  PageSpeedMetricId,
  PageSpeedCell,
  PageSpeedRect,
  PageSpeedScreenshot,
  PageSpeedTable,
  PageSpeedPassedAudit,
  CruxCategory,
  QualityIssue,
} from "../services/seo/pagespeed.types";
import { getWebVitalsSummary } from "../services/seo/web-vitals.service";
import { getCachedShopLocales } from "../utils/shop-locales-cache.server";
import type { WebVitalDevice } from "../services/seo/web-vitals.types";
import { buildAltImageMatches, type AltImageMatch } from "../services/seo/alt-image-matches";
import type { DataResponse } from "~/types/data-response";

const SHOP_HOST_QUERY = `#graphql
  query seoPerformanceShopHost {
    shop {
      primaryDomain { host }
    }
  }
`;

/** Subscription plan for `shop`, defaulting to "free" — mirrors app.seo._index.tsx. */
async function getShopPlan(db: any, shop: string): Promise<Plan> {
  const settings = await db.aISettings.findUnique({
    where: { shop },
    select: { subscriptionPlan: true },
  });
  return (settings?.subscriptionPlan || "free") as Plan;
}

/** UI language, forwarded to PSI so Lighthouse answers in the merchant's language. */
async function getShopLanguage(db: any, shop: string): Promise<string | undefined> {
  const settings = await db.aISettings.findUnique({
    where: { shop },
    select: { appLanguage: true },
  });
  return settings?.appLanguage || undefined;
}

async function getShopHost(admin: any, fallbackShop: string): Promise<string> {
  try {
    const res = await admin.graphql(SHOP_HOST_QUERY);
    const j: any = await res.json();
    return j?.data?.shop?.primaryDomain?.host || fallbackShop;
  } catch {
    return fallbackShop;
  }
}

/**
 * Alt-text coverage audit (accessibility plan §7, app-native replacement for
 * the Lighthouse `image-alt` trigger). Lighthouse never flags Shopify product
 * images: themes always emit an `alt` attribute (empty `alt=""` when unset),
 * and axe-core PASSES empty alt as "decorative" — so the Lighthouse bridge
 * essentially never fires. This warns from OUR own data instead: images with no
 * primary alt text, and images whose alt text is not translated into each
 * active foreign locale.
 */
type AltTextAudit = {
  totalImages: number;
  /** Product images with no primary-language alt text. */
  missingPrimary: number;
  primaryLocale: string;
  /** Per foreign locale: images that HAVE a primary alt but lack that locale's translation. */
  foreign: Array<{ locale: string; name: string; missing: number }>;
};

async function computeAltTextAudit(
  db: any,
  admin: any,
  shop: string,
): Promise<AltTextAudit> {
  const locales = await getCachedShopLocales(admin, shop).catch(() => []);
  const primaryLocale = locales.find((l: any) => l.primary)?.locale || "en";
  const foreignLocales = locales.filter((l: any) => l.published && !l.primary);

  const shopScope = { product: { shop } };
  // "Has a primary alt to translate": non-null AND non-empty.
  const hasPrimaryWhere = { ...shopScope, altText: { not: null }, NOT: { altText: "" } };

  const [totalImages, missingPrimary, foreignMissing] = await Promise.all([
    db.productImage.count({ where: shopScope }),
    db.productImage.count({ where: { ...shopScope, OR: [{ altText: null }, { altText: "" }] } }),
    Promise.all(
      foreignLocales.map((l: any) =>
        db.productImage.count({
          where: { ...hasPrimaryWhere, altTextTranslations: { none: { locale: l.locale, marketId: "" } } },
        }),
      ),
    ),
  ]);

  return {
    totalImages,
    missingPrimary,
    primaryLocale,
    foreign: foreignLocales.map((l: any, i: number) => ({
      locale: l.locale,
      name: l.name || l.locale,
      missing: foreignMissing[i] ?? 0,
    })),
  };
}

/** Picker cap per resource type — mirrors the pattern in app.seo.keywords.tsx. */
const PICKER_CAP = 100;
/** History rows requested from the server / shown in the table. */
const HISTORY_LOAD_LIMIT = 20;
const HISTORY_VISIBLE_LIMIT = 10;
/**
 * How long after it was triggered a PageSpeed run is still "the run in
 * progress" for this page: within this window the loader hands back the run's
 * task so returning to the page either shows its progress or auto-opens its
 * result. Past it, the merchant just gets the normal idle controls + history.
 */
const ACTIVE_AUDIT_WINDOW_MS = 30 * 60 * 1000;
/**
 * A run marks its own task completed/failed in the same request, and a real
 * audit lasts ≤60s (PSI_TIMEOUT_MS). So a task still "running" past this bound
 * is almost certainly dead — the request that owned it died mid-audit (dyno
 * redeploy, OOM, crash) and no other process will ever finish it. Treating it
 * as active would leave the "test" button disabled for the full 30-min window,
 * so a stale-running task is ignored (idle controls + history instead).
 */
const RUNNING_STALE_MS = 3 * 60 * 1000;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const { db } = await import("../db.server");
  const shop = session.shop;

  // `getShopHost` is a Shopify GraphQL round-trip and nothing below depends on
  // its result, so it joins the parallel batch instead of blocking it — the
  // loader's latency is then the slowest single query, not the network hop
  // plus the queries.
  const [domain, products, collections, pages, history, rum, runsToday, plan, altTextAudit] = await Promise.all([
    getShopHost(admin, shop),
    // ACTIVE only: this picks representative storefront URLs to measure page
    // speed for. Unlisted products get near-zero real traffic by design, so
    // spending a scarce daily PageSpeed run on one would misrepresent the
    // storefront the merchant's customers actually load.
    db.product.findMany({
      where: { shop, status: "ACTIVE" },
      select: { id: true, title: true, handle: true },
      orderBy: { shopifyUpdatedAt: "desc" },
      take: PICKER_CAP,
    }),
    // Collection has no status field — every synced collection is a candidate.
    db.collection.findMany({
      where: { shop },
      select: { id: true, title: true, handle: true },
      orderBy: { shopifyUpdatedAt: "desc" },
      take: PICKER_CAP,
    }),
    // Page has no status field either (see prisma/schema.prisma).
    db.page.findMany({
      where: { shop },
      select: { id: true, title: true, handle: true },
      orderBy: { shopifyUpdatedAt: "desc" },
      take: PICKER_CAP,
    }),
    listPageSpeedHistory({ db, shop, limit: HISTORY_LOAD_LIMIT }),
    getWebVitalsSummary({ db, shop }),
    // Informational only — the action re-counts and is the source of truth.
    // This just lets the button render disabled after a reload instead of
    // inviting a click the server would reject.
    countPageSpeedRunsToday(db, shop),
    getShopPlan(db, shop),
    // App-native alt-text coverage — replaces the Lighthouse image-alt trigger
    // (which never fires on Shopify storefronts). Best-effort: a failure must
    // not sink the whole page, so it degrades to null.
    computeAltTextAudit(db, admin, shop).catch(() => null),
  ]);

  // The RUM embed is activated in Settings → Setup with every other app embed,
  // so this section links there instead of building its own theme-editor URL.

  // The run this page most recently kicked off (the `runAudit` action models it
  // as a `Task`, like the AI generations do). When one is still fresh, the
  // client uses it to either show the in-progress state or auto-open the
  // finished result on return — instead of the run silently vanishing from the
  // UI while it keeps writing to history in the background.
  const activeAudit = await resolveActiveAudit(db, shop, history);

  return json({
    domain,
    products,
    collections,
    pages,
    history,
    rum,
    runsToday,
    dailyLimit: getDailyPageSpeedRunsLimit(plan),
    activeAudit,
    altTextAudit,
  });
};

/** What the loader hands the client about the most recent PageSpeed run. */
type ActiveAudit = {
  taskId: string;
  status: string;
  /** Row id of the finished audit (completed runs only), else null. */
  auditId: string | null;
  url: string | null;
  strategy: PageSpeedStrategy | null;
};

/**
 * Newest `pageSpeed` task within the window. For a completed run its stored
 * `{ url, strategy }` is matched against the newest history row for that target
 * (history is newest-first) to recover the audit's row id, so the client can
 * re-open exactly that result via the existing `loadHistory` intent.
 */
async function resolveActiveAudit(
  db: any,
  shop: string,
  history: { id: string; url: string; strategy: string }[],
): Promise<ActiveAudit | null> {
  const task = await db.task.findFirst({
    where: { shop, type: "pageSpeed", createdAt: { gte: new Date(Date.now() - ACTIVE_AUDIT_WINDOW_MS) } },
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true, result: true, createdAt: true },
  });
  if (!task) return null;

  // A task still "running" long past a real audit's duration is a dead run
  // (the request that owned it died before it could mark it done). Ignore it,
  // otherwise the "test" button stays disabled for the whole 30-min window.
  if (task.status === "running") {
    const createdAtMs =
      task.createdAt instanceof Date ? task.createdAt.getTime() : new Date(task.createdAt).getTime();
    if (Date.now() - createdAtMs > RUNNING_STALE_MS) return null;
  }

  let url: string | null = null;
  let strategy: PageSpeedStrategy | null = null;
  try {
    const parsed = task.result ? JSON.parse(task.result) : null;
    if (typeof parsed?.url === "string") url = parsed.url;
    if (parsed?.strategy === "mobile" || parsed?.strategy === "desktop") strategy = parsed.strategy;
  } catch {
    // Malformed result payload — degrade to an id-only active audit.
  }

  let auditId: string | null = null;
  if (task.status === "completed" && url && strategy) {
    const match = history.find((h) => h.url === url && h.strategy === strategy);
    auditId = match?.id ?? null;
  }

  return { taskId: task.id, status: task.status, auditId, url, strategy };
}

type ActionResult =
  | { ok: true; result: PageSpeedAuditResult }
  | { ok: false; error: string; detail?: string };

/** Response of the `deleteHistory` intent (History-row trash button). */
type DeleteHistoryResult =
  | { ok: true; deletedId: string }
  | { ok: false; error: string };

/** Response of the `matchAltImages` intent (alt-text bridge, plan §7). */
type MatchAltImagesResult =
  | { ok: true; matches: Record<string, AltImageMatch | null> }
  | { ok: false; error: string };

/** Response of the `generateAltText` intent (alt-text bridge, plan §7). */
type GenerateAltTextResult =
  | { ok: true; altText: string }
  | { ok: false; error: string };

/**
 * PROBE (accessibility plan §3.3): response of the `debugRawPsi` intent — the
 * complete raw PSI answer plus its top-level category keys, so we can check
 * whether Google ships an unrequested `agentic-browsing` category. Posted from
 * the dev-only PageSpeed probe in Settings (SettingsPageSpeedProbeTab).
 * Temporary — remove with §3.3.
 */
type DebugRawPsiResult =
  | { ok: true; categories: string[]; raw: unknown }
  | { ok: false; error: string };

/**
 * Server-side cap on URLs per `matchAltImages` request. Lighthouse findings
 * are already capped far below this — the cap only defends against a
 * hand-crafted request forcing an oversized matching run.
 */
const MAX_ALT_MATCH_URLS = 20;
/**
 * Cap on ProductImage rows scanned per `matchAltImages` call. Keeps a huge
 * catalog from turning the match into an unbounded query — images beyond the
 * cap are reported as unmatched rather than scanned.
 */
const MAX_ALT_MATCH_IMAGES = 20_000;

export const action = async ({ request }: ActionFunctionArgs): Promise<DataResponse> => {
  const { admin, session } = await authenticate.admin(request);
  const { db } = await import("../db.server");
  const shop = session.shop;

  const form = await request.formData();
  const intent = getFormString(form, "intent");

  // Load a stored past audit by id (History-row click). Same result shape as a
  // fresh run — the UI reuses the same rendering block, gated by an
  // "isHistorical" flag returned alongside so the client can show a banner.
  if (intent === "loadHistory") {
    const auditId = getFormString(form, "auditId");
    if (!auditId) {
      return json<ActionResult>({ ok: false, error: "invalid" }, { status: 400 });
    }
    const stored = await findPageSpeedAuditById(db, shop, auditId);
    if (!stored) {
      return json<ActionResult>({ ok: false, error: "notFound" }, { status: 404 });
    }
    return json<ActionResult>({ ok: true, result: stored });
  }

  // Delete one stored past audit (History-row trash button). Shop-scoped in the
  // service so a tampered id cannot reach another tenant's row.
  if (intent === "deleteHistory") {
    const auditId = getFormString(form, "auditId");
    if (!auditId) {
      return json<DeleteHistoryResult>({ ok: false, error: "invalid" }, { status: 400 });
    }
    const removed = await deletePageSpeedAudit(db, shop, auditId);
    if (removed === 0) {
      return json<DeleteHistoryResult>({ ok: false, error: "notFound" }, { status: 404 });
    }
    return json<DeleteHistoryResult>({ ok: true, deletedId: auditId });
  }

  // Alt-text bridge, step 1 (plan §7): map the image URLs of the current
  // result's `image-alt` findings to shop-scoped ProductImage rows so the UI
  // knows which findings get a working "generate alt text" button.
  if (intent === "matchAltImages") {
    let urls: unknown;
    try {
      urls = JSON.parse(getFormString(form, "imageUrls") || "[]");
    } catch {
      return json<MatchAltImagesResult>({ ok: false, error: "invalid" }, { status: 400 });
    }
    if (!Array.isArray(urls)) {
      return json<MatchAltImagesResult>({ ok: false, error: "invalid" }, { status: 400 });
    }
    const imageUrls = urls
      .filter((u): u is string => typeof u === "string")
      .slice(0, MAX_ALT_MATCH_URLS);

    // R4-DI7 pattern (see alt-text.action.ts): always scope by the owning
    // product's shop — an unscoped query could match another tenant's images.
    // `take` bounds memory and latency on very large catalogs; images beyond
    // the cap simply stay unmatched, which the UI already explains
    // (altTextUnmatched) — a degraded match beats an unbounded scan.
    const images = await db.productImage.findMany({
      where: { product: { shop } },
      select: {
        id: true,
        productId: true,
        url: true,
        mediaId: true,
        product: { select: { title: true } },
      },
      take: MAX_ALT_MATCH_IMAGES,
    });

    const matches = buildAltImageMatches(
      imageUrls,
      images.map((img: { id: string; productId: string; url: string; mediaId: string | null; product: { title: string | null } | null }) => ({
        id: img.id,
        productId: img.productId,
        url: img.url,
        mediaId: img.mediaId,
        productTitle: img.product?.title ?? "",
      })),
    );
    return json<MatchAltImagesResult>({ ok: true, matches });
  }

  // Alt-text bridge, step 2 (plan §7): generate an alt text for one matched
  // image via the merchant's configured AI provider and save it for the
  // primary locale — same prompt build as handleGenerateAltText and same save
  // path as handleSaveImageAltText's primary branch (alt-text.action.ts).
  if (intent === "generateAltText") {
    const mediaId = getFormString(form, "mediaId");
    if (!mediaId) {
      return json<GenerateAltTextResult>({ ok: false, error: "invalid" }, { status: 400 });
    }

    // The client must not be able to smuggle in a foreign GID: only accept a
    // mediaId that a shop-scoped ProductImage row knows (R4-DI7), and use that
    // row's URL and product title — not the client-sent ones — for the AI call.
    const image = await db.productImage.findFirst({
      where: { mediaId, product: { shop } },
      select: { url: true, productId: true, product: { select: { title: true } } },
    });
    if (!image) {
      return json<GenerateAltTextResult>({ ok: false, error: "unknownImage" }, { status: 400 });
    }

    const [
      { AIService, toValidProvider },
      { tryDecryptApiKey },
      { getFullErrorMessage },
      { buildProductAltTextPrompt, saveImageAltTextPrimary },
      { getTaskExpirationDate },
    ] = await Promise.all([
      import("../../src/services/ai.service"),
      import("../utils/encryption.server"),
      import("../utils/error-handler"),
      import("../actions/content/alt-text.action"),
      import("../config/constants"),
    ]);

    const [aiSettings, aiInstructions] = await Promise.all([
      db.aISettings.findUnique({ where: { shop } }),
      db.aIInstructions.findUnique({ where: { shop } }),
    ]);

    // Same provider/serviceConfig assembly as handleUnifiedContentActions
    // (unified-content.actions.ts) — the merchant's configured AI setup.
    const provider = toValidProvider(aiSettings?.preferredProvider || "claude");
    const serviceConfig = {
      huggingfaceApiKey: tryDecryptApiKey(aiSettings?.huggingfaceApiKey, "huggingface") || undefined,
      geminiApiKey: tryDecryptApiKey(aiSettings?.geminiApiKey, "gemini") || undefined,
      claudeApiKey: tryDecryptApiKey(aiSettings?.claudeApiKey, "claude") || undefined,
      openaiApiKey: tryDecryptApiKey(aiSettings?.openaiApiKey, "openai") || undefined,
      grokApiKey: tryDecryptApiKey(aiSettings?.grokApiKey, "grok") || undefined,
      deepseekApiKey: tryDecryptApiKey(aiSettings?.deepseekApiKey, "deepseek") || undefined,
      selectedModel: aiSettings?.selectedModel || undefined,
    };
    // Same language source the PSI call already uses (AISettings.appLanguage,
    // see getShopLanguage) — what handleGenerateAltText receives as
    // `mainLanguage` from its clients.
    const mainLanguage = aiSettings?.appLanguage || "en";

    // Shared prompt build + primary save (alt-text.action.ts) — the bridge
    // must not fork its own copy of the alt-text path (CLAUDE.md: no parallel
    // handlers). The task row mirrors handleGenerateAltText so the run shows
    // up in the activity view like every other generation.
    const { prompt, sanitizedTitle } = buildProductAltTextPrompt({
      productTitle: image.product?.title || "",
      imageUrl: image.url,
      aiInstructions,
      language: mainLanguage,
    });

    const task = await db.task.create({
      data: {
        shop,
        type: "aiGeneration",
        status: "pending",
        resourceType: "Product",
        resourceId: image.productId,
        resourceTitle: image.product?.title || "",
        fieldType: "altText",
        progress: 0,
        expiresAt: getTaskExpirationDate(),
      },
    });

    const failTask = (error: string) =>
      db.task
        .update({ where: { id: task.id }, data: { status: "failed", completedAt: new Date(), error } })
        .catch(() => {});

    let altText: string;
    try {
      const aiService = new AIService(provider, serviceConfig, shop, task.id);
      altText = (await aiService.generateImageAltText(image.url, sanitizedTitle, prompt)).trim();
    } catch (err: unknown) {
      const message = getFullErrorMessage(err);
      await failTask(message);
      return json<GenerateAltTextResult>({ ok: false, error: message }, { status: 500 });
    }
    if (!altText) {
      await failTask("AI returned an empty alt text");
      return json<GenerateAltTextResult>({ ok: false, error: "AI returned an empty alt text" }, { status: 500 });
    }

    const saveResult = await saveImageAltTextPrimary({ admin, db, shop, mediaId, altText });
    if (!saveResult.saved) {
      const message = saveResult.userErrors.join("; ") || "Shopify API error";
      await failTask(message);
      return json<GenerateAltTextResult>({ ok: false, error: message }, { status: 500 });
    }

    await db.task
      .update({
        where: { id: task.id },
        data: {
          status: "completed",
          progress: 100,
          completedAt: new Date(),
          result: JSON.stringify({ altText }),
        },
      })
      .catch(() => {});

    return json<GenerateAltTextResult>({ ok: true, altText });
  }

  // PROBE (accessibility plan §3.3): dump the complete, unparsed PSI response so
  // the merchant can inspect — via one button — whether Google ships an
  // `agentic-browsing` category we never requested. Bypasses cache and parsing
  // and writes NO history row (so it doesn't count against the daily budget),
  // but it DOES spend one Google PSI request. Temporary — remove with §3.3.
  if (intent === "debugRawPsi") {
    const rawUrl = getFormString(form, "url").trim();
    const strategy: PageSpeedStrategy = getFormString(form, "strategy") === "desktop" ? "desktop" : "mobile";
    const domain = await getShopHost(admin, shop);
    const url = rawUrl.startsWith("/") ? `https://${domain}${rawUrl}` : rawUrl;
    const allowedHosts = Array.from(new Set([domain, shop].filter(Boolean)));
    if (!url || !isAllowedAuditUrl(url, allowedHosts)) {
      return json<DebugRawPsiResult>({ ok: false, error: "invalidUrl" }, { status: 400 });
    }
    const locale = await getShopLanguage(db, shop);
    try {
      const raw = await fetchRawPageSpeedInsights(url, strategy, locale);
      const categories = Object.keys((raw as any)?.lighthouseResult?.categories ?? {});
      return json<DebugRawPsiResult>({ ok: true, categories, raw });
    } catch (err: any) {
      return json<DebugRawPsiResult>({ ok: false, error: err?.message || "failed" }, { status: 502 });
    }
  }

  if (intent !== "runAudit") {
    return json<ActionResult>({ ok: false, error: "invalid" }, { status: 400 });
  }

  const rawUrl = getFormString(form, "url").trim();
  const strategy: PageSpeedStrategy = getFormString(form, "strategy") === "desktop" ? "desktop" : "mobile";
  const force = getFormString(form, "force") === "1";

  // The domain is recomputed server-side (never trusted from the client) so a
  // tampered request can't point the audit — and the allow-list check below —
  // at an arbitrary third-party host.
  const domain = await getShopHost(admin, shop);
  const url = rawUrl.startsWith("/") ? `https://${domain}${rawUrl}` : rawUrl;
  const allowedHosts = Array.from(new Set([domain, shop].filter(Boolean)));

  if (!url || !isAllowedAuditUrl(url, allowedHosts)) {
    return json<ActionResult>({ ok: false, error: "invalidUrl" }, { status: 400 });
  }

  const [plan, locale] = await Promise.all([getShopPlan(db, shop), getShopLanguage(db, shop)]);

  // Model the run as a Task, exactly like the AI generations (see
  // text-generation.handler.ts). This is what makes a run survive navigation:
  // it shows up in the nav "Tasks" badge/preview while it runs, and the loader
  // can hand it back to the page on return. The `result` payload carries the
  // target so the loader can recover the finished audit's row id from history.
  // Task-writes are best-effort — a task-row failure must never sink the audit.
  const { getTaskExpirationDate } = await import("../config/constants");
  let pageLabel = url;
  try {
    const parsed = new URL(url);
    pageLabel = parsed.pathname === "/" ? parsed.host : parsed.pathname;
  } catch {
    // Keep the raw url as the label.
  }
  const task = await db.task
    .create({
      data: {
        shop,
        type: "pageSpeed",
        status: "running",
        resourceType: "page",
        resourceTitle: pageLabel,
        fieldType: strategy,
        progress: 10,
        result: JSON.stringify({ url, strategy }),
        expiresAt: getTaskExpirationDate(),
      },
    })
    .catch(() => null);

  const finishTask = (data: Record<string, unknown>) =>
    task ? db.task.update({ where: { id: task.id }, data }).catch(() => {}) : Promise.resolve();

  try {
    const result = await runPageSpeedAudit({ db, shop, url, strategy, force, plan, locale });
    await finishTask({
      status: "completed",
      progress: 100,
      completedAt: new Date(),
      result: JSON.stringify({ url, strategy }),
    });
    return json<ActionResult>({ ok: true, result });
  } catch (err: any) {
    // Both budget failures degrade the same way: serve a stored audit of any
    // age so the merchant sees something rather than a hard error. Only the
    // wording differs — Google's quota is not our daily budget, and blaming
    // Google for our own limit would be wrong. No real measurement happened, so
    // the task is marked failed (it never reached Google).
    if (err instanceof PageSpeedQuotaExceededError || err instanceof PageSpeedDailyLimitError) {
      const staleReason = err instanceof PageSpeedDailyLimitError ? "dailyLimit" : "quota";
      await finishTask({ status: "failed", completedAt: new Date(), error: staleReason });
      const stale = await findLatestPageSpeedAudit(db, shop, url, strategy);
      if (stale) return json<ActionResult>({ ok: true, result: { ...stale, staleReason } });
      return json<ActionResult>(
        { ok: false, error: staleReason === "dailyLimit" ? "dailyLimitReached" : "quotaExceeded" },
        { status: 429 },
      );
    }
    await finishTask({ status: "failed", completedAt: new Date(), error: String(err?.message || err) });
    return json<ActionResult>(
      { ok: false, error: "auditFailed", detail: String(err?.message || err) },
      { status: 502 },
    );
  }
};

/** Same help content as the lab metrics — CrUX rows reuse it, plus INP/TTFB. */
const FIELD_HELP_KEYS: Record<string, string> = {
  lcp: "perfLcp",
  inp: "perfInp",
  cls: "perfCls",
  fcp: "perfFcp",
  ttfb: "perfTtfb",
};

const METRIC_HELP_KEYS: Record<PageSpeedMetricId, string> = {
  lcp: "perfLcp",
  cls: "perfCls",
  tbt: "perfTbt",
  fcp: "perfFcp",
  si: "perfSi",
};

function metricTone(score: number | null): "success" | "warning" | "critical" | undefined {
  if (score == null) return undefined;
  if (score >= 0.9) return "success";
  if (score >= 0.5) return "warning";
  return "critical";
}

const FIELD_CATEGORY_TONE: Record<CruxCategory, "success" | "warning" | "critical"> = {
  FAST: "success",
  AVERAGE: "warning",
  SLOW: "critical",
};

type PerfTone = "success" | "warning" | "critical";

/** Lighthouse's own palette — reused so our bars/gauge read like PSI's. */
const PERF_COLOR: Record<PerfTone, string> = {
  success: "#0cce6b",
  warning: "#ffa400",
  critical: "#ff4e42",
};

/** Lighthouse score bands (90 / 50), not the 70/40 SEO-score bands. */
function lighthouseTone(score: number): PerfTone {
  if (score >= 90) return "success";
  if (score >= 50) return "warning";
  return "critical";
}

/**
 * Core Web Vitals thresholds per field metric, in the metric's own reported unit
 * (ms; CLS as value*100 per CrUX convention). Used for the fallback bar bands
 * and for placing the marker inside its bucket.
 */
const FIELD_THRESHOLDS: Record<string, { good: number; poor: number }> = {
  lcp: { good: 2500, poor: 4000 },
  inp: { good: 200, poor: 500 },
  cls: { good: 10, poor: 25 },
  fcp: { good: 1800, poor: 3000 },
  ttfb: { good: 800, poor: 1800 },
};

/**
 * Band widths used when a stored audit carries no CrUX histogram. These are NOT
 * a user distribution — nobody measured them — so the bar is dimmed and
 * explains itself on hover when they are in play.
 */
const FALLBACK_PROPORTIONS = [0.5, 0.25, 0.25];

/**
 * PSI-style threshold bar: three tone-colored segments whose widths are the
 * real-user distribution (falling back to fixed bands for audits stored before
 * distributions were captured), plus a marker at the p75 value.
 *
 * Marker position = cumulative width of preceding buckets + the value's
 * fraction within its own bucket, so it always lands inside the segment whose
 * color matches the metric's category.
 */
function FieldMetricBar({
  metricKey,
  percentile,
  distributions,
  format,
  fallbackHint,
}: {
  metricKey: string;
  percentile: number;
  distributions?: { min: number; max?: number; proportion: number }[];
  /** Same formatter as the metric's headline value, for the threshold labels. */
  format: (value: number) => string;
  /** Shown on hover when the segment widths are bands, not measured shares. */
  fallbackHint: string;
}) {
  // Which color segment the pointer is over — the threshold numbers are hidden
  // by default and only revealed for the segment(s) a hovered color borders, so
  // the bar stays clean until the merchant reaches for a specific number.
  const [hoveredSeg, setHoveredSeg] = useState<number | null>(null);
  const thresholds = FIELD_THRESHOLDS[metricKey];
  const measured = !!(distributions && distributions.length === 3);
  const buckets =
    measured
      ? distributions!
      : thresholds
        ? [
            { min: 0, max: thresholds.good, proportion: FALLBACK_PROPORTIONS[0] },
            { min: thresholds.good, max: thresholds.poor, proportion: FALLBACK_PROPORTIONS[1] },
            { min: thresholds.poor, proportion: FALLBACK_PROPORTIONS[2] },
          ]
        : null;
  if (!buckets) return null;

  const tones: PerfTone[] = ["success", "warning", "critical"];
  const total = buckets.reduce((sum, b) => sum + b.proportion, 0) || 1;

  let markerPct = 0;
  let cumulative = 0;
  for (let i = 0; i < buckets.length; i++) {
    const b = buckets[i];
    const width = b.proportion / total;
    // Open-ended poor bucket: span it to [min, 2*min] so a runaway value still
    // lands on the bar instead of running off the end.
    const span = b.max != null ? b.max - b.min : Math.max(b.min, 1);
    if (b.max == null || percentile < b.max) {
      const within = span > 0 ? Math.min(1, Math.max(0, (percentile - b.min) / span)) : 0;
      markerPct = (cumulative + within * width) * 100;
      break;
    }
    cumulative += width;
    markerPct = cumulative * 100;
  }

  // Where the color changes — the merchant needs the number behind the break to
  // know when a value starts counting as worse. Only shown for buckets that
  // actually carry a boundary (the open-ended poor bucket has none).
  const boundaries: { pct: number; value: number }[] = [];
  let boundaryCumulative = 0;
  for (let i = 0; i < buckets.length - 1; i++) {
    boundaryCumulative += buckets[i].proportion / total;
    const value = buckets[i].max ?? buckets[i + 1].min;
    if (typeof value === "number") boundaries.push({ pct: boundaryCumulative * 100, value });
  }

  // On a healthy metric both breaks sit far right (e.g. 95% and 98%), so the two
  // labels would print on top of each other. Moving one sideways would put it
  // under the wrong colour, so the second one drops to a second line instead and
  // both stay above the break they belong to.
  const MIN_LABEL_GAP = 22;
  const labelPositions = boundaries.map((b) => ({ pct: Math.min(97, Math.max(3, b.pct)), text: format(b.value) }));
  const stacked =
    labelPositions.length === 2 && labelPositions[1].pct - labelPositions[0].pct < MIN_LABEL_GAP;

  return (
    <div style={{ maxWidth: "260px" }}>
      <div style={{ position: "relative", padding: "6px 0 0" }}>
        <div
          style={{ display: "flex", gap: "2px", height: "4px", opacity: measured ? 1 : 0.4 }}
          title={measured ? undefined : fallbackHint}
        >
          {buckets.map((b, i) => (
            <div
              key={i}
              onMouseEnter={() => setHoveredSeg(i)}
              onMouseLeave={() => setHoveredSeg((h) => (h === i ? null : h))}
              style={{
                width: `${(b.proportion / total) * 100}%`,
                background: PERF_COLOR[tones[i]],
                borderRadius: "2px",
                // A hair taller hit area than the 4px bar so the thin segments
                // are still easy to hover; the visible bar keeps its height.
                cursor: "default",
              }}
            />
          ))}
        </div>
        <span
          style={{
            position: "absolute",
            left: `${Math.min(99, Math.max(1, markerPct))}%`,
            top: "2px",
            width: "10px",
            height: "10px",
            marginLeft: "-5px",
            borderRadius: "50%",
            border: "2px solid var(--p-color-text-secondary, #6d7175)",
            background: "var(--p-color-bg-surface, #fff)",
            boxSizing: "border-box",
          }}
        />
      </div>
      <div style={{ position: "relative", height: stacked ? "32px" : "16px", marginTop: "4px" }}>
        {labelPositions.map((label, i) => {
          // Boundary i sits between segment i and segment i+1, so it belongs to
          // both — reveal it whenever either of those colors is hovered.
          const visible = hoveredSeg === i || hoveredSeg === i + 1;
          return (
            <span
              key={i}
              style={{
                position: "absolute",
                left: `${label.pct}%`,
                top: stacked && i === 1 ? "16px" : 0,
                // Anchored at the edges instead of centred, so a boundary at 96%
                // keeps its label on the bar.
                transform:
                  label.pct <= 6
                    ? "translateX(0)"
                    : label.pct >= 94
                      ? "translateX(-100%)"
                      : "translateX(-50%)",
                whiteSpace: "nowrap",
                fontSize: "11px",
                lineHeight: "16px",
                color: "var(--p-color-text-secondary, #6d7175)",
                // Hidden until its color is hovered; never eats the hover itself.
                opacity: visible ? 1 : 0,
                pointerEvents: "none",
                transition: "opacity 120ms ease-in-out",
              }}
            >
              {label.text}
            </span>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Tone marker in front of a metric name. Shape carries the same information as
 * the color (circle = good, square = needs improvement, triangle = poor), the
 * way PSI does it, so the verdict survives for color-blind merchants.
 */
function ToneMarker({ tone, label }: { tone?: PerfTone; label?: string }) {
  const color = tone ? PERF_COLOR[tone] : "var(--p-color-border, #c9cccf)";
  const base: CSSProperties = { display: "inline-block", flexShrink: 0, width: "10px", height: "10px" };
  if (tone === "critical") {
    return (
      <span
        title={label}
        aria-label={label}
        style={{
          ...base,
          // A CSS triangle needs a zero-size content box — keeping base's 10px
          // width would paint a 20px-wide trapezoid next to the 10px markers.
          width: 0,
          height: 0,
          borderLeft: "5px solid transparent",
          borderRight: "5px solid transparent",
          borderBottom: `9px solid ${color}`,
        }}
      />
    );
  }
  return (
    <span
      title={label}
      aria-label={label}
      style={{
        ...base,
        background: color,
        borderRadius: tone === "success" ? "50%" : "2px",
      }}
    />
  );
}

/** Score bands shown as a legend under the gauge — pure numerals, no i18n needed. */
const SCORE_LEGEND: { range: string; tone: PerfTone }[] = [
  { range: "0–49", tone: "critical" },
  { range: "50–89", tone: "warning" },
  { range: "90–100", tone: "success" },
];

/**
 * Shared responsive grid for the field-data and lab-metric tiles. The generous
 * column gap (plus the 260px cap on the bars themselves) keeps neighbouring
 * bars from reading as one continuous strip.
 */
const FIELD_GRID_STYLE: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))",
  gap: "20px 56px",
};

/**
 * Below this age, re-measuring the same page is almost certainly an accident —
 * the merchant is asked first, because every run costs one of the plan's daily
 * runs (5/day on free).
 */
const RECENT_RUN_WINDOW_MS = 5 * 60 * 1000;

/** Synthetic accordion ids for the grouped rows (not Lighthouse audit ids). */
const ELEMENTS_FINDING_ID = "__elements__";
const PASSED_FINDING_ID = "__passed__";
const NOT_APPLICABLE_FINDING_ID = "__na__";

/**
 * Fixed order for the quality group headings, by Lighthouse group id (matched
 * on id, not translated title). Best practices: General → Trust and Safety →
 * Browser Compatibility → User Experience. Groups not listed (e.g. the
 * accessibility groups) keep PSI's own order after these.
 */
const QUALITY_GROUP_ORDER = [
  "best-practices-general",
  "best-practices-trust-safety",
  "best-practices-browser-compat",
  "best-practices-ux",
];

const FINDING_ROW_STYLE: CSSProperties = {
  borderTop: "1px solid var(--p-color-border-secondary, #e1e3e5)",
};

const FINDING_HEADER_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "12px",
  width: "100%",
  padding: "12px",
  background: "none",
  border: "none",
  textAlign: "left",
  cursor: "pointer",
  // <button> would otherwise fall back to the UA font, not Polaris's.
  font: "inherit",
  color: "inherit",
};

/**
 * Disclosure glyph for the findings accordion — the same ▼/▶ pair the SEO
 * overview uses for its expandable problem rows, so both read as one control.
 */
function DisclosureGlyph({ open }: { open: boolean }) {
  return (
    <Text as="span" tone="subdued" variant="bodySm">
      <span aria-hidden="true">{open ? "▼" : "▶"}</span>
    </Text>
  );
}

const FINDING_TITLE_STYLE: CSSProperties = { flex: "1 1 auto", minWidth: 0 };

/**
 * Plain, borderless toggle used to turn a group heading (h4) into a collapsible
 * one — the "Passed checks" / "Not applicable" summaries read as headings like
 * the real group sections, just clickable, with a caret marking that they open.
 */
const GROUP_TOGGLE_STYLE: CSSProperties = {
  display: "flex",
  width: "100%",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "6px",
  background: "none",
  border: "none",
  padding: 0,
  margin: 0,
  font: "inherit",
  color: "inherit",
  cursor: "pointer",
  textAlign: "left",
};

const CODE_TEXT_STYLE: CSSProperties = {
  fontFamily: "var(--p-font-family-mono, monospace)",
  fontSize: "12px",
  wordBreak: "break-word",
};

/** Sub-second durations read better as ms — PSI shows "480 ms", not "0,5 s".
 *
 * The locale is passed in rather than left to `toLocaleString()`'s default:
 * the server's default locale is not the browser's, so "1,234" vs "1.234"
 * would be a hydration mismatch wherever these render server-side (the RUM
 * table does). Same reasoning as formatNumber in utils/format.ts. */
function formatDuration(ms: number, locale: string): string {
  return ms < 1000 ? `${formatNumber(Math.round(ms), locale)} ms` : formatMs(ms, locale);
}

/** Path + query of a URL, tail-truncated, with the host returned separately. */
function splitUrl(raw: string): { path: string; host?: string } {
  try {
    const parsed = new URL(raw);
    const path = `${parsed.pathname}${parsed.search}`;
    return { path: path.length > 48 ? `…${path.slice(-48)}` : path, host: parsed.host };
  } catch {
    return { path: raw.length > 48 ? `…${raw.slice(-48)}` : raw };
  }
}

/**
 * Crop of one element out of the full-page screenshot — the same trick PSI uses
 * for its element thumbnails: scale the whole screenshot as a background and
 * offset it so the element's rect lands in the box. Renders nothing when
 * Lighthouse gave us no full-page screenshot (then there are no usable rects).
 */
function ElementThumb({
  screenshot,
  rect,
  size = 56,
}: {
  screenshot: PageSpeedScreenshot | null;
  rect?: PageSpeedRect;
  size?: number;
}) {
  if (!screenshot || !rect || !screenshot.width || !screenshot.height) return null;
  if (rect.width <= 0 || rect.height <= 0) return null;

  // Never upscale past 2x — a 10px element blown up to 56px is unreadable mush.
  const scale = Math.min(size / rect.width, size / rect.height, 2);
  const offsetX = (size - rect.width * scale) / 2 - rect.left * scale;
  const offsetY = (size - rect.height * scale) / 2 - rect.top * scale;

  return (
    <div
      style={{
        width: `${size}px`,
        height: `${size}px`,
        flexShrink: 0,
        backgroundImage: `url(${screenshot.data})`,
        backgroundSize: `${screenshot.width * scale}px ${screenshot.height * scale}px`,
        backgroundPosition: `${offsetX}px ${offsetY}px`,
        backgroundRepeat: "no-repeat",
        backgroundColor: "var(--p-color-bg-surface-secondary, #f6f6f7)",
        border: "1px solid var(--p-color-border, #e1e3e5)",
        borderRadius: "4px",
      }}
    />
  );
}

function FindingCellValue({
  cell,
  screenshot,
  locale,
}: {
  cell: PageSpeedCell | null;
  screenshot: PageSpeedScreenshot | null;
  locale: string;
}) {
  if (!cell) return null;
  switch (cell.type) {
    case "node": {
      const node = cell.node;
      if (!node) return null;
      return (
        <InlineStack gap="200" blockAlign="center" wrap={false}>
          <ElementThumb screenshot={screenshot} rect={node.rect} />
          <span style={CODE_TEXT_STYLE}>{node.label}</span>
        </InlineStack>
      );
    }
    case "url": {
      const { path, host } = splitUrl(cell.text ?? "");
      return (
        <span title={cell.text} style={{ wordBreak: "break-word" }}>
          {path}
          {host && (
            <span style={{ color: "var(--p-color-text-secondary, #6d7175)" }}>{` (${host})`}</span>
          )}
        </span>
      );
    }
    case "code":
      return <span style={CODE_TEXT_STYLE}>{cell.text}</span>;
    case "bytes":
      return <>{formatBytes(cell.value ?? 0, locale)}</>;
    case "ms":
      return <>{formatDuration(cell.value ?? 0, locale)}</>;
    case "numeric":
      return <>{formatNumber(cell.value ?? 0, locale)}</>;
    default:
      return <span style={{ wordBreak: "break-word" }}>{cell.text}</span>;
  }
}

const NUMERIC_CELL_TYPES = new Set(["bytes", "ms", "numeric"]);

/** The Lighthouse details table of one finding (URLs, sizes, durations, elements). */
function FindingTable({
  table,
  screenshot,
  truncatedLabel,
}: {
  table: PageSpeedTable;
  screenshot: PageSpeedScreenshot | null;
  truncatedLabel: string;
}) {
  const { locale } = useI18n();
  const hiddenRows = Math.max(0, table.rowTotal - table.rows.length);
  const cellStyle = (type: string): CSSProperties => ({
    padding: "6px 8px",
    textAlign: NUMERIC_CELL_TYPES.has(type) ? "right" : "left",
    verticalAlign: "middle",
    borderTop: "1px solid var(--p-color-border-secondary, #e1e3e5)",
  });

  return (
    <BlockStack gap="200">
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
          <thead>
            <tr>
              {table.columns.map((col, i) => (
                <th
                  key={i}
                  style={{
                    ...cellStyle(col.type),
                    borderTop: "none",
                    fontWeight: 600,
                    whiteSpace: "nowrap",
                  }}
                >
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, ri) => (
              <Fragment key={ri}>
                <tr>
                  {row.cells.map((cell, ci) => (
                    <td key={ci} style={cellStyle(table.columns[ci]?.type ?? "text")}>
                      <FindingCellValue cell={cell} screenshot={screenshot} locale={locale} />
                    </td>
                  ))}
                </tr>
                {row.subRows?.map((sub, si) => (
                  <tr key={`${ri}-${si}`}>
                    {sub.cells.map((cell, ci) => (
                      <td
                        key={ci}
                        style={{
                          ...cellStyle(cell?.type ?? table.columns[ci]?.type ?? "text"),
                          paddingLeft: ci === 0 ? "28px" : undefined,
                          color: "var(--p-color-text-secondary, #6d7175)",
                        }}
                      >
                        <FindingCellValue cell={cell} screenshot={screenshot} locale={locale} />
                      </td>
                    ))}
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      {hiddenRows > 0 && (
        <Text as="p" variant="bodySm" tone="subdued">
          {truncatedLabel.replace("{count}", String(hiddenRows))}
        </Text>
      )}
    </BlockStack>
  );
}

/**
 * Lighthouse's performance-score weights (unchanged across LH 10-13), in the
 * order PSI arranges them clockwise from 12 o'clock. They drive the arc lengths
 * of the split ring, so the picture matches how the score is actually computed.
 */
const SCORE_WEIGHTS: { id: PageSpeedMetricId; weight: number }[] = [
  { id: "fcp", weight: 0.1 },
  { id: "lcp", weight: 0.25 },
  { id: "tbt", weight: 0.3 },
  { id: "cls", weight: 0.25 },
  { id: "si", weight: 0.1 },
];

/** Defaults = the big lab gauge; the score strip passes smaller values (§3.3). */
const GAUGE_SIZE = 190;
const GAUGE_RADIUS = 58;
const GAUGE_STROKE = 8;
/** Degrees of empty space between two metric arcs. */
const GAUGE_ARC_GAP = 5;

/** Point on the gauge circle; 0° is 12 o'clock, growing clockwise. */
function gaugePoint(center: number, radius: number, degrees: number): [number, number] {
  const rad = ((degrees - 90) * Math.PI) / 180;
  return [center + radius * Math.cos(rad), center + radius * Math.sin(rad)];
}

function gaugeArc(center: number, radius: number, startDeg: number, endDeg: number): string {
  // A full circle can't be expressed as one arc — nudge it just short of 360.
  const end = endDeg - startDeg >= 360 ? startDeg + 359.99 : endDeg;
  const [x1, y1] = gaugePoint(center, radius, startDeg);
  const [x2, y2] = gaugePoint(center, radius, end);
  const largeArc = end - startDeg > 180 ? 1 : 0;
  return `M ${x1} ${y1} A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2}`;
}

/**
 * Lighthouse-style score gauge. Hovering splits the ring into one arc per
 * metric — arc length = that metric's weight in the score, fill = its own
 * score — which is how PSI explains where a score comes from. The split only
 * exists when `metrics` are passed; the small strip rings pass none.
 *
 * Size defaults are the big lab gauge; the score strip shrinks it via props.
 */
function ScoreGauge({
  score,
  label,
  metrics = [],
  size = GAUGE_SIZE,
  radius = GAUGE_RADIUS,
  stroke = GAUGE_STROKE,
  numberFontSize = 34,
  showLabel = true,
  neutralWhenNull = false,
}: {
  score: number | null;
  label: string;
  metrics?: PageSpeedMetric[];
  size?: number;
  radius?: number;
  stroke?: number;
  numberFontSize?: number;
  /** The strip rings carry their own caption outside the button (§3.3). */
  showLabel?: boolean;
  /**
   * Missing score → neutral grey ring instead of the warning tone. The strip
   * needs it ("no value" is not "50–89"); the big gauge keeps today's look.
   */
  neutralWhenNull?: boolean;
}) {
  const center = size / 2;
  const [showSplit, setShowSplit] = useState(false);
  const tone: PerfTone | null = score == null ? (neutralWhenNull ? null : "warning") : lighthouseTone(score);
  // Literal hex (not a CSS var) — the ring fill below appends an alpha suffix.
  const color = tone ? PERF_COLOR[tone] : "#8c9196";

  const metricById = new Map(metrics.map((m) => [m.id, m]));
  const available = SCORE_WEIGHTS.filter((w) => metricById.has(w.id));
  const weightTotal = available.reduce((sum, w) => sum + w.weight, 0);
  const splittable = available.length > 0 && weightTotal > 0;

  let cursor = 0;
  const segments = available.map((w) => {
    const start = cursor;
    const span = (w.weight / weightTotal) * 360;
    cursor += span;
    const metric = metricById.get(w.id)!;
    const metricScore = metric.score ?? 0;
    const segTone = metricTone(metric.score);
    const [labelX, labelY] = gaugePoint(center, radius + 20, start + span / 2);
    return {
      id: w.id,
      color: segTone ? PERF_COLOR[segTone] : "var(--p-color-border, #c9cccf)",
      from: start + GAUGE_ARC_GAP / 2,
      to: start + span - GAUGE_ARC_GAP / 2,
      filledTo: start + GAUGE_ARC_GAP / 2 + Math.max(0, span - GAUGE_ARC_GAP) * metricScore,
      labelX,
      labelY,
    };
  });

  return (
    <BlockStack gap="150" inlineAlign="center">
      <div
        style={{ position: "relative", width: `${size}px`, height: `${size}px` }}
        onMouseEnter={() => setShowSplit(true)}
        onMouseLeave={() => setShowSplit(false)}
      >
        <svg
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          role="img"
          aria-label={`${label}: ${score ?? "–"}`}
        >
          <circle cx={center} cy={center} r={radius} fill={`${color}1f`} />

          {/* Whole-score ring */}
          <g style={{ opacity: showSplit && splittable ? 0 : 1, transition: "opacity 150ms ease-in-out" }}>
            <path
              d={gaugeArc(center, radius, 0, 360)}
              fill="none"
              stroke={`${color}40`}
              strokeWidth={stroke}
            />
            {score != null && score > 0 && (
              <path
                d={gaugeArc(center, radius, 0, (score / 100) * 360)}
                fill="none"
                stroke={color}
                strokeWidth={stroke}
                strokeLinecap="round"
              />
            )}
          </g>

          {/* Per-metric ring, revealed on hover */}
          {splittable && (
            <g style={{ opacity: showSplit ? 1 : 0, transition: "opacity 150ms ease-in-out" }}>
              {segments.map((seg) => (
                <Fragment key={seg.id}>
                  <path
                    d={gaugeArc(center, radius, seg.from, seg.to)}
                    fill="none"
                    stroke={seg.color}
                    strokeWidth={stroke}
                    opacity={0.25}
                  />
                  {seg.filledTo > seg.from && (
                    <path
                      d={gaugeArc(center, radius, seg.from, seg.filledTo)}
                      fill="none"
                      stroke={seg.color}
                      strokeWidth={stroke}
                      strokeLinecap="round"
                    />
                  )}
                  <text
                    x={seg.labelX}
                    y={seg.labelY}
                    textAnchor="middle"
                    dominantBaseline="central"
                    fontSize="11"
                    fill="var(--p-color-text, #202223)"
                  >
                    {seg.id.toUpperCase()}
                  </text>
                </Fragment>
              ))}
            </g>
          )}
        </svg>
        <span
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: `${numberFontSize}px`,
            fontWeight: 500,
            color,
            pointerEvents: "none",
          }}
        >
          {score != null ? score : "–"}
        </span>
      </div>
      {showLabel && <Text as="span" variant="headingMd">{label}</Text>}
    </BlockStack>
  );
}

/** Strip ring geometry — pagespeed.web.dev's small category gauges (§3.3). */
const STRIP_GAUGE_SIZE = 48;
const STRIP_GAUGE_RADIUS = 20;
const STRIP_GAUGE_STROKE = 4;

/**
 * The category overview: one small ring per Lighthouse category, each in its
 * own bordered card that doubles as the section selector (the old tab list is
 * gone — these cards ARE the navigation, §3.3). The selected card is outlined
 * in the accent color and tinted; the others show a plain border and highlight
 * on hover so it reads as "these are clickable too". No hover ring split — the
 * weight story only exists for the performance score, told by the big gauge.
 */
function ScoreStrip({
  categories,
  selected,
  onSelect,
  scoreAriaLabel,
  noScoreAriaLabel,
}: {
  categories: { key: string; label: string; score: number | null }[];
  selected: number;
  onSelect: (index: number) => void;
  /** `strip.scoreAriaLabel` — placeholders {category} {score}. */
  scoreAriaLabel: string;
  /** `strip.noScore` — placeholder {category}. */
  noScoreAriaLabel: string;
}) {
  const [hovered, setHovered] = useState<number | null>(null);
  return (
    <InlineStack gap="400" align="center" blockAlign="stretch">
      {categories.map((cat, index) => {
        const active = index === selected;
        const isHovered = index === hovered;
        return (
          <button
            key={cat.key}
            type="button"
            onClick={() => onSelect(index)}
            onMouseEnter={() => setHovered(index)}
            onMouseLeave={() => setHovered((h) => (h === index ? null : h))}
            // aria-pressed, not aria-selected: the latter is only valid on
            // tab/option/gridcell/row roles, and there is no ARIA tablist here.
            aria-pressed={active}
            aria-label={
              cat.score != null
                ? scoreAriaLabel
                    .replace("{category}", cat.label)
                    .replace("{score}", String(cat.score))
                : noScoreAriaLabel.replace("{category}", cat.label)
            }
            style={{
              flex: "1 1 0",
              maxWidth: "220px",
              padding: "16px 20px",
              cursor: "pointer",
              font: "inherit",
              color: "inherit",
              textAlign: "center",
              borderRadius: "12px",
              border: `2px solid ${
                active
                  ? "var(--p-color-border-emphasis, #4a90e2)"
                  : isHovered
                    ? "var(--p-color-border-hover, #8c9196)"
                    : "var(--p-color-border, #c9cccf)"
              }`,
              background: active
                ? "var(--p-color-bg-surface-selected, #f2f7fe)"
                : "var(--p-color-bg-surface, #fff)",
              boxShadow: active
                ? "var(--p-shadow-200, 0 1px 3px rgba(0,0,0,0.12))"
                : "none",
              transition: "border-color 150ms ease-in-out, background 150ms ease-in-out",
            }}
          >
            <BlockStack gap="150" inlineAlign="center">
              <ScoreGauge
                score={cat.score}
                label={cat.label}
                size={STRIP_GAUGE_SIZE}
                radius={STRIP_GAUGE_RADIUS}
                stroke={STRIP_GAUGE_STROKE}
                numberFontSize={15}
                showLabel={false}
                neutralWhenNull
              />
              <Text as="span" variant="bodySm" fontWeight={active ? "semibold" : "regular"}>
                {cat.label}
              </Text>
            </BlockStack>
          </button>
        );
      })}
    </InlineStack>
  );
}

/** Synthetic accordion id for the collapsed manual-audits block per quality tab. */
const MANUAL_FINDING_ID = "manual";

/**
 * Alt-text bridge state + callbacks (plan §7), owned by the page component so
 * it survives tab switches, and handed down into the `image-alt` finding rows.
 */
interface AltTextBridgeState {
  /** url → match map from the `matchAltImages` intent; null while not loaded. */
  matches: Record<string, AltImageMatch | null> | null;
  /** url → outcome of a finished `generateAltText` call. */
  results: Record<string, { altText?: string; error?: string }>;
  /** URL whose generate call is currently in flight (spinner on that button). */
  pendingUrl: string | null;
  /** A generate call is running — every other generate button disables meanwhile. */
  busy: boolean;
  onGenerate: (url: string) => void;
  labels: { unmatched: string; success: string; error: string };
}

/**
 * One accessibility / best-practices finding — the same accordion row pattern
 * as the performance findings, so both tabs read as one tool. `image-alt`
 * items that were matched to a product image render a working "generate alt
 * text" button (plan §7); unmatched ones get an explanation instead of a dead
 * button.
 */
function QualityIssueRow({
  issue,
  open,
  onToggle,
  domId,
  itemsTruncatedLabel,
  tableRowsTruncatedLabel,
  generateAltTextLabel,
  altBridge,
  screenshot,
}: {
  issue: QualityIssue;
  open: boolean;
  onToggle: () => void;
  domId: string;
  itemsTruncatedLabel: string;
  tableRowsTruncatedLabel: string;
  generateAltTextLabel: string;
  altBridge?: AltTextBridgeState;
  /** Full-page screenshot for element thumbnail crops (null when unavailable). */
  screenshot: PageSpeedScreenshot | null;
}) {
  // image-alt keeps its flat list so the alt-text bridge button stays; every
  // other finding with a details table shows the richer table instead of the
  // sparse selector/snippet list.
  const showTable = !!issue.table && issue.id !== "image-alt";
  return (
    <div style={FINDING_ROW_STYLE}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={domId}
        style={FINDING_HEADER_STYLE}
      >
        <span style={FINDING_TITLE_STYLE}>
          <InlineStack gap="200" blockAlign="center" wrap>
            <ToneMarker tone={issue.score == null ? undefined : metricTone(issue.score)} />
            <Text as="span" variant="bodyMd" fontWeight="medium">{issue.title}</Text>
          </InlineStack>
        </span>
        <DisclosureGlyph open={open} />
      </button>
      <Collapsible open={open} id={domId} transition={false}>
        <div style={{ padding: "0 12px 16px" }}>
          <BlockStack gap="300">
            {issue.description && (
              <Text as="p" variant="bodySm" tone="subdued">{issue.description}</Text>
            )}
            {showTable && (
              <FindingTable
                table={issue.table!}
                screenshot={screenshot}
                truncatedLabel={tableRowsTruncatedLabel}
              />
            )}
            {!showTable && issue.items.length > 0 && (
              <BlockStack gap="300">
                {issue.items.map((item, i) => (
                  <InlineStack key={i} gap="200" blockAlign="start" wrap={false}>
                    {/* Element thumbnail crop, when the node maps into the
                        full-page screenshot (e.g. the flagged image of image-alt). */}
                    {item.rect && <ElementThumb screenshot={screenshot} rect={item.rect} />}
                  <BlockStack gap="050">
                    {item.selector && <span style={CODE_TEXT_STYLE}>{item.selector}</span>}
                    {item.snippet && (
                      <span
                        style={{
                          ...CODE_TEXT_STYLE,
                          color: "var(--p-color-text-secondary, #6d7175)",
                        }}
                      >
                        {item.snippet}
                      </span>
                    )}
                    {/* URL-only rows (e.g. errors-in-console sources) would
                        otherwise render blank — show the url whenever there is
                        no snippet already carrying it. */}
                    {item.url && !item.snippet && (
                      <span style={CODE_TEXT_STYLE}>{item.url}</span>
                    )}
                    {/* Alt-text bridge (plan §7): matched → live button;
                        matching not loaded yet → disabled button; loaded but
                        unmatched (theme asset, ambiguous stem, no mediaId) →
                        explanation instead of a dead button. A generated alt
                        text replaces the button with its success line. */}
                    {issue.id === "image-alt" && item.url && (() => {
                      const url = item.url;
                      const outcome = altBridge?.results[url];
                      if (outcome?.altText != null) {
                        return (
                          <InlineStack gap="150" blockAlign="center" wrap>
                            <Badge tone="success">✓</Badge>
                            <Text as="span" variant="bodySm">
                              {altBridge!.labels.success.replace("{altText}", outcome.altText)}
                            </Text>
                          </InlineStack>
                        );
                      }
                      const matchesLoaded = altBridge?.matches != null;
                      const match = matchesLoaded ? altBridge!.matches![url] : undefined;
                      if (matchesLoaded && !match) {
                        return (
                          <Text as="span" variant="bodySm" tone="subdued">
                            {altBridge!.labels.unmatched}
                          </Text>
                        );
                      }
                      return (
                        <BlockStack gap="100">
                          <InlineStack>
                            <Button
                              size="slim"
                              disabled={!match || altBridge?.busy}
                              loading={altBridge?.pendingUrl === url}
                              onClick={() => altBridge?.onGenerate(url)}
                            >
                              {generateAltTextLabel}
                            </Button>
                          </InlineStack>
                          {outcome?.error && (
                            <Text as="span" variant="bodySm" tone="critical">
                              {altBridge!.labels.error.replace("{error}", outcome.error)}
                            </Text>
                          )}
                        </BlockStack>
                      );
                    })()}
                  </BlockStack>
                  </InlineStack>
                ))}
                {issue.itemTotal > issue.items.length && (
                  <Text as="p" variant="bodySm" tone="subdued">
                    {itemsTruncatedLabel
                      .replace("{shown}", String(issue.items.length))
                      .replace("{total}", String(issue.itemTotal))}
                  </Text>
                )}
              </BlockStack>
            )}
          </BlockStack>
        </div>
      </Collapsible>
    </div>
  );
}

/**
 * Finding list of one quality category (a11y / best practices): automated
 * findings as accordion rows, then the manual audits collapsed under their own
 * header — they are unchecked check-points, not found errors, and mixing them
 * into the list would misread as failures.
 */
function QualityFindings({
  issues,
  manualIssues,
  advisory,
  passedAudits,
  notApplicable,
  total,
  keyPrefix,
  openFindings,
  onToggle,
  labels,
  altBridge,
  screenshot,
}: {
  /** Automated (non-manual) findings, already filtered. */
  issues: QualityIssue[];
  manualIssues: QualityIssue[];
  /** Informative advisory checks (gray-circle): no verdict, worth showing. */
  advisory?: QualityIssue[];
  /** Audits this category already passes, title-only. */
  passedAudits?: PageSpeedPassedAudit[];
  /** Audits that did not apply to this page, title-only. */
  notApplicable?: PageSpeedPassedAudit[];
  /** Category finding count before the server-side cap, manual excluded. */
  total: number;
  /** Namespaces accordion ids so a11y and best-practices rows never collide. */
  keyPrefix: string;
  openFindings: Set<string>;
  onToggle: (id: string) => void;
  labels: {
    noIssues: string;
    manualTitle: string;
    manualHint: string;
    itemsTruncated: string;
    tableRowsTruncated: string;
    findingsTruncated: string;
    generateAltText: string;
    passedTitle: string;
    notApplicableTitle: string;
  };
  /** Alt-text bridge (plan §7) — only the accessibility tab passes one. */
  altBridge?: AltTextBridgeState;
  /** Full-page screenshot for element thumbnail crops (null when unavailable). */
  screenshot: PageSpeedScreenshot | null;
}) {
  const manualKey = `${keyPrefix}-${MANUAL_FINDING_ID}`;
  const manualOpen = openFindings.has(manualKey);
  const passedKey = `${keyPrefix}-${PASSED_FINDING_ID}`;
  const passedOpen = openFindings.has(passedKey);
  const naKey = `${keyPrefix}-${NOT_APPLICABLE_FINDING_ID}`;
  const naOpen = openFindings.has(naKey);

  // Findings and advisory checks share PSI's group headings (Trust and Safety,
  // Browser Compatibility, …). Grouped by their group id and ordered by
  // QUALITY_GROUP_ORDER (General → Trust & Safety → Browser Compatibility → …);
  // groups not listed keep PSI's own order after them. The localized title is
  // taken from the first issue in each group. Ungrouped audits trail last.
  const graded = [...issues, ...(advisory ?? [])];
  const groupsById = new Map<string, { id: string; title?: string; items: QualityIssue[] }>();
  for (const it of graded) {
    const id = it.groupId ?? "";
    let entry = groupsById.get(id);
    if (!entry) {
      entry = { id, title: it.group, items: [] };
      groupsById.set(id, entry);
    }
    entry.items.push(it);
  }
  const orderRank = (id: string): number => {
    if (!id) return Number.MAX_SAFE_INTEGER; // ungrouped last
    const i = QUALITY_GROUP_ORDER.indexOf(id);
    return i === -1 ? Number.MAX_SAFE_INTEGER - 1 : i;
  };
  const orderedGroups = [...groupsById.values()].sort((a, b) => orderRank(a.id) - orderRank(b.id));

  return (
    <BlockStack gap="300">
      {graded.length === 0 ? (
        <Text as="p" variant="bodySm" tone="subdued">{labels.noIssues}</Text>
      ) : (
        <BlockStack gap="400">
          {orderedGroups.map((grp) => (
            <BlockStack key={grp.id || "__ungrouped__"} gap="150">
              {grp.title && (
                <Text as="h4" variant="headingSm" tone="subdued">{grp.title}</Text>
              )}
              <div>
                {grp.items.map((issue) => {
                  const rowKey = `${keyPrefix}-${issue.id}`;
                  return (
                    <QualityIssueRow
                      key={issue.id}
                      issue={issue}
                      open={openFindings.has(rowKey)}
                      onToggle={() => onToggle(rowKey)}
                      domId={`finding-${rowKey}`}
                      itemsTruncatedLabel={labels.itemsTruncated}
                      tableRowsTruncatedLabel={labels.tableRowsTruncated}
                      generateAltTextLabel={labels.generateAltText}
                      altBridge={altBridge}
                      screenshot={screenshot}
                    />
                  );
                })}
              </div>
            </BlockStack>
          ))}
          {/* Server cap (max 15 findings) — disclose it instead of letting a
              truncated list read as the complete picture. */}
          {total > issues.length && (
            <div>
              <Text as="p" variant="bodySm" tone="subdued">
                {labels.findingsTruncated
                  .replace("{shown}", String(issues.length))
                  .replace("{total}", String(total))}
              </Text>
            </div>
          )}
        </BlockStack>
      )}

      {manualIssues.length > 0 && (
        <div style={FINDING_ROW_STYLE}>
          <button
            type="button"
            onClick={() => onToggle(manualKey)}
            aria-expanded={manualOpen}
            aria-controls={`finding-${manualKey}`}
            style={FINDING_HEADER_STYLE}
          >
            <span style={FINDING_TITLE_STYLE}>
              <InlineStack gap="200" blockAlign="center" wrap={false}>
                <ToneMarker />
                <Text as="span" variant="bodyMd" fontWeight="medium">{labels.manualTitle}</Text>
              </InlineStack>
            </span>
            <DisclosureGlyph open={manualOpen} />
          </button>
          <Collapsible open={manualOpen} id={`finding-${manualKey}`} transition={false}>
            <div style={{ padding: "0 12px 16px" }}>
              <BlockStack gap="200">
                <Text as="p" variant="bodySm" tone="subdued">{labels.manualHint}</Text>
                {manualIssues.map((m) => (
                  <BlockStack key={m.id} gap="050">
                    <Text as="span" variant="bodySm" fontWeight="medium">{m.title}</Text>
                    {m.description && (
                      <Text as="span" variant="bodySm" tone="subdued">{m.description}</Text>
                    )}
                  </BlockStack>
                ))}
              </BlockStack>
            </div>
          </Collapsible>
        </div>
      )}

      {/* Passed checks — a heading like the group sections above, but
          collapsible; expanding shows the checks directly beneath it. */}
      {passedAudits && passedAudits.length > 0 && (
        <BlockStack gap="150">
          <Text as="h4" variant="headingSm" tone="subdued">
            <button
              type="button"
              onClick={() => onToggle(passedKey)}
              aria-expanded={passedOpen}
              aria-controls={`finding-${passedKey}`}
              style={GROUP_TOGGLE_STYLE}
            >
              <span>{labels.passedTitle.replace("{count}", String(passedAudits.length))}</span>
              <DisclosureGlyph open={passedOpen} />
            </button>
          </Text>
          <Collapsible open={passedOpen} id={`finding-${passedKey}`} transition={false}>
            <BlockStack gap="150">
              {passedAudits.map((a) => (
                <InlineStack key={a.id} gap="200" blockAlign="center" wrap={false}>
                  <ToneMarker tone="success" />
                  <Text as="span" variant="bodySm">{a.title}</Text>
                  {a.displayValue && (
                    <Text as="span" variant="bodySm" tone="subdued">{a.displayValue}</Text>
                  )}
                </InlineStack>
              ))}
            </BlockStack>
          </Collapsible>
        </BlockStack>
      )}

      {/* Not applicable — checks that did not apply to this page (gray in PSI).
          Same collapsible-heading treatment as the passed section. */}
      {notApplicable && notApplicable.length > 0 && (
        <BlockStack gap="150">
          <Text as="h4" variant="headingSm" tone="subdued">
            <button
              type="button"
              onClick={() => onToggle(naKey)}
              aria-expanded={naOpen}
              aria-controls={`finding-${naKey}`}
              style={GROUP_TOGGLE_STYLE}
            >
              <span>{labels.notApplicableTitle.replace("{count}", String(notApplicable.length))}</span>
              <DisclosureGlyph open={naOpen} />
            </button>
          </Text>
          <Collapsible open={naOpen} id={`finding-${naKey}`} transition={false}>
            <BlockStack gap="150">
              {notApplicable.map((a) => (
                <InlineStack key={a.id} gap="200" blockAlign="center" wrap={false}>
                  <ToneMarker />
                  <Text as="span" variant="bodySm" tone="subdued">{a.title}</Text>
                </InlineStack>
              ))}
            </BlockStack>
          </Collapsible>
        </BlockStack>
      )}
    </BlockStack>
  );
}

function formatMs(ms: number, locale: string): string {
  return `${formatNumber(ms / 1000, locale, { maximumFractionDigits: 1 })} s`;
}

function formatBytes(bytes: number, locale: string): string {
  return `${formatNumber(bytes / 1024, locale, { maximumFractionDigits: 0 })} KB`;
}

function pathOnly(url: string): string {
  try {
    return new URL(url).pathname || "/";
  } catch {
    return url;
  }
}

/**
 * Core Web Vitals thresholds (good / needs-improvement / poor) applied to the
 * RUM (real-user) p75 aggregates — same bands Google uses for LCP/CLS/INP.
 */
function cwvTone(value: number | null, goodMax: number, poorMin: number): "success" | "warning" | "critical" | undefined {
  if (value == null) return undefined;
  if (value <= goodMax) return "success";
  if (value > poorMin) return "critical";
  return "warning";
}

export default function SeoPerformance() {
  const { domain, products, collections, pages, history, rum, runsToday, dailyLimit, activeAudit, altTextAudit } =
    useLoaderData<typeof loader>();
  const { t, locale } = useI18n();
  const { handleNavigate } = useAppNavigation();
  // Audit timestamps are the merchant's local time — see useHydrated().
  const hydrated = useHydrated();
  const p = t.seo.performancePage;

  const fetcher = useFetcher<ActionResult>();
  const historyFetcher = useFetcher<ActionResult>();
  const deleteFetcher = useFetcher<DeleteHistoryResult>();

  // The run the loader says this page most recently kicked off (modeled as a
  // Task by the action). Used to restore the run on return: show its progress
  // while it runs, auto-open its result once it finishes. `useTaskCount` is the
  // app-wide task poller — it tells us the moment our run completes so we can
  // revalidate and pick up the finished audit's id.
  const revalidator = useRevalidator();
  const { recentlyCompletedTasks } = useTaskCount();
  // Guards the one-shot auto-open so it can't fight the merchant reopening a
  // different history row, or re-fire on every render.
  const autoOpenedRef = useRef(false);

  // History rows removed via the trash button. The loader data is static within
  // a session, so deleted ids are tracked here and filtered out of the table
  // optimistically (restored if the server rejects the delete).
  const [deletedHistoryIds, setDeletedHistoryIds] = useState<Set<string>>(new Set());
  // The id of the most recent delete submission, restored on server rejection.
  const lastDeletedIdRef = useRef<string | null>(null);

  const [selectedPath, setSelectedPath] = useState<string>("/");
  const [customUrl, setCustomUrl] = useState("");
  const [strategy, setStrategy] = useState<PageSpeedStrategy>("mobile");

  // Which past-run row is currently opened via the History table (null = user
  // is viewing the freshly-run audit / no history opened). Cleared by the
  // "back to latest" button in the historical banner.
  const [viewedHistoryId, setViewedHistoryId] = useState<string | null>(null);
  const [viewedHistoryResult, setViewedHistoryResult] = useState<PageSpeedAuditResult | null>(null);

  useEffect(() => {
    // `viewedHistoryId` is cleared when a fresh audit starts — without this
    // guard an in-flight history load would resolve afterwards and put the old
    // audit back on screen, hiding the run the merchant just triggered.
    if (viewedHistoryId && historyFetcher.state === "idle" && historyFetcher.data && historyFetcher.data.ok) {
      setViewedHistoryResult(historyFetcher.data.result);
    }
  }, [historyFetcher.state, historyFetcher.data, viewedHistoryId]);

  // Running a fresh audit closes any opened history view.
  useEffect(() => {
    if (fetcher.state !== "idle") {
      setViewedHistoryId(null);
      setViewedHistoryResult(null);
    }
  }, [fetcher.state]);

  const effectiveUrl = customUrl.trim() || selectedPath;

  const selectOptions = useMemo(
    () => [
      { label: p.homepageOption, value: "/" },
      {
        title: p.groupProducts,
        options: products.map((item) => ({ label: item.title || item.handle, value: `/products/${item.handle}` })),
      },
      {
        title: p.groupCollections,
        options: collections.map((item) => ({
          label: item.title || item.handle,
          value: `/collections/${item.handle}`,
        })),
      },
      {
        title: p.groupPages,
        options: pages.map((item) => ({ label: item.title || item.handle, value: `/pages/${item.handle}` })),
      },
    ],
    [products, collections, pages, p.homepageOption, p.groupProducts, p.groupCollections, p.groupPages],
  );

  const running = fetcher.state !== "idle";
  const loadingHistory = historyFetcher.state !== "idle";
  const data = fetcher.data;
  const liveResult = data && data.ok ? data.result : null;
  // Historical selection wins visually: when a history row is opened, the
  // result block shows that stored audit and the banner explains it.
  const result = viewedHistoryResult ?? liveResult;
  const isHistorical = viewedHistoryResult != null;
  const errorMessage =
    data && !data.ok
      ? data.error === "invalidUrl"
        ? p.errors.invalidUrl
        : data.error === "quotaExceeded"
          ? p.errors.quotaExceeded
          : data.error === "dailyLimitReached"
            ? p.errors.dailyLimitReached.replace("{limit}", String(dailyLimit))
            : `${p.errors.auditFailed}${data.detail ? `: ${data.detail}` : ""}`
      : null;

  // Loader snapshot, so it does not tick down within a session — the action
  // re-counts and is authoritative. Good enough to disable the button and show
  // the merchant where they stand before they click.
  const budgetExhausted = runsToday >= dailyLimit;
  const runsLeft = Math.max(0, dailyLimit - runsToday);

  // A run this page kicked off is still going server-side, but no fetcher is
  // in flight here (the merchant navigated away and back). Drives the same
  // "running" affordances as a live submission. Suppressed once a fresh on-page
  // run is in flight or has produced a result.
  const showRestoredRunning =
    !!activeAudit && activeAudit.status === "running" && !running && !data;

  const openHistoryEntry = (entry: (typeof history)[number]) => {
    // Mirror the row's URL + strategy into the controls so "Re-test" naturally
    // targets the same page the merchant is looking at.
    setStrategy(entry.strategy);
    const path = pathOnly(entry.url);
    setCustomUrl("");
    setSelectedPath(path);
    setViewedHistoryId(entry.id);
    historyFetcher.submit(
      { intent: "loadHistory", auditId: entry.id },
      { method: "post" },
    );
  };

  const closeHistoryView = () => {
    setViewedHistoryId(null);
    setViewedHistoryResult(null);
  };

  // Return-to-page restore, half 1: a run that finished while the merchant was
  // away auto-opens its result (the same path a history-row click takes), once.
  // Skipped when a fresh on-page run is showing or the merchant already opened a
  // history row, so it never yanks the view out from under them.
  useEffect(() => {
    if (autoOpenedRef.current) return;
    const auditId = activeAudit?.status === "completed" ? activeAudit.auditId : null;
    if (!auditId) return;
    if (data || viewedHistoryId) return;
    const entry = history.find((h) => h.id === auditId);
    if (!entry) return;
    autoOpenedRef.current = true;
    openHistoryEntry(entry);
    // One-shot restore keyed on the loader's active audit; the rest is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeAudit, data, viewedHistoryId, history]);

  // Return-to-page restore, half 2: while the run is still going, the app-wide
  // task poller tells us the moment it completes — pull fresh loader data so
  // `activeAudit` flips to "completed" (with its audit id) and half 1 can open
  // the result.
  useEffect(() => {
    const taskId = activeAudit?.status === "running" ? activeAudit.taskId : null;
    if (!taskId) return;
    if (recentlyCompletedTasks.some((task) => task.id === taskId) && revalidator.state === "idle") {
      revalidator.revalidate();
    }
  }, [activeAudit, recentlyCompletedTasks, revalidator]);

  const deleteHistoryEntry = (id: string) => {
    // Close the result view if the deleted run is the one on screen.
    if (id === viewedHistoryId) closeHistoryView();
    // Optimistic: hide the row immediately, restore it if the server rejects.
    lastDeletedIdRef.current = id;
    setDeletedHistoryIds((prev) => new Set(prev).add(id));
    deleteFetcher.submit(
      { intent: "deleteHistory", auditId: id },
      { method: "post" },
    );
  };

  // A rejected delete puts that one row back so a failed removal is never silent.
  useEffect(() => {
    if (deleteFetcher.state === "idle" && deleteFetcher.data && !deleteFetcher.data.ok) {
      const failedId = lastDeletedIdRef.current;
      if (failedId) {
        setDeletedHistoryIds((prev) => {
          const next = new Set(prev);
          next.delete(failedId);
          return next;
        });
      }
    }
  }, [deleteFetcher.state, deleteFetcher.data]);

  const submitAudit = (force: boolean) => {
    fetcher.submit(
      { intent: "runAudit", url: effectiveUrl, strategy, force: force ? "1" : "0" },
      { method: "post" },
    );
  };

  // Absolute form of what the controls currently target, so it can be compared
  // with the stored (always absolute) audit URLs.
  const targetUrl = effectiveUrl.startsWith("/") ? `https://${domain}${effectiveUrl}` : effectiveUrl;

  /**
   * Newest run of exactly this page+strategy that is younger than the window —
   * either the audit on screen or a row from the history table. Drives the
   * "you just measured this" confirmation.
   */
  const recentRun = useMemo(() => {
    const normalize = (u: string) => u.trim().replace(/\/+$/, "").toLowerCase();
    const target = normalize(targetUrl);
    const candidates: { id: string | null; at: number }[] = [];

    for (const entry of history) {
      if (entry.strategy !== strategy || normalize(entry.url) !== target) continue;
      candidates.push({ id: entry.id, at: new Date(entry.createdAt).getTime() });
    }
    // The run currently on screen is newer than the loader's history snapshot.
    if (result && result.strategy === strategy && normalize(result.url) === target) {
      candidates.push({ id: null, at: new Date(result.fetchedAt).getTime() });
    }

    const newest = candidates.sort((a, b) => b.at - a.at)[0];
    if (!newest || Number.isNaN(newest.at)) return null;
    const age = Date.now() - newest.at;
    return age >= 0 && age < RECENT_RUN_WINDOW_MS ? { ...newest, age } : null;
  }, [history, result, strategy, targetUrl]);

  const [confirmRerun, setConfirmRerun] = useState(false);

  // Every run the merchant asks for is a real measurement — the only thing
  // standing between two clicks and two consumed runs is this confirmation.
  const requestAudit = () => {
    if (recentRun) {
      setConfirmRerun(true);
      return;
    }
    submitAudit(true);
  };

  const showPreviousRun = () => {
    setConfirmRerun(false);
    if (!recentRun?.id) return; // already on screen
    const entry = history.find((h) => h.id === recentRun.id);
    if (entry) openHistoryEntry(entry);
  };

  const strategyLabel = (s: PageSpeedStrategy) => (s === "desktop" ? p.strategyDesktop : p.strategyMobile);

  // History/banner/score-header display of the tested URL: swap the bare "/"
  // for the same friendly homepage label used in the picker dropdown, so past
  // runs of the homepage read as "Homepage"/"Startseite" instead of "/".
  const displayPath = (url: string): string => {
    const path = pathOnly(url);
    return path === "/" ? p.homepageOption : path;
  };

  const annotatable = !!result?.screenshot?.fullPage;
  const visibleHistory = history
    .filter((entry) => !deletedHistoryIds.has(entry.id))
    .slice(0, HISTORY_VISIBLE_LIMIT);

  // Both lists are capped server-side; disclose how much was left out instead
  // of letting a truncated list read as the complete picture. `?? 0` covers
  // audits stored before these totals existed.
  const hiddenAnnotations = Math.max(0, (result?.annotationTotal ?? 0) - (result?.annotations.length ?? 0));
  const hiddenOpportunities = Math.max(0, (result?.opportunityTotal ?? 0) - (result?.opportunities.length ?? 0));

  // Real-user (CrUX) rows, in PSI's own order. CLS is reported as value*100 per
  // CrUX convention, everything else is milliseconds.
  // `group` splits them the way PSI does: the three Core Web Vitals first, the
  // supporting metrics under their own heading.
  const fieldRows = useMemo(() => {
    const fd = result?.fieldData;
    if (!fd) return [];
    // `format` is handed on as a (value) => string, so the locale is bound here
    // rather than threaded through FieldMetricBar.
    const duration = (v: number) => formatDuration(v, locale);
    return (
      [
        { key: "lcp", group: "core", label: p.fieldMetricNames.lcp, metric: fd.lcp, format: duration },
        { key: "inp", group: "core", label: p.fieldMetricNames.inp, metric: fd.inp, format: duration },
        {
          key: "cls",
          group: "core",
          label: p.fieldMetricNames.cls,
          metric: fd.cls,
          format: (v: number) => (v / 100).toFixed(2),
        },
        { key: "fcp", group: "other", label: p.fieldMetricNames.fcp, metric: fd.fcp, format: duration },
        { key: "ttfb", group: "other", label: p.fieldMetricNames.ttfb, metric: fd.ttfb, format: duration },
      ] as const
    ).filter((row) => !!row.metric);
  }, [result, p.fieldMetricNames, locale]);

  const coreFieldRows = fieldRows.filter((row) => row.group === "core");
  const otherFieldRows = fieldRows.filter((row) => row.group === "other");

  const renderFieldMetric = (row: (typeof fieldRows)[number]) => {
    const metric = row.metric!;
    const tone = FIELD_CATEGORY_TONE[metric.category];
    return (
      <BlockStack key={row.key} gap="100">
        <InlineStack gap="150" blockAlign="center" wrap={false}>
          <ToneMarker tone={tone} label={p.fieldCategory[metric.category]} />
          <Text as="span" variant="bodyMd">{row.label}</Text>
          <HelpTooltip helpKey={FIELD_HELP_KEYS[row.key]} position="below" />
        </InlineStack>
        <div
          style={{
            fontSize: "22px",
            lineHeight: "28px",
            maxWidth: "260px",
            textAlign: "center",
            color: PERF_COLOR[tone],
          }}
        >
          {row.format(metric.percentile)}
        </div>
        <FieldMetricBar
          metricKey={row.key}
          percentile={metric.percentile}
          distributions={metric.distributions}
          format={row.format}
          fallbackHint={p.fieldBarNoDistribution}
        />
      </BlockStack>
    );
  };

  // Toggle for the "Learn more" panel under the no-highlight banner. Reset
  // whenever the underlying result changes so it doesn't leak between runs.
  const [showNoHighlightReason, setShowNoHighlightReason] = useState(false);
  useEffect(() => {
    setShowNoHighlightReason(false);
  }, [result]);

  // Which findings are expanded. Reset per result, with the first (biggest
  // saving — the list is sorted) open so the section isn't a wall of headers.
  const [openFindings, setOpenFindings] = useState<Set<string>>(new Set());
  useEffect(() => {
    setOpenFindings(new Set(result?.opportunities.slice(0, 1).map((o) => o.id) ?? []));
  }, [result]);
  const toggleFinding = (id: string) =>
    setOpenFindings((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Element thumbnails can only be cropped from the full-page screenshot — the
  // viewport fallback has no matching coordinate space (see pagespeed.types.ts).
  const cropSource = result?.screenshot?.fullPage ? result.screenshot : null;
  // Audits stored before `previewScreenshot` existed only have `screenshot`.
  const previewScreenshot = result?.previewScreenshot ?? result?.screenshot ?? null;

  // §3.8: the tab choice survives a new test run on purpose — whoever re-tests
  // while on "Accessibility" wants the new accessibility result, not the speed
  // tab again.
  const [selectedTab, setSelectedTab] = useState(0);

  // Runs stored before the quality categories existed carry no `quality` —
  // tabs 2/3 then show an explicit empty state instead of a bare blank (§3.8).
  const quality = result?.quality;
  const a11yAutomated = useMemo(
    () => (quality?.accessibility ?? []).filter((i) => !i.manual),
    [quality],
  );
  const a11yManual = useMemo(
    () => (quality?.accessibility ?? []).filter((i) => i.manual),
    [quality],
  );
  const bpAutomated = useMemo(
    () => (quality?.bestPractices ?? []).filter((i) => !i.manual),
    [quality],
  );
  const bpManual = useMemo(
    () => (quality?.bestPractices ?? []).filter((i) => i.manual),
    [quality],
  );

  // ── Alt-text bridge (plan §7) ─────────────────────────────────────────────
  // Image URLs of the current result's `image-alt` findings, deduplicated —
  // the payload of the `matchAltImages` intent.
  const altImageUrls = useMemo(() => {
    const urls: string[] = [];
    for (const issue of quality?.accessibility ?? []) {
      if (issue.id !== "image-alt") continue;
      for (const item of issue.items) {
        if (item.url && !urls.includes(item.url)) urls.push(item.url);
      }
    }
    return urls;
  }, [quality]);

  const altMatchFetcher = useFetcher<MatchAltImagesResult>();
  const altGenFetcher = useFetcher<GenerateAltTextResult>();
  // url → match; null until the matchAltImages round-trip finished (buttons
  // stay disabled meanwhile — never a live button before the match is known).
  const [altMatches, setAltMatches] = useState<Record<string, AltImageMatch | null> | null>(null);
  // url → generated alt text / error. Success replaces the row's button, so a
  // fixed image is not offered again. Deliberately NOT reset on result
  // switches: an alt text saved to Shopify stays saved no matter which run
  // (live or historical) is currently displayed — clearing this would offer
  // the button again for an image that was just fixed.
  const [altGenResults, setAltGenResults] = useState<Record<string, { altText?: string; error?: string }>>({});
  const [altGenPendingUrl, setAltGenPendingUrl] = useState<string | null>(null);

  // Stable identity of the displayed run. Keying the match effect on the
  // result OBJECT would refire when "back to current test" swaps the same
  // live result back in (new render, same run) and needlessly rematch.
  const resultKey = result ? `${result.url}|${result.strategy}|${result.fetchedAt}` : null;

  // A different run (fresh test or history load) voids the match map and —
  // when it carries image-alt findings — kicks off one matching round-trip.
  useEffect(() => {
    setAltMatches(null);
    setAltGenPendingUrl(null);
    if (altImageUrls.length > 0) {
      altMatchFetcher.submit(
        { intent: "matchAltImages", imageUrls: JSON.stringify(altImageUrls) },
        { method: "post" },
      );
    }
    // Matching belongs to the run switch — not to fetcher identity churn,
    // and altImageUrls is derived from the same result.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resultKey]);

  useEffect(() => {
    if (altMatchFetcher.state === "idle" && altMatchFetcher.data?.ok) {
      setAltMatches(altMatchFetcher.data.matches);
    }
  }, [altMatchFetcher.state, altMatchFetcher.data]);

  const generateAltTextFor = (url: string) => {
    const match = altMatches?.[url];
    if (!match || altGenFetcher.state !== "idle") return;
    setAltGenPendingUrl(url);
    altGenFetcher.submit(
      {
        intent: "generateAltText",
        mediaId: match.mediaId,
        imageUrl: url,
        productTitle: match.productTitle,
      },
      { method: "post" },
    );
  };

  useEffect(() => {
    // Same guard pattern as the history fetcher above: only record a result
    // while a submission is actually pending, so stale fetcher data from an
    // earlier click can't be re-applied.
    if (altGenPendingUrl && altGenFetcher.state === "idle" && altGenFetcher.data) {
      const data = altGenFetcher.data;
      setAltGenResults((prev) => ({
        ...prev,
        [altGenPendingUrl]: data.ok ? { altText: data.altText } : { error: data.error },
      }));
      setAltGenPendingUrl(null);
    }
  }, [altGenFetcher.state, altGenFetcher.data, altGenPendingUrl]);

  // The three category cards carry these captions (§3.3) — same keys as the
  // former tab list, which they replaced.
  const stripCategories = [
    { key: "performance", label: p.tabs.performance, score: result?.performanceScore ?? null },
    { key: "accessibility", label: p.tabs.accessibility, score: quality?.a11yScore ?? null },
    { key: "bestPractices", label: p.tabs.bestPractices, score: quality?.bestPracticesScore ?? null },
  ];

  const qualityFindingLabels = {
    manualTitle: p.a11y.manualTitle,
    manualHint: p.a11y.manualHint,
    itemsTruncated: p.a11y.itemsTruncated,
    tableRowsTruncated: p.tableRowsTruncated,
    findingsTruncated: p.a11y.findingsTruncated,
    generateAltText: p.a11y.generateAltText,
    passedTitle: p.passedTitle,
    notApplicableTitle: p.notApplicableTitle,
  };

  // Handed only to the accessibility tab — image-alt is an a11y-only audit.
  const altTextBridge: AltTextBridgeState = {
    matches: altMatches,
    results: altGenResults,
    pendingUrl: altGenPendingUrl,
    busy: altGenFetcher.state !== "idle",
    onGenerate: generateAltTextFor,
    labels: {
      unmatched: p.a11y.altTextUnmatched,
      success: p.a11y.altTextSuccess,
      error: p.a11y.altTextError,
    },
  };

  return (
    <SeoSectionLayout sectionId="performance">
      <BlockStack gap="400">
        <SeoHelpBanner title={p.helpTitle}>
          <BlockStack gap="200">
            <Text as="p" variant="bodyMd">{p.helpBody1}</Text>
            <Text as="p" variant="bodyMd">{p.helpBody2}</Text>
          </BlockStack>
        </SeoHelpBanner>

        {/* Controls */}
        <Card>
          <BlockStack gap="300">
            <Text as="h3" variant="headingMd">{p.controlsTitle}</Text>
            <InlineStack gap="200" blockAlign="end" wrap>
              <div style={{ minWidth: "260px", flex: "1 1 260px" }}>
                <Select
                  label={p.pageLabel}
                  options={selectOptions as any}
                  value={selectedPath}
                  onChange={setSelectedPath}
                  disabled={!!customUrl.trim()}
                />
              </div>
              <div style={{ minWidth: "260px", flex: "1 1 260px" }}>
                <TextField
                  label={p.customUrlLabel}
                  autoComplete="off"
                  placeholder={p.customUrlPlaceholder}
                  value={customUrl}
                  onChange={setCustomUrl}
                />
              </div>
              <div style={{ minWidth: "180px" }}>
                <Text as="span" variant="bodyMd">{p.strategyLabel}</Text>
                <ButtonGroup variant="segmented">
                  <Button pressed={strategy === "mobile"} onClick={() => setStrategy("mobile")}>
                    {p.strategyMobile}
                  </Button>
                  <Button pressed={strategy === "desktop"} onClick={() => setStrategy("desktop")}>
                    {p.strategyDesktop}
                  </Button>
                </ButtonGroup>
              </div>
              <Button
                variant="primary"
                loading={running || showRestoredRunning}
                disabled={!effectiveUrl || budgetExhausted || showRestoredRunning}
                onClick={requestAudit}
              >
                {p.testButton}
              </Button>
              {/* Right where the decision is made: what a click costs and what
                  is left. `runsToday` comes from the loader, which Remix
                  revalidates after each run. */}
              <div style={{ paddingBottom: "6px" }}>
                <Badge tone={budgetExhausted ? "critical" : runsLeft <= 1 ? "attention" : undefined}>
                  {p.budgetBadge
                    .replace("{remaining}", String(runsLeft))
                    .replace("{limit}", String(dailyLimit))}
                </Badge>
              </div>
            </InlineStack>
            {(running || showRestoredRunning) && (
              <Text as="p" variant="bodySm" tone="subdued">
                {showRestoredRunning ? p.stillRunningHint : p.runningHint}
              </Text>
            )}
            {budgetExhausted && (
              <Text as="p" variant="bodySm" tone="caution">
                {p.budgetExhausted
                  .replace("{used}", String(runsToday))
                  .replace("{limit}", String(dailyLimit))}
              </Text>
            )}
          </BlockStack>
        </Card>

        {/* Asked before a run that would almost certainly repeat one the
            merchant already has — a run they cannot get back. */}
        <Modal
          open={confirmRerun}
          onClose={() => setConfirmRerun(false)}
          title={p.recentRunTitle}
          primaryAction={{ content: p.recentRunViewAction, onAction: showPreviousRun }}
          secondaryActions={[
            {
              content: p.recentRunRerunAction,
              onAction: () => {
                setConfirmRerun(false);
                submitAudit(true);
              },
            },
            { content: p.recentRunCancelAction, onAction: () => setConfirmRerun(false) },
          ]}
        >
          <Modal.Section>
            <BlockStack gap="200">
              <Text as="p" variant="bodyMd">
                {p.recentRunBody
                  .replace("{url}", displayPath(targetUrl))
                  .replace("{strategy}", strategyLabel(strategy))
                  .replace("{minutes}", String(Math.max(1, Math.round((recentRun?.age ?? 0) / 60000))))}
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                {p.recentRunBudgetHint
                  .replace("{used}", String(runsToday))
                  .replace("{limit}", String(dailyLimit))}
              </Text>
            </BlockStack>
          </Modal.Section>
        </Modal>

        {errorMessage && <Banner tone="critical">{errorMessage}</Banner>}

        {result && (
          <Card>
            <BlockStack gap="400">
              {/* §3.2 — everything that applies to all tabs sits above the tab
                  list; the historical note is a one-liner, not a banner. */}
              {isHistorical && (
                <InlineStack gap="200" blockAlign="center" wrap>
                  <Text as="span" variant="bodySm" tone="subdued">
                    {p.viewingHistoryHint
                      .replace("{date}", formatDateTime(result.fetchedAt, hydrated))
                      .replace("{url}", displayPath(result.url))
                      .replace("{strategy}", strategyLabel(result.strategy))}
                  </Text>
                  <Button variant="plain" onClick={closeHistoryView}>{p.viewingHistoryBack}</Button>
                </InlineStack>
              )}
              {result.stale && !isHistorical && (
                <Banner tone="warning">
                  {result.staleReason === "dailyLimit"
                    ? p.staleDailyLimitNotice.replace("{limit}", String(dailyLimit))
                    : p.staleQuotaNotice}
                </Banner>
              )}
              {/* Lighthouse could not analyse the page at all — that empties
                  every category, not just speed, so the notice sits above the
                  tabs. PSI still answers HTTP 200 in that case, so without it
                  the run renders as an empty result with a "–" score. */}
              {result.runtimeError && (
                <Banner tone="critical" title={p.runtimeErrorTitle}>
                  <BlockStack gap="200">
                    <Text as="p" variant="bodyMd">{p.runtimeErrorBody}</Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      {p.runtimeErrorDetail.replace("{message}", result.runtimeError)}
                    </Text>
                  </BlockStack>
                </Banner>
              )}
              {/* Caveats about the run itself — they apply to every tab. */}
              {result.runWarnings && result.runWarnings.length > 0 && (
                <Banner tone="warning" title={p.runWarningsTitle}>
                  <BlockStack gap="100">
                    {result.runWarnings.map((w, i) => (
                      <Text key={i} as="p" variant="bodySm">{w}</Text>
                    ))}
                  </BlockStack>
                </Banner>
              )}

              {/* Which page these numbers belong to — full scanned URL, device
                  and time, pinned above the scores so the result is never
                  ambiguous no matter which category is open. */}
              <div
                style={{
                  padding: "12px 16px",
                  borderRadius: "8px",
                  border: "1px solid var(--p-color-border, #c9cccf)",
                  background: "var(--p-color-bg-surface-secondary, #f6f6f7)",
                }}
              >
                <InlineStack gap="300" align="space-between" blockAlign="center" wrap>
                  <InlineStack gap="200" blockAlign="baseline" wrap>
                    <Text as="span" variant="bodySm" tone="subdued" fontWeight="medium">
                      {p.scannedUrlLabel}
                    </Text>
                    <Text as="span" variant="bodyMd" fontWeight="semibold" breakWord>
                      {result.url}
                    </Text>
                  </InlineStack>
                  <InlineStack gap="200" blockAlign="center">
                    <Badge>{strategyLabel(result.strategy)}</Badge>
                    <Text as="span" variant="bodySm" tone="subdued">
                      {formatDateTime(result.fetchedAt, hydrated)}
                    </Text>
                  </InlineStack>
                </InlineStack>
                {result.finalUrl && (
                  <div style={{ marginTop: "4px" }}>
                    <Text as="span" variant="bodySm" tone="caution">
                      {p.redirectNotice.replace("{url}", result.finalUrl)}
                    </Text>
                  </div>
                )}
              </div>

              {/* §3.3 — the three category cards ARE the section selector; the
                  selected card is outlined in the accent color, the panel below
                  shows that category's detail. */}
              <ScoreStrip
                categories={stripCategories}
                selected={selectedTab}
                onSelect={setSelectedTab}
                scoreAriaLabel={p.strip.scoreAriaLabel}
                noScoreAriaLabel={p.strip.noScore}
              />

              <div>
                {selectedTab === 0 && (
                <BlockStack gap="500">
            {/* Real-user (CrUX) field data — leads the result the way PSI does,
                full width, one threshold bar per metric. */}
            {result.fieldData && (
              <>
                <BlockStack gap="500">
                  <InlineStack gap="300" blockAlign="center" wrap>
                    <Text as="h4" variant="headingSm" tone="subdued">{p.fieldDataTitle}</Text>
                    {/* CrUX's aggregate verdict — the "passed / did not pass
                        the Core Web Vitals assessment" line PSI leads with. */}
                    {result.fieldData.overallCategory && (
                      <InlineStack gap="150" blockAlign="center">
                        <Text as="span" variant="bodyMd">{p.fieldOverallLabel}:</Text>
                        <Badge tone={FIELD_CATEGORY_TONE[result.fieldData.overallCategory]}>
                          {result.fieldData.overallCategory === "FAST"
                            ? p.fieldOverallPass
                            : p.fieldOverallFail}
                        </Badge>
                      </InlineStack>
                    )}
                  </InlineStack>

                  <div style={FIELD_GRID_STYLE}>{coreFieldRows.map(renderFieldMetric)}</div>

                  {otherFieldRows.length > 0 && (
                    <BlockStack gap="400">
                      <Divider />
                      <Text as="h4" variant="headingSm" tone="subdued">{p.fieldOtherTitle}</Text>
                      <div style={FIELD_GRID_STYLE}>{otherFieldRows.map(renderFieldMetric)}</div>
                    </BlockStack>
                  )}

                  {result.fieldData.originFallback && (
                    <Text as="p" variant="bodySm" tone="subdued">{p.fieldOriginFallback}</Text>
                  )}
                </BlockStack>
                <Divider />
              </>
            )}

            {/* Lab result (this run) — gauge + the measured metrics. Former
                own Card, now a section of the tab (§3.4). */}
              <BlockStack gap="500">
                {/* Two halves: score left, captured page right, each centred in
                    its own half with a hairline between them. */}
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: previewScreenshot ? "minmax(0, 1fr) auto minmax(0, 1fr)" : "1fr",
                    alignItems: "center",
                    justifyItems: "center",
                    gap: "24px",
                  }}
                >
                  <BlockStack gap="300" inlineAlign="center">
                    <ScoreGauge
                      score={result.performanceScore}
                      label={p.scoreTitle}
                      metrics={result.metrics}
                    />
                    <div style={{ textAlign: "center", maxWidth: "340px" }}>
                      <BlockStack gap="200" inlineAlign="center">
                        <Text as="p" variant="bodySm" tone="subdued">
                          {p.testedLabel
                            .replace("{url}", displayPath(result.url))
                            .replace("{strategy}", strategyLabel(result.strategy))
                            .replace("{date}", formatDateTime(result.fetchedAt, hydrated))}
                          {/* PROBE (accessibility plan §5.1): scan duration to the
                              right of the timestamp. Absent on runs stored before
                              this probe. Temporary — remove with §5.1. */}
                          {result.scanDurationMs != null &&
                            ` · Scandauer: ${(result.scanDurationMs / 1000).toFixed(1)} s`}
                        </Text>
                        {result.finalUrl && (
                          <Text as="p" variant="bodySm" tone="caution">
                            {p.redirectNotice.replace("{url}", result.finalUrl)}
                          </Text>
                        )}
                        <InlineStack gap="300" wrap align="center">
                          {SCORE_LEGEND.map((entry) => (
                            <InlineStack key={entry.range} gap="100" blockAlign="center">
                              <ToneMarker tone={entry.tone} />
                              <Text as="span" variant="bodySm" tone="subdued">{entry.range}</Text>
                            </InlineStack>
                          ))}
                        </InlineStack>
                      </BlockStack>
                    </div>
                  </BlockStack>

                  {previewScreenshot && (
                    <div
                      style={{
                        width: "1px",
                        alignSelf: "stretch",
                        background: "var(--p-color-border-secondary, #e1e3e5)",
                      }}
                    />
                  )}

                  {/* Prefer the viewport shot — `screenshot` is the full-page
                      capture and would only show a top slice here. Element crops
                      are drawn per finding below, not here. */}
                  {previewScreenshot && (
                    <div
                      style={{
                        width: "min(100%, 240px)",
                        maxHeight: "320px",
                        overflow: "hidden",
                        border: "1px solid var(--p-color-border, #e1e3e5)",
                        borderRadius: "8px",
                      }}
                    >
                      <img src={previewScreenshot.data} alt="" style={{ width: "100%", display: "block" }} />
                    </div>
                  )}
                </div>

                <Divider />

                <Text as="h4" variant="headingSm" tone="subdued">{p.metricsTitle}</Text>
                <div style={FIELD_GRID_STYLE}>
                  {result.metrics.map((m) => {
                    const helpKey = METRIC_HELP_KEYS[m.id as PageSpeedMetricId];
                    const tone = metricTone(m.score);
                    return (
                      <BlockStack key={m.id} gap="100">
                        <InlineStack gap="150" blockAlign="center" wrap={false}>
                          <ToneMarker tone={tone} />
                          <Text as="span" variant="bodyMd">
                            {p.metricNames[m.id as PageSpeedMetricId] || m.id}
                          </Text>
                          {helpKey && <HelpTooltip helpKey={helpKey} position="below" />}
                        </InlineStack>
                        <div
                          style={{
                            fontSize: "22px",
                            lineHeight: "28px",
                            color: tone ? PERF_COLOR[tone] : undefined,
                          }}
                        >
                          {m.displayValue}
                        </div>
                      </BlockStack>
                    );
                  })}
                </div>
              </BlockStack>

            {/* No element screenshot — concerns only the element crops in this
                tab, so the banner stays inside it (§3.2). */}
            {!annotatable && (
              <Banner
                tone="info"
                title={p.noHighlightTitle}
                action={{
                  content: p.noHighlightRetryAction,
                  onAction: () => submitAudit(true),
                  loading: running,
                }}
              >
                <BlockStack gap="200">
                  <Text as="p" variant="bodyMd">{p.noHighlightBody}</Text>
                  <InlineStack>
                    <Button
                      variant="plain"
                      onClick={() => setShowNoHighlightReason((v) => !v)}
                    >
                      {showNoHighlightReason ? p.noHighlightHideDetails : p.noHighlightLearnMore}
                    </Button>
                  </InlineStack>
                  {showNoHighlightReason && (
                    <Text as="p" variant="bodySm" tone="subdued">
                      {result?.screenshotUnavailableReason
                        ? p.noHighlightGoogleReason.replace("{reason}", result.screenshotUnavailableReason)
                        : p.noHighlightGenericReason}
                    </Text>
                  )}
                </BlockStack>
              </Banner>
            )}

            <Divider />

            {/* Findings — full width, one accordion row per Lighthouse
                opportunity/diagnostic, with its own details table. Former own
                Card, now the last section of the speed tab (§3.4). */}
              <BlockStack gap="300">
                <Text as="h4" variant="headingSm" tone="subdued">{p.findingsTitle}</Text>

                {result.opportunities.length === 0 &&
                result.annotations.length === 0 &&
                (result.passedAudits?.length ?? 0) === 0 ? (
                  <Text as="p" variant="bodySm" tone="subdued">{p.noHighlightNote}</Text>
                ) : (
                  <div>
                    {result.opportunities.map((o) => {
                      const open = openFindings.has(o.id);
                      const savings = [
                        o.savingsMs != null ? formatDuration(o.savingsMs, locale) : null,
                        o.savingsBytes != null ? formatBytes(o.savingsBytes, locale) : null,
                      ]
                        .filter(Boolean)
                        .join(" / ");
                      return (
                        <div key={o.id} style={FINDING_ROW_STYLE}>
                          <button
                            type="button"
                            onClick={() => toggleFinding(o.id)}
                            aria-expanded={open}
                            aria-controls={`finding-${o.id}`}
                            style={FINDING_HEADER_STYLE}
                          >
                            <span style={FINDING_TITLE_STYLE}>
                              <InlineStack gap="200" blockAlign="center" wrap>
                                <ToneMarker tone={o.score == null ? undefined : metricTone(o.score)} />
                                <Text as="span" variant="bodyMd" fontWeight="medium">{o.title}</Text>
                                {savings && (
                                  <span style={{ color: PERF_COLOR.critical, fontSize: "13px" }}>
                                    {`— ${p.savingsLabel}: ${savings}`}
                                  </span>
                                )}
                              </InlineStack>
                            </span>
                            <DisclosureGlyph open={open} />
                          </button>
                          <Collapsible open={open} id={`finding-${o.id}`} transition={false}>
                            <div style={{ padding: "0 12px 16px" }}>
                              <BlockStack gap="300">
                                {o.description && (
                                  <Text as="p" variant="bodySm" tone="subdued">{o.description}</Text>
                                )}
                                {(o.metricLabels?.length || o.informative || o.displayValue) && (
                                  <InlineStack gap="150" wrap>
                                    {o.displayValue && <Badge>{o.displayValue}</Badge>}
                                    {o.metricLabels?.map((label) => (
                                      <Badge key={label} tone="info">{label}</Badge>
                                    ))}
                                    {o.informative && <Badge>{p.informativeBadge}</Badge>}
                                  </InlineStack>
                                )}
                                {o.table && (
                                  <FindingTable
                                    table={o.table}
                                    screenshot={cropSource}
                                    truncatedLabel={p.tableRowsTruncated}
                                  />
                                )}
                              </BlockStack>
                            </div>
                          </Collapsible>
                        </div>
                      );
                    })}

                    {/* Elements Lighthouse flagged directly (LCP element, layout
                        shifts, oversized images) — shown with a crop of the
                        full-page screenshot when one is available. */}
                    {result.annotations.length > 0 && (
                      <div style={FINDING_ROW_STYLE}>
                        <button
                          type="button"
                          onClick={() => toggleFinding(ELEMENTS_FINDING_ID)}
                          aria-expanded={openFindings.has(ELEMENTS_FINDING_ID)}
                          aria-controls={`finding-${ELEMENTS_FINDING_ID}`}
                          style={FINDING_HEADER_STYLE}
                        >
                          <span style={FINDING_TITLE_STYLE}>
                            <InlineStack gap="200" blockAlign="center" wrap={false}>
                              <ToneMarker />
                              <Text as="span" variant="bodyMd" fontWeight="medium">{p.elementsTitle}</Text>
                            </InlineStack>
                          </span>
                          <DisclosureGlyph open={openFindings.has(ELEMENTS_FINDING_ID)} />
                        </button>
                        <Collapsible
                          open={openFindings.has(ELEMENTS_FINDING_ID)}
                          id={`finding-${ELEMENTS_FINDING_ID}`}
                          transition={false}
                        >
                          <div style={{ padding: "0 12px 16px" }}>
                            <BlockStack gap="200">
                              {result.annotations.map((a) => (
                                <InlineStack key={a.id} gap="300" blockAlign="center" wrap={false}>
                                  <ElementThumb screenshot={cropSource} rect={a.rect} />
                                  <BlockStack gap="050">
                                    <Text as="span" variant="bodySm" fontWeight="medium">
                                      {p.annotationKinds[a.kind] || a.kind}
                                    </Text>
                                    <span style={CODE_TEXT_STYLE}>{a.label}</span>
                                    {a.detail && (
                                      <Text as="span" variant="bodySm" tone="subdued">{a.detail}</Text>
                                    )}
                                  </BlockStack>
                                </InlineStack>
                              ))}
                              {hiddenAnnotations > 0 && (
                                <Text as="p" variant="bodySm" tone="subdued">
                                  {p.annotationsTruncated.replace("{count}", String(hiddenAnnotations))}
                                </Text>
                              )}
                            </BlockStack>
                          </div>
                        </Collapsible>
                      </div>
                    )}

                    {/* What the page already gets right. Title-only — this
                        group exists to confirm, not to be worked through. */}
                    {(result.passedAudits?.length ?? 0) > 0 && (
                      <div style={FINDING_ROW_STYLE}>
                        <button
                          type="button"
                          onClick={() => toggleFinding(PASSED_FINDING_ID)}
                          aria-expanded={openFindings.has(PASSED_FINDING_ID)}
                          aria-controls={`finding-${PASSED_FINDING_ID}`}
                          style={FINDING_HEADER_STYLE}
                        >
                          <span style={FINDING_TITLE_STYLE}>
                            <InlineStack gap="200" blockAlign="center" wrap={false}>
                              <ToneMarker tone="success" />
                              <Text as="span" variant="bodyMd" fontWeight="medium">
                                {p.passedTitle.replace("{count}", String(result.passedAudits!.length))}
                              </Text>
                            </InlineStack>
                          </span>
                          <DisclosureGlyph open={openFindings.has(PASSED_FINDING_ID)} />
                        </button>
                        <Collapsible
                          open={openFindings.has(PASSED_FINDING_ID)}
                          id={`finding-${PASSED_FINDING_ID}`}
                          transition={false}
                        >
                          <div style={{ padding: "0 12px 16px" }}>
                            <BlockStack gap="150">
                              {result.passedAudits!.map((a) => (
                                <InlineStack key={a.id} gap="200" blockAlign="center" wrap={false}>
                                  <ToneMarker tone="success" />
                                  <Text as="span" variant="bodySm">{a.title}</Text>
                                  {a.displayValue && (
                                    <Text as="span" variant="bodySm" tone="subdued">{a.displayValue}</Text>
                                  )}
                                </InlineStack>
                              ))}
                            </BlockStack>
                          </div>
                        </Collapsible>
                      </div>
                    )}

                    {/* Only audits stored while the display cap was 8 can still
                        be short — new runs keep every finding. */}
                    {hiddenOpportunities > 0 && (
                      <div style={{ paddingTop: "12px" }}>
                        <Text as="p" variant="bodySm" tone="subdued">
                          {p.opportunitiesTruncated.replace("{count}", String(hiddenOpportunities))}
                        </Text>
                      </div>
                    )}
                  </div>
                )}
              </BlockStack>
                </BlockStack>
                )}

                {/* §3.5 — accessibility tab. No big gauge of its own: the
                    score is already in the strip, and unlike performance there
                    is no metric weighting a hover split could explain. */}
                {selectedTab === 1 && (
                  <BlockStack gap="400">
                    {!quality ? (
                      // Run stored before the quality categories existed (§3.8).
                      <Text as="p" variant="bodyMd" tone="subdued">{p.qualityUnavailable}</Text>
                    ) : (
                      <>
                        {/* §1.3 — honesty note, deliberately not dismissible:
                            automated testing finds only part of the real
                            barriers, so a green score is no legal certainty. */}
                        <Banner tone="info">
                          <Text as="p" variant="bodyMd">{p.a11y.disclaimer}</Text>
                        </Banner>
                        {/* App-native alt-text coverage (plan §7): warns from our
                            own data because Lighthouse never flags missing alt on
                            Shopify (empty alt="" passes axe-core). Two axes:
                            primary-language gaps and per-foreign-locale gaps. */}
                        {altTextAudit && (
                          <BlockStack gap="200">
                            <Text as="h3" variant="headingSm" tone="subdued">{p.a11y.altAudit.heading}</Text>
                            <Text as="p" variant="bodySm" tone="subdued">{p.a11y.altAudit.intro}</Text>
                            {altTextAudit.totalImages === 0 ? (
                              <Text as="p" variant="bodySm" tone="subdued">{p.a11y.altAudit.noImages}</Text>
                            ) : (
                              <BlockStack gap="300">
                                {altTextAudit.missingPrimary > 0 ? (
                                  <Banner tone="warning">
                                    <Text as="p" variant="bodyMd">
                                      {p.a11y.altAudit.primaryWarning
                                        .replace("{missing}", String(altTextAudit.missingPrimary))
                                        .replace("{total}", String(altTextAudit.totalImages))
                                        .replace("{locale}", altTextAudit.primaryLocale)}
                                    </Text>
                                  </Banner>
                                ) : (
                                  <Banner tone="success">
                                    <Text as="p" variant="bodyMd">
                                      {p.a11y.altAudit.allGood.replace("{total}", String(altTextAudit.totalImages))}
                                    </Text>
                                  </Banner>
                                )}
                                {altTextAudit.foreign.some((f) => f.missing > 0) && (
                                  <Banner tone="warning">
                                    <BlockStack gap="100">
                                      <Text as="p" variant="bodyMd">{p.a11y.altAudit.foreignWarning}</Text>
                                      <BlockStack gap="050">
                                        {altTextAudit.foreign
                                          .filter((f) => f.missing > 0)
                                          .map((f) => (
                                            <Text as="p" key={f.locale} variant="bodySm">
                                              {p.a11y.altAudit.foreignLine
                                                .replace("{name}", f.name)
                                                .replace("{missing}", String(f.missing))}
                                            </Text>
                                          ))}
                                      </BlockStack>
                                    </BlockStack>
                                  </Banner>
                                )}
                                <InlineStack>
                                  <Button url="/app/products" variant="plain">
                                    {p.a11y.altAudit.manageAction}
                                  </Button>
                                </InlineStack>
                              </BlockStack>
                            )}
                            <Divider />
                          </BlockStack>
                        )}
                        <QualityFindings
                          issues={a11yAutomated}
                          manualIssues={a11yManual}
                          advisory={quality.accessibilityAdvisory}
                          passedAudits={quality.accessibilityPassed}
                          notApplicable={quality.accessibilityNotApplicable}
                          total={quality.accessibilityTotal}
                          keyPrefix="a11y"
                          openFindings={openFindings}
                          onToggle={toggleFinding}
                          labels={{ ...qualityFindingLabels, noIssues: p.a11y.noIssues }}
                          altBridge={altTextBridge}
                          screenshot={cropSource}
                        />
                      </>
                    )}
                  </BlockStack>
                )}

                {/* §3.6 — best practices: extra information that feeds no
                    aggregate score and partly lies outside the merchant's
                    influence; the intro line says exactly that. */}
                {selectedTab === 2 && (
                  <BlockStack gap="400">
                    {!quality ? (
                      <Text as="p" variant="bodyMd" tone="subdued">{p.qualityUnavailable}</Text>
                    ) : (
                      <>
                        <Text as="p" variant="bodyMd" tone="subdued">{p.bestPractices.intro}</Text>
                        <QualityFindings
                          issues={bpAutomated}
                          manualIssues={bpManual}
                          advisory={quality.bestPracticesAdvisory}
                          passedAudits={quality.bestPracticesPassed}
                          notApplicable={quality.bestPracticesNotApplicable}
                          total={quality.bestPracticesTotal}
                          keyPrefix="bp"
                          openFindings={openFindings}
                          onToggle={toggleFinding}
                          labels={{ ...qualityFindingLabels, noIssues: p.bestPractices.noIssues }}
                          screenshot={cropSource}
                        />
                      </>
                    )}
                  </BlockStack>
                )}
              </div>
            </BlockStack>
          </Card>
        )}

        {/* Real-user Web Vitals (RUM) */}
        <Card>
          <BlockStack gap="300">
            <Text as="h3" variant="headingMd">{p.rum.title}</Text>
            {rum.totalSamples === 0 ? (
              <BlockStack gap="200">
                <Text as="p" variant="bodyMd" tone="subdued">{p.rum.emptyBody}</Text>
                <InlineStack>
                  <Button
                    onClick={() =>
                      handleNavigate("/app/settings", {
                        searchParams: new URLSearchParams({ tab: "setup" }),
                      })
                    }
                  >
                    {p.rum.emptyButton}
                  </Button>
                </InlineStack>
                <Text as="p" variant="bodySm" tone="subdued">{p.rum.emptyHint}</Text>
              </BlockStack>
            ) : (
              <BlockStack gap="300">
                <Text as="p" variant="bodySm" tone="subdued">
                  {p.rum.summary
                    .replace("{count}", String(rum.totalSamples))
                    .replace("{days}", String(rum.windowDays))}
                </Text>
                <IndexTable
                  itemCount={rum.rows.length}
                  selectable={false}
                  headings={[
                    { title: p.rum.colTemplate },
                    { title: p.rum.colDevice },
                    { title: p.rum.colSamples },
                    { title: p.rum.colLcp },
                    { title: p.rum.colCls },
                    { title: p.rum.colInp },
                  ]}
                >
                  {rum.rows.map((row, index) => (
                    <IndexTable.Row
                      id={`${row.template}-${row.device}`}
                      key={`${row.template}-${row.device}`}
                      position={index}
                    >
                      <IndexTable.Cell>
                        <Text as="span" variant="bodyMd">{row.template}</Text>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <Text as="span" variant="bodyMd">
                          {(row.device as WebVitalDevice) === "mobile" ? p.strategyMobile : p.strategyDesktop}
                        </Text>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <Text as="span" variant="bodyMd">{row.samples}</Text>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        {row.lcpP75Ms != null ? (
                          <Badge tone={cwvTone(row.lcpP75Ms, 2500, 4000)}>{formatMs(row.lcpP75Ms, locale)}</Badge>
                        ) : (
                          <Text as="span" tone="subdued">–</Text>
                        )}
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        {row.clsP75 != null ? (
                          <Badge tone={cwvTone(row.clsP75, 0.1, 0.25)}>{row.clsP75.toFixed(2)}</Badge>
                        ) : (
                          <Text as="span" tone="subdued">–</Text>
                        )}
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        {row.inpP75Ms != null ? (
                          <Badge tone={cwvTone(row.inpP75Ms, 200, 500)}>{formatMs(row.inpP75Ms, locale)}</Badge>
                        ) : (
                          <Text as="span" tone="subdued">–</Text>
                        )}
                      </IndexTable.Cell>
                    </IndexTable.Row>
                  ))}
                </IndexTable>

                {rum.slowPaths.length > 0 && (
                  <BlockStack gap="150">
                    <Text as="h4" variant="headingSm">{p.rum.slowPathsTitle}</Text>
                    {rum.slowPaths.map((sp) => (
                      <InlineStack key={sp.path} align="space-between" blockAlign="center">
                        <Text as="span" variant="bodyMd">{sp.path}</Text>
                        <InlineStack gap="200" blockAlign="center">
                          <Text as="span" variant="bodySm" tone="subdued">
                            {p.rum.slowPathSamples.replace("{count}", String(sp.samples))}
                          </Text>
                          <Badge tone={cwvTone(sp.lcpP75Ms, 2500, 4000)}>{formatMs(sp.lcpP75Ms, locale)}</Badge>
                        </InlineStack>
                      </InlineStack>
                    ))}
                  </BlockStack>
                )}

                {rum.elements.length > 0 && (
                  <BlockStack gap="150">
                    <Text as="h4" variant="headingSm">{p.rum.elementsTitle}</Text>
                    {rum.elements.map((el, i) => (
                      <InlineStack key={`${el.kind}-${i}`} gap="200" blockAlign="center" wrap>
                        <Text as="span" variant="bodyMd">{p.rum.elementKind[el.kind]}</Text>
                        <code style={{ fontSize: "12px" }}>{el.label}</code>
                        <Text as="span" variant="bodySm" tone="subdued">
                          {p.rum.elementOccurrences.replace("{count}", String(el.occurrences))}
                        </Text>
                      </InlineStack>
                    ))}
                  </BlockStack>
                )}
              </BlockStack>
            )}
          </BlockStack>
        </Card>

        {/* History */}
        <Card>
          <BlockStack gap="300">
            <Text as="h3" variant="headingMd">{p.historyTitle}</Text>
            {visibleHistory.length === 0 ? (
              <Text as="p" tone="subdued">{p.historyEmpty}</Text>
            ) : (
              <BlockStack gap="200">
                <Text as="p" variant="bodySm" tone="subdued">{p.historyClickHint}</Text>
                <IndexTable
                  itemCount={visibleHistory.length}
                  selectable={false}
                  headings={[
                    { title: p.historyColUrl },
                    { title: p.historyColStrategy },
                    { title: p.historyColScore },
                    { title: p.historyColA11y },
                    { title: p.historyColBestPractices },
                    { title: p.historyColDate },
                    { title: p.historyColActions, hidden: true },
                  ]}
                >
                  {visibleHistory.map((entry, index) => {
                    const isOpen = entry.id === viewedHistoryId;
                    return (
                      <IndexTable.Row
                        id={entry.id}
                        key={entry.id}
                        position={index}
                        selected={isOpen}
                        onClick={() => openHistoryEntry(entry)}
                      >
                        <IndexTable.Cell>
                          <InlineStack gap="200" blockAlign="center">
                            <Text as="span" variant="bodyMd" fontWeight={isOpen ? "semibold" : "regular"}>
                              {displayPath(entry.url)}
                            </Text>
                            {isOpen && <Badge tone="info">{p.historyOpenBadge}</Badge>}
                          </InlineStack>
                        </IndexTable.Cell>
                        <IndexTable.Cell>
                          <Text as="span" variant="bodyMd">{strategyLabel(entry.strategy)}</Text>
                        </IndexTable.Cell>
                        <IndexTable.Cell>
                          {entry.performanceScore != null ? (
                            // Lighthouse bands, same as the gauge above — the SEO-score
                            // bands (70/40) would color the very same run differently
                            // on one page.
                            <Badge tone={lighthouseTone(entry.performanceScore)}>{String(entry.performanceScore)}</Badge>
                          ) : (
                            <Text as="span" tone="subdued">–</Text>
                          )}
                        </IndexTable.Cell>
                        <IndexTable.Cell>
                          {/* Null on rows stored before the quality categories
                              existed — shown as "–", never glossed to 0. */}
                          {entry.a11yScore != null ? (
                            <Badge tone={lighthouseTone(entry.a11yScore)}>{String(entry.a11yScore)}</Badge>
                          ) : (
                            <Text as="span" tone="subdued">–</Text>
                          )}
                        </IndexTable.Cell>
                        <IndexTable.Cell>
                          {/* Null on rows stored before the quality categories
                              existed — shown as "–", never glossed to 0. */}
                          {entry.bestPracticesScore != null ? (
                            <Badge tone={lighthouseTone(entry.bestPracticesScore)}>{String(entry.bestPracticesScore)}</Badge>
                          ) : (
                            <Text as="span" tone="subdued">–</Text>
                          )}
                        </IndexTable.Cell>
                        <IndexTable.Cell>
                          <Text as="span" variant="bodyMd">
                            {formatDate(entry.createdAt, hydrated)}
                          </Text>
                        </IndexTable.Cell>
                        <IndexTable.Cell>
                          {/* stopPropagation: the trash button lives inside a
                              row whose onClick opens the run — without it a
                              delete click would also load the audit first. */}
                          <div onClick={(e) => e.stopPropagation()}>
                            <Tooltip content={p.historyDelete}>
                              <Button
                                icon={DeleteIcon}
                                variant="tertiary"
                                tone="critical"
                                accessibilityLabel={p.historyDelete}
                                onClick={() => deleteHistoryEntry(entry.id)}
                              />
                            </Tooltip>
                          </div>
                        </IndexTable.Cell>
                      </IndexTable.Row>
                    );
                  })}
                </IndexTable>
                {loadingHistory && (
                  <Text as="p" variant="bodySm" tone="subdued">{p.historyLoading}</Text>
                )}
                <Text as="p" variant="bodySm" tone="subdued">{p.historyRetentionHint}</Text>
              </BlockStack>
            )}
          </BlockStack>
        </Card>
      </BlockStack>
    </SeoSectionLayout>
  );
}
