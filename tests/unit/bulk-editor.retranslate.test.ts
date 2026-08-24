import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  collectBulkRepair,
  dropWebhookOwnedGroups,
  newBulkRepairPlan,
  MAX_REPAIR_GROUPS,
} from "~/services/bulk-editor/retranslate.server";
import { subResourceLockId } from "~/services/translations/translation-locks.shared";

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
      ownerId: PRODUCT_ID,
      rowType: "product",
      entries: [{ resourceId: PRODUCT_ID, resourceType: "Product", key: "title" }],
    });
    collectBulkRepair(plan, {
      surface: "subResource",
      ownerId: PRODUCT_ID,
      rowType: "product",
      entries: [{ resourceId: "gid://shopify/Metafield/1", resourceType: "Metafield", key: "value" }],
    });
    expect(plan.groups.size).toBe(2);
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
    expect(plan.overflow).toBe(1);
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
    expect(plan.overflow).toBe(1);
  });

  it("records nothing for an empty entry list", () => {
    const plan = newBulkRepairPlan();
    expect(
      collectBulkRepair(plan, { surface: "content", ownerId: PRODUCT_ID, rowType: "product", entries: [] }),
    ).toBe(false);
    expect(plan.groups.size).toBe(0);
    expect(plan.overflow).toBe(0);
  });
});

describe("dropWebhookOwnedGroups", () => {
  it("drops an UNCLAIMED product/collection content group — its webhook repairs it", () => {
    const plan = newBulkRepairPlan();
    collectBulkRepair(plan, {
      surface: "content",
      ownerId: PRODUCT_ID,
      rowType: "product",
      entries: [{ resourceId: PRODUCT_ID, resourceType: "Product", key: "title" }],
    });
    expect(dropWebhookOwnedGroups(plan)).toBe(1);
    expect(plan.groups.size).toBe(0);
  });

  it("KEEPS it when this save claimed the row — the claim is what makes the webhook bail", () => {
    const plan = newBulkRepairPlan();
    collectBulkRepair(plan, {
      surface: "content",
      ownerId: PRODUCT_ID,
      rowType: "product",
      entries: [{ resourceId: PRODUCT_ID, resourceType: "Product", key: "title" }],
    });
    plan.claimedRows.add(PRODUCT_ID);
    expect(dropWebhookOwnedGroups(plan)).toBe(0);
    expect(plan.groups.size).toBe(1);
  });

  it("never drops a surface the webhook cannot reach, claimed or not", () => {
    const plan = newBulkRepairPlan();
    collectBulkRepair(plan, {
      surface: "subResource",
      ownerId: PRODUCT_ID,
      rowType: "product",
      entries: [{ resourceId: "gid://shopify/Metafield/1", resourceType: "Metafield", key: "value" }],
    });
    collectBulkRepair(plan, {
      surface: "content",
      ownerId: "gid://shopify/Page/1",
      rowType: "page",
      entries: [{ resourceId: "gid://shopify/Page/1", resourceType: "Page", key: "title" }],
    });
    expect(dropWebhookOwnedGroups(plan)).toBe(0);
    expect(plan.groups.size).toBe(2);
  });
});

// ─── Through applyBulkDiff ────────────────────────────────────────────────

const reconcileAfterPrimarySave = vi.fn(async (_params: Record<string, unknown>) => ({}));

vi.mock("~/services/translations/stale-translation-sync.server", () => ({
  reconcileAfterPrimarySave: (params: Record<string, unknown>) => reconcileAfterPrimarySave(params),
  contentTranslationMirror: () => ({ kind: "content" }),
  metaobjectTranslationMirror: () => ({ kind: "metaobject" }),
  productImageAltMirror: () => ({ kind: "productImageAlt" }),
  featuredImageAltMirror: () => ({ kind: "featuredAlt" }),
}));

const policy = {
  purgeOnPrimaryChange: false,
  purgeUnreconciledSurfaces: true,
  autoTranslateExternalChanges: true,
  plan: "max" as const,
};

vi.mock("~/services/translations/translation-change-policy.server", () => ({
  loadTranslationChangePolicy: async () => policy,
}));

const { applyBulkDiff } = await import("~/services/bulk-editor/apply.server");
const { buildColumnsForType, BULK_COLUMNS_BY_TYPE, metafieldColumnId } = await import(
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

  it("a product's OWN fields start nothing — its update webhook runs that repair", async () => {
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

    expect(reconcileAfterPrimarySave).not.toHaveBeenCalled();
  });
});
