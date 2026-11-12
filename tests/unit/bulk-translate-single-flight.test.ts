/**
 * Atomic single-flight of "add missing translations" (PLAN §19.7 M-6): the row
 * is INSERTED first (pending) and only then does it ask whether something older
 * stands in the way — check-then-insert lets two requests both pass.
 *
 * The fake task store implements just the where-operators the claim uses, so
 * the test exercises the real query, not a hand-written stand-in for it.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("~/utils/logger.server", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { claimBulkTranslateRun, PENDING_CLAIM_STALE_MS } from "~/routes/api-ai-handlers/bulk-editor-translate.handler";

interface Row {
  id: string;
  shop: string;
  type: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Evaluates the subset of Prisma `where` the claim uses. */
function matches(row: any, where: any): boolean {
  return Object.entries(where).every(([key, cond]: [string, any]) => {
    if (key === "OR") return (cond as any[]).some((w) => matches(row, w));
    if (key === "AND") return (cond as any[]).every((w) => matches(row, w));
    const value = row[key];
    if (cond instanceof Date) return value instanceof Date && value.getTime() === cond.getTime();
    if (cond && typeof cond === "object") {
      return Object.entries(cond).every(([op, expected]: [string, any]) => {
        if (op === "not") return value !== expected;
        if (op === "lt") return value < expected;
        if (op === "gte") return value >= expected;
        if (op === "in") return expected.includes(value);
        throw new Error(`fake store: unsupported operator ${op}`);
      });
    }
    return value === cond;
  });
}

function fakeDb(clock: () => Date, ids: () => string) {
  const rows: Row[] = [];
  const task = {
    create: vi.fn(async ({ data }: any) => {
      await Promise.resolve(); // let a concurrent request interleave
      const now = clock();
      const row = { ...data, id: ids(), createdAt: now, updatedAt: now };
      rows.push(row);
      return row;
    }),
    findFirst: vi.fn(async ({ where, orderBy }: any) => {
      await Promise.resolve();
      const found = rows.filter((r) => matches(r, where));
      if (orderBy) {
        found.sort((a: any, b: any) => {
          for (const o of orderBy) {
            const [k, dir] = Object.entries(o)[0] as [string, string];
            const cmp = a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0;
            if (cmp !== 0) return dir === "asc" ? cmp : -cmp;
          }
          return 0;
        });
      }
      return found[0] ?? null;
    }),
    updateMany: vi.fn(async ({ where, data }: any) => {
      const hit = rows.filter((r) => matches(r, where));
      for (const r of hit) Object.assign(r, data);
      return { count: hit.length };
    }),
    deleteMany: vi.fn(async ({ where }: any) => {
      const before = rows.length;
      for (let i = rows.length - 1; i >= 0; i--) if (matches(rows[i], where)) rows.splice(i, 1);
      return { count: before - rows.length };
    }),
  };
  return { db: { task } as any, rows };
}

const data = { shop: "s.myshopify.com", type: "bulkEditorTranslate", total: 1 } as any;
let seq = 0;
const nextId = () => `id-${String(++seq).padStart(4, "0")}`;

describe("claimBulkTranslateRun", () => {
  it("a lone request wins and the row becomes running", async () => {
    const { db, rows } = fakeDb(() => new Date(), nextId);
    const claim = await claimBulkTranslateRun(db, data);
    expect(claim.ok).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("running");
  });

  it("two concurrent requests: exactly one wins, the loser removes its own row and names the winner", async () => {
    // same createdAt for both: the id breaks the tie
    const fixed = new Date();
    const { db, rows } = fakeDb(() => fixed, nextId);
    const [a, b] = await Promise.all([claimBulkTranslateRun(db, data), claimBulkTranslateRun(db, data)]);
    const winners = [a, b].filter((c) => c.ok);
    const losers = [a, b].filter((c) => !c.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("running");
    expect((losers[0] as { taskId: string }).taskId).toBe(rows[0].id);
  });

  it("many concurrent requests never produce two runs", async () => {
    const base = Date.now();
    let t = 0;
    const { db, rows } = fakeDb(() => new Date(base + Math.floor(t++ / 2)), nextId);
    const claims = await Promise.all(Array.from({ length: 12 }, () => claimBulkTranslateRun(db, data)));
    expect(claims.filter((c) => c.ok)).toHaveLength(1);
    expect(rows.filter((r) => r.status === "running")).toHaveLength(1);
    expect(rows).toHaveLength(1);
  });

  it("an already RUNNING task blocks the new one regardless of age", async () => {
    const { db, rows } = fakeDb(() => new Date(), nextId);
    const first = await claimBulkTranslateRun(db, data);
    const second = await claimBulkTranslateRun(db, data);
    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, taskId: (first as { task: { id: string } }).task.id });
    expect(rows).toHaveLength(1);
  });

  it("another shop's run never blocks", async () => {
    const { db } = fakeDb(() => new Date(), nextId);
    await claimBulkTranslateRun(db, data);
    const other = await claimBulkTranslateRun(db, { ...data, shop: "other.myshopify.com" });
    expect(other.ok).toBe(true);
  });

  it("a STALE pending row (a crashed claim) does not block; a fresh older pending one does", async () => {
    const now = Date.now();
    const { db, rows } = fakeDb(() => new Date(now), nextId);
    rows.push({
      id: "id-stale",
      shop: data.shop,
      type: data.type,
      status: "pending",
      createdAt: new Date(now - PENDING_CLAIM_STALE_MS - 60_000),
      updatedAt: new Date(now - PENDING_CLAIM_STALE_MS - 60_000),
    });
    expect((await claimBulkTranslateRun(db, data)).ok).toBe(true);

    const { db: db2, rows: rows2 } = fakeDb(() => new Date(now), nextId);
    rows2.push({
      id: "id-fresh",
      shop: data.shop,
      type: data.type,
      status: "pending",
      createdAt: new Date(now - 1000),
      updatedAt: new Date(now - 1000),
    });
    expect(await claimBulkTranslateRun(db2, data)).toEqual({ ok: false, taskId: "id-fresh" });
  });

  it("a NEWER pending row does not block an older request", async () => {
    const now = Date.now();
    const { db, rows } = fakeDb(() => new Date(now - 5000), nextId);
    rows.push({
      id: "id-newer",
      shop: data.shop,
      type: data.type,
      status: "pending",
      createdAt: new Date(now),
      updatedAt: new Date(now),
    });
    // my row is created at now-5000: older than the pending one, so I win
    expect((await claimBulkTranslateRun(db, data)).ok).toBe(true);
  });

  it("a row taken by someone else between insert and start is not reported as a win", async () => {
    const { db } = fakeDb(() => new Date(), nextId);
    db.task.updateMany.mockResolvedValueOnce({ count: 0 });
    const claim = await claimBulkTranslateRun(db, data);
    expect(claim.ok).toBe(false);
  });
});
