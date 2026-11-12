/**
 * applyBulkDiff `fillOnly` (PLAN_BULK_TRANSLATE_BATCHING §19.1-§19.2): the
 * write path of the "add missing translations" run refuses to write over a
 * translation that exists at Shopify NOW, and refuses to register a
 * translation of text that is not the text it was made for.
 *
 * Without `fillOnly` nothing changes — the other apply tests in
 * bulk-editor.translations.test.ts pin that unchanged behaviour.
 */
import { describe, it, expect, vi } from "vitest";
import { applyBulkDiff } from "~/services/bulk-editor/apply.server";
import { loadTranslatableState } from "~/services/translations/verified-translations.server";
import { DIGEST_BATCH_CHUNK, liveReadChunkSize } from "~/services/translations/translation-digest.shared";
import {
  buildColumnsForType,
  BULK_COLUMNS_BY_TYPE,
  estimateCalls,
  groupDiffByRow,
  metafieldColumnId,
  optionColumnId,
  type BulkDiffEntry,
  type BulkRowType,
  type ColumnDescriptor,
  type ProductColumnCaps,
} from "~/services/bulk-editor/columns.shared";
import { chunkImportDiff } from "~/services/bulk-editor/diff-chunks.server";

const SHOP = "fill-shop.myshopify.com";
const PRODUCT = "gid://shopify/Product/1";
const fullCaps: ProductColumnCaps = { metafields: true, options: true, imageAlt: true };

interface Node {
  /** key -> digest of the live primary content */
  content: Record<string, string>;
  /** locale -> key -> live translation value (null = none) */
  translations: Record<string, Record<string, string | null>>;
}

/** Answers the aliased state query (`a<i>` per resource, `t<j>` per locale)
 * from a per-resource table; a resource that is not in the table is `null`
 * (Shopify does not know it). Register answers echo what was sent. */
function shopify(nodes: Record<string, Node>, ) {
  const registered: { resourceId: string; translations: { key: string; locale: string; value: string }[] }[] = [];
  const queries: { query: string; variables: Record<string, unknown> | undefined }[] = [];
  const admin = {
    graphql: async (query: string, o?: { variables?: Record<string, unknown> }) => {
      const variables = o?.variables;
      queries.push({ query, variables });
      const respond = (): unknown => {
        if (query.includes("bulkEditorBatchDigests") || query.includes("bulkEditorTranslatableState")) {
          const locales: string[] = [];
          for (let j = 0; variables && `l${j}` in variables; j++) locales.push(variables[`l${j}`] as string);
          const build = (id: string) => {
            const node = nodes[id];
            if (!node) return null;
            const out: Record<string, unknown> = {
              translatableContent: Object.entries(node.content).map(([key, digest]) => ({
                key,
                value: `live ${key}`,
                digest,
              })),
            };
            locales.forEach((locale, j) => {
              out[`t${j}`] = Object.entries(node.translations[locale] ?? {}).map(([key, value]) => ({ key, value }));
            });
            return out;
          };
          if (query.includes("bulkEditorTranslatableState")) {
            return { data: { translatableResource: build(variables!.resourceId as string) } };
          }
          const data: Record<string, unknown> = {};
          for (let i = 0; variables && `r${i}` in variables; i++) data[`a${i}`] = build(variables[`r${i}`] as string);
          return { data };
        }
        if (query.includes("bulkFeaturedImageId")) {
          return { data: { collection: { image: { id: "gid://shopify/CollectionImage/9" } } } };
        }
        if (query.includes("translationsRegister")) {
          const resourceId = variables!.resourceId as string;
          const translations = variables!.translations as { key: string; locale: string; value: string }[];
          registered.push({ resourceId, translations });
          return {
            data: {
              translationsRegister: {
                translations: translations.map((t) => ({ key: t.key, locale: t.locale, value: t.value, market: null })),
                userErrors: [],
              },
            },
          };
        }
        throw new Error(`Unexpected query: ${query.slice(0, 80)}`);
      };
      return { json: async () => respond() } as unknown as Response;
    },
  };
  return { admin, registered, queries };
}

function mockDb(extra: Record<string, unknown> = {}) {
  return {
    contentTranslation: {
      upsert: vi.fn(async () => ({})),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    ...extra,
  };
}

function columnsByType(metafields: { namespace: string; key: string; type: string }[] = []): Record<BulkRowType, ColumnDescriptor[]> {
  return {
    product: buildColumnsForType("product", metafields, fullCaps),
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

const cell = (
  columnId: string,
  value: string,
  extra: Partial<BulkDiffEntry> = {},
): BulkDiffEntry => ({ rowId: PRODUCT, rowType: "product", locale: "fr", marketId: "", columnId, value, ...extra });

const run = (admin: unknown, db: unknown, diff: BulkDiffEntry[], cols = columnsByType()) =>
  applyBulkDiff({ db: db as never, shop: SHOP, admin: admin as never, columnsByType: cols, fillOnly: true }, diff);

describe("fillOnly — row cells", () => {
  it("writes a cell whose language is empty and whose digest is the expected one", async () => {
    const { admin, registered } = shopify({
      [PRODUCT]: { content: { title: "dig-1" }, translations: { fr: { title: null } } },
    });
    const db = mockDb();
    const result = await run(admin, db, [cell("field.title", "Titre", { expected: { [PRODUCT]: "dig-1" } })]);
    expect(registered).toHaveLength(1);
    expect(result.failures).toEqual([]);
    expect(result.skippedChanged).toBe(0);
    expect(result.skippedFilled).toBe(0);
    expect(db.contentTranslation.upsert).toHaveBeenCalledTimes(1);
  });

  it("skips (skippedFilled) a language that already holds a value at Shopify — nothing registered, nothing mirrored", async () => {
    // The DB mirror knows nothing about it: it was typed in Shopify's editor.
    const { admin, registered } = shopify({
      [PRODUCT]: { content: { title: "dig-1" }, translations: { fr: { title: "Deja la" } } },
    });
    const db = mockDb();
    const result = await run(admin, db, [cell("field.title", "Titre", { expected: { [PRODUCT]: "dig-1" } })]);
    expect(registered).toEqual([]);
    expect(db.contentTranslation.upsert).not.toHaveBeenCalled();
    expect(result.skippedFilled).toBe(1);
    expect(result.skippedChanged).toBe(0);
    expect(result.failures).toEqual([]);
  });

  it("skips (skippedChanged) when the primary text moved since the plan — the digest differs", async () => {
    const { admin, registered } = shopify({
      [PRODUCT]: { content: { title: "dig-NEW" }, translations: { fr: {} } },
    });
    const db = mockDb();
    const result = await run(admin, db, [cell("field.title", "Titre", { expected: { [PRODUCT]: "dig-OLD" } })]);
    expect(registered).toEqual([]);
    expect(result.skippedChanged).toBe(1);
    expect(result.failures).toEqual([]);
  });

  it("an already-filled language is reported as filled even if the source also changed", async () => {
    const { admin } = shopify({
      [PRODUCT]: { content: { title: "dig-NEW" }, translations: { fr: { title: "Deja" } } },
    });
    const result = await run(admin, mockDb(), [cell("field.title", "Titre", { expected: { [PRODUCT]: "dig-OLD" } })]);
    expect(result.skippedFilled).toBe(1);
    expect(result.skippedChanged).toBe(0);
  });

  it("a resource the live read did not return writes NOTHING and is a per-cell failure (unknown is not empty)", async () => {
    const { admin, registered } = shopify({});
    const db = mockDb();
    const result = await run(admin, db, [cell("field.title", "Titre", { expected: { [PRODUCT]: "dig-1" } })]);
    expect(registered).toEqual([]);
    expect(db.contentTranslation.upsert).not.toHaveBeenCalled();
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({ columnId: "field.title", locale: "fr" });
    expect(result.failures[0].message).toMatch(/could not be read/);
  });

  it("only the filled cell of a group is skipped; the empty one is still written", async () => {
    const { admin, registered } = shopify({
      [PRODUCT]: {
        content: { title: "d-t", body_html: "d-b" },
        translations: { fr: { title: "Deja", body_html: null } },
      },
    });
    const result = await run(admin, mockDb(), [
      cell("field.title", "Titre"),
      cell("field.descriptionHtml", "<p>Corps</p>"),
    ]);
    expect(registered).toHaveLength(1);
    expect(registered[0].translations.map((t) => t.key)).toEqual(["body_html"]);
    expect(result.skippedFilled).toBe(1);
  });

  it("refuses primary entries, market overrides and clears — they are not a fill", async () => {
    const { admin, registered, queries } = shopify({ [PRODUCT]: { content: { title: "d" }, translations: { fr: {} } } });
    const MARKET = "gid://shopify/Market/7";
    const result = await run(admin, mockDb(), [
      cell("field.title", "Primary", { locale: "" }),
      cell("field.descriptionHtml", "<p>x</p>", { marketId: MARKET }),
      cell("field.seoTitle", ""),
    ]);
    expect(registered).toEqual([]);
    expect(queries).toEqual([]);
    expect(result.failures).toHaveLength(3);
    expect(result.saved).toBe(0);
  });

  it("without fillOnly the same filled cell IS written (the mode is the difference)", async () => {
    const { admin, registered } = shopify({
      [PRODUCT]: { content: { title: "dig-1" }, translations: { fr: { title: "Deja la" } } },
    });
    const result = await applyBulkDiff(
      { db: mockDb() as never, shop: SHOP, admin: admin as never, columnsByType: columnsByType() },
      [cell("field.title", "Titre")],
    );
    expect(registered).toHaveLength(1);
    expect(result.skippedChanged).toBeUndefined();
    expect(result.skippedFilled).toBeUndefined();
  });
});

describe("fillOnly — sub-resources and featured alt", () => {
  const OPTION_ID = "gid://shopify/ProductOption/5";
  const V1 = "gid://shopify/ProductOptionValue/1";
  const V2 = "gid://shopify/ProductOptionValue/2";
  const optionDb = () =>
    mockDb({
      productMetafield: { findMany: vi.fn(async () => []) },
      productOption: {
        findMany: vi.fn(async () => [
          {
            id: OPTION_ID,
            productId: PRODUCT,
            position: 1,
            values: JSON.stringify([
              { id: V1, name: "Red" },
              { id: V2, name: "Blue" },
            ]),
            linkedMetafieldKey: null,
          },
        ]),
      },
    });

  it("an option-VALUES cell is checked per target resource: the filled entry stays, the empty one is written", async () => {
    const { admin, registered } = shopify({
      [V1]: { content: { name: "dv1" }, translations: { fr: { name: "Rouge deja" } } },
      [V2]: { content: { name: "dv2" }, translations: { fr: {} } },
    });
    const result = await run(admin, optionDb(), [
      cell(optionColumnId(1, "values"), "Rouge | Bleu", { expected: { [V1]: "dv1", [V2]: "dv2" } }),
    ]);
    expect(registered.map((r) => r.resourceId)).toEqual([V2]);
    expect(registered[0].translations[0].value).toBe("Bleu");
    // One cell, partly written: it is saved, not skipped.
    expect(result.skippedFilled).toBe(0);
    expect(result.skippedChanged).toBe(0);
    expect(result.failures).toEqual([]);
  });

  it("an option-values cell with every target skipped is ONE skipped cell", async () => {
    const { admin, registered } = shopify({
      [V1]: { content: { name: "dv1" }, translations: { fr: { name: "Rouge" } } },
      [V2]: { content: { name: "NEW" }, translations: { fr: {} } },
    });
    const result = await run(admin, optionDb(), [
      cell(optionColumnId(1, "values"), "Rouge | Bleu", { expected: { [V1]: "dv1", [V2]: "OLD" } }),
    ]);
    expect(registered).toEqual([]);
    // "changed" wins over "filled" for the one cell.
    expect(result.skippedChanged).toBe(1);
    expect(result.skippedFilled).toBe(0);
  });

  it("a metafield cell is read on its OWN Metafield resource", async () => {
    const MF = "gid://shopify/Metafield/3";
    const db = mockDb({
      productMetafield: {
        findMany: vi.fn(async () => [{ id: MF, productId: PRODUCT, namespace: "custom", key: "care" }]),
      },
      productOption: { findMany: vi.fn(async () => []) },
    });
    const cols = columnsByType([{ namespace: "custom", key: "care", type: "single_line_text_field" }]);
    const { admin, registered } = shopify({
      [MF]: { content: { value: "dm" }, translations: { fr: { value: "Deja" } } },
    });
    const result = await run(admin, db, [cell(metafieldColumnId("custom", "care"), "Soie", { expected: { [MF]: "dm" } })], cols);
    expect(registered).toEqual([]);
    expect(result.skippedFilled).toBe(1);
  });

  it("a featured-alt cell reads the IMAGE's live translations and digest", async () => {
    const IMAGE = "gid://shopify/CollectionImage/9";
    const COLLECTION = "gid://shopify/Collection/4";
    const base: Omit<BulkDiffEntry, "expected"> = {
      rowId: COLLECTION,
      rowType: "collection",
      locale: "fr",
      marketId: "",
      columnId: "img.featuredAlt",
      value: "Vase bleu",
    };
    // empty + matching digest: written
    let s = shopify({ [IMAGE]: { content: { alt: "da" }, translations: { fr: {} } } });
    let result = await applyBulkDiff(
      { db: mockDb() as never, shop: SHOP, admin: s.admin as never, columnsByType: columnsByType(), fillOnly: true },
      [{ ...base, expected: { [IMAGE]: "da" } }],
    );
    expect(s.registered).toHaveLength(1);
    expect(result.failures).toEqual([]);
    // filled: skipped
    s = shopify({ [IMAGE]: { content: { alt: "da" }, translations: { fr: { alt: "Deja" } } } });
    result = await applyBulkDiff(
      { db: mockDb() as never, shop: SHOP, admin: s.admin as never, columnsByType: columnsByType(), fillOnly: true },
      [{ ...base, expected: { [IMAGE]: "da" } }],
    );
    expect(s.registered).toEqual([]);
    expect(result.skippedFilled).toBe(1);
    // changed alt text: skipped
    s = shopify({ [IMAGE]: { content: { alt: "da2" }, translations: { fr: {} } } });
    result = await applyBulkDiff(
      { db: mockDb() as never, shop: SHOP, admin: s.admin as never, columnsByType: columnsByType(), fillOnly: true },
      [{ ...base, expected: { [IMAGE]: "da" } }],
    );
    expect(s.registered).toEqual([]);
    expect(result.skippedChanged).toBe(1);
  });
});

describe("fillOnly — query shape and cost", () => {
  it("divides the aliased page by the locale count and carries every locale as a variable", async () => {
    const ids = Array.from({ length: 40 }, (_, i) => `gid://shopify/Product/${i + 1}`);
    const nodes: Record<string, Node> = {};
    for (const id of ids) nodes[id] = { content: { title: "d" }, translations: { fr: {}, es: {}, it: {} } };
    const { admin, queries } = shopify(nodes);
    const gateway = { graphql: (q: string, o?: { variables?: Record<string, unknown> }) => admin.graphql(q, o) };
    const state = await loadTranslatableState(gateway as never, ids, ["title"], { liveLocales: ["fr", "es", "it"] });
    const perPage = liveReadChunkSize(3);
    expect(perPage).toBe(Math.floor(DIGEST_BATCH_CHUNK / 3));
    expect(queries).toHaveLength(Math.ceil(ids.length / perPage));
    for (const q of queries) {
      // 3 locale variables + at most `perPage` resource variables
      expect(Object.keys(q.variables ?? {}).filter((k) => k.startsWith("l"))).toEqual(["l0", "l1", "l2"]);
      expect(Object.keys(q.variables ?? {}).filter((k) => k.startsWith("r")).length).toBeLessThanOrEqual(perPage);
      // ASCII, no comment lines (graphql-document-hygiene)
      expect(/^[\x20-\x7e\n]*$/.test(q.query)).toBe(true);
    }
    expect(state.filled.get(ids[0])?.get("es")).toEqual(new Set());
  });

  it("an unanswered locale stays unknown (absent), an answered empty one is an empty set", async () => {
    const gateway = {
      graphql: async () => ({
        json: async () => ({
          data: {
            a0: { translatableContent: [{ key: "title", digest: "d" }], t0: [{ key: "title", value: null }] },
          },
        }),
      }),
    };
    const state = await loadTranslatableState(gateway as never, [PRODUCT], ["title"], { liveLocales: ["fr", "es"] });
    expect(state.filled.get(PRODUCT)?.get("fr")).toEqual(new Set());
    expect(state.filled.get(PRODUCT)?.has("es")).toBe(false);
  });

  it("estimateCalls counts the smaller live-read pages and the extra featured-alt read", () => {
    const cols = columnsByType().product;
    const diff: BulkDiffEntry[] = [];
    for (let i = 0; i < 60; i++) {
      for (const locale of ["fr", "es"]) {
        diff.push({ rowId: `gid://shopify/Product/${i}`, rowType: "product", locale, marketId: "", columnId: "field.title", value: "x" });
      }
    }
    const plain = estimateCalls(diff, cols);
    const fill = estimateCalls(diff, cols, { fillOnly: true });
    // plain: ceil(60/50) = 2 digest batches; fillOnly: pages of 25 -> ceil(60/25) = 3.
    expect(fill - plain).toBe(Math.ceil(60 / liveReadChunkSize(2)) - Math.ceil(60 / DIGEST_BATCH_CHUNK));
    expect(fill).toBeGreaterThan(plain);

    const alt: BulkDiffEntry[] = [
      { rowId: "gid://shopify/Collection/1", rowType: "collection", locale: "fr", marketId: "", columnId: "img.featuredAlt", value: "x" },
    ];
    const colCols = columnsByType().collection;
    expect(estimateCalls(alt, colCols, { fillOnly: true })).toBe(estimateCalls(alt, colCols) + 1);
  });

  it("chunkImportDiff keeps a row's cells together and splits by the fillOnly estimate", () => {
    const cols = columnsByType().product;
    const diff: BulkDiffEntry[] = [];
    for (let i = 0; i < 30; i++) {
      diff.push({ rowId: `gid://shopify/Product/${i}`, rowType: "product", locale: "fr", marketId: "", columnId: "field.title", value: "a" });
      diff.push({ rowId: `gid://shopify/Product/${i}`, rowType: "product", locale: "fr", marketId: "", columnId: "field.descriptionHtml", value: "b" });
    }
    const batches = chunkImportDiff(diff, cols, { maxCells: 20, fillOnly: true });
    expect(batches.length).toBe(3);
    for (const b of batches) {
      const rows = new Set(b.map((e) => e.rowId));
      expect(b.length).toBe(rows.size * 2);
    }
  });

  it("groupDiffByRow carries the expected digests per cell", () => {
    const groups = groupDiffByRow([
      cell("field.title", "T", { expected: { [PRODUCT]: "d1" } }),
      cell("field.descriptionHtml", "B"),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].expected).toEqual({ "field.title": { [PRODUCT]: "d1" } });
  });
});

describe("fillOnly — the plan's expected map must cover the write's targets (H1)", () => {
  const OPTION_ID = "gid://shopify/ProductOption/5";
  const V1 = "gid://shopify/ProductOptionValue/1";
  const V2 = "gid://shopify/ProductOptionValue/2";
  const optionDbWith = (valueIds: string[]) =>
    mockDb({
      productMetafield: { findMany: vi.fn(async () => []) },
      productOption: {
        findMany: vi.fn(async () => [
          {
            id: OPTION_ID,
            productId: PRODUCT,
            position: 1,
            values: JSON.stringify(valueIds.map((id, i) => ({ id, name: `v${i}` }))),
            linkedMetafieldKey: null,
          },
        ]),
      },
    });

  it("option values reordered since the plan: the whole cell is skippedChanged", async () => {
    const { admin, registered } = shopify({
      [V1]: { content: { name: "dv1" }, translations: { fr: {} } },
      [V2]: { content: { name: "dv2" }, translations: { fr: {} } },
    });
    const result = await run(admin, optionDbWith([V2, V1]), [
      cell(optionColumnId(1, "values"), "Rouge | Bleu", {
        expected: { [V1]: "dv1", [V2]: "dv2", "#order": `${V1},${V2}` },
      }),
    ]);
    expect(registered).toEqual([]);
    expect(result.skippedChanged).toBe(1);
  });

  it("option values in the planned order are written", async () => {
    const { admin, registered } = shopify({
      [V1]: { content: { name: "dv1" }, translations: { fr: {} } },
      [V2]: { content: { name: "dv2" }, translations: { fr: {} } },
    });
    await run(admin, optionDbWith([V1, V2]), [
      cell(optionColumnId(1, "values"), "Rouge | Bleu", {
        expected: { [V1]: "dv1", [V2]: "dv2", "#order": `${V1},${V2}` },
      }),
    ]);
    expect(registered).toHaveLength(2);
  });

  it("a target the plan did not know (an added option value) is changed", async () => {
    const { admin, registered } = shopify({
      [V1]: { content: { name: "dv1" }, translations: { fr: {} } },
      [V2]: { content: { name: "dv2" }, translations: { fr: {} } },
    });
    await run(admin, optionDbWith([V1, V2]), [
      cell(optionColumnId(1, "values"), "Rouge | Bleu", { expected: { [V1]: "dv1" } }),
    ]);
    expect(registered.map((r) => r.resourceId)).toEqual([V1]);
  });

  it("a metafield recreated under a new GID is changed, not written", async () => {
    const OLD = "gid://shopify/Metafield/3";
    const NEW = "gid://shopify/Metafield/4";
    const db = mockDb({
      productMetafield: {
        findMany: vi.fn(async () => [{ id: NEW, productId: PRODUCT, namespace: "custom", key: "care" }]),
      },
      productOption: { findMany: vi.fn(async () => []) },
    });
    const cols = columnsByType([{ namespace: "custom", key: "care", type: "single_line_text_field" }]);
    const { admin, registered } = shopify({ [NEW]: { content: { value: "dn" }, translations: { fr: {} } } });
    const result = await run(
      admin,
      db,
      [cell(metafieldColumnId("custom", "care"), "Soie", { expected: { [OLD]: "dm" } })],
      cols,
    );
    expect(registered).toEqual([]);
    expect(result.skippedChanged).toBe(1);
  });

  it("a featured image replaced since the plan is changed", async () => {
    const s = shopify({
      "gid://shopify/CollectionImage/9": { content: { alt: "da" }, translations: { fr: {} } },
    });
    const r = await applyBulkDiff(
      { db: mockDb() as never, shop: SHOP, admin: s.admin as never, columnsByType: columnsByType(), fillOnly: true },
      [
        {
          rowId: "gid://shopify/Collection/4",
          rowType: "collection",
          locale: "fr",
          marketId: "",
          columnId: "img.featuredAlt",
          value: "Vase",
          expected: { "gid://shopify/CollectionImage/1": "da" },
        },
      ],
    );
    expect(s.registered).toEqual([]);
    expect(r.skippedChanged).toBe(1);
  });

  it("a key absent at plan time (sentinel) reads any digest at write time as changed", async () => {
    const { admin, registered } = shopify({
      [PRODUCT]: { content: { title: "now-there" }, translations: { fr: {} } },
    });
    const result = await run(admin, mockDb(), [cell("field.title", "Titre", { expected: { [PRODUCT]: "#absent" } })]);
    expect(registered).toEqual([]);
    expect(result.skippedChanged).toBe(1);
  });

  it("a target that appeared since the plan recorded none (empty-order marker) is changed, not written", async () => {
    const MF = "gid://shopify/Metafield/4";
    const db = mockDb({
      productMetafield: { findMany: vi.fn(async () => [{ id: MF, productId: PRODUCT, namespace: "custom", key: "care" }]) },
      productOption: { findMany: vi.fn(async () => []) },
    });
    const cols = columnsByType([{ namespace: "custom", key: "care", type: "single_line_text_field" }]);
    const { admin, registered } = shopify({ [MF]: { content: { value: "dm" }, translations: { fr: {} } } });
    const result = await run(admin, db, [cell(metafieldColumnId("custom", "care"), "Soie", { expected: { "#order": "" } })], cols);
    expect(registered).toEqual([]);
    expect(result.skippedChanged).toBe(1);
  });

  it("a changed target list whose live read was NOT answered is unknown (a failure), never 'changed'", async () => {
    const MF = "gid://shopify/Metafield/4";
    const db = mockDb({
      productMetafield: { findMany: vi.fn(async () => [{ id: MF, productId: PRODUCT, namespace: "custom", key: "care" }]) },
      productOption: { findMany: vi.fn(async () => []) },
    });
    const cols = columnsByType([{ namespace: "custom", key: "care", type: "single_line_text_field" }]);
    // The mock has no node for MF: the live read does not answer for it.
    const { admin, registered } = shopify({});
    const result = await run(admin, db, [cell(metafieldColumnId("custom", "care"), "Soie", { expected: { "#order": "gid://shopify/Metafield/3" } })], cols);
    expect(registered).toEqual([]);
    expect(result.skippedChanged ?? 0).toBe(0);
    expect(result.failures).toHaveLength(1);
  });
});
