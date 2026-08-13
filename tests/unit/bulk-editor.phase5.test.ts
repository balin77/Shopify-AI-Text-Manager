import { describe, it, expect, vi, beforeEach } from "vitest";
import { applyBulkDiff } from "~/services/bulk-editor/apply.server";
import { loadBulkRows } from "~/services/bulk-editor/load.server";
import { translationKeyForColumn } from "~/services/bulk-editor/translations.server";
import { allowedRowTypesForPlan } from "~/services/bulk-editor/columns.server";
import {
  buildColumnsForType,
  buildMetaobjectColumn,
  metaobjectColumnId,
  isColumnEditableForType,
  isValidBulkDiffEntry,
  resolveCellValue,
  computeDiff,
  estimateCalls,
  BULK_COLUMNS_BY_TYPE,
  type BulkDiffEntry,
  type BulkRow,
  type BulkRowType,
  type ColumnDescriptor,
  type MetaobjectColumnSpec,
  type ProductColumnCaps,
} from "~/services/bulk-editor/columns.shared";
import {
  buildCsv,
  parseCsv,
  mapCsvHeader,
  editsFromCsvRecords,
} from "~/services/bulk-editor/csv.shared";

/**
 * Phase-5 tests (Plan §7/§12): blog containers, policies and metaobjects.
 *
 * The blog-SEO-clear test is the §14-no.-4 lock of this phase: clearing
 * global.title_tag/description_tag MUST go through metafieldsDelete —
 * metafieldsSet with "" is rejected by Shopify and the classic silent-no-op
 * trap (CLAUDE.md gotcha).
 */

const SHOP = "test-shop.myshopify.com";
const BLOG_ID = "gid://shopify/Blog/11";
const POLICY_ID = "gid://shopify/ShopPolicy/22";
const MO_ID = "gid://shopify/Metaobject/33";

const fullCaps: ProductColumnCaps = { metafields: true, options: true, imageAlt: true };

const FAQ_SPECS: MetaobjectColumnSpec[] = [
  { type: "faq", fieldKey: "question", fieldType: "single_line_text_field", name: "Question" },
  { type: "faq", fieldKey: "answer", fieldType: "multi_line_text_field", name: "Answer" },
  { type: "faq", fieldKey: "details", fieldType: "rich_text_field", name: "Details" },
  { type: "faq", fieldKey: "tags", fieldType: "list.single_line_text_field", name: "Tags" },
  { type: "size_guide", fieldKey: "label", fieldType: "single_line_text_field", name: "Label" },
];

function columnsByType(metaobjectSpecs: MetaobjectColumnSpec[] = FAQ_SPECS): Record<BulkRowType, ColumnDescriptor[]> {
  return {
    product: buildColumnsForType("product", [], fullCaps),
    variant: BULK_COLUMNS_BY_TYPE.variant,
    collection: BULK_COLUMNS_BY_TYPE.collection,
    article: BULK_COLUMNS_BY_TYPE.article,
    page: BULK_COLUMNS_BY_TYPE.page,
    blog: BULK_COLUMNS_BY_TYPE.blog,
    policy: BULK_COLUMNS_BY_TYPE.policy,
    metaobject: buildColumnsForType("metaobject", [], fullCaps, metaobjectSpecs),
    image: BULK_COLUMNS_BY_TYPE.image,
  };
}

interface RecordedCall {
  query: string;
  variables: Record<string, unknown> | undefined;
}

function mockAdmin(respond: (query: string, variables: Record<string, unknown> | undefined) => unknown) {
  const calls: RecordedCall[] = [];
  const admin = {
    graphql: async (query: string, opts?: { variables?: Record<string, unknown> }) => {
      calls.push({ query, variables: opts?.variables });
      return { json: async () => respond(query, opts?.variables) } as unknown as Response;
    },
  };
  return { admin, calls };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

// ─── Column universe (Plan §7) ─────────────────────────────────────────────

describe("Phase-5 column universe", () => {
  it("keeps the policy title read-only (§14: shopPolicyUpdate has no title) and the body editable", () => {
    expect(isColumnEditableForType("policy", "policyTitle")).toBe(false);
    expect(isColumnEditableForType("policy", "field.body")).toBe(true);
    const body = BULK_COLUMNS_BY_TYPE.policy.find((c) => c.id === "field.body")!;
    expect(body.translatable).toBe(true);
  });

  it("gives blog containers exactly title/handle/seoTitle/seoDescription — no body (§14 no. 6)", () => {
    const ids = BULK_COLUMNS_BY_TYPE.blog.map((c) => c.id).sort();
    expect(ids).toEqual(["field.handle", "field.seoDescription", "field.seoTitle", "field.title"]);
    expect(BULK_COLUMNS_BY_TYPE.blog.every((c) => c.editable && c.translatable)).toBe(true);
  });

  it("builds metaobject columns per definition field with the metafield type filter", () => {
    const columns = buildColumnsForType("metaobject", [], fullCaps, FAQ_SPECS);
    const ids = columns.map((c) => c.id);
    expect(ids).toContain(metaobjectColumnId("faq", "question"));
    expect(ids).toContain(metaobjectColumnId("size_guide", "label"));
    // rich_text gets a column, but a read-only one ("open in editor").
    const details = columns.find((c) => c.id === metaobjectColumnId("faq", "details"))!;
    expect(details.editable).toBe(false);
    expect(details.translatable).toBe(false);
    // The shop-defined field name is the verbatim label (§10.4).
    expect(columns.find((c) => c.id === metaobjectColumnId("faq", "question"))!.label).toBe("Question");
  });
});

// ─── Cell resolution (Plan §12: "Feld fehlt ⇒ leer, rich_text ⇒ read-only") ─

describe("resolveCellValue — metaobject rows", () => {
  const columns = buildColumnsForType("metaobject", [], fullCaps, FAQ_SPECS);
  const col = (id: string) => columns.find((c) => c.id === id)!;
  const row: BulkRow = {
    id: MO_ID,
    type: "metaobject",
    title: "What is it?",
    seoTitle: "",
    seoDescription: "",
    handle: "what-is-it",
    moType: "faq",
    moFields: {
      [metaobjectColumnId("faq", "question")]: "What is it?",
      [metaobjectColumnId("faq", "details")]: JSON.stringify({
        type: "root",
        children: [{ type: "paragraph", children: [{ type: "text", value: "Rich details" }] }],
      }),
      [metaobjectColumnId("faq", "tags")]: JSON.stringify(["a", "b"]),
    },
  };

  it("resolves a missing field to an EMPTY but editable cell (the save creates the value)", () => {
    const cell = resolveCellValue(row, col(metaobjectColumnId("faq", "answer")));
    expect(cell).toEqual({ value: "", editable: true });
  });

  it("keeps rich_text fields read-only with a plain-text preview", () => {
    const cell = resolveCellValue(row, col(metaobjectColumnId("faq", "details")));
    expect(cell.editable).toBe(false);
    expect(cell.readOnlyReason).toBe("richText");
    expect(cell.value).toBe("Rich details");
  });

  it("renders a column of ANOTHER definition type read-only and empty", () => {
    const cell = resolveCellValue(row, col(metaobjectColumnId("size_guide", "label")));
    expect(cell).toEqual({ value: "", editable: false, readOnlyReason: "wrongMetaobjectType" });
  });

  it("formats list fields with the | separator", () => {
    const cell = resolveCellValue(row, col(metaobjectColumnId("faq", "tags")));
    expect(cell).toEqual({ value: "a | b", editable: true });
  });

  it("makes a list field READ-ONLY when an entry contains '|' (Finding 11)", () => {
    const conflictRow: BulkRow = {
      ...row,
      moFields: {
        ...row.moFields,
        [metaobjectColumnId("faq", "tags")]: JSON.stringify(["a", "b|c"]),
      },
    };
    const cell = resolveCellValue(conflictRow, col(metaobjectColumnId("faq", "tags")));
    expect(cell.editable).toBe(false);
    expect(cell.readOnlyReason).toBe("listSeparatorInValue");
  });

  it("resolves the read-only context columns from the row", () => {
    expect(resolveCellValue(row, col("moDisplayName")).value).toBe("What is it?");
    expect(resolveCellValue(row, col("moHandle")).value).toBe("what-is-it");
  });
});

// ─── Plan gating + entrance validation (Plan §3.4/§10.7) ───────────────────

describe("Phase-5 gating and validation", () => {
  it("intersects the new row types with PLAN_CONFIG contentTypes: policy is Basic+, blog/metaobject Pro+", () => {
    const basic = allowedRowTypesForPlan("basic");
    expect(basic).toContain("policy");
    expect(basic).not.toContain("blog");
    expect(basic).not.toContain("metaobject");
    const pro = allowedRowTypesForPlan("pro");
    expect(pro).toEqual(
      expect.arrayContaining(["product", "variant", "collection", "article", "page", "blog", "policy", "metaobject"]),
    );
  });

  it("accepts valid diff entries for the new types at both entrances (same validator)", () => {
    const byType = columnsByType();
    const all: BulkRowType[] = ["blog", "policy", "metaobject"];
    expect(
      isValidBulkDiffEntry(
        { rowId: BLOG_ID, rowType: "blog", locale: "", marketId: "", columnId: "field.seoTitle", value: "SEO" },
        all,
        byType,
      ),
    ).toBe(true);
    expect(
      isValidBulkDiffEntry(
        { rowId: POLICY_ID, rowType: "policy", locale: "", marketId: "", columnId: "field.body", value: "<p>x</p>" },
        all,
        byType,
      ),
    ).toBe(true);
    expect(
      isValidBulkDiffEntry(
        {
          rowId: MO_ID,
          rowType: "metaobject",
          locale: "",
          marketId: "",
          columnId: metaobjectColumnId("faq", "question"),
          value: "Q",
        },
        all,
        byType,
      ),
    ).toBe(true);
  });

  it("rejects the read-only policy title, unknown metaobject columns and plan-excluded types", () => {
    const byType = columnsByType();
    expect(
      isValidBulkDiffEntry(
        { rowId: POLICY_ID, rowType: "policy", locale: "", marketId: "", columnId: "policyTitle", value: "X" },
        ["policy"],
        byType,
      ),
    ).toBe(false);
    expect(
      isValidBulkDiffEntry(
        {
          rowId: MO_ID,
          rowType: "metaobject",
          locale: "",
          marketId: "",
          columnId: metaobjectColumnId("faq", "nonexistent"),
          value: "X",
        },
        ["metaobject"],
        byType,
      ),
    ).toBe(false);
    // A Basic shop's allowed list has no "blog" — the entry is refused even
    // though the column exists.
    expect(
      isValidBulkDiffEntry(
        { rowId: BLOG_ID, rowType: "blog", locale: "", marketId: "", columnId: "field.title", value: "X" },
        allowedRowTypesForPlan("basic"),
        byType,
      ),
    ).toBe(false);
  });

  it("keeps the rich_text metaobject column non-editable in the validator too", () => {
    const byType = columnsByType();
    expect(
      isValidBulkDiffEntry(
        {
          rowId: MO_ID,
          rowType: "metaobject",
          locale: "",
          marketId: "",
          columnId: metaobjectColumnId("faq", "details"),
          value: "X",
        },
        ["metaobject"],
        byType,
      ),
    ).toBe(false);
  });
});

// ─── Translation keys (Phase 5 additions) ──────────────────────────────────

describe("translationKeyForColumn — Phase-5 row types", () => {
  const policyBody = BULK_COLUMNS_BY_TYPE.policy.find((c) => c.id === "field.body")!;
  const articleBody = BULK_COLUMNS_BY_TYPE.article.find((c) => c.id === "field.body")!;
  const blogSeoDescription = BULK_COLUMNS_BY_TYPE.blog.find((c) => c.id === "field.seoDescription")!;
  const moQuestion = buildMetaobjectColumn(FAQ_SPECS[0]);

  it("resolves the ShopPolicy body exception: 'body', not 'body_html'", () => {
    expect(translationKeyForColumn(policyBody, "policy")).toBe("body");
    // Regression guard: every other type keeps body → body_html.
    expect(translationKeyForColumn(articleBody, "article")).toBe("body_html");
  });

  it("maps blog SEO columns onto meta_title/meta_description (§14 no. 6)", () => {
    expect(translationKeyForColumn(blogSeoDescription, "blog")).toBe("meta_description");
  });

  it("uses the raw field key for metaobject columns", () => {
    expect(translationKeyForColumn(moQuestion, "metaobject")).toBe("question");
  });
});

// ─── estimateCalls (Plan §10.1 Phase-5 counting) ───────────────────────────

describe("estimateCalls — Phase-5 rows", () => {
  const byType = columnsByType();

  const entry = (rowType: BulkRowType, rowId: string, columnId: string, value: string): BulkDiffEntry => ({
    rowId,
    rowType,
    locale: "",
    marketId: "",
    columnId,
    value,
  });

  it("counts a blog row as 1 call, plus 1 when an SEO half is CLEARED (metafieldsDelete)", () => {
    expect(estimateCalls([entry("blog", BLOG_ID, "field.title", "T")], byType.blog)).toBe(1);
    expect(
      estimateCalls(
        [entry("blog", BLOG_ID, "field.title", "T"), entry("blog", BLOG_ID, "field.seoTitle", "S")],
        byType.blog,
      ),
    ).toBe(1);
    expect(
      estimateCalls(
        [entry("blog", BLOG_ID, "field.title", "T"), entry("blog", BLOG_ID, "field.seoTitle", "")],
        byType.blog,
      ),
    ).toBe(2);
  });

  it("counts policy and metaobject rows as one call each", () => {
    expect(estimateCalls([entry("policy", POLICY_ID, "field.body", "<p>x</p>")], byType.policy)).toBe(1);
    expect(
      estimateCalls(
        [
          entry("metaobject", MO_ID, metaobjectColumnId("faq", "question"), "Q"),
          entry("metaobject", MO_ID, metaobjectColumnId("faq", "answer"), "A"),
        ],
        byType.metaobject,
      ),
    ).toBe(1);
  });
});

// ─── applyBulkDiff — blog rows (mock gateway, §14 no. 4) ───────────────────

describe("applyBulkDiff — blog containers", () => {
  const blogEntry = (columnId: string, value: string): BulkDiffEntry => ({
    rowId: BLOG_ID,
    rowType: "blog",
    locale: "",
    marketId: "",
    columnId,
    value,
  });

  const respond = (query: string) => {
    if (query.includes("blogUpdate(")) {
      return { data: { blogUpdate: { blog: { id: BLOG_ID, title: "T", handle: "h" }, userErrors: [] } } };
    }
    if (query.includes("metafieldsDelete(")) {
      return { data: { metafieldsDelete: { deletedMetafields: [], userErrors: [] } } };
    }
    throw new Error(`Unexpected query: ${query.slice(0, 80)}`);
  };

  it("clears an SEO cell via metafieldsDelete — NEVER an empty metafieldsSet (§14 no. 4)", async () => {
    const { admin, calls } = mockAdmin(respond);

    const result = await applyBulkDiff(
      { db: {} as never, shop: SHOP, admin: admin as never, columnsByType: columnsByType() },
      [blogEntry("field.title", "New title"), blogEntry("field.seoTitle", "")],
    );

    expect(result.failures).toEqual([]);
    expect(result.saved).toBe(1);
    const update = calls.find((c) => c.query.includes("blogUpdate("));
    expect(update).toBeDefined();
    const blogInput = update!.variables?.blog as { title?: string; metafields?: unknown };
    expect(blogInput.title).toBe("New title");
    // The cleared half must NOT ride in the metafields input.
    expect(blogInput.metafields).toBeUndefined();
    const del = calls.find((c) => c.query.includes("metafieldsDelete("));
    expect(del).toBeDefined();
    expect(del!.variables?.metafields).toEqual([
      { ownerId: BLOG_ID, namespace: "global", key: "title_tag" },
    ]);
  });

  it("sends a SET SEO value inside blogUpdate's metafields input without a delete call", async () => {
    const { admin, calls } = mockAdmin(respond);

    const result = await applyBulkDiff(
      { db: {} as never, shop: SHOP, admin: admin as never, columnsByType: columnsByType() },
      [blogEntry("field.seoDescription", "Fresh meta description")],
    );

    expect(result.failures).toEqual([]);
    const update = calls.find((c) => c.query.includes("blogUpdate("));
    const blogInput = update!.variables?.blog as {
      metafields?: { namespace: string; key: string; value: string; type: string }[];
    };
    expect(blogInput.metafields).toEqual([
      {
        namespace: "global",
        key: "description_tag",
        value: "Fresh meta description",
        type: "single_line_text_field",
      },
    ]);
    expect(calls.some((c) => c.query.includes("metafieldsDelete("))).toBe(false);
  });
});

// ─── applyBulkDiff — policy rows ───────────────────────────────────────────

describe("applyBulkDiff — policies", () => {
  const policyEntry = (value: string): BulkDiffEntry => ({
    rowId: POLICY_ID,
    rowType: "policy",
    locale: "",
    marketId: "",
    columnId: "field.body",
    value,
  });

  function policyDb(found = true) {
    return {
      shopPolicy: {
        findUnique: vi.fn(async (_args: unknown) => (found ? { type: "PRIVACY_POLICY" } : null)),
        update: vi.fn(async (_args: unknown) => ({})),
      },
    };
  }

  it("writes the body via shopPolicyUpdate(type, body) and mirrors the cache row", async () => {
    const { admin, calls } = mockAdmin((query) => {
      if (query.includes("shopPolicyUpdate(")) {
        return { data: { shopPolicyUpdate: { shopPolicy: { id: POLICY_ID }, userErrors: [] } } };
      }
      throw new Error(`Unexpected query: ${query.slice(0, 80)}`);
    });
    const db = policyDb();

    const result = await applyBulkDiff(
      { db: db as never, shop: SHOP, admin: admin as never, columnsByType: columnsByType() },
      [policyEntry("<p>New policy text</p>")],
    );

    expect(result.failures).toEqual([]);
    expect(result.saved).toBe(1);
    const call = calls.find((c) => c.query.includes("shopPolicyUpdate("));
    // §14: shopPolicyUpdate takes {type, body} — the TYPE comes from the
    // server-side cache row, never from the client.
    expect(call?.variables?.shopPolicy).toEqual({ type: "PRIVACY_POLICY", body: "<p>New policy text</p>" });
    expect(db.shopPolicy.update).toHaveBeenCalledTimes(1);
    const mirror = db.shopPolicy.update.mock.calls[0][0] as unknown as { data: { body: string } };
    expect(mirror.data.body).toBe("<p>New policy text</p>");
  });

  it("fails the row without calling Shopify when the policy is not in the cache (tenancy guard)", async () => {
    const { admin, calls } = mockAdmin(() => {
      throw new Error("must not be called");
    });
    const db = policyDb(false);

    const result = await applyBulkDiff(
      { db: db as never, shop: SHOP, admin: admin as never, columnsByType: columnsByType() },
      [policyEntry("<p>x</p>")],
    );

    expect(result.saved).toBe(0);
    expect(result.failures).toHaveLength(1);
    expect(calls).toHaveLength(0);
    expect(db.shopPolicy.update).not.toHaveBeenCalled();
  });
});

// ─── applyBulkDiff — metaobject rows (echo verification) ───────────────────

describe("applyBulkDiff — metaobjects", () => {
  const moEntry = (columnId: string, value: string): BulkDiffEntry => ({
    rowId: MO_ID,
    rowType: "metaobject",
    locale: "",
    marketId: "",
    columnId,
    value,
  });

  function moDb(type = "faq") {
    return {
      metaobject: {
        findUnique: vi.fn(async (_args: unknown) => ({ type })),
        update: vi.fn(async (_args: unknown) => ({})),
      },
      metaobjectTranslation: {
        upsert: vi.fn(async (_args: unknown) => ({})),
        deleteMany: vi.fn(async (_args: unknown) => ({ count: 1 })),
      },
    };
  }

  it("persists dirty fields with ONE metaobjectUpdate and mirrors only the ECHOED state", async () => {
    const { admin, calls } = mockAdmin((query, variables) => {
      if (query.includes("metaobjectUpdate(")) {
        const input = (variables?.metaobject as { fields: { key: string; value: string }[] }).fields;
        return {
          data: {
            metaobjectUpdate: {
              metaobject: {
                id: MO_ID,
                handle: "what-is-it",
                displayName: "What is it? (new)",
                type: "faq",
                fields: input.map((f) => ({ key: f.key, value: f.value, type: "single_line_text_field" })),
              },
              userErrors: [],
            },
          },
        };
      }
      throw new Error(`Unexpected query: ${query.slice(0, 80)}`);
    });
    const db = moDb();

    const result = await applyBulkDiff(
      { db: db as never, shop: SHOP, admin: admin as never, columnsByType: columnsByType() },
      [
        moEntry(metaobjectColumnId("faq", "question"), "New question?"),
        moEntry(metaobjectColumnId("faq", "answer"), "New answer"),
      ],
    );

    expect(result.failures).toEqual([]);
    expect(result.saved).toBe(1);
    const updates = calls.filter((c) => c.query.includes("metaobjectUpdate("));
    expect(updates).toHaveLength(1);
    expect((updates[0].variables?.metaobject as { fields: unknown[] }).fields).toHaveLength(2);
    expect(db.metaobject.update).toHaveBeenCalledTimes(1);
    const mirror = db.metaobject.update.mock.calls[0][0] as unknown as {
      data: { displayName: string; fields: { key: string; value: string }[] };
    };
    expect(mirror.data.displayName).toBe("What is it? (new)");
    expect(mirror.data.fields.map((f) => f.key).sort()).toEqual(["answer", "question"]);
  });

  it("fails the cell and skips the mirror when Shopify does not echo the written value", async () => {
    const { admin } = mockAdmin((query) => {
      if (query.includes("metaobjectUpdate(")) {
        return {
          data: {
            metaobjectUpdate: {
              metaobject: {
                id: MO_ID,
                type: "faq",
                // Echo carries the OLD value — the write silently no-opped.
                fields: [{ key: "question", value: "Old question?", type: "single_line_text_field" }],
              },
              userErrors: [],
            },
          },
        };
      }
      throw new Error("unexpected");
    });
    const db = moDb();

    const result = await applyBulkDiff(
      { db: db as never, shop: SHOP, admin: admin as never, columnsByType: columnsByType() },
      [moEntry(metaobjectColumnId("faq", "question"), "New question?")],
    );

    expect(result.saved).toBe(0);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].columnId).toBe(metaobjectColumnId("faq", "question"));
    expect(db.metaobject.update).not.toHaveBeenCalled();
  });

  it("rejects a column of another definition type as a cell failure without calling Shopify", async () => {
    const { admin, calls } = mockAdmin(() => {
      throw new Error("must not be called");
    });
    // The row is a size_guide — the faq column must not write into it.
    const db = moDb("size_guide");

    const result = await applyBulkDiff(
      { db: db as never, shop: SHOP, admin: admin as never, columnsByType: columnsByType() },
      [moEntry(metaobjectColumnId("faq", "question"), "X")],
    );

    expect(result.saved).toBe(0);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].columnId).toBe(metaobjectColumnId("faq", "question"));
    expect(calls).toHaveLength(0);
  });

  it("mirrors a verified foreign translation into MetaobjectTranslation (not ContentTranslation)", async () => {
    const { admin } = mockAdmin((query, variables) => {
      if (query.includes("bulkEditorBatchDigests")) {
        const data: Record<string, unknown> = {};
        for (const varName of Object.keys(variables ?? {})) {
          data[`a${varName.slice(1)}`] = {
            translatableContent: [{ key: "question", digest: "d-question" }],
          };
        }
        return { data };
      }
      if (query.includes("translationsRegister")) {
        return {
          data: {
            translationsRegister: {
              translations: [{ key: "question", locale: "fr", value: "Question ?", market: null }],
              userErrors: [],
            },
          },
        };
      }
      throw new Error(`Unexpected query: ${query.slice(0, 80)}`);
    });
    const db = {
      ...moDb(),
      contentTranslation: {
        upsert: vi.fn(async () => ({})),
        deleteMany: vi.fn(async () => ({ count: 0 })),
      },
    };

    const result = await applyBulkDiff(
      { db: db as never, shop: SHOP, admin: admin as never, columnsByType: columnsByType() },
      [
        {
          rowId: MO_ID,
          rowType: "metaobject",
          locale: "fr",
          marketId: "",
          columnId: metaobjectColumnId("faq", "question"),
          value: "Question ?",
        },
      ],
    );

    expect(result.failures).toEqual([]);
    expect(db.metaobjectTranslation.upsert).toHaveBeenCalledTimes(1);
    const upsert = db.metaobjectTranslation.upsert.mock.calls[0][0] as unknown as {
      create: { metaobjectId: string; key: string; locale: string; type: string };
    };
    expect(upsert.create).toMatchObject({
      metaobjectId: MO_ID,
      key: "question",
      locale: "fr",
      type: "faq",
    });
    expect(db.contentTranslation.upsert).not.toHaveBeenCalled();
  });
});

// ─── loadBulkRows — metaobject type filter ─────────────────────────────────

describe("loadBulkRows — metaobject rows", () => {
  it("restricts the query to the selected definition type and maps fields onto column ids", async () => {
    const findMany = vi.fn(async (_args: unknown) => [
      {
        id: MO_ID,
        type: "faq",
        handle: "what-is-it",
        displayName: "What is it?",
        fields: [
          { key: "question", value: "What is it?", type: "single_line_text_field" },
          { key: "answer", value: null, type: "multi_line_text_field" },
        ],
      },
    ]);
    const count = vi.fn(async (_args: unknown) => 1);
    const db = { metaobject: { findMany, count } };

    const result = await loadBulkRows(db as never, SHOP, {
      type: "metaobject",
      locale: "",
      marketId: "",
      search: "",
      filters: [],
      sort: null,
      skip: 0,
      take: 50,
      moType: "faq",
    });

    const where = (findMany.mock.calls[0][0] as unknown as { where: { AND: unknown[] } }).where;
    expect(where.AND).toEqual(expect.arrayContaining([{ type: "faq" }]));
    expect(result.total).toBe(1);
    expect(result.rows[0]).toMatchObject({
      id: MO_ID,
      type: "metaobject",
      title: "What is it?",
      handle: "what-is-it",
      moType: "faq",
    });
    expect(result.rows[0].moFields).toEqual({
      [metaobjectColumnId("faq", "question")]: "What is it?",
      [metaobjectColumnId("faq", "answer")]: "",
    });
  });
});

// ─── CSV roundtrip for a new type (Plan §12) ───────────────────────────────

describe("CSV roundtrip — blog rows", () => {
  it("export → parse → header map → edits → computeDiff yields exactly the typed change", () => {
    const columns = BULK_COLUMNS_BY_TYPE.blog;
    const row: BulkRow = {
      id: BLOG_ID,
      type: "blog",
      title: "News",
      seoTitle: "Old SEO",
      seoDescription: "",
      handle: "news",
    };

    const header = ["id", "field.handle", "field.title", "field.seoTitle"];
    const csv = buildCsv(header, [[BLOG_ID, "news", "News", "New SEO"]], ";");

    const records = parseCsv(csv);
    expect(records[0]).toEqual(header);
    const mapping = mapCsvHeader(records[0], columns, { foreign: false });
    expect(mapping.idIndex).toBe(0);
    expect(mapping.unknown).toEqual([]);

    const edits = editsFromCsvRecords(
      [{ rowId: BLOG_ID, cells: records[1] }],
      mapping,
      "",
      "",
    );
    const diff = computeDiff([row], columns, edits);
    // Unchanged handle/title produce no entries; the SEO change is the diff.
    expect(diff).toEqual([
      {
        rowId: BLOG_ID,
        rowType: "blog",
        locale: "",
        marketId: "",
        columnId: "field.seoTitle",
        value: "New SEO",
      },
    ]);
  });
});
