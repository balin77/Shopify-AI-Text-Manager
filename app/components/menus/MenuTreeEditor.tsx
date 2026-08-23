/**
 * The menu tree editor — drag to reorder and re-nest, edit in place.
 *
 * dnd-kit has no tree component. The established shape (and the one its own
 * SortableTree example uses) is to FLATTEN the tree into a list, sort that,
 * and express nesting through the horizontal offset of the drag.
 *
 * There is deliberately NO `DragOverlay`: the row being dragged is the row
 * that moves. The overlay is dnd-kit's usual answer, but it puts a second
 * object on screen — a floating copy under the cursor while the original stays
 * in place, dimmed — and with rows this tall that reads as two things moving
 * at once rather than as one being carried. Everything
 * about that translation — including the depth clamp Shopify measurably
 * enforces — lives in `projectDrop` in menu-tree.shared.ts, so it can be
 * tested without a DOM. This component is the hands: sensors, rendering, and
 * turning a finished drag into `moveNode`.
 *
 * Two rules of this codebase apply and are easy to miss here:
 *
 *   The rows are Polaris fields, so the app's field chrome comes from
 *   FieldChrome / AIEditableField rather than from anything invented here.
 *
 *   A drag must be reachable from the keyboard. `KeyboardSensor` with dnd-kit's
 *   sortable coordinate getter moves an item up and down; left and right
 *   change its depth through the same projection the pointer uses.
 */

import { useMemo, useState } from "react";
import {
  DndContext,
  KeyboardSensor,
  MeasuringStrategy,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  sortableKeyboardCoordinates,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Button, Text, TextField, Tooltip } from "@shopify/polaris";
import {
  MAX_MENU_DEPTH,
  dropIndexAmongSiblings,
  findNode,
  flattenEditorTree,
  moveNode,
  projectDrop,
  subtreeHeight,
  type FlatEditorItem,
  type MenuEditorNode,
} from "~/services/menu-tree.shared";

/** One indent step, in pixels. The drag's horizontal offset is read in these. */
const INDENT_WIDTH = 28;

export interface MenuTreeEditorStrings {
  dragHandle: string;
  addChild: string;
  deleteItem: string;
  maxDepthReached: string;
  /** Shown under an item that cannot be translated (foreign locale only). */
  notTranslatable?: string;
}

export interface MenuTreeEditorProps {
  nodes: MenuEditorNode[];
  onChange: (nodes: MenuEditorNode[]) => void;
  /** Renders the row's editable field — the page owns what a field means. */
  renderField: (node: MenuEditorNode, flat: FlatEditorItem) => React.ReactNode;
  /**
   * Renders the row's TARGET control, or nothing where there is none (a
   * foreign locale does not retarget).
   *
   * Its own render prop rather than part of `renderField`, because the two
   * are placed independently: side by side while there is room, and stacked
   * with the action row BETWEEN them when there is not — which no single
   * returned node could express.
   */
  renderTarget?: (node: MenuEditorNode, flat: FlatEditorItem) => React.ReactNode;
  /** Renders the row's per-item actions (translate, copy, …). */
  renderActions?: (node: MenuEditorNode, flat: FlatEditorItem) => React.ReactNode;
  onDelete?: (node: MenuEditorNode) => void;
  onAddChild?: (node: MenuEditorNode) => void;
  /** Structure editing off — the foreign-locale view only translates. */
  structureLocked?: boolean;
  strings: MenuTreeEditorStrings;
}

export function MenuTreeEditor({
  nodes,
  onChange,
  renderField,
  renderTarget,
  renderActions,
  onDelete,
  onAddChild,
  structureLocked = false,
  strings,
}: MenuTreeEditorProps) {
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [offsetX, setOffsetX] = useState(0);
  const [overKey, setOverKey] = useState<string | null>(null);
  /**
   * A keyboard drag REORDERS, it does not re-nest.
   *
   * The rows are indented with margin, so moving between two rows of different
   * depth produces a horizontal delta the projection would read as an intent
   * to change the parent — and a change of parent destroys that item's
   * translations (measured). Nobody pressing ArrowDown means that. Depth stays
   * put until there is a deliberate keyboard gesture for it, and the header
   * comment no longer claims otherwise.
   */
  const [keyboardDrag, setKeyboardDrag] = useState(false);

  const flat = useMemo(() => flattenEditorTree(nodes), [nodes]);

  /**
   * While a branch is dragged, its own descendants are hidden — they travel
   * with it, and a placeholder that shows them mid-flight reads as if the
   * merchant were dropping an item into itself.
   */
  const visible = useMemo(() => {
    if (!activeKey) return flat;
    const hidden = new Set<string>();
    const collect = (parent: string) => {
      for (const item of flat) {
        if (item.parentKey === parent && !hidden.has(item.key)) {
          hidden.add(item.key);
          collect(item.key);
        }
      }
    };
    collect(activeKey);
    return flat.filter((i) => !hidden.has(i.key));
  }, [flat, activeKey]);

  const projection = useMemo(() => {
    if (!activeKey || !overKey) return null;
    const active = findNode(nodes, activeKey);
    return projectDrop(flat, activeKey, overKey, offsetX, INDENT_WIDTH, active ? subtreeHeight(active) : 1);
  }, [activeKey, overKey, offsetX, flat, nodes]);

  const sensors = useSensors(
    useSensor(MouseSensor),
    useSensor(TouchSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragStart = ({ active, activatorEvent }: DragStartEvent) => {
    setActiveKey(String(active.id));
    setOverKey(String(active.id));
    setOffsetX(0);
    setKeyboardDrag(
      typeof KeyboardEvent !== "undefined" && activatorEvent instanceof KeyboardEvent,
    );
  };

  const handleDragMove = ({ delta, over }: DragMoveEvent) => {
    if (!keyboardDrag) setOffsetX(delta.x);
    if (over) setOverKey(String(over.id));
  };

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    const key = String(active.id);
    const projected = projection;
    setActiveKey(null);
    setOverKey(null);
    setOffsetX(0);
    setKeyboardDrag(false);
    if (!over || !projected) return;

    // Where among its new siblings does it land? Pure, tested, and next to the
    // projection it has to agree with.
    const index = dropIndexAmongSiblings(visible, key, String(over.id), projected.parentKey);
    const next = moveNode(nodes, key, projected.parentKey, index);
    if (next !== nodes) onChange(next);
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      // The list changes height when a branch collapses under the cursor, so
      // dnd-kit has to re-measure rather than work from stale rectangles.
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      onDragStart={handleDragStart}
      onDragMove={handleDragMove}
      onDragEnd={handleDragEnd}
      onDragCancel={() => {
        setActiveKey(null);
        setOverKey(null);
        setOffsetX(0);
        setKeyboardDrag(false);
      }}
    >
      <SortableContext items={visible.map((i) => i.key)} strategy={verticalListSortingStrategy}>
        <div>
          {visible.map((item) => (
            <MenuTreeRow
              key={item.key}
              item={item}
              depth={activeKey === item.key && projection ? projection.depth : item.depth}
              renderField={renderField}
              renderTarget={renderTarget}
              renderActions={renderActions}
              onDelete={onDelete}
              onAddChild={onAddChild}
              structureLocked={structureLocked}
              strings={strings}
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}

interface MenuTreeRowProps {
  item: FlatEditorItem;
  depth: number;
  renderField: MenuTreeEditorProps["renderField"];
  renderTarget?: MenuTreeEditorProps["renderTarget"];
  renderActions?: MenuTreeEditorProps["renderActions"];
  onDelete?: MenuTreeEditorProps["onDelete"];
  onAddChild?: MenuTreeEditorProps["onAddChild"];
  structureLocked: boolean;
  strings: MenuTreeEditorStrings;
}

function MenuTreeRow({
  item,
  depth,
  renderField,
  renderTarget,
  renderActions,
  onDelete,
  onAddChild,
  structureLocked,
  strings,
}: MenuTreeRowProps) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: item.key, disabled: structureLocked });

  const canAddChild = !structureLocked && depth < MAX_MENU_DEPTH;
  const target = renderTarget?.(item.node, item);

  return (
    <div
      ref={setNodeRef}
      className="menu-tree-row"
      style={
        {
          transform: CSS.Translate.toString(transform),
          transition,
          // The ROW is what the merchant drags. There used to be a `DragOverlay`
          // — a copy of the title floating under the cursor while the real row
          // stayed put and dimmed — and it read as two things moving at once.
          // Without it, `useSortable` translates this element itself, so there
          // is one object on screen and it is the one being moved. It only has
          // to sit ABOVE its neighbours on the way past them; dimming it would
          // now be dimming the thing under the cursor.
          zIndex: isDragging ? 2 : undefined,
          position: isDragging ? "relative" : undefined,
          marginBottom: "0.75rem",
          // Depth as a VARIABLE, not as a margin on the row.
          //
          // A margin here shifted the whole grid, so a nested row's name box
          // ended further right than a top-level one's and the target column
          // started at a different x on every line — a ragged right edge down
          // the middle of the page. The stylesheet spends it on the NAME cell
          // instead: the left edge moves with the depth, the right edge is the
          // column boundary and does not move, and every target box therefore
          // begins at the same place. On a phone, where the two boxes stack and
          // there is no column to line up, it goes back to being the row's own
          // indent so the stacked pair reads as one item.
          "--menu-row-indent": `${(depth - 1) * INDENT_WIDTH}px`,
        } as React.CSSProperties
      }
    >
      {/* Name, target and actions are placed by ONE grid rather than
          stacked, because their arrangement differs between the two widths
          in a way stacking cannot express: side by side with the actions
          running underneath both, or one above the other with the actions
          BETWEEN them. The rules live in MenuTreeRow.css; the modifiers are
          here because only this component knows whether there is a target at
          all (a foreign locale has none, and an empty second column would
          leave the name box at half width) and whether there is a handle to
          reserve a lane for. */}
      <div
        className={[
          "menu-row-grid",
          target ? "" : "menu-row-grid--no-target",
          structureLocked ? "menu-row-grid--no-handle" : "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        <div className="menu-row-name">
          {/* The handle lives INSIDE the name cell, absolutely positioned
              against it. It has to step in with the nesting like everything
              else in the row — but it cannot do that from a flex lane in
              front of the grid, because then its own offset would push the
              grid and the target column would go ragged again, which is the
              defect the indent was just moved off the row to fix. Out of
              flow, it indents freely: the cell reserves the lane in its
              padding, the handle sits at the lane's left edge, and the grid
              starts at the same x on every row. */}
          {!structureLocked && (
            <div
              ref={setActivatorNodeRef}
              {...attributes}
              {...listeners}
              aria-label={strings.dragHandle}
              className="menu-row-handle"
            >
              ⠿
            </div>
          )}
          {renderField(item.node, item)}
        </div>
        {target && <div className="menu-row-target">{target}</div>}
        <div className="menu-row-actions">
          {renderActions?.(item.node, item)}
          {canAddChild && onAddChild && (
            <Button size="slim" variant="tertiary" onClick={() => onAddChild(item.node)}>
              {strings.addChild}
            </Button>
          )}
          {!structureLocked && depth >= MAX_MENU_DEPTH && onAddChild && (
            // Said rather than hidden: a merchant who cannot find "add below"
            // on the third level should learn why, not hunt for it.
            <Tooltip content={strings.maxDepthReached}>
              <Text as="span" variant="bodySm" tone="subdued">
                {strings.maxDepthReached}
              </Text>
            </Tooltip>
          )}
          {!structureLocked && onDelete && (
            <Button size="slim" variant="tertiary" tone="critical" onClick={() => onDelete(item.node)}>
              {strings.deleteItem}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * A blank item for the "add" button.
 *
 * The key is minted here and never derived from the title: a merchant who
 * types the same name twice would otherwise collide two nodes into one, and
 * the diff matches on keys.
 */
export function newMenuNode(sequence: number): MenuEditorNode {
  return {
    id: null,
    key: `new-${sequence}`,
    title: "",
    type: "HTTP",
    url: "",
    children: [],
  };
}

/** The plain field a new item's title uses before anything else exists. */
export function MenuNodeTitleField({
  value,
  onChange,
  label,
  disabled,
  error,
  helpText,
}: {
  value: string;
  onChange: (next: string) => void;
  label: React.ReactNode;
  disabled?: boolean;
  error?: string;
  helpText?: string;
}) {
  return (
    <TextField
      label={label as string}
      value={value}
      onChange={onChange}
      disabled={disabled}
      error={error}
      helpText={helpText}
      autoComplete="off"
    />
  );
}
