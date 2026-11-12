/**
 * AIService.translatePackage and the per-call request options
 * (PLAN_BULK_TRANSLATE_BATCHING 3.1 / 3.2): prompt order (stable part first,
 * glossary in the variable part), the sent max_tokens / timeout / no SDK retries,
 * the queue estimate from the PLAN, stop-reason detection on the package path
 * only, and byte-identical behaviour for every call without options.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { AIService } from "../../src/services/ai.service";
import { recordAiUsage } from "../../app/services/ai/usage-meter.server";

vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create: vi.fn() }; } }));
vi.mock("openai", () => ({ default: class { chat = { completions: { create: vi.fn() } }; } }));

const enqueueCalls: unknown[][] = [];
vi.mock("../../src/services/ai-queue.service", () => ({
  MAX_RATE_LIMIT_RETRIES: 3,
  rateLimitBucket: (source: string, provider: string) => `${source}:${provider}`,
  AIQueueService: {
    getInstance: vi.fn().mockReturnValue({
      getBucketTokenLimit: () => 40_000,
      enqueue: vi.fn(async (...args: unknown[]) => {
        enqueueCalls.push(args);
        return (args[4] as (attempt: number) => unknown)(0);
      }),
    }),
  },
}));

vi.mock("../../app/db.server", () => ({
  db: {
    task: {
      update: vi.fn(),
      findUnique: vi.fn().mockResolvedValue({ type: "bulkEditorTranslate", prompt: null }),
    },
  },
}));
vi.mock("../../app/services/ai/usage-meter.server", () => ({
  recordAiUsage: vi.fn().mockResolvedValue({ period: "m:2026-11", costMicros: 0, billedMicros: 0, ledgerWritten: true, taskWritten: null }),
}));

const SHOP = "demo.myshopify.com";

function claude(reply: (params: any, options: any) => unknown) {
  const calls: { params: any; options: any }[] = [];
  const svc = new AIService("claude", { claudeApiKey: "k", selectedModel: "claude-sonnet-4-5" } as never, SHOP, "task-1");
  (svc as any).anthropic = {
    messages: {
      create: async (params: any, options: any) => {
        calls.push({ params, options });
        return reply(params, options);
      },
    },
  };
  (svc as any).getGlossaryDirective = async () => "GLOSSARY: Sneaker = Sneaker";
  return { svc, calls };
}

const message = (text: string, stop_reason = "end_turn") => ({
  content: [{ type: "text", text }],
  stop_reason,
  usage: { input_tokens: 100, output_tokens: 50 },
});

const REQUEST = {
  kind: "short" as const,
  fromLang: "de",
  locales: ["fr", "es"],
  items: [
    { id: "k1", text: "Schal" },
    { id: "k2", text: "Mütze" },
  ],
  contentType: "product",
  instructions: "Use formal tone.",
  plannedOutputTokens: 4000,
  timeoutMs: 150_000,
};

beforeEach(() => {
  enqueueCalls.length = 0;
});

describe("translatePackage", () => {
  it("puts the stable part (rules + instructions) BEFORE everything that varies; the glossary is in the variable part", async () => {
    const { svc, calls } = claude(() => message('{"k1":{"fr":"Écharpe","es":"Bufanda"},"k2":{"fr":"Bonnet","es":"Gorro"}}'));
    const result = await svc.translatePackage(REQUEST);
    expect(result.invalid).toBeUndefined();
    expect(result.parsed).toEqual({ k1: { fr: "Écharpe", es: "Bufanda" }, k2: { fr: "Bonnet", es: "Gorro" } });
    const prompt: string = calls[0].params.messages[0].content;
    expect(prompt.indexOf("Requirements:")).toBeLessThan(prompt.indexOf("Use formal tone."));
    expect(prompt.indexOf("Use formal tone.")).toBeLessThan(prompt.indexOf("Target languages:"));
    expect(prompt.indexOf("Target languages:")).toBeLessThan(prompt.indexOf("GLOSSARY"));
    expect(prompt.indexOf("GLOSSARY")).toBeLessThan(prompt.indexOf('"items"'));
    // The prefix (everything before the first varying line) does not mention languages or items.
    const prefix = prompt.slice(0, prompt.indexOf("Target languages:"));
    expect(prefix).not.toContain("Schal");
    expect(prefix).not.toContain("French");
  });

  it("sends its own max_tokens, a per-request timeout and NO SDK retries; the queue estimate comes from the plan", async () => {
    const { svc, calls } = claude(() => message('{"k1":{"fr":"a","es":"b"},"k2":{"fr":"c","es":"d"}}'));
    await svc.translatePackage(REQUEST);
    expect(calls[0].params.max_tokens).toBe(6000); // 4000 x 1.5, model ceiling 32 000
    expect(calls[0].options).toEqual({ timeout: 150_000, maxRetries: 0 });
    const [, , , estimate, , source, , options] = enqueueCalls[0];
    expect(source).toBe("byo");
    expect(options).toMatchObject({ packageCall: true });
    const promptLength = (calls[0].params.messages[0].content as string).length;
    expect(estimate).toBe(Math.ceil(promptLength / 4) + Math.ceil(4000 * 1.1));
  });

  it("an answer cut off at max_tokens is invalid (truncated), whatever its beginning parses to", async () => {
    const { svc } = claude(() => message('{"k1":{"fr":"Écharpe","es":"Bufanda"}', "max_tokens"));
    const result = await svc.translatePackage(REQUEST);
    expect(result).toEqual({ parsed: null, invalid: "truncated" });
  });

  it("an unparseable answer is invalid (unparseable), not a throw", async () => {
    const { svc } = claude(() => message("Sorry, I cannot do that."));
    expect((await svc.translatePackage(REQUEST)).invalid).toBe("unparseable");
  });

  it("a provider error propagates untouched (the caller decides what stands down)", async () => {
    const { svc } = claude(() => {
      throw new Error("provider exploded");
    });
    await expect(svc.translatePackage(REQUEST)).rejects.toThrow("provider exploded");
  });

  it("the sent max_tokens never exceeds what the serving model can emit", async () => {
    const svc = new AIService("openai", { openaiApiKey: "k", selectedModel: "gpt-4-turbo" } as never, SHOP, "task-1");
    const seen: any[] = [];
    (svc as any).openai = {
      chat: {
        completions: {
          create: async (params: any) => {
            seen.push(params);
            return { choices: [{ message: { content: '{"k1":{"fr":"a","es":"b"}}' }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
          },
        },
      },
    };
    (svc as any).getGlossaryDirective = async () => "";
    await svc.translatePackage({ ...REQUEST, items: [REQUEST.items[0]], plannedOutputTokens: 4500 });
    expect(seen[0].max_tokens).toBe(4096); // gpt-4-turbo
  });

  it("OpenAI finish_reason length is reported as truncated even when the content is empty", async () => {
    const svc = new AIService("openai", { openaiApiKey: "k", selectedModel: "gpt-4o" } as never, SHOP, "task-1");
    (svc as any).openai = {
      chat: { completions: { create: async () => ({ choices: [{ message: { content: "" }, finish_reason: "length" }], usage: {} }) } },
    };
    (svc as any).getGlossaryDirective = async () => "";
    // The empty content makes the provider branch throw; the stop flag is set first.
    await expect(svc.translatePackage(REQUEST)).rejects.toThrow(/finish_reason: length/);
  });
});

describe("calls WITHOUT request options are unchanged", () => {
  it("send the fixed 8192, no SDK options, the flat queue estimate and no package flags", async () => {
    const { svc, calls } = claude(() => message("hello"));
    await svc.replayRequest("p");
    expect(calls[0].params.max_tokens).toBe(8192);
    expect(calls[0].options).toBeUndefined();

    enqueueCalls.length = 0;
    // askAI through the queue (shop + task present).
    await (svc as any).askAI("a prompt");
    const [, , , estimate, , , , options] = enqueueCalls[0];
    expect(estimate).toBe(Math.ceil("a prompt".length / 4) + 8192);
    expect(options).toBeUndefined();
  });
});

describe("packageLimits", () => {
  it("reports the model ceiling and the bucket's token allowance for planning", () => {
    const { svc } = claude(() => message("x"));
    expect(svc.packageLimits()).toMatchObject({ provider: "claude", maxOutputTokens: 32_000, bucketTpm: 40_000 });
  });
});

describe("prompt caching (phase 1d)", () => {
  // 4 chars per token estimate: 17 000 chars of instructions = a 4250+ token prefix.
  const LONG = "Always keep the brand voice playful and precise. ".repeat(350);
  const cacheable = { ...REQUEST, instructions: LONG, cacheable: true };
  const ANSWER = '{"k1":{"fr":"a","es":"b"},"k2":{"fr":"c","es":"d"}}';

  it("Anthropic: the stable prefix becomes a cache_control system block; glossary and items stay in the user turn", async () => {
    const { svc, calls } = claude(() => message(ANSWER));
    await svc.translatePackage(cacheable);
    const params = calls[0].params;
    expect(params.system).toHaveLength(1);
    expect(params.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(params.system[0].text).toContain("Requirements:");
    expect(params.system[0].text).toContain("playful and precise");
    expect(params.system[0].text).not.toContain("GLOSSARY");
    expect(params.system[0].text).not.toContain("Schal");
    expect(params.system[0].text).not.toContain("French");
    const user = params.messages[0].content as string;
    expect(user).toContain("Target languages:");
    expect(user).toContain("GLOSSARY");
    expect(user).toContain("Schal");
    // Nothing is lost by the split: the same text as the unsplit prompt, minus the joining newline.
    const plain = claude(() => message(ANSWER));
    await plain.svc.translatePackage({ ...cacheable, cacheable: false });
    expect(`${params.system[0].text}\n${user}`).toBe(plain.calls[0].params.messages[0].content);
  });

  it("no marker when the group has too few packages (caller says not cacheable)", async () => {
    const { svc, calls } = claude(() => message(ANSWER));
    await svc.translatePackage({ ...cacheable, cacheable: false });
    expect(calls[0].params.system).toBeUndefined();
    expect(JSON.stringify(calls[0].params)).not.toContain("cache_control");
  });

  it("no marker when the prefix is below the minimum", async () => {
    const { svc, calls } = claude(() => message(ANSWER));
    await svc.translatePackage({ ...REQUEST, cacheable: true });
    expect(calls[0].params.system).toBeUndefined();
    expect(JSON.stringify(calls[0].params)).not.toContain("cache_control");
  });

  it("calls that are not package calls never carry a marker or a system block", async () => {
    const { svc, calls } = claude(() => message("hello"));
    await svc.replayRequest(LONG);
    await (svc as any).askAI(LONG);
    for (const call of calls) {
      expect(call.params.system).toBeUndefined();
      expect(JSON.stringify(call.params)).not.toContain("cache_control");
    }
  });

  it("OpenAI: no marker, the stable prefix stays first, and cached_tokens is metered as a cache read", async () => {
    const svc = new AIService("openai", { openaiApiKey: "k", selectedModel: "gpt-4o" } as never, SHOP, "task-1");
    const seen: any[] = [];
    (svc as any).openai = {
      chat: {
        completions: {
          create: async (params: any) => {
            seen.push(params);
            return {
              choices: [{ message: { content: ANSWER }, finish_reason: "stop" }],
              usage: { prompt_tokens: 5000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 4000 } },
            };
          },
        },
      },
    };
    (svc as any).getGlossaryDirective = async () => "GLOSSARY: x";
    vi.mocked(recordAiUsage).mockClear();
    await svc.translatePackage(cacheable);
    expect(seen[0].messages).toHaveLength(1);
    expect(JSON.stringify(seen[0])).not.toContain("cache_control");
    const prompt: string = seen[0].messages[0].content;
    expect(prompt.indexOf("playful and precise")).toBeLessThan(prompt.indexOf("Target languages:"));
    expect(vi.mocked(recordAiUsage).mock.calls[0][0]).toMatchObject({ inputTokens: 5000, cacheReadTokens: 4000 });
  });

  it("Anthropic cache read/write tokens are metered separately and the input stays the sum of all three", async () => {
    const { svc } = claude(() => ({
      content: [{ type: "text", text: ANSWER }],
      stop_reason: "end_turn",
      usage: { input_tokens: 200, output_tokens: 50, cache_read_input_tokens: 4000, cache_creation_input_tokens: 300 },
    }));
    vi.mocked(recordAiUsage).mockClear();
    await svc.translatePackage(cacheable);
    expect(vi.mocked(recordAiUsage).mock.calls[0][0]).toMatchObject({
      inputTokens: 4500,
      cacheReadTokens: 4000,
      cacheWriteTokens: 300,
    });
  });
});
