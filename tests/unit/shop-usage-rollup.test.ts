/** Rollup of task statistics into ShopUsageDay (plan 3.2): idempotent, monotone, tracker columns untouched, known shops only, 90 days. */
import { describe, it, expect, vi } from "vitest";

vi.mock("~/utils/logger.server", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { pruneShopUsage, rollupTaskUsage } from "../../app/services/shop-usage-rollup.server";

function fakeDb() {
  const executed: Array<{ sql: string; values: unknown[] }> = [];
  return {
    executed,
    $executeRaw: vi.fn(async (q: TemplateStringsArray, ...values: unknown[]) => {
      executed.push({ sql: q.join("?"), values });
      return 3;
    }),
    shopUsageDay: { deleteMany: vi.fn(async () => ({ count: 2 })) },
  };
}
const NOW = new Date("2026-11-09T10:30:00Z");

describe("rollupTaskUsage", () => {
  it("covers today, yesterday and the day before (UTC)", async () => {
    const db = fakeDb();
    expect(await rollupTaskUsage(db as never, NOW)).toBe(3);
    expect(db.executed[0].values[0]).toBe("2026-11-07T00:00:00.000Z");
  });

  it("is idempotent and monotone: GREATEST on every task column, never a plain overwrite", async () => {
    const db = fakeDb();
    await rollupTaskUsage(db as never, NOW);
    const sql = db.executed[0].sql;
    for (const col of ["tasksStarted", "tasksFailed", "aiCostMicros", "aiTokens"]) {
      expect(sql).toContain(`"${col}" = GREATEST("ShopUsageDay"."${col}", EXCLUDED."${col}")`);
    }
  });

  it("never touches the tracker's counters", async () => {
    const db = fakeDb();
    await rollupTaskUsage(db as never, NOW);
    const update = db.executed[0].sql.split("DO UPDATE SET")[1];
    expect(update).not.toContain("activeSlots");
    expect(update).not.toContain('"actions"');
    expect(db.executed[0].sql.split("DO UPDATE SET")[0]).not.toContain("activeSlots");
  });

  it("only for known shops, and reads no task text", async () => {
    const db = fakeDb();
    await rollupTaskUsage(db as never, NOW);
    const sql = db.executed[0].sql;
    expect(sql).toContain('SELECT "shop" FROM "ShopInstallState" UNION SELECT "shop" FROM "Session"');
    for (const forbidden of ['"prompt"', '"result"', '"resourceTitle"', '"error"']) expect(sql).not.toContain(forbidden);
  });

  it("never throws", async () => {
    const db = fakeDb();
    db.$executeRaw.mockRejectedValue(new Error("db"));
    expect(await rollupTaskUsage(db as never, NOW)).toBe(0);
  });
});

describe("pruneShopUsage", () => {
  it("deletes rows older than 90 days", async () => {
    const db = fakeDb();
    expect(await pruneShopUsage(db as never, NOW)).toBe(2);
    expect(db.shopUsageDay.deleteMany).toHaveBeenCalledWith({ where: { day: { lt: new Date("2026-08-11T00:00:00Z") } } });
  });
});
