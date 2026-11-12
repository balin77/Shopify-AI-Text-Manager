/**
 * The COLLECT half of the Batch-API mode (PLAN_BULK_TRANSLATE_BATCHING 5.5):
 * results -> per-item answers (succeeded / errored / expired / canceled /
 * missing lines / cut-off / garbled), what they cost, the cells that are still
 * missing and unchanged, the answer source the package ladder asks (paid
 * answers first, bounded live retries after), and the run itself in batch mode
 * (owned statuses, digests from the submit, no per-row path, cancel -> cancelled).
 *
 * The provider is mocked away entirely: these tests prove the mapping and the
 * write rules, never the provider.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const applyBulkDiff = vi.fn();
vi.mock("~/services/bulk-editor/apply.server", () => ({ applyBulkDiff: (...a: unknown[]) => applyBulkDiff(...a) }));
const planTranslateRead = vi.fn();
vi.mock("~/services/bulk-editor/translate-plan-read.server", () => ({
  planCellKey: (rowId: string, columnId: string) => `${rowId}|${columnId}`,
  planTranslateRead: (...a: unknown[]) => planTranslateRead(...a),
}));
const scanMissingTranslations = vi.fn();
vi.mock("~/services/bulk-editor/missing-translations.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/services/bulk-editor/missing-translations.server")>();
  return {
    ...actual,
    scanMissingTranslations: (...a: unknown[]) => scanMissingTranslations(...a),
    recheckMissingDetailed: vi.fn(async (_db: unknown, _shop: string, opts: { rowIds: string[]; columns: { id: string }[]; locales: string[] }) => ({
      missing: new Set(opts.rowIds.flatMap((r) => opts.columns.flatMap((c) => opts.locales.map((l) => `${r}|${c.id}|${l}`)))),
      goneRows: new Set<string>(),
      emptySources: new Set<string>(),
    })),
  };
});
vi.mock("~/services/bulk-editor/columns.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/services/bulk-editor/columns.server")>();
  const { BULK_COLUMNS_BY_TYPE } = await import("~/services/bulk-editor/columns.shared");
  return { ...actual, buildServerColumnsByType: vi.fn(async () => ({ product: BULK_COLUMNS_BY_TYPE.product })) };
});
vi.mock("~/utils/logger.server", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { BULK_COLUMNS_BY_TYPE } from "~/services/bulk-editor/columns.shared";
import {
  BatchAnswerAI,
  buildBatchAnswers,
  rebuildJobsFromScan,
  runBatchCollect,
  usageItemsFromResults,
} from "~/services/bulk-editor/translate-batch-collect.server";
import { itemSignature, sourceHash, retryBudgetFor, type BatchManifest } from "~/services/bulk-editor/translate-batch.shared";
import type { SettlementResultItem } from "~/services/ai/batch-settlement.shared";
import { ManagedAiRefusedError } from "../../src/services/ai.service";

const titleColumn = BULK_COLUMNS_BY_TYPE.product.find((c) => c.id === "field.title")!;
const LOCALES = ["fr", "es"];
const ROW = (n: number) => `gid://shopify/Product/${n}`;
const src = (n: number) => `Schal ${n}x`;
const sig = (text: string) => itemSignature({ kind: "short", source: text });

/** A manifest with `count` title cells (one per product), two requests of ten items at most. */
function manifestOf(count: number, over: Partial<BatchManifest> = {}): BatchManifest {
  const cells = Array.from({ length: count }, (_, i) => ({
    r: ROW(i + 1),
    c: "field.title",
    l: LOCALES,
    h: sourceHash(src(i + 1)),
    e: { [ROW(i + 1)]: `digest-${i + 1}` },
  }));
  const requests: BatchManifest["requests"] = [];
  for (let start = 0; start < count; start += 10) {
    const ids = Array.from({ length: Math.min(10, count - start) }, (_, j) => start + j + 1);
    requests.push({ customId: `ttask_p${requests.length}`, kind: "short", items: ids.map((n) => sig(src(n))), maxTokens: 1000, inputEstimate: 200 });
  }
  return {
    v: 1,
    rowType: "product",
    moType: "",
    locales: LOCALES,
    primaryLocale: "de",
    units: count * LOCALES.length,
    cells,
    requests,
    plan: { skippedChanged: 0, failures: [], mismatchesByKey: {}, notStarted: 0 },
    submittedAt: "2026-11-12T00:00:00Z",
    ...over,
  };
}

/** The text a package answer would carry: `{"k1":{"fr":"fr:<text>", ...}}` for the ids given. */
function answerText(numbers: number[]): string {
  return JSON.stringify(
    Object.fromEntries(
      numbers.map((n, i) => [`k${i + 1}`, Object.fromEntries(LOCALES.map((l) => [l, `${l}:${src(n)}`]))]),
    ),
  );
}
const ok = (customId: string, numbers: number[], usage = { inputTokens: 500, outputTokens: 100 }): SettlementResultItem => ({
  customId,
  outcome: "succeeded",
  text: answerText(numbers),
  usage,
});

describe("buildBatchAnswers", () => {
  const m = manifestOf(20);
  const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

  it("maps every delivered item to its signature and counts the outcomes", () => {
    const results = new Map<string, SettlementResultItem>([
      ["ttask_p0", ok("ttask_p0", range(1, 10))],
      ["ttask_p1", ok("ttask_p1", range(11, 20))],
    ]);
    const { answers, undelivered, counts } = buildBatchAnswers(m, results);
    expect(answers.size).toBe(20);
    expect(undelivered.size).toBe(0);
    expect(counts).toMatchObject({ requests: 2, succeeded: 2, errored: 0, expired: 0, canceled: 0, missing: 0, invalid: 0 });
    expect(answers.get(sig(src(3)))).toEqual({ fr: "fr:Schal 3x", es: "es:Schal 3x" });
  });

  it("errored / expired / canceled / a request with NO result line leave its items undelivered, each counted apart", () => {
    const results = new Map<string, SettlementResultItem>([
      ["ttask_p0", { customId: "ttask_p0", outcome: "errored", error: "overloaded" }],
      // ttask_p1: no line at all
    ]);
    const a = buildBatchAnswers(m, results);
    expect(a.answers.size).toBe(0);
    expect(a.undelivered.size).toBe(20);
    expect(a.counts).toMatchObject({ errored: 1, missing: 1, succeeded: 0 });

    const b = buildBatchAnswers(m, new Map([
      ["ttask_p0", { customId: "ttask_p0", outcome: "expired" as const }],
      ["ttask_p1", { customId: "ttask_p1", outcome: "canceled" as const }],
    ]));
    expect(b.counts).toMatchObject({ expired: 1, canceled: 1 });
    expect(b.undelivered.size).toBe(20);
  });

  it("a cut-off answer is invalid as a whole, whatever its beginning looks like", () => {
    const results = new Map<string, SettlementResultItem>([
      ["ttask_p0", { ...ok("ttask_p0", range(1, 10)), truncated: true }],
      ["ttask_p1", ok("ttask_p1", range(11, 20))],
    ]);
    const { answers, undelivered, counts } = buildBatchAnswers(m, results);
    expect(counts).toMatchObject({ succeeded: 2, invalid: 1 });
    expect(answers.size).toBe(10);
    expect(undelivered.size).toBe(10);
  });

  it("an unparseable answer is invalid; one entry the model skipped is undelivered, the rest are kept", () => {
    const garbled = buildBatchAnswers(m, new Map([["ttask_p0", { customId: "ttask_p0", outcome: "succeeded" as const, text: "sorry, no JSON" }]]));
    expect(garbled.counts.invalid).toBe(1);

    const withGap = JSON.parse(answerText(range(1, 10)));
    delete withGap.k4;
    const partial = buildBatchAnswers(m, new Map([["ttask_p0", { customId: "ttask_p0", outcome: "succeeded" as const, text: JSON.stringify(withGap) }]]));
    expect(partial.answers.size).toBe(9);
    expect([...partial.undelivered]).toContain(sig(src(4)));
  });

  it("a text delivered by one request is not undelivered because another request lost it", () => {
    const dup = manifestOf(1, {
      requests: [
        { customId: "ttask_p0", kind: "short", items: [sig(src(1))], maxTokens: 1, inputEstimate: 1 },
        { customId: "ttask_p1", kind: "short", items: [sig(src(1))], maxTokens: 1, inputEstimate: 1 },
      ],
    });
    const a = buildBatchAnswers(dup, new Map([["ttask_p0", { customId: "ttask_p0", outcome: "errored" as const }], ["ttask_p1", ok("ttask_p1", [1])]]));
    expect(a.answers.size).toBe(1);
    expect(a.undelivered.size).toBe(0);
  });
});

describe("usageItemsFromResults", () => {
  const m = manifestOf(20);
  it("books only SUCCEEDED requests (a failed one costs nothing), measured where the provider reported usage", () => {
    const items = usageItemsFromResults(
      m,
      new Map<string, SettlementResultItem>([
        ["ttask_p0", ok("ttask_p0", [1], { inputTokens: 700, outputTokens: 90 })],
        ["ttask_p1", { customId: "ttask_p1", outcome: "errored" }],
      ]),
      "claude",
      "claude-haiku-4-5",
    );
    // no service tier reported: priced standard, the discount is never assumed
    expect(items).toEqual([{ provider: "claude", model: "claude-haiku-4-5", inputTokens: 700, outputTokens: 90, estimated: false, tier: "standard" }]);
  });

  it("L3: only a result the provider says ran in the batch tier is priced at the batch tier", () => {
    const [batch, other] = usageItemsFromResults(
      m,
      new Map<string, SettlementResultItem>([
        ["ttask_p0", ok("ttask_p0", [1], { inputTokens: 700, outputTokens: 90, serviceTier: "batch" } as never)],
        ["ttask_p1", ok("ttask_p1", [1], { inputTokens: 700, outputTokens: 90, serviceTier: "standard" } as never)],
      ]),
      "claude",
      "claude-haiku-4-5",
    );
    expect(batch.tier).toBe("batch");
    expect(other.tier).toBe("standard");
  });

  it("a cut-off answer WAS generated and is booked; a usage object of zero input is an estimate, never a free call", () => {
    const items = usageItemsFromResults(
      m,
      new Map<string, SettlementResultItem>([
        ["ttask_p0", { ...ok("ttask_p0", [1], { inputTokens: 600, outputTokens: 1000 }), truncated: true }],
        ["ttask_p1", { customId: "ttask_p1", outcome: "succeeded", text: "x".repeat(300), usage: { inputTokens: 0, outputTokens: 0 } }],
      ]),
      "claude",
      "claude-haiku-4-5",
    );
    expect(items[0]).toMatchObject({ inputTokens: 600, outputTokens: 1000, estimated: false });
    expect(items[1]).toMatchObject({ inputTokens: 200, outputTokens: 100, estimated: true, tier: "standard" });
  });

  it("carries the cache parts when the provider reports them", () => {
    const [item] = usageItemsFromResults(
      m,
      new Map([["ttask_p0", ok("ttask_p0", [1], { inputTokens: 700, outputTokens: 90, cacheReadTokens: 100, cacheWriteTokens: 50 } as never)]]),
      "claude",
      "claude-haiku-4-5",
    );
    expect(item).toMatchObject({ cacheReadTokens: 100, cacheWriteTokens: 50 });
  });
});

describe("rebuildJobsFromScan", () => {
  const columnById = new Map([[titleColumn.id, titleColumn]]);
  const m = manifestOf(4);
  const scanItem = (n: number, over: Partial<{ source: string; locales: string[] }> = {}) => ({
    rowId: ROW(n),
    primaryHandle: `h${n}`,
    columns: [{ columnId: "field.title", locales: over.locales ?? LOCALES, source: over.source ?? src(n) }],
  });

  it("keeps the cells that are still missing AND whose text is the one the model was asked about", () => {
    const out = rebuildJobsFromScan(m, [1, 2, 3, 4].map((n) => scanItem(n)), columnById);
    expect(out.jobs).toHaveLength(4);
    expect(out.jobs[0]).toMatchObject({ rowId: ROW(1), primaryHandle: "h1" });
    expect(out.jobs[0].cells[0]).toMatchObject({ fieldKey: "title", source: src(1), locales: LOCALES });
    expect(out.skippedChanged).toBe(0);
    expect(out.skippedFilled).toBe(0);
  });

  it("a text that moved while the batch waited is SKIPPED as changed, never translated over", () => {
    const out = rebuildJobsFromScan(m, [scanItem(1, { source: "Neuer Text" }), scanItem(2), scanItem(3), scanItem(4)], columnById);
    expect(out.jobs.map((j) => j.rowId)).toEqual([ROW(2), ROW(3), ROW(4)]);
    expect(out.skippedChanged).toBe(2); // two languages
  });

  it("a language filled meanwhile drops out (skippedFilled); the other language is still written", () => {
    const out = rebuildJobsFromScan(m, [scanItem(1, { locales: ["es"] }), scanItem(2), scanItem(3), scanItem(4)], columnById);
    expect(out.jobs[0].cells[0].locales).toEqual(["es"]);
    expect(out.skippedFilled).toBe(1);
  });

  it("a cell the scan no longer finds (filled everywhere, or the row is gone) is counted as filled, not failed", () => {
    const out = rebuildJobsFromScan(m, [scanItem(2), scanItem(3), scanItem(4)], columnById);
    expect(out.jobs).toHaveLength(3);
    expect(out.skippedFilled).toBe(2);
  });
});

describe("BatchAnswerAI -- paid answers first, bounded live retries after", () => {
  const request = (numbers: number[]) => ({
    kind: "short" as const,
    fromLang: "de",
    locales: LOCALES,
    items: numbers.map((n, i) => ({ id: `k${i + 1}`, text: src(n) })),
    contentType: "product",
    plannedOutputTokens: 100,
    timeoutMs: 120_000,
  });
  const live = (impl: (req: any) => unknown) => ({ translatePackage: vi.fn(async (req: any) => impl(req)), translateShortFieldsBatch: vi.fn() }) as never;

  it("answers from the batch by item text, under the ids THIS call uses (the collect may plan other packages than the submit)", async () => {
    const data = buildBatchAnswers(manifestOf(20), new Map([["ttask_p0", ok("ttask_p0", [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])]]));
    const ai = new BatchAnswerAI(data, null, 0, { maxOutputTokens: 32_000 });
    const result = await ai.translatePackage(request([7, 3]));
    expect(result.parsed).toEqual({
      k1: { fr: "fr:Schal 7x", es: "es:Schal 7x" },
      k2: { fr: "fr:Schal 3x", es: "es:Schal 3x" },
    });
    expect(ai.retries).toBe(0);
  });

  it("an undelivered item is re-asked LIVE, only that item, once, and its answer joins the batch's", async () => {
    const data = buildBatchAnswers(manifestOf(20), new Map([["ttask_p1", ok("ttask_p1", [11, 12, 13, 14, 15, 16, 17, 18, 19, 20])]]));
    const liveAi = live((req) => ({ parsed: { [req.items[0].id]: { fr: "fr:Schal 1x", es: "es:Schal 1x" } } }));
    const ai = new BatchAnswerAI(data, liveAi, 5, { maxOutputTokens: 32_000 });
    const first = await ai.translatePackage(request([1, 11]));
    expect((liveAi as any).translatePackage).toHaveBeenCalledTimes(1);
    expect((liveAi as any).translatePackage.mock.calls[0][0].items).toEqual([{ id: "k1", text: src(1) }]);
    expect(first.parsed).toEqual({
      k1: { fr: "fr:Schal 1x", es: "es:Schal 1x" },
      k2: { fr: "fr:Schal 11x", es: "es:Schal 11x" },
    });
    // the same text is never re-asked a second time
    await ai.translatePackage(request([1]));
    expect((liveAi as any).translatePackage).toHaveBeenCalledTimes(1);
    expect(ai.retries).toBe(1);
  });

  it("past the retry budget the entry is simply left out (the cell is reported, nothing is invented)", async () => {
    const data = buildBatchAnswers(manifestOf(20), new Map());
    const liveAi = live(() => ({ parsed: {} }));
    const ai = new BatchAnswerAI(data, liveAi, 1, { maxOutputTokens: 32_000 });
    await ai.translatePackage(request([1]));
    const second = await ai.translatePackage(request([2]));
    expect((liveAi as any).translatePackage).toHaveBeenCalledTimes(1);
    expect(second.parsed).toEqual({});
    await expect(ai.translateShortFieldsBatch({ title: "x" }, "de", LOCALES)).rejects.toThrow("batch_retry_unavailable");
  });

  it("a text that is not in the manifest at all (it changed) is never asked live", async () => {
    const liveAi = live(() => ({ parsed: {} }));
    const ai = new BatchAnswerAI(buildBatchAnswers(manifestOf(2), new Map()), liveAi, 5, { maxOutputTokens: 32_000 });
    await ai.translatePackage({ ...request([1]), items: [{ id: "k1", text: "Etwas ganz Neues" }] });
    expect((liveAi as any).translatePackage).not.toHaveBeenCalled();
  });

  it("a managed refusal in a live retry switches live retries OFF and never throws -- the paid results are still written", async () => {
    const liveAi = live(() => {
      throw new ManagedAiRefusedError("budgetExceeded");
    });
    const ai = new BatchAnswerAI(buildBatchAnswers(manifestOf(20), new Map()), liveAi, 5, { maxOutputTokens: 32_000 });
    await expect(ai.translatePackage(request([1]))).resolves.toEqual({ parsed: {} });
    await ai.translatePackage(request([2]));
    expect((liveAi as any).translatePackage).toHaveBeenCalledTimes(1);
  });

  it("the budget is min(20, 10 % of the requests), at least one", () => {
    expect(retryBudgetFor(1)).toBe(1);
    expect(retryBudgetFor(50)).toBe(5);
    expect(retryBudgetFor(1000)).toBe(20);
  });
});

// ─── the run, in batch mode ─────────────────────────────────────────────────

function makeDb(status: string) {
  const state = { status };
  return {
    state,
    task: {
      update: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 1 })),
      findUnique: vi.fn(async () => ({ status: state.status })),
    },
    groupedFieldTranslation: {},
  } as any;
}

function collectInput(db: any, over: Record<string, unknown> = {}, manifest = manifestOf(3)) {
  const results = new Map([["ttask_p0", ok("ttask_p0", [1, 2, 3])]]);
  return {
    db,
    shop: "s.myshopify.com",
    admin: {} as any,
    settings: null as any,
    taskId: "task-1",
    manifest,
    answers: buildBatchAnswers(manifest, results),
    live: null,
    aiInstructions: null,
    seoLimits: null as any,
    translationMode: undefined as any,
    summary: { requests: 1, succeeded: 1 },
    maxOutputTokens: 32_000,
    ...over,
  };
}

const terminalCalls = (db: any) => db.task.updateMany.mock.calls.map((c: any[]) => c[0]).filter((c: any) => c.data.completedAt);
const written = () => applyBulkDiff.mock.calls.flatMap((c) => c[1] as { rowId: string; locale: string; columnId: string; value: string; expected?: Record<string, string> }[]);

beforeEach(() => {
  for (const fn of [applyBulkDiff, planTranslateRead, scanMissingTranslations]) fn.mockReset();
  planTranslateRead.mockImplementation(async (_d: unknown, list: unknown[]) => ({
    jobs: list,
    expected: new Map(Object.entries({ [`${ROW(1)}|field.title`]: { [ROW(1)]: "FRESH" } })),
    skippedChanged: 0,
    failures: [],
  }));
  applyBulkDiff.mockImplementation(async (_c: unknown, piece: unknown[]) => ({ saved: piece.length, failures: [], skippedChanged: 0, skippedFilled: 0 }));
  scanMissingTranslations.mockImplementation(async () => ({
    items: [1, 2, 3].map((n) => ({
      rowId: ROW(n),
      primaryHandle: "",
      columns: [{ columnId: "field.title", locales: LOCALES, source: src(n) }],
    })),
    unitsByColumnLocale: {},
    matchedRows: 3,
    scannedRows: 3,
    scanTruncated: false,
  }));
});

describe("runBatchCollect", () => {
  it("re-reads the manifest's rows, verifies the paid answers and writes them fill-only, held to the digests of the SUBMIT", async () => {
    const db = makeDb("waiting_batch");
    await runBatchCollect(collectInput(db));

    // the scan is restricted to the manifest's rows
    expect(scanMissingTranslations.mock.calls[0][2]).toMatchObject({ rowIds: [ROW(1), ROW(2), ROW(3)], withSources: true, foreignLocales: LOCALES });
    const entries = written();
    expect(entries).toHaveLength(6);
    for (const e of entries) expect(e.value).toMatch(/^(fr|es):Schal \dx$/);
    // submit-time digests, not the fresh read's ("FRESH")
    expect(entries.find((e) => e.rowId === ROW(1))!.expected).toEqual({ [ROW(1)]: "digest-1" });
    expect(applyBulkDiff.mock.calls[0][0]).toMatchObject({ fillOnly: true });

    const [terminal] = terminalCalls(db);
    expect(terminal.where).toEqual({ id: "task-1", status: "waiting_batch" });
    expect(terminal.data.status).toBe("completed");
    const result = JSON.parse(terminal.data.result);
    expect(result).toMatchObject({ saved: 6, failed: 0, mode: "batch", batch: { requests: 1, succeeded: 1, retries: 0 } });
    // never the per-row path
    expect(result).not.toHaveProperty("notStarted");
  });

  it("owns waiting_batch AND cancel_requested: a cancel_requested Task writes its partial results and ends as `cancelled`", async () => {
    const db = makeDb("cancel_requested");
    await runBatchCollect(collectInput(db));
    const statuses = terminalCalls(db).map((c: any) => [c.where.status, c.data.status]);
    // one conditional update per owned status; only the one the Task is really in matches (the mock matches both)
    expect(statuses).toContainEqual(["cancel_requested", "cancelled"]);
    expect(statuses).toContainEqual(["waiting_batch", "completed"]);
    expect(written()).toHaveLength(6);
  });

  it("a Task that is no longer waiting (deleted / failed meanwhile) stops the run before it writes", async () => {
    const db = makeDb("failed");
    await runBatchCollect(collectInput(db));
    expect(applyBulkDiff).not.toHaveBeenCalled();
  });

  it("a text that moved since the submit is skipped (counted), the unchanged rows are still written", async () => {
    scanMissingTranslations.mockImplementation(async () => ({
      items: [
        { rowId: ROW(1), primaryHandle: "", columns: [{ columnId: "field.title", locales: LOCALES, source: "Ganz neuer Titel" }] },
        { rowId: ROW(2), primaryHandle: "", columns: [{ columnId: "field.title", locales: LOCALES, source: src(2) }] },
        { rowId: ROW(3), primaryHandle: "", columns: [{ columnId: "field.title", locales: LOCALES, source: src(3) }] },
      ],
      unitsByColumnLocale: {},
      matchedRows: 3,
      scannedRows: 3,
      scanTruncated: false,
    }));
    const db = makeDb("waiting_batch");
    await runBatchCollect(collectInput(db));
    expect(written().map((e) => e.rowId)).not.toContain(ROW(1));
    const result = JSON.parse(terminalCalls(db)[0].data.result);
    expect(result).toMatchObject({ saved: 4, skippedChanged: 2, failed: 0 });
  });

  it("units the submit never started are reported as notStarted, not as failures", async () => {
    const manifest = manifestOf(3, { units: 6 + 4, plan: { skippedChanged: 0, failures: [], mismatchesByKey: {}, notStarted: 4 } });
    const db = makeDb("waiting_batch");
    await runBatchCollect(collectInput(db, {}, manifest));
    const result = JSON.parse(terminalCalls(db)[0].data.result);
    expect(result).toMatchObject({ saved: 6, failed: 0, notStarted: 4 });
  });

  it("plan-time results of the SUBMIT are carried into the final result (changed text, unreadable cells)", async () => {
    const manifest = manifestOf(3, {
      units: 6 + 2 + 2,
      plan: {
        skippedChanged: 2,
        failures: [{ rowId: ROW(9), columnId: "field.title", message: "Shopify could not be read", units: 2 }],
        mismatchesByKey: { title: 2 },
        notStarted: 0,
      },
    });
    const db = makeDb("waiting_batch");
    await runBatchCollect(collectInput(db, {}, manifest));
    const result = JSON.parse(terminalCalls(db)[0].data.result);
    expect(result).toMatchObject({ saved: 6, skippedChanged: 2, failed: 2, mismatchesByKey: { title: 2 } });
    expect(result.failures[0]).toMatchObject({ rowId: ROW(9), message: "Shopify could not be read" });
  });

  it("an entry the batch did not deliver is a reported cell failure -- the source is never written as its translation", async () => {
    const manifest = manifestOf(3);
    const results = new Map([["ttask_p0", { customId: "ttask_p0", outcome: "errored" as const }]]);
    const db = makeDb("waiting_batch");
    await runBatchCollect(collectInput(db, { answers: buildBatchAnswers(manifest, results) }, manifest));
    expect(written()).toHaveLength(0);
    const [terminal] = terminalCalls(db);
    const result = JSON.parse(terminal.data.result);
    expect(result).toMatchObject({ saved: 0, failed: 6 });
    expect(terminal.data.status).toBe("failed");
  });
});

describe("static guards", () => {
  it("the collect run has no per-row path: batch mode never calls createAIService and drops the remaining jobs", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(__dirname, "..", "..", "app/routes/api-ai-handlers/bulk-editor-translate.handler.ts"), "utf8");
    expect(src).toMatch(/const aiService = batch \? \(null as unknown as AIService\) : createAIService/);
    expect(src).toMatch(/loopJobs = batch \? \[\] : phase\.remainingJobs;/);
  });
});
