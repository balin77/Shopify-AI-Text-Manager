import { useSortable, SortableContext, rectSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { DndContext, closestCenter, type DragEndEvent } from "@dnd-kit/core";
import { arrayMove } from "@dnd-kit/sortable";
import type { ImageMeta } from "./types";

function getFormatBadge(url: string, mimeType?: string): { label: string; color: string } | null {
  const lower = url.toLowerCase();
  const mime = mimeType?.toLowerCase() ?? "";
  if (mime === "image/webp" || lower.includes(".webp") || lower.includes("format=webp")) {
    return { label: "WebP", color: "#008060" };
  }
  if (mime === "image/png" || lower.includes(".png")) {
    return { label: "PNG", color: "#616161" };
  }
  if (mime === "image/gif" || lower.includes(".gif")) {
    return { label: "GIF", color: "#616161" };
  }
  if (mime === "image/jpeg" || lower.includes(".jpg") || lower.includes(".jpeg")) {
    return { label: "JPG", color: "#616161" };
  }
  return null;
}

interface SortableThumbnailProps {
  url: string;
  isSelected: boolean;
  meta?: ImageMeta;
  onSelect: (selected: boolean) => void;
}

function SortableThumbnail({ url, isSelected, meta, onSelect }: SortableThumbnailProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: url });
  const formatBadge = getFormatBadge(url, meta?.mimeType);
  const hasAlt = Boolean(meta?.altText);

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
        position: "relative",
        userSelect: "none",
      }}
      {...attributes}
    >
      <div
        {...listeners}
        style={{ cursor: "grab" }}
        onClick={(e) => { e.stopPropagation(); onSelect(!isSelected); }}
      >
        <img
          src={url}
          alt=""
          draggable={false}
          style={{
            width: 80,
            height: 80,
            objectFit: "cover",
            borderRadius: 6,
            border: isSelected ? "2px solid #005bd3" : "2px solid #e1e3e5",
            display: "block",
          }}
        />

        {/* Selection checkmark */}
        {isSelected && (
          <div style={{
            position: "absolute",
            top: 4,
            right: 4,
            width: 18,
            height: 18,
            borderRadius: "50%",
            background: "#005bd3",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            pointerEvents: "none",
          }}>
            <span style={{ color: "white", fontSize: 12, lineHeight: 1 }}>✓</span>
          </div>
        )}

        {/* Alt text badge */}
        <div style={{
          position: "absolute",
          bottom: 4,
          left: 4,
          background: hasAlt ? "rgba(0,128,96,0.85)" : "rgba(142,31,11,0.75)",
          color: "white",
          fontSize: 9,
          fontWeight: 700,
          padding: "1px 4px",
          borderRadius: 3,
          lineHeight: "14px",
          pointerEvents: "none",
        }}>
          {hasAlt ? "ALT" : "NO ALT"}
        </div>

        {/* Format badge */}
        {formatBadge && (
          <div style={{
            position: "absolute",
            bottom: 4,
            right: 4,
            background: formatBadge.color,
            color: "white",
            fontSize: 9,
            fontWeight: 700,
            padding: "1px 4px",
            borderRadius: 3,
            lineHeight: "14px",
            pointerEvents: "none",
          }}>
            {formatBadge.label}
          </div>
        )}
      </div>
    </div>
  );
}

interface SortableImageGridProps {
  containerId: string;
  imageUrls: string[];
  imageMetas?: Record<string, ImageMeta>;
  onReorder: (newOrder: string[]) => void;
  onSelect?: (url: string, selected: boolean) => void;
  selectedUrls?: Set<string>;
  isDropTarget?: boolean;
}

export function SortableImageGrid({
  imageUrls,
  imageMetas = {},
  onReorder,
  onSelect,
  selectedUrls = new Set(),
  isDropTarget = false,
}: SortableImageGridProps) {
  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      const oldIndex = imageUrls.indexOf(active.id as string);
      const newIndex = imageUrls.indexOf(over.id as string);
      if (oldIndex !== -1 && newIndex !== -1) {
        onReorder(arrayMove(imageUrls, oldIndex, newIndex));
      }
    }
  }

  return (
    <DndContext collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={imageUrls} strategy={rectSortingStrategy}>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 8,
            minHeight: 48,
            padding: 8,
            borderRadius: 8,
            border: isDropTarget ? "2px dashed #005bd3" : "2px dashed #e1e3e5",
            background: isDropTarget ? "rgba(0, 91, 211, 0.04)" : "transparent",
            transition: "border-color 0.2s, background 0.2s",
          }}
        >
          {imageUrls.length === 0 && (
            <div style={{ color: "#8c9196", fontSize: 13, padding: "8px 4px" }}>
              Keine Bilder
            </div>
          )}
          {imageUrls.map(url => (
            <SortableThumbnail
              key={url}
              url={url}
              isSelected={selectedUrls.has(url)}
              meta={imageMetas[url]}
              onSelect={(sel) => onSelect?.(url, sel)}
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}
