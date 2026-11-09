/**
 * Data loading for the standalone /admin page (app/routes/admin.tsx).
 *
 * Every query here is independent of the number of shops: one query (or one
 * grouped query) per data kind, all run in parallel. The previous loader ran
 * six queries PER shop (five counts and a size estimate).
 *
 * The page never receives tokens, encrypted values or anything from a session
 * row beyond the shop domain (`select` lists name every column that is read).
 */

import { db } from '~/db.server';

export interface ShopRow {
  shop: string;
  plan: string;
  devForcedPlan: string | null;
  products: number;
  collections: number;
  articles: number;
  pages: number;
  tasks: number;
  hasSession: boolean;
  uninstalledAt: string | null;
  initialSyncCompletedAt: string | null;
}

export interface AuditRow {
  id: string;
  shop: string;
  requestType: string;
  status: string;
  requestedAt: string;
  completedAt: string;
}

// Loaded only on click (GET /admin?audit=<id>), never with the page: it holds
// the customer e-mail and the full data_request export (R5-G1: the export must
// stay retrievable so the request can be fulfilled).
export interface AuditDetail {
  id: string;
  shop: string;
  customerEmail: string | null;
  error: string | null;
  dataExported: string | null;
  webhookId: string | null;
}

export interface ShopStorage {
  shop: string;
  storageMB: number;
}

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
  return db.gdprAuditLog.findUnique({
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
}

type CountRow = { shop: string; _count: { _all: number } };
const countMap = (rows: CountRow[]) => new Map(rows.map((r) => [r.shop, r._count._all]));

export async function loadShopRows(): Promise<ShopRow[]> {
  // 9 queries in parallel, none per shop. The shop list is the union of all
  // sources: a shop can exist without a session (uninstalled) or without a
  // ShopInstallState (old).
  const [
    sessionShops,
    installStates,
    aiSettings,
    products,
    collections,
    articles,
    pages,
    tasks,
  ] = await Promise.all([
    db.session.findMany({ distinct: ['shop'], select: { shop: true } }),
    db.shopInstallState.findMany({
      select: { shop: true, uninstalledAt: true, initialSyncCompletedAt: true },
    }),
    db.aISettings.findMany({
      select: { shop: true, subscriptionPlan: true, devForcedPlan: true },
    }),
    db.product.groupBy({ by: ['shop'], _count: { _all: true } }),
    db.collection.groupBy({ by: ['shop'], _count: { _all: true } }),
    db.article.groupBy({ by: ['shop'], _count: { _all: true } }),
    db.page.groupBy({ by: ['shop'], _count: { _all: true } }),
    db.task.groupBy({ by: ['shop'], _count: { _all: true } }),
  ]);

  const shops = new Set<string>();
  sessionShops.forEach((s) => shops.add(s.shop));
  installStates.forEach((s) => shops.add(s.shop));
  aiSettings.forEach((s) => shops.add(s.shop));

  const sessionShopSet = new Set(sessionShops.map((s) => s.shop));
  const installByShop = new Map(installStates.map((s) => [s.shop, s]));
  const aiByShop = new Map(aiSettings.map((s) => [s.shop, s]));
  const productCount = countMap(products as CountRow[]);
  const collectionCount = countMap(collections as CountRow[]);
  const articleCount = countMap(articles as CountRow[]);
  const pageCount = countMap(pages as CountRow[]);
  const taskCount = countMap(tasks as CountRow[]);

  return [...shops].sort().map((shop) => {
    const install = installByShop.get(shop);
    const ai = aiByShop.get(shop);
    return {
      shop,
      plan: ai?.subscriptionPlan ?? '—',
      devForcedPlan: ai?.devForcedPlan ?? null,
      products: productCount.get(shop) ?? 0,
      collections: collectionCount.get(shop) ?? 0,
      articles: articleCount.get(shop) ?? 0,
      pages: pageCount.get(shop) ?? 0,
      tasks: taskCount.get(shop) ?? 0,
      hasSession: sessionShopSet.has(shop),
      uninstalledAt: install?.uninstalledAt?.toISOString() ?? null,
      initialSyncCompletedAt: install?.initialSyncCompletedAt?.toISOString() ?? null,
    };
  });
}

/** Rough size of one shop's text content in MB (detail view, on demand). */
export async function loadShopStorage(shop: string): Promise<ShopStorage | null> {
  // Unknown to every source the overview lists => not a shop (null, 404).
  const [s, i, a] = await Promise.all([
    db.session.findFirst({ where: { shop }, select: { shop: true } }),
    db.shopInstallState.findFirst({ where: { shop }, select: { shop: true } }),
    db.aISettings.findFirst({ where: { shop }, select: { shop: true } }),
  ]);
  if (!s && !i && !a) return null;
  const sizeRows = await db.$queryRaw<Array<{ bytes: bigint }>>`
    SELECT
      (SELECT COALESCE(SUM(octet_length(COALESCE(title,'')) + octet_length(COALESCE("descriptionHtml",''))),0) FROM "Product" WHERE shop = ${shop})
    + (SELECT COALESCE(SUM(octet_length(COALESCE(title,'')) + octet_length(COALESCE("descriptionHtml",''))),0) FROM "Collection" WHERE shop = ${shop})
    + (SELECT COALESCE(SUM(octet_length(COALESCE(title,'')) + octet_length(COALESCE(body,''))),0) FROM "Article" WHERE shop = ${shop})
    + (SELECT COALESCE(SUM(octet_length(COALESCE(title,'')) + octet_length(COALESCE(body,''))),0) FROM "Page" WHERE shop = ${shop})
    + (SELECT COALESCE(SUM(octet_length(COALESCE(value,''))),0) FROM "ContentTranslation" WHERE shop = ${shop})
    + (SELECT COALESCE(SUM(octet_length(COALESCE(value,''))),0) FROM "ThemeTranslation" WHERE shop = ${shop})
    AS bytes`;
  return {
    shop,
    storageMB: Math.round((Number(sizeRows[0]?.bytes ?? 0) / (1024 * 1024)) * 1000) / 1000,
  };
}
