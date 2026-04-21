import { useMemo } from "react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  arrayMove,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { InlineStack, Text, Badge, Button } from "@shopify/polaris";
import { DeleteIcon } from "@shopify/polaris-icons";
import type { StagedItem } from "./types";

interface SortableItemRowProps {
  item: StagedItem;
  variantTitle?: string;
  onRemove: (uniqueId: string) => void;
}

function SortableItemRow({ item, variantTitle, onRemove }: SortableItemRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: item.uniqueId });

  const style: React.CSSProperties = {
    transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
    transition,
    zIndex: isDragging ? 1000 : undefined,
    listStyle: "none",
    marginBottom: 4,
  };

  const identifier = item.parsedMeta?.identifier ?? item.fileName ?? item.uniqueId;
  const productName = item.parsedMeta?.productName ?? "—";
  const assignmentBadge = item.assignmentMode === "assigned"
    ? <Badge tone="success">Zugewiesen</Badge>
    : item.assignmentMode === "manual"
    ? <Badge tone="info">Manuell</Badge>
    : <Badge tone="attention">Nicht zugewiesen</Badge>;

  return (
    <li ref={setNodeRef} style={style}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 8px",
          background: "var(--p-color-bg-surface)",
          borderRadius: 6,
          border: "1px solid var(--p-color-border)",
        }}
      >
        {/* Drag handle */}
        <div
          {...attributes}
          {...listeners}
          style={{ cursor: "grab", opacity: 0.5, fontSize: 16, flexShrink: 0 }}
          title="Verschieben"
        >
          ⠿
        </div>

        {/* Preview */}
        <img
          src={item.previewUrl}
          alt={identifier}
          style={{ width: 40, height: 40, objectFit: "cover", borderRadius: 4, flexShrink: 0 }}
        />

        {/* Info */}
        <div style={{ flex: 1, minWidth: 0, display: "flex", gap: 12, alignItems: "center" }}>
          <Text as="span" variant="bodySm" truncate>
            <strong>{productName}</strong>
          </Text>
          <Text as="span" variant="bodySm" tone="subdued" truncate>
            ID: {identifier}
          </Text>
          {variantTitle && (
            <Text as="span" variant="bodySm" truncate>
              → {variantTitle}
            </Text>
          )}
        </div>

        <InlineStack gap="200" blockAlign="center">
          {assignmentBadge}
          <div onPointerDown={e => e.stopPropagation()}>
            <Button
              icon={DeleteIcon}
              variant="plain"
              tone="critical"
              onClick={() => onRemove(item.uniqueId)}
              accessibilityLabel="Entfernen"
            />
          </div>
        </InlineStack>
      </div>
    </li>
  );
}

interface BulkSortableListProps {
  items: StagedItem[];
  variantTitles?: Record<string, string>;
  onReorder: (newOrder: StagedItem[]) => void;
  onRemove: (uniqueId: string) => void;
}

export function BulkSortableList({ items, variantTitles = {}, onReorder, onRemove }: BulkSortableListProps) {
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor)
  );

  const sortedItems = useMemo(
    () => [...items].sort((a, b) => {
      const ia = a.parsedMeta?.identifier ?? a.fileName ?? "";
      const ib = b.parsedMeta?.identifier ?? b.fileName ?? "";
      return ia.localeCompare(ib, undefined, { numeric: true });
    }),
    [items]
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = sortedItems.findIndex(i => i.uniqueId === active.id);
    const newIndex = sortedItems.findIndex(i => i.uniqueId === over.id);
    onReorder(arrayMove(sortedItems, oldIndex, newIndex));
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={sortedItems.map(i => i.uniqueId)} strategy={verticalListSortingStrategy}>
        <div>
          <Text as="p" variant="bodyMd" fontWeight="semibold">
            Reihenfolge anpassen ({sortedItems.length} Bilder)
          </Text>
          <ul style={{ padding: 0, margin: "8px 0 0" }}>
            {sortedItems.map(item => (
              <SortableItemRow
                key={item.uniqueId}
                item={item}
                variantTitle={item.targetVariantId ? variantTitles[item.targetVariantId] : undefined}
                onRemove={onRemove}
              />
            ))}
          </ul>
        </div>
      </SortableContext>
    </DndContext>
  );
}
