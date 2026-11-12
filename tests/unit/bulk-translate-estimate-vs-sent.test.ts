/**
 * The per-row estimate must LEAN HIGH against what the runner really sends
 * (PLAN_BULK_TRANSLATE_BATCHING 19 review H1): the whole long source again for
 * every locale chunk, the merchant's instructions on every request, and the
 * glossary directive on every request. The "sent" side is the real AIService
 * with only the provider call stubbed, so the prompts are the real prompts.
 */
import { describe, it, expect, vi } from "vitest";
import { AIService } from "../../src/services/ai.service";
import { buildPackageItems, packageBudgetFor, planPackages, type PackageEntry } from "~/services/bulk-editor/translate-packages.shared";
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

  it("Gemini 2.5 package requests carry the thinking allowance in the output; other Gemini models do not; the per-row path carries it as well", () => {
    const g25 = { provider: "gemini" as const, model: "gemini-2.5-flash", maxOutputTokens: 32_000, bucketTpm: null };
    const g20 = { provider: "gemini" as const, model: "gemini-2.0-flash", maxOutputTokens: 8192, bucketTpm: null };
    const a = estimateTranslateRun({ ...base, jobs: many(10), classifiers: shortClassifiers(undefined), limits: g25 });
    const b = estimateTranslateRun({ ...base, jobs: many(10), classifiers: shortClassifiers(undefined), limits: g20 });
    expect(a.outputTokens).toBeGreaterThan(b.outputTokens);
    const perRow25 = estimateTranslateRun({ ...base, packages: false, jobs: many(10), classifiers: shortClassifiers(undefined), limits: g25 });
    const perRow20 = estimateTranslateRun({ ...base, packages: false, jobs: many(10), classifiers: shortClassifiers(undefined), limits: g20 });
    // Per-row requests carry the thinking allowance too (it is billed as output).
    expect(perRow25.outputTokens).toBeGreaterThan(perRow20.outputTokens);
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

describe("estimate >= what the other runner paths send (real prompt builders)", () => {
  const LOCALES = ["fr", "es", "it", "nl", "pt-BR", "sv", "da", "fi", "pl", "cs", "zh-CN", "ja"];
  const col = (id: string) => ({ id, kind: "field", label: id, group: "content", editable: true, translatable: true, inputType: "text", minWidth: 100 }) as any;
  const sentTokens = (prompts: string[]) => Math.ceil(prompts.reduce((n, p) => n + p.length, 0) / 3);
  const cls = (over: Partial<EstimateClassifiers>): EstimateClassifiers => ({ ...classifiers(""), ...over });
  const base = { skippedOverCap: 0, scanTruncated: false, glossaryChars: 0, limits };

  it("short batch (title + seoTitle + handle + productType) into 12 locales", async () => {
    const { svc, prompts } = service("");
    const fields = { title: "Handgewebter Wollschal", seoTitle: "Wollschal handgewebt kaufen", handle: "wollschal-handgewebt", productType: "Schal" };
    await svc.translateShortFieldsBatch(fields, "de", LOCALES, "product").catch(() => undefined);
    expect(prompts).toHaveLength(1);
    const jobs: EstimateJob[] = [{
      rowId: "r1",
      cells: Object.entries(fields).map(([k, v]) => ({ column: col(`field.${k}`), fieldKey: k, source: v, locales: LOCALES })),
    }];
    const e = estimateTranslateRun({ ...base, jobs, units: 48, packages: false, classifiers: cls({ isShortColumn: () => true }) });
    expect(e.requests).toBeGreaterThanOrEqual(prompts.length);
    expect(e.inputTokens).toBeGreaterThanOrEqual(sentTokens(prompts));
  });

  it("a single short title into one locale", async () => {
    const { svc, prompts } = service("");
    await svc.translateShortFieldsBatch({ title: "Schal" }, "de", ["fr"], "product").catch(() => undefined);
    const jobs: EstimateJob[] = [{ rowId: "r1", cells: [{ column: col("field.title"), fieldKey: "title", source: "Schal", locales: ["fr"] }] }];
    const e = estimateTranslateRun({ ...base, jobs, units: 1, packages: false, classifiers: cls({ isShortColumn: () => true }) });
    expect(e.inputTokens).toBeGreaterThanOrEqual(sentTokens(prompts));
  });

  it("value batches: many locales and the single-locale batch", async () => {
    const values = Array.from({ length: 45 }, (_, i) => `Wert Nummer ${i} aus Wolle`);
    const jobs: EstimateJob[] = [{
      rowId: "r1",
      cells: [{ column: col("metafield.x"), fieldKey: "value", source: values.join(" | "), locales: LOCALES }],
    }];
    const { svc, prompts } = service("");
    await svc.translateBatchValuesToLocales(values, "de", LOCALES, "product content").catch(() => undefined);
    expect(prompts.length).toBeGreaterThan(1);
    const e = estimateTranslateRun({
      ...base, jobs, units: LOCALES.length, packages: false,
      classifiers: cls({ isValueColumn: () => true, isListValuesColumn: () => true }),
    });
    // list columns split on the display separator; the figure must still lead high
    expect(e.requests).toBeGreaterThanOrEqual(prompts.length);
    const split = estimateTranslateRun({
      ...base, units: 1, packages: false,
      jobs: [{ rowId: "r1", cells: [{ column: col("metafield.x"), fieldKey: "value", source: "Wolle", locales: ["fr"] }] }],
      classifiers: cls({ isValueColumn: () => true }),
    });
    const one = service("");
    await one.svc.translateBatchValuesToLocales(["Wolle"], "de", ["fr"], "product content").catch(() => undefined);
    expect(split.inputTokens).toBeGreaterThanOrEqual(sentTokens(one.prompts));
  });

  it("productType-only and handle-only short cells", async () => {
    for (const key of ["productType", "handle"] as const) {
      const { svc, prompts } = service("");
      const src = key === "handle" ? "wollschal-handgewebt" : "Schal";
      await svc.translateShortFieldsBatch({ [key]: src }, "de", LOCALES, "product").catch(() => undefined);
      const jobs: EstimateJob[] = [{ rowId: "r1", cells: [{ column: col(`field.${key}`), fieldKey: key, source: src, locales: LOCALES }] }];
      const e = estimateTranslateRun({ ...base, jobs, units: LOCALES.length, packages: false, classifiers: cls({ isShortColumn: () => true, isHandleColumn: () => key === "handle" }) });
      expect(e.inputTokens).toBeGreaterThanOrEqual(sentTokens(prompts));
    }
  });

  it("the oversized per-locale fallback of a long field", async () => {
    const HUGE = "<p>" + "Handgewebter Wollschal in vielen Farben. ".repeat(2500) + "</p>";
    const { svc, prompts } = service("");
    await svc.translateFieldsToLocalesChunked({ body: HUGE }, "de", LOCALES.slice(0, 4), { preserveHtml: true }).catch(() => undefined);
    const jobs: EstimateJob[] = [{ rowId: "r1", cells: [{ column: longColumn, fieldKey: "body", source: HUGE, locales: LOCALES.slice(0, 4) }] }];
    const e = estimateTranslateRun({ ...base, jobs, units: 4, packages: false, classifiers: classifiers("") });
    expect(e.requests).toBeGreaterThanOrEqual(prompts.length);
    expect(e.inputTokens).toBeGreaterThanOrEqual(sentTokens(prompts));
  });

  it("the package path: every package prompt and every oversized item is covered", async () => {
    const titles = Array.from({ length: 60 }, (_, i) => `Wollschal Modell ${i} handgewebt`);
    const jobs: EstimateJob[] = titles.map((t, i) => ({
      rowId: `r${i}`,
      cells: [
        { column: col("field.title"), fieldKey: "title", source: t, locales: LOCALES },
        { column: col("field.handle"), fieldKey: "handle", source: `wollschal-${i}`, locales: LOCALES.slice(0, 5) },
      ],
    }));
    const c = cls({ isShortColumn: () => true, isHandleColumn: (x) => x.id === "field.handle" });
    const entries: PackageEntry[] = jobs.flatMap((j) =>
      j.cells.map((cell) => ({
        owner: `${j.rowId}|${cell.column.id}#0`,
        kind: cell.fieldKey === "handle" ? ("handle" as const) : ("short" as const),
        fieldKey: cell.fieldKey, source: cell.source, locales: cell.locales,
        instructions: undefined,
        ...(cell.fieldKey === "handle" ? { context: titles[Number(j.rowId.slice(1))].slice(0, 200) } : {}),
      })),
    );
    const plan = planPackages(buildPackageItems(entries), packageBudgetFor({ modelMaxOutput: limits.maxOutputTokens, bucketTpm: null }));
    const { svc, prompts } = service("");
    for (const pkg of plan.packages) {
      await svc.translatePackage({
        kind: pkg.kind, fromLang: "de", locales: pkg.locales, contentType: "product",
        items: pkg.items.map((it) => ({ id: it.key, text: it.source, ...(it.context ? { context: it.context } : {}) })),
        instructions: pkg.instructions, plannedOutputTokens: 1000, timeoutMs: 60_000,
      }).catch(() => undefined);
    }
    const e = estimateTranslateRun({ ...base, jobs, units: 60 * LOCALES.length, packages: true, classifiers: c });
    expect(prompts.length).toBe(plan.packages.length);
    expect(e.requests).toBeGreaterThanOrEqual(prompts.length);
    expect(e.inputTokens).toBeGreaterThanOrEqual(sentTokens(prompts));
  });
});
