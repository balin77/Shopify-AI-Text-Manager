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
 * the title column stay pinned while the grid scrolls horizontally.
 */

import { Text, Tooltip } from "@shopify/polaris";
import { EditIcon } from "@shopify/polaris-icons";
import {
  resolveCellValue,
  type BulkRow,
  type BulkRowType,
  type BulkSort,
  type CellReadOnlyReason,
  type ColumnDescriptor,
} from "../../services/bulk-editor/columns.shared";
import { BulkCell, type BulkCellStatusOptions } from "./BulkCell";

/** Fixed image-column width — must be a constant so the sticky title column
 * can sit at left:72px. */
const IMAGE_COLUMN_WIDTH = 72;

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
  columnHeading: (column: ColumnDescriptor) => string;
  statusOptions: BulkCellStatusOptions;
  handleWarning: string;
  /** Localized read-only explanations per reason (Plan §4.1–§4.3). */
  readOnlyTooltips: Record<CellReadOnlyReason, string>;
  sortButtonLabel: string;
  /** Visually-hidden table label — the localized content-type name. */
  caption: string;
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
  notTranslatableTooltip,
  failuresByCell,
  rowLevelFailures,
  sort,
  onSortToggle,
  openInEditorLabel,
  onOpenInEditor,
  columnHeading,
  statusOptions,
  handleWarning,
  readOnlyTooltips,
  sortButtonLabel,
  caption,
}: BulkGridProps) {
  // Image column is ALWAYS the leftmost cell and doubles as the
  // "open in editor" affordance via a hover overlay (see BulkImageCell) —
  // consistent across every content type, so pages get the same left-side
  // editor hook (rendered as a placeholder since page rows have no imageUrl).
  const displayColumns = columns.filter((c) => c.id !== "image");
  // Sticky pinning: image at left:0, title (canonically the first data
  // column) at left:72px — but only when title actually renders directly
  // after the image, otherwise a gap column would scroll underneath it.
  // Variant rows (Plan §5.3) pin the product-title CONTEXT column instead.
  const titleSticky =
    displayColumns[0]?.id === "field.title" || displayColumns[0]?.id === "productTitle";

  const gridTemplateColumns = [
    `${IMAGE_COLUMN_WIDTH}px`,
    ...displayColumns.map((c) => `minmax(${c.minWidth}px, 1fr)`),
  ].join(" ");

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
    <div style={{ overflowX: "auto", width: "100%" }} className="cp-bulk-scroll">
      <style>{`
        .cp-bulk-grid {
          display: grid;
          min-width: 100%;
          width: max-content;
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
           Select keep their intrinsic sizing. */
        .cp-bulk-cell > .cp-bulk-textarea,
        .cp-bulk-cell > .cp-bulk-cell-static {
          flex: 1 1 auto;
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
                className={`cp-bulk-th${stickyClass(i + 1)}`}
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
        </div>
        {rows.map((row, rowIndex) => {
          const rowFailure = rowLevelFailures.get(row.id);
          return (
            <div key={row.id} role="row" className="cp-bulk-row">
              <div role="cell" className={`cp-bulk-cell${stickyClass(0)}`}>
                <BulkImageCell row={row} onOpen={onOpenInEditor} openLabel={openInEditorLabel} />
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
                return (
                  <div key={col.id} role="cell" className={`cp-bulk-cell${stickyClass(i + 1)}`}>
                    <BulkCell
                      column={col}
                      value={valueFor(row, col)}
                      readOnly={!resolved.editable || foreignReadOnly}
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
                          : undefined
                      }
                      showOpenInEditor={resolved.readOnlyReason === "richText"}
                      openInEditorLabel={openInEditorLabel}
                      onOpenInEditor={() => onOpenInEditor(row)}
                      isDirty={dirty}
                      error={error}
                      errorId={error ? `cp-bulk-err-${type}-${rowIndex}-${i}` : undefined}
                      statusOptions={statusOptions}
                      onChange={(v) => setEdit(row, col, v)}
                    />
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface BulkImageCellProps {
  row: BulkRow;
  onOpen: (row: BulkRow) => void;
  openLabel: string;
}

/**
 * Image cell that doubles as the "open in editor" affordance: hovering
 * reveals a dark overlay with a pencil icon; clicking anywhere on the cell
 * jumps to the full editor for that row. Rows with no imageUrl render a
 * placeholder box so the affordance is uniform across all rows of the type.
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
          <EditIcon />
        </span>
      </button>
    </Tooltip>
  );
}
