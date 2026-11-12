/**
 * Handle de-duplication of "add missing translations" (PLAN §19.7 M-5): the
 * per-language set of used handles starts from the handle translations the
 * shop ALREADY has, per RESOURCE TYPE and target language — a product's /fr/
 * handle and a page's /fr/ handle never compete for one URL — and not from an
 * empty set per run.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const translateShortFieldsBatch = vi.fn();
vi.mock("~/routes/api-ai-handlers/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/routes/api-ai-handlers/shared")>();
  return { ...actual, createAIService: () => ({ translateShortFieldsBatch }) };
});
const applyBulkDiff = vi.fn();
vi.mock("~/services/bulk-editor/apply.server", () => ({ applyBulkDiff: (...a: unknown[]) => applyBulkDiff(...a) }));
vi.mock("~/services/bulk-editor/translate-plan-read.server", () => ({
  planCellKey: (rowId: string, columnId: string) => `${rowId}|${columnId}`,
  planTranslateRead: async (_d: unknown, jobs: unknown[]) => ({ jobs, expected: new Map(), skippedChanged: 0, failures: [] }),
}));
vi.mock("~/utils/logger.server", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import {
  runBulkEditorTranslate,
  loadExistingHandles,
  handleScopeKey,
  type TranslateJob,
} from "~/routes/api-ai-handlers/bulk-editor-translate.handler";
import { BULK_COLUMNS_BY_TYPE, type BulkRowType } from "~/services/bulk-editor/columns.shared";

const SHOP = "s.myshopify.com";

describe("loadExistingHandles", () => {
  it("reads the mirrored handle translations of THIS resource type and the target languages, global layer only", async () => {
    const findMany = vi.fn(async () => [
      { locale: "fr", value: "mon-slug" },
      { locale: "fr", value: " autre " },
      { locale: "es", value: "mi-slug" },
      { locale: "es", value: "   " },
    ]);
    const scopes = await loadExistingHandles({ contentTranslation: { findMany } } as never, SHOP, "page", ["fr", "es"]);
    expect(findMany).toHaveBeenCalledWith({
      where: { shop: SHOP, resourceType: "Page", key: "handle", marketId: "", locale: { in: ["fr", "es"] } },
      select: { locale: true, value: true },
    });
    expect([...(scopes.get(handleScopeKey("Page", "fr")) ?? [])].sort()).toEqual(["autre", "mon-slug"]);
    expect([...(scopes.get(handleScopeKey("Page", "es")) ?? [])]).toEqual(["mi-slug"]);
    // never leaks into another resource type's scope
    expect(scopes.has(handleScopeKey("Product", "fr"))).toBe(false);
  });

  it("metaobjects and images have no handle translation: no query at all", async () => {
    const findMany = vi.fn(async () => []);
    for (const type of ["metaobject", "image"] as BulkRowType[]) {
      expect((await loadExistingHandles({ contentTranslation: { findMany } } as never, SHOP, type, ["fr"])).size).toBe(0);
    }
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe("the run de-duplicates a new handle against the shop's existing ones", () => {
  const handleColumn = (type: BulkRowType) => BULK_COLUMNS_BY_TYPE[type].find((c) => c.id === "field.handle")!;
  const jobFor = (type: BulkRowType, n: number): TranslateJob => ({
    rowId: `gid://shopify/${type === "page" ? "Page" : "Product"}/${n}`,
    cells: [{ column: handleColumn(type), fieldKey: "handle", source: `quelle ${n}`, locales: ["fr"] }],
    primaryHandle: "primary",
  });
  const makeDb = (existing: { locale: string; value: string }[]) =>
    ({
      task: {
        update: vi.fn(async () => ({})),
        updateMany: vi.fn(async () => ({ count: 1 })),
        findUnique: vi.fn(async () => ({ status: "running" })),
      },
      contentTranslation: { findMany: vi.fn(async () => existing) },
      groupedFieldTranslation: {},
    }) as any;
  const run = (db: any, type: BulkRowType, jobs: TranslateJob[]) =>
    runBulkEditorTranslate("t", {
      db,
      shop: SHOP,
      admin: {} as any,
      settings: null as any,
      jobs,
      units: jobs.length,
      rowType: type,
      primaryLocale: "de",
      columnsByType: { [type]: BULK_COLUMNS_BY_TYPE[type] } as any,
      aiInstructions: null,
      seoLimits: null as any,
      translationMode: undefined as any,
    });

  beforeEach(() => {
    translateShortFieldsBatch.mockReset();
    applyBulkDiff.mockReset();
    applyBulkDiff.mockImplementation(async (_c: unknown, piece: unknown[]) => ({ saved: piece.length, failures: [] }));
    // every handle translates to the same slug
    translateShortFieldsBatch.mockImplementation(async () => ({ fr: { handle: "Mon Slug" } }));
  });

  it("a slug the mirror already holds for this type and language gets a suffix", async () => {
    const db = makeDb([{ locale: "fr", value: "mon-slug" }]);
    await run(db, "page", [jobFor("page", 1)]);
    const written = applyBulkDiff.mock.calls[0][1] as { value: string }[];
    expect(written.map((e) => e.value)).toEqual(["mon-slug-2"]);
  });

  it("two rows of one run still dedupe against each other on top of the existing ones", async () => {
    const db = makeDb([{ locale: "fr", value: "mon-slug" }]);
    await run(db, "page", [jobFor("page", 1), jobFor("page", 2)]);
    const written = (applyBulkDiff.mock.calls[0][1] as { value: string }[]).map((e) => e.value);
    expect(written).toEqual(["mon-slug-2", "mon-slug-3"]);
  });

  it("is scoped to the resource type: a PAGE handle does not suffix a PRODUCT's", async () => {
    // the mirror query is made for the Product type; a Page row exists only in the fake's answer
    const db = makeDb([]);
    await run(db, "product", [jobFor("product", 1)]);
    expect(db.contentTranslation.findMany.mock.calls[0][0].where.resourceType).toBe("Product");
    const written = (applyBulkDiff.mock.calls[0][1] as { value: string }[]).map((e) => e.value);
    expect(written).toEqual(["mon-slug"]);
  });

  it("no handle column in the run: the mirror is not even queried", async () => {
    const title = BULK_COLUMNS_BY_TYPE.page.find((c) => c.id === "field.title")!;
    translateShortFieldsBatch.mockImplementation(async () => ({ fr: { title: "Titre" } }));
    const db = makeDb([]);
    await run(db, "page", [
      { rowId: "gid://shopify/Page/1", cells: [{ column: title, fieldKey: "title", source: "x", locales: ["fr"] }], primaryHandle: "" },
    ]);
    expect(db.contentTranslation.findMany).not.toHaveBeenCalled();
  });

  it("a failed mirror read does not stop the run (the in-run set still guards duplicates)", async () => {
    const db = makeDb([]);
    db.contentTranslation.findMany.mockRejectedValue(new Error("db blink"));
    await run(db, "page", [jobFor("page", 1), jobFor("page", 2)]);
    const written = (applyBulkDiff.mock.calls[0][1] as { value: string }[]).map((e) => e.value);
    expect(written).toEqual(["mon-slug", "mon-slug-2"]);
  });
});
