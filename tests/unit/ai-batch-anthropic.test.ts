/**
 * The Anthropic Batch API surface of AIService (PLAN_BULK_TRANSLATE_BATCHING 5):
 * the request builder (same prompt as the live path), the submit gate, the
 * create call, and the SETTLEMENT operations (retrieve / results / cancel /
 * deleteFile) with the provider's four result types. The SDK is mocked: nothing
 * here touches a provider, so what it proves is the mapping, not the provider.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const sdk = vi.hoisted(() => ({
  create: vi.fn(),
  retrieve: vi.fn(),
  cancel: vi.fn(),
  results: vi.fn(),
  list: vi.fn(),
  ctorArgs: [] as unknown[],
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: vi.fn(), batches: { create: sdk.create, retrieve: sdk.retrieve, cancel: sdk.cancel, results: sdk.results, list: sdk.list } };
    constructor(args: unknown) {
      sdk.ctorArgs.push(args);
    }
  },
}));
vi.mock("openai", () => ({ default: class { chat = { completions: { create: vi.fn() } }; } }));
vi.mock("../../src/services/ai-queue.service", () => ({
  MAX_RATE_LIMIT_RETRIES: 3,
  rateLimitBucket: (source: string, provider: string) => `${source}:${provider}`,
  AIQueueService: { getInstance: vi.fn().mockReturnValue({ getBucketTokenLimit: () => 40_000, enqueue: vi.fn() }) },
}));
vi.mock("../../app/db.server", () => ({ db: { task: { update: vi.fn(), findUnique: vi.fn() } } }));
vi.mock("../../app/services/ai/usage-meter.server", () => ({ recordAiUsage: vi.fn() }));

import { AIService, BatchCreateError, isDefinitiveBatchRefusal, isManagedRefusal } from "../../src/services/ai.service";
import { maxOutputTokensFor } from "../../app/config/ai-model-limits";

const SHOP = "demo.myshopify.com";

function service(extra: Record<string, unknown> = {}) {
  const svc = new AIService("claude", { claudeApiKey: "k", selectedModel: "claude-haiku-4-5", ...extra } as never, SHOP, "task-1");
  (svc as any).getGlossaryDirective = async () => "";
  return svc;
}

const REQ = {
  kind: "short" as const,
  fromLang: "de",
  locales: ["fr", "es"],
  items: [{ id: "k1", text: "Schal" }, { id: "k2", text: "Mütze" }],
  contentType: "product",
  instructions: "Keep brand names.",
  plannedOutputTokens: 400,
  timeoutMs: 120_000,
};

beforeEach(() => {
  sdk.create.mockReset();
  sdk.retrieve.mockReset();
  sdk.cancel.mockReset();
  sdk.results.mockReset();
  sdk.list.mockReset();
  sdk.ctorArgs.length = 0;
});

describe("buildBatchRequest", () => {
  it("sends the SAME prompt the live package path sends, as one user turn, with the sent max_tokens", async () => {
    const svc = service();
    const built = await svc.buildBatchRequest("t1_p0", REQ);
    expect(built.customId).toBe("t1_p0");
    // rules + the merchant's instructions first, items after, answer skeleton last
    expect(built.prompt).toContain("Translate EVERY item into EVERY target language");
    expect(built.prompt).toContain("Keep brand names.");
    expect(built.prompt.indexOf("Keep brand names.")).toBeLessThan(built.prompt.indexOf("Schal"));
    expect(built.prompt).toContain('"id":"k2","text":"Mütze"');
    // planned 400 -> 600 with headroom, never below 256
    expect(built.maxTokens).toBe(600);
    expect(built.inputEstimateTokens).toBeGreaterThan(50);
  });

  it("clamps max_tokens to the serving model's ceiling", async () => {
    const svc = service({ selectedModel: "claude-unknown-model-x" });
    const built = await svc.buildBatchRequest("t1_p0", { ...REQ, plannedOutputTokens: 1_000_000 });
    expect(built.maxTokens).toBeLessThanOrEqual(maxOutputTokensFor('claude', 'claude-unknown-model-x'));
  });
});

describe("batchGate", () => {
  it("is the typed managed refusal when the instance was refused at build time", async () => {
    const svc = service({ managedRefusal: "consentMissing", credentialSource: "managed" });
    const err = await svc.batchGate().catch((e) => e);
    expect(isManagedRefusal(err)).toBe(true);
    expect(err.message).toBe("managed_ai_refused:consentMissing");
  });

  it("runs the per-request preflight of a managed service and pins its answer (period, pool, role)", async () => {
    const preflight = vi.fn(async () => ({ ok: true as const, period: "b:2026-12-01", pool: "paid" as const }));
    const svc = service({ credentialSource: "managed", preflight });
    expect(await svc.batchGate()).toEqual({
      provider: "claude",
      model: "claude-haiku-4-5",
      source: "managed",
      role: "default",
      period: "b:2026-12-01",
      pool: "paid",
    });
    expect(preflight).toHaveBeenCalledTimes(1);
  });

  it("a preflight refusal (budget) is the typed refusal, not a generic error", async () => {
    const svc = service({
      credentialSource: "managed",
      preflight: async () => ({ ok: false as const, reason: "budgetExceeded", usedMicros: 10, limitMicros: 10 }),
    });
    const err = await svc.batchGate().catch((e) => e);
    expect(isManagedRefusal(err)).toBe(true);
    expect(err.reason).toBe("budgetExceeded");
  });

  it("an own-key service needs no preflight and reports byo", async () => {
    expect(await service().batchGate()).toMatchObject({ source: "byo", provider: "claude" });
  });

  it("a provider without a batch API is refused", async () => {
    const svc = new AIService("gemini", { geminiApiKey: "k" } as never, SHOP, "task-1");
    await expect(svc.batchGate()).rejects.toThrow(/batch_unsupported:gemini/);
    expect(AIService.batchSupportedFor("gemini")).toBe(false);
    expect(AIService.batchSupportedFor("claude")).toBe(true);
  });
});

describe("createBatch", () => {
  const REQS = [
    { customId: "t1_p0", prompt: "PROMPT A", maxTokens: 600, inputEstimateTokens: 10 },
    { customId: "t1_p1", prompt: "PROMPT B", maxTokens: 300, inputEstimateTokens: 10 },
  ];

  it("maps requests to {custom_id, params}, one user turn each, never retried", async () => {
    sdk.create.mockResolvedValue({ id: "msgbatch_1", expires_at: "2026-11-13T00:00:00Z" });
    const svc = service();
    const out = await svc.createBatch(REQS, await svc.batchGate());
    expect(out).toEqual({ batchId: "msgbatch_1", expiresAt: "2026-11-13T00:00:00Z" });
    const [body, options] = sdk.create.mock.calls[0];
    expect(body.requests).toEqual([
      { custom_id: "t1_p0", params: { model: "claude-haiku-4-5", max_tokens: 600, messages: [{ role: "user", content: "PROMPT A" }] } },
      { custom_id: "t1_p1", params: { model: "claude-haiku-4-5", max_tokens: 300, messages: [{ role: "user", content: "PROMPT B" }] } },
    ]);
    expect(options.maxRetries).toBe(0);
  });

  it("M3: it cannot be called without the answer of batchGate() -- no gate, a made-up gate or another instance's gate is refused before any provider call", async () => {
    const svc = service();
    await expect(svc.createBatch(REQS, undefined as never)).rejects.toThrow("batch_gate_required");
    await expect(svc.createBatch(REQS, { provider: "claude", model: "claude-haiku-4-5", source: "byo", role: "default" })).rejects.toThrow("batch_gate_required");
    const other = service();
    await expect(svc.createBatch(REQS, await other.batchGate())).rejects.toThrow("batch_gate_required");
    expect(sdk.create).not.toHaveBeenCalled();
  });

  it("M3: an instance refused at build time cannot create even with a gate in hand", async () => {
    const svc = service();
    const gate = await svc.batchGate();
    (svc as never as { config: { managedRefusal?: string } }).config.managedRefusal = "consentMissing";
    const err = await svc.createBatch(REQS, gate).catch((e) => e);
    expect(isManagedRefusal(err)).toBe(true);
    expect(sdk.create).not.toHaveBeenCalled();
  });

  describe("a failed create says whether the provider REFUSED it or the outcome is UNKNOWN", () => {
    const fail = async (error: unknown) => {
      sdk.create.mockRejectedValue(error);
      const svc = service();
      return svc.createBatch(REQS, await svc.batchGate()).catch((e) => e);
    };
    it("a 4xx with a body is a definitive refusal (nothing was created)", async () => {
      for (const status of [400, 401, 403, 413, 429]) {
        const err = await fail(Object.assign(new Error("bad"), { status, error: { type: "invalid_request_error" } }));
        expect(err).toBeInstanceOf(BatchCreateError);
        expect(err).toMatchObject({ definitive: true, status });
      }
    });
    it("a timeout, an abort, a dropped connection, a 5xx / 529, a 408 or a 409 leave the outcome UNKNOWN", async () => {
      for (const e of [
        new Error("Request timed out."),
        Object.assign(new Error("aborted"), { name: "AbortError" }),
        Object.assign(new Error("Connection error."), { name: "APIConnectionError" }),
        Object.assign(new Error("overloaded"), { status: 529, error: { type: "overloaded_error" } }),
        Object.assign(new Error("boom"), { status: 500, error: { type: "api_error" } }),
        Object.assign(new Error("timeout"), { status: 408, error: {} }),
        Object.assign(new Error("conflict"), { status: 409, error: {} }),
      ]) {
        const err = await fail(e);
        expect(err).toBeInstanceOf(BatchCreateError);
        expect(err.definitive).toBe(false);
      }
    });
    it("classifies on the status and the body, never on the wording", () => {
      expect(isDefinitiveBatchRefusal({ status: 400, error: {} })).toBe(true);
      expect(isDefinitiveBatchRefusal({ status: 400 })).toBe(false); // no body, no message: not a refusal we can read
      expect(isDefinitiveBatchRefusal({ status: 500, message: "invalid request" })).toBe(false);
      expect(isDefinitiveBatchRefusal(null)).toBe(false);
    });
  });
});

describe("M4: the reservation's input estimate is script-aware", () => {
  it("Latin text keeps the pessimistic ~3 characters per token; CJK, Thai, Arabic, Hebrew run ~1 per character and are never reserved at a third", () => {
    const latin = "a".repeat(300);
    const cjk = "日".repeat(300);
    expect(AIService.estimateInputTokensForBatch(latin)).toBeLessThanOrEqual(115);
    expect(AIService.estimateInputTokensForBatch(latin)).toBeGreaterThanOrEqual(100);
    for (const ch of ["日", "한", "ก", "ع", "א", "अ"]) {
      expect(AIService.estimateInputTokensForBatch(ch.repeat(300))).toBeGreaterThanOrEqual(300);
    }
    expect(AIService.estimateInputTokensForBatch(cjk)).toBeGreaterThan(3 * AIService.estimateInputTokensForBatch(latin) - 20);
    // Cyrillic sits between, an emoji (astral) counts double
    expect(AIService.estimateInputTokensForBatch("я".repeat(300))).toBeGreaterThanOrEqual(150);
    expect(AIService.estimateInputTokensForBatch("😀".repeat(100))).toBeGreaterThanOrEqual(200);
    expect(AIService.estimateInputTokensForBatch("")).toBe(0);
  });

  it("buildBatchRequest uses it", async () => {
    const built = await service().buildBatchRequest("t1_p0", { ...REQ, items: [{ id: "k1", text: "日本語のテキスト".repeat(50) }] });
    expect(built.inputEstimateTokens).toBeGreaterThanOrEqual(400);
  });
});

describe("settlementOps (claude)", () => {
  const counts = (over: Record<string, number> = {}) => ({ processing: 0, succeeded: 0, errored: 0, expired: 0, canceled: 0, ...over });

  it("only the Anthropic provider has real operations here", () => {
    expect(AIService.settlementOps("openai", "k")).toBeNull();
    expect(AIService.settlementOps("claude", "k")).not.toBeNull();
  });

  it("retrieve normalises the provider status", async () => {
    sdk.retrieve.mockResolvedValue({ processing_status: "ended", expires_at: "2026-11-13T00:00:00Z", request_counts: counts({ succeeded: 3, errored: 1 }) });
    const status = await AIService.settlementOps("claude", "k")!.retrieve("msgbatch_1");
    expect(status).toMatchObject({
      providerStatus: "ended",
      ended: true,
      canceling: false,
      requestCounts: { total: 4, processing: 0, succeeded: 3, errored: 1, expired: 0, canceled: 0 },
      expiresAt: "2026-11-13T00:00:00Z",
    });
  });

  it("cancel of a running batch returns the provider's canceling state", async () => {
    sdk.cancel.mockResolvedValue({ processing_status: "canceling", request_counts: counts({ processing: 5 }) });
    expect(await AIService.settlementOps("claude", "k")!.cancel("msgbatch_1")).toMatchObject({ canceling: true, ended: false });
  });

  it("cancel of a batch that already ended is not a failure -- nothing is running", async () => {
    sdk.cancel.mockRejectedValue(Object.assign(new Error("batch already ended"), { status: 400 }));
    sdk.retrieve.mockResolvedValue({ processing_status: "ended", request_counts: counts({ succeeded: 2 }) });
    expect(await AIService.settlementOps("claude", "k")!.cancel("msgbatch_1")).toMatchObject({ ended: true });
  });

  it("cancel that fails while the batch still runs rethrows the original error", async () => {
    sdk.cancel.mockRejectedValue(new Error("503"));
    sdk.retrieve.mockResolvedValue({ processing_status: "in_progress", request_counts: counts({ processing: 2 }) });
    await expect(AIService.settlementOps("claude", "k")!.cancel("msgbatch_1")).rejects.toThrow("503");
  });

  it("results maps succeeded / errored / expired / canceled, truncation and the cache parts", async () => {
    const lines = [
      {
        custom_id: "t1_p0",
        result: {
          type: "succeeded",
          message: {
            content: [{ type: "text", text: '{"k1":{"fr":"Echarpe"}}' }],
            stop_reason: "end_turn",
            usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 10 },
          },
        },
      },
      {
        custom_id: "t1_p1",
        result: { type: "succeeded", message: { content: [{ type: "text", text: "{" }], stop_reason: "max_tokens", usage: { input_tokens: 5, output_tokens: 600 } } },
      },
      { custom_id: "t1_p2", result: { type: "errored", error: { type: "error", error: { type: "invalid_request_error", message: "bad request" } } } },
      { custom_id: "t1_p3", result: { type: "expired" } },
      { custom_id: "t1_p4", result: { type: "canceled" } },
    ];
    sdk.results.mockResolvedValue((async function* () {
      for (const l of lines) yield l;
    })());
    const items = [];
    for await (const item of AIService.settlementOps("claude", "k")!.results("msgbatch_1")) items.push(item);
    expect(items).toEqual([
      {
        customId: "t1_p0",
        outcome: "succeeded",
        text: '{"k1":{"fr":"Echarpe"}}',
        truncated: false,
        // input_tokens EXCLUDES the cache parts: the total is the sum of the three
        usage: { inputTokens: 140, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 10, serviceTier: null },
      },
      { customId: "t1_p1", outcome: "succeeded", text: "{", truncated: true, usage: { inputTokens: 5, outputTokens: 600, serviceTier: null } },
      { customId: "t1_p2", outcome: "errored", error: "bad request" },
      { customId: "t1_p3", outcome: "expired" },
      { customId: "t1_p4", outcome: "canceled" },
    ]);
  });

  it("Anthropic batches leave no files: deleteFile is a no-op", async () => {
    await expect(AIService.settlementOps("claude", "k")!.deleteFile("anything")).resolves.toBeUndefined();
  });

  it("the key reaches only the SDK client constructor", () => {
    AIService.settlementOps("claude", "sk-secret");
    expect(sdk.ctorArgs[0]).toMatchObject({ apiKey: "sk-secret" });
  });
});

describe("parsePackageAnswer", () => {
  it("is the live path's parser: fenced JSON parses, a cut-off answer is invalid whatever it looks like", () => {
    expect(AIService.parsePackageAnswer('```json\n{"k1":{"fr":"a"}}\n```', false)).toEqual({ parsed: { k1: { fr: "a" } } });
    expect(AIService.parsePackageAnswer('{"k1":{"fr":"a"}}', true)).toEqual({ parsed: null, invalid: "truncated" });
    expect(AIService.parsePackageAnswer("no json here", false)).toEqual({ parsed: null, invalid: "unparseable" });
  });
});

describe("settlementOps.findIntentBatch (a create whose answer never arrived)", () => {
  const batch = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    created_at: "2026-11-12T10:00:30Z",
    expires_at: "2026-11-13T10:00:30Z",
    processing_status: "ended",
    request_counts: { processing: 0, succeeded: 2, errored: 0, expired: 0, canceled: 0 },
    ...over,
  });
  const list = (items: unknown[]) => sdk.list.mockReturnValue((async function* () { for (const i of items) yield i; })());
  const firstLine = (customId: string) => sdk.results.mockImplementation(async () => (async function* () { yield { custom_id: customId, result: { type: "canceled" } }; })());
  const query = { idPrefix: "ttask-1_p", since: "2026-11-12T10:00:00Z", requestCount: 2 };
  const ops = () => AIService.settlementOps("claude", "k")!;

  it("adopts an ENDED batch created since the intent with the same request count whose first custom_id carries OUR prefix", async () => {
    list([batch("msgbatch_x")]);
    firstLine("ttask-1_p0");
    expect(await ops().findIntentBatch!(query)).toEqual({ found: true, batchId: "msgbatch_x", expiresAt: "2026-11-13T10:00:30Z" });
  });

  it("never adopts a stranger's batch: a different prefix, a different request count or an older batch", async () => {
    list([batch("a"), batch("b", { request_counts: { processing: 0, succeeded: 9, errored: 0, expired: 0, canceled: 0 } }), batch("c", { created_at: "2026-11-11T00:00:00Z" })]);
    firstLine("tother_p0");
    expect(await ops().findIntentBatch!(query)).toEqual({ found: false, pending: false });
  });

  it("reads a stranger's candidate batch ONCE: a rejected candidate is not inspected again on the next tick", async () => {
    const q = { ...query, idPrefix: "tonce_p" };
    list([batch("stranger")]);
    firstLine("tother_p0");
    expect(await ops().findIntentBatch!(q)).toEqual({ found: false, pending: false });
    expect(sdk.results).toHaveBeenCalledTimes(1);
    list([batch("stranger")]);
    expect(await ops().findIntentBatch!(q)).toEqual({ found: false, pending: false });
    expect(sdk.results).toHaveBeenCalledTimes(1);
  });

  it("a RUNNING candidate cannot be told from a stranger's (its request ids are unreadable): pending, never adopted", async () => {
    list([batch("run", { processing_status: "in_progress", request_counts: { processing: 2, succeeded: 0, errored: 0, expired: 0, canceled: 0 } })]);
    expect(await ops().findIntentBatch!(query)).toEqual({ found: false, pending: true });
    expect(sdk.results).not.toHaveBeenCalled();
  });
});
