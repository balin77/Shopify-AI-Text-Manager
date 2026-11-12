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
  ctorArgs: [] as unknown[],
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: vi.fn(), batches: { create: sdk.create, retrieve: sdk.retrieve, cancel: sdk.cancel, results: sdk.results } };
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

import { AIService, isManagedRefusal } from "../../src/services/ai.service";
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
  it("maps requests to {custom_id, params}, one user turn each, never retried", async () => {
    sdk.create.mockResolvedValue({ id: "msgbatch_1", expires_at: "2026-11-13T00:00:00Z" });
    const out = await service().createBatch([
      { customId: "t1_p0", prompt: "PROMPT A", maxTokens: 600, inputEstimateTokens: 10 },
      { customId: "t1_p1", prompt: "PROMPT B", maxTokens: 300, inputEstimateTokens: 10 },
    ]);
    expect(out).toEqual({ batchId: "msgbatch_1", expiresAt: "2026-11-13T00:00:00Z" });
    const [body, options] = sdk.create.mock.calls[0];
    expect(body.requests).toEqual([
      { custom_id: "t1_p0", params: { model: "claude-haiku-4-5", max_tokens: 600, messages: [{ role: "user", content: "PROMPT A" }] } },
      { custom_id: "t1_p1", params: { model: "claude-haiku-4-5", max_tokens: 300, messages: [{ role: "user", content: "PROMPT B" }] } },
    ]);
    expect(options.maxRetries).toBe(0);
  });

  it("a provider error propagates untouched", async () => {
    sdk.create.mockRejectedValue(Object.assign(new Error("model does not support batches"), { status: 400 }));
    await expect(service().createBatch([{ customId: "t1_p0", prompt: "x", maxTokens: 300, inputEstimateTokens: 1 }])).rejects.toMatchObject({ status: 400 });
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
      requestCounts: { total: 4, succeeded: 3, errored: 1, expired: 0, canceled: 0 },
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
        usage: { inputTokens: 140, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 10 },
      },
      { customId: "t1_p1", outcome: "succeeded", text: "{", truncated: true, usage: { inputTokens: 5, outputTokens: 600 } },
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
