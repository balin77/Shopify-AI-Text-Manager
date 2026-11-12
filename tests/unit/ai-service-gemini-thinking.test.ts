/**
 * Gemini 2.5 thinking allowance on the PACKAGE path only
 * (PLAN_BULK_TRANSLATE_BATCHING 19 review M2). The installed SDK has no
 * `thinkingConfig`, so the package ceiling carries an allowance instead.
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
vi.mock("../../app/db.server", () => ({
  db: { task: { update: vi.fn(), findUnique: vi.fn().mockResolvedValue({ type: "bulkEditorTranslate", prompt: null }) } },
}));
vi.mock("../../app/services/ai/usage-meter.server", () => ({
  recordAiUsage: vi.fn().mockResolvedValue({ period: "m:2026-11", costMicros: 0, billedMicros: 0, ledgerWritten: true, taskWritten: null }),
}));

const SHOP = "demo.myshopify.com";
const ANSWER = '{"k1":{"fr":"a","es":"b"},"k2":{"fr":"c","es":"d"}}';
const REQUEST = {
  kind: "short" as const,
  fromLang: "de",
  locales: ["fr", "es"],
  items: [
    { id: "k1", text: "Schal" },
    { id: "k2", text: "Muetze" },
  ],
  contentType: "product",
  instructions: "Use formal tone.",
  plannedOutputTokens: 4000,
  timeoutMs: 150_000,
};

function gemini(model: string) {
  const svc = new AIService("gemini", { geminiApiKey: "k", selectedModel: model } as never, SHOP, "task-1");
  const sent: any[][] = [];
  (svc as any).gemini = {
    generateContent: async (...args: any[]) => {
      sent.push(args);
      return { response: Promise.resolve({ candidates: [{ finishReason: "STOP" }], text: () => ANSWER }) };
    },
  };
  (svc as any).getGlossaryDirective = async () => "";
  return { svc, sent };
}

describe("Gemini 2.5 thinking allowance (package calls only)", () => {
  it("a 2.5 model's package ceiling carries the thinking allowance on top of the planned max_tokens", async () => {
    const { svc, sent } = gemini("gemini-2.5-flash");
    await svc.translatePackage(REQUEST);
    expect(sent[0][0].generationConfig.maxOutputTokens).toBe(6000 + 4096);
  });

  it("the allowance never passes the model's own ceiling", async () => {
    const { svc, sent } = gemini("gemini-2.5-flash");
    await svc.translatePackage({ ...REQUEST, plannedOutputTokens: 21_000 });
    expect(sent[0][0].generationConfig.maxOutputTokens).toBe(32_000);
  });

  it("a non-2.5 Gemini model is sent exactly its planned ceiling", async () => {
    const { svc, sent } = gemini("gemini-2.0-flash");
    await svc.translatePackage(REQUEST);
    expect(sent[0][0].generationConfig.maxOutputTokens).toBe(6000);
  });

  it("a call without request options is still the bare prompt", async () => {
    const { svc, sent } = gemini("gemini-2.5-flash");
    await (svc as any).askAI("plain");
    expect(sent[0][0]).toBe("plain");
  });
});
