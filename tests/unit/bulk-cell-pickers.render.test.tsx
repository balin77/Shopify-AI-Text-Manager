/**
 * What the grid's cells SHOW for the price of a multi-variant product and for
 * the two picker columns.
 *
 * The price case is the one a merchant reported: the read-only reason and its
 * tooltip text existed, but the cell rendered "" — and a tooltip anchored to an
 * empty string has nothing for the pointer to rest on. So the explanation was
 * there and unreachable. The placeholder is the fix, and this pins it.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { AppProvider } from "@shopify/polaris";
import en from "@shopify/polaris/locales/en.json";
import { BulkCell } from "~/components/bulk-editor/BulkCell";
import { resetTaxonomyLabelsForTests } from "~/components/unified/TaxonomyField";
import {
  buildColumnsForType,
  CATEGORY_COLUMN_ID,
  COLLECTIONS_COLUMN_ID,
  VAR_PRICE_COLUMN_ID,
  type BulkRow,
} from "~/services/bulk-editor/columns.shared";

vi.mock("~/contexts/I18nContext", () => ({ useI18n: () => ({ locale: "de" }) }));

const columns = buildColumnsForType("product", [], { metafields: true, options: true, imageAlt: true });
const column = (id: string) => columns.find((c) => c.id === id)!;

const row: BulkRow = {
  id: "gid://shopify/Product/1",
  type: "product",
  title: "Vase",
  seoTitle: "",
  seoDescription: "",
  handle: "vase",
  category: "gid://shopify/TaxonomyCategory/hg-3-74",
  categoryName: "Home & Garden > Decor > Vases",
  collections: "gid://shopify/Collection/10",
  collectionMemberships: [
    { collectionId: "gid://shopify/Collection/10", collectionTitle: "Sale", automated: false },
  ],
  attributesKnown: true,
};

function cell(props: Partial<Parameters<typeof BulkCell>[0]>) {
  return render(
    <AppProvider i18n={en}>
      <BulkCell
        column={column(VAR_PRICE_COLUMN_ID)}
        value=""
        isDirty={false}
        readOnly={false}
        readOnlyTooltip=""
        enumLabels={{}}
        onChange={() => {}}
        {...props}
      />
    </AppProvider>,
  );
}

afterEach(() => {
  cleanup();
  resetTaxonomyLabelsForTests();
});

describe("an empty read-only cell", () => {
  it("shows its placeholder, so the explaining tooltip has something to hover", () => {
    const { container } = cell({
      readOnly: true,
      readOnlyTooltip: "This product has several variants…",
      readOnlyPlaceholder: "Mehrere Varianten",
    });
    expect(container.textContent).toContain("Mehrere Varianten");
  });

  it("still shows its own value when it has one", () => {
    const { container } = cell({ readOnly: true, value: "49.90", readOnlyPlaceholder: "Mehrere Varianten" });
    expect(container.textContent).toContain("49.90");
    expect(container.textContent).not.toContain("Mehrere Varianten");
  });
});

describe("the picker cells", () => {
  it("renders the category as its NAME, never as the GID", () => {
    const { container } = cell({
      column: column(CATEGORY_COLUMN_ID),
      value: row.category!,
      row,
      categoryTexts: {},
    });
    expect(container.textContent).toContain("Vases");
    expect(container.textContent).not.toContain("gid://");
    // A picker, not a text box a GID could be typed into.
    expect(container.querySelector("textarea")).toBeNull();
  });

  it("renders memberships as TITLES, never as GIDs", () => {
    globalThis.fetch = vi.fn(async () => ({
      json: async () => ({ success: true, collections: [], truncated: false }),
    })) as unknown as typeof fetch;
    const { container } = cell({
      column: column(COLLECTIONS_COLUMN_ID),
      value: row.collections!,
      row,
      collectionsTexts: {},
    });
    expect(container.textContent).toContain("Sale");
    expect(container.textContent).not.toContain("gid://");
  });
});

describe("a category picked in the grid survives a remount of its cell", () => {
  it("keeps showing the NEW name, not the cached old one", async () => {
    // Switching to a language tab and back remounts the cell. Its picked label
    // lived in component state and died with it, so the cell fell back to the
    // CACHED path — the old category's name on a cell whose dirty value (and
    // whose save) was the new one.
    const NEW = "gid://shopify/TaxonomyCategory/aa-1-13";
    globalThis.fetch = vi.fn(async () => ({
      json: async () => ({ success: true, category: { id: NEW, fullName: "Apparel > Shirts", name: "Shirts" } }),
    })) as unknown as typeof fetch;

    // First mount: a dirty value with no cached label — the grid passes ""
    // for currentLabel, so the cell asks once and LEARNS the name.
    const first = cell({ column: column(CATEGORY_COLUMN_ID), value: NEW, row, categoryTexts: {} });
    await vi.waitFor(() => expect(first.container.textContent).toContain("Shirts"));
    first.unmount();

    // Second mount, the lookup now failing: the learned name must still show.
    globalThis.fetch = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const second = cell({ column: column(CATEGORY_COLUMN_ID), value: NEW, row, categoryTexts: {} });
    expect(second.container.textContent).toContain("Shirts");
    expect(second.container.textContent).not.toContain("Vases");
  });
});
