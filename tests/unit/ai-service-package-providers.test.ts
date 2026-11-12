/**
 * Package-path details of the provider branches (PLAN_BULK_TRANSLATE_BATCHING
 * 3.2, Phase 1b review): Gemini and HuggingFace get their own output ceiling and
 * timeout, HuggingFace does not retry, a reused request object does not carry a
 * stale truncation flag into the next attempt, and the task log of concurrent
 * package calls loses nothing. Calls WITHOUT options stay byte-identical.
 */
import { describe, it, expect, vi } from "vitest";
import { AIService } from "../../src/services/ai.service";

vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create: vi.fn() }; } }));
vi.mock("openai", () => ({ default: class { chat = { completions: { create: vi.fn() } }; } }));
vi.mock("../../src/services/ai-queue.service", () => ({
  MAX_RATE_LIMIT_RETRIES: 3,
  rateLimitBucket: (source: string, provider: string) => `${source}:${provider}`,
  AIQueueService: {
    getInstance: vi.fn().mockReturnValue({
      getBucketTokenLimit: () => 40_000,
      enqueue: vi.fn(async (...args: unknown[]) => (args[4] as (attempt: number) => unknown)(0)),
    }),
  },
}));

// A tiny in-memory task row: update replaces the prompt column after an await,
// so an unserialised read-modify-write loses entries.
const row = { prompt: null as string | null };
vi.mock("../../app/db.server", () => ({
  db: {
    task: {
      findUnique: vi.fn(async () => {
        const snapshot = row.prompt;
        await new Promise((r) => setTimeout(r, 5));
        return { prompt: snapshot };
      }),
      update: vi.fn(async ({ data }: { data: { prompt?: string } }) => {
        await new Promise((r) => setTimeout(r, 5));
        if (data.prompt !== undefined) row.prompt = data.prompt;
        return {};
      }),
    },
  },
}));
vi.mock("../../app/services/ai/usage-meter.server", () => ({
  recordAiUsage: vi.fn().mockResolvedValue({ period: "m:2026-11", costMicros: 0, billedMicros: 0, ledgerWritten: true, taskWritten: null }),
}));

const SHOP = "demo.myshopify.com";
const REQUEST = {
  kind: "short" as const,
  fromLang: "de",
  locales: ["fr"],
  items: [{ id: "k1", text: "Schal" }],
  contentType: "product",
  plannedOutputTokens: 1000,
  timeoutMs: 90_000,
};
const ANSWER = '{"k1":{"fr":"Echarpe"}}';

describe("Gemini package call", () => {
  const geminiResponse = (finishReason = "STOP") => ({
    response: Promise.resolve({
      candidates: [{ finishReason }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      text: () => ANSWER,
    }),
  });

  it("sends generationConfig.maxOutputTokens and a request timeout", async () => {
    const svc = new AIService("gemini", { geminiApiKey: "k", selectedModel: "gemini-2.5-flash" } as never, SHOP, "task-g");
    const generateContent = vi.fn(async () => geminiResponse());
    (svc as any).gemini = { generateContent };
    (svc as any).getGlossaryDirective = async () => "";
    await svc.translatePackage(REQUEST);
    const [request, options] = generateContent.mock.calls[0] as unknown as [any, any];
    expect(request.generationConfig.maxOutputTokens).toBe(1500);
    expect(typeof request.contents[0].parts[0].text).toBe("string");
    expect(options).toEqual({ timeout: 90_000 });
  });

  it("a MAX_TOKENS finish is reported as truncated", async () => {
    const svc = new AIService("gemini", { geminiApiKey: "k", selectedModel: "gemini-2.5-flash" } as never, SHOP, "task-g");
    (svc as any).gemini = { generateContent: async () => geminiResponse("MAX_TOKENS") };
    (svc as any).getGlossaryDirective = async () => "";
    expect(await svc.translatePackage(REQUEST)).toEqual({ parsed: null, invalid: "truncated" });
  });

  it("without request options the bare prompt string is sent, exactly as before", async () => {
    const svc = new AIService("gemini", { geminiApiKey: "k", selectedModel: "gemini-2.5-flash" } as never, SHOP, "task-g");
    const generateContent = vi.fn(async () => geminiResponse());
    (svc as any).gemini = { generateContent };
    await svc.replayRequest("plain prompt");
    expect(generateContent.mock.calls[0]).toEqual(["plain prompt"]);
  });
});

describe("HuggingFace package call", () => {
  const completion = { choices: [{ message: { content: ANSWER }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } };

  it("does not retry on error and carries a timeout signal", async () => {
    const svc = new AIService("huggingface", { huggingfaceApiKey: "k", selectedModel: "m/x" } as never, SHOP, "task-h");
    const chatCompletion = vi.fn(async () => completion);
    (svc as any).huggingface = { chatCompletion };
    (svc as any).getGlossaryDirective = async () => "";
    await svc.translatePackage(REQUEST);
    const [, options] = chatCompletion.mock.calls[0] as unknown as [any, any];
    expect(options.retry_on_error).toBe(false);
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it("without request options no options are passed", async () => {
    const svc = new AIService("huggingface", { huggingfaceApiKey: "k", selectedModel: "m/x" } as never, SHOP, "task-h");
    const chatCompletion = vi.fn(async () => completion);
    (svc as any).huggingface = { chatCompletion };
    await svc.replayRequest("plain");
    expect((chatCompletion.mock.calls[0] as unknown[])[1]).toBeUndefined();
  });
});

describe("a reused request object", () => {
  it("does not carry a truncation flag of an earlier attempt into the next one", async () => {
    const svc = new AIService("claude", { claudeApiKey: "k", selectedModel: "claude-sonnet-4-5" } as never, SHOP, "task-c");
    let first = true;
    (svc as any).anthropic = {
      messages: {
        create: async () => {
          const cut = first;
          first = false;
          return { content: [{ type: "text", text: ANSWER }], stop_reason: cut ? "max_tokens" : "end_turn", usage: { input_tokens: 1, output_tokens: 1 } };
        },
      },
    };
    const stop = { truncated: false };
    const options = { maxOutputTokens: 1000, plannedOutputTokens: 500, timeoutMs: 1000, stop };
    await (svc as any).executeAIRequest("p", undefined, 0, { provider: "claude" }, options);
    expect(stop.truncated).toBe(true);
    await (svc as any).executeAIRequest("p", undefined, 1, { provider: "claude" }, options);
    expect(stop.truncated).toBe(false);
  });
});

describe("the task log under concurrent package calls", () => {
  it("keeps every entry and puts each response on its own entry", async () => {
    row.prompt = null;
    const svc = new AIService("claude", { claudeApiKey: "k", selectedModel: "claude-sonnet-4-5" } as never, SHOP, "task-log");
    (svc as any).anthropic = {
      messages: {
        create: async (params: any) => {
          const text = params.messages[0].content as string;
          const id = /Schal(\d)/.exec(text)![1];
          return { content: [{ type: "text", text: `{"k1":{"fr":"R${id}"}}` }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } };
        },
      },
    };
    (svc as any).getGlossaryDirective = async () => "";
    await Promise.all(
      [1, 2, 3, 4].map((n) => svc.translatePackage({ ...REQUEST, items: [{ id: "k1", text: `Schal${n}` }] })),
    );
    const history = JSON.parse(row.prompt!) as { prompt: string; response?: string }[];
    expect(history).toHaveLength(4);
    for (const entry of history) {
      const n = /Schal(\d)/.exec(entry.prompt)![1];
      expect(entry.response).toContain(`R${n}`);
    }
  });
});
