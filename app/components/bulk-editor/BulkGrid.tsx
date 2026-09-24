/**
 * Bulk editor — the spreadsheet grid (docs/plans/PLAN_BULK_EDITOR.md §2).
 *
 * Excel-like grid: borderless textareas that auto-grow with content (swapped
 * in lazily per cell, see BulkCell), tight padding, horizontal scrolling when
 * columns don't fit, and a read-only image thumbnail column that doubles as
 * the "open in editor" affordance.
 *
 * Implemented as CSS Grid (not <table>) because the textarea in every cell
 * must fill the whole cell — the classic <td h:1px> table trick collapsed to
 * 0 inside the embedded-iframe layout chain. CSS Grid stretches cells with
 * align-items:stretch by default, and children with min-height:100% reliably
 * reference the cell's rendered height. `display:contents` on each row div
 * lets its cells participate in the outer grid, so columns align vertically
 * and cells in the same visual row share height. Semantics are preserved via
 * ARIA (role="table"/"row"/"cell"/"columnheader", aria-sort on sortable
 * headers).
 *
 * Sticky columns (§2): the image column (always leftmost, fixed 72 px) and
 * the title column stay pinned while the grid scrolls horizontally. Two rules
 * keep that true and both were live defects: the grid needs `min-width:
 * min-content` (a sticky box may not leave its containing block, which for a
 * grid item is the grid container, so `width: 100%` alone unpins them at the
 * right-hand end of the scroll) and every cell isolates its own stacking
 * context (or a Polaris control inside a cell paints over the pinned columns —
 * see the .cp-bulk-cell rule).
 *
 * The horizontal scrollbar is a PROXY pinned to the bottom of the window
 * (.cp-bulk-hscroll): the scroller's own bar is at the bottom of a grid that
 * can be hundreds of rows tall, i.e. reachable only from the very end of the
 * page.
 */

import { useEffect, useRef, useState } from "react";
import { Button, Text, Tooltip } from "@shopify/polaris";
import { EditIcon, SearchIcon } from "@shopify/polaris-icons";
import {
  resolveCellValue,
  columnCanHaveCellActions,
  ATTRIBUTE_BLOCK_COLUMNS,
  type BulkRow,
  type BulkRowType,
  type BulkSort,
  type CellReadOnlyReason,
  type ColumnDescriptor,
} from "../../services/bulk-editor/columns.shared";
import {
  BulkCell,
  type BulkCellActions,
  type BulkCellEnumLabels,
  type CellNavDirection,
} from "./BulkCell";

/** Fixed image-column width — must be a constant so the sticky title column
 * can sit at left:72px. */
/** The menu trigger's icon box, and the gutter a cell reserves for it (icon +
 * the 2px inset on each side). Columns that carry a menu grow their minimum by
 * exactly the gutter — see the grid template. */
const CELL_ACTIONS_ICON = 20;
const CELL_ACTIONS_GUTTER = CELL_ACTIONS_ICON + 4;

const IMAGE_COLUMN_WIDTH = 72;

/** Field-colour state, mirroring the single editor: "untranslated" (yellow —
 * empty in the selected language) or "missingTranslation" (blue — primary set
 * but a foreign locale lacks it, primary view only); null = no colour. */
export type CellTranslationStatus = "untranslated" | "missingTranslation" | null;

interface BulkGridProps {
  rows: BulkRow[];
  type: BulkRowType;
  /** Visible columns in render order. The image column is forced leftmost by
   * the grid regardless of whether it is included here. */
  columns: ColumnDescriptor[];
  valueFor: (row: BulkRow, column: ColumnDescriptor) => string;
  isDirty: (row: BulkRow, column: ColumnDescriptor) => boolean;
  setEdit: (row: BulkRow, column: ColumnDescriptor, value: string) => void;
  /** True when a foreign locale is selected (Phase 4): non-translatable
   * columns render read-only (grey + tooltip) and empty translatable cells
   * show the ghost from `ghostFor`. */
  isForeignLocale: boolean;
  /** Ghost placeholder for an empty foreign cell — the primary value, or the
   * global translation under a market override (Plan §6.4). */
  ghostFor: (row: BulkRow, column: ColumnDescriptor) => string;
  /** PLAN §2.4 / §3.6 — the word for "we have not fetched this yet", shown in
   *  a `vendor`/`tags` cell whose row predates the attribute sync. Without it
   *  an unsynced row is indistinguishable from a product whose vendor the
   *  merchant genuinely left blank — the same trap as every other column of
   *  that block, and here it would invite a merchant to "fix" data that is
   *  merely unfetched. */
  unknownAttributeGhost?: string;
  /** Field colour per cell (Plan §2) — see CellTranslationStatus. */
  translationStatus: (row: BulkRow, column: ColumnDescriptor) => CellTranslationStatus;
  /** Tooltip text for a blue "missingTranslation" cell — the foreign languages
   * still lacking a translation. Only consulted for cells coloured blue. */
  translationTooltip?: (row: BulkRow, column: ColumnDescriptor) => string | null;
  /** Tooltip for columns that are read-only in a foreign locale. */
  notTranslatableTooltip: string;
  /** `${rowId}|${columnId}` → failure message of the last save — marks
   * exactly that CELL invalid (Plan §4.4 cell-granular failures). */
  failuresByCell: ReadonlyMap<string, string>;
  /** rowId → failure message for row-level failures (single-mutation types,
   * no columnId) — falls back to marking the row's edited cells. */
  rowLevelFailures: ReadonlyMap<string, string>;
  sort: BulkSort | null;
  onSortToggle: (column: ColumnDescriptor) => void;
  openInEditorLabel: string;
  onOpenInEditor: (row: BulkRow) => void;
  /** Click on the image cell — opens the preview modal. */
  onPreviewImage: (row: BulkRow) => void;
  previewImageLabel: string;
  /** Per-cell action menu (three dots on hover). Returns undefined for cells
   * that have nothing to offer. */
  cellActions?: (row: BulkRow, column: ColumnDescriptor) => BulkCellActions | undefined;
  columnHeading: (column: ColumnDescriptor) => string;
  /** Labels for the select columns (see BulkCellEnumLabels). */
  enumLabels: BulkCellEnumLabels;
  /** Template suffixes the PUBLISHED theme offers for this row type, or
   *  undefined while the lookup is pending or after it failed — the cell then
   *  falls back to a text box rather than an empty dropdown. */
  templateSuffixes?: string[];
  handleWarning: string;
  /** Localized read-only explanations per reason (Plan §4.1–§4.3). */
  readOnlyTooltips: Record<CellReadOnlyReason, string>;
  sortButtonLabel: string;
  /** Visually-hidden table label — the localized content-type name. */
  caption: string;
  /** Esc on a cell (§8.4): reset it to its load value (drop the edit). */
  onResetCell: (row: BulkRow, column: ColumnDescriptor) => void;
  /** Rectangle paste hook (§8.3): coordinates are indices into the VISIBLE
   * rows × display columns (image column excluded — same list this grid
   * renders). Return true to consume the paste. */
  onPasteRect: (startRow: number, startCol: number, text: string) => boolean;
}

export function BulkGrid({
  rows,
  type,
  columns,
  valueFor,
  isDirty,
  setEdit,
  isForeignLocale,
  ghostFor,
  unknownAttributeGhost,
  translationStatus,
  translationTooltip,
  notTranslatableTooltip,
  failuresByCell,
  rowLevelFailures,
  sort,
  onSortToggle,
  openInEditorLabel,
  onOpenInEditor,
  onPreviewImage,
  previewImageLabel,
  cellActions,
  columnHeading,
  enumLabels,
  templateSuffixes,
  handleWarning,
  readOnlyTooltips,
  sortButtonLabel,
  caption,
  onResetCell,
  onPasteRect,
}: BulkGridProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  /** The proxy horizontal scrollbar pinned to the bottom of the viewport (see
   * the .cp-bulk-hscroll rules below). Null until the grid actually overflows. */
  const hScrollRef = useRef<HTMLDivElement>(null);
  /** Content vs. viewport width of the horizontal scroller. `content` is what
   * the proxy's spacer is sized to; the bar only renders while it exceeds the
   * viewport, so a grid that fits grows no second scrollbar. */
  const [scrollMetrics, setScrollMetrics] = useState({ content: 0, viewport: 0 });

  /** Keyboard navigation (§8.4). Every editable TEXT cell stamps its
   * coordinate as data-cp-cell on whichever element is mounted (static div or
   * textarea — the lazy swap, §10.2), so "next"/"prev" is simply the DOM
   * order of those elements (row-major thanks to display:contents), and
   * "down" is the same column in the next row that has an editable cell.
   * Focusing a static div promotes it to the textarea automatically. */
  const navigateFromCell = (rowIndex: number, colIndex: number, direction: CellNavDirection) => {
    const container = containerRef.current;
    if (!container) return;
    if (direction === "down") {
      for (let r = rowIndex + 1; r < rows.length; r++) {
        const el = container.querySelector<HTMLElement>(`[data-cp-cell="${r}:${colIndex}"]`);
        if (el) {
          el.focus();
          return;
        }
      }
      return;
    }
    const cells = [...container.querySelectorAll<HTMLElement>("[data-cp-cell]")];
    const current = cells.findIndex((el) => el.dataset.cpCell === `${rowIndex}:${colIndex}`);
    if (current === -1) return;
    const target = cells[current + (direction === "next" ? 1 : -1)];
    target?.focus();
  };
  // Image column is ALWAYS the leftmost cell; its hover overlay (a magnifier,
  // see BulkImageCell) opens the PREVIEW — the jump into the full editor is
  // the trailing edit column's job, not the thumbnail's. Rendered as a
  // placeholder for types without an image, so every type keeps the column.
  const displayColumns = columns.filter((c) => c.id !== "image");
  // Sticky pinning: image at left:0, title (canonically the first data
  // column) at left:72px — but only when title actually renders directly
  // after the image, otherwise a gap column would scroll underneath it.
  // Variant rows (Plan §5.3) pin the product-title CONTEXT column instead.
  const titleSticky =
    displayColumns[0]?.id === "field.title" || displayColumns[0]?.id === "productTitle";

  // A column whose cells carry the action menu gives up CELL_ACTIONS_GUTTER of
  // its content width to it — so its minimum has to GROW by exactly that,
  // otherwise the reservation would squeeze the narrow columns (an option name
  // at 160px would render its text in 134).
  //
  // Judged from the DESCRIPTOR, never from the loaded rows: editability is
  // per row (a product without a second option, an image without a mediaId),
  // so probing the rows would make the track width — and with it every 1fr
  // track — jump on page turns, filters and searches. Read-only, money and
  // status columns have no menu and stay untouched either way.
  const columnGutter = displayColumns.map((col) =>
    cellActions && columnCanHaveCellActions(col) ? CELL_ACTIONS_GUTTER : 0,
  );

  const gridTemplateColumns = [
    `${IMAGE_COLUMN_WIDTH}px`,
    // Columns without a maxWidth share the remaining width equally (1fr);
    // a capped one stays at its own size instead of stretching.
    ...displayColumns.map((c, index) => {
      const min = c.minWidth + columnGutter[index];
      return `minmax(${min}px, ${c.maxWidth ? `${c.maxWidth + columnGutter[index]}px` : "1fr"})`;
    }),
    // Trailing "open in editor" column. A CSS variable rather than a literal
    // so the width lives in the stylesheet with the rest of the column's
    // rules — no media query or class can reach an inline style.
    "var(--cp-bulk-edit-col)",
  ].join(" ");

  /** Keep the proxy bar's spacer as wide as the real scroller's content.
   *
   * The ResizeObserver watches the SCROLLER, not the grid: with
   * `.cp-bulk-grid { width: 100% }` the grid box never grows — its tracks
   * overflow it — so a grid-side observation would never fire. What changes
   * the content width is the container's width (observed) and the column
   * template (the effect dependency). */
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => {
      const content = el.scrollWidth;
      const viewport = el.clientWidth;
      setScrollMetrics((prev) =>
        prev.content === content && prev.viewport === viewport ? prev : { content, viewport },
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [gridTemplateColumns, rows.length]);

  /** Two scrollers showing one position — and the ECHO of our own write must
   * never be synced back.
   *
   * A scroll event is delivered asynchronously (next frame), so the event the
   * proxy fires for OUR assignment arrives after a trackpad or momentum
   * scroll has already moved the grid further. Syncing that echo back wrote
   * the proxy's OLDER position into the grid: it jumped back a few pixels and,
   * because a programmatic scroll cancels the running smooth/momentum scroll,
   * the gesture stalled until the next input event restarted it — the stutter
   * merchants saw when scrolling sideways with a touchpad. (The old
   * "assigning an equal value fires no event" reasoning only holds while the
   * source stands still.)
   *
   * So every write records the value the target really took (read back: the
   * browser clamps and rounds), and a scroll event on that target reporting
   * exactly that value is our echo and is dropped. Anything else is the
   * merchant moving that scroller and is synced across. */
  const echoRef = useRef(new WeakMap<HTMLDivElement, number>());
  const syncScroll = (from: HTMLDivElement | null, to: HTMLDivElement | null) => {
    if (!from || !to) return;
    // Kept (not consumed) on a match: a write can surface as more than one
    // event, and a second echo read as "the merchant moved it" is the same
    // jump back. Any other value clears it.
    if (echoRef.current.get(from) === from.scrollLeft) return;
    echoRef.current.delete(from);
    const before = to.scrollLeft;
    if (before === from.scrollLeft) return;
    to.scrollLeft = from.scrollLeft;
    const after = to.scrollLeft;
    // A clamped no-op fires no event, so there is no echo to wait for.
    if (after !== before) echoRef.current.set(to, after);
  };

  const overflowing = scrollMetrics.content > scrollMetrics.viewport + 1;

  /** The bar is only ever moved BY a scroll event, so the render that first
   * mounts it (or that resized its spacer) leaves it at 0 while the grid may
   * be scrolled halfway — and the merchant's next drag would then jerk the
   * grid back to where the bar happened to sit. Align it once per change
   * instead. A column change can also clamp the grid's own scrollLeft, which
   * is another moment the two would silently disagree. */
  useEffect(() => {
    syncScroll(containerRef.current, hScrollRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- syncScroll reads
    // both refs at call time; re-running on its identity would fire every render.
  }, [overflowing, scrollMetrics.content]);

  const stickyClass = (index: number): string => {
    if (index === 0) return " cp-bulk-sticky cp-bulk-sticky-0";
    if (index === 1 && titleSticky) return " cp-bulk-sticky cp-bulk-sticky-1";
    return "";
  };

  const ariaSort = (column: ColumnDescriptor): "ascending" | "descending" | "none" | undefined => {
    if (!column.sortKey) return undefined;
    if (sort?.columnId !== column.id) return "none";
    return sort.direction === "asc" ? "ascending" : "descending";
  };

  return (
    <div className="cp-bulk-scroll-wrap">
    <div
      ref={containerRef}
      className="cp-bulk-scroll"
      /* Marks this as the scroll container Polaris overlays should track.
         Without it PositionedOverlay falls back to the document and never
         hears this scroller, so an open cell menu stays put while its
         activator scrolls away underneath it. */
      data-polaris-scrollable="true"
      onScroll={() => syncScroll(containerRef.current, hScrollRef.current)}
    >
      <style>{`
        /* The horizontal scroller. Its own scrollbar is HIDDEN: it sits at the
           bottom of a grid that can be hundreds of rows tall, so it is only
           reachable after scrolling the whole page down. .cp-bulk-hscroll
           below is the visible one, pinned to the bottom of the window, and
           two bars for one axis would only raise the question which is which.
           Hiding it changes no gesture: wheel, trackpad, touch and keyboard
           all still scroll this element. */
        .cp-bulk-scroll {
          overflow-x: auto;
          width: 100%;
          scrollbar-width: none;
        }
        .cp-bulk-scroll::-webkit-scrollbar { display: none; }
        /* No overflow of its own — a scroll container here would become the
           sticky bar's scrollport and pin it to the bottom of the GRID again,
           which is the bug this is about. */
        .cp-bulk-scroll-wrap {
          width: 100%;
        }
        .cp-bulk-hscroll {
          position: sticky;
          bottom: 0;
          /* Above the sticky data columns (2) and their headers (4): the bar
             belongs to the whole grid, not to a column. */
          z-index: 5;
          overflow-x: scroll;
          overflow-y: hidden;
          background: var(--p-color-bg-surface, #fff);
          border-top: 1px solid var(--p-color-border, #e1e3e5);
          /* A floor under the bar, because a scrollbar is not guaranteed to
             take any space: where the platform draws OVERLAY scrollbars the
             element would collapse to the spacer's 1px and the merchant would
             be looking for a bar that is one pixel tall. With a real scrollbar
             (12px + spacer) the floor is already cleared and does nothing. */
          min-height: 12px;
        }
        /* Deliberately NO scrollbar-width/scrollbar-color here: Chrome ignores
           every ::-webkit-scrollbar rule on an element that sets one, which
           would hand the bar back to the platform — including its overlay
           behaviour, i.e. a bar that is invisible until it is already being
           dragged. The WebKit pseudo-elements draw a classic, always-visible
           one instead. Firefox falls back to its own default bar, which is
           always visible on Windows and Linux. */
        .cp-bulk-hscroll::-webkit-scrollbar { height: 12px; }
        .cp-bulk-hscroll::-webkit-scrollbar-track { background: transparent; }
        .cp-bulk-hscroll::-webkit-scrollbar-thumb {
          background: var(--p-color-border, #c9cccf);
          border: 3px solid var(--p-color-bg-surface, #fff);
          border-radius: 6px;
        }
        .cp-bulk-hscroll::-webkit-scrollbar-thumb:hover {
          background: var(--p-color-border-emphasis, #8a8a8a);
        }
        /* 1px, not 0: a zero-height child makes some engines treat the
           scroller as empty and drop the bar. */
        .cp-bulk-hscroll-spacer { height: 1px; }
        .cp-bulk-grid {
          display: grid;
          /* DEFINITE width (not max-content): under width:max-content the
             minmax(px,1fr) tracks resolve as max-content and each column
             blows up to the widest UNWRAPPED cell — long product titles then
             swallowed ~80% of the grid. With a definite 100% the 1fr tracks
             share the real container width and long text wraps inside its
             column. When the columns' min widths exceed the container the grid
             simply overflows → the parent's overflow-x:auto scrolls (many
             columns still scroll horizontally, as before). */
          width: 100%;
          /* …but the BOX has to cover the tracks, or the sticky columns come
             unpinned at the right-hand end of the scroll. A sticky box may not
             leave its containing block, which here is the grid container: with
             width:100% alone that box is only as wide as the scrollport, so
             past a scrollLeft of (box − 316px) the pinned image and title
             columns are dragged off the left edge — MEASURED in Chromium,
             image at -32px and title at -204px at full right scroll on a
             12-column grid.

             min-content, never max-content: every track's MINIMUM is a fixed
             length (minmax(<px>, 1fr)), so the grid's min-content width is
             exactly the sum of those minimums — the overflow width we already
             scroll through. max-content is what the note above rejects: it
             resolves the 1fr tracks against the widest unwrapped cell and a
             long product title swallows the grid (measured: 244px → 882px).
             Where the columns fit, min-content is below 100% and changes
             nothing. */
          min-width: min-content;
        }
        /* display:contents makes each row-div disappear as a box; its cells
           become direct grid items of .cp-bulk-grid, so all cells share ONE
           set of column tracks and browser Grid layout groups them into
           implicit rows. Cells in the same implicit row automatically stretch
           to the tallest cell's height (align-items:stretch default). */
        .cp-bulk-row {
          display: contents;
        }
        .cp-bulk-th,
        .cp-bulk-cell {
          padding: 4px 6px;
          border-bottom: 1px solid var(--p-color-border, #e1e3e5);
          box-sizing: border-box;
          display: flex;
          flex-direction: column;
          background: var(--p-color-bg-surface, #fff);
          /* Every cell is its own stacking context, so nothing INSIDE a cell
             can paint over the sticky columns or the sticky header.

             Polaris' Select is exactly such an escapee and is what made this
             a rule: .Polaris-Select is position:relative with NO z-index
             (verified against @shopify/polaris 13.9.5's styles.css), so it
             creates no stacking context of its own and its parts — Backdrop
             10, Content 20, Input 30 — land in the GRID's context, far above
             the sticky columns at 2 and the header at 3/4. With the status
             column on, scrolling right left a column of status dropdowns
             floating over the pinned image and title cells.

             Fixed here rather than by raising the sticky z-indexes, because
             the ladder would have to be re-raised for the next Polaris
             control that ships a z-index — TextField's backdrop is a 10 too. */
          isolation: isolate;
        }
        .cp-bulk-th {
          text-align: left;
          font-weight: 500;
          font-size: 12px;
          color: var(--p-color-text-secondary, #6d7175);
          background: var(--p-color-bg-surface-secondary, #f6f6f7);
          position: sticky;
          top: 0;
          z-index: 3;
        }
        /* Sticky data columns (image + title). Headers of sticky columns pin
           on BOTH axes, so they need the highest z-index. */
        .cp-bulk-sticky {
          position: sticky;
          z-index: 2;
        }
        .cp-bulk-sticky-0 { left: 0; }
        .cp-bulk-sticky-1 { left: ${IMAGE_COLUMN_WIDTH}px; box-shadow: 1px 0 0 var(--p-color-border, #e1e3e5); }
        .cp-bulk-th.cp-bulk-sticky { z-index: 4; }
        /* Per-cell action menu: present in the DOM (so keyboard users can tab
           to it) but invisible until the cell is hovered or holds focus —
           250 rows of always-visible icons would be a wall of noise.

           The cell RESERVES the gutter the menu sits in, permanently: an
           overlay would let the value run underneath the dots, and revealing
           the space only on hover would make the text jump in a 250-row grid.
           The reservation is scoped to cells that actually have a menu, so
           read-only, money and status columns keep their full width. */
        .cp-bulk-cell-with-actions {
          position: relative;
          padding-right: ${CELL_ACTIONS_GUTTER}px;
        }
        .cp-bulk-cell-actions {
          position: absolute;
          top: 2px;
          right: 2px;
          opacity: 0;
          transition: opacity 100ms ease-in-out;
        }
        /* Hand-rolled trigger (like .cp-bulk-img-btn and .cp-bulk-sort-btn):
           a Polaris Button carries ~8px of horizontal padding, which pushed
           the icon out of the reserved gutter and into the text while leaving
           its own padding empty on the right. */
        .cp-bulk-cell-menu-btn {
          display: flex;
          align-items: center;
          justify-content: center;
          width: ${CELL_ACTIONS_ICON}px;
          height: ${CELL_ACTIONS_ICON}px;
          padding: 0;
          margin: 0;
          border: none;
          border-radius: 4px;
          background: transparent;
          color: var(--p-color-icon-secondary, #6d7175);
          cursor: pointer;
        }
        .cp-bulk-cell-menu-btn:hover {
          background: var(--p-color-bg-surface-hover, #f1f1f1);
          color: var(--p-color-icon, #4a4a4a);
        }
        .cp-bulk-cell-menu-btn:focus-visible {
          outline: 2px solid var(--p-color-border-focus, #005ab4);
          outline-offset: 1px;
        }
        .cp-bulk-cell:hover .cp-bulk-cell-actions,
        .cp-bulk-cell-with-actions:focus-within .cp-bulk-cell-actions,
        .cp-bulk-cell-actions:focus-within,
        .cp-bulk-cell-actions-open { opacity: 1; }
        /* Same menu, outside a grid cell (the image preview modal): no gutter
           to sit in, so it stays in flow and is always visible. */
        .cp-bulk-cell-actions-inline { display: inline-flex; opacity: 1; }
        /* A finger produces neither hover nor focus, so a hover-revealed
           control is unreachable — the menu stays visible.

           any-pointer, NOT (hover:none) and (pointer:coarse): a Windows
           touchscreen laptop and an iPad with a trackpad both report
           hover:hover / pointer:fine for their PRIMARY input, so the narrow
           query left exactly those devices with an invisible 20px control. */
        @media (any-pointer: coarse) {
          .cp-bulk-cell-actions { opacity: 1; }
        }
        /* Trailing edit column: an explicit "open in editor" button at the end
           of every row, on every device. It started as a touch-only stand-in
           for the image cell's hover overlay (a finger never triggers hover),
           but the overlay is undiscoverable with a mouse too — so the column
           is permanent and the overlay is the shortcut, not the other way
           round.

           Kept as a CSS variable rather than a literal so the width stays in
           ONE place: the grid template is an inline style, which no media
           query or stylesheet rule can reach. */
        .cp-bulk-grid { --cp-bulk-edit-col: 44px; }
        .cp-bulk-edit-cell { align-items: center; justify-content: center; }
        /* Sticky image + title pin 72 + 244 = 316px. On a phone that is most
           of the viewport, leaving a ~50px slit to scroll every other column
           through — so below 700px nothing pins and the grid scrolls whole. */
        @media (max-width: 700px) {
          .cp-bulk-sticky { position: static; }
          .cp-bulk-sticky-1 { box-shadow: none; }
        }
        /* Headers must consume the same gutter their cells reserve, or a
           heading wraps at a different width than the values below it. */
        .cp-bulk-th-with-actions { padding-right: ${CELL_ACTIONS_GUTTER}px; }
        /* Field colours, matching the single editor (Plan §2): applied to the
           cell WRAPPER (the input itself is transparent). Same hexes as
           AIEditableField.css so "Inhalt" and the bulk grid read identically.
           Dirty/error cells are never recoloured (see the grid render). */
        .cp-bulk-cell-untranslated { background: #fff4e5; }
        .cp-bulk-cell-missing { background: #e0f2fe; }
        /* Sortable header: the whole heading is a button; the caret shows
           the current direction. */
        .cp-bulk-sort-btn {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          padding: 0;
          margin: 0;
          border: none;
          background: transparent;
          font: inherit;
          color: inherit;
          cursor: pointer;
          text-align: left;
        }
        .cp-bulk-sort-btn:focus-visible {
          outline: 2px solid var(--p-color-border-focus, #005ab4);
          outline-offset: 1px;
          border-radius: 2px;
        }
        /* Only the text control stretches to fill the cell — image and
           Select keep their intrinsic sizing. The action-menu wrapper sits
           BETWEEN the cell and the control, so it has to carry the stretch
           through: without this the control loses its flex:1, its
           min-height:100% resolves against a shrink-wrapped parent and the
           whole grid's row heights fall apart. */
        .cp-bulk-cell > .cp-bulk-textarea,
        .cp-bulk-cell > .cp-bulk-cell-static,
        .cp-bulk-cell-with-actions > .cp-bulk-textarea,
        .cp-bulk-cell-with-actions > .cp-bulk-cell-static {
          flex: 1 1 auto;
        }
        .cp-bulk-cell > .cp-bulk-cell-with-actions {
          flex: 1 1 auto;
          display: flex;
          flex-direction: column;
        }
        /* Image cell: capped at 64 px tall so a row with long text doesn't
           inflate the image along with it. */
        .cp-bulk-img {
          display: block;
          max-height: 64px;
          max-width: ${IMAGE_COLUMN_WIDTH - 12}px;
          width: auto;
          object-fit: contain;
        }
        .cp-bulk-img-btn {
          position: relative;
          display: inline-block;
          padding: 0;
          margin: 0;
          border: none;
          background: transparent;
          cursor: pointer;
          line-height: 0;
          border-radius: 4px;
        }
        .cp-bulk-img-btn:focus-visible {
          outline: 2px solid var(--p-color-border-focus, #005ab4);
          outline-offset: 2px;
        }
        .cp-bulk-img-placeholder {
          display: block;
          width: ${IMAGE_COLUMN_WIDTH - 12}px;
          height: 64px;
          background: var(--p-color-bg-surface-secondary, #f6f6f7);
          border-radius: 4px;
        }
        .cp-bulk-img-overlay {
          position: absolute;
          inset: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          background: rgba(0, 0, 0, 0.55);
          opacity: 0;
          transition: opacity 120ms ease-out;
          border-radius: 4px;
          pointer-events: none;
        }
        .cp-bulk-img-btn:hover .cp-bulk-img-overlay,
        .cp-bulk-img-btn:focus-visible .cp-bulk-img-overlay {
          opacity: 1;
        }
        .cp-bulk-img-overlay svg {
          width: 20px;
          height: 20px;
          fill: #fff;
        }
        /* Static (unfocused) text cell — the cheap stand-in for the textarea
           (Plan §10.2). Same metrics as the textarea so the swap is
           position-stable. */
        .cp-bulk-cell-static {
          display: block;
          width: 100%;
          min-height: 100%;
          font: inherit;
          color: inherit;
          padding: 4px;
          margin: 0;
          box-sizing: border-box;
          white-space: pre-wrap;
          overflow-wrap: anywhere;
          cursor: text;
          border-radius: 4px;
        }
        .cp-bulk-cell-static:hover {
          background: var(--p-color-bg-surface-hover, #f6f6f7);
        }
        .cp-bulk-cell-static:focus-visible {
          outline: 2px solid var(--p-color-border-focus, #005ab4);
          outline-offset: -2px;
        }
        /* Focused text cell: visually invisible until focused, autogrows via
           JS, fills the whole grid cell so click targets aren't dead below
           the text baseline. */
        .cp-bulk-textarea {
          display: block;
          width: 100%;
          min-height: 100%;
          border: none;
          background: transparent;
          font: inherit;
          color: inherit;
          padding: 4px;
          margin: 0;
          resize: none;
          overflow: hidden;
          outline: none;
          box-sizing: border-box;
        }
        .cp-bulk-textarea:focus {
          outline: 2px solid var(--p-color-border-focus, #005ab4);
          outline-offset: -2px;
          border-radius: 4px;
          background: var(--p-color-bg-surface, #fff);
        }
        /* Cell states (§2): dirty = highlighted, error = red. */
        .cp-bulk-cell-dirty {
          background: var(--p-color-bg-surface-caution, #fff8db);
          color: var(--p-color-text-magic, #7f56d9);
        }
        .cp-bulk-textarea.cp-bulk-cell-dirty:focus {
          background: var(--p-color-bg-surface-caution, #fff8db);
        }
        .cp-bulk-cell-error {
          background: var(--p-color-bg-surface-critical, #fff0f0);
          outline: 1px solid var(--p-color-border-critical, #d72c0d);
          outline-offset: -1px;
          border-radius: 4px;
        }
        /* A select cell wears the same two states. Polaris draws the control's
           box on its Backdrop element (the one responsive.css already owns for
           the app-wide field outline), and the input above it is transparent —
           so a background on the wrapper would be hidden and these have to name
           the Backdrop. Two classes plus the descendant win on specificity, so
           the load order against Polaris' own sheet does not matter. */
        .cp-bulk-select.cp-bulk-cell-dirty .Polaris-Select__Backdrop {
          background: var(--p-color-bg-surface-caution, #fff8db);
        }
        .cp-bulk-select.cp-bulk-cell-error .Polaris-Select__Backdrop {
          background: var(--p-color-bg-surface-critical, #fff0f0);
          border-color: var(--p-color-border-critical, #d72c0d);
        }
        .cp-bulk-select.cp-bulk-cell-dirty .Polaris-Select__SelectedOption {
          color: var(--p-color-text-magic, #7f56d9);
        }
        /* Ghost (untranslated) state: the primary value greyed out in an
           empty foreign cell (§2 "▒grau▒"). The focused textarea repeats it
           as a native placeholder. */
        .cp-bulk-ghost {
          color: var(--p-color-text-disabled, #8c9196);
        }
        .cp-bulk-textarea::placeholder {
          color: var(--p-color-text-disabled, #8c9196);
          opacity: 1;
        }
        .cp-bulk-visually-hidden {
          position: absolute;
          width: 1px;
          height: 1px;
          padding: 0;
          margin: -1px;
          overflow: hidden;
          clip: rect(0 0 0 0);
          white-space: nowrap;
          border: 0;
        }
      `}</style>
      <div role="table" aria-label={caption} className="cp-bulk-grid" style={{ gridTemplateColumns }}>
        <div role="row" className="cp-bulk-row">
          <div role="columnheader" className={`cp-bulk-th${stickyClass(0)}`} />
          {displayColumns.map((col, i) => {
            const heading = columnHeading(col);
            const headingNode =
              col.id === "field.handle" ? (
                <Tooltip content={handleWarning}>
                  <span>{heading}</span>
                </Tooltip>
              ) : (
                <span>{heading}</span>
              );
            return (
              <div
                key={col.id}
                role="columnheader"
                aria-sort={ariaSort(col)}
                className={`cp-bulk-th${stickyClass(i + 1)}${
                  columnGutter[i] > 0 ? " cp-bulk-th-with-actions" : ""
                }`}
              >
                {col.sortKey ? (
                  <button
                    type="button"
                    className="cp-bulk-sort-btn"
                    onClick={() => onSortToggle(col)}
                    aria-label={`${sortButtonLabel}: ${heading}`}
                  >
                    {headingNode}
                    <span aria-hidden="true">
                      {sort?.columnId === col.id ? (sort.direction === "asc" ? "▲" : "▼") : "↕"}
                    </span>
                  </button>
                ) : (
                  headingNode
                )}
              </div>
            );
          })}
          <div role="columnheader" className="cp-bulk-th cp-bulk-edit-cell">
            {/* A real, always-visible column, so it needs a name — but a
                visible heading would cost width the icon does not need. */}
            <span className="cp-bulk-visually-hidden">{openInEditorLabel}</span>
          </div>
        </div>
        {rows.map((row, rowIndex) => {
          const rowFailure = rowLevelFailures.get(row.id);
          return (
            <div key={row.id} role="row" className="cp-bulk-row">
              <div role="cell" className={`cp-bulk-cell${stickyClass(0)}`}>
                <BulkImageCell row={row} onOpen={onPreviewImage} openLabel={previewImageLabel} />
              </div>
              {displayColumns.map((col, i) => {
                const dirty = isDirty(row, col);
                // Cell-granular failures (Plan §4.4): a failure with a
                // columnId marks exactly this cell; a row-level failure
                // (single-mutation types) falls back to the row's EDITED
                // cells (they are what the failed save tried to write).
                const cellFailure = failuresByCell.get(`${row.id}|${col.id}`);
                const error = cellFailure ?? (rowFailure && dirty ? rowFailure : undefined);
                // Editability varies per ROW now (linked options, missing
                // mediaId, rich-text metafields) — resolve it per cell. In a
                // foreign locale, non-translatable columns are additionally
                // read-only with their own tooltip (Plan §6.4).
                const resolved = resolveCellValue(row, col);
                const foreignReadOnly = isForeignLocale && !col.translatable;
                const cellReadOnly = !resolved.editable || foreignReadOnly;
                // Field colour (Plan §2). On the WRAPPER so the transparent
                // input shows it and the dirty/error inner backgrounds take
                // precedence naturally (a dirty or errored cell is never
                // recoloured).
                const status = dirty || error ? null : translationStatus(row, col);
                const statusClass =
                  status === "untranslated"
                    ? " cp-bulk-cell-untranslated"
                    : status === "missingTranslation"
                      ? " cp-bulk-cell-missing"
                      : "";
                // Blue cells only: which foreign languages still lack a
                // translation, surfaced as a native `title` tooltip on the cell
                // wrapper. A native title injects NO element, so the grid's
                // `display:contents` rows, sticky columns and the direct-child
                // `.cp-bulk-cell > .cp-bulk-textarea` flex rule all stay intact
                // (a Polaris Tooltip wrapper would break them). Read-only cells
                // keep BulkCell's own explanatory tooltip instead.
                const tip =
                  status === "missingTranslation" && !cellReadOnly ? translationTooltip?.(row, col) : null;
                return (
                  <div
                    key={col.id}
                    role="cell"
                    className={`cp-bulk-cell${stickyClass(i + 1)}${statusClass}`}
                    title={tip ?? undefined}
                  >
                    <BulkCell
                      column={col}
                      value={valueFor(row, col)}
                      readOnly={cellReadOnly}
                      readOnlyTooltip={
                        foreignReadOnly
                          ? notTranslatableTooltip
                          : resolved.readOnlyReason
                            ? readOnlyTooltips[resolved.readOnlyReason]
                            : readOnlyTooltips.column
                      }
                      ghost={
                        isForeignLocale && !foreignReadOnly && resolved.editable
                          ? ghostFor(row, col)
                          : ATTRIBUTE_BLOCK_COLUMNS.has(col.id) && row.attributesKnown === false
                            ? unknownAttributeGhost
                            : undefined
                      }
                      showOpenInEditor={resolved.readOnlyReason === "richText"}
                      openInEditorLabel={openInEditorLabel}
                      onOpenInEditor={() => onOpenInEditor(row)}
                      isDirty={dirty}
                      error={error}
                      errorId={error ? `cp-bulk-err-${type}-${rowIndex}-${i}` : undefined}
                      enumLabels={enumLabels}
                      templateSuffixes={templateSuffixes}
                      onChange={(v) => setEdit(row, col, v)}
                      cellCoord={`${rowIndex}:${i}`}
                      onNavigate={(direction) => navigateFromCell(rowIndex, i, direction)}
                      onEscape={() => onResetCell(row, col)}
                      actions={cellActions?.(row, col)}
                      onPasteText={(text) => onPasteRect(rowIndex, i, text)}
                    />
                  </div>
                );
              })}
              <div role="cell" className="cp-bulk-cell cp-bulk-edit-cell">
                <Tooltip content={openInEditorLabel} dismissOnMouseOut>
                  <Button
                    variant="tertiary"
                    // Not "micro": this is the row's primary jump-out and a
                    // touch target, so it gets a usable hit area inside the
                    // 44px track.
                    size="slim"
                    icon={EditIcon}
                    accessibilityLabel={openInEditorLabel}
                    onClick={() => onOpenInEditor(row)}
                  />
                </Tooltip>
              </div>
            </div>
          );
        })}
      </div>
    </div>
      {/* The proxy horizontal scrollbar. It is a SIBLING of the scroller, not
          a child: a child of an overflow-x:auto box sticks to THAT box's own
          scrollport (overflow-x:auto computes overflow-y to auto, so the
          scroller is a scroll container on both axes), i.e. to exactly the
          bottom edge the merchant cannot see. Out here the nearest scrollport
          is the page's <main>, so the bar pins to the bottom of the window for
          as long as the grid is on screen.

          Rendered only while the grid really overflows, and aria-hidden +
          tabIndex -1 because it carries no content: it is a second view of one
          scroll position, and keyboard cell navigation scrolls the real
          container by itself. */}
      {overflowing && (
        <div
          ref={hScrollRef}
          className="cp-bulk-hscroll"
          aria-hidden="true"
          tabIndex={-1}
          onScroll={() => syncScroll(hScrollRef.current, containerRef.current)}
        >
          <div className="cp-bulk-hscroll-spacer" style={{ width: scrollMetrics.content }} />
        </div>
      )}
    </div>
  );
}

interface BulkImageCellProps {
  row: BulkRow;
  onOpen: (row: BulkRow) => void;
  openLabel: string;
}

/**
 * Image cell: hovering reveals a dark overlay with a magnifier; clicking opens
 * the preview modal (which is also where the "open in editor" jump lives now —
 * the thumbnail is too small to judge an alt text against).
 *
 * ALWAYS a button, including for rows without an image: the modal is the only
 * remaining path to the single editor, and blog/policy/metaobject rows have no
 * thumbnail at all.
 */
function BulkImageCell({ row, onOpen, openLabel }: BulkImageCellProps) {
  return (
    <Tooltip content={openLabel}>
      <button type="button" className="cp-bulk-img-btn" onClick={() => onOpen(row)} aria-label={openLabel}>
        {row.imageUrl ? (
          <img src={row.imageUrl} alt={row.imageAlt ?? ""} className="cp-bulk-img" loading="lazy" />
        ) : (
          <span className="cp-bulk-img-placeholder" aria-hidden="true" />
        )}
        <span className="cp-bulk-img-overlay" aria-hidden="true">
          <SearchIcon />
        </span>
      </button>
    </Tooltip>
  );
}
