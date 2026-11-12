/**
 * Tasks tab, batch states (PLAN_BULK_TRANSLATE_BATCHING 19.4): Cancel branches
 * on the status (pending/running as before, waiting_batch -> cancel_requested by
 * a conditional updateMany, mirrored onto the batch row without its manifest,
 * everything else refused) and Delete is refused SERVER-side for an open batch
 * status.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("~/utils/logger.server", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { cancelTask, deleteTask } from "~/services/tasks/task-cancel.server";

type Row = { id: string; shop: string; status: string };

/** Tiny task store: updateMany/deleteMany/findFirst over `status`, honouring in / notIn / equality. */
function store(rows: Row[]) {
  const match = (r: Row, where: any) =>
    Object.entries(where).every(([k, c]: [string, any]) => {
      const v = (r as any)[k];
      if (c && typeof c === "object") {
        if ("in" in c) return c.in.includes(v);
        if ("notIn" in c) return !c.notIn.includes(v);
      }
      return v === c;
    });
  const batchUpdateMany = vi.fn(async () => ({ count: 1 }));
  const db = {
    task: {
      updateMany: vi.fn(async ({ where, data }: any) => {
        const hit = rows.filter((r) => match(r, where));
        hit.forEach((r) => Object.assign(r, data));
        return { count: hit.length };
      }),
      deleteMany: vi.fn(async ({ where }: any) => {
        const hit = rows.filter((r) => match(r, where));
        hit.forEach((r) => rows.splice(rows.indexOf(r), 1));
        return { count: hit.length };
      }),
      findFirst: vi.fn(async ({ where }: any) => rows.find((r) => match(r, where)) ?? null),
    },
    bulkTranslateBatch: { updateMany: batchUpdateMany },
  } as any;
  return { db, batchUpdateMany };
}

const SHOP = "s.myshopify.com";

describe("cancelTask", () => {
  it("a waiting batch becomes cancel_requested (conditional) and the batch row follows, state only", async () => {
    const rows = [{ id: "t1", shop: SHOP, status: "waiting_batch" }];
    const { db, batchUpdateMany } = store(rows);
    expect(await cancelTask(db, SHOP, "t1")).toEqual({ ok: true, mode: "requested" });
    expect(rows[0].status).toBe("cancel_requested");
    expect(batchUpdateMany).toHaveBeenCalledWith({
      where: { taskId: "t1", shop: SHOP, state: "waiting" },
      data: { state: "cancel_requested" },
    });
    // never the manifest
    const data = (batchUpdateMany.mock.calls[0] as any[])[0].data;
    expect(Object.keys(data)).not.toContain("manifest");
    // cancelRequestedAt = provider cancel CONFIRMED: never set by the mirror
    expect(Object.keys(data)).not.toContain("cancelRequestedAt");
  });

  it("running and pending keep the old immediate semantics", async () => {
    for (const status of ["running", "pending"]) {
      const rows = [{ id: "t1", shop: SHOP, status }];
      const { db, batchUpdateMany } = store(rows);
      expect(await cancelTask(db, SHOP, "t1")).toEqual({ ok: true, mode: "cancelled" });
      expect(rows[0].status).toBe("cancelled");
      expect(batchUpdateMany).not.toHaveBeenCalled();
    }
  });

  it("submitting, cancel_requested and every terminal state are refused and left untouched", async () => {
    for (const status of ["submitting", "cancel_requested", "completed", "failed", "cancelled", "batch_unreachable"]) {
      const rows = [{ id: "t1", shop: SHOP, status }];
      const { db } = store(rows);
      expect(await cancelTask(db, SHOP, "t1")).toEqual({ ok: false, reason: "notCancellable" });
      expect(rows[0].status).toBe(status);
    }
  });

  it("another shop's task cannot be cancelled", async () => {
    const rows = [{ id: "t1", shop: "other.myshopify.com", status: "waiting_batch" }];
    const { db } = store(rows);
    expect(await cancelTask(db, SHOP, "t1")).toEqual({ ok: false, reason: "notCancellable" });
    expect(rows[0].status).toBe("waiting_batch");
  });

  it("a failed mirror onto the batch row does not fail the cancel (the Task status is authoritative)", async () => {
    const rows = [{ id: "t1", shop: SHOP, status: "waiting_batch" }];
    const { db, batchUpdateMany } = store(rows);
    batchUpdateMany.mockRejectedValueOnce(new Error("db blink"));
    expect(await cancelTask(db, SHOP, "t1")).toEqual({ ok: true, mode: "requested" });
    expect(rows[0].status).toBe("cancel_requested");
  });
});

describe("deleteTask", () => {
  it("refuses an open batch task, server-side, in every open state", async () => {
    for (const status of ["submitting", "waiting_batch", "cancel_requested"]) {
      const rows = [{ id: "t1", shop: SHOP, status }];
      const { db } = store(rows);
      expect(await deleteTask(db, SHOP, "t1")).toEqual({ ok: false, reason: "openBatch" });
      expect(rows).toHaveLength(1);
    }
  });

  it("deletes a settled task, including batch_unreachable", async () => {
    for (const status of ["completed", "failed", "cancelled", "batch_unreachable"]) {
      const rows = [{ id: "t1", shop: SHOP, status }];
      const { db } = store(rows);
      expect(await deleteTask(db, SHOP, "t1")).toEqual({ ok: true });
      expect(rows).toHaveLength(0);
    }
  });

  it("an unknown task (or another shop's) is not found", async () => {
    const rows = [{ id: "t1", shop: "other.myshopify.com", status: "completed" }];
    const { db } = store(rows);
    expect(await deleteTask(db, SHOP, "t1")).toEqual({ ok: false, reason: "notFound" });
    expect(rows).toHaveLength(1);
  });
});
