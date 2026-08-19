import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ShopifyApiGateway } from "~/services/shopify-api-gateway.service";
import {
  loadDigestsForRows,
  fetchDigestsForResource,
  registerAndVerify,
  removeAndVerify,
  removeAndVerifyAcrossLocales,
  LOCALE_KEY_SEP,
  translationKeyForColumn,
  translationKeysByColumnId,
} from "~/services/bulk-editor/translations.server";
import { applyBulkDiff } from "~/services/bulk-editor/apply.server";
import {
  estimateCalls,
  metafieldColumnId,
  optionColumnId,
  buildColumnsForType,
  IMG_ALT_COLUMN_ID,
  DIGEST_BATCH_CHUNK,
  BULK_COLUMNS_BY_TYPE,
  type BulkDiffEntry,
  type BulkRowType,
  type ColumnDescriptor,
  type ProductColumnCaps,
} from "~/services/bulk-editor/columns.shared";

/**
 * Phase-4 tests (Plan §6/§12): the verified translation write path.
 *
 * The registerAndVerify partial-echo test is THE test of this phase — it
 * covers the historically most expensive bug class of this app (silent no-op
 * translation saves that were mirrored into the DB anyway).
 */

const PRODUCT_ID = "gid://shopify/Product/1";
const SHOP = "test-shop.myshopify.com";
const LOCALE = "fr";

interface RecordedCall {
  query: string;
  variables: Record<string, unknown> | undefined;
}

/** Minimal fake gateway — the helpers only use `.graphql`. Keeping the real
 * ShopifyApiGateway out of the pure helper tests avoids its 1-s retry delays
 * when a call is made to fail. */
function fakeGateway(
  respond: (query: string, variables: Record<string, unknown> | undefined) => unknown,
): { gateway: ShopifyApiGateway; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const gateway = {
    graphql: async (query: string, opts?: { variables?: Record<string, unknown> }) => {
      calls.push({ query, variables: opts?.variables });
      const data = respond(query, opts?.variables);
      return { ok: true, status: 200, json: async () => data };
    },
  } as unknown as ShopifyApiGateway;
  return { gateway, calls };
}

/** Response payload for the aliased batch-digest query: every requested id
 * gets the given key→digest entries. */
function batchDigestResponse(variables: Record<string, unknown> | undefined, digests: Record<string, string>) {
  const data: Record<string, unknown> = {};
  for (const varName of Object.keys(variables ?? {})) {
    const idx = varName.slice(1);
    data[`a${idx}`] = {
      translatableContent: Object.entries(digests).map(([key, digest]) => ({ key, digest })),
    };
  }
  return { data };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

// ─── Column → key mapping (via the ONE exported constant) ──────────────────

describe("translationKeyForColumn", () => {
  const productColumns = BULK_COLUMNS_BY_TYPE.product;
  const articleColumns = BULK_COLUMNS_BY_TYPE.article;
  const col = (columns: ColumnDescriptor[], id: string) => columns.find((c) => c.id === id)!;

  it("maps the bulk column field names onto the canonical Shopify keys", () => {
    expect(translationKeyForColumn(col(productColumns, "field.title"))).toBe("title");
    expect(translationKeyForColumn(col(productColumns, "field.descriptionHtml"))).toBe("body_html");
    expect(translationKeyForColumn(col(articleColumns, "field.body"))).toBe("body_html");
    expect(translationKeyForColumn(col(articleColumns, "field.summary"))).toBe("summary_html");
    expect(translationKeyForColumn(col(productColumns, "field.handle"))).toBe("handle");
    expect(translationKeyForColumn(col(productColumns, "field.seoTitle"))).toBe("meta_title");
    expect(translationKeyForColumn(col(productColumns, "field.seoDescription"))).toBe("meta_description");
    expect(translationKeyForColumn(col(productColumns, "field.productType"))).toBe("product_type");
  });

  it("returns null for non-translatable and non-field columns", () => {
    expect(translationKeyForColumn(col(productColumns, "field.status"))).toBeNull();
    expect(translationKeyForColumn(col(productColumns, "image"))).toBeNull();
  });

  it("translationKeysByColumnId covers exactly the translatable columns of a type", () => {
    const keys = translationKeysByColumnId("page");
    expect([...keys.entries()].sort()).toEqual(
      [
        ["field.body", "body_html"],
        ["field.handle", "handle"],
        ["field.seoDescription", "meta_description"],
        ["field.seoTitle", "meta_title"],
        ["field.title", "title"],
      ].sort(),
    );
  });
});

// ─── loadDigestsForRows (Plan §6.2) ────────────────────────────────────────

describe("loadDigestsForRows", () => {
  it("dedupes resource ids and chunks the aliased batch at DIGEST_BATCH_CHUNK", async () => {
    const ids = Array.from({ length: DIGEST_BATCH_CHUNK + 10 }, (_, i) => `gid://shopify/Product/${i + 1}`);
    const withDupes = [...ids, ...ids.slice(0, 20)];
    const { gateway, calls } = fakeGateway((_query, variables) =>
      batchDigestResponse(variables, { title: "digest-t" }),
    );

    const result = await loadDigestsForRows(gateway, withDupes, ["title"]);

    expect(calls).toHaveLength(2);
    expect(Object.keys(calls[0].variables ?? {})).toHaveLength(DIGEST_BATCH_CHUNK);
    expect(Object.keys(calls[1].variables ?? {})).toHaveLength(10);
    expect(result.size).toBe(ids.length);
    expect(result.get(ids[0])?.get("title")).toBe("digest-t");
  });

  it("returns several keys per resource, filtered to the requested keys", async () => {
    const { gateway } = fakeGateway((_query, variables) =>
      batchDigestResponse(variables, { title: "d1", body_html: "d2", handle: "d3" }),
    );
    const result = await loadDigestsForRows(gateway, [PRODUCT_ID], ["title", "body_html"]);
    const digests = result.get(PRODUCT_ID)!;
    expect(digests.get("title")).toBe("d1");
    expect(digests.get("body_html")).toBe("d2");
    expect(digests.has("handle")).toBe(false); // not requested → not returned
  });

  it("falls back to per-item fetches when a whole chunk fails", async () => {
    const { gateway, calls } = fakeGateway((query) => {
      if (query.includes("bulkEditorBatchDigests")) throw new Error("chunk boom");
      return {
        data: { translatableResource: { translatableContent: [{ key: "title", digest: "solo" }] } },
      };
    });

    const ids = ["gid://shopify/Product/1", "gid://shopify/Product/2"];
    const result = await loadDigestsForRows(gateway, ids, ["title"]);

    // 1 failed batch + 2 per-item fallbacks.
    expect(calls).toHaveLength(3);
    expect(result.get(ids[0])?.get("title")).toBe("solo");
    expect(result.get(ids[1])?.get("title")).toBe("solo");
  });

  it("leaves a resource out entirely when even its per-item fallback fails", async () => {
    const { gateway } = fakeGateway(() => {
      throw new Error("everything down");
    });
    const result = await loadDigestsForRows(gateway, [PRODUCT_ID], ["title"]);
    expect(result.has(PRODUCT_ID)).toBe(false);
  });
});

// ─── registerAndVerify / removeAndVerify (Plan §6.2/§12) ───────────────────

describe("registerAndVerify", () => {
  it("confirms ONLY the keys Shopify echoes back — userErrors: [] alone is not success", async () => {
    // Shopify answers WITHOUT userErrors but silently drops meta_description
    // — the silent-no-op pattern. Only title + body_html may be confirmed.
    const { gateway } = fakeGateway(() => ({
      data: {
        translationsRegister: {
          translations: [
            { key: "title", locale: LOCALE, value: "Titre", market: null },
            { key: "body_html", locale: LOCALE, value: "<p>Corps</p>", market: null },
          ],
          userErrors: [],
        },
      },
    }));

    const { confirmedKeys, userErrors } = await registerAndVerify(gateway, PRODUCT_ID, [
      { key: "title", value: "Titre", locale: LOCALE, translatableContentDigest: "d1" },
      { key: "body_html", value: "<p>Corps</p>", locale: LOCALE, translatableContentDigest: "d2" },
      { key: "meta_description", value: "Méta", locale: LOCALE, translatableContentDigest: "d3" },
    ]);

    expect(userErrors).toEqual([]);
    expect([...confirmedKeys].sort()).toEqual(["body_html", "title"]);
    expect(confirmedKeys.has("meta_description")).toBe(false);
  });

  it("requires the echoed locale to match — an echo for another locale confirms nothing", async () => {
    const { gateway } = fakeGateway(() => ({
      data: {
        translationsRegister: {
          translations: [{ key: "title", locale: "de", value: "Titel", market: null }],
          userErrors: [],
        },
      },
    }));
    const { confirmedKeys } = await registerAndVerify(gateway, PRODUCT_ID, [
      { key: "title", value: "Titre", locale: LOCALE, translatableContentDigest: "d1" },
    ]);
    expect(confirmedKeys.size).toBe(0);
  });

  it("checks the echoed market id against the written one (§14 no. 7: market is an object)", async () => {
    const { gateway } = fakeGateway(() => ({
      data: {
        translationsRegister: {
          translations: [
            { key: "title", locale: LOCALE, value: "Titre", market: { id: "gid://shopify/Market/9" } },
          ],
          userErrors: [],
        },
      },
    }));
    const mismatched = await registerAndVerify(gateway, PRODUCT_ID, [
      {
        key: "title",
        value: "Titre",
        locale: LOCALE,
        translatableContentDigest: "d1",
        marketId: "gid://shopify/Market/3",
      },
    ]);
    expect(mismatched.confirmedKeys.size).toBe(0);

    const matched = await registerAndVerify(gateway, PRODUCT_ID, [
      {
        key: "title",
        value: "Titre",
        locale: LOCALE,
        translatableContentDigest: "d1",
        marketId: "gid://shopify/Market/9",
      },
    ]);
    expect(matched.confirmedKeys.has("title")).toBe(true);
  });
});

describe("removeAndVerify", () => {
  it("confirms only echoed removals and scopes market removals via marketIds", async () => {
    const { gateway, calls } = fakeGateway(() => ({
      data: {
        translationsRemove: {
          translations: [{ key: "title", locale: LOCALE }],
          userErrors: [],
        },
      },
    }));

    const { confirmedKeys } = await removeAndVerify(
      gateway,
      PRODUCT_ID,
      ["title", "body_html"],
      LOCALE,
      "gid://shopify/Market/3",
    );

    expect(confirmedKeys.has("title")).toBe(true);
    expect(confirmedKeys.has("body_html")).toBe(false);
    expect(calls[0].variables?.marketIds).toEqual(["gid://shopify/Market/3"]);
  });

  it("confirms an unechoed key when a fresh read shows it is GONE", async () => {
    // `translationsRemove` echoes what it DELETED, so a key that carried no
    // translation on Shopify comes back empty — and the merchant was told
    // "the translation was kept" about a field they had just cleared, with no
    // way to clear it. The re-read is the stronger form of the echo rule: it
    // asks for the state the rule exists to protect.
    const { gateway, calls } = fakeGateway((query: string) =>
      query.includes("translationsRemove")
        ? { data: { translationsRemove: { translations: [], userErrors: [] } } }
        : { data: { translatableResource: { translations: [{ key: "body_html", value: "x", market: null }] } } },
    );

    const { confirmedKeys, confirmedByRead } = await removeAndVerify(
      gateway,
      PRODUCT_ID,
      ["title", "body_html"],
      LOCALE,
      "",
    );

    expect(confirmedKeys.has("title")).toBe(true);
    expect(confirmedByRead?.has("title")).toBe(true);
    // Still there on Shopify ⇒ still not confirmed ⇒ the local row stays.
    expect(confirmedKeys.has("body_html")).toBe(false);
    expect(calls).toHaveLength(2);
  });

  it("treats an ABSENT translatableResource as inconclusive, never as removed", async () => {
    // A query that answered about nothing is not evidence that a key is gone
    // — the `translatableContent` trap wearing a different hat.
    const { gateway } = fakeGateway((query: string) =>
      query.includes("translationsRemove")
        ? { data: { translationsRemove: { translations: [], userErrors: [] } } }
        : { data: { translatableResource: null } },
    );
    const { confirmedKeys } = await removeAndVerify(gateway, PRODUCT_ID, ["title"], LOCALE, "");
    expect(confirmedKeys.size).toBe(0);
  });

  it("does not let a MARKET override count as the global translation surviving", async () => {
    const { gateway } = fakeGateway((query: string) =>
      query.includes("translationsRemove")
        ? { data: { translationsRemove: { translations: [], userErrors: [] } } }
        : {
            data: {
              translatableResource: {
                translations: [
                  { key: "title", value: "market only", market: { id: "gid://shopify/Market/3" } },
                ],
              },
            },
          },
    );
    const { confirmedKeys } = await removeAndVerify(gateway, PRODUCT_ID, ["title"], LOCALE, "");
    expect(confirmedKeys.has("title")).toBe(true);
  });

  it("passes marketIds: null for a global removal", async () => {
    const { gateway, calls } = fakeGateway(() => ({
      data: { translationsRemove: { translations: [], userErrors: [] } },
    }));
    await removeAndVerify(gateway, PRODUCT_ID, ["title"], LOCALE, "");
    expect(calls[0].variables?.marketIds).toBeNull();
  });
});

describe("removeAndVerifyAcrossLocales (Phase 4b invalidation)", () => {
  it("confirms only the (locale, key) pairs Shopify echoes back", async () => {
    const { gateway, calls } = fakeGateway(() => ({
      data: {
        translationsRemove: {
          // Asked for title+body_html across de+fr; Shopify only removed two.
          translations: [
            { key: "title", locale: "de" },
            { key: "body_html", locale: "fr" },
          ],
          userErrors: [],
        },
      },
    }));

    const { confirmedPairs } = await removeAndVerifyAcrossLocales(
      gateway,
      PRODUCT_ID,
      ["title", "body_html"],
      ["de", "fr"],
      "",
    );

    expect(confirmedPairs.has(`de${LOCALE_KEY_SEP}title`)).toBe(true);
    expect(confirmedPairs.has(`fr${LOCALE_KEY_SEP}body_html`)).toBe(true);
    // Not echoed → not confirmed → the caller keeps those local rows.
    expect(confirmedPairs.has(`fr${LOCALE_KEY_SEP}title`)).toBe(false);
    expect(confirmedPairs.has(`de${LOCALE_KEY_SEP}body_html`)).toBe(false);
    // The REMOVAL is still one call for all locales — that is the point of
    // this function and it has not changed. The extra calls are the re-reads
    // an unechoed pair now triggers, one per locale that has a gap, and here
    // they answer with nothing usable so nothing extra is confirmed.
    const removals = calls.filter((c) => c.variables?.translationKeys !== undefined);
    expect(removals).toHaveLength(1);
    expect(removals[0].variables?.locales).toEqual(["de", "fr"]);
    expect(removals[0].variables?.marketIds).toBeNull();
  });

  it("no-ops without keys or locales (no Shopify call)", async () => {
    const { gateway, calls } = fakeGateway(() => ({
      data: { translationsRemove: { translations: [], userErrors: [] } },
    }));
    const a = await removeAndVerifyAcrossLocales(gateway, PRODUCT_ID, [], ["de"], "");
    const b = await removeAndVerifyAcrossLocales(gateway, PRODUCT_ID, ["title"], [], "");
    expect(a.confirmedPairs.size).toBe(0);
    expect(b.confirmedPairs.size).toBe(0);
    expect(calls).toHaveLength(0);
  });
});

describe("fetchDigestsForResource", () => {
  it("filters to the requested keys and skips null digests", async () => {
    const { gateway } = fakeGateway(() => ({
      data: {
        translatableResource: {
          translatableContent: [
            { key: "title", digest: "d1" },
            { key: "meta_title", digest: null },
            { key: "handle", digest: "d3" },
          ],
        },
      },
    }));
    const map = await fetchDigestsForResource(gateway, PRODUCT_ID, ["title", "meta_title"]);
    expect(map.get("title")).toBe("d1");
    expect(map.has("meta_title")).toBe(false);
    expect(map.has("handle")).toBe(false);
  });
});

// ─── applyBulkDiff foreign groups (the DB-mirror consequences) ─────────────

/** Fake admin for the REAL gateway path through applyBulkDiff — answers the
 * batched digest query and register/remove per test. */
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

function mockDb() {
  return {
    contentTranslation: {
      upsert: vi.fn(async (_args: unknown) => ({})),
      deleteMany: vi.fn(async (_args: unknown) => ({ count: 1 })),
    },
  };
}

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

function foreignEntry(columnId: string, value: string, marketId = ""): BulkDiffEntry {
  return { rowId: PRODUCT_ID, rowType: "product", locale: LOCALE, marketId, columnId, value };
}

describe("applyBulkDiff — foreign-locale groups (Plan §6)", () => {
  it("mirrors ONLY echo-confirmed keys into ContentTranslation; the dropped key becomes a cell failure", async () => {
    // THE test of this phase (Plan §12): Shopify answers without userErrors
    // but echoes only 2 of 3 keys ⇒ exactly 2 DB rows, third cell fails.
    const { admin } = mockAdmin((query, variables) => {
      if (query.includes("bulkEditorBatchDigests")) {
        return batchDigestResponse(variables, {
          title: "d-title",
          body_html: "d-body",
          meta_description: "d-meta",
        });
      }
      if (query.includes("translationsRegister")) {
        return {
          data: {
            translationsRegister: {
              translations: [
                { key: "title", locale: LOCALE, value: "Titre", market: null },
                { key: "body_html", locale: LOCALE, value: "<p>Corps</p>", market: null },
              ],
              userErrors: [],
            },
          },
        };
      }
      throw new Error(`Unexpected query: ${query.slice(0, 80)}`);
    });
    const db = mockDb();

    const result = await applyBulkDiff(
      { db: db as never, shop: SHOP, admin: admin as never, columnsByType: columnsByType() },
      [
        foreignEntry("field.title", "Titre"),
        foreignEntry("field.descriptionHtml", "<p>Corps</p>"),
        foreignEntry("field.seoDescription", "Méta"),
      ],
    );

    expect(db.contentTranslation.upsert).toHaveBeenCalledTimes(2);
    const upsertedKeys = db.contentTranslation.upsert.mock.calls
      .map((c) => (c[0] as { create: { key: string } }).create.key)
      .sort();
    expect(upsertedKeys).toEqual(["body_html", "title"]);

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({
      rowId: PRODUCT_ID,
      columnId: "field.seoDescription",
      locale: LOCALE,
    });
    // A row with a failed cell does not count as fully saved.
    expect(result.saved).toBe(0);
  });

  it("scopes the DB mirror to the group's market and folds marketId into the register input", async () => {
    const MARKET = "gid://shopify/Market/7";
    let registerVars: Record<string, unknown> | undefined;
    const { admin } = mockAdmin((query, variables) => {
      if (query.includes("bulkEditorBatchDigests")) {
        return batchDigestResponse(variables, { title: "d-title" });
      }
      if (query.includes("translationsRegister")) {
        registerVars = variables;
        return {
          data: {
            translationsRegister: {
              translations: [{ key: "title", locale: LOCALE, value: "Titre", market: { id: MARKET } }],
              userErrors: [],
            },
          },
        };
      }
      throw new Error("unexpected");
    });
    const db = mockDb();

    const result = await applyBulkDiff(
      { db: db as never, shop: SHOP, admin: admin as never, columnsByType: columnsByType() },
      [foreignEntry("field.title", "Titre", MARKET)],
    );

    expect(result.failures).toEqual([]);
    expect(result.saved).toBe(1);
    const inputs = registerVars?.translations as { marketId?: string }[];
    expect(inputs[0].marketId).toBe(MARKET);
    const upsert = db.contentTranslation.upsert.mock.calls[0][0] as {
      where: { shop_resourceId_key_locale_marketId: { marketId: string } };
      create: { marketId: string };
    };
    expect(upsert.where.shop_resourceId_key_locale_marketId.marketId).toBe(MARKET);
    expect(upsert.create.marketId).toBe(MARKET);
  });

  it("keeps the local row when translationsRemove does not confirm the removal", async () => {
    const { admin } = mockAdmin((query) => {
      if (query.includes("translationsRemove")) {
        // No userErrors, but nothing echoed — the silent-no-op remove.
        return { data: { translationsRemove: { translations: [], userErrors: [] } } };
      }
      throw new Error("unexpected");
    });
    const db = mockDb();

    const result = await applyBulkDiff(
      { db: db as never, shop: SHOP, admin: admin as never, columnsByType: columnsByType() },
      [foreignEntry("field.title", "")], // cleared cell → remove path
    );

    expect(db.contentTranslation.deleteMany).not.toHaveBeenCalled();
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].columnId).toBe("field.title");
  });

  it("deletes the local row when the removal IS confirmed", async () => {
    const { admin } = mockAdmin((query) => {
      if (query.includes("translationsRemove")) {
        return {
          data: {
            translationsRemove: {
              translations: [{ key: "title", locale: LOCALE }],
              userErrors: [],
            },
          },
        };
      }
      throw new Error("unexpected");
    });
    const db = mockDb();

    const result = await applyBulkDiff(
      { db: db as never, shop: SHOP, admin: admin as never, columnsByType: columnsByType() },
      [foreignEntry("field.title", "")],
    );

    expect(result.failures).toEqual([]);
    expect(db.contentTranslation.deleteMany).toHaveBeenCalledWith({
      where: { shop: SHOP, resourceId: PRODUCT_ID, key: "title", locale: LOCALE, marketId: "" },
    });
  });

  it("rejects a handle translation identical to the primary handle (duplicate-slug guard)", async () => {
    const { admin } = mockAdmin((query, variables) => {
      if (query.includes("bulkEditorBatchDigests")) {
        return batchDigestResponse(variables, { handle: "d-handle" });
      }
      throw new Error(`unexpected: ${query.slice(0, 60)}`);
    });
    const db = {
      ...mockDb(),
      product: { findUnique: vi.fn(async () => ({ handle: "summer-dress" })) },
    };

    const result = await applyBulkDiff(
      { db: db as never, shop: SHOP, admin: admin as never, columnsByType: columnsByType() },
      [foreignEntry("field.handle", "summer-dress")],
    );

    // No register attempted, no DB mirror — the cell fails with the guard.
    expect(db.contentTranslation.upsert).not.toHaveBeenCalled();
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].columnId).toBe("field.handle");
    expect(result.failures[0].message).toMatch(/identical to the primary handle/);
  });

  it("missing digest ⇒ ONE re-fetch ⇒ still missing ⇒ cell error, NO register, NO DB write (§6.3)", async () => {
    let refetches = 0;
    let registers = 0;
    const { admin } = mockAdmin((query, variables) => {
      if (query.includes("bulkEditorBatchDigests")) {
        // meta_description has no digest — the expected state for SEO fields
        // without a primary override (Plan §14 no. 6).
        return batchDigestResponse(variables, { title: "d-title" });
      }
      if (query.includes("bulkEditorTranslatableContent")) {
        refetches++;
        return {
          data: { translatableResource: { translatableContent: [{ key: "title", digest: "d-title" }] } },
        };
      }
      if (query.includes("translationsRegister")) {
        registers++;
        const sent = (variables?.translations ?? []) as { key: string; locale: string; value: string }[];
        return {
          data: {
            translationsRegister: {
              translations: sent.map((t) => ({ ...t, market: null })),
              userErrors: [],
            },
          },
        };
      }
      throw new Error("unexpected");
    });
    const db = mockDb();

    const result = await applyBulkDiff(
      { db: db as never, shop: SHOP, admin: admin as never, columnsByType: columnsByType() },
      [foreignEntry("field.seoDescription", "Méta"), foreignEntry("field.title", "Titre")],
    );

    expect(refetches).toBe(1); // exactly ONE re-fetch of the resource
    expect(registers).toBe(1); // title still registers — only the digestless cell fails
    expect(db.contentTranslation.upsert).toHaveBeenCalledTimes(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].columnId).toBe("field.seoDescription");
  });
});

// ─── estimateCalls (Plan §10.1/§12) ────────────────────────────────────────

describe("estimateCalls", () => {
  const productColumns = buildColumnsForType(
    "product",
    [
      { namespace: "custom", key: "material", type: "single_line_text_field" },
      { namespace: "custom", key: "care", type: "single_line_text_field" },
    ],
    fullCaps,
  );

  const primary = (columnId: string, value = "x"): BulkDiffEntry => ({
    rowId: PRODUCT_ID,
    rowType: "product",
    locale: "",
    marketId: "",
    columnId,
    value,
  });

  it("row with base + 2 metafields + 1 option + alt-text ⇒ 4 calls (§12)", () => {
    const diff = [
      primary("field.title"),
      primary("field.seoTitle"),
      primary(metafieldColumnId("custom", "material")),
      primary(metafieldColumnId("custom", "care")),
      primary(optionColumnId(1, "name")),
      primary(IMG_ALT_COLUMN_ID),
    ];
    expect(estimateCalls(diff, productColumns)).toBe(4);
  });

  it("counts a metafieldsDelete for cleared metafield cells separately from the set chunk", () => {
    const diff = [
      primary(metafieldColumnId("custom", "material"), "Linen"),
      primary(metafieldColumnId("custom", "care"), ""), // clear → delete call
    ];
    expect(estimateCalls(diff, productColumns)).toBe(2);
  });

  it("foreign group: register + remove + one digest batch", () => {
    const diff = [
      foreignEntry("field.title", "Titre"),
      foreignEntry("field.descriptionHtml", "<p>Corps</p>"),
      foreignEntry("field.handle", ""), // clear
    ];
    // 1 register + 1 remove + 1 digest batch.
    expect(estimateCalls(diff, productColumns)).toBe(3);
  });

  it("digest batches scale with unique foreign resources at DIGEST_BATCH_CHUNK", () => {
    const diff: BulkDiffEntry[] = Array.from({ length: DIGEST_BATCH_CHUNK + 1 }, (_, i) => ({
      rowId: `gid://shopify/Product/${i + 1}`,
      rowType: "product" as const,
      locale: LOCALE,
      marketId: "",
      columnId: "field.title",
      value: "Titre",
    }));
    // 51 registers + 2 digest batches.
    expect(estimateCalls(diff, productColumns)).toBe(DIGEST_BATCH_CHUNK + 1 + 2);
  });

  it("non-product primary rows stay one call each", () => {
    const diff: BulkDiffEntry[] = [
      { rowId: "gid://shopify/Page/1", rowType: "page", locale: "", marketId: "", columnId: "field.title", value: "x" },
      { rowId: "gid://shopify/Page/1", rowType: "page", locale: "", marketId: "", columnId: "field.body", value: "y" },
      { rowId: "gid://shopify/Page/2", rowType: "page", locale: "", marketId: "", columnId: "field.title", value: "z" },
    ];
    expect(estimateCalls(diff, BULK_COLUMNS_BY_TYPE.page)).toBe(2);
  });
});

/**
 * §3.3, foreign half — a TRANSLATED handle is a real storefront URL, and
 * editing it in the grid breaks that URL exactly as a primary rename does.
 *
 * The measurement behind it (see handle-redirect.shared.ts) says one UNPREFIXED
 * row covers every locale, which is what these tests check for: the write path
 * must not invent a `/fr/` row, and it must not fire at all in the case that
 * looks the most like a rename but is not one — a translation being FILLED,
 * which is every row bulk-translate ever writes.
 */
describe("applyBulkDiff — redirect on a TRANSLATED handle change", () => {
  const HANDLE_COL = "field.handle";

  /** The db double plus the two reads the capture makes. `handleRows` is what
   *  ContentTranslation holds for this product before the write. */
  function redirectDb(handleRows: Array<{ locale: string; value: string }>) {
    return {
      ...mockDb(),
      contentTranslation: {
        upsert: vi.fn(async (_args: unknown) => ({})),
        deleteMany: vi.fn(async (_args: unknown) => ({ count: 1 })),
        findMany: vi.fn(async (_args: unknown) => handleRows),
        findFirst: vi.fn(async (_args: unknown): Promise<{ id: string } | null> => null),
      },
      product: {
        findUnique: vi.fn(async (_args: unknown) => ({ handle: "kumikobox", status: "ACTIVE" })),
        // The cross-resource collision check: no OTHER product answers the old
        // translated handle as its primary one.
        findFirst: vi.fn(async (_args: unknown): Promise<{ id: string } | null> => null),
      },
      aISettings: { findUnique: vi.fn(async (_args: unknown) => ({ seoAutoHandleRedirect: true })) },
    };
  }

  /** Responds to the digest + register calls and records redirect mutations. */
  function redirectAdmin(created: Array<Record<string, unknown>>) {
    return mockAdmin((query, variables) => {
      if (query.includes("bulkEditorBatchDigests")) return batchDigestResponse(variables, { handle: "d-handle" });
      if (query.includes("translationsRegister")) {
        return {
          data: {
            translationsRegister: {
              translations: [{ key: "handle", locale: LOCALE, value: "boite-neuve", market: null }],
              userErrors: [],
            },
          },
        };
      }
      if (query.includes("urlRedirects")) {
        return { data: { urlRedirects: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } } } };
      }
      if (query.includes("urlRedirectCreate")) {
        created.push((variables?.urlRedirect as Record<string, unknown>) ?? {});
        return {
          data: { urlRedirectCreate: { urlRedirect: { id: "gid://shopify/UrlRedirect/1" }, userErrors: [] } },
        };
      }
      throw new Error(`Unexpected query: ${query.slice(0, 80)}`);
    });
  }

  it("redirects the OLD translated URL to the new one, with no locale prefix", async () => {
    const created: Array<Record<string, unknown>> = [];
    const { admin } = redirectAdmin(created);
    const db = redirectDb([{ locale: LOCALE, value: "boite-ancienne" }]);

    const result = await applyBulkDiff(
      { db: db as never, shop: SHOP, admin: admin as never, columnsByType: columnsByType() },
      [foreignEntry(HANDLE_COL, "boite-neuve")],
    );

    expect(result.failures).toHaveLength(0);
    expect(created).toEqual([{ path: "/products/boite-ancienne", target: "/products/boite-neuve" }]);
  });

  it("creates NOTHING when the translation is being filled for the first time", async () => {
    // Every row bulk-translate writes. The locale was served under the PRIMARY
    // handle, which stays live — nothing broke, and a redirect here would sit
    // on the shop's own primary product URL.
    const created: Array<Record<string, unknown>> = [];
    const { admin } = redirectAdmin(created);
    const db = redirectDb([]);

    await applyBulkDiff(
      { db: db as never, shop: SHOP, admin: admin as never, columnsByType: columnsByType() },
      [foreignEntry(HANDLE_COL, "boite-neuve")],
    );

    expect(created).toEqual([]);
  });

  it("creates nothing when Shopify did not echo the handle back", async () => {
    // The echo rule reaches the redirect too: an unconfirmed write leaves the
    // OLD translated handle in place, so its URL is not dead.
    const created: Array<Record<string, unknown>> = [];
    const { admin } = mockAdmin((query, variables) => {
      if (query.includes("bulkEditorBatchDigests")) return batchDigestResponse(variables, { handle: "d-handle" });
      if (query.includes("translationsRegister")) {
        return { data: { translationsRegister: { translations: [], userErrors: [] } } };
      }
      if (query.includes("urlRedirectCreate")) {
        created.push((variables?.urlRedirect as Record<string, unknown>) ?? {});
        return { data: { urlRedirectCreate: { urlRedirect: null, userErrors: [] } } };
      }
      if (query.includes("urlRedirects")) {
        return { data: { urlRedirects: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } } } };
      }
      throw new Error(`Unexpected query: ${query.slice(0, 80)}`);
    });
    const db = redirectDb([{ locale: LOCALE, value: "boite-ancienne" }]);

    const result = await applyBulkDiff(
      { db: db as never, shop: SHOP, admin: admin as never, columnsByType: columnsByType() },
      [foreignEntry(HANDLE_COL, "boite-neuve")],
    );

    expect(result.failures).toHaveLength(1);
    expect(created).toEqual([]);
  });

  it("sends a CLEARED handle translation back to the primary handle", async () => {
    const created: Array<Record<string, unknown>> = [];
    const { admin } = mockAdmin((query, variables) => {
      if (query.includes("bulkEditorBatchDigests")) return batchDigestResponse(variables, { handle: "d-handle" });
      if (query.includes("translationsRemove")) {
        return {
          data: {
            translationsRemove: {
              translations: [{ key: "handle", locale: LOCALE, value: null, market: null }],
              userErrors: [],
            },
          },
        };
      }
      if (query.includes("urlRedirects")) {
        return { data: { urlRedirects: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } } } };
      }
      if (query.includes("urlRedirectCreate")) {
        created.push((variables?.urlRedirect as Record<string, unknown>) ?? {});
        return {
          data: { urlRedirectCreate: { urlRedirect: { id: "gid://shopify/UrlRedirect/1" }, userErrors: [] } },
        };
      }
      throw new Error(`Unexpected query: ${query.slice(0, 80)}`);
    });
    const db = redirectDb([{ locale: LOCALE, value: "boite-ancienne" }]);

    await applyBulkDiff(
      { db: db as never, shop: SHOP, admin: admin as never, columnsByType: columnsByType() },
      [foreignEntry(HANDLE_COL, "")],
    );

    // Without the translation the locale is served under the primary handle
    // again — the only address the dead URL can point at.
    expect(created).toEqual([{ path: "/products/boite-ancienne", target: "/products/kumikobox" }]);
  });

  it("refuses when another product already answers the old handle", async () => {
    // The collision the primary path cannot have: Shopify enforces uniqueness
    // among PRIMARY handles, so a renamed-away one is free — a translated one
    // can be another product's live address, and the row would 301 it away in
    // every locale, permanently.
    const created: Array<Record<string, unknown>> = [];
    const { admin } = redirectAdmin(created);
    const db = redirectDb([{ locale: LOCALE, value: "boite-ancienne" }]);
    db.product.findFirst = vi.fn(async (_args: unknown) => ({ id: "gid://shopify/Product/2" }));

    await applyBulkDiff(
      { db: db as never, shop: SHOP, admin: admin as never, columnsByType: columnsByType() },
      [foreignEntry(HANDLE_COL, "boite-neuve")],
    );

    expect(created).toEqual([]);
  });

  it("builds the redirect from the value Shopify ECHOED, not the one sent", async () => {
    // The repo's echo rule reaches the target, not just the decision to act:
    // this column is not slug-sanitised, so what Shopify stores is the only
    // honest basis for a URL. The DB mirror follows the same value.
    const created: Array<Record<string, unknown>> = [];
    const { admin } = mockAdmin((query, variables) => {
      if (query.includes("bulkEditorBatchDigests")) return batchDigestResponse(variables, { handle: "d-handle" });
      if (query.includes("translationsRegister")) {
        return {
          data: {
            translationsRegister: {
              translations: [{ key: "handle", locale: LOCALE, value: "boite-neuve", market: null }],
              userErrors: [],
            },
          },
        };
      }
      if (query.includes("urlRedirects")) {
        return { data: { urlRedirects: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } } } };
      }
      if (query.includes("urlRedirectCreate")) {
        created.push((variables?.urlRedirect as Record<string, unknown>) ?? {});
        return {
          data: { urlRedirectCreate: { urlRedirect: { id: "gid://shopify/UrlRedirect/1" }, userErrors: [] } },
        };
      }
      throw new Error(`Unexpected query: ${query.slice(0, 80)}`);
    });
    const db = redirectDb([{ locale: LOCALE, value: "boite-ancienne" }]);

    await applyBulkDiff(
      { db: db as never, shop: SHOP, admin: admin as never, columnsByType: columnsByType() },
      // What the merchant typed differs from what Shopify stored.
      [foreignEntry(HANDLE_COL, "Boite Neuve")],
    );

    expect(created).toEqual([{ path: "/products/boite-ancienne", target: "/products/boite-neuve" }]);
    expect(db.contentTranslation.upsert.mock.calls[0][0]).toMatchObject({
      create: { value: "boite-neuve" },
    });
  });

  it("leaves a market-scoped translation alone", async () => {
    // A redirect row is shop-wide; a market override is not.
    const created: Array<Record<string, unknown>> = [];
    const { admin } = redirectAdmin(created);
    const db = redirectDb([{ locale: LOCALE, value: "boite-ancienne" }]);

    await applyBulkDiff(
      { db: db as never, shop: SHOP, admin: admin as never, columnsByType: columnsByType() },
      [foreignEntry(HANDLE_COL, "boite-neuve", "gid://shopify/Market/7")],
    );

    expect(created).toEqual([]);
    // Not even the lookup: the market case is refused before the reads.
    expect(db.contentTranslation.findMany).not.toHaveBeenCalled();
  });
});
