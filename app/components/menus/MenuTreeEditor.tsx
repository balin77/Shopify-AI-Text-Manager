/**
 * The menu tree editor — drag to reorder and re-nest, edit in place.
 *
 * dnd-kit has no tree component. The established shape (and the one its own
 * SortableTree example uses) is to FLATTEN the tree into a list, sort that,
 * and express nesting through the horizontal offset of the drag. Everything
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
  DragOverlay,
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
import { Button, InlineStack, Text, TextField, Tooltip } from "@shopify/polaris";
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

  const activeNode = activeKey ? findNode(nodes, activeKey) : null;

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
              renderActions={renderActions}
              onDelete={onDelete}
              onAddChild={onAddChild}
              structureLocked={structureLocked}
              strings={strings}
            />
          ))}
        </div>
      </SortableContext>
      {/* The overlay is what the merchant drags: without it the row stays in
          place and only a gap moves, which reads as a broken drag. */}
      <DragOverlay>
        {activeNode ? (
          <div
            style={{
              padding: "0.5rem 0.75rem",
              background: "var(--p-color-bg-surface, #fff)",
              border: "1px solid var(--app-surface-border-color)",
              borderRadius: "8px",
              boxShadow: "0 4px 12px rgba(0,0,0,0.12)",
            }}
          >
            <Text as="span" variant="bodyMd">{activeNode.title}</Text>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

interface MenuTreeRowProps {
  item: FlatEditorItem;
  depth: number;
  renderField: MenuTreeEditorProps["renderField"];
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
  renderActions,
  onDelete,
  onAddChild,
  structureLocked,
  strings,
}: MenuTreeRowProps) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: item.key, disabled: structureLocked });

  const canAddChild = !structureLocked && depth < MAX_MENU_DEPTH;

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
        // The dragged row keeps its space but goes quiet — the overlay above
        // is the thing that moves.
        opacity: isDragging ? 0.4 : 1,
        marginLeft: `${(depth - 1) * INDENT_WIDTH}px`,
        marginBottom: "0.75rem",
      }}
    >
      <InlineStack gap="200" blockAlign="start" wrap={false}>
        {!structureLocked && (
          <div
            ref={setActivatorNodeRef}
            {...attributes}
            {...listeners}
            aria-label={strings.dragHandle}
            style={{
              cursor: "grab",
              padding: "0.5rem 0.25rem",
              // The handle sits beside a Polaris field whose own label row is
              // above the box; a fixed nudge keeps it on the box's line.
              marginTop: "1.5rem",
              color: "var(--p-color-icon-secondary, #6d7175)",
              touchAction: "none",
              userSelect: "none",
            }}
          >
            ⠿
          </div>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>{renderField(item.node, item)}</div>
      </InlineStack>
      <InlineStack gap="200" align="end" blockAlign="center">
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
      </InlineStack>
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
