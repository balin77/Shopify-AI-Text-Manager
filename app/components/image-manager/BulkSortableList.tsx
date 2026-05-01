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
import { useI18n } from "../../contexts/I18nContext";
import type { StagedItem } from "./types";

interface SortableItemRowProps {
  item: StagedItem;
  variantTitle?: string;
  variantCount: number;
  onRemove: (uniqueId: string) => void;
}

function SortableItemRow({ item, variantTitle, variantCount, onRemove }: SortableItemRowProps) {
  const { t } = useI18n();
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
  const im = t.imageManager;
  const assignmentBadge = item.assignmentMode === "assigned"
    ? <Badge tone="success">{im.bulkAssigned?.replace("{count}", "") ?? "✓"}</Badge>
    : item.assignmentMode === "manual"
    ? <Badge tone="info">{im.unassigned ?? "Manual"}</Badge>
    : <Badge tone="attention">{im.unassigned ?? "?"}</Badge>;

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
          {variantCount > 1 && (
            <Badge>{`×${variantCount}`}</Badge>
          )}
          {assignmentBadge}
          <div onPointerDown={e => e.stopPropagation()}>
            <Button
              icon={DeleteIcon}
              variant="plain"
              tone="critical"
              onClick={() => onRemove(item.uniqueId)}
              accessibilityLabel={t.imageManager.remove?.replace(" ({count})", "") ?? "Remove"}
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
  onRemove: (uniqueIds: string[]) => void;
}

export function BulkSortableList({ items, variantTitles = {}, onReorder, onRemove }: BulkSortableListProps) {
  const { t } = useI18n();
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor)
  );

  // One representative per identifier — maintain array order so drag-and-drop order persists
  const uniqueItems = useMemo(() => {
    const seen = new Set<string>();
    return items.filter(item => {
      const key = item.parsedMeta?.identifier ?? item.fileName ?? item.uniqueId;
      if (!seen.has(key)) {
        seen.add(key);
        return true;
      }
      return false;
    });
  }, [items]);

  // Count how many items share each identifier
  const countByIdentifier = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const item of items) {
      const key = item.parsedMeta?.identifier ?? item.fileName ?? item.uniqueId;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
  }, [items]);

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = uniqueItems.findIndex(i => i.uniqueId === active.id);
    const newIndex = uniqueItems.findIndex(i => i.uniqueId === over.id);
    const reorderedUnique = arrayMove(uniqueItems, oldIndex, newIndex);

    // Expand back to full items array, grouping all variants per identifier together
    const result: StagedItem[] = [];
    for (const rep of reorderedUnique) {
      const key = rep.parsedMeta?.identifier ?? rep.fileName ?? rep.uniqueId;
      result.push(...items.filter(i => (i.parsedMeta?.identifier ?? i.fileName ?? i.uniqueId) === key));
    }
    onReorder(result);
  }

  function handleRemoveByIdentifier(clickedUniqueId: string) {
    const clicked = items.find(i => i.uniqueId === clickedUniqueId);
    if (!clicked) return;
    const key = clicked.parsedMeta?.identifier ?? clicked.fileName ?? clicked.uniqueId;
    const allIds = items
      .filter(i => (i.parsedMeta?.identifier ?? i.fileName ?? i.uniqueId) === key)
      .map(i => i.uniqueId);
    onRemove(allIds);
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={uniqueItems.map(i => i.uniqueId)} strategy={verticalListSortingStrategy}>
        <div>
          <Text as="p" variant="bodyMd" fontWeight="semibold">
            {t.imageManager.bulkSortListTitle?.replace("{count}", String(uniqueItems.length)) ?? `${uniqueItems.length}`}
          </Text>
          <ul style={{ padding: 0, margin: "8px 0 0" }}>
            {uniqueItems.map(item => {
              const key = item.parsedMeta?.identifier ?? item.fileName ?? item.uniqueId;
              return (
                <SortableItemRow
                  key={item.uniqueId}
                  item={item}
                  variantTitle={item.targetVariantId ? variantTitles[item.targetVariantId] : undefined}
                  variantCount={countByIdentifier[key] ?? 1}
                  onRemove={handleRemoveByIdentifier}
                />
              );
            })}
          </ul>
        </div>
      </SortableContext>
    </DndContext>
  );
}
