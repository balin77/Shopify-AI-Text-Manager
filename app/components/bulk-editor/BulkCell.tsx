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

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { ActionList, Button, Icon, InlineStack, Popover, Select, Spinner, Text, Tooltip } from "@shopify/polaris";
import { MenuVerticalIcon } from "@shopify/polaris-icons";
import type { ColumnDescriptor } from "../../services/bulk-editor/columns.shared";

/** Keyboard navigation directions (Plan §8.4): Tab/Shift-Tab walk the
 * editable cells, Enter goes one row down in the same column. */
export type CellNavDirection = "next" | "prev" | "down";

export interface BulkCellStatusOptions {
  active: string;
  draft: string;
  archived: string;
  unlisted: string;
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
  /** Grid coordinate "row:col" — stamped as data-cp-cell on the focusable
   * element so BulkGrid can move focus for Tab/Enter navigation (§8.4). Text
   * cells only; the status Select keeps its native keyboard handling. */
  cellCoord?: string;
  /** Tab/Shift-Tab/Enter navigation (§8.4) — the grid resolves the target
   * cell and focuses it (lazy textarea swap included). */
  onNavigate?: (direction: CellNavDirection) => void;
  /** Esc (§8.4): reset the cell to its load value (drop the edit-map entry). */
  onEscape?: () => void;
  /** Raw paste hook (§8.3): return true to consume the paste (rectangle
   * distribution); false lets the browser paste normally into the textarea. */
  onPasteText?: (text: string) => boolean;
  /** Per-cell actions, revealed on hover/focus as a three-dot menu. Absent =
   * no menu (read-only cells, and columns none of the actions can serve). */
  actions?: BulkCellActions;
}

/**
 * The same three field actions the content editor offers, per grid cell. Each
 * produces an EDIT — nothing is written until the merchant saves, so they ride
 * the ordinary diff pipeline like a typed value.
 */
export interface BulkCellActions {
  /** AI-improve the value of the CURRENT view. */
  onImprove?: () => void;
  /** Translate the primary value into every active foreign language. */
  onTranslateAll?: () => void;
  /** Copy the primary value into every active foreign language, verbatim. */
  onCopyAll?: () => void;
  /**
   * Why the two fan-out actions cannot run (a single-language shop, or every
   * foreign language switched off). Set ⇒ both entries STAY in the menu,
   * disabled and carrying this as their help text — hiding them would read as
   * "the feature is missing" (CLAUDE.md single-language rules; an ActionList
   * cannot show a hover tooltip, so `disabled` + `helpText` is the form).
   */
  fanOutDisabledReason?: string;
  /** Why COPY alone cannot run (a URL handle: an identical slug across
   * locales is rejected by the write path). Same disabled+helpText form. */
  copyDisabledReason?: string;
  busy?: boolean;
  labels: {
    menu: string;
    busy: string;
    improve: string;
    translateAll: string;
    copyAll: string;
  };
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
  cellCoord,
  onNavigate,
  onEscape,
  onPasteText,
  actions,
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
    // UNLISTED is a real Shopify status (confirmed against live shop data) and
    // IS settable: the 2025-10 ProductStatus enum lists UNLISTED and the docs
    // name `ProductInput` (the input `productUpdate` takes, which is what
    // apply.server.ts sends) among the inputs that accept it. The docs' one
    // restriction — "can't be changed from unlisted in older versions" — is
    // scoped to pre-2025-10 versions, where the value is translated to active
    // and is not part of the enum at all. The app pins 2025-10 by default
    // (shopify.server.ts), so it is offered as a normal choice here; the
    // matching server-side gate is PRODUCT_STATUSES in apply.server.ts, which
    // must list exactly these four values. Source:
    // https://shopify.dev/docs/api/admin-graphql/2025-10/enums/ProductStatus
    const hasStatus =
      value === "ACTIVE" || value === "DRAFT" || value === "UNLISTED" || value === "ARCHIVED";
    return (
      <Select
        label=""
        labelHidden
        options={[
          ...(hasStatus ? [] : [{ label: "—", value: "", disabled: true } as const]),
          { label: statusOptions.active, value: "ACTIVE" },
          { label: statusOptions.draft, value: "DRAFT" },
          { label: statusOptions.unlisted, value: "UNLISTED" },
          { label: statusOptions.archived, value: "ARCHIVED" },
        ]}
        value={hasStatus ? value : ""}
        onChange={onChange}
      />
    );
  }

  const cell = (
    <LazyTextCell
      value={value}
      isDirty={isDirty}
      error={error}
      errorId={errorId}
      ghost={ghost}
      onChange={onChange}
      cellCoord={cellCoord}
      onNavigate={onNavigate}
      onEscape={onEscape}
      onPasteText={onPasteText}
    />
  );
  const hasMenu =
    !!actions && (!!actions.onImprove || !!actions.onTranslateAll || !!actions.onCopyAll || !!actions.fanOutDisabledReason);
  if (!actions || !hasMenu) return cell;
  return <BulkCellWithActions actions={actions}>{cell}</BulkCellWithActions>;
}

/**
 * Wraps a cell's control and its action menu, and owns the menu's open state
 * so the CELL can open it from the keyboard.
 *
 * That is not a nicety: CellTextArea consumes Tab and Shift-Tab for grid
 * navigation, and focusing a cell promotes it straight into that textarea — so
 * the three-dot button is never in anyone's tab order, and the three actions
 * would have no keyboard path at all. Shift+F10 and the ContextMenu key are
 * the platform gestures for "open this element's menu"; the events bubble up
 * from the textarea, which does not touch either key.
 */
function BulkCellWithActions({ actions, children }: { actions: BulkCellActions; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className="cp-bulk-cell-with-actions"
      onKeyDown={(event) => {
        if (event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey)) return;
        event.preventDefault();
        setOpen(true);
      }}
    >
      {children}
      <BulkCellMenu actions={actions} open={open} onOpenChange={setOpen} />
    </div>
  );
}

/**
 * Three vertical dots at the cell's right edge — hidden until the cell is
 * hovered or focused (CSS in BulkGrid), so a 250-row grid does not turn into a
 * wall of icons.
 */
export function BulkCellMenu({
  actions,
  open,
  onOpenChange,
  positioned = true,
}: {
  actions: BulkCellActions;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Inside a grid cell the menu is absolutely positioned in the reserved
   * gutter. Elsewhere (the image preview modal) it is an ordinary inline
   * control that must not be pulled out of flow. Defaults to the grid case. */
  positioned?: boolean;
}) {
  const setOpen = onOpenChange;
  const buttonRef = useRef<HTMLButtonElement>(null);
  const fanOutDisabled = actions.fanOutDisabledReason;
  // While an AI call for this cell runs, every entry is disabled: a second run
  // would spend a second provider call and overwrite the first one's result.
  const busyDisabled = actions.busy ? actions.labels.busy : undefined;
  const items: { content: string; onAction?: () => void; disabled?: boolean; helpText?: string }[] = [];

  /** Closing from an item handler bypasses Polaris' own focus restore (it only
   * runs for Escape/focus-out), which would drop focus to <body>. */
  const runAndClose = (action?: () => void) => () => {
    setOpen(false);
    buttonRef.current?.focus();
    action?.();
  };
  const entry = (content: string, reason: string | undefined, action?: () => void) =>
    reason ? { content, disabled: true, helpText: reason } : { content, onAction: runAndClose(action) };

  if (actions.onImprove || busyDisabled) {
    items.push(entry(`✨ ${actions.labels.improve}`, busyDisabled, actions.onImprove));
  }
  if (actions.onTranslateAll || fanOutDisabled || busyDisabled) {
    items.push(
      entry(`🌍 ${actions.labels.translateAll}`, busyDisabled ?? fanOutDisabled, actions.onTranslateAll),
    );
  }
  if (actions.onCopyAll || fanOutDisabled || actions.copyDisabledReason || busyDisabled) {
    items.push(
      entry(
        `📋 ${actions.labels.copyAll}`,
        busyDisabled ?? fanOutDisabled ?? actions.copyDisabledReason,
        actions.onCopyAll,
      ),
    );
  }

  return (
    // Keeps the dots visible while their own menu is open: the popover content
    // is portalled out of the cell, so neither :hover nor :focus-within holds
    // once the pointer or focus moves into the list.
    <span className={`${positioned ? "cp-bulk-cell-actions" : "cp-bulk-cell-actions-inline"}${open ? " cp-bulk-cell-actions-open" : ""}`}>
      <Popover
        active={open}
        onClose={() => setOpen(false)}
        preferredAlignment="right"
        activator={
          <button
            ref={buttonRef}
            type="button"
            className="cp-bulk-cell-menu-btn"
            aria-label={actions.labels.menu}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-busy={actions.busy ? true : undefined}
            onClick={() => setOpen(!open)}
          >
            {actions.busy ? (
              // hasFocusableParent keeps Polaris from rendering a role="status"
              // live region inside the button — without it every busy flip
              // re-announces the button on a screen reader.
              <Spinner size="small" hasFocusableParent accessibilityLabel={actions.labels.busy} />
            ) : (
              <Icon source={MenuVerticalIcon} />
            )}
          </button>
        }
      >
        <ActionList actionRole="menuitem" items={items} />
      </Popover>
    </span>
  );
}

interface LazyTextCellProps {
  value: string;
  isDirty: boolean;
  error?: string;
  errorId?: string;
  ghost?: string;
  onChange: (value: string) => void;
  cellCoord?: string;
  onNavigate?: (direction: CellNavDirection) => void;
  onEscape?: () => void;
  onPasteText?: (text: string) => boolean;
}

/**
 * Text cell that renders as a cheap, focusable <div> until the merchant
 * focuses or clicks it, then swaps in the real auto-growing textarea. The
 * div participates in the tab order (tabIndex=0) so keyboard users reach it;
 * receiving focus promotes it to the textarea, which takes focus itself.
 * Both incarnations carry data-cp-cell, so grid keyboard navigation (§8.4)
 * can focus the cell in either state — focusing the static div swaps in the
 * textarea automatically.
 */
function LazyTextCell({
  value,
  isDirty,
  error,
  errorId,
  ghost,
  onChange,
  cellCoord,
  onNavigate,
  onEscape,
  onPasteText,
}: LazyTextCellProps) {
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
        data-cp-cell={cellCoord}
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
        cellCoord={cellCoord}
        onNavigate={onNavigate}
        onEscape={onEscape}
        onPasteText={onPasteText}
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
  cellCoord?: string;
  onNavigate?: (direction: CellNavDirection) => void;
  onEscape?: () => void;
  onPasteText?: (text: string) => boolean;
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
function CellTextArea({
  value,
  onChange,
  onBlur,
  className,
  ariaInvalid,
  ariaDescribedBy,
  placeholder,
  cellCoord,
  onNavigate,
  onEscape,
  onPasteText,
}: CellTextAreaProps) {
  const ref = useRef<HTMLTextAreaElement>(null);

  // Keyboard contract (§8.4): Tab/Shift-Tab walk the editable cells, Enter
  // moves one row down in the same column (Shift+Enter keeps inserting a
  // line break in multi-line cells), Esc resets the cell to its load value.
  // Ctrl/Cmd+Z is NOT handled here — the route intercepts it at the grid
  // container (edit-map history, not the browser's per-textarea undo).
  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Tab" && onNavigate) {
      e.preventDefault();
      onNavigate(e.shiftKey ? "prev" : "next");
    } else if (e.key === "Enter" && !e.shiftKey && onNavigate) {
      e.preventDefault();
      onNavigate("down");
    } else if (e.key === "Escape" && onEscape) {
      e.preventDefault();
      onEscape();
    }
  };

  // §8.3: a clipboard rectangle (tab AND newline) is distributed over the
  // grid by the route's handler; it returns true to consume the event —
  // anything else pastes normally into this textarea.
  const handlePaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!onPasteText) return;
    const text = e.clipboardData.getData("text/plain");
    if (text && onPasteText(text)) e.preventDefault();
  };

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
      onKeyDown={handleKeyDown}
      onPaste={handlePaste}
      aria-invalid={ariaInvalid || undefined}
      aria-describedby={ariaDescribedBy}
      placeholder={placeholder}
      data-cp-cell={cellCoord}
      rows={1}
      spellCheck={false}
    />
  );
}
