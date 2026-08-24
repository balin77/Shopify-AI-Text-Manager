import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  collectBulkRepair,
  newBulkRepairPlan,
  MAX_REPAIR_GROUPS,
} from "~/services/bulk-editor/retranslate.server";
import {
  altTextLockId,
  subResourceLockId,
} from "~/services/translations/translation-locks.shared";

/**
 * Auto-translation in the bulk editor (retranslate.server.ts).
 *
 * The question every test here asks is the same one the merchant asks: with
 * "translate again when the primary text changes" on, does a bulk save REFRESH
 * the foreign values or DELETE them — and does it start one background run per
 * merchant action or one per cell.
 */

const SHOP = "test-shop.myshopify.com";
const PRODUCT_ID = "gid://shopify/Product/1";
const LOCALE = "fr";

// ─── The plan itself (pure) ────────────────────────────────────────────────

describe("collectBulkRepair", () => {
  it("folds every entry of one (row, surface) into ONE group and dedupes", () => {
    const plan = newBulkRepairPlan();
    const ok1 = collectBulkRepair(plan, {
      surface: "subResource",
      ownerId: PRODUCT_ID,
      rowType: "product",
      entries: [{ resourceId: "gid://shopify/Metafield/1", resourceType: "Metafield", key: "value" }],
    });
    const ok2 = collectBulkRepair(plan, {
      surface: "subResource",
      ownerId: PRODUCT_ID,
      rowType: "product",
      entries: [
        // the same one again (a cell written twice in one diff)…
        { resourceId: "gid://shopify/Metafield/1", resourceType: "Metafield", key: "value" },
        // …and a second resource under the same product
        { resourceId: "gid://shopify/ProductOption/1", resourceType: "ProductOption", key: "name" },
      ],
    });

    expect(ok1 && ok2).toBe(true);
    expect(plan.groups.size).toBe(1);
    expect([...plan.groups.values()][0].entries).toHaveLength(2);
  });

  it("keeps the surfaces of one row apart — they have different locks and mirrors", () => {
    const plan = newBulkRepairPlan();
    collectBulkRepair(plan, {
      surface: "content",
      ownerId: "gid://shopify/Page/9",
      rowType: "page",
      entries: [{ resourceId: "gid://shopify/Page/9", resourceType: "Page", key: "title" }],
    });
    collectBulkRepair(plan, {
      surface: "subResource",
      ownerId: PRODUCT_ID,
      rowType: "product",
      entries: [{ resourceId: "gid://shopify/Metafield/1", resourceType: "Metafield", key: "value" }],
    });
    expect(plan.groups.size).toBe(2);
  });

  it("collects a product's own CONTENT like every other surface", () => {
    // It waited in a pool of its own for one release, on the argument that the
    // `products/update` webhook repairs it. That webhook proves a change from
    // digests stored on TRANSLATION ROWS, so a product nobody has translated
    // yet carries no baseline and its webhook can prove nothing — forever,
    // which is exactly the row a merchant switches the feature on for. The
    // repair claims the row instead, and the webhook stands down on that.
    const plan = newBulkRepairPlan();
    collectBulkRepair(plan, {
      surface: "content",
      ownerId: PRODUCT_ID,
      rowType: "product",
      entries: [{ resourceId: PRODUCT_ID, resourceType: "Product", key: "title" }],
    });
    expect(plan.groups.size).toBe(1);
  });

  it("refuses a NEW group past the cap and counts the overflow — an existing one still grows", () => {
    const plan = newBulkRepairPlan();
    for (let i = 0; i < MAX_REPAIR_GROUPS; i++) {
      const accepted = collectBulkRepair(plan, {
        surface: "content",
        ownerId: `gid://shopify/Page/${i}`,
        rowType: "page",
        entries: [{ resourceId: `gid://shopify/Page/${i}`, resourceType: "Page", key: "title" }],
      });
      expect(accepted).toBe(true);
    }
    // One more ROW is refused: the caller falls back to its own purge, which
    // is exactly what this surface did before auto-translate reached it.
    expect(
      collectBulkRepair(plan, {
        surface: "content",
        ownerId: "gid://shopify/Page/over",
        rowType: "page",
        entries: [{ resourceId: "gid://shopify/Page/over", resourceType: "Page", key: "title" }],
      }),
    ).toBe(false);
    expect(plan.overflow.size).toBe(1);
    // …but a second key on a row already in the plan costs no extra run.
    expect(
      collectBulkRepair(plan, {
        surface: "content",
        ownerId: "gid://shopify/Page/0",
        rowType: "page",
        entries: [{ resourceId: "gid://shopify/Page/0", resourceType: "Page", key: "body_html" }],
      }),
    ).toBe(true);
    expect(plan.groups.size).toBe(MAX_REPAIR_GROUPS);
    expect(plan.overflow.size).toBe(1);
  });

  it("lets a DELETION-fallback group displace a product's content group at the cap", () => {
    // The pool fills in persist order — base fields first, sub-resources and
    // alt texts after — so without this rule thirteen rows that each changed a
    // title and a metafield spent every slot on content groups and had their
    // METAFIELD translations deleted from row thirteen on. A refused content
    // group of a product loses nothing (its deletion answer is
    // `purgeOnPrimaryChange`, which auto-translate forces off); a refused
    // sub-resource group is DELETED.
    const plan = newBulkRepairPlan();
    for (let i = 0; i < MAX_REPAIR_GROUPS; i++) {
      const id = `gid://shopify/Product/${i}`;
      expect(
        collectBulkRepair(plan, {
          surface: "content",
          ownerId: id,
          rowType: "product",
          entries: [{ resourceId: id, resourceType: "Product", key: "title" }],
        }),
      ).toBe(true);
    }
    // The pool is full of free-to-refuse groups; the expensive one still gets in.
    expect(
      collectBulkRepair(plan, {
        surface: "subResource",
        ownerId: PRODUCT_ID,
        rowType: "product",
        entries: [{ resourceId: "gid://shopify/Metafield/1", resourceType: "Metafield", key: "value" }],
      }),
    ).toBe(true);
    expect(plan.groups.size).toBe(MAX_REPAIR_GROUPS);
    expect([...plan.groups.values()].some((g) => g.surface === "subResource")).toBe(true);
    // …and the displaced one is REPORTED, never silently dropped.
    expect(plan.overflow.size).toBe(1);
    expect(plan.overflowRows.size).toBe(1);
  });

  it("does NOT displace a page's content group — refusing that one deletes too", () => {
    // A webhook-less type's content follows the merchant's stored deletion
    // answer when it is refused, so it is not free to refuse.
    const plan = newBulkRepairPlan();
    for (let i = 0; i < MAX_REPAIR_GROUPS; i++) {
      const id = `gid://shopify/Page/${i}`;
      collectBulkRepair(plan, {
        surface: "content",
        ownerId: id,
        rowType: "page",
        entries: [{ resourceId: id, resourceType: "Page", key: "title" }],
      });
    }
    expect(
      collectBulkRepair(plan, {
        surface: "subResource",
        ownerId: PRODUCT_ID,
        rowType: "product",
        entries: [{ resourceId: "gid://shopify/Metafield/1", resourceType: "Metafield", key: "value" }],
      }),
    ).toBe(false);
    expect(plan.groups.size).toBe(MAX_REPAIR_GROUPS);
  });

  it("records nothing for an empty entry list", () => {
    const plan = newBulkRepairPlan();
    expect(
      collectBulkRepair(plan, { surface: "content", ownerId: PRODUCT_ID, rowType: "product", entries: [] }),
    ).toBe(false);
    expect(plan.groups.size).toBe(0);
    expect(plan.overflow.size).toBe(0);
  });
});

// ─── Through applyBulkDiff ────────────────────────────────────────────────

/** What the (mocked) repair reports back — `retranslating: 0` is the real
 *  answer whenever nothing was left to translate, and the save must then NOT
 *  tell the merchant to look in the Tasks tab. */
let reconcileResult = { removed: 0, retranslating: 2 };
const reconcileAfterPrimarySave = vi.fn(async (_params: Record<string, unknown>) => reconcileResult);

/** What the flush's mirror pre-check finds. `[]` = this surface holds no
 *  foreign translation, so the group is skipped before any Shopify call. */
let mirrorRows: unknown[] = [{ resourceId: "x", locale: LOCALE, key: "value" }];
const fakeMirror = (kind: string) => ({ kind, existing: async () => mirrorRows });

vi.mock("~/services/translations/stale-translation-sync.server", () => ({
  reconcileAfterPrimarySave: (params: Record<string, unknown>) => reconcileAfterPrimarySave(params),
  contentTranslationMirror: () => fakeMirror("content"),
  metaobjectTranslationMirror: () => fakeMirror("metaobject"),
  productImageAltMirror: () => fakeMirror("productImageAlt"),
  featuredImageAltMirror: () => fakeMirror("featuredAlt"),
}));

const policy: {
  purgeOnPrimaryChange: boolean;
  purgeUnreconciledSurfaces: boolean;
  autoTranslateExternalChanges: boolean;
  plan: "max";
} = {
  purgeOnPrimaryChange: false,
  purgeUnreconciledSurfaces: true,
  autoTranslateExternalChanges: true,
  plan: "max",
};

vi.mock("~/services/translations/translation-change-policy.server", () => ({
  loadTranslationChangePolicy: async () => policy,
}));

const { applyBulkDiff } = await import("~/services/bulk-editor/apply.server");
const { buildColumnsForType, BULK_COLUMNS_BY_TYPE, metafieldColumnId, IMAGE_ROW_ALT_COLUMN_ID } = await import(
  "~/services/bulk-editor/columns.shared"
);
type BulkRowType = import("~/services/bulk-editor/columns.shared").BulkRowType;
type ColumnDescriptor = import("~/services/bulk-editor/columns.shared").ColumnDescriptor;
type BulkDiffEntry = import("~/services/bulk-editor/columns.shared").BulkDiffEntry;

function columnsFor(metafields: { namespace: string; key: string; type: string }[]) {
  return {
    ...BULK_COLUMNS_BY_TYPE,
    product: buildColumnsForType("product", metafields, {
      metafields: true,
      options: true,
      imageAlt: true,
    }),
  } as Record<BulkRowType, ColumnDescriptor[]>;
}

function mockAdmin(respond: (query: string, variables: Record<string, unknown> | undefined) => unknown) {
  const calls: { query: string; variables: Record<string, unknown> | undefined }[] = [];
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
    product: {
      findUnique: vi.fn(async () => ({})),
      update: vi.fn(async () => ({})),
      // The Task row is named after the row, not after its GID.
      findMany: vi.fn(async () => [{ id: PRODUCT_ID, title: "Kumiko-Box" }]),
    },
    productMetafield: { upsert: vi.fn(async () => ({})), deleteMany: vi.fn(async () => ({ count: 0 })), findMany: vi.fn(async () => []) },
    productOption: { findMany: vi.fn(async () => []) },
    contentTranslation: {
      findMany: vi.fn(async () => [{ key: "value", locale: LOCALE }]),
      deleteMany: vi.fn(async () => ({ count: 1 })),
      upsert: vi.fn(async () => ({})),
    },
  };
}

beforeEach(() => {
  reconcileAfterPrimarySave.mockClear();
  mirrorRows = [{ resourceId: "x", locale: LOCALE, key: "value" }];
  policy.purgeUnreconciledSurfaces = true;
  reconcileResult = { removed: 0, retranslating: 2 };
});

describe("applyBulkDiff with auto-translate on", () => {
  it("a changed metafield is REPAIRED under the product's sub-resource lock, not deleted", async () => {
    const { admin, calls } = mockAdmin((query, variables) => {
      if (query.includes("metafieldsSet(")) {
        const inputs = (variables?.metafields ?? []) as { namespace: string; key: string; value: string; type: string }[];
        return {
          data: {
            metafieldsSet: {
              metafields: inputs.map((m) => ({
                id: "gid://shopify/Metafield/1",
                namespace: m.namespace,
                key: m.key,
                value: m.value,
                type: m.type,
              })),
              userErrors: [],
            },
          },
        };
      }
      throw new Error(`Unexpected query: ${query.slice(0, 60)}`);
    });

    const result = await applyBulkDiff(
      {
        db: mockDb() as never,
        shop: SHOP,
        admin: admin as never,
        columnsByType: columnsFor([{ namespace: "custom", key: "care", type: "single_line_text_field" }]),
        foreignLocales: [LOCALE],
        primaryLocale: "de",
        autoHandleRedirect: false,
      },
      [
        {
          rowId: PRODUCT_ID,
          rowType: "product",
          locale: "",
          marketId: "",
          columnId: metafieldColumnId("custom", "care"),
          value: "Seide",
        } as BulkDiffEntry,
      ],
    );

    expect(result.failures).toEqual([]);
    // NOT deleted: no removal ever reached Shopify.
    expect(calls.some((c) => c.query.includes("translationsRemove"))).toBe(false);
    expect(reconcileAfterPrimarySave).toHaveBeenCalledTimes(1);
    const call = reconcileAfterPrimarySave.mock.calls[0][0];
    expect(call).toMatchObject({
      shop: SHOP,
      resourceId: PRODUCT_ID,
      lockId: subResourceLockId(PRODUCT_ID),
      contentKind: "product",
      resourceTitle: "Kumiko-Box",
      translateAs: { kind: "values", sourceLocale: "de" },
    });
    expect(call.changed).toEqual([
      {
        resourceId: "gid://shopify/Metafield/1",
        resourceType: "Metafield",
        key: "value",
        // single-line text survives the generic value prompt
        retranslatable: true,
      },
    ]);
  });

  it("a rich-text metafield is marked NOT retranslatable — the prompt would corrupt it", async () => {
    const { admin } = mockAdmin((query, variables) => {
      if (query.includes("metafieldsSet(")) {
        const inputs = (variables?.metafields ?? []) as { namespace: string; key: string; value: string; type: string }[];
        return {
          data: {
            metafieldsSet: {
              metafields: inputs.map((m) => ({
                id: "gid://shopify/Metafield/2",
                namespace: m.namespace,
                key: m.key,
                value: m.value,
                type: m.type,
              })),
              userErrors: [],
            },
          },
        };
      }
      throw new Error(`Unexpected query: ${query.slice(0, 60)}`);
    });

    await applyBulkDiff(
      {
        db: mockDb() as never,
        shop: SHOP,
        admin: admin as never,
        columnsByType: columnsFor([{ namespace: "custom", key: "story", type: "multi_line_text_field" }]),
        foreignLocales: [LOCALE],
        primaryLocale: "de",
        autoHandleRedirect: false,
      },
      [
        {
          rowId: PRODUCT_ID,
          rowType: "product",
          locale: "",
          marketId: "",
          columnId: metafieldColumnId("custom", "story"),
          value: "Zeile 1",
        } as BulkDiffEntry,
      ],
    );

    const call = reconcileAfterPrimarySave.mock.calls[0][0] as unknown as {
      changed: { retranslatable: boolean }[];
    };
    expect(call.changed[0].retranslatable).toBe(false);
  });

  it("repairs a surface whose mirror is EMPTY — the first translation is a translation too", async () => {
    // This used to be skipped: one mirror query, no rows, no repair, which kept
    // the reach where the deletion it replaced had it. It is also exactly why a
    // merchant with empty translations saw nothing happen on every primary
    // edit, so the pre-check is gone and the fill writes the first one.
    mirrorRows = [];
    const { admin } = mockAdmin((query, variables) => {
      if (query.includes("metafieldsSet(")) {
        const inputs = (variables?.metafields ?? []) as { namespace: string; key: string; value: string; type: string }[];
        return {
          data: {
            metafieldsSet: {
              metafields: inputs.map((m) => ({
                id: "gid://shopify/Metafield/1",
                namespace: m.namespace,
                key: m.key,
                value: m.value,
                type: m.type,
              })),
              userErrors: [],
            },
          },
        };
      }
      throw new Error(`Unexpected query: ${query.slice(0, 60)}`);
    });

    await applyBulkDiff(
      {
        db: mockDb() as never,
        shop: SHOP,
        admin: admin as never,
        columnsByType: columnsFor([{ namespace: "custom", key: "care", type: "single_line_text_field" }]),
        foreignLocales: [LOCALE],
        primaryLocale: "de",
        autoHandleRedirect: false,
      },
      [
        {
          rowId: PRODUCT_ID,
          rowType: "product",
          locale: "",
          marketId: "",
          columnId: metafieldColumnId("custom", "care"),
          value: "Seide",
        } as BulkDiffEntry,
      ],
    );

    expect(reconcileAfterPrimarySave).toHaveBeenCalledTimes(1);
  });

  it("hands the repair what THIS save wrote, so it cannot overwrite it", async () => {
    // The regression this exists for: the merchant changes a metafield's
    // primary value AND types its French translation in one save. The claim
    // makes the repair ours; without `alreadyWritten` that repair would then
    // machine-translate over the value they just typed.
    const { admin } = mockAdmin((query, variables) => {
      if (query.includes("metafieldsSet(")) {
        const inputs = (variables?.metafields ?? []) as { namespace: string; key: string; value: string; type: string }[];
        return {
          data: {
            metafieldsSet: {
              metafields: inputs.map((m) => ({
                id: "gid://shopify/Metafield/1",
                namespace: m.namespace,
                key: m.key,
                value: m.value,
                type: m.type,
              })),
              userErrors: [],
            },
          },
        };
      }
      if (query.includes("bulkEditorBatchDigests")) {
        const data: Record<string, unknown> = {};
        for (const name of Object.keys(variables ?? {})) {
          data[`a${name.slice(1)}`] = { translatableContent: [{ key: "value", digest: "d" }] };
        }
        return { data };
      }
      // The PRIMARY write of this same save drops the prefetched digest, so the
      // foreign half re-fetches it — that is the point of the ordering: the
      // translation is registered against the text that was just saved, not
      // against the one it replaced.
      if (query.includes("bulkEditorTranslatableContent")) {
        return { data: { translatableResource: { translatableContent: [{ key: "value", digest: "d2" }] } } };
      }
      if (query.includes("translationsRegister")) {
        return {
          data: {
            translationsRegister: {
              translations: [{ key: "value", locale: LOCALE, value: "Soie", market: null }],
              userErrors: [],
            },
          },
        };
      }
      throw new Error(`Unexpected query: ${query.slice(0, 60)}`);
    });
    const db = mockDb();
    (db as Record<string, unknown>).productMetafield = {
      upsert: vi.fn(async () => ({})),
      deleteMany: vi.fn(async () => ({ count: 0 })),
      findMany: vi.fn(async () => [
        { id: "gid://shopify/Metafield/1", productId: PRODUCT_ID, namespace: "custom", key: "care" },
      ]),
    };

    await applyBulkDiff(
      {
        db: db as never,
        shop: SHOP,
        admin: admin as never,
        columnsByType: columnsFor([{ namespace: "custom", key: "care", type: "single_line_text_field" }]),
        foreignLocales: [LOCALE],
        primaryLocale: "de",
        autoHandleRedirect: false,
      },
      [
        {
          rowId: PRODUCT_ID,
          rowType: "product",
          locale: "",
          marketId: "",
          columnId: metafieldColumnId("custom", "care"),
          value: "Seide",
        } as BulkDiffEntry,
        {
          rowId: PRODUCT_ID,
          rowType: "product",
          locale: LOCALE,
          marketId: "",
          columnId: metafieldColumnId("custom", "care"),
          value: "Soie",
        } as BulkDiffEntry,
      ],
    );

    expect(reconcileAfterPrimarySave).toHaveBeenCalledTimes(1);
    const call = reconcileAfterPrimarySave.mock.calls[0][0] as unknown as {
      alreadyWritten: { resourceId: string; locale: string; key: string }[];
    };
    expect(call.alreadyWritten).toContainEqual({
      resourceId: "gid://shopify/Metafield/1",
      locale: LOCALE,
      key: "value",
    });
  });

  it("reaches the alt-text surface even with the merchant's deletion switched OFF", async () => {
    // The image dispatch used to sit BEHIND the purge gate, so on a shop with
    // auto-translate on and the deletion off, alt texts got neither — the one
    // surface where the switch did nothing at all.
    policy.purgeUnreconciledSurfaces = false;
    const MEDIA = "gid://shopify/MediaImage/7";
    const { admin } = mockAdmin((query, variables) => {
      if (query.includes("productUpdateMedia(")) {
        const media = (variables?.media ?? []) as { id: string; alt?: string }[];
        return {
          data: {
            productUpdateMedia: {
              media: media.map((m) => ({ id: m.id, alt: m.alt ?? "" })),
              mediaUserErrors: [],
            },
          },
        };
      }
      throw new Error(`Unexpected query: ${query.slice(0, 60)}`);
    });
    const db = mockDb();
    (db as Record<string, unknown>).productImage = {
      findFirst: vi.fn(async () => ({ id: "img-row-1", productId: PRODUCT_ID, mediaId: MEDIA, position: 1 })),
      update: vi.fn(async () => ({})),
    };

    await applyBulkDiff(
      {
        db: db as never,
        shop: SHOP,
        admin: admin as never,
        columnsByType: columnsFor([]),
        foreignLocales: [LOCALE],
        primaryLocale: "de",
        autoHandleRedirect: false,
      },
      [
        {
          rowId: MEDIA,
          rowType: "image",
          locale: "",
          marketId: "",
          columnId: IMAGE_ROW_ALT_COLUMN_ID,
          value: "Blaue Vase",
        } as BulkDiffEntry,
      ],
    );

    expect(reconcileAfterPrimarySave).toHaveBeenCalledTimes(1);
    const call = reconcileAfterPrimarySave.mock.calls[0][0] as Record<string, unknown>;
    expect(call).toMatchObject({ resourceId: PRODUCT_ID, lockId: altTextLockId(PRODUCT_ID) });
  });

  it("does NOT record a MARKET write — that would silence the repair for the global row", async () => {
    // The global translation is still a translation of the old primary text.
    // Recording the market override put it in neither list: not re-translated
    // (skipped as "already written") and not removed (the purge stood down).
    const { admin } = mockAdmin((query, variables) => {
      if (query.includes("metafieldsSet(")) {
        const inputs = (variables?.metafields ?? []) as { namespace: string; key: string; value: string; type: string }[];
        return {
          data: {
            metafieldsSet: {
              metafields: inputs.map((m) => ({
                id: "gid://shopify/Metafield/1",
                namespace: m.namespace,
                key: m.key,
                value: m.value,
                type: m.type,
              })),
              userErrors: [],
            },
          },
        };
      }
      if (query.includes("bulkEditorBatchDigests")) {
        const data: Record<string, unknown> = {};
        for (const name of Object.keys(variables ?? {})) {
          data[`a${name.slice(1)}`] = { translatableContent: [{ key: "value", digest: "d" }] };
        }
        return { data };
      }
      // The PRIMARY write of this same save drops the prefetched digest, so the
      // foreign half re-fetches it — that is the point of the ordering: the
      // translation is registered against the text that was just saved, not
      // against the one it replaced.
      if (query.includes("bulkEditorTranslatableContent")) {
        return { data: { translatableResource: { translatableContent: [{ key: "value", digest: "d2" }] } } };
      }
      if (query.includes("translationsRegister")) {
        return {
          data: {
            translationsRegister: {
              translations: [
                { key: "value", locale: LOCALE, value: "Soie", market: { id: "gid://shopify/Market/3" } },
              ],
              userErrors: [],
            },
          },
        };
      }
      throw new Error(`Unexpected query: ${query.slice(0, 60)}`);
    });
    const db = mockDb();
    (db as Record<string, unknown>).productMetafield = {
      upsert: vi.fn(async () => ({})),
      deleteMany: vi.fn(async () => ({ count: 0 })),
      findMany: vi.fn(async () => [
        { id: "gid://shopify/Metafield/1", productId: PRODUCT_ID, namespace: "custom", key: "care" },
      ]),
    };

    await applyBulkDiff(
      {
        db: db as never,
        shop: SHOP,
        admin: admin as never,
        columnsByType: columnsFor([{ namespace: "custom", key: "care", type: "single_line_text_field" }]),
        foreignLocales: [LOCALE],
        primaryLocale: "de",
        autoHandleRedirect: false,
      },
      [
        {
          rowId: PRODUCT_ID,
          rowType: "product",
          locale: "",
          marketId: "",
          columnId: metafieldColumnId("custom", "care"),
          value: "Seide",
        } as BulkDiffEntry,
        {
          rowId: PRODUCT_ID,
          rowType: "product",
          locale: LOCALE,
          marketId: "gid://shopify/Market/3",
          columnId: metafieldColumnId("custom", "care"),
          value: "Soie",
        } as BulkDiffEntry,
      ],
    );

    const call = reconcileAfterPrimarySave.mock.calls[0][0] as unknown as {
      alreadyWritten: unknown[];
    };
    expect(call.alreadyWritten).toEqual([]);
  });

  it("reports TRANSLATIONS, and reports nothing when the repair took nothing on", async () => {
    reconcileResult = { removed: 1, retranslating: 0 };
    const { admin } = mockAdmin((query, variables) => {
      if (query.includes("metafieldsSet(")) {
        const inputs = (variables?.metafields ?? []) as { namespace: string; key: string; value: string; type: string }[];
        return {
          data: {
            metafieldsSet: {
              metafields: inputs.map((m) => ({
                id: "gid://shopify/Metafield/1",
                namespace: m.namespace,
                key: m.key,
                value: m.value,
                type: m.type,
              })),
              userErrors: [],
            },
          },
        };
      }
      throw new Error(`Unexpected query: ${query.slice(0, 60)}`);
    });
    const ctx = {
      db: mockDb() as never,
      shop: SHOP,
      admin: admin as never,
      columnsByType: columnsFor([{ namespace: "custom", key: "care", type: "single_line_text_field" }]),
      foreignLocales: [LOCALE],
      primaryLocale: "de",
      autoHandleRedirect: false,
    };
    const diff = [
      {
        rowId: PRODUCT_ID,
        rowType: "product",
        locale: "",
        marketId: "",
        columnId: metafieldColumnId("custom", "care"),
        value: "Seide",
      } as BulkDiffEntry,
    ];

    // The repair was CALLED but started no run: nothing to tell the merchant,
    // and above all no "follow the progress under Tasks" pointing at nothing.
    const quiet = await applyBulkDiff(ctx, diff);
    expect(reconcileAfterPrimarySave).toHaveBeenCalledTimes(1);
    expect(quiet.retranslation).toBeUndefined();

    reconcileResult = { removed: 0, retranslating: 4 };
    const loud = await applyBulkDiff(ctx, diff);
    expect(loud.retranslation).toMatchObject({ started: 1, translations: 4, capped: 0 });
  });

  it("repairs a product's OWN fields too — its webhook cannot prove anything on a row with no translations", async () => {
    const { admin } = mockAdmin((query) => {
      if (query.includes("productUpdate(")) {
        return { data: { productUpdate: { product: { id: PRODUCT_ID }, userErrors: [] } } };
      }
      throw new Error(`Unexpected query: ${query.slice(0, 60)}`);
    });

    await applyBulkDiff(
      {
        db: mockDb() as never,
        shop: SHOP,
        admin: admin as never,
        columnsByType: columnsFor([]),
        foreignLocales: [LOCALE],
        primaryLocale: "de",
        autoHandleRedirect: false,
      },
      [
        {
          rowId: PRODUCT_ID,
          rowType: "product",
          locale: "",
          marketId: "",
          columnId: "field.title",
          value: "Neuer Titel",
        } as BulkDiffEntry,
      ],
    );

    // The claim the repair makes when it starts is what keeps the
    // `products/update` webhook from running a second one.
    expect(reconcileAfterPrimarySave).toHaveBeenCalledTimes(1);
    const call = reconcileAfterPrimarySave.mock.calls[0][0] as unknown as {
      resourceType: string;
      lockId?: string;
      changed: { key: string }[];
    };
    expect(call.resourceType).toBe("Product");
    expect(call.changed.map((entry) => entry.key)).toEqual(["title"]);
    // No private lock: claiming the PRODUCT is the point here.
    expect(call.lockId).toBeUndefined();
  });
});
