/**
 * The batch task states (submitting / waiting_batch / cancel_requested /
 * batch_unreachable, PLAN_BULK_TRANSLATE_BATCHING 19.4) are free strings in
 * `Task.status`, so nothing but these tests notices a filter that forgets them.
 * Every list that means "this task is still going" must name them; the reaper
 * must NOT reap a waiting batch; the three expiry sweeps must not delete one.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ACTIVE_TASK_STATUSES,
  OPEN_BATCH_TASK_STATUSES,
  RUN_OCCUPYING_TASK_STATUSES,
  NOT_OPEN_BATCH_TASK,
  SETTLED_TASK_STATUSES,
  isOpenBatchTaskStatus,
  isTranslatePollTerminal,
  translatePollDelayMs,
} from "../../app/config/task-statuses.js";
import { TERMINAL_TASK_STATUSES } from "~/services/tasks/task-watch.shared";

const root = join(__dirname, "..", "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

describe("status vocabulary", () => {
  it("the open batch states are active and occupy the single-flight, but are not terminal", () => {
    expect(OPEN_BATCH_TASK_STATUSES).toEqual(["submitting", "waiting_batch", "cancel_requested"]);
    for (const s of OPEN_BATCH_TASK_STATUSES) {
      expect(ACTIVE_TASK_STATUSES).toContain(s);
      expect(RUN_OCCUPYING_TASK_STATUSES).toContain(s);
      expect(TERMINAL_TASK_STATUSES.has(s)).toBe(false);
      expect(SETTLED_TASK_STATUSES).not.toContain(s);
      expect(isOpenBatchTaskStatus(s)).toBe(true);
    }
    expect(ACTIVE_TASK_STATUSES).toEqual(expect.arrayContaining(["pending", "queued", "running"]));
  });

  it("batch_unreachable is terminal everywhere and not open", () => {
    expect(TERMINAL_TASK_STATUSES.has("batch_unreachable")).toBe(true);
    expect(SETTLED_TASK_STATUSES).toContain("batch_unreachable");
    expect(ACTIVE_TASK_STATUSES).not.toContain("batch_unreachable");
    expect(isOpenBatchTaskStatus("batch_unreachable")).toBe(false);
    expect(isTranslatePollTerminal("batch_unreachable")).toBe(true);
  });

  it("the bulk-translate page polls a waiting batch slowly and ends on cancelled / batch_unreachable", () => {
    expect(translatePollDelayMs("waiting_batch")).toBeGreaterThanOrEqual(30_000);
    expect(translatePollDelayMs("running")).toBe(2_000);
    expect(translatePollDelayMs(undefined)).toBe(2_000);
    for (const s of ["completed", "completed_with_errors", "failed", "cancelled", "batch_unreachable"]) {
      expect(isTranslatePollTerminal(s)).toBe(true);
    }
    for (const s of ["pending", "running", "submitting", "waiting_batch", "cancel_requested"]) {
      expect(isTranslatePollTerminal(s)).toBe(false);
    }
  });
});

describe("every 'still going' filter names the batch states", () => {
  it.each([
    "app/routes/api.running-tasks-count.tsx",
    "app/routes/api.running-tasks-list.tsx",
    "app/routes/api.running-field-tasks.tsx",
  ])("%s uses ACTIVE_TASK_STATUSES, not a hand-written list", (file) => {
    const src = read(file);
    expect(src).toContain("ACTIVE_TASK_STATUSES");
    expect(src).not.toMatch(/\["pending",\s*"queued",\s*"running"\]/);
  });

  it("the bulk-translate page loader and the handler's single-flight use the occupying list", () => {
    expect(read("app/routes/app.bulk_.translate.tsx")).toContain("RUN_OCCUPYING_TASK_STATUSES");
    const handler = read("app/routes/api-ai-handlers/bulk-editor-translate.handler.ts");
    expect(handler.match(/RUN_OCCUPYING_TASK_STATUSES/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("the Tasks tab offers Cancel for a waiting batch and refuses Delete server-side", () => {
    const src = read("app/routes/app.tasks.tsx");
    expect(src).toContain("TASK_STATUS_WAITING_BATCH");
    expect(src).toContain("deleteTask(");
    expect(src).not.toContain("db.task.delete(");
  });
});

describe("the reaper and the boot recovery do not reap a waiting batch", () => {
  it("no hard-coded 'running' list in the recovery modules mentions a batch state", () => {
    for (const file of ["orphan-run-recovery.js", "task-recovery.service.js"]) {
      const src = read(file);
      expect(src).toMatch(/NON_TERMINAL = \['?"?running/);
      const nonTerminal = src.match(/const NON_TERMINAL = \[[^\]]*\]/)?.[0] ?? "";
      for (const s of ["waiting_batch", "cancel_requested", "submitting"]) expect(nonTerminal).not.toContain(s);
    }
  });
});

describe("expiry sweeps exclude the open batch statuses (all three)", () => {
  it("the shared fragment excludes exactly the open statuses", () => {
    expect(NOT_OPEN_BATCH_TASK).toEqual({ status: { notIn: ["submitting", "waiting_batch", "cancel_requested"] } });
  });

  it("task-cleanup.service.js: both deleteMany calls carry the exclusion", async () => {
    const deleteMany = vi.fn(async () => ({ count: 0 }));
    (globalThis as any).__db = { task: { deleteMany } };
    const { TaskCleanupService } = await import("../../task-cleanup.service.js");
    const svc = (TaskCleanupService as any).getInstance();
    await svc.cleanup();
    await svc.triggerCleanup();
    expect(deleteMany).toHaveBeenCalledTimes(2);
    for (const call of deleteMany.mock.calls as any[]) {
      expect(call[0].where.status).toEqual({ notIn: [...OPEN_BATCH_TASK_STATUSES] });
      expect(call[0].where.expiresAt).toBeDefined();
    }
    delete (globalThis as any).__db;
  });

  it("sync-scheduler and scripts/cleanup-database.js: the expiresAt branch carries the exclusion", () => {
    const scheduler = read("app/services/sync-scheduler.service.ts");
    expect(scheduler).toMatch(/\{ expiresAt: \{ lt: new Date\(\) \}, \.\.\.NOT_OPEN_BATCH_TASK \}/);
    const script = read("scripts/cleanup-database.js");
    expect(script).toMatch(/\{ expiresAt: \{ lt: new Date\(\) \}, \.\.\.NOT_OPEN_BATCH_TASK \}/);
    // no remaining expiresAt-only task delete anywhere
    for (const src of [scheduler, script]) {
      expect(src).not.toMatch(/\{ expiresAt: \{ lt: new Date\(\) \} \}/);
    }
  });
});

describe("the batch state is pruned only once settled and released", () => {
  it("the scheduler cleanup deletes 'done' batch rows that no longer hold a reservation", () => {
    const scheduler = read("app/services/sync-scheduler.service.ts");
    expect(scheduler).toMatch(/bulkTranslateBatch\.deleteMany\(\{\s*where: \{ state: 'done', reservationState: \{ not: 'held' \}/);
  });
});

describe("/api/task-result never ships a result for an open batch task", () => {
  const findUnique = vi.fn();
  beforeEach(() => {
    findUnique.mockReset();
    vi.resetModules();
  });

  async function load() {
    vi.doMock("../../app/shopify.server", () => ({
      authenticate: { admin: async () => ({ session: { shop: "s.myshopify.com" } }) },
    }));
    vi.doMock("../../app/db.server", () => ({ db: { task: { findUnique } } }));
    vi.doMock("~/utils/logger.server", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
    return (await import("../../app/routes/api.task-result")).loader;
  }

  it("blanks `result` while the batch is open, keeps it once settled", async () => {
    const loader = await load();
    const call = () =>
      loader({ request: new Request("https://x/api/task-result?taskId=t1"), params: {}, context: {} } as any);

    findUnique.mockResolvedValue({ id: "t1", shop: "s.myshopify.com", type: "bulkEditorTranslate", status: "waiting_batch", result: '{"manifest":"secret"}' });
    const open: any = await call();
    expect((open.data ?? open).task.result).toBeNull();

    findUnique.mockResolvedValue({ id: "t1", shop: "s.myshopify.com", type: "bulkEditorTranslate", status: "completed", result: '{"saved":3}' });
    const done: any = await call();
    expect((done.data ?? done).task.result).toBe('{"saved":3}');
  });
});
