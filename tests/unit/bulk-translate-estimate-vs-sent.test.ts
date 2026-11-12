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
