/**
 * The SUBMIT half of the Batch-API mode (PLAN_BULK_TRANSLATE_BATCHING 5.3 / 6.3):
 * the order of the steps (intent record BEFORE the provider call, reservation
 * before money can be spent, the batch id stored unconditionally), what the
 * manifest holds (no source text), the worst-case reservation at the batch tier,
 * every refusal (consent, budget, taster, provider, nothing to send) and what
 * happens when the Task is no longer ours at the moment the id comes back.
 * The provider is a stub: nothing here sends a request.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create: vi.fn(), batches: {} }; } }));
vi.mock("openai", () => ({ default: class { chat = { completions: { create: vi.fn() } }; } }));

const log: string[] = [];
const h = vi.hoisted(() => ({
  reserve: vi.fn(),
  release: vi.fn(),
  convert: vi.fn(),
  budget: vi.fn(),
  pool: vi.fn(),
  settle: vi.fn(),
  cancel: vi.fn(),
  retrieve: vi.fn(),
  planRead: vi.fn(),
}));

vi.mock("~/services/ai/usage-meter.server", () => ({
  reserveBudget: (...a: unknown[]) => h.reserve(...a),
  releaseBudget: (...a: unknown[]) => h.release(...a),
  convertReservation: (...a: unknown[]) => h.convert(...a),
  currentAiUsagePeriod: () => "m:2026-11",
}));
vi.mock("~/services/ai/managed-budget.server", () => ({ managedBudgetStatus: (...a: unknown[]) => h.budget(...a) }));
vi.mock("~/services/ai/managed-global-pool.server", () => ({
  globalPoolPeriod: () => "m:2026-11",
  globalPoolStatus: (...a: unknown[]) => h.pool(...a),
}));
vi.mock("~/services/ai/ai-credentials.server", () => ({
  aiServiceFor: vi.fn(() => {
    throw new Error("the test passes its own service");
  }),
  settlementCredentialsFor: (...a: unknown[]) => h.settle(...a),
}));
vi.mock("~/services/bulk-editor/translate-plan-read.server", () => ({
  planCellKey: (r: string, c: string) => `${r}|${c}`,
  planTranslateRead: (...a: unknown[]) => h.planRead(...a),
}));
vi.mock("~/services/shopify-api-gateway.service", () => ({ ShopifyApiGateway: class {} }));
vi.mock("~/utils/logger.server", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { submitBulkTranslateBatch } from "~/services/bulk-editor/translate-batch-submit.server";
import { BULK_COLUMNS_BY_TYPE } from "~/services/bulk-editor/columns.shared";
import { BATCH_CUSTOM_ID_PATTERN, parseManifest } from "~/services/bulk-editor/translate-batch.shared";
import { priceCall } from "~/config/ai-pricing";
import { AIService, BatchCreateError, ManagedAiRefusedError } from "../../src/services/ai.service";

const col = (id: string) => BULK_COLUMNS_BY_TYPE.product.find((c) => c.id === id)!;
const LOCALES = ["fr", "es"];
const ROW = (n: number) => `gid://shopify/Product/${n}`;

const classifiers = {
  isGroupedColumn: (c: { id: string }) => c.id === "field.productType",
  isValueColumn: () => false,
  isShortColumn: (c: { id: string }) => ["field.title", "field.seoTitle", "field.handle"].includes(c.id),
  isListValuesColumn: () => false,
  isHandleColumn: (c: { id: string }) => c.id === "field.handle",
  isTitleColumn: (c: { id: string }) => c.id === "field.title",
};

const jobs = (count: number, extra = false) =>
  Array.from({ length: count }, (_, i) => ({
    rowId: ROW(i + 1),
    primaryHandle: "",
    cells: [
      { column: col("field.title"), fieldKey: "title", source: `Schal ${i + 1}x`, locales: LOCALES },
      ...(extra ? [{ column: col("field.productType"), fieldKey: "productType", source: "Accessoires", locales: LOCALES }] : []),
    ],
  }));

function makeDb(opts: { taskStillOurs?: boolean; idStoreFails?: boolean; txFails?: boolean; resumedByRecovery?: boolean; parkedByRecovery?: boolean; adoptMisses?: boolean; namedInState?: string; rereadThrows?: boolean } = {}) {
  let polledAdopted = false;
  const calls: { op: string; arg: any }[] = [];
  const rowState = { state: "submitting", batchIds: [] as string[], manifest: "" };
  const db: any = {
    calls,
    task: {
      updateMany: vi.fn(async (arg: any) => {
        calls.push({ op: "task.updateMany", arg });
        // the flip waiting_batch is only conditional on `submitting`
        if (arg.data.status === "waiting_batch" && opts.taskStillOurs === false) return { count: 0 };
        return { count: 1 };
      }),
      findUnique: vi.fn(async () => ({ status: opts.namedInState ? "failed" : opts.resumedByRecovery || opts.parkedByRecovery ? "waiting_batch" : "cancelled" })),
    },
    bulkTranslateBatch: {
      create: vi.fn(async (arg: any) => {
        log.push("row.create");
        calls.push({ op: "row.create", arg });
        rowState.manifest = arg.data.manifest;
        return { id: "row-1", ...arg.data };
      }),
      update: vi.fn(async (arg: any) => {
        log.push("row.update");
        calls.push({ op: "row.update", arg });
        if (opts.idStoreFails) throw new Error("db down");
        rowState.batchIds = arg.data.batchIds ?? rowState.batchIds;
        return {};
      }),
      updateMany: vi.fn(async (arg: any) => {
        calls.push({ op: "row.updateMany", arg });
        if (opts.adoptMisses && arg.where.state === "create_unknown") {
          polledAdopted = true; // the poller got there first
          return { count: 0 };
        }
        if (arg.data.batchIds) rowState.batchIds = arg.data.batchIds;
        if (arg.data.state) rowState.state = arg.data.state;
        return { count: 1 };
      }),
      findUnique: vi.fn(async () => {
        if (opts.rereadThrows) throw new Error("db blink");
        if (opts.namedInState) return { id: "row-1", state: opts.namedInState, batchIds: ["msgbatch_1"], manifest: rowState.manifest };
        return {
        id: "row-1", provider: "claude", model: "claude-haiku-4-5", source: "managed", reservationState: "held",
        batchIds: opts.resumedByRecovery || polledAdopted ? ["msgbatch_1"] : opts.parkedByRecovery ? [] : rowState.batchIds,
        state: polledAdopted ? "waiting" : opts.resumedByRecovery ? "waiting" : opts.parkedByRecovery ? "create_unknown" : rowState.state,
        manifest: rowState.manifest,
      };
      }),
    },
    $transaction: vi.fn(async (fn: any) => {
      if (opts.txFails) throw new Error("tx failed");
      return fn(db);
    }),
  };
  return db;
}

function fakeService(over: Record<string, unknown> = {}) {
  let n = 0;
  return {
    packageLimits: vi.fn(() => ({ provider: "claude", model: "claude-haiku-4-5", maxOutputTokens: 32_000, bucketTpm: 40_000 })),
    batchGate: vi.fn(async () => ({
      provider: "claude", model: "claude-haiku-4-5", source: "managed", role: "default", period: "b:2026-12-01", pool: "paid",
    })),
    buildBatchRequest: vi.fn(async (customId: string, req: any) => ({
      customId,
      prompt: `PROMPT ${++n} ${req.items.map((i: any) => i.text).join("|")}`,
      maxTokens: 1500,
      inputEstimateTokens: 400,
    })),
    createBatch: vi.fn(async (_requests: unknown, _gate: unknown) => {
      log.push("provider.create");
      return { batchId: "msgbatch_1", expiresAt: "2026-11-13T12:00:00Z" };
    }),
    ...over,
  } as any;
}

const args = (db: any, service: any, over: Record<string, unknown> = {}) => ({
  db,
  shop: "s.myshopify.com",
  admin: {} as any,
  settings: { subscriptionPlan: "pro" } as any,
  jobs: jobs(3, true) as any,
  units: 12,
  rowType: "product" as const,
  moType: "",
  primaryLocale: "de",
  contentType: "product",
  targetLocales: LOCALES,
  instructionsFor: () => "Keep brand names.",
  classifiers,
  service,
  ...over,
});

beforeEach(() => {
  log.length = 0;
  for (const fn of Object.values(h)) fn.mockReset();
  h.planRead.mockImplementation(async (_d: unknown, list: any[]) => ({
    jobs: list,
    expected: new Map(list.map((j) => [`${j.rowId}|field.title`, { [j.rowId]: `d-${j.rowId}` }])),
    skippedChanged: 0,
    failures: [],
    mismatchesByKey: {},
  }));
  h.reserve.mockImplementation(async () => (log.push("reserve"), { applied: true, micros: 1 }));
  h.release.mockResolvedValue({ applied: true, micros: 1 });
  h.convert.mockResolvedValue({ applied: true, micros: 1 });
  h.budget.mockResolvedValue({ kind: "period", allowed: true, remainingMicros: 50_000_000, usedMicros: 0, limitMicros: 50_000_000, period: "b:2026-12-01" });
  h.pool.mockResolvedValue({ allowed: true, limitMicros: null, spentMicros: 0 });
  h.cancel.mockResolvedValue({});
  h.retrieve.mockResolvedValue({ providerStatus: "canceling", ended: false, requestCounts: { total: 1, processing: 1, succeeded: 0, errored: 0, expired: 0, canceled: 0 } });
  h.settle.mockResolvedValue({ ok: true, transport: { cancel: h.cancel, retrieve: h.retrieve } });
});

describe("the happy path (managed)", () => {
  it("runs the steps in the fixed order: intent row -> reservation -> provider create -> id stored -> Task waiting_batch", async () => {
    const db = makeDb();
    const out = await submitBulkTranslateBatch("task-1", args(db, fakeService()));

    expect(out).toMatchObject({ ok: true, batchRowId: "row-1", batchId: "msgbatch_1", requests: 1 });
    expect(log).toEqual(["row.create", "reserve", "provider.create", "row.update"]);
    // the Task is `submitting` first, `waiting_batch` last (conditional on `submitting`)
    const taskUpdates = db.calls.filter((c: any) => c.op === "task.updateMany").map((c: any) => c.arg);
    expect(taskUpdates[0]).toMatchObject({ where: { id: "task-1", status: "running" }, data: { status: "submitting" } });
    const flip = taskUpdates.find((a: any) => a.data.status === "waiting_batch");
    expect(flip.where).toEqual({ id: "task-1", status: "submitting" });
    // Task.expiresAt: the provider's own expiry + 3 days, so no cleanup deletes a waiting task
    expect(flip.data.expiresAt).toEqual(new Date(Date.parse("2026-11-13T12:00:00Z") + 3 * 24 * 3600 * 1000));
    // the batch id is written WITHOUT a status condition
    expect(db.calls.find((c: any) => c.op === "row.update").arg).toEqual({ where: { id: "row-1" }, data: { batchIds: ["msgbatch_1"] } });
    // the row ends `waiting`, flipped in the SAME transaction as the Task (never one without the other)
    expect(db.calls.some((c: any) => c.op === "row.updateMany" && c.arg.data.state === "waiting")).toBe(true);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
  });

  it("the INTENT row pins everything the later booking needs: provider, model, source, role, period, pool, pool period, id prefix", async () => {
    const db = makeDb();
    await submitBulkTranslateBatch("task-1", args(db, fakeService()));
    const data = db.calls.find((c: any) => c.op === "row.create").arg.data;
    expect(data).toMatchObject({
      taskId: "task-1",
      shop: "s.myshopify.com",
      state: "submitting",
      provider: "claude",
      model: "claude-haiku-4-5",
      source: "managed",
      role: "default",
      period: "b:2026-12-01",
      pool: "paid",
      poolPeriod: "m:2026-11",
      idPrefix: "ttask-1_p",
    });
    expect(data.intentAt).toBeInstanceOf(Date);
  });

  it("the manifest holds hashes, signatures and digests -- NO source text -- and only the cells the packages carry", async () => {
    const db = makeDb();
    await submitBulkTranslateBatch("task-1", args(db, fakeService()));
    const text = db.calls.find((c: any) => c.op === "row.create").arg.data.manifest as string;
    expect(text).not.toContain("Schal 1x");
    expect(text).not.toContain("Accessoires");
    const manifest = parseManifest(text)!;
    expect(manifest.cells).toHaveLength(3); // the three titles; productType (grouped) is not carried
    expect(manifest.cells[0]).toMatchObject({ r: ROW(1), c: "field.title", l: LOCALES, e: { [ROW(1)]: `d-${ROW(1)}` } });
    expect(manifest.cells[0].h).toMatch(/^[0-9a-f]{16}$/);
    expect(manifest.requests).toHaveLength(1);
    expect(manifest.requests[0].items).toHaveLength(3);
    // each item also carries its signature WITHIN the instruction group it was asked under (State M1)
    expect(manifest.requests[0].groupSigs).toHaveLength(3);
    expect(new Set(manifest.requests[0].groupSigs).size).toBe(3);
    expect(manifest.requests[0].customId).toMatch(BATCH_CUSTOM_ID_PATTERN);
    // 3 products x 1 cell not carried (productType) x 2 locales
    expect(manifest.plan.notStarted).toBe(6);
    expect(manifest.units).toBe(12);
    expect(manifest.locales).toEqual(LOCALES);
  });

  it("reserves the WORST CASE at the batch tier: sum of (estimated input + max_tokens SENT), priced with the model's batch factor", async () => {
    const db = makeDb();
    await submitBulkTranslateBatch("task-1", args(db, fakeService()));
    const expected = priceCall("claude", "claude-haiku-4-5", 400, 1500, { tier: "batch" }).costMicros;
    expect(h.reserve).toHaveBeenCalledWith("row-1", { billedMicros: expected });
    // and it IS the batch tier: cheaper than the same tokens at the standard price
    expect(expected).toBeLessThan(priceCall("claude", "claude-haiku-4-5", 400, 1500).costMicros);
  });

  it("sends custom_ids that carry the task id and satisfy the provider's documented pattern", async () => {
    const service = fakeService();
    const db = makeDb();
    await submitBulkTranslateBatch("cm3abcdefghijklmnopqrstuv", args(db, service));
    const sent = service.createBatch.mock.calls[0][0];
    expect(sent.map((r: any) => r.customId)).toEqual(["tcm3abcdefghijklmnopqrstuv_p0"]);
    expect(sent[0].customId).toMatch(BATCH_CUSTOM_ID_PATTERN);
  });
});

describe("an own-key (BYO) run", () => {
  it("reserves nothing, checks no budget or pool, and pins the current calendar period", async () => {
    const service = fakeService({ batchGate: vi.fn(async () => ({ provider: "claude", model: "claude-haiku-4-5", source: "byo", role: "default" })) });
    const db = makeDb();
    const out = await submitBulkTranslateBatch("task-1", args(db, service));
    expect(out.ok).toBe(true);
    expect(h.reserve).not.toHaveBeenCalled();
    expect(h.budget).not.toHaveBeenCalled();
    expect(h.pool).not.toHaveBeenCalled();
    expect(db.calls.find((c: any) => c.op === "row.create").arg.data).toMatchObject({ source: "byo", period: "m:2026-11", pool: "", poolPeriod: "" });
  });
});

describe("refusals -- nothing is created, nothing is reserved", () => {
  const failedTask = (db: any) => db.calls.map((c: any) => c.arg).find((a: any) => a.data?.status === "failed");

  it("consent missing / kill switch / budget at the gate: the TYPED managed refusal becomes the Task error", async () => {
    const service = fakeService({ batchGate: vi.fn(async () => { throw new ManagedAiRefusedError("consentMissing"); }) });
    const db = makeDb();
    const out = await submitBulkTranslateBatch("task-1", args(db, service));
    expect(out).toEqual({ ok: false, code: "managed_ai_refused:consentMissing" });
    expect(failedTask(db).data.error).toBe("managed_ai_refused:consentMissing");
    expect(db.bulkTranslateBatch.create).not.toHaveBeenCalled();
    expect(service.createBatch).not.toHaveBeenCalled();
    expect(h.reserve).not.toHaveBeenCalled();
  });

  it("a remaining budget below the worst case is refused as budgetExceeded BEFORE the intent row", async () => {
    h.budget.mockResolvedValue({ kind: "period", allowed: true, remainingMicros: 10, usedMicros: 0, limitMicros: 10, period: "b:2026-12-01" });
    const db = makeDb();
    const out = await submitBulkTranslateBatch("task-1", args(db, fakeService()));
    expect(out).toEqual({ ok: false, code: "managed_ai_refused:budgetExceeded" });
    expect(db.bulkTranslateBatch.create).not.toHaveBeenCalled();
  });

  it("a global pool that cannot cover it is managedUnavailable", async () => {
    h.pool.mockResolvedValue({ allowed: true, limitMicros: 1_000, spentMicros: 900 });
    const out = await submitBulkTranslateBatch("task-1", args(makeDb(), fakeService()));
    expect(out).toEqual({ ok: false, code: "managed_ai_refused:managedUnavailable" });
  });

  it("the taster gets no batch -- by the pool the gate pinned or by the budget kind", async () => {
    const byPool = await submitBulkTranslateBatch("task-1", args(makeDb(), fakeService({
      batchGate: vi.fn(async () => ({ provider: "claude", model: "claude-haiku-4-5", source: "managed", role: "default", period: "taster", pool: "taster" })),
    })));
    expect(byPool).toEqual({ ok: false, code: "batch_not_available" });
    h.budget.mockResolvedValue({ kind: "taster", allowed: true, remainingMicros: 99_999_999, usedMicros: 0, limitMicros: 99_999_999, period: "taster" });
    const byBudget = await submitBulkTranslateBatch("task-1", args(makeDb(), fakeService()));
    expect(byBudget).toEqual({ ok: false, code: "batch_not_available" });
  });

  it("a budget that cannot be read refuses (the per-shop direction: unread evidence protects the money)", async () => {
    h.budget.mockResolvedValue({ kind: "period", allowed: false, readFailed: true, remainingMicros: 0, usedMicros: 0, limitMicros: 0, period: "b" });
    const out = await submitBulkTranslateBatch("task-1", args(makeDb(), fakeService()));
    expect(out).toEqual({ ok: false, code: "managed_ai_refused:managedUnavailable" });
  });

  it("a provider without a batch API is refused before anything is read or built", async () => {
    const service = fakeService({ packageLimits: vi.fn(() => ({ provider: "gemini", model: "gemini-2.5-flash", maxOutputTokens: 8192, bucketTpm: null })) });
    const out = await submitBulkTranslateBatch("task-1", args(makeDb(), service));
    expect(out).toEqual({ ok: false, code: "batch_not_available" });
    expect(service.buildBatchRequest).not.toHaveBeenCalled();
  });

  it("everything dropped at the plan (nothing the provider can do) is its own answer, not a silent success", async () => {
    h.planRead.mockResolvedValue({ jobs: [], expected: new Map(), skippedChanged: 12, failures: [], mismatchesByKey: {} });
    const out = await submitBulkTranslateBatch("task-1", args(makeDb(), fakeService()));
    expect(out).toEqual({ ok: false, code: "batch_nothing_to_submit" });
  });

  it("a Task that is not `running` any more is not ours: nothing is read, built or sent", async () => {
    const db = makeDb();
    db.task.updateMany = vi.fn(async () => ({ count: 0 }));
    const out = await submitBulkTranslateBatch("task-1", args(db, fakeService()));
    expect(out).toEqual({ ok: false, code: "task_not_ours" });
    expect(h.planRead).not.toHaveBeenCalled();
  });
});

describe("the provider refuses or the reservation cannot be written", () => {
  const refusal = () => new BatchCreateError("model does not support batches\nsorry", true, 400);

  it("a create the provider REFUSES (definitive): Task failed with the provider's words after batch_submit_refused:, row done, hold RELEASED", async () => {
    const service = fakeService({ createBatch: vi.fn(async () => { throw refusal(); }) });
    const db = makeDb();
    const out = await submitBulkTranslateBatch("task-1", args(db, service));
    expect(out).toEqual({ ok: false, code: "batch_submit_refused:model does not support batches sorry" });
    const failed = db.calls.map((c: any) => c.arg).find((a: any) => a.data?.status === "failed");
    expect(failed.data.error).toBe("batch_submit_refused:model does not support batches sorry");
    expect(db.calls.some((c: any) => c.op === "row.updateMany" && c.arg.data.state === "done")).toBe(true);
    expect(h.release).toHaveBeenCalledWith("row-1");
  });

  it("a reservation that cannot be written REFUSES the submit: no provider call, the intent row is closed", async () => {
    h.reserve.mockResolvedValue({ applied: false, reason: "failed" });
    const service = fakeService();
    const db = makeDb();
    const out = await submitBulkTranslateBatch("task-1", args(db, service));
    expect(out.ok).toBe(false);
    expect(service.createBatch).not.toHaveBeenCalled();
    expect(db.calls.some((c: any) => c.op === "row.updateMany" && c.arg.data.state === "done")).toBe(true);
  });

  it("a typed managed refusal from the create (budget at the call) is the managed code, not a provider refusal", async () => {
    const service = fakeService({ createBatch: vi.fn(async () => { throw new ManagedAiRefusedError("budgetExceeded"); }) });
    const out = await submitBulkTranslateBatch("task-1", args(makeDb(), service));
    expect(out).toEqual({ ok: false, code: "managed_ai_refused:budgetExceeded" });
  });

  it("the gate's answer is what createBatch is handed (M3: no create without the gate)", async () => {
    const service = fakeService();
    await submitBulkTranslateBatch("task-1", args(makeDb(), service));
    const gate = await service.batchGate.mock.results[0].value;
    expect(service.createBatch.mock.calls[0][1]).toBe(gate);
  });
});

describe("H1: a create of UNKNOWN outcome (timeout, abort, dropped connection, 5xx) keeps the hold", () => {
  for (const [name, error] of [
    ["a timeout", new BatchCreateError("Request timed out.", false)],
    ["an overloaded provider (529)", new BatchCreateError("overloaded", false, 529)],
    ["a plain unclassified failure", new Error("socket hang up")],
  ] as const) {
    it(`${name}: the hold is NOT released, the row waits as create_unknown, the Task as waiting_batch, and nothing says "nothing was charged"`, async () => {
      const service = fakeService({ createBatch: vi.fn(async () => { throw error; }) });
      const db = makeDb();
      const out = await submitBulkTranslateBatch("task-1", args(db, service));
      expect(out).toEqual({ ok: false, code: "batch_create_unconfirmed" });
      expect(h.release).not.toHaveBeenCalled();
      expect(h.convert).not.toHaveBeenCalled(); // converted only at the absolute end, after the search
      expect(db.calls.some((c: any) => c.op === "row.updateMany" && c.arg.data.state === "create_unknown")).toBe(true);
      expect(db.calls.some((c: any) => c.op === "row.updateMany" && c.arg.data.state === "done")).toBe(false);
      const taskFlip = db.calls.map((c: any) => c.arg).find((a: any) => a.data?.status === "waiting_batch");
      expect(taskFlip.where).toEqual({ id: "task-1", status: "submitting" });
      expect(taskFlip.data.expiresAt).toBeInstanceOf(Date);
      // no failed Task, and never the "refused" code
      expect(db.calls.map((c: any) => c.arg).find((a: any) => a.data?.status === "failed")).toBeUndefined();
      expect(JSON.stringify(db.calls)).not.toContain("batch_submit_refused");
      // park: Task and row in ONE transaction
      expect(db.$transaction).toHaveBeenCalledTimes(1);
    });
  }

  it("the row keeps the intent (id prefix, intentAt, manifest) the poller searches the provider with", async () => {
    const service = fakeService({ createBatch: vi.fn(async () => { throw new BatchCreateError("timeout", false); }) });
    const db = makeDb();
    await submitBulkTranslateBatch("task-1", args(db, service));
    const data = db.calls.find((c: any) => c.op === "row.create").arg.data;
    expect(data).toMatchObject({ idPrefix: "ttask-1_p", state: "submitting" });
    expect(data.intentAt).toBeInstanceOf(Date);
    expect(parseManifest(data.manifest)!.requests).toHaveLength(1);
  });

  it("an exception thrown around the create (after it was sent, before an answer) is unknown too, never 'refused'", async () => {
    const service = fakeService();
    const db = makeDb({ txFails: false });
    h.reserve.mockImplementation(async () => (log.push("reserve"), { applied: true, micros: 1 }));
    service.createBatch = vi.fn(async () => { throw new TypeError("cannot read properties of undefined"); });
    const out = await submitBulkTranslateBatch("task-1", args(db, service));
    expect(out).toEqual({ ok: false, code: "batch_create_unconfirmed" });
    expect(h.release).not.toHaveBeenCalled();
  });
});

describe("H1-state: a failure AFTER the create takes the 'not ours' path", () => {
  it("the batch id cannot be stored (DB down three times): cancel at once, the hold is NOT released (the counts decide), the Task fails as unconfirmed", async () => {
    const db = makeDb({ idStoreFails: true });
    const out = await submitBulkTranslateBatch("task-1", args(db, fakeService()));
    expect(out).toEqual({ ok: false, code: "task_not_ours" });
    expect(db.bulkTranslateBatch.update).toHaveBeenCalledTimes(3);
    expect(h.cancel).toHaveBeenCalledWith("msgbatch_1");
    // still canceling: nothing proven -> neither released nor converted yet; the row stays open for the poller
    expect(h.release).not.toHaveBeenCalled();
    expect(h.convert).not.toHaveBeenCalled();
    expect(db.calls.some((c: any) => c.op === "row.updateMany" && c.arg.data.state === "cancel_requested")).toBe(true);
    expect(db.calls.some((c: any) => c.op === "row.updateMany" && c.arg.data.state === "done")).toBe(false);
    // the id is still written for the settlement allowlist
    expect(db.calls.some((c: any) => c.op === "row.updateMany" && JSON.stringify(c.arg.data.batchIds) === '["msgbatch_1"]')).toBe(true);
    expect(db.calls.map((c: any) => c.arg).find((a: any) => a.data?.status === "failed")?.data.error).toBe("batch_submit_unconfirmed");
  });

  it("the Task/row transaction fails (DB error): same path, and the batch is cancelled", async () => {
    const db = makeDb({ txFails: true });
    const out = await submitBulkTranslateBatch("task-1", args(db, fakeService()));
    expect(out.ok).toBe(false);
    expect(h.cancel).toHaveBeenCalledWith("msgbatch_1");
    expect(h.release).not.toHaveBeenCalled();
    expect(db.calls.map((c: any) => c.arg).find((a: any) => a.data?.status === "failed")?.data.error).toBe("batch_submit_unconfirmed");
  });

  it("once the provider PROVES nothing ran (ended, nothing succeeded) the hold goes back and the row is closed", async () => {
    h.retrieve.mockResolvedValue({ providerStatus: "ended", ended: true, requestCounts: { total: 1, processing: 0, succeeded: 0, errored: 0, expired: 0, canceled: 1 } });
    const db = makeDb({ txFails: true });
    await submitBulkTranslateBatch("task-1", args(db, fakeService()));
    expect(h.release).toHaveBeenCalledWith("row-1");
    expect(db.calls.some((c: any) => c.op === "row.updateMany" && c.arg.data.state === "done")).toBe(true);
  });
});

describe("the Task is no longer ours when the batch id comes back (cancelled, deleted, failed by recovery)", () => {
  it("cancels the batch AT ONCE through the settlement transport; a cancel is no proof, so the hold waits for the counts", async () => {
    const db = makeDb({ taskStillOurs: false });
    const out = await submitBulkTranslateBatch("task-1", args(db, fakeService()));
    expect(out).toEqual({ ok: false, code: "task_not_ours" });
    expect(h.settle).toHaveBeenCalledWith("s.myshopify.com", "row-1");
    expect(h.cancel).toHaveBeenCalledWith("msgbatch_1");
    expect(h.release).not.toHaveBeenCalled();
    expect(h.convert).not.toHaveBeenCalled();
    expect(db.calls.some((c: any) => c.op === "row.updateMany" && c.arg.data.state === "cancel_requested")).toBe(true);
    // the Task is somebody else's decision: not touched
    expect(db.calls.map((c: any) => c.arg).find((a: any) => a.data?.status === "failed")).toBeUndefined();
  });

  it("an ended batch that SUCCEEDED somewhere is booked pro rata, not released", async () => {
    h.retrieve.mockResolvedValue({ providerStatus: "ended", ended: true, requestCounts: { total: 1, processing: 0, succeeded: 1, errored: 0, expired: 0, canceled: 0 } });
    const db = makeDb({ taskStillOurs: false });
    await submitBulkTranslateBatch("task-1", args(db, fakeService()));
    expect(h.convert).toHaveBeenCalledWith("row-1", { bookMicros: expect.any(Number) });
    expect(h.release).not.toHaveBeenCalled();
  });

  it("a cancel that FAILS and nothing readable: the hold is neither released nor converted here (the poller / the absolute end decide)", async () => {
    h.cancel.mockRejectedValue(new Error("provider down"));
    h.retrieve.mockRejectedValue(new Error("provider down"));
    await submitBulkTranslateBatch("task-1", args(makeDb({ taskStillOurs: false }), fakeService()));
    expect(h.release).not.toHaveBeenCalled();
    expect(h.convert).not.toHaveBeenCalled();
  });

  it("a Task the RECOVERY merely resumed (waiting_batch over a waiting row naming this batch) is still ours: the batch is NOT cancelled", async () => {
    const db = makeDb({ taskStillOurs: false, resumedByRecovery: true });
    const out = await submitBulkTranslateBatch("task-1", args(db, fakeService()));
    expect(out).toMatchObject({ ok: true, batchId: "msgbatch_1" });
    expect(h.cancel).not.toHaveBeenCalled();
    expect(h.release).not.toHaveBeenCalled();
  });
});

describe("a row that names this batch is ours in ANY state (M3)", () => {
  for (const state of ["waiting", "cancel_requested", "collecting"]) {
    it(`${state}: not abandoned, not settled`, async () => {
      const out = await submitBulkTranslateBatch("task-1", args(makeDb({ taskStillOurs: false, namedInState: state }), fakeService()));
      expect(out).toMatchObject({ ok: true, batchId: "msgbatch_1" });
      expect(h.cancel).not.toHaveBeenCalled();
      expect(h.release).not.toHaveBeenCalled();
      expect(h.convert).not.toHaveBeenCalled();
    });
  }
  it("a done row naming the batch is NOT ours: the batch is cancelled at the provider, never adopted, the row is not reopened", async () => {
    const db = makeDb({ taskStillOurs: false, namedInState: "done" });
    const out = await submitBulkTranslateBatch("task-1", args(db, fakeService()));
    expect(out).toEqual({ ok: false, code: "task_not_ours" });
    expect(h.cancel).toHaveBeenCalledWith("msgbatch_1");
    const reopen = db.calls.filter((c: any) => c.op === "row.updateMany" && c.arg.data.state === "cancel_requested");
    for (const c of reopen) expect(c.arg.where.state).toEqual({ in: ["submitting", "create_unknown"] });
  });
  it("a re-read that fails once is retried and then judged normally", async () => {
    const db = makeDb({ taskStillOurs: false, namedInState: "waiting" });
    let n = 0;
    const real = db.bulkTranslateBatch.findUnique;
    db.bulkTranslateBatch.findUnique = vi.fn(async (a: any) => {
      if (n++ === 0) throw new Error("db blink");
      return real(a);
    });
    const out = await submitBulkTranslateBatch("task-1", { ...args(db, fakeService()), rereadRetryDelayMs: 0 });
    expect(out).toMatchObject({ ok: true, batchId: "msgbatch_1" });
    expect(n).toBeGreaterThan(1);
    expect(h.cancel).not.toHaveBeenCalled();
  });
  it("a re-read that keeps throwing: the run is NOT cancelled from here; the row is handed to the poller as cancel_requested (conditional on submitting, no cancelRequestedAt), the task is not failed, no hold release", async () => {
    const db = makeDb({ taskStillOurs: false, rereadThrows: true });
    const out = await submitBulkTranslateBatch("task-1", { ...args(db, fakeService()), rereadRetryDelayMs: 0 });
    expect(out).toEqual({ ok: false, code: "task_not_ours" });
    expect(db.bulkTranslateBatch.findUnique.mock.calls.length).toBeGreaterThanOrEqual(5);
    expect(h.cancel).not.toHaveBeenCalled();
    const moves = db.calls.filter((c: any) => c.op === "row.updateMany" && c.arg.data.state === "cancel_requested");
    expect(moves.length).toBe(1);
    expect(moves[0].arg.data.cancelRequestedAt).toBeUndefined();
    expect(moves[0].arg.where).toEqual({ id: expect.any(String), state: "submitting" });
    expect(db.calls.some((c: any) => c.op === "row.updateMany" && c.arg.data.cancelRequestedAt)).toBe(false);
    expect(db.calls.map((c: any) => c.arg).find((a: any) => a.data?.status === "failed")).toBeUndefined();
    expect(h.release).not.toHaveBeenCalled();
  });
  it("an UNCONFIRMED cancel leaves cancelRequestedAt unset and reopens a done row for the poller (never closed here)", async () => {
    h.cancel.mockRejectedValue(new Error("provider down"));
    h.retrieve.mockResolvedValue({ providerStatus: "ended", ended: true, requestCounts: { total: 1, processing: 0, succeeded: 0, errored: 0, expired: 0, canceled: 1 } });
    const db = makeDb({ taskStillOurs: false, namedInState: "done" });
    const out = await submitBulkTranslateBatch("task-1", args(db, fakeService()));
    expect(out).toEqual({ ok: false, code: "task_not_ours" });
    expect(db.calls.some((c: any) => c.op === "row.updateMany" && c.arg.data.cancelRequestedAt instanceof Date)).toBe(false);
    const reopen = db.calls.find((c: any) => c.op === "row.updateMany" && c.arg.where.state === "done");
    expect(reopen.arg.data).toMatchObject({ state: "cancel_requested", cancelRequestedAt: null });
    expect(db.calls.some((c: any) => c.op === "row.updateMany" && c.arg.data.state === "done")).toBe(false);
  });
});

describe("a row parked as create_unknown by a recovery while the runner was alive", () => {
  it("the answer arrived after all: the batch is OURS, the row flips to waiting with the batch id (conditional), nothing is cancelled", async () => {
    const db = makeDb({ taskStillOurs: false, parkedByRecovery: true });
    const out = await submitBulkTranslateBatch("task-1", args(db, fakeService()));
    expect(out).toMatchObject({ ok: true, batchId: "msgbatch_1" });
    expect(h.cancel).not.toHaveBeenCalled();
    expect(h.release).not.toHaveBeenCalled();
    const adopt = db.calls.find((c: any) => c.op === "row.updateMany" && c.arg.where.state === "create_unknown");
    expect(adopt.arg.data).toMatchObject({ batchIds: ["msgbatch_1"], state: "waiting" });
  });
});

describe("the adopt of a create_unknown row matches nothing", () => {
  it("the poller adopted the batch first (row waiting, names the batch): still ours, nothing is cancelled or abandoned", async () => {
    const db = makeDb({ taskStillOurs: false, parkedByRecovery: true, adoptMisses: true });
    const out = await submitBulkTranslateBatch("task-1", args(db, fakeService()));
    expect(out).toMatchObject({ ok: true, batchId: "msgbatch_1" });
    expect(h.cancel).not.toHaveBeenCalled();
    expect(h.release).not.toHaveBeenCalled();
  });
});

describe("the plan the handler resolved is the plan the budget is checked with", () => {
  it("passes args.plan, not a second reading of the settings", async () => {
    await submitBulkTranslateBatch("task-1", args(makeDb(), fakeService(), { plan: "max", settings: { subscriptionPlan: "free" } as any }));
    expect(h.budget.mock.calls[0][2]).toBe("max");
  });
});

describe("the payload cap", () => {
  it("a package that would push the batch past the byte cap is not sent: it is reported as not started, never half-sent", async () => {
    const big = "x".repeat(5 * 1024 * 1024);
    let n = 0;
    const service = fakeService({
      buildBatchRequest: vi.fn(async (customId: string) => ({ customId, prompt: big + ++n, maxTokens: 1500, inputEstimateTokens: 400 })),
    });
    // three groups of titles -> force several packages by instructions
    const out = await submitBulkTranslateBatch("task-1", args(makeDb(), service, { jobs: jobs(3) as any, instructionsFor: (k: string[]) => k.join(",") + Math.random() }));
    if (out.ok) expect(out.requests).toBeLessThanOrEqual(1);
    const sent = service.createBatch.mock.calls[0]?.[0] ?? [];
    const bytes = sent.reduce((acc: number, r: any) => acc + Buffer.byteLength(r.prompt), 0);
    expect(bytes).toBeLessThanOrEqual(8 * 1024 * 1024);
  });
});

describe("static guards", () => {
  it("the submit path talks to the provider only through AIService (no SDK import, no env read)", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(__dirname, "..", "..", "app/services/bulk-editor/translate-batch-submit.server.ts"), "utf8");
    expect(src).not.toMatch(/@anthropic-ai\/sdk|from "openai"|process\.env/);
    expect(AIService.batchSupportedFor("claude")).toBe(true);
  });
});
