/**
 * The per-row estimate must LEAN HIGH against what the runner really sends
 * (PLAN_BULK_TRANSLATE_BATCHING 19 review H1): the whole long source again for
 * every locale chunk, the merchant's instructions on every request, and the
 * glossary directive on every request. The "sent" side is the real AIService
 * with only the provider call stubbed, so the prompts are the real prompts.
 */
import { describe, it, expect, vi } from "vitest";
import { AIService } from "../../src/services/ai.service";
import { MAX_TERMS_IN_PROMPT } from "../../src/services/glossary.service";
import {
  GLOSSARY_MAX_TERMS,
  estimateTranslateRun,
  glossaryAllowanceChars,
  type EstimateClassifiers,
  type EstimateJob,
} from "~/services/bulk-editor/translate-estimate.shared";

vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create: vi.fn() }; } }));
vi.mock("openai", () => ({ default: class { chat = { completions: { create: vi.fn() } }; } }));

const longColumn = { id: "field.body", kind: "field", label: "body", group: "content", editable: true, translatable: true, inputType: "text", minWidth: 100 } as any;
const classifiers = (instr: string): EstimateClassifiers => ({
  isGroupedColumn: () => false,
  isValueColumn: () => false,
  isShortColumn: () => false,
  isListValuesColumn: () => false,
  isHandleColumn: () => false,
  instructionsFor: () => instr,
});
const limits = { provider: "claude" as const, model: "claude-sonnet-4-5", maxOutputTokens: 32_000, bucketTpm: null };

function service(glossary: string) {
  const svc = new AIService("claude", { claudeApiKey: "k", selectedModel: "claude-sonnet-4-5" } as never, "demo.myshopify.com");
  const prompts: string[] = [];
  (svc as any).askAI = async (prompt: string) => {
    prompts.push(prompt);
    throw new Error("stubbed provider");
  };
  (svc as any).getGlossaryDirective = async () => glossary;
  return { svc, prompts };
}

describe("packaged estimate: cache write once per qualifying group, Gemini thinking", () => {
  const LONG = "Always keep the brand voice playful and precise. ".repeat(350);
  const titleColumn = { id: "field.title", kind: "field", label: "title", group: "content", editable: true, translatable: true, inputType: "text", minWidth: 100 } as any;
  const shortClassifiers = (instr: string | undefined): EstimateClassifiers => ({
    isGroupedColumn: () => false,
    isValueColumn: () => false,
    isShortColumn: () => true,
    isListValuesColumn: () => false,
    isHandleColumn: () => false,
    instructionsFor: () => instr,
  });
  const many = (n: number): EstimateJob[] =>
    Array.from({ length: n }, (_, i) => ({
      rowId: `r${i}`,
      cells: [{ column: titleColumn, fieldKey: "title", source: `Wollschal Modell ${i} mit langem Namen`, locales: ["fr", "es"] }],
    }));
  const base = { units: 240, packages: true, skippedOverCap: 0, scanTruncated: false };
  const tiny = { provider: "claude" as const, model: "claude-sonnet-4-5", maxOutputTokens: 1024, bucketTpm: null };

  it("a qualifying Claude group is priced with ONE cache write at 1.25x (reads at 1.0)", async () => {
    const { priceCall } = await import("~/config/ai-pricing");
    const e = estimateTranslateRun({ ...base, jobs: many(120), classifiers: shortClassifiers(LONG), limits: tiny });
    const noCache = priceCall("claude", "claude-sonnet-4-5", e.inputTokens, e.outputTokens).costMicros;
    expect(e.costMicros).toBeGreaterThan(noCache);
    // The surcharge is bounded: one write of ~the prefix, not every package.
    const prefixTokens = 250 + Math.ceil(LONG.length / 3);
    const oneWrite = priceCall("claude", "claude-sonnet-4-5", e.inputTokens, e.outputTokens, { cacheWriteTokens: prefixTokens }).costMicros;
    expect(e.costMicros).toBeLessThanOrEqual(oneWrite);
  });

  it("no cache credit or surcharge when the prefix is short, the group small or the provider not Claude", async () => {
    const { priceCall } = await import("~/config/ai-pricing");
    const short = estimateTranslateRun({ ...base, jobs: many(120), classifiers: shortClassifiers("Short."), limits: tiny });
    expect(short.costMicros).toBe(priceCall("claude", "claude-sonnet-4-5", short.inputTokens, short.outputTokens).costMicros);
    const small = estimateTranslateRun({ ...base, jobs: many(2), classifiers: shortClassifiers(LONG), limits: tiny });
    expect(small.costMicros).toBe(priceCall("claude", "claude-sonnet-4-5", small.inputTokens, small.outputTokens).costMicros);
    const openai = { provider: "openai" as const, model: "gpt-4o", maxOutputTokens: 1024, bucketTpm: null };
    const o = estimateTranslateRun({ ...base, jobs: many(120), classifiers: shortClassifiers(LONG), limits: openai });
    expect(o.costMicros).toBe(priceCall("openai", "gpt-4o", o.inputTokens, o.outputTokens).costMicros);
  });

  it("Gemini 2.5 package requests carry the thinking allowance in the output; other Gemini models and the per-row path do not", () => {
    const g25 = { provider: "gemini" as const, model: "gemini-2.5-flash", maxOutputTokens: 32_000, bucketTpm: null };
    const g20 = { provider: "gemini" as const, model: "gemini-2.0-flash", maxOutputTokens: 8192, bucketTpm: null };
    const a = estimateTranslateRun({ ...base, jobs: many(10), classifiers: shortClassifiers(undefined), limits: g25 });
    const b = estimateTranslateRun({ ...base, jobs: many(10), classifiers: shortClassifiers(undefined), limits: g20 });
    expect(a.outputTokens).toBeGreaterThan(b.outputTokens);
    const perRow25 = estimateTranslateRun({ ...base, packages: false, jobs: many(10), classifiers: shortClassifiers(undefined), limits: g25 });
    const perRow20 = estimateTranslateRun({ ...base, packages: false, jobs: many(10), classifiers: shortClassifiers(undefined), limits: g20 });
    expect(perRow25.outputTokens).toBe(perRow20.outputTokens);
  });
});

describe("estimate >= what the per-row runner sends", () => {
  const LOCALES = ["fr", "es", "it", "nl", "pt", "sv", "da", "fi"];
  const BODY = "<p>" + "Handgewebter Wollschal in vielen Farben. ".repeat(100) + "</p>";
  const INSTR = "Keep the brand voice playful and precise. ".repeat(40);
  const GLOSSARY = "GLOSSARY: Schal = scarf; ".repeat(60);

  it("a multi-locale long field with instructions and glossary: more requests and tokens than were sent", async () => {
    const { svc, prompts } = service(GLOSSARY);
    await svc
      .translateFieldsToLocalesChunked({ body: BODY }, "de", LOCALES, { preserveHtml: true, customInstructions: INSTR })
      .catch(() => undefined);
    expect(prompts.length).toBeGreaterThan(1); // the field really is chunked per locale group
    const sentTokens = Math.ceil(prompts.reduce((n, p) => n + p.length, 0) / 3);

    const jobs: EstimateJob[] = [{ rowId: "r1", cells: [{ column: longColumn, fieldKey: "body", source: BODY, locales: LOCALES }] }];
    const e = estimateTranslateRun({
      jobs, units: LOCALES.length, packages: false, classifiers: classifiers(INSTR), limits,
      skippedOverCap: 0, scanTruncated: false, glossaryChars: GLOSSARY.length,
    });
    expect(e.requests).toBeGreaterThanOrEqual(prompts.length);
    expect(e.inputTokens).toBeGreaterThanOrEqual(sentTokens);
  });

  it("with the glossary unknown a worst-case allowance is added, so the figure is never lower than with the real one", () => {
    const jobs: EstimateJob[] = [{ rowId: "r1", cells: [{ column: longColumn, fieldKey: "body", source: BODY, locales: LOCALES }] }];
    const base = { jobs, units: 8, packages: false, classifiers: classifiers(INSTR), limits, skippedOverCap: 0, scanTruncated: false };
    const real = estimateTranslateRun({ ...base, glossaryChars: GLOSSARY.length });
    const unknown = estimateTranslateRun(base);
    const none = estimateTranslateRun({ ...base, glossaryChars: 0 });
    expect(unknown.inputTokens).toBeGreaterThan(real.inputTokens);
    expect(real.inputTokens).toBeGreaterThan(none.inputTokens);
    expect(glossaryAllowanceChars(8)).toBeGreaterThan(GLOSSARY.length);
  });

  it("instructions raise the long-field estimate on every chunk", () => {
    const jobs: EstimateJob[] = [{ rowId: "r1", cells: [{ column: longColumn, fieldKey: "body", source: BODY, locales: LOCALES }] }];
    const args = { jobs, units: 8, packages: false, limits, skippedOverCap: 0, scanTruncated: false, glossaryChars: 0 };
    const without = estimateTranslateRun({ ...args, classifiers: classifiers("") });
    const withInstr = estimateTranslateRun({ ...args, classifiers: classifiers(INSTR) });
    expect(withInstr.inputTokens).toBeGreaterThanOrEqual(without.inputTokens + Math.ceil(INSTR.length / 3) * (without.requests - 1));
  });

  it("the glossary term cap matches the prompt's", () => {
    expect(GLOSSARY_MAX_TERMS).toBe(MAX_TERMS_IN_PROMPT);
  });
});
