import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The retry list for automatic translations. What each rule protects:
 *
 *  - at most TWO retries, and a limit postponement does not count — or a
 *    merchant's own cap would silently drop the work it was meant to pace;
 *  - a row whose retries are used up STAYS (exhausted) — given-up work is
 *    reported, never deleted silently;
 *  - a new failure resets the count — it describes a newer text.
 */

vi.mock("~/utils/logger.server", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  enqueueTranslationRetry,
  settleTranslationRetry,
  processTranslationRetries,
  mergeRetryPairs,
  removeDeliveredRetryPairs,
  retriesPerSweep,
  MAX_RETRY_ATTEMPTS,
} from "../../app/services/translations/translation-retry.server";

const SHOP = "a.myshopify.com";
const PRODUCT = "gid://shopify/Product/1";

interface Row {
  id: string;
  shop: string;
  resourceId: string;
  resourceType: string;
  contentKind: string;
  resourceTitle: string | null;
  pairs: unknown;
  reason: string;
  attempts: number;
  status: string;
  lastError: string | null;
  updatedAt: Date;
}

/** A tiny in-memory AutoTranslateRetry table with the Prisma calls the module uses. */
function fakeDb() {
  const rows: Row[] = [];
  let seq = 0;
  const byKey = (where: any) =>
    where.id
      ? rows.find((r) => r.id === where.id)
      : rows.find((r) => r.shop === where.shop_resourceId.shop && r.resourceId === where.shop_resourceId.resourceId);
  const table = {
    findUnique: vi.fn(async ({ where }: any) => byKey(where) ?? null),
    upsert: vi.fn(async ({ where, create, update }: any) => {
      const row = byKey(where);
      if (row) Object.assign(row, update, { updatedAt: new Date() });
      else rows.push({ id: `r${++seq}`, lastError: null, resourceTitle: null, updatedAt: new Date(), ...create });
    }),
    update: vi.fn(async ({ where, data }: any) => {
      const row = byKey(where)!;
      for (const [key, value] of Object.entries(data)) {
        (row as any)[key] =
          value && typeof value === "object" && "increment" in (value as any)
            ? (row as any)[key] + (value as any).increment
            : value;
      }
      row.updatedAt = new Date();
    }),
    delete: vi.fn(async ({ where }: any) => {
      rows.splice(rows.indexOf(byKey(where)!), 1);
    }),
    findMany: vi.fn(async () => rows.filter((r) => r.status === "pending")),
  };
  const db: any = { autoTranslateRetry: table };
  db.$transaction = async (cb: (tx: unknown) => Promise<unknown>) => cb(db);
  return { db: db as never, rows, table };
}

const pair = (locale: string, key = "title") => ({ locale, key });

describe("mergeRetryPairs", () => {
  it("unites without duplicates, keeping order", () => {
    expect(mergeRetryPairs([pair("de"), pair("fr")], [pair("fr"), pair("it")])).toEqual([
      pair("de"),
      pair("fr"),
      pair("it"),
    ]);
  });
});

describe("enqueue and settle", () => {
  let fake: ReturnType<typeof fakeDb>;
  beforeEach(() => {
    fake = fakeDb();
  });

  const enqueue = (pairs = [pair("de")], reason: "limit" | "failed" = "failed") =>
    enqueueTranslationRetry(
      { shop: SHOP, resourceId: PRODUCT, resourceType: "Product", contentKind: "product", pairs, reason },
      fake.db,
    );

  it("records a content resource as pending with no attempts", async () => {
    await enqueue();
    expect(fake.rows).toHaveLength(1);
    expect(fake.rows[0]).toMatchObject({ status: "pending", attempts: 0, reason: "failed" });
  });

  it("does not record a surface it cannot reproduce on its own", async () => {
    await enqueueTranslationRetry(
      { shop: SHOP, resourceId: "gid://shopify/Metafield/1", resourceType: "Metafield", contentKind: "product", pairs: [pair("de", "value")], reason: "failed" },
      fake.db,
    );
    expect(fake.rows).toHaveLength(0);
  });

  it("a new failure MERGES the pairs and resets the attempt count", async () => {
    await enqueue([pair("de")]);
    fake.rows[0].attempts = 2;
    fake.rows[0].status = "exhausted";
    await enqueue([pair("fr")]);
    expect(fake.rows).toHaveLength(1);
    expect(fake.rows[0]).toMatchObject({ attempts: 0, status: "pending" });
    expect(fake.rows[0].pairs).toEqual([pair("de"), pair("fr")]);
  });

  it("settles a retry that delivered everything by deleting the row", async () => {
    await enqueue();
    await settleTranslationRetry(fake.rows[0].id, { handed: [pair("de")], remaining: [] }, fake.db);
    expect(fake.rows).toHaveLength(0);
  });

  it(`marks a row EXHAUSTED after ${MAX_RETRY_ATTEMPTS} failed retries, and keeps it`, async () => {
    await enqueue();
    const id = fake.rows[0].id;
    fake.rows[0].attempts = 1;
    await settleTranslationRetry(id, { handed: [pair("de")], remaining: [pair("de")], error: "not_delivered" }, fake.db);
    expect(fake.rows[0].status).toBe("pending");
    fake.rows[0].attempts = 2;
    await settleTranslationRetry(id, { handed: [pair("de")], remaining: [pair("de")], error: "not_delivered" }, fake.db);
    expect(fake.rows[0]).toMatchObject({ status: "exhausted", lastError: "not_delivered" });
  });

  it("a POSTPONEMENT by the daily limit gives the attempt back", async () => {
    await enqueue();
    fake.rows[0].attempts = 2; // the processor counted this one before it ran
    await settleTranslationRetry(
      fake.rows[0].id,
      { handed: [pair("de")], remaining: [pair("de")], postponed: true, postponedBy: "limit" },
      fake.db,
    );
    expect(fake.rows[0]).toMatchObject({ status: "pending", attempts: 1, reason: "limit" });
  });

  it("NEW WORK added while a retry runs survives that retry's settle — with its own count", async () => {
    // Review finding: the retry used to overwrite the row with its own
    // leftovers, or delete it because IT had delivered everything.
    await enqueue([pair("de")]);
    fake.rows[0].status = "running";
    fake.rows[0].attempts = 1;
    await enqueue([pair("fr")]); // a normal run failed meanwhile
    expect(fake.rows[0]).toMatchObject({ status: "running", attempts: 1 });

    await settleTranslationRetry(fake.rows[0].id, { handed: [pair("de")], remaining: [] }, fake.db);

    expect(fake.rows).toHaveLength(1);
    expect(fake.rows[0].pairs).toEqual([pair("fr")]);
    expect(fake.rows[0]).toMatchObject({ status: "pending", attempts: 0 });
  });

  it("a LIMIT refusal does not reset the count of a row that keeps failing", async () => {
    await enqueue([pair("de")], "failed");
    fake.rows[0].attempts = 1;
    await enqueue([pair("de")], "limit");
    expect(fake.rows[0]).toMatchObject({ attempts: 1, reason: "failed" });
  });

  it("a later successful run CLEARS the pairs it delivered — an exhausted row included", async () => {
    await enqueue([pair("de"), pair("fr")]);
    fake.rows[0].status = "exhausted";
    await removeDeliveredRetryPairs(SHOP, PRODUCT, [pair("de")], fake.db);
    expect(fake.rows[0].pairs).toEqual([pair("fr")]);
    await removeDeliveredRetryPairs(SHOP, PRODUCT, [pair("fr")], fake.db);
    expect(fake.rows).toHaveLength(0);
  });
});

describe("retriesPerSweep", () => {
  it("paces the backlog at the merchant's own limit, within bounds", () => {
    expect(retriesPerSweep(null)).toBe(25);
    expect(retriesPerSweep(5)).toBe(25);
    expect(retriesPerSweep(80)).toBe(80);
    expect(retriesPerSweep(10_000)).toBe(200);
  });
});

describe("processTranslationRetries", () => {
  it("counts the attempt BEFORE the run and hands the owed pairs over", async () => {
    const fake = fakeDb();
    await enqueueTranslationRetry(
      { shop: SHOP, resourceId: PRODUCT, resourceType: "Product", contentKind: "product", pairs: [pair("de"), pair("xx")], reason: "failed" },
      fake.db,
    );
    const retry = vi.fn(async () => "started" as const);

    const stats = await processTranslationRetries(
      { shop: SHOP, client: {} as never, foreignLocales: ["de", "fr"], retry },
      fake.db,
    );

    expect(stats.started).toBe(1);
    expect(fake.rows[0]).toMatchObject({ status: "running", attempts: 1 });
    expect(fake.rows[0]).toHaveProperty("startedAt");
    // A locale the shop no longer publishes is owed nothing.
    expect((retry.mock.calls[0] as any[])[0].pairs).toEqual([pair("de")]);
  });

  it("drops a row whose every locale is no longer published", async () => {
    const fake = fakeDb();
    await enqueueTranslationRetry(
      { shop: SHOP, resourceId: PRODUCT, resourceType: "Product", contentKind: "product", pairs: [pair("xx")], reason: "failed" },
      fake.db,
    );
    const retry = vi.fn();
    await processTranslationRetries({ shop: SHOP, client: {} as never, foreignLocales: ["de"], retry }, fake.db);
    expect(retry).not.toHaveBeenCalled();
    expect(fake.rows).toHaveLength(0);
  });

  it("a retry that cannot even read the resource is a FAILED attempt, and the row stays", async () => {
    const fake = fakeDb();
    await enqueueTranslationRetry(
      { shop: SHOP, resourceId: PRODUCT, resourceType: "Product", contentKind: "product", pairs: [pair("de")], reason: "failed" },
      fake.db,
    );
    const retry = vi.fn(async () => {
      throw new Error("Throttled");
    });
    await processTranslationRetries({ shop: SHOP, client: {} as never, foreignLocales: ["de"], retry }, fake.db);
    // A CODE, never the raw provider message — the settings card renders it.
    expect(fake.rows[0]).toMatchObject({ status: "pending", attempts: 1, lastError: "unreadable" });
  });
});
