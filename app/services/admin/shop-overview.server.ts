/**
 * Data loading for the standalone /admin page (app/routes/admin.tsx).
 *
 * PLAN_ADMIN_SHOP_OVERVIEW 3.3. The overview runs a FIXED set of queries, all in
 * parallel, none of them per shop (the first version ran six per shop). The
 * shop list is the union of every source, including shops that exist ONLY in
 * the webhook log (a shop we never installed, or whose rows are all gone).
 *
 * What the page may never receive: tokens, encrypted values, anything from a
 * session row beyond aggregates over its SHAPE, `*ApiKey`, webhook payloads,
 * task prompt/result/title, customer e-mails. Every `select` below names the
 * columns it reads; the two raw queries return aggregates and flags only.
 * Customer data (GDPR audit e-mail and export) is loaded on click only,
 * through `loadAuditDetail`.
 *
 * BigInt (ledger and usage columns) becomes Number at ONE boundary, `num`.
 */

import { db } from '~/db.server';
import {
  computeShopStatus,
  type ShopStatusInput,
} from './shop-status.shared';
import type {
  ConnectionInstallFacts,
  ConnectionSessionFacts,
} from '../shop-connection-status.shared';
import { utcDay } from '../shop-activity.shared';
import { calendarPeriodKey } from '../ai/managed-periods.shared';
import type {
  AuditDetail,
  AuditRow,
  OverviewHeader,
  OverviewStatus,
  ShopDetail,
  ShopRow,
  TimelineEntry,
  UsageDayView,
  WebhookCounts,
} from './shop-overview.shared';

export type { AuditDetail, AuditRow, ShopDetail, ShopRow, OverviewHeader };

const DAY_MS = 24 * 60 * 60 * 1000;
const TIMELINE_MAX = 100;
const TEXT_MAX = 160;

/** BigInt / Decimal / number / null from the database -> Number. The one boundary. */
export function num(v: unknown): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'bigint') return Number(v);
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Short, token-free text for the page: cut to 160 characters, and anything
 * token-, key- or address-shaped is masked first (a stored error line is
 * "never a token" by contract; this is the belt to that suspender).
 */
export function sanitizeText(v: unknown): string {
  if (typeof v !== 'string') return '';
  const masked = v
    .replace(/shp[a-z]{2}_[A-Za-z0-9]+/g, '[maskiert]')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[maskiert]')
    .replace(/[A-Za-z0-9_-]{24,}/g, '[maskiert]')
    .replace(/\s+/g, ' ')
    .trim();
  return masked.length > TEXT_MAX ? `${masked.slice(0, TEXT_MAX - 1)}…` : masked;
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
const dayString = (d: Date): string => d.toISOString().slice(0, 10);
const monthStart = (now: Date): Date =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
const lastMonthStart = (now: Date): Date =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
const periodKey = (d: Date): string => d.toISOString().slice(0, 7);

// ---- the pieces every shop is judged from --------------------------------

interface InstallSelect extends ConnectionInstallFacts {
  shop: string;
  initialSyncCompletedAt: Date | null;
  lastActivityApprox: boolean;
  lastActionAt: Date | null;
  lastActionArea: string | null;
}

const INSTALL_SELECT = {
  shop: true,
  uninstalledAt: true,
  uninstallSource: true,
  reinstallEvidenceAt: true,
  connectionState: true,
  connectionStateSince: true,
  connectionStateReason: true,
  resyncRequiredSince: true,
  droppedWebhookCount: true,
  lastWebhookAt: true,
  lastActivityAt: true,
  lastActivityApprox: true,
  lastActionAt: true,
  lastActionArea: true,
  lastAuthAt: true,
  lastApiOkAt: true,
  initialSyncCompletedAt: true,
} as const;

const MIGRATION_SELECT = {
  shop: true,
  status: true,
  attempts: true,
  failureKind: true,
  failureKindSince: true,
  startedAt: true,
} as const;

interface SessionAgg extends ConnectionSessionFacts {
  shop: string;
  sessions: number;
  offline: number;
}

interface SessionAggRaw {
  shop: string;
  sessions: number;
  offline: number;
  tokenEmpty: boolean | null;
  hasRefresh: boolean | null;
  expires: Date | null;
  refreshTokenExpires: Date | null;
}

/** Session SHAPE only (flags and dates). The token columns are compared, never returned. */
function toSessionAgg(r: SessionAggRaw): SessionAgg {
  return {
    shop: r.shop,
    sessions: num(r.sessions),
    offline: num(r.offline),
    tokenEmpty: r.tokenEmpty === true,
    hasRefreshToken: r.hasRefresh === true,
    expires: r.expires,
    refreshTokenExpires: r.refreshTokenExpires,
  };
}

function statusInputFor(
  shop: string,
  parts: {
    install: InstallSelect | undefined;
    session: SessionAgg | undefined;
    migration: { status: string; attempts: number; failureKind: string | null; failureKindSince: Date | null; startedAt: Date } | undefined;
    webhooks: WebhookCounts;
    onlyInWebhookLog: boolean;
  },
): ShopStatusInput {
  return {
    shop,
    onlyInWebhookLog: parts.onlyInWebhookLog,
    install: parts.install ?? null,
    // An offline session is what the verdict is about; a shop with online
    // sessions only has none.
    session: parts.session && parts.session.offline > 0 ? parts.session : null,
    migration: parts.migration ?? null,
    webhooks24h: parts.webhooks,
  };
}

function slimStatus(s: ReturnType<typeof computeShopStatus>): OverviewStatus {
  return {
    color: s.color,
    colorLabel: s.colorLabel,
    tokenStatus: s.tokenStatus,
    tokenLabel: s.tokenLabel,
    reasons: s.reasons,
    lastOpenedMs: s.lastOpenedMs,
  };
}

// ---- GDPR audit (separate table, survives redaction) ----------------------

export async function loadAuditRows(): Promise<AuditRow[]> {
  // GdprAuditLog survives redactShopData on purpose (3-year retention).
  // Shown separately, since the shop otherwise appears nowhere after deletion.
  const logs = await db.gdprAuditLog.findMany({
    orderBy: { requestedAt: 'desc' },
    take: 200,
    select: {
      id: true,
      shop: true,
      requestType: true,
      status: true,
      requestedAt: true,
      completedAt: true,
    },
  });
  return logs.map((l) => ({
    id: l.id,
    shop: l.shop,
    requestType: l.requestType,
    status: l.status,
    requestedAt: l.requestedAt.toISOString(),
    completedAt: l.completedAt.toISOString(),
  }));
}

export async function loadAuditDetail(id: string): Promise<AuditDetail | null> {
  const row = await db.gdprAuditLog.findUnique({
    where: { id },
    select: {
      id: true,
      shop: true,
      customerEmail: true,
      error: true,
      dataExported: true,
      webhookId: true,
    },
  });
  // A stored error line is "never a token" by contract; sanitizeText is the
  // belt to that suspender before it reaches the page.
  return row ? { ...row, error: row.error ? sanitizeText(row.error) : null } : null;
}

// ---- the overview --------------------------------------------------------

type CountRow = { shop: string; _count: { _all: number } };
const countMap = (rows: CountRow[]) => new Map(rows.map((r) => [r.shop, r._count._all]));

interface UsageAggRaw {
  shop: string;
  active7: number;
  active30: number;
  actions7: unknown;
  actions30: unknown;
  tasks7: unknown;
  tasks30: unknown;
  failed7: unknown;
  failed30: unknown;
}
interface AiAggRaw {
  shop: string;
  costThis: unknown;
  costLast: unknown;
}
interface LastTaskRaw {
  shop: string;
  type: string;
  status: string;
  startedAt: Date;
}

export interface ShopOverview {
  now: string;
  rows: ShopRow[];
  header: OverviewHeader;
}

/**
 * 19 queries in parallel, whatever the number of shops. The shop list is the
 * union of all sources, so a shop can exist without a session (uninstalled),
 * without a ShopInstallState (old), or only in the webhook log.
 */
export async function loadShopOverview(now: Date = new Date()): Promise<ShopOverview> {
  const since24h = new Date(now.getTime() - DAY_MS);
  const d7 = dayString(utcDay(now.getTime() - 6 * DAY_MS));
  const d30 = dayString(utcDay(now.getTime() - 29 * DAY_MS));
  const thisMonth = monthStart(now);
  const lastMonth = lastMonthStart(now);

  const [
    sessionAggs,
    installStates,
    aiSettings,
    products,
    collections,
    articles,
    pages,
    tasks,
    migrations,
    webhooksTotal,
    webhooksFailed,
    retries,
    usageAggs,
    aiAggs,
    imageOps,
    lastTasks,
    globalCounters,
  ] = await Promise.all([
    db.$queryRaw<SessionAggRaw[]>`
      SELECT "shop",
             COUNT(*)::int AS "sessions",
             (COUNT(*) FILTER (WHERE NOT "isOnline"))::int AS "offline",
             bool_and("accessToken" = '') FILTER (WHERE NOT "isOnline") AS "tokenEmpty",
             bool_or(COALESCE("refreshToken", '') <> '') FILTER (WHERE NOT "isOnline") AS "hasRefresh",
             MAX("expires") FILTER (WHERE NOT "isOnline") AS "expires",
             MAX("refreshTokenExpires") FILTER (WHERE NOT "isOnline") AS "refreshTokenExpires"
      FROM "Session" GROUP BY "shop"`,
    db.shopInstallState.findMany({ select: INSTALL_SELECT }),
    db.aISettings.findMany({
      select: { shop: true, subscriptionPlan: true, devForcedPlan: true },
    }),
    db.product.groupBy({ by: ['shop'], _count: { _all: true } }),
    db.collection.groupBy({ by: ['shop'], _count: { _all: true } }),
    db.article.groupBy({ by: ['shop'], _count: { _all: true } }),
    db.page.groupBy({ by: ['shop'], _count: { _all: true } }),
    db.task.groupBy({ by: ['shop'], _count: { _all: true } }),
    db.offlineTokenMigration.findMany({ select: MIGRATION_SELECT }),
    db.webhookLog.groupBy({
      by: ['shop'],
      where: { createdAt: { gte: since24h } },
      _count: { _all: true },
    }),
    db.webhookLog.groupBy({
      by: ['shop'],
      where: { createdAt: { gte: since24h }, error: { not: null } },
      _count: { _all: true },
    }),
    db.webhookRetry.groupBy({ by: ['shop'], _count: { _all: true } }),
    db.$queryRaw<UsageAggRaw[]>`
      SELECT "shop",
             (COUNT(*) FILTER (WHERE "day" >= ${d7}::date AND "activeSlots" > 0))::int AS "active7",
             (COUNT(*) FILTER (WHERE "activeSlots" > 0))::int AS "active30",
             COALESCE(SUM("actions") FILTER (WHERE "day" >= ${d7}::date), 0)::bigint AS "actions7",
             COALESCE(SUM("actions"), 0)::bigint AS "actions30",
             COALESCE(SUM("tasksStarted") FILTER (WHERE "day" >= ${d7}::date), 0)::bigint AS "tasks7",
             COALESCE(SUM("tasksStarted"), 0)::bigint AS "tasks30",
             COALESCE(SUM("tasksFailed") FILTER (WHERE "day" >= ${d7}::date), 0)::bigint AS "failed7",
             COALESCE(SUM("tasksFailed"), 0)::bigint AS "failed30"
      FROM "ShopUsageDay" WHERE "day" >= ${d30}::date GROUP BY "shop"`,
    // Managed (our own key's) spend only, by PERIOD KEY: `m:YYYY-MM`, and
    // `b:<billing period end>` keys whose end falls in the month. The one-time
    // `taster` key is a lifetime total with no month and is left out of the
    // month figures (the column tooltip says so). Approximate: a billing period
    // is attributed to the month it ENDS in.
    db.$queryRaw<AiAggRaw[]>`
      SELECT "shop",
             COALESCE(SUM("costMicros") FILTER (WHERE "period" = ${calendarPeriodKey(thisMonth)} OR "period" LIKE ${`b:${periodKey(thisMonth)}-%`}), 0)::bigint AS "costThis",
             COALESCE(SUM("costMicros") FILTER (WHERE "period" = ${calendarPeriodKey(lastMonth)} OR "period" LIKE ${`b:${periodKey(lastMonth)}-%`}), 0)::bigint AS "costLast"
      FROM "AiUsageCounter" WHERE "source" = 'managed' AND "period" <> 'taster' GROUP BY "shop"`,
    db.imageOperationCounter.findMany({
      where: { period: { in: [periodKey(thisMonth), periodKey(lastMonth)] } },
      select: { shop: true, period: true, count: true },
    }),
    // Last task per shop: type, status and time only - never prompt, result or title.
    db.$queryRaw<LastTaskRaw[]>`
      SELECT DISTINCT ON ("shop") "shop", "type", "status", "startedAt"
      FROM "Task" ORDER BY "shop", "startedAt" DESC`,
    db.managedAiGlobalCounter.findMany({
      where: { period: calendarPeriodKey(thisMonth) },
      select: { costMicros: true },
    }),
  ]);

  const sessionByShop = new Map(sessionAggs.map((s) => [s.shop, toSessionAgg(s)]));
  const installByShop = new Map(installStates.map((s) => [s.shop, s as InstallSelect]));
  const aiByShop = new Map(aiSettings.map((s) => [s.shop, s]));
  const migrationByShop = new Map(migrations.map((m) => [m.shop, m]));
  const webhookTotal = countMap(webhooksTotal as CountRow[]);
  const webhookFailed = countMap(webhooksFailed as CountRow[]);
  const retryCount = countMap(retries as CountRow[]);
  const productCount = countMap(products as CountRow[]);
  const collectionCount = countMap(collections as CountRow[]);
  const articleCount = countMap(articles as CountRow[]);
  const pageCount = countMap(pages as CountRow[]);
  const taskCount = countMap(tasks as CountRow[]);
  const usageByShop = new Map(usageAggs.map((u) => [u.shop, u]));
  const aiAggByShop = new Map(aiAggs.map((a) => [a.shop, a]));
  const lastTaskByShop = new Map(lastTasks.map((t) => [t.shop, t]));
  const imageByShop = new Map<string, { cur: number; prev: number }>();
  for (const r of imageOps) {
    const e = imageByShop.get(r.shop) ?? { cur: 0, prev: 0 };
    if (r.period === periodKey(thisMonth)) e.cur += r.count;
    else e.prev += r.count;
    imageByShop.set(r.shop, e);
  }

  const known = new Set<string>();
  sessionAggs.forEach((s) => known.add(s.shop));
  installStates.forEach((s) => known.add(s.shop));
  aiSettings.forEach((s) => known.add(s.shop));
  // Shops seen only in the webhook log (and nowhere else) are listed too.
  const all = new Set(known);
  webhooksTotal.forEach((w) => all.add(w.shop));

  let totalWebhooks = 0;
  let failedWebhooks = 0;

  const rows: ShopRow[] = [...all]
    .sort()
    .map((shop) => {
      const install = installByShop.get(shop);
      const ai = aiByShop.get(shop);
      const session = sessionByShop.get(shop);
      const wh: WebhookCounts = {
        total: webhookTotal.get(shop) ?? 0,
        failed: webhookFailed.get(shop) ?? 0,
      };
      totalWebhooks += wh.total;
      failedWebhooks += wh.failed;
      const onlyInWebhookLog = !known.has(shop);
      const status = computeShopStatus(
        statusInputFor(shop, {
          install,
          session,
          migration: migrationByShop.get(shop),
          webhooks: wh,
          onlyInWebhookLog,
        }),
        now,
      );
      const usage = usageByShop.get(shop);
      const aiAgg = aiAggByShop.get(shop);
      const img = imageByShop.get(shop);
      const task = lastTaskByShop.get(shop);
      const lastOpened = status.lastOpenedMs;
      return {
        shop,
        plan: ai?.subscriptionPlan ?? '—',
        devForcedPlan: ai?.devForcedPlan ?? null,
        products: productCount.get(shop) ?? 0,
        collections: collectionCount.get(shop) ?? 0,
        articles: articleCount.get(shop) ?? 0,
        pages: pageCount.get(shop) ?? 0,
        tasks: taskCount.get(shop) ?? 0,
        hasSession: !!session && session.sessions > 0,
        uninstalledAt: iso(install?.uninstalledAt as Date | null | undefined),
        initialSyncCompletedAt: iso(install?.initialSyncCompletedAt),
        onlyInWebhookLog,
        status: slimStatus(status),
        lastOpenedAt: lastOpened === null ? null : new Date(lastOpened).toISOString(),
        // Approximate while the visit time is the one-off backfill and no
        // newer sign-in exists.
        lastOpenedApprox:
          !!install?.lastActivityApprox &&
          (install.lastAuthAt == null ||
            new Date(install.lastAuthAt as Date).getTime() < new Date(install.lastActivityAt as Date).getTime()),
        lastActionAt: iso(install?.lastActionAt),
        lastActionArea: install?.lastActionArea ?? null,
        activeDays7: num(usage?.active7),
        activeDays30: num(usage?.active30),
        actions7: num(usage?.actions7),
        actions30: num(usage?.actions30),
        tasks7: num(usage?.tasks7),
        tasks30: num(usage?.tasks30),
        tasksFailed7: num(usage?.failed7),
        tasksFailed30: num(usage?.failed30),
        aiCostMicrosMonth: num(aiAgg?.costThis),
        aiCostMicrosLastMonth: num(aiAgg?.costLast),
        imageOpsMonth: img?.cur ?? 0,
        imageOpsLastMonth: img?.prev ?? 0,
        webhooks24h: wh,
        webhooksPaused: status.connection.webhooksPaused,
        droppedWebhooks: status.connection.droppedWebhookCount,
        retriesPending: retryCount.get(shop) ?? 0,
        lastTask: task ? { type: task.type, status: task.status, at: task.startedAt.toISOString() } : null,
      };
    });

  return {
    now: now.toISOString(),
    rows,
    header: {
      webhooks24h: { total: totalWebhooks, failed: failedWebhooks },
      managedAiCostMicrosMonth: globalCounters.reduce((sum, c) => sum + num(c.costMicros), 0),
    },
  };
}

// ---- the detail of one shop (on demand) -----------------------------------

const DETAIL_TASKS = 40;

/**
 * Everything the detail row shows for ONE shop: reasons, facts, 30 usage days,
 * storage and a timeline of at most 100 entries. A fixed number of queries,
 * all by shop. Returns null for a shop no source knows (404). Never customer
 * data: GDPR entries are type, status and time only.
 */
export async function loadShopDetail(shop: string, now: Date = new Date()): Promise<ShopDetail | null> {
  const since24h = new Date(now.getTime() - DAY_MS);
  const d30 = dayString(utcDay(now.getTime() - 29 * DAY_MS));

  const [
    sessionAggs,
    install,
    ai,
    migration,
    usageDays,
    webhookTotal,
    webhookFailed,
    failedByHour,
    recentTasks,
    consents,
    gdpr,
    sizeRows,
  ] = await Promise.all([
    db.$queryRaw<SessionAggRaw[]>`
      SELECT "shop",
             COUNT(*)::int AS "sessions",
             (COUNT(*) FILTER (WHERE NOT "isOnline"))::int AS "offline",
             bool_and("accessToken" = '') FILTER (WHERE NOT "isOnline") AS "tokenEmpty",
             bool_or(COALESCE("refreshToken", '') <> '') FILTER (WHERE NOT "isOnline") AS "hasRefresh",
             MAX("expires") FILTER (WHERE NOT "isOnline") AS "expires",
             MAX("refreshTokenExpires") FILTER (WHERE NOT "isOnline") AS "refreshTokenExpires"
      FROM "Session" WHERE "shop" = ${shop} GROUP BY "shop"`,
    db.shopInstallState.findUnique({ where: { shop }, select: INSTALL_SELECT }),
    db.aISettings.findUnique({
      where: { shop },
      select: { shop: true, subscriptionPlan: true, aiProcessingConsentAt: true },
    }),
    db.offlineTokenMigration.findUnique({
      where: { shop },
      select: { ...MIGRATION_SELECT, lastError: true, completedAt: true },
    }),
    db.shopUsageDay.findMany({
      where: { shop, day: { gte: new Date(`${d30}T00:00:00.000Z`) } },
      orderBy: { day: 'asc' },
      select: { day: true, activeSlots: true, actions: true, tasksStarted: true, tasksFailed: true },
    }),
    db.webhookLog.count({ where: { shop, createdAt: { gte: since24h } } }),
    db.webhookLog.count({ where: { shop, createdAt: { gte: since24h }, error: { not: null } } }),
    db.$queryRaw<Array<{ hour: Date; failed: number }>>`
      SELECT date_trunc('hour', "createdAt") AS "hour", COUNT(*)::int AS "failed"
      FROM "WebhookLog"
      WHERE "shop" = ${shop} AND "createdAt" >= ${since24h.toISOString()}::timestamp AND "error" IS NOT NULL
      GROUP BY 1 ORDER BY 1 DESC LIMIT 24`,
    db.task.findMany({
      where: { shop },
      orderBy: { startedAt: 'desc' },
      take: DETAIL_TASKS,
      select: { type: true, status: true, startedAt: true, error: true },
    }),
    db.aiConsentEvent.findMany({
      where: { shop },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: { granted: true, createdAt: true },
    }),
    db.gdprAuditLog.findMany({
      where: { shop },
      orderBy: { requestedAt: 'desc' },
      take: 10,
      select: { requestType: true, status: true, requestedAt: true },
    }),
    db.$queryRaw<Array<{ bytes: bigint }>>`
      SELECT
        (SELECT COALESCE(SUM(octet_length(COALESCE(title,'')) + octet_length(COALESCE("descriptionHtml",''))),0) FROM "Product" WHERE shop = ${shop})
      + (SELECT COALESCE(SUM(octet_length(COALESCE(title,'')) + octet_length(COALESCE("descriptionHtml",''))),0) FROM "Collection" WHERE shop = ${shop})
      + (SELECT COALESCE(SUM(octet_length(COALESCE(title,'')) + octet_length(COALESCE(body,''))),0) FROM "Article" WHERE shop = ${shop})
      + (SELECT COALESCE(SUM(octet_length(COALESCE(title,'')) + octet_length(COALESCE(body,''))),0) FROM "Page" WHERE shop = ${shop})
      + (SELECT COALESCE(SUM(octet_length(COALESCE(value,''))),0) FROM "ContentTranslation" WHERE shop = ${shop})
      + (SELECT COALESCE(SUM(octet_length(COALESCE(value,''))),0) FROM "ThemeTranslation" WHERE shop = ${shop})
      AS bytes`,
  ]);

  const session = sessionAggs[0] ? toSessionAgg(sessionAggs[0]) : undefined;
  const onlyInWebhookLog = !install && !ai && !session;
  // Unknown to every source the overview lists (the webhook log counts) => not a shop.
  if (onlyInWebhookLog && webhookTotal === 0) return null;

  const status = computeShopStatus(
    statusInputFor(shop, {
      install: (install ?? undefined) as InstallSelect | undefined,
      session,
      migration: migration ?? undefined,
      webhooks: { total: webhookTotal, failed: webhookFailed },
      onlyInWebhookLog,
    }),
    now,
  );
  const conn = status.connection;

  const facts: Array<{ label: string; value: string }> = [
    { label: 'Token', value: status.tokenLabel },
    { label: 'Installation', value: install?.uninstalledAt ? `deinstalliert (${install.uninstallSource ?? 'unbekannte Quelle'})` : install ? 'installiert' : 'unbekannt' },
    { label: 'Plan', value: ai?.subscriptionPlan ?? '—' },
    { label: 'Webhooks pausiert', value: conn.webhooksPaused ? `ja, ${conn.droppedWebhookCount} verworfen` : 'nein' },
    { label: 'Webhooks 24 h', value: `${webhookTotal} (davon ${webhookFailed} fehlgeschlagen)` },
    { label: 'Nachholen nötig seit', value: iso(install?.resyncRequiredSince as Date | null | undefined) ?? '—' },
    { label: 'Sperrgrund', value: conn.reason ? sanitizeText(conn.reason) : '—' },
    { label: 'Session', value: session ? (session.offline > 0 ? `Offline-Session, ${session.hasRefreshToken ? 'ablaufend' : 'nicht ablaufend'}` : 'nur Online-Sessions') : 'keine' },
    { label: 'Refresh-Token läuft ab', value: iso(session?.refreshTokenExpires as Date | null | undefined) ?? '—' },
    { label: 'Erstsynchronisation', value: iso(install?.initialSyncCompletedAt) ?? 'nicht abgeschlossen' },
    { label: 'KI-Einwilligung', value: ai?.aiProcessingConsentAt ? ai.aiProcessingConsentAt.toISOString() : 'keine' },
  ];
  if (migration) {
    facts.push({
      label: 'Token-Umstellung',
      value: `${migration.status}, ${migration.attempts} Versuche${migration.failureKind ? `, ${migration.failureKind}` : ''}`,
    });
  }

  const timeline: TimelineEntry[] = [];
  const add = (at: Date | null | undefined, kind: string, text: string) => {
    if (at) timeline.push({ at: at.toISOString(), kind, text });
  };
  add(install?.lastActivityAt as Date | null | undefined, 'Aktivität', install?.lastActivityApprox ? 'Zuletzt geöffnet (ungefähr)' : 'Zuletzt geöffnet');
  add(install?.lastActionAt as Date | null | undefined, 'Aktivität', `Letzte Aktion${install?.lastActionArea ? ` (${sanitizeText(install.lastActionArea)})` : ''}`);
  add(install?.lastAuthAt as Date | null | undefined, 'Anmeldung', 'Anmeldung / Token-Austausch');
  add(install?.lastWebhookAt as Date | null | undefined, 'Webhook', 'Letzter Webhook mit gültiger Signatur');
  add(install?.uninstalledAt as Date | null | undefined, 'Installation', 'Als deinstalliert markiert');
  add(install?.reinstallEvidenceAt as Date | null | undefined, 'Installation', 'Beleg für eine Neuinstallation');
  add(install?.connectionStateSince as Date | null | undefined, 'Verbindung', `Zugang gesperrt (${sanitizeText(install?.connectionState)})`);
  if (migration) {
    add(migration.startedAt, 'Migration', `Token-Umstellung gestartet (${migration.status})`);
    add(migration.completedAt, 'Migration', 'Token-Umstellung beendet');
    if (migration.lastError) add(migration.failureKindSince ?? migration.startedAt, 'Migration', `Fehler: ${sanitizeText(migration.lastError)}`);
  }
  for (const t of recentTasks) {
    const err = t.status === 'failed' && t.error ? ` — ${sanitizeText(t.error)}` : '';
    add(t.startedAt, 'Task', `${sanitizeText(t.type)}: ${sanitizeText(t.status)}${err}`);
  }
  for (const h of failedByHour) {
    add(h.hour, 'Webhook', `${num(h.failed)} fehlgeschlagene Webhooks in dieser Stunde`);
  }
  for (const c of consents) add(c.createdAt, 'KI-Einwilligung', c.granted ? 'erteilt' : 'widerrufen');
  for (const g of gdpr) add(g.requestedAt, 'DSGVO', `${sanitizeText(g.requestType)}: ${sanitizeText(g.status)}`);
  timeline.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

  const usage: UsageDayView[] = usageDays.map((u) => ({
    day: dayString(u.day),
    activeSlots: u.activeSlots,
    actions: u.actions,
    tasksStarted: u.tasksStarted,
    tasksFailed: u.tasksFailed,
  }));

  return {
    shop,
    now: now.toISOString(),
    status: slimStatus(status),
    storageMB: Math.round((num(sizeRows[0]?.bytes) / (1024 * 1024)) * 1000) / 1000,
    facts,
    usage,
    timeline: timeline.slice(0, TIMELINE_MAX),
  };
}
