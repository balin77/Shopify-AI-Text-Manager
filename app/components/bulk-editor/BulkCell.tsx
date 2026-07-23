/**
 * Bulk editor — one grid cell (docs/plans/PLAN_BULK_EDITOR.md §2/§10.2).
 *
 * Cell states: unchanged · dirty (highlighted) · error (red + aria-invalid +
 * aria-describedby) · read-only (grey + tooltip).
 *
 * Browser-load measure (§10.2): text cells render as a lightweight <div> and
 * only swap in a real <textarea> when the merchant focuses/clicks the cell —
 * 250 rows × 20 columns as live textareas is exactly the load the plan caps.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button, InlineStack, Select, Text, Tooltip } from "@shopify/polaris";
import type { ColumnDescriptor } from "../../services/bulk-editor/columns.shared";

export interface BulkCellStatusOptions {
  active: string;
  draft: string;
  archived: string;
}

interface BulkCellProps {
  column: ColumnDescriptor;
  value: string;
  isDirty: boolean;
  /** Per-CELL editability (Plan §4.4): read-only can be column-wide
   * (blogTitle, rich-text metafields) or row-specific (linked option,
   * missing mediaId, missing option position). The grid resolves it via
   * resolveCellValue and passes the verdict + localized tooltip. */
  readOnly: boolean;
  readOnlyTooltip: string;
  /** rich_text_field cells render an "open in editor" jump (Plan §4.1). */
  showOpenInEditor?: boolean;
  openInEditorLabel?: string;
  onOpenInEditor?: () => void;
  /** Cell failure message from the last save — marks the cell invalid. */
  error?: string;
  /** Unique id for the visually-hidden error message (aria-describedby). */
  errorId?: string;
  /** Ghost placeholder (Phase 4, Plan §1.3): the primary value (or, under a
   * market override, the global translation) shown greyed in an EMPTY foreign
   * cell so it stays visible what needs translating. Typing over it creates
   * the translation; the ghost itself is never part of the value. */
  ghost?: string;
  statusOptions: BulkCellStatusOptions;
  onChange: (value: string) => void;
}

export function BulkCell({
  column,
  value,
  isDirty,
  readOnly,
  readOnlyTooltip,
  showOpenInEditor,
  openInEditorLabel,
  onOpenInEditor,
  error,
  errorId,
  ghost,
  statusOptions,
  onChange,
}: BulkCellProps) {
  // Read-only cells (blogTitle, rich-text metafields, linked options, …):
  // grey text + tooltip explaining why; rich-text cells additionally offer
  // the "open in editor" jump.
  if (readOnly) {
    return (
      <Tooltip content={readOnlyTooltip}>
        <InlineStack gap="100" blockAlign="center" wrap={false}>
          <Text as="span" variant="bodySm" tone="subdued" truncate>
            {value}
          </Text>
          {showOpenInEditor && onOpenInEditor && (
            <Button variant="plain" size="micro" onClick={onOpenInEditor}>
              {openInEditorLabel ?? ""}
            </Button>
          )}
        </InlineStack>
      </Tooltip>
    );
  }

  if (column.inputType === "select") {
    // Product status. Non-null in the schema, but a partial sync could leave
    // it "" — show a placeholder row instead of silently defaulting the
    // display to ACTIVE (which would cause a no-op click to write ACTIVE
    // where the DB had "").
    const hasStatus = value === "ACTIVE" || value === "DRAFT" || value === "ARCHIVED";
    return (
      <Select
        label=""
        labelHidden
        options={[
          ...(hasStatus ? [] : [{ label: "—", value: "", disabled: true } as const]),
          { label: statusOptions.active, value: "ACTIVE" },
          { label: statusOptions.draft, value: "DRAFT" },
          { label: statusOptions.archived, value: "ARCHIVED" },
        ]}
        value={hasStatus ? value : ""}
        onChange={onChange}
      />
    );
  }

  return (
    <LazyTextCell
      value={value}
      isDirty={isDirty}
      error={error}
      errorId={errorId}
      ghost={ghost}
      onChange={onChange}
    />
  );
}

interface LazyTextCellProps {
  value: string;
  isDirty: boolean;
  error?: string;
  errorId?: string;
  ghost?: string;
  onChange: (value: string) => void;
}

/**
 * Text cell that renders as a cheap, focusable <div> until the merchant
 * focuses or clicks it, then swaps in the real auto-growing textarea. The
 * div participates in the tab order (tabIndex=0) so keyboard users reach it;
 * receiving focus promotes it to the textarea, which takes focus itself.
 */
function LazyTextCell({ value, isDirty, error, errorId, ghost, onChange }: LazyTextCellProps) {
  const [editing, setEditing] = useState(false);

  const stateClass = `${isDirty ? " cp-bulk-cell-dirty" : ""}${error ? " cp-bulk-cell-error" : ""}`;
  const showGhost = value === "" && !!ghost;

  if (!editing) {
    return (
      <div
        role="textbox"
        aria-readonly={false}
        aria-multiline
        aria-invalid={error ? true : undefined}
        aria-describedby={error && errorId ? errorId : undefined}
        tabIndex={0}
        className={`cp-bulk-cell-static${stateClass}`}
        onFocus={() => setEditing(true)}
        onClick={() => setEditing(true)}
      >
        {showGhost ? (
          // Ghost (untranslated) state: the primary value greyed out. It is
          // NOT the cell's value — focusing swaps in an EMPTY textarea whose
          // placeholder repeats the ghost. aria-hidden keeps screen readers
          // on the truthful "empty" cell semantics.
          <span className="cp-bulk-ghost" aria-hidden="true">
            {ghost}
          </span>
        ) : (
          value
        )}
        {error && errorId && (
          <span id={errorId} className="cp-bulk-visually-hidden">
            {error}
          </span>
        )}
      </div>
    );
  }

  return (
    <>
      <CellTextArea
        value={value}
        onChange={onChange}
        onBlur={() => setEditing(false)}
        className={`cp-bulk-textarea${stateClass}`}
        ariaInvalid={!!error}
        ariaDescribedBy={error && errorId ? errorId : undefined}
        placeholder={ghost}
      />
      {error && errorId && (
        <span id={errorId} className="cp-bulk-visually-hidden">
          {error}
        </span>
      )}
    </>
  );
}

interface CellTextAreaProps {
  value: string;
  onChange: (value: string) => void;
  onBlur: () => void;
  className: string;
  ariaInvalid: boolean;
  ariaDescribedBy?: string;
  placeholder?: string;
}

/**
 * Borderless auto-growing textarea used by every editable text cell.
 *
 * Autogrow via scrollHeight measurement in a useLayoutEffect keyed on value:
 * we reset `style.height` to `auto`, read `scrollHeight` (the browser's
 * measurement of what the content needs), then write it back as an explicit
 * height. The paired CSS rule `min-height: 100%` (targeting the textarea
 * directly, no Polaris wrapper) ensures the textarea also fills the grid
 * cell when it's shorter than the tallest cell in the row.
 *
 * (Deliberately NOT Polaris <TextField multiline>: its internal __Resizer
 * writes an inline height that collapses the wrapper to content-height, so
 * short values render a ~30-px control with the rest of the cell dead to
 * clicks — see the original bulk-meta grid notes.)
 */
function CellTextArea({ value, onChange, onBlur, className, ariaInvalid, ariaDescribedBy, placeholder }: CellTextAreaProps) {
  const ref = useRef<HTMLTextAreaElement>(null);

  // The cell just swapped from the static div: move focus into the textarea
  // with the caret at the end, so typing continues where the merchant clicked.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    const end = el.value.length;
    try {
      el.setSelectionRange(end, end);
    } catch {
      // Some input types don't support selection ranges — focus is enough.
    }
    // Mount-only: the swap happens exactly once per editing session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Feedback-loop guard: temporarily kill min-height while measuring so
    // scrollHeight reflects the ACTUAL content, not the CSS-inflated cell
    // height. Reset height first so scrollHeight reflects CURRENT content
    // (not the previous rendered height — otherwise deleting text wouldn't
    // shrink).
    el.style.minHeight = "0px";
    el.style.height = "auto";
    const contentHeight = el.scrollHeight;
    el.style.minHeight = "";
    el.style.height = `${contentHeight}px`;
  }, [value]);

  return (
    <textarea
      ref={ref}
      className={className}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
      aria-invalid={ariaInvalid || undefined}
      aria-describedby={ariaDescribedBy}
      placeholder={placeholder}
      rows={1}
      spellCheck={false}
    />
  );
}
