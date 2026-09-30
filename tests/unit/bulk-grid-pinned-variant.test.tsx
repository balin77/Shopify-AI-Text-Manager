/**
 * The variant view pins its two context columns — the product AND the
 * variant — so scrolling out to the price columns never loses which variant a
 * row is. The second pinned column sits where the first one ends, which is
 * only knowable if the first one has a fixed width.
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { AppProvider } from "@shopify/polaris";
import en from "@shopify/polaris/locales/en.json";
import { BulkGrid } from "~/components/bulk-editor/BulkGrid";
import type { BulkRow, ColumnDescriptor } from "~/services/bulk-editor/columns.shared";

afterEach(cleanup);

function readonlyColumn(id: string, minWidth: number): ColumnDescriptor {
  return { id, kind: "readonly", label: id, group: "base", editable: false, translatable: false, inputType: "text", minWidth };
}

const PRODUCT = readonlyColumn("productTitle", 180);
const VARIANT = readonlyColumn("variantTitle", 160);
const SKU: ColumnDescriptor = {
  id: "var.sku", kind: "variant", label: "sku", group: "base", editable: true, translatable: false, inputType: "text", minWidth: 140,
};

const rows: BulkRow[] = [
  { id: "gid://shopify/ProductVariant/1", type: "variant", title: "S / Red", seoTitle: "", seoDescription: "", handle: "" },
];

function renderGrid(columns: ColumnDescriptor[]) {
  const { container } = render(
    <AppProvider i18n={en}>
      <BulkGrid
        rows={rows}
        type="variant"
        columns={columns}
        valueFor={(row) => row.title}
        isDirty={() => false}
        setEdit={() => {}}
        isForeignLocale={false}
        ghostFor={() => ""}
        translationStatus={() => null}
        notTranslatableTooltip="not translatable"
        failuresByCell={new Map()}
        rowLevelFailures={new Map()}
        sort={null}
        onSortToggle={() => {}}
        openInEditorLabel="open"
        onOpenInEditor={() => {}}
        onPreviewImage={() => {}}
        previewImageLabel="preview"
        columnHeading={(column) => column.label}
        enumLabels={{}}
        handleWarning="handle"
        readOnlyTooltips={{ column: "read only" } as never}
        sortButtonLabel="sort"
        caption="variants"
        onResetCell={() => {}}
        onPasteRect={() => false}
      />
    </AppProvider>,
  );
  const grid = container.querySelector<HTMLElement>(".cp-bulk-grid")!;
  const headers = [...grid.querySelectorAll<HTMLElement>('[role="columnheader"]')];
  return { grid, headers };
}

describe("the variant view's pinned columns", () => {
  it("pins the variant title right after the product title, and gives the product a fixed track", () => {
    const { grid, headers } = renderGrid([PRODUCT, VARIANT, SKU]);
    expect(headers[1].className).toContain("cp-bulk-sticky-1");
    expect(headers[1].className).not.toContain("cp-bulk-sticky-edge");
    expect(headers[2].className).toContain("cp-bulk-sticky-2");
    expect(headers[2].className).toContain("cp-bulk-sticky-edge");
    expect(headers[3].className).not.toContain("cp-bulk-sticky");
    // A `1fr` product track would leave the variant column's `left` unknown.
    expect(grid.style.gridTemplateColumns.split(" ")[1]).toBe("200px");
    // Every data cell of that column pins too, not only the header.
    const variantCells = grid.querySelectorAll(".cp-bulk-cell.cp-bulk-sticky-2");
    expect(variantCells.length).toBe(rows.length);
  });

  it("pins the variant title in the first slot when the product column is hidden", () => {
    const { grid, headers } = renderGrid([VARIANT, SKU]);
    expect(headers[1].className).toContain("cp-bulk-sticky-1");
    expect(headers[1].className).toContain("cp-bulk-sticky-edge");
    expect(grid.querySelector(".cp-bulk-sticky-2")).toBeNull();
    expect(grid.style.gridTemplateColumns.split(" ")[1]).toMatch(/^minmax\(/);
  });
});
