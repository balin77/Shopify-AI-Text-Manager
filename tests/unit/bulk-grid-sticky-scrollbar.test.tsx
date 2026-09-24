/**
 * The bulk grid's horizontal scrollbar, pinned to the bottom of the window.
 *
 * The real scroller's own bar sits at the bottom of a grid that can be
 * hundreds of rows tall, so it is only reachable after scrolling the whole
 * page down — which is what the merchant reported: sideways scrolling is
 * unusable unless you are already at the very bottom. The bar rendered here is
 * a second view of the same scroll position, `position: sticky; bottom: 0`.
 *
 * Two things about it cannot be read off the stylesheet, and both are what
 * these tests observe:
 *
 * 1. It has to be a SIBLING of the scroller. A child of an overflow-x:auto box
 *    sticks to THAT box's scrollport (overflow-x:auto computes overflow-y to
 *    auto, so the scroller is a scroll container on both axes) — i.e. to the
 *    very bottom edge that is off screen, which is the bug rather than the fix.
 *
 * 2. It only exists while the grid really overflows. A grid whose columns fit
 *    has nothing to scroll, and a permanent empty bar under it would be a
 *    control that does nothing.
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { AppProvider } from "@shopify/polaris";
import en from "@shopify/polaris/locales/en.json";
import { BulkGrid } from "~/components/bulk-editor/BulkGrid";
import type { BulkRow, ColumnDescriptor } from "~/services/bulk-editor/columns.shared";

afterEach(() => {
  cleanup();
  restoreWidths();
});

let restoreWidths = () => {};

/** happy-dom lays nothing out, so the grid's overflow has to be stated. The
 *  component reads both off the scroll container in its measuring effect. */
function stubWidths(content: number, viewport: number) {
  const proto = window.HTMLElement.prototype;
  const original = {
    scrollWidth: Object.getOwnPropertyDescriptor(proto, "scrollWidth"),
    clientWidth: Object.getOwnPropertyDescriptor(proto, "clientWidth"),
  };
  Object.defineProperty(proto, "scrollWidth", { configurable: true, get: () => content });
  Object.defineProperty(proto, "clientWidth", { configurable: true, get: () => viewport });
  restoreWidths = () => {
    if (original.scrollWidth) Object.defineProperty(proto, "scrollWidth", original.scrollWidth);
    else delete (proto as unknown as Record<string, unknown>).scrollWidth;
    if (original.clientWidth) Object.defineProperty(proto, "clientWidth", original.clientWidth);
    else delete (proto as unknown as Record<string, unknown>).clientWidth;
    restoreWidths = () => {};
  };
}

const columns: ColumnDescriptor[] = [
  {
    id: "field.title",
    kind: "field",
    label: "title",
    group: "base",
    editable: true,
    translatable: true,
    inputType: "text",
    minWidth: 244,
  },
  {
    id: "field.status",
    kind: "field",
    label: "status",
    group: "base",
    editable: true,
    translatable: false,
    inputType: "select",
    minWidth: 160,
  },
];

const rows: BulkRow[] = [
  {
    id: "gid://shopify/Product/1",
    type: "product",
    title: "Kumiko Box",
    seoTitle: "",
    seoDescription: "",
    handle: "kumiko-box",
    status: "ACTIVE",
  },
];

function grid() {
  return (
    <AppProvider i18n={en}>
      <BulkGrid
        rows={rows}
        type="product"
        columns={columns}
        valueFor={(row, column) => (column.id === "field.status" ? (row.status ?? "") : row.title)}
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
        enumLabels={{ "status.ACTIVE": "Active", "status.DRAFT": "Draft" }}
        handleWarning="handle"
        readOnlyTooltips={{
          column: "read only",
          richText: "rich text",
          linkedOption: "linked",
          missingOption: "no option",
          legacyOptionValues: "legacy",
          missingImage: "no image",
          missingMediaId: "no media",
          wrongMetaobjectType: "wrong type",
          listSeparatorInValue: "separator",
          altTextInImages: "alt in images",
          attributesNotSynced: "not synced",
          commerceNotSynced: "commerce not synced",
          missingInventoryItem: "no inventory item",
          multipleVariants: "several variants",
          variantsNotSynced: "variants not synced",
          needsPicker: "use the single editor",
          collectionsTruncated: "list incomplete",
        }}
        sortButtonLabel="sort"
        caption="products"
        onResetCell={() => {}}
        onPasteRect={() => false}
      />
    </AppProvider>
  );
}

describe("the bulk grid's sticky horizontal scrollbar", () => {
  it("renders OUTSIDE the scroll container it drives", () => {
    stubWidths(2400, 1200);
    const { container } = render(grid());
    const scroller = container.querySelector(".cp-bulk-scroll");
    const bar = container.querySelector(".cp-bulk-hscroll");
    expect(scroller, "the scroll container is gone").not.toBeNull();
    expect(bar, "the sticky scrollbar did not render over an overflowing grid").not.toBeNull();
    expect(scroller!.contains(bar!)).toBe(false);
    // …and inside the wrapper that holds both, so `bottom: 0` is resolved
    // against the page's scroll container rather than the scroller's.
    expect(container.querySelector(".cp-bulk-scroll-wrap")!.contains(bar!)).toBe(true);
  });

  it("sizes its thumb like a native one: viewport share of the content", () => {
    stubWidths(2400, 1200);
    const { container } = render(grid());
    const thumb = container.querySelector<HTMLElement>(".cp-bulk-hscroll-thumb");
    expect(thumb).not.toBeNull();
    expect(thumb!.style.width).toBe("600px");
    expect(thumb!.style.getPropertyValue("--cp-bulk-thumb-travel")).toBe("600px");
  });

  it("stays away while the columns fit", () => {
    stubWidths(1200, 1200);
    const { container } = render(grid());
    expect(container.querySelector(".cp-bulk-hscroll")).toBeNull();
  });

  /* The touchpad judder: the bar used to be a second native scroller kept in
     step by scroll events, which reach the main thread a frame after the
     compositor has moved the grid. It is now a plain track whose thumb the
     browser moves from the grid's own scroll timeline — nothing to sync, so
     no element here may be a scroller of its own. */
  it("is not a second scroller that would have to be kept in step", () => {
    stubWidths(2400, 1200);
    const { container } = render(grid());
    expect(container.querySelector(".cp-bulk-hscroll-spacer")).toBeNull();
    const css = container.querySelector("style")!.textContent!;
    expect(css).toMatch(/\.cp-bulk-scroll \{[^}]*scroll-timeline: --cp-bulk-x x;/);
    expect(css).toMatch(/\.cp-bulk-scroll-wrap \{[^}]*timeline-scope: --cp-bulk-x;/);
    expect(css).toMatch(/animation-timeline: --cp-bulk-x;/);
    const barRule = css.match(/\.cp-bulk-hscroll \{[^}]*\}/)![0];
    expect(barRule).not.toMatch(/overflow/);
  });

  it("drags the grid by the thumb, in content pixels", () => {
    stubWidths(2400, 1200);
    const { container } = render(grid());
    const scroller = container.querySelector<HTMLDivElement>(".cp-bulk-scroll")!;
    const bar = container.querySelector<HTMLDivElement>(".cp-bulk-hscroll")!;
    const thumb = container.querySelector<HTMLDivElement>(".cp-bulk-hscroll-thumb")!;

    // travel 600px covers a scroll range of 1200px ⇒ 1px of thumb = 2px of grid.
    fireEvent.pointerDown(thumb, { pointerId: 1, button: 0, clientX: 100 });
    fireEvent.pointerMove(bar, { pointerId: 1, clientX: 250 });
    expect(scroller.scrollLeft).toBe(300);
    fireEvent.pointerUp(bar, { pointerId: 1, clientX: 250 });
    fireEvent.pointerMove(bar, { pointerId: 1, clientX: 400 });
    expect(scroller.scrollLeft, "the drag outlived the pointer release").toBe(300);
  });

  it("scrolls the grid when the wheel turns over the bar", () => {
    stubWidths(2400, 1200);
    const { container } = render(grid());
    const scroller = container.querySelector<HTMLDivElement>(".cp-bulk-scroll")!;
    const bar = container.querySelector<HTMLDivElement>(".cp-bulk-hscroll")!;
    const event = new WheelEvent("wheel", { deltaY: 80, cancelable: true, bubbles: true });
    bar.dispatchEvent(event);
    expect(scroller.scrollLeft).toBe(80);
    expect(event.defaultPrevented, "the page scrolled underneath as well").toBe(true);
  });
});
