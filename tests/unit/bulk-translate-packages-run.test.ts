/**
 * The "add missing translations" run with cross-item PACKAGES
 * (PLAN_BULK_TRANSLATE_BATCHING phase 1b): off by default and then exactly the
 * per-row run; on, many rows ride in one request, every entry is verified, a
 * missing one walks the ladder and is never filled with its source, and the
 * write / cancel / stand-down behaviour is unchanged.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const translateShortFieldsBatch = vi.fn();
const translatePackage = vi.fn();
const translateBatchValuesToLocales = vi.fn();
const translateFieldsToLocalesChunked = vi.fn();
const packageLimits = vi.fn();
vi.mock("~/routes/api-ai-handlers/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/routes/api-ai-handlers/shared")>();
  return {
    ...actual,
    createAIService: () => ({
      translateShortFieldsBatch,
      translatePackage,
      translateBatchValuesToLocales,
      translateFieldsToLocalesChunked,
      packageLimits,
    }),
  };
});
const applyBulkDiff = vi.fn();
vi.mock("~/services/bulk-editor/apply.server", () => ({ applyBulkDiff: (...a: unknown[]) => applyBulkDiff(...a) }));
const planTranslateRead = vi.fn();
vi.mock("~/services/bulk-editor/translate-plan-read.server", () => ({
  planCellKey: (rowId: string, columnId: string) => `${rowId}|${columnId}`,
  planTranslateRead: (...a: unknown[]) => planTranslateRead(...a),
}));
vi.mock("~/utils/logger.server", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import {
  runBulkEditorTranslate,
  bulkTranslatePackagesEnabled,
  type TranslateJob,
} from "~/routes/api-ai-handlers/bulk-editor-translate.handler";
import { BULK_COLUMNS_BY_TYPE } from "~/services/bulk-editor/columns.shared";
import { ManagedAiRefusedError } from "../../src/services/ai.service";

const col = (id: string) => BULK_COLUMNS_BY_TYPE.product.find((c) => c.id === id)!;
const titleColumn = col("field.title");
const LOCALES = ["fr", "es"];

const job = (n: number, extra: Partial<TranslateJob["cells"][number]>[] = []): TranslateJob => ({
  rowId: `gid://shopify/Product/${n}`,
  cells: [{ column: titleColumn, fieldKey: "title", source: `Schal ${n}x`, locales: LOCALES }, ...extra.map((e) => e as never)],
  primaryHandle: "",
});
const jobs = (count: number) => Array.from({ length: count }, (_, i) => job(i + 1));

function makeDb(status = "running") {
  return {
    task: {
      update: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 1 })),
      findUnique: vi.fn(async () => ({ status })),
    },
    groupedFieldTranslation: {},
  } as any;
}

const run = (db: any, list: TranslateJob[], extra: Record<string, unknown> = {}) =>
  runBulkEditorTranslate("task-1", {
    db,
    shop: "s.myshopify.com",
    admin: {} as any,
    settings: null as any,
    jobs: list,
    units: list.reduce((n, j) => n + j.cells.reduce((m, c) => m + c.locales.length, 0), 0),
    rowType: "product",
    primaryLocale: "de",
    columnsByType: { product: BULK_COLUMNS_BY_TYPE.product } as any,
    aiInstructions: null,
    seoLimits: null as any,
    translationMode: undefined as any,
    ...extra,
  });

const finalResult = (db: any) => {
  const call = db.task.updateMany.mock.calls.map((c: any[]) => c[0]).find((c: any) => c.data.completedAt);
  return { data: call.data, result: call.data.result ? JSON.parse(call.data.result) : null };
};
const written = () => applyBulkDiff.mock.calls.flatMap((c) => c[1] as { rowId: string; locale: string; columnId: string; value: string; expected?: unknown }[]);

/** A model that translates each item "<locale>:<text>" -- keeps digits, so swap checks pass. */
function echoModel(opts: { drop?: (text: string) => boolean; truncateAbove?: number } = {}) {
  translatePackage.mockImplementation(async (req: any) => {
    if (opts.truncateAbove !== undefined && req.items.length > opts.truncateAbove) return { parsed: null, invalid: "truncated" };
    const parsed: Record<string, Record<string, string>> = {};
    for (const item of req.items) {
      if (opts.drop?.(item.text)) continue;
      parsed[item.id] = Object.fromEntries(req.locales.map((l: string) => [l, req.kind === "handle" ? `${l}-${item.text}` : `${l}:${item.text}`]));
    }
    return { parsed };
  });
}

beforeEach(() => {
  for (const fn of [translateShortFieldsBatch, translatePackage, translateBatchValuesToLocales, translateFieldsToLocalesChunked, applyBulkDiff, planTranslateRead, packageLimits]) fn.mockReset();
  packageLimits.mockReturnValue({ maxOutputTokens: 32_000, bucketTpm: null });
  translateShortFieldsBatch.mockImplementation(async (payload: Record<string, string>, _p: string, locales: string[]) =>
    Object.fromEntries(locales.map((l) => [l, Object.fromEntries(Object.entries(payload).map(([k, v]) => [k, `${l}:${v}`]))])),
  );
  planTranslateRead.mockImplementation(async (_d: unknown, list: unknown[]) => ({ jobs: list, expected: new Map(), skippedChanged: 0, failures: [] }));
  applyBulkDiff.mockImplementation(async (_c: unknown, piece: unknown[]) => ({ saved: piece.length, failures: [], skippedChanged: 0, skippedFilled: 0 }));
  delete process.env.BULK_TRANSLATE_PACKAGES;
});
afterEach(() => {
  delete process.env.BULK_TRANSLATE_PACKAGES;
});

describe("the switch", () => {
  it("is on only for exactly \"true\"", () => {
    for (const value of [undefined, "", "1", "TRUE", "True", "yes", "false"]) {
      if (value === undefined) delete process.env.BULK_TRANSLATE_PACKAGES;
      else process.env.BULK_TRANSLATE_PACKAGES = value;
      expect(bulkTranslatePackagesEnabled()).toBe(false);
    }
    process.env.BULK_TRANSLATE_PACKAGES = "true";
    expect(bulkTranslatePackagesEnabled()).toBe(true);
  });

  it("OFF (the default): the run is the per-row run -- one short-batch call per row, no package call, no packaging in the result", async () => {
    const db = makeDb();
    await run(db, jobs(5));
    expect(translatePackage).not.toHaveBeenCalled();
    expect(packageLimits).not.toHaveBeenCalled();
    expect(translateShortFieldsBatch).toHaveBeenCalledTimes(5);
    const { result } = finalResult(db);
    expect(result).toMatchObject({ saved: 10, failed: 0, mode: "sync", blocks: 1 });
    expect(result).not.toHaveProperty("packaging");
    expect(written()).toHaveLength(10);
  });

  it("the env switch turns packages on without any argument", async () => {
    process.env.BULK_TRANSLATE_PACKAGES = "true";
    echoModel();
    await run(makeDb(), jobs(3));
    expect(translatePackage).toHaveBeenCalledTimes(1);
    expect(translateShortFieldsBatch).not.toHaveBeenCalled();
  });
});

describe("packages ON", () => {
  it("30 rows x 2 languages ride in ONE request; every cell is written with the plan's digests", async () => {
    echoModel();
    const expected = new Map(jobs(30).map((j) => [`${j.rowId}|field.title`, { [j.rowId]: "d" }]));
    planTranslateRead.mockImplementation(async (_d: unknown, list: unknown[]) => ({ jobs: list, expected, skippedChanged: 0, failures: [] }));
    const db = makeDb();
    await run(db, jobs(30), { packages: true });
    expect(translatePackage).toHaveBeenCalledTimes(1);
    expect(translatePackage.mock.calls[0][0].items).toHaveLength(30);
    expect(translateShortFieldsBatch).not.toHaveBeenCalled();
    const entries = written();
    expect(entries).toHaveLength(60);
    expect(entries[0]).toMatchObject({ columnId: "field.title", expected: { "gid://shopify/Product/1": "d" } });
    for (const e of entries) expect(e.value).toMatch(/^(fr|es):Schal \d+x$/);
    const { result, data } = finalResult(db);
    expect(result).toMatchObject({ saved: 60, failed: 0, packaging: { packages: 1, requests: 1, retries: 0 } });
    expect(Object.values(result.packaging.groups)[0]).toMatchObject({ packages: 1, requests: 1, retries: 0 });
    expect(data.status).toBe("completed");
  });

  it("identical source texts are sent once and fan out to every row", async () => {
    echoModel();
    const same = ["a", "b", "c"].map((n, i) => ({ ...job(i + 1), cells: [{ column: titleColumn, fieldKey: "title", source: "Gleich", locales: LOCALES }] }));
    await run(makeDb(), same, { packages: true });
    expect(translatePackage.mock.calls[0][0].items).toHaveLength(1);
    expect(written()).toHaveLength(6);
  });

  it("a truncated package is retried as halves; nothing is lost", async () => {
    echoModel({ truncateAbove: 5 });
    const db = makeDb();
    await run(db, jobs(12), { packages: true });
    const sizes = translatePackage.mock.calls.map((c) => c[0].items.length);
    expect(sizes[0]).toBe(12);
    expect(sizes.slice(1)).toEqual([6, 3, 3, 6, 3, 3]);
    expect(written()).toHaveLength(24);
    const { result } = finalResult(db);
    expect(result.packaging).toMatchObject({ packages: 1, requests: 7, retries: 6 });
  });

  it("an entry the model drops goes to the single path; if that fails too it is a per-language failure and the SOURCE is never written", async () => {
    echoModel({ drop: (text) => text === "Schal 2x" });
    translateShortFieldsBatch.mockResolvedValue({}); // the single path delivers nothing either
    const db = makeDb();
    await run(db, jobs(3), { packages: true });
    const entries = written();
    expect(entries).toHaveLength(4); // rows 1 and 3, two languages each
    expect(entries.some((e) => e.rowId.endsWith("/2"))).toBe(false);
    expect(entries.some((e) => /Schal \dx$/.test(e.value) && !/^(fr|es):/.test(e.value))).toBe(false);
    const { result } = finalResult(db);
    expect(result.saved).toBe(4);
    expect(result.failed).toBe(2);
    expect(result.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rowId: "gid://shopify/Product/2", locale: "fr", message: "AI returned no translation." }),
        expect.objectContaining({ rowId: "gid://shopify/Product/2", locale: "es", message: "AI returned no translation." }),
      ]),
    );
  });

  it("swapped answers (numbers belonging to another entry) are rejected and re-asked, not written", async () => {
    translatePackage.mockImplementation(async (req: any) => {
      const parsed: Record<string, Record<string, string>> = {};
      // The first round swaps the first two entries' answers; later rounds are right.
      const swap = translatePackage.mock.calls.length === 1;
      req.items.forEach((item: any, i: number) => {
        const source = swap && i < 2 ? req.items[1 - i].text : item.text;
        parsed[item.id] = Object.fromEntries(req.locales.map((l: string) => [l, `${l}:${source}`]));
      });
      return { parsed };
    });
    await run(makeDb(), [job(1), job(2), job(3)], { packages: true });
    const byRow = new Map(written().filter((e) => e.locale === "fr").map((e) => [e.rowId, e.value]));
    expect(byRow.get("gid://shopify/Product/1")).toBe("fr:Schal 1x");
    expect(byRow.get("gid://shopify/Product/2")).toBe("fr:Schal 2x");
  });

  it("a handle is packed with its title as CONTEXT, and the slug rules still apply (equal-to-primary is skipped)", async () => {
    echoModel();
    const handleColumn = col("field.handle");
    const row: TranslateJob = {
      rowId: "gid://shopify/Product/1",
      cells: [
        { column: titleColumn, fieldKey: "title", source: "Wollschal", locales: ["fr"] },
        { column: handleColumn, fieldKey: "handle", source: "wollschal", locales: ["fr"] },
      ],
      primaryHandle: "fr-wollschal",
    };
    const db = makeDb();
    await run(db, [row], { packages: true });
    const requests = translatePackage.mock.calls.map((c) => c[0]);
    const handleRequest = requests.find((r) => r.kind === "handle");
    expect(handleRequest.items[0]).toMatchObject({ text: "wollschal", context: "Wollschal" });
    expect(requests.find((r) => r.kind === "short")).toBeDefined();
    const entries = written();
    expect(entries.map((e) => e.columnId)).toEqual(["field.title"]);
    expect(finalResult(db).result.skippedHandles).toBe(1);
  });

  it("different instruction text (SEO cap per field) never shares a package", async () => {
    echoModel();
    const seoColumn = col("field.seoTitle");
    const rows: TranslateJob[] = [1, 2].map((n) => ({
      rowId: `gid://shopify/Product/${n}`,
      cells: [
        { column: titleColumn, fieldKey: "title", source: `Schal ${n}x`, locales: LOCALES },
        { column: seoColumn, fieldKey: "seoTitle", source: `Schal SEO ${n}x`, locales: LOCALES },
      ],
      primaryHandle: "",
    }));
    await run(makeDb(), rows, {
      packages: true,
      aiInstructions: { translateInstructions: "Be brief." },
      translationMode: "seo_optimized",
      seoLimits: { seoTitle: 60, title: 255 } as never,
    });
    const requests = translatePackage.mock.calls.map((c) => c[0]);
    expect(requests).toHaveLength(2);
    expect(requests[0].instructions).not.toBe(requests[1].instructions);
  });

  it("productType stays on the per-row cached path", async () => {
    echoModel();
    const productTypeColumn = col("field.productType");
    const row: TranslateJob = {
      rowId: "gid://shopify/Product/1",
      cells: [
        { column: titleColumn, fieldKey: "title", source: "Schal 1x", locales: ["fr"] },
        { column: productTypeColumn, fieldKey: "productType", source: "Schals", locales: ["fr"] },
      ],
      primaryHandle: "",
    };
    const db = makeDb();
    db.groupedFieldTranslation = {
      findMany: vi.fn(async () => []),
      upsert: vi.fn(async () => ({})),
      createMany: vi.fn(async () => ({ count: 0 })),
    };
    await run(db, [row], { packages: true });
    expect(translatePackage.mock.calls.every((c) => c[0].kind === "short" && c[0].items.every((i: any) => i.text !== "Schals"))).toBe(true);
    expect(translateShortFieldsBatch.mock.calls.some((c) => "productType" in c[0])).toBe(true);
  });

  it("an entry too large for any package stays on the per-row path as a whole cell", async () => {
    echoModel();
    translateFieldsToLocalesChunked.mockImplementation(async (payload: Record<string, string>, _p: string, locales: string[]) =>
      Object.fromEntries(locales.map((l) => [l, Object.fromEntries(Object.keys(payload).map((k) => [k, `${l}:long`]))])),
    );
    const bodyColumn = col("field.descriptionHtml");
    const big = "<p>" + "wort ".repeat(5000) + "</p>"; // far above one package
    const row: TranslateJob = {
      rowId: "gid://shopify/Product/1",
      cells: [
        { column: titleColumn, fieldKey: "title", source: "Schal 1x", locales: ["fr"] },
        { column: bodyColumn, fieldKey: "body_html", source: big, locales: ["fr"] },
      ],
      primaryHandle: "",
    };
    const db = makeDb();
    await run(db, [row], { packages: true });
    expect(translateFieldsToLocalesChunked).toHaveBeenCalledTimes(1);
    expect(written().map((e) => e.columnId).sort()).toEqual(["field.descriptionHtml", "field.title"]);
    expect(finalResult(db).result.packaging.oversizedCells).toBe(1);
  });

  it("a managed refusal stands the run down: no more packages, nothing is reported as an AI failure, the code is the task error", async () => {
    translatePackage.mockRejectedValue(new ManagedAiRefusedError("budgetExceeded"));
    const db = makeDb();
    await run(db, jobs(5), { packages: true });
    expect(translatePackage).toHaveBeenCalledTimes(1);
    const { result, data } = finalResult(db);
    expect(data.error).toMatch(/^managed_ai_refused:/);
    expect(result.failures).toEqual([]);
    expect(applyBulkDiff).not.toHaveBeenCalled();
    expect(data.status).toBe("failed");
  });

  it("a stand-down mid-ladder still writes the entries the earlier answers already delivered", async () => {
    echoModel({ drop: (text) => text === "Schal 5x" });
    // The dropped entry goes down to the single path, where the refusal hits.
    translateShortFieldsBatch.mockRejectedValue(new ManagedAiRefusedError("budgetExceeded"));
    const db = makeDb();
    await run(db, jobs(5), { packages: true });
    const rows = new Set(written().map((e) => e.rowId));
    expect([...rows].sort()).toEqual([1, 2, 3, 4].map((n) => `gid://shopify/Product/${n}`));
    const { data, result } = finalResult(db);
    expect(data.error).toMatch(/^managed_ai_refused:/);
    expect(result.failures).toEqual([]);
    expect(data.status).not.toBe("failed");
  });

  it("only a group with at least three packages asks for prompt caching", async () => {
    echoModel();
    // One small package: not cacheable.
    await run(makeDb(), jobs(3), { packages: true });
    expect(translatePackage.mock.calls.every((c) => c[0].cacheable === undefined)).toBe(true);

    translatePackage.mockClear();
    echoModel();
    // A tiny output ceiling forces many packages in the one group.
    packageLimits.mockReturnValue({ maxOutputTokens: 1024, bucketTpm: null });
    await run(makeDb(), jobs(120), { packages: true });
    const first = translatePackage.mock.calls.map((c) => c[0]);
    expect(first.length).toBeGreaterThanOrEqual(3);
    expect(first.every((r) => r.cacheable === true)).toBe(true);
  });

  it("a cacheable group sends its FIRST package alone; the rest of the group follows once it has answered", async () => {
    echoModel();
    const base = translatePackage.getMockImplementation()!;
    const log: string[] = [];
    let inflight = 0;
    let maxInflightAfterFirst = 0;
    translatePackage.mockImplementation(async (req: any) => {
      const n = log.filter((l) => l.startsWith("start")).length + 1;
      log.push(`start${n}`);
      inflight++;
      if (n > 1) maxInflightAfterFirst = Math.max(maxInflightAfterFirst, inflight);
      if (n === 1) {
        // The first package is still out while the others would be taken.
        await new Promise((r) => setTimeout(r, 30));
        expect(inflight).toBe(1);
      } else {
        await new Promise((r) => setTimeout(r, 2));
      }
      const out = await base(req);
      inflight--;
      log.push(`end${n}`);
      return out;
    });
    packageLimits.mockReturnValue({ maxOutputTokens: 1024, bucketTpm: null });
    await run(makeDb(), jobs(120), { packages: true });
    expect(translatePackage.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(log.indexOf("end1")).toBeLessThan(log.indexOf("start2"));
    // After the first, the group runs with the normal concurrency again.
    expect(maxInflightAfterFirst).toBeGreaterThan(1);
  });

  it("a failing first package still releases its group (no deadlock)", async () => {
    echoModel();
    const base = translatePackage.getMockImplementation()!;
    translatePackage.mockImplementationOnce(async () => {
      throw Object.assign(new Error("boom"), { status: 400 });
    });
    translatePackage.mockImplementation(base);
    packageLimits.mockReturnValue({ maxOutputTokens: 1024, bucketTpm: null });
    await run(makeDb(), jobs(120), { packages: true });
    expect(translatePackage.mock.calls.length).toBeGreaterThan(3);
  });

  it("a transient provider error (503) repeats the same package once instead of splitting it", async () => {
    echoModel();
    const base = translatePackage.getMockImplementation()!;
    translatePackage.mockImplementationOnce(async () => {
      throw Object.assign(new Error("Service Unavailable"), { status: 503 });
    });
    translatePackage.mockImplementation(base);
    const db = makeDb();
    await run(db, jobs(4), { packages: true });
    expect(translatePackage.mock.calls.map((c) => c[0].items.length)).toEqual([4, 4]);
    expect(new Set(written().map((e) => e.rowId)).size).toBe(4);
  });

  it("a rejected provider key aborts the run as before (a failed task, not a per-entry failure)", async () => {
    const { InvalidAIKeyError } = await import("../../src/services/ai.service");
    translatePackage.mockRejectedValue(new InvalidAIKeyError("bad key"));
    const db = makeDb();
    await run(db, jobs(3), { packages: true });
    const update = db.task.updateMany.mock.calls.map((c: any[]) => c[0].data).find((d: any) => d.status === "failed");
    expect(update.error).toMatch(/bad key/);
  });

  it("a cancelled task spends nothing further and writes nothing more", async () => {
    echoModel();
    const db = makeDb("cancelled");
    await run(db, jobs(5), { packages: true });
    expect(translatePackage).not.toHaveBeenCalled();
    expect(applyBulkDiff).not.toHaveBeenCalled();
  });

  it("an option-values cell: the AI's entries are merged OVER the already translated ones", async () => {
    echoModel();
    const optionValuesColumn = { ...col("field.title"), id: "option.1.values", kind: "option", optionField: "values", optionPosition: 1 } as any;
    const row: TranslateJob = {
      rowId: "gid://shopify/Product/1",
      cells: [
        {
          column: optionValuesColumn,
          fieldKey: "option1",
          source: "Rot | Blau",
          locales: ["fr"],
          existingListValuesByLocale: { fr: ["Rouge", ""] },
        },
      ],
      primaryHandle: "",
    };
    // The generic classifier needs the sub-resource shape: stub it via the column kind.
    const db = makeDb();
    await run(db, [row], { packages: true });
    const entries = written();
    expect(entries).toHaveLength(1);
    expect(entries[0].value).toBe("Rouge | fr:Blau");
  });
});
