import { describe, it, expect } from "vitest";
import {
  MAX_TRANSLATE_UNITS,
  allSelectionState,
  countSelectedUnits,
  dedupeHandle,
  deselectAllPairs,
  initialTranslateSelection,
  isPairSelected,
  itemSelectionState,
  normalizeTranslatedHandle,
  parseTranslateSelection,
  selectAllPairs,
  serializeTranslateSelection,
  setItemSelected,
  setPairSelected,
  translatePairKey,
  type MissingItem,
} from "~/services/bulk-editor/translate-missing.shared";
import { translateCandidateColumns } from "~/services/bulk-editor/missing-translations.server";
import { buildJobs } from "~/routes/api-ai-handlers/bulk-editor-translate.handler";
import {
  buildColumnsForType,
  buildMetaobjectColumn,
  type ColumnDescriptor,
  type ProductColumnCaps,
} from "~/services/bulk-editor/columns.shared";

/**
 * "Translate missing" page: the selection model (the part the merchant's
 * clicks and the server's job list BOTH depend on) and the handle
 * normalization. Everything here is pure — the scan itself is DB-bound and
 * covered by the loader/handler in integration.
 */

const ALL_CAPS: ProductColumnCaps = { metafields: true, options: true, imageAlt: true };

const ITEM_A: MissingItem = {
  rowId: "gid://shopify/Product/1",
  title: "Silk scarf",
  subtitle: "silk-scarf",
  columns: [
    { columnId: "field.title", locales: ["de", "fr"] },
    { columnId: "field.seoTitle", locales: ["fr"] },
    { columnId: "field.handle", locales: ["de", "fr"] },
  ],
};

const ITEM_B: MissingItem = {
  rowId: "gid://shopify/Product/2",
  title: "Wool hat",
  subtitle: "wool-hat",
  columns: [{ columnId: "field.title", locales: ["de"] }],
};

/** Matches ITEM_A + ITEM_B. */
const UNITS_BY_COLUMN_LOCALE = {
  "field.title": { de: 2, fr: 1 },
  "field.seoTitle": { fr: 1 },
  "field.handle": { de: 1, fr: 1 },
};

function missingMap(...items: MissingItem[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const item of items) {
    for (const column of item.columns) {
      map.set(translatePairKey(item.rowId, column.columnId), column.locales);
    }
  }
  return map;
}

describe("translate-missing: selection defaults", () => {
  it("preselects every field EXCEPT the URL handle", () => {
    const selection = initialTranslateSelection();
    expect(isPairSelected(selection, ITEM_A.rowId, "field.title")).toBe(true);
    expect(isPairSelected(selection, ITEM_A.rowId, "field.seoTitle")).toBe(true);
    expect(isPairSelected(selection, ITEM_A.rowId, "field.handle")).toBe(false);
    // "everything except one column" is not "all" — the header must show it.
    expect(allSelectionState(selection)).toBe("indeterminate");
  });

  it("counts the default selection without the handle units", () => {
    const units = countSelectedUnits(
      initialTranslateSelection(),
      UNITS_BY_COLUMN_LOCALE,
      ["de", "fr"],
      missingMap(ITEM_A, ITEM_B),
    );
    // title 2+1, seoTitle 1 — handle (1+1) excluded.
    expect(units).toBe(4);
  });

  it("select-all takes the handle in, deselect-all empties everything", () => {
    const all = selectAllPairs();
    expect(allSelectionState(all)).toBe("checked");
    expect(isPairSelected(all, ITEM_A.rowId, "field.handle")).toBe(true);
    expect(countSelectedUnits(all, UNITS_BY_COLUMN_LOCALE, ["de", "fr"], missingMap(ITEM_A, ITEM_B))).toBe(6);

    const none = deselectAllPairs();
    expect(allSelectionState(none)).toBe("unchecked");
    expect(isPairSelected(none, ITEM_A.rowId, "field.title")).toBe(false);
    expect(countSelectedUnits(none, UNITS_BY_COLUMN_LOCALE, ["de", "fr"], missingMap(ITEM_A, ITEM_B))).toBe(0);
  });
});

describe("translate-missing: toggling", () => {
  it("deselecting one field subtracts exactly its units (all mode)", () => {
    const selection = setPairSelected(selectAllPairs(), ITEM_A.rowId, "field.title", false);
    const units = countSelectedUnits(selection, UNITS_BY_COLUMN_LOCALE, ["de", "fr"], missingMap(ITEM_A, ITEM_B));
    // 6 total minus item A's title (de + fr).
    expect(units).toBe(4);
  });

  it("selecting one field in 'none' mode adds exactly its units", () => {
    const selection = setPairSelected(deselectAllPairs(), ITEM_A.rowId, "field.handle", true);
    expect(
      countSelectedUnits(selection, UNITS_BY_COLUMN_LOCALE, ["de", "fr"], missingMap(ITEM_A, ITEM_B)),
    ).toBe(2);
    // Only the ACTIVE languages count.
    expect(countSelectedUnits(selection, UNITS_BY_COLUMN_LOCALE, ["fr"], missingMap(ITEM_A, ITEM_B))).toBe(1);
  });

  it("toggling a field back to its default drops the exception again", () => {
    const off = setPairSelected(selectAllPairs(), ITEM_A.rowId, "field.title", false);
    expect(off.exceptions.size).toBe(1);
    const on = setPairSelected(off, ITEM_A.rowId, "field.title", true);
    expect(on.exceptions.size).toBe(0);
  });

  it("the item checkbox owns every field below it", () => {
    const cleared = setItemSelected(initialTranslateSelection(), ITEM_A, false);
    expect(itemSelectionState(cleared, ITEM_A, ["de", "fr"])).toBe("unchecked");
    const full = setItemSelected(cleared, ITEM_A, true);
    expect(itemSelectionState(full, ITEM_A, ["de", "fr"])).toBe("checked");
    expect(isPairSelected(full, ITEM_A.rowId, "field.handle")).toBe(true);
  });

  it("an item with a partial selection reads as indeterminate", () => {
    // The default IS partial for item A: the handle is off.
    expect(itemSelectionState(initialTranslateSelection(), ITEM_A, ["de", "fr"])).toBe("indeterminate");
    // …but not for item B, which has no handle candidate.
    expect(itemSelectionState(initialTranslateSelection(), ITEM_B, ["de", "fr"])).toBe("checked");
  });

  it("fields missing only in a switched-off language don't affect the item state", () => {
    const item: MissingItem = {
      rowId: "gid://shopify/Product/3",
      title: "Linen shirt",
      subtitle: "",
      columns: [
        { columnId: "field.title", locales: ["de"] },
        { columnId: "field.seoTitle", locales: ["fr"] },
      ],
    };
    // seoTitle is deselected, but it is missing in "fr" only — with fr off it
    // is out of the run and must not keep the item indeterminate.
    const selection = setPairSelected(initialTranslateSelection(), item.rowId, "field.seoTitle", false);
    expect(itemSelectionState(selection, item, ["de", "fr"])).toBe("indeterminate");
    expect(itemSelectionState(selection, item, ["de"])).toBe("checked");
  });
});

describe("translate-missing: wire format", () => {
  it("round-trips a selection", () => {
    const selection = setPairSelected(initialTranslateSelection(), ITEM_A.rowId, "field.title", false);
    const parsed = parseTranslateSelection(serializeTranslateSelection(selection));
    expect(parsed.mode).toBe("all");
    expect(parsed.defaultOffColumnIds).toEqual(["field.handle"]);
    expect([...parsed.exceptions]).toEqual([translatePairKey(ITEM_A.rowId, "field.title")]);
  });

  it("collapses malformed payloads to 'nothing selected', never to 'everything'", () => {
    for (const raw of [null, undefined, "all", {}, { mode: "everything" }, { mode: 42 }]) {
      const parsed = parseTranslateSelection(raw);
      expect(parsed.mode).toBe("none");
      expect(parsed.exceptions.size).toBe(0);
    }
  });

  it("drops exception entries that are not pair keys", () => {
    const parsed = parseTranslateSelection({
      mode: "all",
      defaultOffColumnIds: [],
      exceptions: ["gid://shopify/Product/1|field.title", "nonsense", 7],
    });
    expect([...parsed.exceptions]).toEqual(["gid://shopify/Product/1|field.title"]);
  });
});

describe("translate-missing: handles", () => {
  it("normalizes an AI answer into a Shopify-legal slug", () => {
    expect(normalizeTranslatedHandle("Écharpe en Soie")).toBe("echarpe-en-soie");
    expect(normalizeTranslatedHandle("Grüne Bürostühle")).toBe("gruene-buerostuehle");
    expect(normalizeTranslatedHandle("  Strauß & Co.  ")).toBe("strauss-co");
    expect(normalizeTranslatedHandle("already-fine-123")).toBe("already-fine-123");
  });

  it("returns '' when nothing usable is left (never an empty-ish handle)", () => {
    expect(normalizeTranslatedHandle("！？")).toBe("");
    expect(normalizeTranslatedHandle("   ")).toBe("");
    expect(normalizeTranslatedHandle("")).toBe("");
  });

  it("suffixes duplicates within a run, like Shopify does", () => {
    const used = new Set<string>();
    expect(dedupeHandle("scarf", used)).toBe("scarf");
    expect(dedupeHandle("scarf", used)).toBe("scarf-2");
    expect(dedupeHandle("scarf", used)).toBe("scarf-3");
    expect(dedupeHandle("", used)).toBe("");
  });
});

describe("translate-missing: candidate columns", () => {
  it("offers the translatable field columns INCLUDING the handle", () => {
    const columns = translateCandidateColumns(buildColumnsForType("product", [], ALL_CAPS), "product", "");
    const ids = columns.map((c) => c.id);
    expect(ids).toContain("field.title");
    expect(ids).toContain("field.handle");
    expect(ids).toContain("field.seoDescription");
  });

  it("never offers columns the verified write path cannot translate", () => {
    const columns = translateCandidateColumns(
      buildColumnsForType("product", [{ namespace: "custom", key: "care", type: "single_line_text_field" }], ALL_CAPS),
      "product",
      "",
    );
    const ids = columns.map((c) => c.id);
    // Metafields/options/alt-texts translate on their OWN Shopify resource,
    // not on the product's translatableResource.
    expect(ids).not.toContain("mf.custom.care");
    expect(ids.some((id) => id.startsWith("opt."))).toBe(false);
    expect(ids).not.toContain("img.alt");
    // Never translatable at all.
    expect(ids).not.toContain("field.status");
  });

  it("keeps metaobject fields of the SELECTED definition type only, text types only", () => {
    const specs = [
      { type: "size_guide", fieldKey: "intro", fieldType: "multi_line_text_field", name: "Intro" },
      { type: "size_guide", fieldKey: "tags", fieldType: "list.single_line_text_field", name: "Tags" },
      { type: "other", fieldKey: "intro", fieldType: "single_line_text_field", name: "Intro" },
    ];
    const columns = translateCandidateColumns(
      [...buildColumnsForType("metaobject", [], ALL_CAPS, specs)],
      "metaobject",
      "size_guide",
    );
    expect(columns.map((c) => c.id)).toEqual(["mo.size_guide.intro"]);
  });
});

describe("translate-missing: job building", () => {
  const columns: ColumnDescriptor[] = buildColumnsForType("product", [], ALL_CAPS);
  const withSources = (item: MissingItem): MissingItem => ({
    ...item,
    primaryHandle: item.subtitle,
    columns: item.columns.map((c) => ({ ...c, source: `source of ${c.columnId}` })),
  });

  it("translates exactly what the selection says, in the requested languages", () => {
    const { jobs, units, overCap } = buildJobs(
      [withSources(ITEM_A), withSources(ITEM_B)],
      columns,
      initialTranslateSelection(),
      ["de", "fr"],
      "product",
    );
    expect(overCap).toBe(0);
    expect(units).toBe(4);
    expect(jobs).toHaveLength(2);
    expect(jobs[0].cells.map((c) => c.column.id)).toEqual(["field.title", "field.seoTitle"]);
    expect(jobs[0].primaryHandle).toBe("silk-scarf");
    // The AI payload key is the canonical field name, not the column id.
    expect(jobs[0].cells[0].fieldKey).toBe("title");
  });

  it("ignores locales the merchant switched off", () => {
    const { jobs, units } = buildJobs(
      [withSources(ITEM_A)],
      columns,
      initialTranslateSelection(),
      ["de"],
      "product",
    );
    expect(units).toBe(1);
    expect(jobs[0].cells).toHaveLength(1);
    expect(jobs[0].cells[0].locales).toEqual(["de"]);
  });

  it("skips cells without a source value instead of translating an empty string", () => {
    const item: MissingItem = {
      ...ITEM_A,
      primaryHandle: "silk-scarf",
      columns: [{ columnId: "field.title", locales: ["de"], source: "   " }],
    };
    const { jobs, units } = buildJobs([item], columns, selectAllPairs(), ["de"], "product");
    expect(units).toBe(0);
    expect(jobs).toHaveLength(0);
  });

  it("caps a run at MAX_TRANSLATE_UNITS and reports the remainder", () => {
    const many: MissingItem[] = Array.from({ length: MAX_TRANSLATE_UNITS + 10 }, (_, i) => ({
      rowId: `gid://shopify/Product/${i}`,
      title: `Product ${i}`,
      subtitle: "",
      primaryHandle: "",
      columns: [{ columnId: "field.title", locales: ["de"], source: `Title ${i}` }],
    }));
    const { units, overCap } = buildJobs(many, columns, selectAllPairs(), ["de"], "product");
    expect(units).toBe(MAX_TRANSLATE_UNITS);
    expect(overCap).toBe(10);
  });
});
