import { useRef } from "react";
import { useSortable, SortableContext, rectSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { DndContext, closestCenter, MouseSensor, TouchSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
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

interface PlaceholderThumbnailProps {
  activeAction: "copy" | "move" | null;
  onDrop: () => void;
  onUpload: (files: File[]) => void;
  thumbSize: number;
}

function PlaceholderThumbnail({ activeAction, onDrop, onUpload, thumbSize }: PlaceholderThumbnailProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isActionMode = activeAction !== null;

  const borderColor = isActionMode
    ? (activeAction === "copy" ? "#008060" : "#005bd3")
    : "#c9cccf";
  const bgColor = isActionMode
    ? (activeAction === "copy" ? "rgba(0,128,96,0.07)" : "rgba(0,91,211,0.07)")
    : "transparent";
  const labelColor = isActionMode
    ? (activeAction === "copy" ? "#008060" : "#005bd3")
    : "#8c9196";

  return (
    <div
      style={{
        width: thumbSize,
        height: thumbSize,
        borderRadius: 6,
        border: `2px dashed ${borderColor}`,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        cursor: "pointer",
        background: bgColor,
        flexShrink: 0,
        transition: "border-color 0.2s, background 0.2s",
        gap: 4,
      }}
      onClick={() => {
        if (isActionMode) onDrop();
        else fileInputRef.current?.click();
      }}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        style={{ display: "none" }}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length) onUpload(files);
          e.target.value = "";
        }}
      />
      <span style={{ fontSize: isActionMode ? 20 : 24, color: labelColor, lineHeight: 1 }}>
        {isActionMode ? (activeAction === "copy" ? "⊕" : "→") : "+"}
      </span>
      <span style={{
        fontSize: 9,
        textAlign: "center",
        color: labelColor,
        fontWeight: isActionMode ? 600 : 400,
        lineHeight: 1.2,
      }}>
        {isActionMode ? (activeAction === "copy" ? "Kopieren" : "Verschieben") : "Upload"}
      </span>
    </div>
  );
}

interface SortableThumbnailProps {
  url: string;
  isSelected: boolean;
  meta?: ImageMeta;
  onSelect: (selected: boolean) => void;
  thumbSize: number;
  isMain?: boolean;
}

function extractFilename(url: string): string {
  try {
    return new URL(url).pathname.split("/").pop() ?? url;
  } catch {
    return url.split("/").pop()?.split("?")[0] ?? url;
  }
}

function SortableThumbnail({ url, isSelected, meta, onSelect, thumbSize, isMain = false }: SortableThumbnailProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: url });
  const formatBadge = getFormatBadge(url, meta?.mimeType);
  const hasAlt = Boolean(meta?.altText);
  const filename = extractFilename(url);

  return (
    <div
      ref={setNodeRef}
      title={filename}
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
            width: thumbSize,
            height: thumbSize,
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

        {/* Main image badge */}
        {isMain && (
          <div style={{
            position: "absolute",
            top: 4,
            left: 4,
            background: "rgba(0,91,211,0.85)",
            color: "white",
            fontSize: 9,
            fontWeight: 700,
            padding: "1px 4px",
            borderRadius: 3,
            lineHeight: "14px",
            pointerEvents: "none",
          }}>
            HAUPT
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
  thumbSize?: number;
  // Placeholder props — only rendered for variant galleries
  activeAction?: "copy" | "move" | null;
  onDropToPlaceholder?: () => void;
  onUploadToGallery?: (files: File[]) => void;
}

export function SortableImageGrid({
  imageUrls,
  imageMetas = {},
  onReorder,
  onSelect,
  selectedUrls = new Set(),
  isDropTarget = false,
  thumbSize = 80,
  activeAction,
  onDropToPlaceholder,
  onUploadToGallery,
}: SortableImageGridProps) {
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
  );

  const showPlaceholder = onDropToPlaceholder !== undefined || onUploadToGallery !== undefined;

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
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
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
        {/* Placeholder first only when gallery is empty */}
        {showPlaceholder && imageUrls.length === 0 && (
          <PlaceholderThumbnail
            activeAction={activeAction ?? null}
            onDrop={() => onDropToPlaceholder?.()}
            onUpload={(files) => onUploadToGallery?.(files)}
            thumbSize={thumbSize}
          />
        )}

        <SortableContext items={imageUrls} strategy={rectSortingStrategy}>
          {imageUrls.length === 0 && !showPlaceholder && (
            <div style={{ color: "#8c9196", fontSize: 13, padding: "8px 4px" }}>
              Keine Bilder
            </div>
          )}
          {imageUrls.map((url, idx) => (
            <SortableThumbnail
              key={url}
              url={url}
              isSelected={selectedUrls.has(url)}
              meta={imageMetas[url]}
              onSelect={(sel) => onSelect?.(url, sel)}
              thumbSize={thumbSize}
              isMain={showPlaceholder && idx === 0}
            />
          ))}
        </SortableContext>

        {/* Placeholder at end when gallery has images */}
        {showPlaceholder && imageUrls.length > 0 && (
          <PlaceholderThumbnail
            activeAction={activeAction ?? null}
            onDrop={() => onDropToPlaceholder?.()}
            onUpload={(files) => onUploadToGallery?.(files)}
            thumbSize={thumbSize}
          />
        )}
      </div>
    </DndContext>
  );
}
