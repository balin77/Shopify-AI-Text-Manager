/**
 * The bulk editor's "add missing translations" run on a MANAGED-AI refusal
 * mid-run: the loops stop, but what was already translated is still written
 * through applyBulkDiff, and the Task ends with `managed_ai_refused:<reason>`.
 * A rejected PROVIDER key keeps aborting the run as before.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const translateShortFieldsBatch = vi.fn();
vi.mock("~/routes/api-ai-handlers/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/routes/api-ai-handlers/shared")>();
  return { ...actual, createAIService: () => ({ translateShortFieldsBatch }) };
});
const applyBulkDiff = vi.fn();
vi.mock("~/services/bulk-editor/apply.server", () => ({ applyBulkDiff: (...a: unknown[]) => applyBulkDiff(...a) }));
vi.mock("~/utils/logger.server", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { runBulkEditorTranslate, BULK_TRANSLATE_HEARTBEAT_MS, type TranslateJob } from "~/routes/api-ai-handlers/bulk-editor-translate.handler";
import { ManagedAiRefusedError } from "../../src/services/ai.service";

const titleColumn = {
  id: "field.title",
  kind: "field",
  label: "title",
  group: "content",
  editable: true,
  translatable: true,
  inputType: "text",
  minWidth: 100,
} as unknown as TranslateJob["cells"][number]["column"];

const job = (rowId: string): TranslateJob => ({
  rowId,
  cells: [{ column: titleColumn, fieldKey: "title", source: `src ${rowId}`, locales: ["en"] }],
  primaryHandle: "",
});

function makeDb() {
  return { task: { update: vi.fn(async () => ({})), updateMany: vi.fn(async () => ({ count: 1 })) }, groupedFieldTranslation: {} } as any;
}

const run = (db: any, jobs: TranslateJob[]) =>
  runBulkEditorTranslate("task-1", {
    db,
    shop: "s.myshopify.com",
    admin: {} as any,
    settings: null as any,
    jobs,
    units: jobs.length,
    rowType: "product",
    primaryLocale: "de",
    columnsByType: {} as any,
    aiInstructions: null,
    seoLimits: null as any,
    translationMode: undefined as any,
  });

const finalUpdate = (db: any) => {
  const calls = db.task.updateMany.mock.calls.map((c: any[]) => c[0].data);
  return calls.filter((d: any) => d.completedAt)[0];
};

describe("bulk-editor translate: managed refusal mid-run", () => {
  beforeEach(() => {
    translateShortFieldsBatch.mockReset();
    applyBulkDiff.mockReset();
    applyBulkDiff.mockResolvedValue({ saved: 1, failures: [] });
  });

  it("keeps and WRITES what was translated before the refusal and stops asking", async () => {
    translateShortFieldsBatch
      .mockResolvedValueOnce({ en: { title: "Hello" } })
      .mockRejectedValueOnce(new ManagedAiRefusedError("budgetExceeded"))
      .mockResolvedValue({ en: { title: "never" } });
    const db = makeDb();
    await run(db, [job("r1"), job("r2"), job("r3")]);

    // The third row is never asked: the run stood down.
    expect(translateShortFieldsBatch).toHaveBeenCalledTimes(2);
    expect(applyBulkDiff).toHaveBeenCalledTimes(1);
    const diff = applyBulkDiff.mock.calls[0][1];
    expect(diff).toEqual([
      expect.objectContaining({ rowId: "r1", locale: "en", columnId: "field.title", value: "Hello" }),
    ]);
    const final = finalUpdate(db);
    expect(final.error).toBe("managed_ai_refused:budgetExceeded");
    expect(final.status).toBe("completed");
    const result = JSON.parse(final.result);
    expect(result.saved).toBe(1);
    expect(result.failed).toBe(2);
    // A refused cell is not reported as "AI returned no translation".
    expect(result.failures).toEqual([]);
  });

  it("a refusal on the FIRST call writes nothing and fails the Task with the refusal code", async () => {
    translateShortFieldsBatch.mockRejectedValue(new ManagedAiRefusedError("tasterExhausted"));
    const db = makeDb();
    await run(db, [job("r1"), job("r2")]);
    expect(translateShortFieldsBatch).toHaveBeenCalledTimes(1);
    expect(applyBulkDiff).not.toHaveBeenCalled();
    const final = finalUpdate(db);
    expect(final.status).toBe("failed");
    expect(final.error).toBe("managed_ai_refused:tasterExhausted");
  });

  it("a SHUTDOWN of the AI queue mid-run keeps and WRITES what was translated and ends with its own code", async () => {
    const { AIQueueShuttingDownError } = await import("../../src/services/ai-queue.service");
    translateShortFieldsBatch
      .mockResolvedValueOnce({ en: { title: "Hello" } })
      .mockRejectedValueOnce(new AIQueueShuttingDownError())
      .mockResolvedValue({ en: { title: "never" } });
    const db = makeDb();
    await run(db, [job("r1"), job("r2"), job("r3")]);
    expect(translateShortFieldsBatch).toHaveBeenCalledTimes(2);
    expect(applyBulkDiff).toHaveBeenCalledTimes(1);
    expect(applyBulkDiff.mock.calls[0][1]).toEqual([
      expect.objectContaining({ rowId: "r1", value: "Hello" }),
    ]);
    const final = finalUpdate(db);
    expect(final.error).toBe("server_shutting_down");
    expect(final.status).toBe("completed");
  });

  it("a rejected PROVIDER key still aborts the run without writing", async () => {
    const keyError = Object.assign(new Error("401 invalid x-api-key"), { status: 401, code: "INVALID_AI_KEY" });
    translateShortFieldsBatch
      .mockResolvedValueOnce({ en: { title: "Hello" } })
      .mockRejectedValueOnce(keyError);
    const { isProviderKeyRejection } = await import("../../src/services/ai.service");
    // Guard the fixture: it must be what the runner treats as a key rejection.
    expect(isProviderKeyRejection(keyError)).toBe(true);
    const db = makeDb();
    await run(db, [job("r1"), job("r2")]);
    expect(applyBulkDiff).not.toHaveBeenCalled();
    expect(finalUpdate(db).status).toBe("failed");
  });
});


describe("bulk-editor translate: liveness and monotonic finalizers", () => {
  beforeEach(() => {
    translateShortFieldsBatch.mockReset();
    applyBulkDiff.mockReset();
    applyBulkDiff.mockResolvedValue({ saved: 1, failures: [] });
  });

  it("the terminal update is CONDITIONAL on the row still running (a row somebody settled never flips back)", async () => {
    translateShortFieldsBatch.mockResolvedValue({ en: { title: "Hello" } });
    const db = makeDb();
    await run(db, [job("r1")]);
    const finals = db.task.updateMany.mock.calls.filter((c: any[]) => c[0].data.completedAt);
    expect(finals).toHaveLength(1);
    expect(finals[0][0].where).toEqual({ id: "task-1", status: "running" });
    // and nothing writes a terminal state through an unconditional update
    expect(db.task.update.mock.calls.some((c: any[]) => c[0].data.completedAt)).toBe(false);
  });

  it("a crashed run is also failed conditionally", async () => {
    translateShortFieldsBatch.mockRejectedValue(new Error("provider exploded"));
    applyBulkDiff.mockRejectedValue(new Error("write exploded"));
    const db = makeDb();
    await run(db, [job("r1")]);
    const finals = db.task.updateMany.mock.calls.filter((c: any[]) => c[0].data.completedAt);
    expect(finals.length).toBeGreaterThan(0);
    for (const c of finals) expect(c[0].where.status).toBe("running");
  });

  it("beats while an AI call is out (Task.updatedAt) and stops beating afterwards", async () => {
    vi.useFakeTimers();
    try {
      let release: (v: unknown) => void = () => {};
      translateShortFieldsBatch.mockImplementation(() => new Promise((r) => { release = r; }));
      const db = makeDb();
      const running = run(db, [job("r1")]);
      await vi.advanceTimersByTimeAsync(BULK_TRANSLATE_HEARTBEAT_MS * 3 + 10);
      const beats = () => db.task.updateMany.mock.calls.filter((c: any[]) => c[0].data.updatedAt && !c[0].data.completedAt);
      expect(beats().length).toBeGreaterThanOrEqual(3);
      expect(beats()[0][0].where).toEqual({ id: "task-1", status: "running" });
      release({ en: { title: "Hello" } });
      await running;
      const after = beats().length;
      await vi.advanceTimersByTimeAsync(BULK_TRANSLATE_HEARTBEAT_MS * 4);
      expect(beats().length).toBe(after);
    } finally {
      vi.useRealTimers();
    }
  });
});
