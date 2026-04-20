import { useCallback } from "react";
import { DropZone, Text, Button, InlineStack } from "@shopify/polaris";
import type { StagedItem } from "./types";

const ALLOWED_MIME = ["image/jpeg", "image/png", "image/gif", "image/webp", "image/svg+xml"];

interface BulkImageUploadPanelProps {
  items: StagedItem[];
  selectedUniqueIds: Set<string>;
  activeAction: "copy" | "move" | null;
  onItemsChange: (updater: (prev: StagedItem[]) => StagedItem[]) => void;
  onSelect: (uniqueId: string, selected: boolean) => void;
  onSetAction: (action: "copy" | "move" | null) => void;
  onRemove: (uniqueIds: string[]) => void;
}

export function BulkImageUploadPanel({
  items,
  selectedUniqueIds,
  activeAction,
  onItemsChange,
  onSelect,
  onSetAction,
  onRemove,
}: BulkImageUploadPanelProps) {
  const handleDrop = useCallback(async (_dropFiles: File[], acceptedFiles: File[]) => {
    const validFiles = acceptedFiles.filter(f => ALLOWED_MIME.includes(f.type));
    if (validFiles.length === 0) return;

    const newItems: StagedItem[] = validFiles.map(file => ({
      uniqueId: crypto.randomUUID(),
      previewUrl: URL.createObjectURL(file),
      resourceUrl: "",
      fileName: file.name,
      mimeType: file.type,
      progress: 0,
      status: "uploading" as const,
    }));

    onItemsChange(prev => [...prev, ...newItems]);

    // Parallel hochladen
    await Promise.all(validFiles.map(async (file, i) => {
      const item = newItems[i];
      try {
        const res = await fetch("/api/staged-upload", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            filename: file.name,
            mimeType: file.type,
            fileSize: file.size,
          }),
        });
        const { url, resourceUrl, error } = await res.json();

        if (error || !url) {
          onItemsChange(prev => prev.map(it =>
            it.uniqueId === item.uniqueId ? { ...it, status: "error" as const } : it
          ));
          return;
        }

        await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) {
              const pct = Math.round((e.loaded / e.total) * 100);
              onItemsChange(prev => prev.map(it =>
                it.uniqueId === item.uniqueId ? { ...it, progress: pct } : it
              ));
            }
          };
          xhr.onload = () => {
            onItemsChange(prev => prev.map(it =>
              it.uniqueId === item.uniqueId
                ? { ...it, status: "ready" as const, progress: 100, resourceUrl }
                : it
            ));
            resolve();
          };
          xhr.onerror = () => {
            onItemsChange(prev => prev.map(it =>
              it.uniqueId === item.uniqueId ? { ...it, status: "error" as const } : it
            ));
            reject();
          };
          xhr.open("PUT", url);
          xhr.setRequestHeader("Content-Type", file.type);
          xhr.send(file);
        });
      } catch {
        onItemsChange(prev => prev.map(it =>
          it.uniqueId === item.uniqueId ? { ...it, status: "error" as const } : it
        ));
      }
    }));
  }, [onItemsChange]);

  const selectedItems = items.filter(i => selectedUniqueIds.has(i.uniqueId));
  const hasSelected = selectedItems.length > 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <DropZone onDrop={handleDrop} accept={ALLOWED_MIME.join(",")} allowMultiple>
        <DropZone.FileUpload actionTitle="Bilder hochladen" actionHint="JPG, PNG, GIF, WebP, SVG" />
      </DropZone>

      {items.length > 0 && (
        <>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {items.map(item => (
              <div
                key={item.uniqueId}
                style={{
                  position: "relative",
                  width: 72,
                  cursor: "pointer",
                  borderRadius: 6,
                  outline: selectedUniqueIds.has(item.uniqueId) ? "2px solid #005bd3" : "2px solid transparent",
                }}
                onClick={() => onSelect(item.uniqueId, !selectedUniqueIds.has(item.uniqueId))}
              >
                <img
                  src={item.previewUrl}
                  alt={item.fileName}
                  style={{ width: 72, height: 72, objectFit: "cover", borderRadius: 6, display: "block" }}
                />

                {item.status === "uploading" && (
                  <div style={{ position: "absolute", bottom: 0, left: 0, right: 0 }}>
                    <div style={{
                      height: 4,
                      background: "#e1e3e5",
                      borderRadius: "0 0 6px 6px",
                      overflow: "hidden",
                    }}>
                      <div style={{
                        height: "100%",
                        width: `${item.progress}%`,
                        background: "#005bd3",
                        transition: "width 0.3s",
                      }} />
                    </div>
                  </div>
                )}

                {item.status === "error" && (
                  <div style={{
                    position: "absolute",
                    inset: 0,
                    background: "rgba(212, 44, 37, 0.3)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    borderRadius: 6,
                  }}>
                    <Text as="span" tone="critical" variant="bodyLg">!</Text>
                  </div>
                )}

                {selectedUniqueIds.has(item.uniqueId) && (
                  <div style={{
                    position: "absolute",
                    top: 3,
                    right: 3,
                    width: 18,
                    height: 18,
                    borderRadius: "50%",
                    background: "#005bd3",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}>
                    <span style={{ color: "white", fontSize: 11, lineHeight: 1 }}>✓</span>
                  </div>
                )}
              </div>
            ))}
          </div>

          <InlineStack gap="200">
            <Button
              size="slim"
              pressed={activeAction === "copy"}
              onClick={() => onSetAction(activeAction === "copy" ? null : "copy")}
              disabled={!hasSelected}
            >
              Copy
            </Button>
            <Button
              size="slim"
              pressed={activeAction === "move"}
              onClick={() => onSetAction(activeAction === "move" ? null : "move")}
              disabled={!hasSelected}
            >
              Move
            </Button>
            <Button
              size="slim"
              tone="critical"
              onClick={() => onRemove([...selectedUniqueIds])}
              disabled={!hasSelected}
            >
              Remove
            </Button>
          </InlineStack>
        </>
      )}

    </div>
  );
}
