import { describe, it, expect, vi, beforeEach } from "vitest";
import { applyBulkDiff } from "~/services/bulk-editor/apply.server";
import {
  buildColumnsForType,
  resolveCellValue,
  ATTRIBUTE_BLOCK_COLUMNS,
  BULK_COLUMNS_BY_TYPE,
  type BulkDiffEntry,
  type BulkRow,
  type BulkRowType,
  type ColumnDescriptor,
  type ProductColumnCaps,
} from "~/services/bulk-editor/columns.shared";
import { attributesForResource } from "~/services/content-attributes.shared";
import { CREATE_PRODUCT_STATUSES, COLLECTION_SORT_ORDERS } from "~/config/shopify-enums.shared";

/**
 * The merchandising attributes in the GRID (§Phase 3).
 *
 * They existed only in the single editor, which meant the one kind of field a
 * merchant fixes across a whole catalogue — a theme template, a visibility
 * flag, a collection's sort order — was the one kind they had to open five
 * hundred items to reach.
 *
 * Three rules carry the correctness and each has its own describe block below:
 * the string→enum/boolean/list conversion goes through the ONE module the
 * single editor uses; the DB mirror comes from Shopify's ECHO, never from what
 * was sent; and a cell whose row predates the attribute sync is READ-ONLY,
 * because `Boolean @default(true)` on an unsynced page is indistinguishable
 * from "the merchant published it".
 */

const SHOP = "test-shop.myshopify.com";
const COLLECTION_ID = "gid://shopify/Collection/1";
const PAGE_ID = "gid://shopify/Page/2";
const ARTICLE_ID = "gid://shopify/Article/3";
const BLOG_ID = "gid://shopify/Blog/4";
const PRODUCT_ID = "gid://shopify/Product/5";

const fullCaps: ProductColumnCaps = { metafields: true, options: true, imageAlt: true };

function columnsByType(): Record<BulkRowType, ColumnDescriptor[]> {
  return {
    product: buildColumnsForType("product", [], fullCaps),
    variant: BULK_COLUMNS_BY_TYPE.variant,
    collection: BULK_COLUMNS_BY_TYPE.collection,
    article: BULK_COLUMNS_BY_TYPE.article,
    page: BULK_COLUMNS_BY_TYPE.page,
    blog: BULK_COLUMNS_BY_TYPE.blog,
    policy: BULK_COLUMNS_BY_TYPE.policy,
    metaobject: BULK_COLUMNS_BY_TYPE.metaobject,
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

/** No foreign translations anywhere ⇒ the §6.6 invalidation short-circuits
 *  before any Shopify call, which keeps these tests about the attributes. */
function mockDb() {
  return {
    product: {
      findUnique: vi.fn(async () => ({ seoTitle: "old", seoDescription: "old" })),
      update: vi.fn(async (_args?: unknown) => ({})),
    },
    collection: {
      findUnique: vi.fn(async () => ({ seoTitle: "old", seoDescription: "old" })),
      update: vi.fn(async (_args?: unknown) => ({})),
    },
    page: { update: vi.fn(async (_args?: unknown) => ({})) },
    article: { update: vi.fn(async (_args?: unknown) => ({})) },
    contentTranslation: {
      findMany: vi.fn(async () => [] as { key: string; locale: string }[]),
      deleteMany: vi.fn(async (_args?: unknown) => ({ count: 0 })),
    },
    aISettings: {
      findUnique: vi.fn(async () => ({
        translationPurgeOnPrimaryChange: true,
        autoTranslateExternalChanges: false,
        subscriptionPlan: "max",
      })),
    },
  };
}

function entry(rowId: string, rowType: BulkRowType, columnId: string, value: string): BulkDiffEntry {
  return { rowId, rowType, locale: "", marketId: "", columnId, value };
}

/** The four update mutations echo their attributes back (content.mutations.ts),
 *  which is what the DB mirror reads. `echo` overrides that per test. */
function respondWith(echo: Record<string, unknown> = {}) {
  return (query: string, variables: Record<string, unknown> | undefined): unknown => {
    if (query.includes("collectionUpdate(")) {
      const input = (variables?.input ?? {}) as Record<string, unknown>;
      return {
        data: {
          collectionUpdate: {
            collection: {
              id: COLLECTION_ID,
              handle: "h",
              sortOrder: input.sortOrder ?? null,
              templateSuffix: input.templateSuffix ?? null,
              ...echo,
            },
            userErrors: [],
          },
        },
      };
    }
    if (query.includes("pageUpdate(")) {
      const input = (variables?.page ?? {}) as Record<string, unknown>;
      return {
        data: {
          pageUpdate: {
            page: {
              id: PAGE_ID,
              handle: "h",
              isPublished: input.isPublished ?? null,
              templateSuffix: input.templateSuffix ?? null,
              ...echo,
            },
            userErrors: [],
          },
        },
      };
    }
    if (query.includes("articleUpdate(")) {
      const input = (variables?.article ?? {}) as Record<string, unknown>;
      const author = input.author as { name?: string } | undefined;
      return {
        data: {
          articleUpdate: {
            article: {
              id: ARTICLE_ID,
              handle: "h",
              author: author ? { name: author.name } : null,
              tags: input.tags ?? null,
              isPublished: input.isPublished ?? null,
              templateSuffix: input.templateSuffix ?? null,
              ...echo,
            },
            userErrors: [],
          },
        },
      };
    }
    if (query.includes("blogUpdate(")) {
      const input = (variables?.blog ?? {}) as Record<string, unknown>;
      return {
        data: {
          blogUpdate: {
            blog: { id: BLOG_ID, handle: "h", templateSuffix: input.templateSuffix ?? null, ...echo },
            userErrors: [],
          },
        },
      };
    }
    if (query.includes("productUpdate(")) {
      const input = (variables?.input ?? {}) as Record<string, unknown>;
      return {
        data: {
          productUpdate: {
            product: {
              id: PRODUCT_ID,
              handle: "h",
              tags: [],
              templateSuffix: input.templateSuffix ?? null,
              ...echo,
            },
            userErrors: [],
          },
        },
      };
    }
    throw new Error(`Unexpected query in test: ${query.slice(0, 100)}`);
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

// ─── The column universe ───────────────────────────────────────────────────

describe("the attribute columns each type actually has", () => {
  /** A `sortOrder` on a page is not a harmless extra — Shopify rejects the
   *  WHOLE input, which on an atomic mutation takes the merchant's text edits
   *  with it. So the grid may only offer what the resource declares. */
  it.each([
    ["collection", "Collection"],
    ["page", "Page"],
    ["article", "Article"],
    ["blog", "Blog"],
  ] as const)("offers no attribute %s does not declare", (rowType, resource) => {
    const declared = new Set<string>(attributesForResource(resource));
    const offered = BULK_COLUMNS_BY_TYPE[rowType]
      .filter((c) => c.kind === "field")
      .map((c) => c.id.slice("field.".length))
      .filter((name) => ATTRIBUTE_BLOCK_COLUMNS.has(`field.${name}`));

    for (const name of offered) expect(declared).toContain(name);
  });

  it("keeps every attribute column out of the foreign-locale groups", () => {
    // One value per item, so a translation screen has nothing to change here.
    for (const columns of Object.values(BULK_COLUMNS_BY_TYPE)) {
      for (const column of columns) {
        if (ATTRIBUTE_BLOCK_COLUMNS.has(column.id)) expect(column.translatable).toBe(false);
      }
    }
  });

  it("offers exactly the enum values the single editor does", () => {
    // Both are GraphQL ENUMS: a value outside the set fails at the SCHEMA
    // level, where `userErrors` never sees it and the save reads as a success
    // while nothing was written. The grid's status list is written out in its
    // own order (an existing dropdown must not reshuffle), so the SET is what
    // this pins.
    const status = BULK_COLUMNS_BY_TYPE.product.find((c) => c.id === "field.status")!;
    expect([...(status.selectOptions ?? [])].sort()).toEqual([...CREATE_PRODUCT_STATUSES].sort());

    const sortOrder = BULK_COLUMNS_BY_TYPE.collection.find((c) => c.id === "field.sortOrder")!;
    expect(sortOrder.selectOptions).toEqual([...COLLECTION_SORT_ORDERS]);
  });

  it("gives templateSuffix no static vocabulary — its options are the THEME's", () => {
    // The published theme's files are per shop and per resource, so they
    // cannot live in a static column universe. The cell falls back to a text
    // box while the lookup is pending or after it failed, which is the single
    // editor's rule too: an empty dropdown is a control whose next save clears
    // a working value.
    for (const rowType of ["product", "collection", "article", "page", "blog"] as const) {
      const column = BULK_COLUMNS_BY_TYPE[rowType].find((c) => c.id === "field.templateSuffix");
      expect(column, rowType).toBeDefined();
      expect(column!.inputType).toBe("select");
      expect(column!.selectOptions).toBeUndefined();
    }
  });
});

// ─── The attributesSyncedAt gate ───────────────────────────────────────────

describe("a row that was never attribute-synced", () => {
  const column = (rowType: BulkRowType, id: string) =>
    BULK_COLUMNS_BY_TYPE[rowType].find((c) => c.id === id)!;

  const pageRow = (attributesKnown: boolean): BulkRow => ({
    id: PAGE_ID,
    type: "page",
    title: "Impressum",
    seoTitle: "",
    seoDescription: "",
    handle: "impressum",
    isPublished: "true",
    templateSuffix: "",
    attributesKnown,
  });

  it("locks isPublished, because the column DEFAULT reads as 'visible'", () => {
    // `Page.isPublished` is `Boolean @default(true)`, so a row an older sync
    // wrote claims the page is visible whether or not it is. A merchant who
    // saw that and edited a NEIGHBOURING cell would publish a hidden page.
    const cell = resolveCellValue(pageRow(false), column("page", "field.isPublished"));
    expect(cell.editable).toBe(false);
    expect(cell.readOnlyReason).toBe("attributesNotSynced");
  });

  it("unlocks it once the block really was fetched", () => {
    const cell = resolveCellValue(pageRow(true), column("page", "field.isPublished"));
    expect(cell).toEqual({ value: "true", editable: true });
  });

  it("locks templateSuffix and sortOrder for the same reason", () => {
    const collectionRow: BulkRow = {
      id: COLLECTION_ID,
      type: "collection",
      title: "Sale",
      seoTitle: "",
      seoDescription: "",
      handle: "sale",
      sortOrder: "",
      templateSuffix: "",
      attributesKnown: false,
    };
    expect(resolveCellValue(collectionRow, column("collection", "field.sortOrder")).editable).toBe(false);
    expect(resolveCellValue(collectionRow, column("collection", "field.templateSuffix")).editable).toBe(
      false,
    );
  });
});

// ─── Writing them ──────────────────────────────────────────────────────────

describe("applyBulkDiff — attribute writes", () => {
  it("sends a collection's sortOrder and templateSuffix, and mirrors the ECHO", async () => {
    const { admin, calls } = mockAdmin(respondWith());
    const db = mockDb();

    const result = await applyBulkDiff(
      { db: db as never, shop: SHOP, admin: admin as never, columnsByType: columnsByType() },
      [
        entry(COLLECTION_ID, "collection", "field.sortOrder", "BEST_SELLING"),
        entry(COLLECTION_ID, "collection", "field.templateSuffix", "sale"),
      ],
    );

    expect(result.failures).toEqual([]);
    const input = calls.find((c) => c.query.includes("collectionUpdate("))!.variables?.input as Record<
      string,
      unknown
    >;
    expect(input.sortOrder).toBe("BEST_SELLING");
    expect(input.templateSuffix).toBe("sale");

    const mirrored = (db.collection.update.mock.calls[0]![0] as { data: Record<string, unknown> }).data;
    expect(mirrored.sortOrder).toBe("BEST_SELLING");
    expect(mirrored.templateSuffix).toBe("sale");
  });

  it("clears a templateSuffix as NULL, not as an empty string", async () => {
    // "" is the theme's DEFAULT template, which Shopify expresses as null —
    // and the Prisma column is nullable, so mirroring "" would leave the cache
    // claiming a suffix the theme does not have.
    const { admin, calls } = mockAdmin(respondWith());
    const db = mockDb();

    await applyBulkDiff(
      { db: db as never, shop: SHOP, admin: admin as never, columnsByType: columnsByType() },
      [entry(PAGE_ID, "page", "field.templateSuffix", "")],
    );

    const input = calls.find((c) => c.query.includes("pageUpdate("))!.variables?.page as Record<
      string,
      unknown
    >;
    expect(input.templateSuffix).toBeNull();
    const mirrored = (db.page.update.mock.calls[0]![0] as { data: Record<string, unknown> }).data;
    expect(mirrored.templateSuffix).toBeNull();
  });

  it("converts isPublished to a BOOLEAN and mirrors Shopify's own answer", async () => {
    const { admin, calls } = mockAdmin(respondWith());
    const db = mockDb();

    await applyBulkDiff(
      { db: db as never, shop: SHOP, admin: admin as never, columnsByType: columnsByType() },
      [entry(PAGE_ID, "page", "field.isPublished", "false")],
    );

    const input = calls.find((c) => c.query.includes("pageUpdate("))!.variables?.page as Record<
      string,
      unknown
    >;
    expect(input.isPublished).toBe(false);
    const mirrored = (db.page.update.mock.calls[0]![0] as { data: Record<string, unknown> }).data;
    // A Prisma Boolean column — the grid's string must never reach it.
    expect(mirrored.isPublished).toBe(false);
  });

  it("wraps an article's author in an AuthorInput and parses its tag list", async () => {
    const { admin, calls } = mockAdmin(respondWith());
    const db = mockDb();

    await applyBulkDiff(
      { db: db as never, shop: SHOP, admin: admin as never, columnsByType: columnsByType() },
      [
        entry(ARTICLE_ID, "article", "field.author", "Ada Lovelace"),
        // Shopify trims, drops empties and collapses case — the same parser
        // the single editor and the product row use.
        entry(ARTICLE_ID, "article", "field.tags", " Sale , sale,, Winter "),
      ],
    );

    const input = calls.find((c) => c.query.includes("articleUpdate("))!.variables?.article as Record<
      string,
      unknown
    >;
    // A bare string here fails at the SCHEMA level, i.e. a save that reports
    // success while nothing was written.
    expect(input.author).toEqual({ name: "Ada Lovelace" });
    expect(input.tags).toEqual(["Sale", "Winter"]);

    const mirrored = (db.article.update.mock.calls[0]![0] as { data: Record<string, unknown> }).data;
    expect(mirrored.author).toBe("Ada Lovelace");
    expect(mirrored.tags).toEqual(["Sale", "Winter"]);
  });

  it("refuses a bad enum PER CELL and still saves the rest of the row", async () => {
    const { admin, calls } = mockAdmin(respondWith());
    const db = mockDb();

    const result = await applyBulkDiff(
      { db: db as never, shop: SHOP, admin: admin as never, columnsByType: columnsByType() },
      [
        entry(COLLECTION_ID, "collection", "field.sortOrder", "CHEAPEST_FIRST"),
        entry(COLLECTION_ID, "collection", "field.title", "Sale"),
      ],
    );

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].columnId).toBe("field.sortOrder");
    const input = calls.find((c) => c.query.includes("collectionUpdate("))!.variables?.input as Record<
      string,
      unknown
    >;
    // Dropped, never forwarded: a bad enum comes back as a top-level `errors`
    // array with `data: null` that never reaches `userErrors`.
    expect(input.sortOrder).toBeUndefined();
    expect(input.title).toBe("Sale");
  });

  it("refuses a CLEARED article author rather than writing an empty name", async () => {
    const { admin, calls } = mockAdmin(respondWith());
    const db = mockDb();

    const result = await applyBulkDiff(
      { db: db as never, shop: SHOP, admin: admin as never, columnsByType: columnsByType() },
      [entry(ARTICLE_ID, "article", "field.author", "  ")],
    );

    // `ArticleCreateInput.author` is REQUIRED, so an article always has one —
    // leaving the existing author alone is the honest reading of an emptied
    // field the UI marks required.
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].columnId).toBe("field.author");
    // Nothing left to send: the mutation must not run with only an id, which
    // would report a successful save of nothing.
    expect(calls.some((c) => c.query.includes("articleUpdate("))).toBe(false);
    expect(db.article.update).not.toHaveBeenCalled();
  });

  it("writes a blog container's templateSuffix through blogUpdate", async () => {
    const { admin, calls } = mockAdmin(respondWith());

    const result = await applyBulkDiff(
      // Blog containers have no cache model — nothing is mirrored.
      { db: mockDb() as never, shop: SHOP, admin: admin as never, columnsByType: columnsByType() },
      [entry(BLOG_ID, "blog", "field.templateSuffix", "magazine")],
    );

    expect(result.failures).toEqual([]);
    const input = calls.find((c) => c.query.includes("blogUpdate("))!.variables?.blog as Record<
      string,
      unknown
    >;
    expect(input.templateSuffix).toBe("magazine");
  });

  it("writes a product's templateSuffix through productUpdate", async () => {
    const { admin, calls } = mockAdmin(respondWith());
    const db = mockDb();

    const result = await applyBulkDiff(
      { db: db as never, shop: SHOP, admin: admin as never, columnsByType: columnsByType() },
      [entry(PRODUCT_ID, "product", "field.templateSuffix", "gift-card")],
    );

    expect(result.failures).toEqual([]);
    const input = calls.find((c) => c.query.includes("productUpdate("))!.variables?.input as Record<
      string,
      unknown
    >;
    expect(input.templateSuffix).toBe("gift-card");
    const mirrored = (db.product.update.mock.calls[0]![0] as { data: Record<string, unknown> }).data;
    expect(mirrored.templateSuffix).toBe("gift-card");
  });

  it("leaves the mirror alone for an attribute Shopify did not echo", async () => {
    // "Shopify did not tell us" is not "the value is empty": the cached value
    // stays whatever the last sync established.
    const { admin } = mockAdmin((query, variables) => {
      if (query.includes("pageUpdate(")) {
        void variables;
        return { data: { pageUpdate: { page: { id: PAGE_ID, handle: "h" }, userErrors: [] } } };
      }
      throw new Error(`Unexpected query: ${query.slice(0, 80)}`);
    });
    const db = mockDb();

    await applyBulkDiff(
      { db: db as never, shop: SHOP, admin: admin as never, columnsByType: columnsByType() },
      [entry(PAGE_ID, "page", "field.isPublished", "false")],
    );

    const mirrored = (db.page.update.mock.calls[0]![0] as { data: Record<string, unknown> }).data;
    expect("isPublished" in mirrored).toBe(false);
  });
});

// ─── Read-only context: category and collection memberships ────────────────

describe("the product row's category and collection columns", () => {
  const column = (id: string) => buildColumnsForType("product", [], fullCaps).find((c) => c.id === id)!;

  const row = (over: Partial<BulkRow> = {}): BulkRow => ({
    id: PRODUCT_ID,
    type: "product",
    title: "Kumikobox",
    seoTitle: "",
    seoDescription: "",
    handle: "kumikobox",
    productCategory: "Home & Garden > Decor",
    productCollections: "Neuheiten, Sale",
    hasMoreCollections: false,
    attributesKnown: true,
    ...over,
  });

  it("shows both, and names the picker instead of leaving the cell mute", () => {
    // A category NAME is not a writable value (Shopify's tree repeats names
    // under different parents) and a membership is a JOIN/LEAVE diff, never a
    // list — a full-list write would drop collections this shop never cached.
    const category = resolveCellValue(row(), column("productCategory"));
    expect(category).toEqual({
      value: "Home & Garden > Decor",
      editable: false,
      readOnlyReason: "needsPicker",
    });
    const collections = resolveCellValue(row(), column("productCollections"));
    expect(collections.value).toBe("Neuheiten, Sale");
    expect(collections.readOnlyReason).toBe("needsPicker");
  });

  it("says when the membership list is INCOMPLETE", () => {
    // A truncated list is a different statement from a complete one, and it is
    // per row — so it overrides the column's own reason.
    const cell = resolveCellValue(row({ hasMoreCollections: true }), column("productCollections"));
    expect(cell.readOnlyReason).toBe("collectionsTruncated");
  });

  it("reports an unsynced row as UNKNOWN, not as 'no category'", () => {
    // Read-only and still gated: an empty cell on a row an older sync wrote is
    // "not fetched", which is what the grid's ghost text says.
    expect(ATTRIBUTE_BLOCK_COLUMNS.has("productCategory")).toBe(true);
    const cell = resolveCellValue(
      row({ attributesKnown: false, productCategory: "" }),
      column("productCategory"),
    );
    expect(cell.readOnlyReason).toBe("attributesNotSynced");
  });

  it("is never writable, through any entrance", async () => {
    // The route validator and the /api/ai task runner both check editability,
    // so a diff naming one of these fails per cell rather than reaching Shopify.
    const { admin, calls } = mockAdmin(respondWith());
    const db = mockDb();

    const result = await applyBulkDiff(
      { db: db as never, shop: SHOP, admin: admin as never, columnsByType: columnsByType() },
      [entry(PRODUCT_ID, "product", "productCategory", "Apparel")],
    );

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].columnId).toBe("productCategory");
    expect(calls).toHaveLength(0);
  });
});
