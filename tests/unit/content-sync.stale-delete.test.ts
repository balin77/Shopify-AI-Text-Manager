/**
 * Unit Tests for app/services/content-sync.service.ts — R3
 *
 * Articles and Menus have no Shopify create/update/delete webhook, so the sync
 * is the only thing that can prune locally-cached rows that were deleted in
 * Shopify. R3 hardened that path:
 *
 *  - stale-delete: rows whose id is `notIn` the live Shopify id set are removed
 *    (articles also cascade their ContentTranslation rows).
 *  - truncation guard: an un-paginated (>=250) result is NOT trusted for
 *    deletes (we may simply not have paged through the rest).
 *  - 0-items health check: an empty Shopify response with local rows present
 *    throws "aborting to prevent data loss" and deletes nothing.
 *  - the plan cap is applied AFTER the stale-delete (the cap must not drive
 *    deletes — over-cap pruning is planCacheCleanup's job).
 *
 * DB is mocked (dynamic `import("../db.server")`); the per-item sync
 * (syncArticle/syncMenu) is stubbed so no network is touched.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const dbm = vi.hoisted(() => ({
  articleCount: vi.fn().mockResolvedValue(0),
  articleFindMany: vi.fn().mockResolvedValue([]),
  articleDeleteMany: vi.fn().mockResolvedValue({ count: 0 }),
  ctDeleteMany: vi.fn().mockResolvedValue({ count: 0 }),
  menuCount: vi.fn().mockResolvedValue(0),
  menuDeleteMany: vi.fn().mockResolvedValue({ count: 0 }),
  transaction: vi.fn(),
}));

vi.mock('~/db.server', () => {
  const db = {
    article: { count: dbm.articleCount, findMany: dbm.articleFindMany, deleteMany: dbm.articleDeleteMany },
    contentTranslation: { deleteMany: dbm.ctDeleteMany },
    menu: { count: dbm.menuCount, deleteMany: dbm.menuDeleteMany },
    $transaction: dbm.transaction,
  };
  (dbm.transaction as any).mockImplementation((cb: (tx: unknown) => unknown) => cb(db));
  return { db };
});

vi.mock('~/utils/logger.server', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { ContentSyncService } from '~/services/content-sync.service';

const shop = 'test.myshopify.com';

/** A Shopify GraphQL response stub: `.json()` resolves the given payload. */
const gql = (payload: unknown) => ({ json: async () => payload });

function blogsPayload(articleIdsPerBlog: string[][]) {
  return {
    data: {
      blogs: {
        edges: articleIdsPerBlog.map((ids) => ({
          node: {
            id: 'gid://shopify/Blog/1',
            articles: { edges: ids.map((id) => ({ node: { id } })) },
          },
        })),
      },
    },
  };
}
const menusPayload = (ids: string[]) => ({
  data: { menus: { edges: ids.map((id) => ({ node: { id } })) } },
});

function makeService(graphqlImpl: ReturnType<typeof vi.fn>) {
  const svc = new ContentSyncService({ graphql: graphqlImpl } as never, shop);
  vi.spyOn(svc as any, 'syncArticle').mockResolvedValue(undefined);
  vi.spyOn(svc as any, 'syncMenu').mockResolvedValue(undefined);
  return svc;
}

beforeEach(() => {
  vi.clearAllMocks();
  dbm.articleCount.mockResolvedValue(0);
  dbm.articleFindMany.mockResolvedValue([]);
  dbm.articleDeleteMany.mockResolvedValue({ count: 0 });
  dbm.ctDeleteMany.mockResolvedValue({ count: 0 });
  dbm.menuCount.mockResolvedValue(0);
  dbm.menuDeleteMany.mockResolvedValue({ count: 0 });
});

describe('syncAllArticles — R3 stale-delete', () => {
  it('deletes articles whose id is notIn the live Shopify set + cascades translations', async () => {
    const live = ['gid://shopify/Article/1', 'gid://shopify/Article/2'];
    dbm.articleFindMany.mockResolvedValue([{ id: 'gid://shopify/Article/STALE' }]);
    dbm.articleDeleteMany.mockResolvedValue({ count: 1 });

    const graphql = vi.fn().mockResolvedValue(gql(blogsPayload([live])));
    const svc = makeService(graphql);

    const n = await svc.syncAllArticles();

    expect(dbm.articleDeleteMany).toHaveBeenCalledWith({
      where: { shop, id: { notIn: live } },
    });
    expect(dbm.ctDeleteMany).toHaveBeenCalledWith({
      where: { shop, resourceType: 'Article', resourceId: { in: ['gid://shopify/Article/STALE'] } },
    });
    expect(n).toBe(2);
  });

  it('truncation guard: >=250 blogs → no stale-delete attempted', async () => {
    const manyBlogs = Array.from({ length: 250 }, () => [] as string[]);
    const graphql = vi.fn().mockResolvedValue(gql(blogsPayload(manyBlogs)));
    const svc = makeService(graphql);

    const n = await svc.syncAllArticles();

    expect(dbm.transaction).not.toHaveBeenCalled();
    expect(dbm.articleCount).not.toHaveBeenCalled();
    expect(dbm.articleDeleteMany).not.toHaveBeenCalled();
    expect(n).toBe(0);
  });

  it('0-items health check: empty Shopify + local rows present → throws, deletes nothing', async () => {
    dbm.articleCount.mockResolvedValue(5);
    const graphql = vi.fn().mockResolvedValue(gql(blogsPayload([[]])));
    const svc = makeService(graphql);

    await expect(svc.syncAllArticles()).rejects.toThrow(/aborting to prevent data loss/);
    expect(dbm.articleDeleteMany).not.toHaveBeenCalled();
  });

  it('0 items + 0 local rows → no throw, no delete, returns 0', async () => {
    dbm.articleCount.mockResolvedValue(0);
    const graphql = vi.fn().mockResolvedValue(gql(blogsPayload([[]])));
    const svc = makeService(graphql);

    await expect(svc.syncAllArticles()).resolves.toBe(0);
    expect(dbm.articleDeleteMany).not.toHaveBeenCalled();
  });

  it('plan cap is applied AFTER the stale-delete (delete sees ALL live ids, not the capped subset)', async () => {
    const live = ['gid://shopify/Article/1', 'gid://shopify/Article/2', 'gid://shopify/Article/3'];
    dbm.articleFindMany.mockResolvedValue([]);
    const graphql = vi.fn().mockResolvedValue(gql(blogsPayload([live])));
    const svc = makeService(graphql);
    const syncArticleSpy = vi.spyOn(svc as any, 'syncArticle').mockResolvedValue(undefined);

    const n = await svc.syncAllArticles(1); // cap = 1

    // Stale-delete must use the full live set, not the capped (sliced) one —
    // otherwise capping would wrongly delete legitimate over-cap articles.
    expect(dbm.articleDeleteMany).toHaveBeenCalledWith({
      where: { shop, id: { notIn: live } },
    });
    expect(syncArticleSpy).toHaveBeenCalledTimes(1); // cap applied to the sync loop
    expect(n).toBe(1);
  });
});

describe('syncAllMenus — R3 stale-delete', () => {
  it('deletes menus whose id is notIn the live Shopify set', async () => {
    const live = ['gid://shopify/Menu/1', 'gid://shopify/Menu/2'];
    dbm.menuDeleteMany.mockResolvedValue({ count: 1 });
    const graphql = vi.fn().mockResolvedValue(gql(menusPayload(live)));
    const svc = makeService(graphql);

    const n = await svc.syncAllMenus();

    expect(dbm.menuDeleteMany).toHaveBeenCalledWith({
      where: { shop, id: { notIn: live } },
    });
    expect(n).toBe(2);
  });

  it('truncation guard: >=250 menus → no stale-delete', async () => {
    const live = Array.from({ length: 250 }, (_, i) => `gid://shopify/Menu/${i}`);
    const graphql = vi.fn().mockResolvedValue(gql(menusPayload(live)));
    const svc = makeService(graphql);

    await svc.syncAllMenus();

    expect(dbm.menuCount).not.toHaveBeenCalled();
    expect(dbm.menuDeleteMany).not.toHaveBeenCalled();
  });

  it('0 menus + local rows present → throws "aborting to prevent data loss"', async () => {
    dbm.menuCount.mockResolvedValue(3);
    const graphql = vi.fn().mockResolvedValue(gql(menusPayload([])));
    const svc = makeService(graphql);

    await expect(svc.syncAllMenus()).rejects.toThrow(/aborting to prevent data loss/);
    expect(dbm.menuDeleteMany).not.toHaveBeenCalled();
  });
});
