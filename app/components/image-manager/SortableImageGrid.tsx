import { useRef } from "react";
import { useSortable, SortableContext, rectSortingStrategy, sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { DndContext, closestCenter, MouseSensor, TouchSensor, KeyboardSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { arrayMove } from "@dnd-kit/sortable";
import { useI18n } from "../../contexts/I18nContext";
import type { ImageMeta } from "./types";
// MediaKind is referenced indirectly via ImageMeta.kind — no direct import
// needed here, but kept as a comment for grep-discoverability of the dispatch.

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
  const { t } = useI18n();
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
        // Mirror the BulkImageUploadPanel whitelist so merchants can pick a
        // video or GLB directly from the placeholder tile too. The /api/staged-
        // upload route revalidates via classifyFile() — this attribute is just
        // OS picker UX.
        accept="image/*,video/mp4,video/quicktime,video/webm,model/gltf-binary,model/gltf+json,.glb,.gltf"
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
        {isActionMode ? (activeAction === "copy" ? t.imageManager.copy : t.imageManager.move) : t.imageManager.upload}
      </span>
    </div>
  );
}

interface SortableThumbnailProps {
  sortableId: string;
  url: string;
  containerId: string;
  isSelected: boolean;
  meta?: ImageMeta;
  onSelect: (selected: boolean) => void;
  thumbSize: number;
  isMain?: boolean;
  localAltTexts?: Record<string, string>;
  isPrimaryLocale?: boolean;
}

function extractFilename(url: string): string {
  try {
    return new URL(url).pathname.split("/").pop() ?? url;
  } catch {
    return url.split("/").pop()?.split("?")[0] ?? url;
  }
}

function SortableThumbnail({ sortableId, url, containerId, isSelected, meta, onSelect, thumbSize, isMain = false, localAltTexts, isPrimaryLocale = true }: SortableThumbnailProps) {
  const { t } = useI18n();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: sortableId,
    data: { containerId, url },
  });
  // Format badge is only meaningful for images — video / model / external
  // video have their own play / 3D / host overlays and showing JPG/PNG/etc
  // on a video poster would just be confusing.
  const kind = meta?.kind ?? "image";
  const formatBadge = kind === "image" ? getFormatBadge(url, meta?.mimeType) : null;
  const currentLocaleAltText = isPrimaryLocale
    ? (localAltTexts?.[url] ?? meta?.altText ?? "")
    : (localAltTexts?.[url] ?? "");
  const hasAlt = Boolean(currentLocaleAltText);
  const filename = extractFilename(url);
  const isConverting = Boolean(meta?.isConverting);

  const tileBorder = isSelected ? "2px solid #005bd3" : (isMain ? "2px solid #e6a817" : "2px solid #e1e3e5");
  const tileBoxShadow = isMain
    ? (isSelected ? "0 0 0 2px #e6a817" : "0 0 0 2px rgba(230,168,23,0.35)")
    : "none";

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
        // R4-UX5: this is a selectable/deletable/draggable item whose
        // selected & "main image" state was conveyed by border colour only.
        // Expose it as a toggle with a textual name + state so the image
        // manager / bulk-delete is usable without sight.
        role="button"
        aria-pressed={isSelected}
        aria-label={
          (currentLocaleAltText || t.imageManager.imageThumbLabel) +
          (isMain ? `, ${t.imageManager.mainImage}` : "")
        }
      >
        {kind === "model" && !url ? (
          // GLB without a preview poster — neutral placeholder. The "3D" badge
          // below still renders, so the tile is identifiable.
          <div
            aria-label={`${t.imageManager.modelLabel ?? "3D model"}: ${filename}`}
            style={{
              width: thumbSize,
              height: thumbSize,
              borderRadius: 6,
              border: tileBorder,
              boxShadow: tileBoxShadow,
              background: "#f1f2f4",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#616161",
              fontWeight: 700,
              fontSize: Math.max(10, Math.round(thumbSize * 0.18)),
              letterSpacing: 0.5,
            }}
          >
            3D
          </div>
        ) : kind === "external_video" ? (
          // YouTube / Vimeo URL: the merchant's URL is not an image, so we
          // either fetch the host's thumbnail (img.youtube.com for YT) when
          // available via meta.previewUrl, or render a flat tile with the
          // host name. The play overlay sits on top either way.
          meta?.externalHost === "YouTube" || meta?.externalHost === "youtube" ? (
            <img
              src={(() => {
                const m = url.match(/[?&]v=([A-Za-z0-9_-]{11})/) || url.match(/youtu\.be\/([A-Za-z0-9_-]{11})/) || url.match(/youtube\.com\/(?:embed|shorts)\/([A-Za-z0-9_-]{11})/);
                return m ? `https://img.youtube.com/vi/${m[1]}/hqdefault.jpg` : "";
              })()}
              alt={currentLocaleAltText || t.imageManager.externalVideoLabel || "External video"}
              draggable={false}
              onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = "hidden"; }}
              style={{
                width: thumbSize,
                height: thumbSize,
                objectFit: "cover",
                borderRadius: 6,
                border: tileBorder,
                boxShadow: tileBoxShadow,
                background: "#0b0b0b",
                display: "block",
              }}
            />
          ) : (
            <div
              aria-label={currentLocaleAltText || (t.imageManager.externalVideoLabel ?? "External video")}
              style={{
                width: thumbSize,
                height: thumbSize,
                borderRadius: 6,
                border: tileBorder,
                boxShadow: tileBoxShadow,
                background: "linear-gradient(135deg, #1ab7ea 0%, #007ea8 100%)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "white",
                fontWeight: 700,
                fontSize: Math.max(11, Math.round(thumbSize * 0.16)),
                letterSpacing: 0.5,
              }}
            >
              {meta?.externalHost ?? "VIDEO"}
            </div>
          )
        ) : (
          <img
            src={url}
            alt={currentLocaleAltText || t.imageManager.imageThumbLabel}
            draggable={false}
            style={{
              width: thumbSize,
              height: thumbSize,
              objectFit: "cover",
              borderRadius: 6,
              border: tileBorder,
              boxShadow: tileBoxShadow,
              display: "block",
            }}
          />
        )}

        {/* Media-type overlays (mirrors the storefront tile language so the
            admin gallery and the storefront gallery stay visually consistent).
            Skipped for plain images. */}
        {(kind === "video" || kind === "external_video") && (
          <div
            aria-hidden
            style={{
              position: "absolute",
              inset: 0,
              borderRadius: 6,
              background: "rgba(0,0,0,0.32)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              pointerEvents: "none",
            }}
          >
            <svg width={Math.max(18, Math.round(thumbSize * 0.32))} height={Math.max(18, Math.round(thumbSize * 0.32))} viewBox="0 0 24 24" fill="white"><path d="M8 5v14l11-7z" /></svg>
          </div>
        )}
        {kind === "model" && url && (
          <div
            aria-hidden
            style={{
              position: "absolute",
              right: 4,
              bottom: 4,
              background: "rgba(0,0,0,0.72)",
              color: "#fff",
              font: "700 10px/1 system-ui, sans-serif",
              letterSpacing: 0.5,
              padding: "2px 5px",
              borderRadius: 3,
              pointerEvents: "none",
            }}
          >
            3D
          </div>
        )}
        {kind === "external_video" && meta?.externalHost && (
          <div
            aria-hidden
            style={{
              position: "absolute",
              top: 4,
              left: 4,
              background: "rgba(0,0,0,0.72)",
              color: "#fff",
              font: "700 9px/1 system-ui, sans-serif",
              letterSpacing: 0.4,
              padding: "2px 5px",
              borderRadius: 3,
              pointerEvents: "none",
              textTransform: "uppercase",
            }}
          >
            {meta.externalHost}
          </div>
        )}

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
        <div
          title={hasAlt ? currentLocaleAltText : undefined}
          style={{
            position: "absolute",
            bottom: 4,
            left: 4,
            background: hasAlt ? "rgba(0,128,96,0.85)" : "rgba(142,31,11,0.75)",
            color: "white",
            fontSize: 10,
            fontWeight: 700,
            padding: "2px 6px",
            borderRadius: 3,
            lineHeight: "14px",
            cursor: hasAlt ? "default" : "default",
          }}>
          {hasAlt ? t.imageManager.altBadge : t.imageManager.noAltBadge}
        </div>

        {/* Conversion spinner overlay */}
        {isConverting && (
          <div style={{
            position: "absolute",
            inset: 0,
            background: "rgba(0,0,0,0.45)",
            borderRadius: 6,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            pointerEvents: "none",
          }}>
            <div style={{
              width: 20,
              height: 20,
              border: "3px solid rgba(255,255,255,0.35)",
              borderTopColor: "white",
              borderRadius: "50%",
              animation: "spin 0.75s linear infinite",
            }} />
          </div>
        )}

        {/* Format badge */}
        {formatBadge && (
          <div style={{
            position: "absolute",
            bottom: 4,
            right: 4,
            background: formatBadge.color,
            color: "white",
            fontSize: 10,
            fontWeight: 700,
            padding: "2px 6px",
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
  // When true, no internal DndContext — parent provides one
  skipDndContext?: boolean;
  // When false, no image gets the "main" gold border (variant has no featured image)
  hasMainImage?: boolean;
  localAltTexts?: Record<string, string>;
  isPrimaryLocale?: boolean;
}

export function SortableImageGrid({
  containerId,
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
  skipDndContext = false,
  hasMainImage = true,
  localAltTexts,
  isPrimaryLocale = true,
}: SortableImageGridProps) {
  const { t } = useI18n();
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
    // R4-UX4: keyboard/screen-reader users could not reorder gallery images
    // at all (only Mouse+Touch sensors). Matches BulkSortableList's setup.
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const showPlaceholder = onDropToPlaceholder !== undefined || onUploadToGallery !== undefined;
  const sortableIds = imageUrls.map(url => `${containerId}::${url}`);

  // Position 0 of a variant gallery becomes the variant's mediaId — Shopify
  // only accepts MediaImage there. Block a reorder that would land a video /
  // model / external_video at index 0; the server has the same guard but
  // feedback is friendlier when the UI refuses the drop outright.
  const isNonImageItem = (url: string): boolean => {
    const k = imageMetas[url]?.kind;
    return k === "video" || k === "model" || k === "external_video";
  };

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      const activeUrl = (active.id as string).slice((active.id as string).indexOf("::") + 2);
      const overUrl = (over.id as string).slice((over.id as string).indexOf("::") + 2);
      const oldIndex = imageUrls.indexOf(activeUrl);
      const newIndex = imageUrls.indexOf(overUrl);
      if (oldIndex !== -1 && newIndex !== -1) {
        // Variant galleries (showPlaceholder=true && hasMainImage) reserve
        // index 0 for the featured image. Refuse a move that would either
        // (a) drop a non-image into index 0, or
        // (b) push the existing image-at-0 out by moving it backwards.
        // Product galleries (showPlaceholder=false) have no such constraint.
        const enforcePositionZero = showPlaceholder && hasMainImage;
        if (enforcePositionZero && newIndex === 0 && isNonImageItem(activeUrl)) {
          return;
        }
        if (enforcePositionZero && oldIndex === 0 && imageUrls[0] && !isNonImageItem(imageUrls[0])) {
          // The featured image is at 0 — dragging it away would replace it
          // with whatever follows. Only allow if the new head would also be
          // an image; otherwise refuse.
          const candidateHead = newIndex === 0 ? imageUrls[1] : imageUrls[0];
          if (candidateHead && isNonImageItem(candidateHead)) {
            return;
          }
        }
        onReorder(arrayMove(imageUrls, oldIndex, newIndex));
      }
    }
  }

  const containerStyle: React.CSSProperties = {
    display: "flex",
    flexWrap: "wrap",
    gap: 8,
    minHeight: 48,
    padding: 8,
    borderRadius: 8,
    border: isDropTarget ? "2px dashed #005bd3" : "2px dashed #e1e3e5",
    background: isDropTarget ? "rgba(0, 91, 211, 0.04)" : "transparent",
    transition: "border-color 0.2s, background 0.2s",
  };

  const inner = (
    <>
      {/* Missing main image placeholder — shown at position 0 when gallery exists but main image is absent */}
      {showPlaceholder && !hasMainImage && imageUrls.length > 0 && (
        <div style={{
          width: thumbSize,
          height: thumbSize,
          borderRadius: 6,
          border: "2px dashed rgba(255,149,0,0.7)",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          background: "rgba(255,149,0,0.06)",
          flexShrink: 0,
          gap: 2,
        }}>
          <span style={{ fontSize: Math.max(16, thumbSize * 0.22), lineHeight: 1, color: "rgba(255,149,0,0.9)" }}>!</span>
          <span style={{ fontSize: Math.max(8, thumbSize * 0.1), color: "rgba(255,149,0,0.8)", textAlign: "center", padding: "0 4px", lineHeight: 1.2 }}>
            {t.imageManager.noMainImage}
          </span>
        </div>
      )}

      {/* Placeholder first only when gallery is empty */}
      {showPlaceholder && imageUrls.length === 0 && (
        <PlaceholderThumbnail
          activeAction={activeAction ?? null}
          onDrop={() => onDropToPlaceholder?.()}
          onUpload={(files) => onUploadToGallery?.(files)}
          thumbSize={thumbSize}
        />
      )}

      <SortableContext items={sortableIds} strategy={rectSortingStrategy}>
        {imageUrls.length === 0 && !showPlaceholder && (
          <div style={{ color: "#8c9196", fontSize: 13, padding: "8px 4px" }}>
            {t.imageManager.noImages}
          </div>
        )}
        {imageUrls.map((url, idx) => (
          <SortableThumbnail
            key={url}
            sortableId={`${containerId}::${url}`}
            url={url}
            containerId={containerId}
            isSelected={selectedUrls.has(url)}
            meta={imageMetas[url]}
            onSelect={(sel) => onSelect?.(url, sel)}
            thumbSize={thumbSize}
            isMain={showPlaceholder && hasMainImage && idx === 0}
            localAltTexts={localAltTexts}
            isPrimaryLocale={isPrimaryLocale}
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
    </>
  );

  if (skipDndContext) {
    return <div style={containerStyle}>{inner}</div>;
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <div style={containerStyle}>{inner}</div>
    </DndContext>
  );
}
