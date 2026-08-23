/**
 * How the metaobject entry card lays its fields out.
 *
 * TWO rules, and the card shipped without either.
 *
 * A field that needs the whole width is laid out UNDER the grid, never inside
 * it. Spanning a cell across every column keeps every column ALIVE, and
 * `auto-fit` only collapses a column that is empty -- so one chip list at the
 * top of an entry froze every box below it at its minimum width and left the
 * rest of the card blank.
 *
 * A `lead` field -- the entry's picture -- gets a row of its own ABOVE the
 * grid: in the grid its 48px tile claimed a whole text column and pushed the
 * fields that actually hold text onto the next row.
 *
 * Both failures are invisible in a snapshot (the same elements are on the page,
 * in the same order) and show up only as which container each field sits in,
 * which is what these tests assert.
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { AppProvider } from "@shopify/polaris";
import en from "@shopify/polaris/locales/en.json";
import { MetaobjectEntryCard } from "~/components/metaobjects/MetaobjectEntryCard";

afterEach(cleanup);

function card(children: Array<{ key: string; node: React.ReactNode; wide?: boolean; lead?: boolean }>) {
  return render(
    <AppProvider i18n={en}>
      <MetaobjectEntryCard
        entryId="gid://shopify/Metaobject/1"
        title="Army Beige"
        handle="plaarmybeige"
        unsupportedFields={[]}
        usage={{ state: "known", products: 0 }}
      >
        {children}
      </MetaobjectEntryCard>
    </AppProvider>,
  );
}

const grid = () => document.querySelector(".metaobject-entry-fields");

describe("metaobject entry card layout", () => {
  it("puts every box field in the one grid", () => {
    card([
      { key: "label", node: <span data-testid="label">Label</span> },
      { key: "image", node: <span data-testid="image">Image</span> },
    ]);
    expect(grid()).not.toBeNull();
    expect(grid()!.contains(screen.getByTestId("label"))).toBe(true);
    expect(grid()!.contains(screen.getByTestId("image"))).toBe(true);
  });

  it("keeps a wide field OUT of the grid", () => {
    card([
      { key: "label", node: <span data-testid="label">Label</span> },
      { key: "colors", node: <span data-testid="colors">Colors</span>, wide: true },
      { key: "pattern", node: <span data-testid="pattern">Pattern</span> },
    ]);
    const wide = screen.getByTestId("colors");
    expect(grid()!.contains(wide)).toBe(false);
    expect(wide.closest(".metaobject-entry-fields__wide")).not.toBeNull();
    // The box AFTER the wide one still belongs to the grid — it used to start a
    // row of its own behind the spanning cell, alone in a five-column line.
    expect(grid()!.contains(screen.getByTestId("pattern"))).toBe(true);
  });

  it("draws no grid at all when every field is wide", () => {
    card([{ key: "body", node: <span data-testid="body">Body</span>, wide: true }]);
    expect(grid()).toBeNull();
    expect(screen.getByTestId("body").closest(".metaobject-entry-fields__wide")).not.toBeNull();
  });

  it("lifts a lead field out of the grid, above it", () => {
    card([
      { key: "label", node: <span data-testid="label">Label</span> },
      { key: "image", node: <span data-testid="image">Image</span>, lead: true },
      { key: "pattern", node: <span data-testid="pattern">Pattern</span> },
    ]);
    const image = screen.getByTestId("image");
    expect(grid()!.contains(image)).toBe(false);
    const lead = image.closest(".metaobject-entry-fields__lead");
    expect(lead).not.toBeNull();
    // ABOVE the grid, not merely outside it: the whole point is that the
    // picture comes first and the text fields keep their full row below.
    expect(lead!.compareDocumentPosition(grid()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The boxes around it stay in the one grid — they used to be split across
    // rows by whatever sat between them.
    expect(grid()!.contains(screen.getByTestId("label"))).toBe(true);
    expect(grid()!.contains(screen.getByTestId("pattern"))).toBe(true);
  });

  it("draws no grid when the only field leads", () => {
    card([{ key: "image", node: <span data-testid="image">Image</span>, lead: true }]);
    expect(grid()).toBeNull();
    expect(screen.getByTestId("image").closest(".metaobject-entry-fields__lead")).not.toBeNull();
    // A lead field IS an editable field: the empty-state sentence must not
    // appear over a working image picker.
    expect(screen.queryByText(/None of this entry's fields can be edited here\./)).toBeNull();
  });

  it("still says when there is nothing to edit", () => {
    card([]);
    expect(screen.getByText(/None of this entry's fields can be edited here\./)).toBeTruthy();
  });
});
