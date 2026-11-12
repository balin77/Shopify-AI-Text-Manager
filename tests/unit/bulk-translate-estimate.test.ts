/**
 * Cost preview of "add missing translations" (PLAN_BULK_TRANSLATE_BATCHING 3.4,
 * phase 1c): the pure estimate and the handler's `estimateOnly` mode.
 *
 * The handler half pins the rails: no Task row, no AI request, no Shopify write,
 * and the answer carries the planner's numbers.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const applyBulkDiff = vi.fn();
vi.mock("~/services/bulk-editor/apply.server", () => ({ applyBulkDiff: (...a: unknown[]) => applyBulkDiff(...a) }));
vi.mock("~/utils/logger.server", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const titleColumn = {
  id: "field.title",
  kind: "field",
  label: "title",
  group: "content",
  editable: true,
  translatable: true,
  inputType: "text",
  minWidth: 100,
} as any;

vi.mock("~/utils/shop-locales-cache.server", () => ({
  getCachedShopLocales: async () => [
    { locale: "de", primary: true, name: "German" },
    { locale: "fr", primary: false, name: "French" },
    { locale: "es", primary: false, name: "Spanish" },
  ],
}));
vi.mock("~/services/bulk-editor/columns.server", () => ({
  buildServerColumnsByType: async () => ({ product: [titleColumn] }),
}));
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

import { handleBulkEditorTranslate } from "~/routes/api-ai-handlers/bulk-editor-translate.handler";
import {
  RETRY_ALLOWANCE,
  estimateTranslateRun,
  type EstimateClassifiers,
  type EstimateJob,
} from "~/services/bulk-editor/translate-estimate.shared";
import {
  buildPackageItems,
  packageBudgetFor,
  packageInputTokens,
  planPackages,
  type PackageEntry,
} from "~/services/bulk-editor/translate-packages.shared";
import { priceCall } from "~/config/ai-pricing";
import { initialTranslateSelection, serializeTranslateSelection } from "~/services/bulk-editor/translate-missing.shared";

const classifiers: EstimateClassifiers = {
  isGroupedColumn: () => false,
  isValueColumn: () => false,
  isShortColumn: (c) => c.id === "field.title",
  isListValuesColumn: () => false,
  isHandleColumn: () => false,
  instructionsFor: () => undefined,
};

const jobs = (n: number): EstimateJob[] =>
  Array.from({ length: n }, (_, i) => ({
    rowId: `gid://shopify/Product/${i}`,
    cells: [{ column: titleColumn, fieldKey: "title", source: `Wollschal Modell ${i}`, locales: ["fr", "es"] }],
  }));

const limits = { provider: "claude" as const, model: "claude-3-5-haiku-20241022", maxOutputTokens: 8192, bucketTpm: 40_000 };

describe("estimateTranslateRun", () => {
  it("per-row: one short request per row, leaning high (retry allowance)", () => {
    const e = estimateTranslateRun({
      jobs: jobs(10),
      units: 20,
      packages: false,
      classifiers,
      limits,
      skippedOverCap: 0,
      scanTruncated: false,
    });
    expect(e.packaged).toBe(false);
    expect(e.requests).toBe(Math.ceil(10 * RETRY_ALLOWANCE));
    expect(e.units).toBe(20);
    expect(e.inputTokens).toBeGreaterThan(0);
    expect(e.outputTokens).toBeGreaterThan(0);
  });

  it("packaged: the request count is the run's own planner's, plus the allowance", () => {
    const entries: PackageEntry[] = jobs(120).map((j, i) => ({
      owner: `${j.rowId}|field.title#0`,
      kind: "short",
      fieldKey: "title",
      source: j.cells[0].source,
      locales: ["fr", "es"],
    }));
    const budget = packageBudgetFor({ modelMaxOutput: limits.maxOutputTokens, bucketTpm: limits.bucketTpm });
    const plan = planPackages(buildPackageItems(entries), budget);
    expect(plan.packages.length).toBeGreaterThan(1);

    const e = estimateTranslateRun({
      jobs: jobs(120),
      units: 240,
      packages: true,
      classifiers,
      limits,
      skippedOverCap: 0,
      scanTruncated: false,
    });
    expect(e.packaged).toBe(true);
    expect(e.requests).toBe(Math.ceil((plan.packages.length + plan.oversized.length * 2) * RETRY_ALLOWANCE));
    // Never BELOW the planner's own (quarter-based) input figure.
    const plannerInput = plan.packages.reduce((n, p) => n + packageInputTokens(p), 0);
    expect(e.inputTokens).toBeGreaterThanOrEqual(plannerInput);
  });

  it("prices through priceCall; an unknown model is flagged as the provider's ceiling", () => {
    const known = estimateTranslateRun({
      jobs: jobs(5), units: 10, packages: false, classifiers,
      limits: { ...limits, model: "claude-3-5-haiku-20241022" }, skippedOverCap: 0, scanTruncated: false,
    });
    expect(known.costMicros).toBe(priceCall("claude", "claude-3-5-haiku-20241022", known.inputTokens, known.outputTokens).costMicros);
    const unknown = estimateTranslateRun({
      jobs: jobs(5), units: 10, packages: false, classifiers,
      limits: { ...limits, model: "claude-from-the-future" }, skippedOverCap: 0, scanTruncated: false,
    });
    expect(unknown.pricedAtCeiling).toBe(true);
    expect(unknown.costMicros!).toBeGreaterThanOrEqual(known.costMicros!);
  });

  it("an unpriced provider has tokens and no cost, and never claims to exceed a budget", () => {
    const e = estimateTranslateRun({
      jobs: jobs(5), units: 10, packages: false, classifiers,
      limits: { ...limits, provider: "huggingface", model: "x" },
      skippedOverCap: 0, scanTruncated: false,
      managedBudget: { remainingMicros: 1, limitMicros: 100 },
    });
    expect(e.costMicros).toBeNull();
    expect(e.inputTokens).toBeGreaterThan(0);
    expect(e.budget?.wouldExceed).toBe(false);
  });

  it("managed: wouldExceed compares the cost with the REMAINING budget", () => {
    const base = {
      jobs: jobs(50), units: 100, packages: false, classifiers, limits, skippedOverCap: 0, scanTruncated: false,
    };
    const cost = estimateTranslateRun(base).costMicros!;
    expect(estimateTranslateRun({ ...base, managedBudget: { remainingMicros: cost - 1, limitMicros: cost * 10 } }).budget)
      .toEqual({ remainingMicros: cost - 1, limitMicros: cost * 10, wouldExceed: true });
    expect(estimateTranslateRun({ ...base, managedBudget: { remainingMicros: cost, limitMicros: cost * 10 } }).budget?.wouldExceed)
      .toBe(false);
    expect(estimateTranslateRun(base).budget).toBeUndefined();
  });
});

// ─── handler: estimateOnly ─────────────────────────────────────────────────

function makeDb() {
  return {
    task: {
      create: vi.fn(),
      findFirst: vi.fn(async () => null),
      updateMany: vi.fn(),
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
    estimateOnly: "true",
    ...extra,
  };
  for (const [k, v] of Object.entries(fields)) formData.set(k, v);
  return {
    session: { shop: "s.myshopify.com" },
    admin: { graphql: vi.fn() },
    db,
    formData,
    settings,
    seoLimits: null,
    translationMode: undefined,
  } as any;
}

async function bodyOf(res: any): Promise<any> {
  return res.data ?? res;
}

describe("handleBulkEditorTranslate estimateOnly", () => {
  const translateShortFieldsBatch = vi.fn();
  const translateContent = vi.fn();

  beforeEach(() => {
    applyBulkDiff.mockReset();
    translateShortFieldsBatch.mockReset();
    translateContent.mockReset();
    managedBudgetStatus.mockReset();
    scan.mockReset();
    scan.mockResolvedValue({
      items: Array.from({ length: 30 }, (_, i) => ({
        rowId: `gid://shopify/Product/${i}`,
        title: `P${i}`,
        subtitle: "",
        columns: [{ columnId: "field.title", locales: ["fr", "es"], source: `Wollschal Modell ${i}` }],
      })),
      scanTruncated: false,
      matchedRows: 30,
      scannedRows: 30,
    });
    aiServiceFor.mockReset();
    aiServiceFor.mockReturnValue({
      service: { packageLimits: () => limits, translateShortFieldsBatch, translateContent },
      decision: { ok: true, source: "byo", provider: "claude" },
    });
  });

  it("creates no Task, makes no AI call and writes nothing; answers the planner's numbers", async () => {
    const db = makeDb();
    const res = await bodyOf(await handleBulkEditorTranslate(ctx(db)));
    expect(res.success).toBe(true);
    expect(db.task.create).not.toHaveBeenCalled();
    expect(db.task.updateMany).not.toHaveBeenCalled();
    expect(db.task.findFirst).not.toHaveBeenCalled();
    expect(applyBulkDiff).not.toHaveBeenCalled();
    expect(translateShortFieldsBatch).not.toHaveBeenCalled();
    expect(translateContent).not.toHaveBeenCalled();

    const expected = estimateTranslateRun({
      jobs: Array.from({ length: 30 }, (_, i) => ({
        rowId: `gid://shopify/Product/${i}`,
        cells: [{ column: titleColumn, fieldKey: "title", source: `Wollschal Modell ${i}`, locales: ["fr", "es"] }],
      })),
      units: 60,
      packages: false,
      classifiers,
      limits,
      skippedOverCap: 0,
      scanTruncated: false,
    });
    expect(res.estimate.units).toBe(60);
    expect(res.estimate.requests).toBe(expected.requests);
    // The handler adds the merchant's (default) translate instructions to the
    // input; the output side is the planner's alone.
    expect(res.estimate.inputTokens).toBeGreaterThanOrEqual(expected.inputTokens);
    expect(res.estimate.outputTokens).toBe(expected.outputTokens);
    expect(res.estimate.costMicros).toBe(
      priceCall(limits.provider, limits.model, res.estimate.inputTokens, res.estimate.outputTokens).costMicros,
    );
    expect(res.estimate.budget).toBeUndefined();
    expect(managedBudgetStatus).not.toHaveBeenCalled();
  });

  it("works while a run is active (no single-flight claim) and never starts one", async () => {
    const db = makeDb();
    db.task.findFirst = vi.fn(async () => ({ id: "running" }));
    const res = await bodyOf(await handleBulkEditorTranslate(ctx(db)));
    expect(res.success).toBe(true);
    expect(res.estimate).toBeTruthy();
  });

  it("managed shops get the share of the remaining budget, read-only", async () => {
    aiServiceFor.mockReturnValue({
      service: { packageLimits: () => limits },
      decision: { ok: true, source: "managed", provider: "claude" },
    });
    managedBudgetStatus.mockResolvedValue({ remainingMicros: 5_000_000, limitMicros: 20_000_000, readFailed: false });
    const db = makeDb();
    const res = await bodyOf(await handleBulkEditorTranslate(ctx(db)));
    expect(res.estimate.budget).toEqual({ remainingMicros: 5_000_000, limitMicros: 20_000_000, wouldExceed: false });
    expect(db.task.create).not.toHaveBeenCalled();
  });

  it("the plan gate and the row-type check still apply", async () => {
    const free = await handleBulkEditorTranslate(ctx(makeDb(), {}, { subscriptionPlan: "free" }));
    expect((free as any).init?.status ?? (free as any).status).toBe(403);
    expect(scan).not.toHaveBeenCalled();
  });

  it("an estimate that cannot be built answers a soft failure the page can start through", async () => {
    aiServiceFor.mockImplementation(() => {
      throw new Error("no service");
    });
    const res = await bodyOf(await handleBulkEditorTranslate(ctx(makeDb())));
    expect(res.success).toBe(false);
    expect(res.code).toBe("ESTIMATE_UNAVAILABLE");
  });
});

// ─── the refusal without a key is the route's, and it covers this action ───

describe("estimateOnly sits behind aiRefusalFor", () => {
  it("a shop without a key (and without the taster) is refused for bulkEditorTranslate", async () => {
    const { aiRefusalFor } = await import("~/utils/ai-refusal-response.server");
    const refusal = await aiRefusalFor(
      { subscriptionPlan: "pro", preferredProvider: "claude" } as any,
      "s.myshopify.com",
      { actionType: "bulkEditorTranslate" },
    );
    expect(refusal).not.toBeNull();
  });
});
