/**
 * The handler's side of the Batch-API mode (PLAN_BULK_TRANSLATE_BATCHING 5.1 /
 * 5.3 / 15): the estimate offers the cheaper mode ONLY when the SERVER says this
 * shop may use it (a provider with a batch API, not a taster, not refused);
 * a batch start re-decides that (the route takes a direct POST) and answers
 * BATCH_NOT_AVAILABLE instead of silently running live; an eligible start claims
 * the single-flight, hands the run to the SUBMIT path and never to the live
 * runner; everything else is the live run, byte for byte.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("~/utils/logger.server", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const titleColumn = {
  id: "field.title", kind: "field", label: "title", group: "content", editable: true, translatable: true, inputType: "text", minWidth: 100,
} as any;

vi.mock("~/utils/shop-locales-cache.server", () => ({
  getCachedShopLocales: async () => [
    { locale: "de", primary: true, name: "German" },
    { locale: "fr", primary: false, name: "French" },
    { locale: "es", primary: false, name: "Spanish" },
  ],
}));
vi.mock("~/services/bulk-editor/columns.server", () => ({ buildServerColumnsByType: async () => ({ product: [titleColumn] }) }));
const scan = vi.fn();
vi.mock("~/services/bulk-editor/missing-translations.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/services/bulk-editor/missing-translations.server")>()),
  scanMissingTranslations: (...a: unknown[]) => scan(...a),
  translateCandidateColumns: () => [titleColumn],
}));
const aiServiceFor = vi.fn();
vi.mock("~/services/ai/ai-credentials.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/services/ai/ai-credentials.server")>()),
  aiServiceFor: (...a: unknown[]) => aiServiceFor(...a),
}));
const managedBudgetStatus = vi.fn();
vi.mock("~/services/ai/managed-budget.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/services/ai/managed-budget.server")>()),
  managedBudgetStatus: (...a: unknown[]) => managedBudgetStatus(...a),
}));
const submit = vi.fn();
vi.mock("~/services/bulk-editor/translate-batch-submit.server", () => ({ submitBulkTranslateBatch: (...a: unknown[]) => submit(...a) }));
const createAIService = vi.fn();
vi.mock("~/routes/api-ai-handlers/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/routes/api-ai-handlers/shared")>();
  return { ...actual, createAIService: (...a: unknown[]) => createAIService(...a) };
});
vi.mock("~/utils/offline-admin.server", () => ({ backgroundAdmin: (_shop: string, admin: unknown) => admin }));
vi.mock("~/services/bulk-editor/apply.server", () => ({ applyBulkDiff: vi.fn() }));

import { handleBulkEditorTranslate } from "~/routes/api-ai-handlers/bulk-editor-translate.handler";
import { initialTranslateSelection, serializeTranslateSelection } from "~/services/bulk-editor/translate-missing.shared";
import { batchEligibility } from "~/services/bulk-editor/translate-batch-eligibility.server";

const claudeLimits = { provider: "claude", model: "claude-haiku-4-5", maxOutputTokens: 32_000, bucketTpm: 40_000 };
const service = (limits: Record<string, unknown> = claudeLimits) => ({ packageLimits: () => limits, translateShortFieldsBatch: vi.fn() });
const byo = (limits?: Record<string, unknown>) => ({ service: service(limits), decision: { ok: true, source: "byo", provider: limits?.provider ?? "claude" } });
const managed = (limits?: Record<string, unknown>) => ({ service: service(limits), decision: { ok: true, source: "managed", provider: limits?.provider ?? "claude" } });

function makeDb() {
  return {
    task: {
      create: vi.fn(async () => ({ id: "task-1", createdAt: new Date() })),
      findFirst: vi.fn(async () => null),
      updateMany: vi.fn(async () => ({ count: 1 })),
      update: vi.fn(),
      deleteMany: vi.fn(),
    },
    aIInstructions: { findUnique: vi.fn(async () => null) },
    metaobjectDefinition: { findMany: vi.fn(async () => []) },
  } as any;
}

function ctx(db: any, extra: Record<string, string> = {}, settings: any = { subscriptionPlan: "pro" }) {
  const formData = new FormData();
  const fields: Record<string, string> = {
    rowType: "product",
    locales: "fr,es",
    selection: JSON.stringify(serializeTranslateSelection(initialTranslateSelection(["field.title"]))),
    ...extra,
  };
  for (const [k, v] of Object.entries(fields)) formData.set(k, v);
  return { session: { shop: "s.myshopify.com" }, admin: { graphql: vi.fn() }, db, formData, settings, seoLimits: null, translationMode: undefined } as any;
}
const bodyOf = (res: any) => res.data ?? res;
const statusOf = (res: any) => res.init?.status ?? res.status;

beforeEach(() => {
  for (const fn of [scan, aiServiceFor, managedBudgetStatus, submit, createAIService]) fn.mockReset();
  scan.mockResolvedValue({
    items: Array.from({ length: 30 }, (_, i) => ({
      rowId: `gid://shopify/Product/${i}`,
      title: `P${i}`,
      subtitle: "",
      primaryHandle: "",
      columns: [{ columnId: "field.title", locales: ["fr", "es"], source: `Wollschal Modell ${i}` }],
    })),
    unitsByColumnLocale: {},
    scanTruncated: false,
    matchedRows: 30,
    scannedRows: 30,
  });
  aiServiceFor.mockReturnValue(byo());
  submit.mockResolvedValue({ ok: true });
  createAIService.mockImplementation(() => {
    throw new Error("the live runner must not be started for a batch");
  });
});

describe("batchEligibility", () => {
  it("claude on the merchant's own key: yes", async () => {
    expect(await batchEligibility({} as any, "s.myshopify.com", "pro")).toEqual({ available: true, provider: "claude", model: "claude-haiku-4-5", source: "byo" });
  });

  it("claude on the managed key: yes, unless it is the one-time TASTER", async () => {
    aiServiceFor.mockReturnValue(managed());
    managedBudgetStatus.mockResolvedValue({ kind: "period", readFailed: false, unavailable: false });
    expect(await batchEligibility({} as any, "s", "pro")).toMatchObject({ available: true, source: "managed" });
    managedBudgetStatus.mockResolvedValue({ kind: "taster", readFailed: false, unavailable: false });
    expect(await batchEligibility({} as any, "s", "pro")).toEqual({ available: false, reason: "taster" });
  });

  it("a managed budget that cannot be read is not offered (a batch needs a hold against it)", async () => {
    aiServiceFor.mockReturnValue(managed());
    managedBudgetStatus.mockResolvedValue({ kind: "period", readFailed: true });
    expect(await batchEligibility({} as any, "s", "pro")).toEqual({ available: false, reason: "unavailable" });
  });

  it("providers without a batch API (Gemini, OpenAI for now, Grok, DeepSeek, HuggingFace) and refused shops: no", async () => {
    for (const provider of ["gemini", "grok", "deepseek", "huggingface"]) {
      aiServiceFor.mockReturnValue(byo({ ...claudeLimits, provider }));
      expect(await batchEligibility({} as any, "s", "pro")).toEqual({ available: false, reason: "provider" });
    }
    aiServiceFor.mockReturnValue({ service: service(), decision: { ok: false, reason: "noKey", provider: "claude" } });
    expect(await batchEligibility({} as any, "s", "pro")).toEqual({ available: false, reason: "refused" });
    aiServiceFor.mockImplementation(() => { throw new Error("boom"); });
    expect(await batchEligibility({} as any, "s", "pro")).toEqual({ available: false, reason: "unavailable" });
  });
});

describe("the estimate offers the cheaper mode only when the server says so", () => {
  it("claude (own key): the estimate carries a batch alternative that is cheaper than the live price", async () => {
    const res = bodyOf(await handleBulkEditorTranslate(ctx(makeDb(), { estimateOnly: "true" })));
    expect(res.success).toBe(true);
    expect(res.estimate.batch).toBeTruthy();
    expect(res.estimate.batch.costMicros).toBeLessThan(res.estimate.costMicros);
    expect(res.estimate.batch.requests).toBeGreaterThan(0);
  });

  it("a provider without a batch API: no alternative in the estimate", async () => {
    aiServiceFor.mockReturnValue(byo({ ...claudeLimits, provider: "gemini", model: "gemini-2.5-flash" }));
    const res = bodyOf(await handleBulkEditorTranslate(ctx(makeDb(), { estimateOnly: "true" })));
    expect(res.estimate.batch).toBeUndefined();
  });

  it("managed: the alternative names what a batch must RESERVE and whether the remaining budget covers it", async () => {
    aiServiceFor.mockReturnValue(managed());
    managedBudgetStatus.mockResolvedValue({ kind: "period", remainingMicros: 1, limitMicros: 20_000_000, readFailed: false });
    const res = bodyOf(await handleBulkEditorTranslate(ctx(makeDb(), { estimateOnly: "true" })));
    expect(res.estimate.batch.reserveMicros).toBeGreaterThan(res.estimate.batch.costMicros);
    expect(res.estimate.batch.wouldExceed).toBe(true);
  });

  it("an estimate never creates a Task", async () => {
    const db = makeDb();
    await handleBulkEditorTranslate(ctx(db, { estimateOnly: "true" }));
    expect(db.task.create).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });
});

describe("starting with mode=batch", () => {
  it("an ineligible shop is answered BATCH_NOT_AVAILABLE (409) -- no Task, no silent live run", async () => {
    aiServiceFor.mockReturnValue(byo({ ...claudeLimits, provider: "gemini" }));
    const db = makeDb();
    const res = await handleBulkEditorTranslate(ctx(db, { mode: "batch" }));
    expect(statusOf(res)).toBe(409);
    expect(bodyOf(res)).toMatchObject({ success: false, code: "BATCH_NOT_AVAILABLE", reason: "provider" });
    expect(db.task.create).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(createAIService).not.toHaveBeenCalled();
  });

  it("a taster is refused the same way, server-side, whatever the page sent", async () => {
    aiServiceFor.mockReturnValue(managed());
    managedBudgetStatus.mockResolvedValue({ kind: "taster", readFailed: false });
    const res = await handleBulkEditorTranslate(ctx(makeDb(), { mode: "batch" }));
    expect(bodyOf(res)).toMatchObject({ code: "BATCH_NOT_AVAILABLE", reason: "taster" });
  });

  it("an eligible shop claims the single-flight and hands the run to the SUBMIT path -- never the live runner", async () => {
    const db = makeDb();
    const res = bodyOf(await handleBulkEditorTranslate(ctx(db, { mode: "batch" })));
    expect(res).toMatchObject({ success: true, taskId: "task-1", mode: "batch", total: 60 });
    expect(db.task.create).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledTimes(1);
    const [taskId, args] = submit.mock.calls[0];
    expect(taskId).toBe("task-1");
    expect(args).toMatchObject({
      shop: "s.myshopify.com",
      rowType: "product",
      primaryLocale: "de",
      targetLocales: ["fr", "es"],
      contentType: "products",
      units: 60,
    });
    expect(args.jobs).toHaveLength(30);
    expect(typeof args.instructionsFor).toBe("function");
    expect(createAIService).not.toHaveBeenCalled();
  });

  it("the single-flight still holds: a running (or waiting) run refuses a second start in either mode", async () => {
    const db = makeDb();
    db.task.findFirst = vi.fn(async () => ({ id: "other" }));
    const res = await handleBulkEditorTranslate(ctx(db, { mode: "batch" }));
    expect(statusOf(res)).toBe(409);
    expect(bodyOf(res).code).toBe("ALREADY_RUNNING");
    expect(submit).not.toHaveBeenCalled();
  });

  it("the plan gate still applies in batch mode", async () => {
    const res = await handleBulkEditorTranslate(ctx(makeDb(), { mode: "batch" }, { subscriptionPlan: "free" }));
    expect(statusOf(res)).toBe(403);
    expect(submit).not.toHaveBeenCalled();
  });

  it("without mode=batch it is the live run: the submit path is never touched", async () => {
    aiServiceFor.mockReturnValue(byo());
    createAIService.mockReturnValue({
      translateShortFieldsBatch: vi.fn(async () => ({})),
      translateFieldsToLocalesChunked: vi.fn(async () => ({})),
      translateBatchValuesToLocales: vi.fn(async () => ({})),
    });
    const db = makeDb();
    db.task.findUnique = vi.fn(async () => ({ status: "running" }));
    const res = bodyOf(await handleBulkEditorTranslate(ctx(db)));
    expect(res.success).toBe(true);
    expect(res.mode).toBeUndefined();
    expect(submit).not.toHaveBeenCalled();
  });
});
